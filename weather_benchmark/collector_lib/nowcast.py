"""Python port of src/services/nowcast.js + parts of src/utils/metarParse.js.

Owns the algorithm — computes:
  - skyState        (background atmospheric state)
  - precipStateNow  (legacy: radar-primary precip)
  - precipTrend60m  (12-bucket timeline + human summary)
  - lightningState  (merged GLM + METAR thunder)
  - nowcastState    (synthesized precip / sky / thunder)

PARITY NOTE: any change to src/services/nowcast.js must be mirrored here.
The parity test (tests/test_collector_parity.py) catches drift.

Input shape — same as the browser:
  obs = { stationId, obs: { timestamp, temperature_c, humidity, presentWeather,
                            textDescription, ... } }
  radar_state = { dbz, isRaining, rainState, timestamp, source, lastValidDbzTime }
  motion      = { speed_kmh, direction_deg, dx, dy }  or None
  model_wmo   = integer Open-Meteo weather_code  or None
  om_precip   = Open-Meteo current.precipitation in/hr  or None
  lightning   = empty_lightning_state() output  (GLM not yet polled — METAR only)
"""

import math
import re
import logging
from datetime import datetime, timezone
from typing import Optional, Dict, List, Any

from .lightning import detect_thunder, metar_age_minutes

logger = logging.getLogger(__name__)

# Tunable thresholds — must match src/services/nowcast.js constants
SCORE_RADAR_WET_US     = 0.90
SCORE_RADAR_DRY_US     = 0.75
SCORE_RADAR_WET_INTL   = 0.85
SCORE_RADAR_DRY_INTL   = 0.65
SCORE_METAR_PRECIP_MAX = 0.70
SCORE_METAR_DRY_MAX    = 0.55
SCORE_METAR_SKY_MAX    = 0.90
SCORE_MODEL_PRECIP     = 0.30
SCORE_MODEL_SKY        = 0.35


# ── WMO weather-code table (ported from src/utils/weatherCodes.js) ───────────
# desc + icon must match WEATHER_CODES there exactly; the collector uses these
# for model-sourced precip icons and model sky cover/icon (train/serve parity).
WEATHER_CODES = {
    0:  ('Clear sky', 'clear-day'),
    1:  ('Mainly clear', 'clear-day'),
    2:  ('Partly cloudy', 'partly-cloudy-day'),
    3:  ('Overcast', 'overcast-day'),
    45: ('Foggy', 'fog-day'),
    48: ('Rime fog', 'fog-day'),
    51: ('Light drizzle', 'drizzle'),
    53: ('Moderate drizzle', 'drizzle'),
    55: ('Dense drizzle', 'rain'),
    56: ('Light freezing drizzle', 'sleet'),
    57: ('Heavy freezing drizzle', 'sleet'),
    61: ('Slight rain', 'rain'),
    63: ('Moderate rain', 'rain'),
    65: ('Heavy rain', 'rain'),
    66: ('Light freezing rain', 'sleet'),
    67: ('Heavy freezing rain', 'sleet'),
    71: ('Slight snow', 'snow'),
    73: ('Moderate snow', 'snow'),
    75: ('Heavy snow', 'snow'),
    77: ('Snow grains', 'snow'),
    80: ('Slight rain showers', 'drizzle'),
    81: ('Moderate rain showers', 'rain'),
    82: ('Violent rain showers', 'thunderstorms-rain'),
    85: ('Slight snow showers', 'snow'),
    86: ('Heavy snow showers', 'snow'),
    95: ('Thunderstorm', 'thunderstorms-rain'),
    96: ('Thunderstorm with hail', 'hail'),
    99: ('Thunderstorm with heavy hail', 'hail'),
}


def _wmo_info(code) -> Dict:
    """Port of getWeatherInfo() — {desc, icon} for a WMO code, with the same
    'Unknown' sentinels (so the `desc != 'Unknown'` guards behave identically)."""
    if code is None:
        return {'desc': 'Unknown', 'icon': 'not-available'}
    entry = WEATHER_CODES.get(code)
    if entry is None:
        return {'desc': f'Unknown (code: {code})', 'icon': 'not-available'}
    return {'desc': entry[0], 'icon': entry[1]}


# ── METAR parsing (ported from src/utils/metarParse.js) ──────────────────────

