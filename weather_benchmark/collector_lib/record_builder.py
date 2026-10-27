"""Port of src/services/nowcastLogger.js _buildLogRecord.

Produces the JSONL schema that ingest.py expects. Each record is a single
snapshot from one city.

_schemaVersion 3 (2026-10-25) adds:
  - ``obs``: the METAR the algorithm actually saw (present weather, temp /
    dewpoint, age vs the poll, raw text) — the surface inputs were previously
    dropped, so ML data had no record of them;
  - ``radar.sampleStatus``: ok | no_echo | fetch_failed (dbz=None was
    ambiguous between "no echo" and "tile fetch failed");
  - ``algoVersion`` / ``gitSha``: which code produced the record.
"""

import re
from datetime import datetime, timezone
from typing import Optional, Dict, Any

from .provenance import algo_version, git_describe

SCHEMA_VERSION = 3
# Read once at import (= collector startup), so they describe the running code.
_ALGO_VERSION = algo_version()
_GIT_SHA = git_describe()


def build_record(*, lat: float, lon: float, country: str, location_name: str,
                 state_code: Optional[str], station: Optional[str],
                 radar_state: Optional[Dict], motion: Optional[Dict],
                 obs: Optional[Dict], summary: Dict,
                 model_context: Optional[Dict],
                 model_hourly: Optional[list],
                 stale_sources: Optional[Dict] = None) -> Dict:
    """Build a JSONL record matching the browser's schema.

    ``stale_sources`` maps a source name ('obs', 'model', 'modelHourly') to the
    age in minutes of the cached response used after a failed fetch (see
    fetchers._stale_fallback). Written as ``_staleSources`` + a
    ``stale_cache`` validation flag; absent when every input was fresh.
    """

    nowcast_state = summary.get('nowcastState') or {}
    precip_ns = nowcast_state.get('precip') or {}
    sky_state = summary.get('skyState')
    precip_state_now = summary.get('precipStateNow')
    trend_60m = summary.get('precipTrend60m') or {}
    lightning_state = summary.get('lightningState')

    precip_active = precip_ns.get('active') is True
    displayed_condition = _desc_from_scored_precip(precip_ns) if precip_active else 'Dry'

    if precip_active:
        displayed_icon = precip_ns.get('icon')
    else:
        sky_icon = (nowcast_state.get('sky') or {}).get('icon')
        if sky_icon and re.search(r'rain|drizzle|thunder|snow|sleet', sky_icon):
            displayed_icon = None
        else:
            displayed_icon = sky_icon

    sky = ({
        'desc': sky_state.get('desc'),
        'source': sky_state.get('source'),
        'confidence': sky_state.get('confidence'),
    } if sky_state else {'desc': None, 'source': None, 'confidence': None})

    trend = {
        'summary': trend_60m.get('summary'),
        'summaryConfidence': trend_60m.get('summaryConfidence'),
        'beginInMin': trend_60m.get('beginInMin'),
        'endInMin': trend_60m.get('endInMin'),
        'timeline': trend_60m.get('timeline'),
        'method': trend_60m.get('method'),   # 'edge' | 'slope' | 'edge-horizon' | 'none'
        'edge': trend_60m.get('edge'),       # {distKm, speedKmh, lateralHits} | None
    }

    lightning = ({
        'state': lightning_state.get('state'),
        'nearestFlashMi': lightning_state.get('nearestFlashMi'),
        'flashCounts': lightning_state.get('flashCounts'),
        'trend': lightning_state.get('trend'),
        'confidence': lightning_state.get('confidence'),
        'source': lightning_state.get('source'),
        'connected': lightning_state.get('connected'),
        'bufferAgeMs': lightning_state.get('bufferAgeMs'),
        'lastFlashAt': lightning_state.get('lastFlashAt'),  # ingest-health audit field
    } if lightning_state else None)

    radar = ({
        'dbz': radar_state.get('dbz'),
        'rainState': radar_state.get('rainState'),
        'source': radar_state.get('source'),
        'lastValidDbzTime': radar_state.get('lastValidDbzTime'),
        'sampleStatus': radar_state.get('sampleStatus'),   # ok | no_echo | fetch_failed
        'motionSpeed': motion.get('speed_kmh') if motion else None,
        'motionDir': motion.get('direction_deg') if motion else None,
        'motionSource': motion.get('source') if motion else None,  # radar | persisted | model-wind
    } if radar_state else None)

    precip = ({
        'phenomenon': precip_state_now.get('phenomenon'),
        'desc': precip_state_now.get('desc'),
        'source': precip_state_now.get('source'),
        'confidence': precip_state_now.get('confidence'),
    } if precip_state_now else None)

    now = datetime.now(timezone.utc)
    record = {
        '_schemaVersion': SCHEMA_VERSION,
        'algoVersion': _ALGO_VERSION,
        'gitSha': _GIT_SHA,
        'timestamp': now.isoformat(),
        'lat': lat,
        'lon': lon,
        'country': country,
        'stateCode': state_code,
        'station': station,
        'locationName': location_name,
        'displayedCondition': displayed_condition,
        'displayedIcon': displayed_icon,
        'precip': precip,
        'sky': sky,
        'lightning': lightning,
        'trend': trend,
        'radar': radar,
        'obs': _obs_block(obs, now),
        'model': model_context,
        'modelHourly': model_hourly,
    }
    if stale_sources:
        record['_staleSources'] = dict(stale_sources)
    _validate_record(record)
    return record


