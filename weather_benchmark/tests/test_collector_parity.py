"""Parity tests for the Python collector vs the JS browser nowcast.

This is the train/serve-skew check from the validation plan. The Python and
JS implementations must agree on key outputs; any drift between them is a bug.

Two complementary approaches:

1. **Unit-level parity** (the tests here) — feed identical synthetic inputs
   to the Python port and assert outputs. The JS reference values are
   captured as fixtures; if the JS algorithm changes, fixtures regenerate.

2. **Live parity** (test_collector_live_parity.py, future) — run the browser
   via Playwright alongside the collector for the same city; diff snapshots.
   Requires Playwright; skipped in CI by default.

Usage:
    pytest weather_benchmark/tests/test_collector_parity.py -v
"""

import pytest

from collector_lib import nowcast as nc
from collector_lib.lightning import empty_lightning_state, detect_thunder
from collector_lib.radar_sampler import _dbz_to_precip_class


# ── Threshold parity ─────────────────────────────────────────────────────────

def test_intensity_thresholds_match_v144_changes():
    """DBZ → intensity must match v1.44.0 thresholds from CLAUDE.md."""
    # Verified against src/services/nowcast.js _scorePrecipNow:
    #   >= 45  heavy   (was 50)
    #   >= 30  moderate (was 35)
    #   >= 22  light    (was 28)
    cases = [
        (44, 'moderate'),
        (45, 'heavy'),
        (50, 'heavy'),
        (30, 'moderate'),
        (29, 'light'),
        (22, 'light'),
        (21, 'light'),  # else path keeps light
    ]
    for dbz, expected in cases:
        radar = {'isRaining': True, 'dbz': dbz, 'rainState': 'ON', 'timestamp': '2026-01-01T00:00:00+00:00'}
        scored = nc.score_precip_now(radar, None, None, is_us=True)
        assert scored['intensity'] == expected, f'dBZ={dbz} → expected {expected}, got {scored["intensity"]}'


def test_precip_class_thresholds():
    """_dbzToPrecipClass parity with radarSampler.js v1.44.0."""
    assert _dbz_to_precip_class(21) == 0    # dry
    assert _dbz_to_precip_class(22) == 1    # drizzle / very light
    assert _dbz_to_precip_class(29) == 1
    assert _dbz_to_precip_class(30) == 2    # light-moderate
    assert _dbz_to_precip_class(39) == 2
    assert _dbz_to_precip_class(40) == 3    # heavy
    assert _dbz_to_precip_class(49) == 3
    assert _dbz_to_precip_class(50) == 4    # convective


def test_virga_veto_humidity_branch():
    """v1.44.0 added humidity < 60% as a virga signal alongside spread > 6°C."""
    radar = {'isRaining': True, 'dbz': 32, 'rainState': 'ON',
             'timestamp': '2026-01-01T00:00:00+00:00'}
    obs = {
        'stationId': 'KTST',
        'obs': {
            'timestamp': _recent_iso(),
            'presentWeather': '',         # METAR says dry
            'textDescription': 'Clear',
            'temperature_c': 28.0,
            'humidity': 45.0,             # < 60% → virga signal
        }
    }
    scored = nc.score_precip_now(radar, obs, model_wmo=None, is_us=True,
                                 om_precip_in_hr=0.0)
    assert scored['active'] is False, 'Virga veto failed with humidity < 60%'


def test_virga_veto_temp_dewpoint_spread():
    """Spread > 6°C should trigger virga veto independently of OM.

    Test isolates the virga branch by forcing om_precip_in_hr > 0.01 (so
    om_also_dry is False) — the veto must come from the temp/dewpoint signal.
    """
    radar = {'isRaining': True, 'dbz': 32, 'rainState': 'ON',
             'timestamp': '2026-01-01T00:00:00+00:00'}
    obs = {
        'stationId': 'KTST',
        'obs': {
            'timestamp': _recent_iso(),
            'presentWeather': '',
            'textDescription': 'Clear',
            'temperature_c': 35.0,
            'humidity': 50.0,            # ~16°C dewpoint, ~19°C spread → virga
        }
    }
    # om_precip_in_hr > 0.01 disables the OM agreement path, forcing virga branch
    scored = nc.score_precip_now(radar, obs, model_wmo=None, is_us=True,
                                 om_precip_in_hr=0.05)
    assert scored['active'] is False, 'Virga veto should fire on large spread'

    # Same setup but small spread (high humidity) → no virga, no OM agreement → NOT vetoed
    obs2 = dict(obs)
    obs2['obs'] = dict(obs['obs'])
    obs2['obs']['temperature_c'] = 20.0
    obs2['obs']['humidity'] = 98.0
    scored2 = nc.score_precip_now(radar, obs2, model_wmo=None, is_us=True,
                                  om_precip_in_hr=0.05)
    assert scored2['active'] is True, 'No virga signal + OM wet → must remain active'