_METAR_PATTERNS = [
    (r'\+TS',            'Heavy Thunderstorm', 'thunderstorms-rain', True,  True,  False),
    (r'TSRA|TSSN|TSGS',  'Thunderstorm',       'thunderstorms-rain', True,  True,  False),
    (r'\bTS\b',          'Thunderstorm',       'thunderstorms-rain', True,  False, False),
    (r'FZRA',            'Freezing Rain',      'sleet',              False, True,  False),
    (r'FZDZ',            'Freezing Drizzle',   'sleet',              False, True,  False),
    (r'\+SN',            'Heavy Snow',         'snow',               False, False, True),
    (r'\bSN\b',          'Snow',               'snow',               False, False, True),
    (r'-SN',             'Light Snow',         'snow',               False, False, True),
    (r'SG|IC|PE|PL|GS',  'Wintry Mix',         'sleet',              False, True,  True),
    (r'\+RA',            'Heavy Rain',         'rain',               False, True,  False),
    (r'\bRA\b',          'Rain',               'rain',               False, True,  False),
    (r'-RA',             'Light Rain',         'drizzle',            False, True,  False),
    (r'\bDZ\b|\+DZ|-DZ', 'Drizzle',            'drizzle',            False, True,  False),
    (r'\+SH',            'Heavy Showers',      'rain',               False, True,  False),
    (r'SHRA',            'Rain Showers',       'drizzle',            False, True,  False),
    (r'\bSH\b|-SH',      'Light Showers',      'drizzle',            False, True,  False),
    (r'FG',              'Fog',                'fog-day',            False, False, False),
    (r'BR',              'Mist',               'mist',               False, False, False),
    (r'HZ',              'Haze',               'mist',               False, False, False),
    (r'FU|VA',           'Smoke',              'mist',               False, False, False),
    (r'DU|SA|SS|DS',     'Dust/Sand',          'mist',               False, False, False),
]
_METAR_RX = [(re.compile(p), d, i, t, r_, s) for (p, d, i, t, r_, s) in _METAR_PATTERNS]

_TEXT_PATTERNS = [
    (r'thunder',                     'Thunderstorm',  'thunderstorms-rain', True,  True,  False),
    (r'freezing rain',               'Freezing Rain', 'sleet',              False, True,  False),
    (r'heavy (rain|precip)',         'Heavy Rain',    'rain',               False, True,  False),
    (r'rain|showers',                'Rain',          'rain',               False, True,  False),
    (r'light rain|drizzle',          'Light Rain',    'drizzle',            False, True,  False),
    (r'heavy snow|blizzard',         'Heavy Snow',    'snow',               False, False, True),
    (r'snow|flurries',               'Snow',          'snow',               False, False, True),
    (r'sleet|ice|wintry|freezing',   'Wintry Mix',    'sleet',              False, True,  True),
    (r'fog',                         'Fog',           'fog-day',            False, False, False),
    (r'mist|haze',                   'Mist',          'mist',               False, False, False),
    (r'smoke',                       'Smoke',         'mist',               False, False, False),
    (r'overcast|cloudy',             'Overcast',      'overcast-day',       False, False, False),
    (r'mostly cloudy',               'Mostly Cloudy', 'overcast-day',       False, False, False),
    (r'partly (cloudy|sunny)',       'Partly Cloudy', 'partly-cloudy-day',  False, False, False),
    (r'mostly (clear|sunny)',        'Mostly Clear',  'clear-day',          False, False, False),
    (r'fair|clear|sunny',            'Clear',         'clear-day',          False, False, False),
]
_TEXT_RX = [(re.compile(p, re.IGNORECASE), d, i, t, r_, s) for (p, d, i, t, r_, s) in _TEXT_PATTERNS]


def parse_metar_condition(present_weather, text_description) -> Dict:
    """Parse METAR rawcodes + text → condition dict. Mirrors parseMetarCondition()."""
    pw_str = present_weather or ''
    if isinstance(pw_str, list):
        # In case caller passes NWS-style list of {rawString,...}
        pw_str = ' '.join((p.get('rawString') or p.get('weather') or '') for p in pw_str)
    pw_str = pw_str.upper()

    if pw_str.strip():
        for rx, desc, icon, is_thunder, is_rain, is_snow in _METAR_RX:
            if rx.search(pw_str):
                return {'desc': desc, 'icon': icon, 'isThunder': is_thunder,
                        'isRain': is_rain, 'isSnow': is_snow}

    if text_description:
        for rx, desc, icon, is_thunder, is_rain, is_snow in _TEXT_RX:
            if rx.search(text_description):
                return {'desc': desc, 'icon': icon, 'isThunder': is_thunder,
                        'isRain': is_rain, 'isSnow': is_snow}

    return {'desc': 'Unknown', 'icon': 'not-available',
            'isThunder': False, 'isRain': False, 'isSnow': False}


def metar_freshness_weight(age_min: float, phenomenon: str) -> float:
    """Same step function as the JS version."""
    if phenomenon == 'sky':
        if age_min <= 20: return 1.0
        if age_min <= 40: return 0.7
        if age_min <= 60: return 0.4
        return 0.1
    # precip
    if age_min <= 10: return 1.0
    if age_min <= 20: return 0.7
    if age_min <= 30: return 0.4
    if age_min <= 40: return 0.15
    return 0.05


def _dewpoint_c(temp_c: float, rh_pct: float) -> float:
    a, b = 17.625, 243.04
    gamma = math.log(rh_pct / 100) + (a * temp_c) / (b + temp_c)
    return (b * gamma) / (a - gamma)


# ── Sky State ────────────────────────────────────────────────────────────────