def _obs_block(obs: Optional[Dict], now: datetime) -> Optional[Dict]:
    """The surface observation exactly as the nowcast consumed it."""
    if not obs:
        return None
    o = obs.get('obs') or {}
    ts = o.get('timestamp')
    age_min = None
    if ts:
        try:
            age_min = round((now - datetime.fromisoformat(ts)).total_seconds() / 60.0, 1)
        except (TypeError, ValueError):
            pass
    return {
        'stationId': obs.get('stationId'),
        'timestamp': ts,
        'ageMin': age_min,
        'presentWeather': o.get('presentWeather'),
        'tempC': o.get('temperature_c'),
        'dewpointC': o.get('dewpoint_c'),
        'humidity': o.get('humidity'),
        'visibilityMi': o.get('visibility_mi'),
        'windSpeedKt': o.get('wind_speed_kt'),
        'windDir': o.get('wind_dir'),
        'precip1hIn': o.get('precip_1h_in'),
        'raw': o.get('metar'),
    }


def _desc_from_scored_precip(precip: Dict) -> str:
    if not precip or not precip.get('active'):
        return 'Dry'
    t, i = precip.get('type'), precip.get('intensity')
    if t == 'snow':
        return ('Heavy Snow' if i == 'heavy' else 'Light Snow' if i == 'light' else 'Snow')
    if t == 'rain':
        if i == 'heavy':
            return 'Heavy Rain'
        if i == 'light':
            return 'Light Rain'
        return 'Rain'
    return precip.get('type') or 'Precipitation'


def _validate_record(record: Dict) -> None:
    """Mirror of nowcastLogger.js _validateRecord — flags coherence issues."""
    flags = []
    icon, cond = record.get('displayedIcon'), record.get('displayedCondition')
    if icon and cond:
        icon_is_rain = re.search(r'rain|drizzle|thunder|snow|sleet', icon) is not None
        cond_is_dry = cond == 'Dry'
        icon_is_clear = re.search(r'clear|cloudy|overcast', icon) and not icon_is_rain
        cond_is_rain = re.search(r'drizzle|rain|thunder|snow|sleet', cond, re.IGNORECASE) is not None
        if icon_is_rain and cond_is_dry:
            flags.append('rain_icon_dry_cond')
        if icon_is_clear and cond_is_rain:
            flags.append('clear_icon_rain_cond')
    if record.get('model') is None:
        flags.append('model_unavailable')
    r = record.get('radar')
    if r:
        if r.get('dbz') is None and r.get('rainState') in ('ON', 'HOLDING'):
            flags.append('radar_state_no_dbz')
        if r.get('sampleStatus') == 'fetch_failed':
            flags.append('radar_fetch_failed')
    if record.get('_staleSources'):
        flags.append('stale_cache')
    if flags:
        record['_validationFlags'] = flags