def test_tier1_veto_uses_30_dbz_boundary():
    """v1.44.0 raised the Tier 1 / Tier 2 boundary from 28 → 30 dBZ."""
    obs_dry = {
        'stationId': 'KTST',
        'obs': {
            'timestamp': _recent_iso(),
            'presentWeather': '',
            'textDescription': 'Clear',
            'temperature_c': 20.0, 'humidity': 90.0,
        }
    }
    # 29 dBZ should hit Tier 1 (< 30) and get vetoed by METAR alone
    radar_29 = {'isRaining': True, 'dbz': 29, 'rainState': 'ON',
                'timestamp': '2026-01-01T00:00:00+00:00'}
    s29 = nc.score_precip_now(radar_29, obs_dry, model_wmo=None, is_us=True,
                              om_precip_in_hr=0.0)
    assert s29['active'] is False, 'Tier 1 veto failed at dBZ=29'


def test_dbz_thresholds_for_legacy_precip_now():
    """compute_precip_now legacy path also reflects v1.44.0 thresholds."""
    cases = [
        (45, 'Heavy Rain'),
        (30, 'Rain'),
        (22, 'Light Rain'),
        (18, 'Drizzle'),
    ]
    for dbz, expected in cases:
        radar = {'isRaining': True, 'dbz': dbz, 'rainState': 'ON',
                 'timestamp': '2026-01-01T00:00:00+00:00'}
        out = nc.compute_precip_now(None, radar, 'United States')
        assert out is not None
        assert out['desc'] == expected, f'dBZ={dbz} → {expected}, got {out["desc"]}'


# ── Trend / timeline parity ──────────────────────────────────────────────────

def test_slope_only_caps_at_med():
    """v1.44.0 rule carried into v1.47.0: slope-only predictions (no edge
    confirmation) cap at 'med' and never use exact-minute onset wording."""
    timeline = [
        {'minute': i * 5, 'precipClass': 1 if i * 5 >= 10 else 0,
         'projectedDbz': 25 if i * 5 >= 10 else 0,
         'confidence': max(0.1, 1.0 - i * 0.10)} for i in range(12)
    ]
    trend = nc.compute_precip_trend(
        timeline=timeline, is_raining=False, edge=None, edge_attempted=False,
        motion=None, now_ms=1_760_000_000_000,
    )
    assert trend['summary'] is not None
    assert trend['summaryConfidence'] in ('med', 'low')
    assert trend['method'] == 'slope'
    # Must NOT claim a clock time — that requires edge confirmation
    assert 'starting ~' not in trend['summary']


def test_edge_good_plus_slope_can_be_high():
    """Edge with spread + fast motion + slope agreement → high tier, clock time."""
    timeline = [
        {'minute': i * 5, 'precipClass': 1 if i * 5 >= 15 else 0,
         'projectedDbz': 25 if i * 5 >= 15 else 0,
         'confidence': max(0.1, 1.0 - i * 0.10)} for i in range(12)
    ]
    edge = {'beginInMin': 15, 'endInMin': None, 'edgeDistKm': 10,
            'closingSpeedKmh': 40, 'lateralHits': 3}
    trend = nc.compute_precip_trend(
        timeline=timeline, is_raining=False, edge=edge, edge_attempted=True,
        motion={'speed_kmh': 40}, now_ms=1_760_000_000_000, utc_offset_sec=0,
    )
    assert trend['summaryConfidence'] == 'high'
    assert trend['summary'].startswith('Rain starting ~')
    assert trend['beginInMin'] == 15


# ── Thunder / lightning fallback parity ──────────────────────────────────────

def test_detect_thunder_metar_ts():
    out = detect_thunder('TSRA', '', None)
    assert out['isThunder'] is True
    assert out['source'] == 'METAR'