def compute_sky_state(obs: Optional[Dict], country: str) -> Optional[Dict]:
    if not obs or not obs.get('obs'):
        return None
    o = obs['obs']
    age = metar_age_minutes(o.get('timestamp'))
    weight = metar_freshness_weight(age, 'sky')
    parsed = parse_metar_condition(o.get('presentWeather'), o.get('textDescription'))
    if parsed['desc'] == 'Unknown':
        return None
    return {
        'desc':       parsed['desc'],
        'icon':       parsed['icon'],
        'source':     f"METAR {obs.get('stationId')}",
        'confidence': weight,
        'observedAt': o.get('timestamp'),
    }


# ── Precip Now (legacy, radar-primary) ───────────────────────────────────────

def compute_precip_now(obs: Optional[Dict], radar_state: Optional[Dict], country: str) -> Optional[Dict]:
    is_us = country == 'United States'
    radar_src = 'NEXRAD' if is_us else 'RainViewer'

    if radar_state:
        if radar_state.get('isRaining'):
            dbz = radar_state.get('dbz') or 0
            if dbz >= 45:
                phenomenon, desc, icon = 'heavy rain', 'Heavy Rain', 'rain'
            elif dbz >= 30:
                phenomenon, desc, icon = 'rain', 'Rain', 'rain'
            elif dbz >= 22:
                phenomenon, desc, icon = 'rain', 'Light Rain', 'rain'
            else:
                phenomenon, desc, icon = 'drizzle', 'Drizzle', 'drizzle'
            return {
                'phenomenon': phenomenon, 'desc': desc, 'icon': icon,
                'source': radar_src, 'confidence': 0.9,
                'observedAt': radar_state.get('timestamp'),
            }
        return {
            'phenomenon': 'dry', 'desc': 'Dry', 'icon': '',
            'source': radar_src, 'confidence': 0.85,
            'observedAt': radar_state.get('timestamp'),
        }

    if obs and obs.get('obs'):
        o = obs['obs']
        age = metar_age_minutes(o.get('timestamp'))
        weight = metar_freshness_weight(age, 'precip')
        if weight < 0.05:
            return None
        parsed = parse_metar_condition(o.get('presentWeather'), o.get('textDescription'))
        if parsed['isRain'] or parsed['isSnow'] or parsed['isThunder']:
            desc_l = parsed['desc'].lower()
            phenomenon = ('thunderstorm' if parsed['isThunder']
                          else 'snow' if parsed['isSnow']
                          else 'drizzle' if 'drizzle' in desc_l
                          else 'heavy rain' if 'heavy' in desc_l
                          else 'rain')
            return {
                'phenomenon': phenomenon, 'desc': parsed['desc'], 'icon': parsed['icon'],
                'source': f"METAR {obs.get('stationId')}",
                'confidence': weight * 0.8, 'observedAt': o.get('timestamp'),
            }
        return {
            'phenomenon': 'dry', 'desc': 'Dry', 'icon': '',
            'source': f"METAR {obs.get('stationId')}",
            'confidence': weight * 0.7, 'observedAt': o.get('timestamp'),
        }

    return None


# ── Scored Precip Now (the v1.44.0 path: virga veto, intensity bands) ───────

def score_precip_now(radar_state, obs, model_wmo, is_us: bool, om_precip_in_hr=None) -> Dict:
    radar_src = 'NEXRAD' if is_us else 'RainViewer'
    score_wet = SCORE_RADAR_WET_US if is_us else SCORE_RADAR_WET_INTL
    score_dry = SCORE_RADAR_DRY_US if is_us else SCORE_RADAR_DRY_INTL

    metar_parsed = None
    metar_age = float('inf')
    metar_weight = 0.0
    if obs and obs.get('obs'):
        o = obs['obs']
        metar_age = metar_age_minutes(o.get('timestamp'))
        metar_weight = metar_freshness_weight(metar_age, 'precip')
        metar_parsed = parse_metar_condition(o.get('presentWeather'), o.get('textDescription'))

    if radar_state:
        if radar_state.get('isRaining'):
            dbz = radar_state.get('dbz') or 0

            # Surface dry veto (virga / overshoot / hold-time tails)
            if dbz < 50 and metar_parsed:
                pw = (obs['obs'].get('presentWeather') or '').strip()
                desc = obs['obs'].get('textDescription') or ''
                has_precip_code = len(pw) > 0
                desc_has_precip = re.search(r'rain|drizzle|shower|snow|sleet|mist|freezing',
                                            desc, re.IGNORECASE) is not None
                if not has_precip_code and not desc_has_precip:
                    om_also_dry = om_precip_in_hr is None or om_precip_in_hr < 0.01
                    tier1 = dbz < 30 and metar_weight > 0.1 and metar_age < 45

                    virga = False
                    o = obs['obs']
                    if o.get('temperature_c') is not None and o.get('humidity') is not None:
                        td = _dewpoint_c(o['temperature_c'], o['humidity'])
                        virga = (o['temperature_c'] - td) > 6 or o['humidity'] < 60
                    tier2 = dbz >= 30 and metar_weight > 0.3 and metar_age < 20 and (om_also_dry or virga)

                    if tier1 or tier2:
                        return {
                            'active': False, 'type': None, 'intensity': None, 'icon': None,
                            'source': 'radar', 'sourceDetail': radar_src,
                            'confidence': score_dry * 0.8,
                            'observedAt': radar_state.get('timestamp'),
                        }

            ptype, intensity, icon = 'rain', 'moderate', 'rain'
            if dbz >= 45:
                intensity = 'heavy'
            elif dbz >= 30:
                intensity = 'moderate'
            elif dbz >= 22:
                intensity = 'light'
                icon = 'rain'
            else:
                ptype, intensity, icon = 'rain', 'light', 'rain'

            if metar_parsed and metar_parsed['isSnow'] and metar_weight > 0.1:
                ptype, icon = 'snow', 'snow'

            return {
                'active': True, 'type': ptype, 'intensity': intensity, 'icon': icon,
                'source': 'radar', 'sourceDetail': radar_src,
                'confidence': score_wet, 'observedAt': radar_state.get('timestamp'),
            }

        # Radar dry — METAR override paths
        radar_dbz_dry = radar_state.get('dbz') or 0
        radar_sub_threshold = radar_dbz_dry < 15

        if metar_parsed and metar_weight > 0.1 and metar_age < 30:
            desc_l = metar_parsed['desc'].lower()
            is_classic_radar_blind = ('drizzle' in desc_l or 'mist' in desc_l
                                      or 'freezing drizzle' in desc_l
                                      or (metar_parsed['isRain'] and 'light' in desc_l))
            is_sub_threshold_precip = (radar_sub_threshold
                                       and (metar_parsed['isRain'] or metar_parsed['isSnow']
                                            or metar_parsed['isThunder']))
            if is_classic_radar_blind or is_sub_threshold_precip:
                ptype = 'snow' if metar_parsed['isSnow'] else 'rain'
                conf = (SCORE_METAR_PRECIP_MAX * metar_weight if is_classic_radar_blind
                        else SCORE_METAR_PRECIP_MAX * metar_weight * 0.85)
                return {
                    'active': True, 'type': ptype, 'intensity': 'light',
                    'icon': metar_parsed['icon'],
                    'source': 'metar', 'sourceDetail': f"METAR {obs.get('stationId')}",
                    'confidence': conf, 'observedAt': obs['obs'].get('timestamp'),
                }

        # Sub-threshold radar + model WMO precip signal
        if radar_sub_threshold and model_wmo is not None and model_wmo >= 51:
            om_wet = om_precip_in_hr is not None and om_precip_in_hr > 0.005
            if om_wet or model_wmo >= 61:
                is_snow = (71 <= model_wmo <= 77) or (85 <= model_wmo <= 86)
                ptype = 'snow' if is_snow else 'rain'
                return {
                    'active': True, 'type': ptype, 'intensity': 'light',
                    'icon': 'snow' if is_snow else 'drizzle',
                    'source': 'model', 'sourceDetail': 'model (sub-threshold radar)',
                    'confidence': SCORE_MODEL_PRECIP * 1.5, 'observedAt': None,
                }

        return {
            'active': False, 'type': None, 'intensity': None, 'icon': None,
            'source': 'radar', 'sourceDetail': radar_src,
            'confidence': score_dry, 'observedAt': radar_state.get('timestamp'),
        }

    # No radar — METAR or model
    if metar_parsed and metar_weight > 0.05:
        if metar_parsed['isRain'] or metar_parsed['isSnow'] or metar_parsed['isThunder']:
            ptype = 'snow' if metar_parsed['isSnow'] else 'rain'
            desc_l = metar_parsed['desc'].lower()
            intensity = ('heavy' if 'heavy' in desc_l
                         else 'light' if 'light' in desc_l or 'drizzle' in desc_l
                         else 'moderate')
            return {
                'active': True, 'type': ptype, 'intensity': intensity,
                'icon': metar_parsed['icon'],
                'source': 'metar', 'sourceDetail': f"METAR {obs.get('stationId')}",
                'confidence': SCORE_METAR_PRECIP_MAX * metar_weight,
                'observedAt': obs['obs'].get('timestamp'),
            }
        return {
            'active': False, 'type': None, 'intensity': None, 'icon': None,
            'source': 'metar', 'sourceDetail': f"METAR {obs.get('stationId')}",
            'confidence': SCORE_METAR_DRY_MAX * metar_weight,
            'observedAt': obs['obs'].get('timestamp'),
        }

    if model_wmo is not None:
        is_precip = model_wmo >= 51
        if is_precip:
            is_snow = (71 <= model_wmo <= 77) or (85 <= model_wmo <= 86)
            ptype = 'snow' if is_snow else 'rain'
            intensity = ('heavy' if model_wmo in (65, 75, 82, 86)
                         else 'light' if model_wmo in (61, 71, 80, 51)
                         else 'moderate')
            return {
                'active': True, 'type': ptype, 'intensity': intensity,
                'icon': _wmo_info(model_wmo)['icon'],   # match getWeatherInfo (drizzle/sleet/hail/etc.)
                'source': 'model', 'sourceDetail': 'model',
                'confidence': SCORE_MODEL_PRECIP, 'observedAt': None,
            }
        return {
            'active': False, 'type': None, 'intensity': None, 'icon': None,
            'source': 'model', 'sourceDetail': 'model',
            'confidence': SCORE_MODEL_PRECIP, 'observedAt': None,
        }

    return {
        'active': False, 'type': None, 'intensity': None, 'icon': None,
        'source': 'none', 'sourceDetail': None,
        'confidence': 0.0, 'observedAt': None,
    }