def test_detect_thunder_text_fallback():
    out = detect_thunder('', 'Thunder in vicinity', None)
    assert out['isThunder'] is True


def test_detect_thunder_radar_alone_does_not_promote():
    out = detect_thunder('', '', 55)
    assert out['isThunder'] is False, 'High dBZ alone must not claim thunder'


def test_detect_thunder_radar_plus_convective_metar():
    out = detect_thunder('+RA', '', 50)
    assert out['isThunder'] is True
    assert out['source'] == 'NEXRAD+METAR'


def test_glm_unavailable_falls_back_to_metar():
    glm = empty_lightning_state()
    obs = {
        'stationId': 'KTST',
        'obs': {
            'timestamp': _recent_iso(),
            'presentWeather': 'TSRA',
            'textDescription': '',
        }
    }
    state = nc.compute_lightning_state(obs, None, None, glm)
    assert state['state'] == 'nearby'
    assert state['source'] == 'metar-fallback'


# ── METAR parsing parity ─────────────────────────────────────────────────────

def test_parse_metar_condition_precedence():
    # +TS should beat TSRA pattern (specificity)
    p = nc.parse_metar_condition('+TS', None)
    assert p['desc'] == 'Heavy Thunderstorm'

    p = nc.parse_metar_condition('TSRA', None)
    assert p['desc'] == 'Thunderstorm'
    assert p['isRain'] is True

    p = nc.parse_metar_condition('RA', None)
    assert p['desc'] == 'Rain'

    # NOTE: This is a known parity quirk. JS pattern \bRA\b matches '-RA' because
    # '-' is a non-word char and \b is satisfied between '-' and 'R'. So '-RA'
    # returns 'Rain' rather than 'Light Rain'. The Python port replicates that
    # behavior faithfully. Fixing this is an algorithm improvement and would
    # also need to land in src/utils/metarParse.js — track separately if pursued.
    p = nc.parse_metar_condition('-RA', None)
    assert p['desc'] == 'Rain'


def test_parse_metar_text_fallback():
    p = nc.parse_metar_condition('', 'Overcast')
    assert p['desc'] == 'Overcast'

    p = nc.parse_metar_condition('', 'Mostly Clear')
    assert p['desc'] == 'Mostly Clear'


# ── Helpers ──────────────────────────────────────────────────────────────────

def _recent_iso():
    """An ISO timestamp 'right now' so freshness weights stay max."""
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


# ── WMO code → icon / sky-cover parity (getWeatherInfo port) ─────────────────

def test_model_precip_icon_matches_weathercodes():
    """No radar, no METAR, model precip code: precip.icon must match
    getWeatherInfo(code).icon (weatherCodes.js), not a hardcoded rain/snow."""
    cases = [
        (51, 'drizzle'),            # light drizzle
        (53, 'drizzle'),
        (56, 'sleet'),              # freezing drizzle
        (66, 'sleet'),              # freezing rain
        (80, 'drizzle'),            # slight rain showers
        (82, 'thunderstorms-rain'),
        (95, 'thunderstorms-rain'),
        (96, 'hail'),
        (99, 'hail'),
        (63, 'rain'),               # plain rain still 'rain'
        (75, 'snow'),               # snow still 'snow'
    ]
    for wmo, expected_icon in cases:
        scored = nc.score_precip_now(None, None, model_wmo=wmo, is_us=True)
        assert scored['active'] is True, f'wmo={wmo} should be active precip'
        assert scored['icon'] == expected_icon, (
            f'wmo={wmo} → icon {expected_icon}, got {scored["icon"]}')


def test_model_sky_cover_matches_weathercodes():
    """No METAR, model code: sky cover/icon must mirror _scoreSkyState."""
    # Sky-code explicit labels
    assert nc._score_sky_state(None, 2)['cover'] == 'Partly Cloudy'
    assert nc._score_sky_state(None, 3)['cover'] == 'Overcast'
    assert nc._score_sky_state(None, 45)['cover'] == 'Fog'
    # Precip code → WMO description as cover (was incorrectly None before)
    drizzle = nc._score_sky_state(None, 51)
    assert drizzle['cover'] == 'Light drizzle'
    assert drizzle['source'] == 'model'
    assert drizzle['icon'] == 'drizzle'
    storm = nc._score_sky_state(None, 95)
    assert storm['cover'] == 'Thunderstorm'
    assert storm['icon'] == 'thunderstorms-rain'