# ── Poll-cycle self-correction (prediction memory) ───────────────────────────
# Parity with nowcast.js v1.48.0: _applyPredictionMemory / resetPredictionMemory.

PRED_MEMORY_MAX_AGE_MS = 15 * 60 * 1000
PRED_STABLE_DRIFT_MIN = 5    # ≤ this drift counts as converging
PRED_DIVERGE_DRIFT_MIN = 15  # > this drift counts as diverging

_CONF_TIERS = ['low', 'med', 'high']


def _conf_shift(conf: str, delta: int) -> str:
    i = _CONF_TIERS.index(conf) if conf in _CONF_TIERS else 0
    return _CONF_TIERS[max(0, min(len(_CONF_TIERS) - 1, i + delta))]


def apply_prediction_memory(memory: Optional[Dict], kind: str,
                            new_target_ms: float, confidence: str,
                            now_ms: float) -> Dict:
    """PURE — converging predictions (≤5 min drift twice) boost one tier and
    smooth; diverging (>15 min) decay a tier. Returns
    {'targetMs', 'confidence', 'memory'}."""
    fresh = {'kind': kind, 'targetMs': new_target_ms, 'updatedAtMs': now_ms,
             'stableCount': 0}
    if (not memory or memory['kind'] != kind
            or (now_ms - memory['updatedAtMs']) > PRED_MEMORY_MAX_AGE_MS):
        return {'targetMs': new_target_ms, 'confidence': confidence, 'memory': fresh}

    drift_min = abs(new_target_ms - memory['targetMs']) / 60000
    if drift_min <= PRED_STABLE_DRIFT_MIN:
        stable_count = memory['stableCount'] + 1
        target_ms = round(0.7 * new_target_ms + 0.3 * memory['targetMs'])
        conf = _conf_shift(confidence, +1) if stable_count >= 2 else confidence
        return {'targetMs': target_ms, 'confidence': conf,
                'memory': {'kind': kind, 'targetMs': target_ms,
                           'updatedAtMs': now_ms, 'stableCount': stable_count}}
    if drift_min > PRED_DIVERGE_DRIFT_MIN:
        return {'targetMs': new_target_ms,
                'confidence': _conf_shift(confidence, -1), 'memory': fresh}
    return {'targetMs': new_target_ms, 'confidence': confidence,
            'memory': {'kind': kind, 'targetMs': new_target_ms,
                       'updatedAtMs': now_ms, 'stableCount': memory['stableCount']}}


class PredictionMemory:
    """Stateful wrapper — one instance per city (mirrors the JS module state)."""

    def __init__(self):
        self.state: Optional[Dict] = None

    def reset(self):
        self.state = None

    def apply(self, kind: str, new_target_ms: float, confidence: str,
              now_ms: float):
        out = apply_prediction_memory(self.state, kind, new_target_ms,
                                      confidence, now_ms)
        self.state = out['memory']
        return out['targetMs'], out['confidence']


# ── Precip Trend 0-60 min (edge-geometry primary, slope fallback) ────────────
# Parity with nowcast.js v1.47.0: _clampPrecision / _slopeSignal /
# _deriveDryTiming / _deriveWetTiming / _summarizeTrend.

def clamp_precision(minutes: Optional[int], confidence: str) -> Optional[int]:
    """PURE — benchmark precision floors: low → ≥15 min, med → ≥10 min."""
    if minutes is None:
        return None
    if confidence == 'low':
        return max(minutes, 15)
    if confidence == 'med':
        return max(minutes, 10)
    return minutes


def slope_signal(timeline: Optional[List[Dict]], is_raining: bool) -> Optional[Dict]:
    """PURE — slope tier from timeline wet buckets (legacy logic, capped at
    med). Returns {'minutes', 'tier', 'intermittent'} or None."""
    if not timeline:
        return None
    wet = [b for b in timeline if b['precipClass'] > 0]
    if not wet:
        return None
    run_count, prev_wet = 0, False
    for b in timeline:
        w = b['precipClass'] > 0
        if w and not prev_wet:
            run_count += 1
        prev_wet = w
    avg_conf = sum(b['confidence'] for b in wet) / len(wet)
    tier = 'high' if avg_conf >= 0.7 else 'med' if avg_conf >= 0.4 else 'low'
    if tier == 'high':
        tier = 'med'  # slope-only never exceeds med
    minutes = wet[-1]['minute'] if is_raining else wet[0]['minute']
    return {'minutes': minutes, 'tier': tier, 'intermittent': run_count >= 3}


def derive_dry_timing(edge: Optional[Dict], slope: Optional[Dict],
                      motion: Optional[Dict]) -> Dict:
    """PURE — fuse edge + slope for the dry case."""
    if edge and edge.get('beginInMin') is not None:
        slope_agrees = slope is not None
        fast_enough = bool(motion and motion.get('speed_kmh', 0) >= 10)
        if edge['lateralHits'] >= 2 and fast_enough and slope_agrees:
            return {'minutes': edge['beginInMin'], 'confidence': 'high', 'method': 'edge'}
        if edge['lateralHits'] >= 2:
            return {'minutes': edge['beginInMin'], 'confidence': 'med', 'method': 'edge'}
        return {'minutes': edge['beginInMin'], 'confidence': 'low', 'method': 'edge'}
    if slope is not None:
        return {'minutes': slope['minutes'], 'confidence': slope['tier'], 'method': 'slope'}
    return {'minutes': None, 'confidence': 'low', 'method': 'none'}


# RainViewer nowcast consensus — parity with _applyRvConsensus (JS v1.49.0)
RV_AGREE_MIN = 10     # |edge − rv| ≤ this → consensus boost
RV_DISAGREE_MIN = 20  # |edge − rv| > this → cap edge at med


def apply_rv_consensus(timing: Dict, rv_minutes: Optional[int]) -> Dict:
    """PURE — merge RainViewer's model nowcast with the derived timing.
    edge+RV agree → boost a tier and blend ('consensus'); disagree → keep edge,
    cap at med; method 'none' → RV timing at med ('rv'); slope/edge-horizon →
    unchanged."""
    if rv_minutes is None:
        return timing
    if timing['method'] == 'edge' and timing['minutes'] is not None:
        diff = abs(timing['minutes'] - rv_minutes)
        if diff <= RV_AGREE_MIN:
            return {'minutes': round(0.7 * timing['minutes'] + 0.3 * rv_minutes),
                    'confidence': _conf_shift(timing['confidence'], +1),
                    'method': 'consensus'}
        if diff > RV_DISAGREE_MIN and timing['confidence'] == 'high':
            return {'minutes': timing['minutes'], 'confidence': 'med', 'method': 'edge'}
        return timing
    if timing['method'] == 'none':
        return {'minutes': rv_minutes, 'confidence': 'med', 'method': 'rv'}
    return timing


def derive_wet_timing(edge: Optional[Dict], slope: Optional[Dict],
                      motion: Optional[Dict], edge_attempted: bool) -> Dict:
    """PURE — fuse edge + slope for the wet case. 'edge-horizon' = trailing
    edge beyond march range: rain continues all hour."""
    if edge and edge.get('endInMin') is not None:
        fast_enough = bool(motion and motion.get('speed_kmh', 0) >= 10)
        return {'minutes': edge['endInMin'],
                'confidence': 'high' if fast_enough else 'med', 'method': 'edge'}
    if edge_attempted and motion and motion.get('speed_kmh', 0) >= 5:
        return {'minutes': None, 'confidence': 'med', 'method': 'edge-horizon'}
    if slope is not None:
        return {'minutes': slope['minutes'], 'confidence': slope['tier'], 'method': 'slope'}
    return {'minutes': None, 'confidence': 'low', 'method': 'none'}


def _format_clock_time_rounded(ms_epoch: float, round_min: int = 5,
                               utc_offset_sec: Optional[int] = None) -> str:
    """Clock time rounded to the nearest round_min minutes, e.g. '3:45 PM'.
    Parity with formatClockTimeRounded (JS)."""
    from datetime import datetime, timezone, timedelta
    round_ms = round_min * 60 * 1000
    rounded = round(ms_epoch / round_ms) * round_ms
    tz = timezone(timedelta(seconds=utc_offset_sec)) if utc_offset_sec is not None else None
    dt = datetime.fromtimestamp(rounded / 1000, tz or timezone.utc)
    if tz is None:
        dt = dt.astimezone()  # local time, matching the JS browser-local fallback
    hour = dt.hour % 12 or 12
    ampm = 'AM' if dt.hour < 12 else 'PM'
    return f'{hour}:{dt.minute:02d} {ampm}'


def summarize_trend(timeline: Optional[List[Dict]], is_raining: bool,
                    minutes: Optional[int], confidence: str, method: str,
                    intermittent: bool, now_ms: float,
                    utc_offset_sec: Optional[int] = None) -> Optional[Dict]:
    """PURE(ish) — confidence-aware human wording. Parity with _summarizeTrend.
    high → clock times; med → ±5 min ranges; low → vague strings only."""
    if method == 'slope' and intermittent:
        return {'text': 'Intermittent rain next hour', 'confidence': 'low'}

    if is_raining:
        if minutes is None:
            if method == 'edge-horizon':
                return {'text': 'Rain continuing this hour', 'confidence': 'med'}
            return {'text': 'Rain now, clearing later', 'confidence': 'low'}
        if confidence == 'high':
            t = _format_clock_time_rounded(now_ms + minutes * 60000, 5, utc_offset_sec)
            return {'text': f'Clearing by ~{t}', 'confidence': 'high'}
        if confidence == 'med':
            lo = max(5, minutes - 5)
            return {'text': f'Rain tapering off in ~{lo}–{minutes + 5} min', 'confidence': 'med'}
        return {'text': 'Rain now, clearing later', 'confidence': 'low'}

    # Dry case
    if minutes is None:
        return None
    if confidence == 'high':
        t = _format_clock_time_rounded(now_ms + minutes * 60000, 5, utc_offset_sec)
        return {'text': f'Rain starting ~{t}', 'confidence': 'high'}
    if confidence == 'med':
        lo = max(5, minutes - 5)
        return {'text': f'Rain likely in ~{lo}–{minutes + 5} min', 'confidence': 'med'}
    return {'text': 'Showers possible soon', 'confidence': 'low'}


def compute_precip_trend(timeline: Optional[List[Dict]],
                         is_raining: bool,
                         edge: Optional[Dict],
                         edge_attempted: bool,
                         motion: Optional[Dict],
                         fallback_minutes: Optional[int] = None,
                         now_ms: Optional[float] = None,
                         utc_offset_sec: Optional[int] = None,
                         pred_memory: Optional['PredictionMemory'] = None,
                         rv_minutes: Optional[int] = None) -> Dict:
    """Fused precip trend — parity with _computePrecipTrend60m (JS v1.49.0).

    edge: result of RadarSampler.sample_edge_timing (or None).
    fallback_minutes: estimate_rain_timing minutes when timeline is missing.
    now_ms: injectable for deterministic tests (defaults to wall clock).
    pred_memory: per-city PredictionMemory for poll-cycle self-correction.
    rv_minutes: RainViewer nowcast begin/end minutes for consensus (or None).
    """
    import time as _time
    if now_ms is None:
        now_ms = _time.time() * 1000

    slope = slope_signal(timeline, is_raining)
    if slope is None and timeline is None and fallback_minutes is not None:
        slope = {'minutes': fallback_minutes, 'tier': 'low', 'intermittent': False}

    timing = (derive_wet_timing(edge, slope, motion, edge_attempted) if is_raining
              else derive_dry_timing(edge, slope, motion))
    timing = apply_rv_consensus(timing, rv_minutes)

    # Self-correction against the previous poll's prediction
    raw_minutes = timing['minutes']
    confidence = timing['confidence']
    if raw_minutes is not None and pred_memory is not None:
        kind = 'end' if is_raining else 'begin'
        target_ms, confidence = pred_memory.apply(
            kind, now_ms + raw_minutes * 60000, confidence, now_ms)
        raw_minutes = max(0, round((target_ms - now_ms) / 60000))

    minutes = clamp_precision(raw_minutes, confidence)

    summary = summarize_trend(timeline, is_raining, minutes,
                              confidence, timing['method'],
                              slope['intermittent'] if slope else False,
                              now_ms, utc_offset_sec)
    return {
        'timeline':          timeline,
        'summary':           summary['text'] if summary else None,
        'summaryConfidence': summary['confidence'] if summary else 'low',
        'beginInMin':        None if is_raining else minutes,
        'endInMin':          minutes if is_raining else None,
        'method':            timing['method'],
        'edge': ({'distKm': edge['edgeDistKm'],
                  'speedKmh': edge['closingSpeedKmh'],
                  'lateralHits': edge['lateralHits']} if edge else None),
    }


# ── Lightning state (merge GLM + METAR, with GLM disabled in collector v1) ──

def compute_lightning_state(obs: Optional[Dict], radar_state: Optional[Dict],
                            motion: Optional[Dict], lx_glm: Dict) -> Dict:
    """Merges the (currently empty) GLM state with METAR thunder fallback.

    Mirrors _computeLightningState() in nowcast.js.
    """
    metar = _detect_thunder_from_sources(obs, radar_state)
    metar_age = metar_age_minutes(obs['obs'].get('timestamp')) if obs and obs.get('obs') else float('inf')
    metar_explicit = metar['isThunder'] and metar['source'] == 'METAR'

    state = lx_glm['state']
    confidence = lx_glm['confidence']
    source = 'lightning' if lx_glm['state'] != 'none' else 'none'
    nearest_mi = lx_glm['nearestFlashMi']

    if state in ('active', 'nearby') and metar_explicit and metar_age < 20:
        confidence = 'high'
        source = 'merged'

    if lx_glm['flashCounts']['within10mi'] > 0 and metar_explicit:
        state = 'active'
        confidence = 'high'
        source = 'merged'

    if state == 'none' and metar_explicit:
        if metar_age < 20:
            state = 'nearby'
            confidence = 'medium'
            source = 'metar-fallback'
            nearest_mi = 10
        elif metar_age < 45:
            state = 'nearby'
            confidence = 'low'
            source = 'metar-fallback'
            nearest_mi = 10

    is_approaching = False
    if state == 'approaching' and motion and motion.get('speed_kmh', 0) > 10:
        is_approaching = True
    if state == 'approaching' and lx_glm['trend'] == 'rising' and motion and motion.get('speed_kmh', 0) > 5:
        is_approaching = True

    return {
        'state': state,
        'nearestFlashMi': nearest_mi,
        'flashCounts': lx_glm['flashCounts'],
        'updatedAt': lx_glm['updatedAt'],
        'source': source,
        'confidence': confidence,
        'connected': lx_glm['connected'],
        'bufferAgeMs': lx_glm['bufferAgeMs'],
        'lastFlashAt': lx_glm['lastFlashAt'],
        'trend': lx_glm['trend'],
        '_isApproaching': is_approaching,
    }


def _detect_thunder_from_sources(obs, radar_state) -> Dict:
    pw = obs['obs'].get('presentWeather') if obs and obs.get('obs') else None
    text = obs['obs'].get('textDescription') if obs and obs.get('obs') else None
    dbz = radar_state.get('dbz') if radar_state else None
    return detect_thunder(pw, text, dbz)


# ── Synthesized nowcast state ────────────────────────────────────────────────

def derive_nowcast_state(radar_state, obs, model_wmo, lightning_state, trend,
                         country: str, om_precip_in_hr=None) -> Dict:
    is_us = country == 'United States'
    precip = score_precip_now(radar_state, obs, model_wmo, is_us, om_precip_in_hr)
    sky = _score_sky_state(obs, model_wmo)
    thunder = _normalize_thunder(lightning_state)

    sources = []
    if precip['sourceDetail'] and precip['sourceDetail'] != 'model':
        sources.append(precip['sourceDetail'])
    if (sky['sourceDetail']
            and sky['sourceDetail'] != precip['sourceDetail']
            and sky['sourceDetail'] != 'model'):
        sources.append(sky['sourceDetail'])
    if thunder['state'] != 'none' and thunder['source'] in ('lightning', 'merged'):
        sources.append('GOES GLM')
    if not sources and (precip['sourceDetail'] == 'model' or sky['sourceDetail'] == 'model'):
        sources.append('Model forecast')

    return {'precip': precip, 'sky': sky, 'thunder': thunder, 'trend': trend, 'sources': sources}


def _score_sky_state(obs, model_wmo) -> Dict:
    """Simplified port — no hysteresis (sky hysteresis lives across polls in JS,
    but collector polls are far enough apart that the practical effect is negligible).
    The parity test will catch any cases where this matters."""
    metar_score = 0.0
    metar_cover = None
    metar_icon = None
    metar_src = None
    metar_observed_at = None

    if obs and obs.get('obs'):
        o = obs['obs']
        age = metar_age_minutes(o.get('timestamp'))
        parsed = parse_metar_condition(o.get('presentWeather'), o.get('textDescription'))
        if parsed['desc'] != 'Unknown':
            if age <= 20:    metar_score = SCORE_METAR_SKY_MAX
            elif age <= 40:  metar_score = 0.70
            elif age <= 60:  metar_score = 0.50
            else:            metar_score = 0.30
            metar_cover = parsed['desc']
            metar_icon = parsed['icon']
            metar_src = f"METAR {obs.get('stationId')}"
            metar_observed_at = o.get('timestamp')

    model_cover = None
    model_icon = None
    if model_wmo is not None:
        info = _wmo_info(model_wmo)
        if info['desc'] != 'Unknown':
            # Cover mapping mirrors _scoreSkyState: explicit labels for sky
            # codes, else the WMO description (e.g. "Light drizzle").
            if model_wmo <= 1:
                model_cover = 'Clear'
            elif model_wmo == 2:
                model_cover = 'Partly Cloudy'
            elif model_wmo == 3:
                model_cover = 'Overcast'
            elif model_wmo in (45, 48):
                model_cover = 'Fog'
            else:
                model_cover = info['desc']
            model_icon = info['icon']

    if metar_cover and metar_score > SCORE_MODEL_SKY:
        return {
            'cover': metar_cover, 'visibility': None, 'icon': metar_icon,
            'source': 'metar', 'sourceDetail': metar_src,
            'confidence': metar_score, 'observedAt': metar_observed_at,
        }
    if model_cover:
        return {
            'cover': model_cover, 'visibility': None, 'icon': model_icon,
            'source': 'model', 'sourceDetail': 'model',
            'confidence': SCORE_MODEL_SKY, 'observedAt': None,
        }
    return {
        'cover': None, 'visibility': None, 'icon': None,
        'source': 'none', 'sourceDetail': None,
        'confidence': 0.0, 'observedAt': None,
    }


def _normalize_thunder(lx: Optional[Dict]) -> Dict:
    if not lx or lx['state'] == 'none':
        return {
            'state': 'none', 'nearestMi': None,
            'source': lx['source'] if lx else 'none',
            'confidence': 0.0,
            'updatedAt': lx['updatedAt'] if lx else None,
        }
    conf_map = {'high': 0.85, 'medium': 0.55, 'low': 0.3, 'none': 0.0}
    return {
        'state': lx['state'], 'nearestMi': lx['nearestFlashMi'],
        'source': lx['source'],
        'confidence': conf_map.get(lx['confidence'], 0.0),
        'updatedAt': lx['updatedAt'] or lx.get('lastFlashAt'),
    }
