"""Tests for intensity-aware nowcast wording (unshipped v1.52.0 batch).

"Heavy rain starting ~3:45 PM" vs "Light rain likely in ~20–30 min" — the
prefix comes ONLY from observed echo (edge/consensus/rv methods). Null
intensity must render the exact pre-intensity strings, so every older
exact-string test keeps passing untouched.
"""

from collector_lib import nowcast as nc
from collector_lib.radar_sampler import _edge_intensity_dbz, RADAR_CFG

T0 = 1_760_000_000_000
STEP = RADAR_CFG['EDGE_STEP_KM']


def _profile(dbz_list):
    return [{'distKm': i * STEP, 'dbz': d} for i, d in enumerate(dbz_list)]


# ── intensity_word thresholds ────────────────────────────────────────────────

def test_intensity_word_thresholds():
    assert nc.intensity_word(None) == 'Rain'
    assert nc.intensity_word(27) == 'Light rain'
    assert nc.intensity_word(28) == 'Rain'
    assert nc.intensity_word(39) == 'Rain'
    assert nc.intensity_word(40) == 'Heavy rain'
    assert nc.intensity_word(55) == 'Heavy rain'


# ── _edge_intensity_dbz ──────────────────────────────────────────────────────

def test_edge_intensity_heavy_core_behind_edge():
    # dry to 20 km (10 samples), then a 45-dBZ core
    prof = _profile([None] * 10 + [45, 48, 45, 50, 44])
    assert _edge_intensity_dbz(prof, 20) >= 40


def test_edge_intensity_light_shield():
    prof = _profile([None] * 10 + [20, 22, 21, 20, 23])
    assert _edge_intensity_dbz(prof, 20) < 28


def test_edge_intensity_depth_limited():
    # Heavy core BEYOND the 16-km characterization depth must not count:
    # edge at 20 km → depth window 20–36 km (samples 10..18)
    prof = _profile([None] * 10 + [20, 21, 20, 21, 20, 21, 20, 21, 20] + [55, 55, 55])
    assert _edge_intensity_dbz(prof, 20) < 28


def test_edge_intensity_empty():
    assert _edge_intensity_dbz(_profile([None] * 15), 10) is None


# ── Wording end-to-end ───────────────────────────────────────────────────────

def _edge(begin=30, hits=3, intensity=None):
    return {'beginInMin': begin, 'endInMin': None, 'edgeDistKm': 20,
            'closingSpeedKmh': 40, 'lateralHits': hits, 'intensityDbz': intensity}


def test_heavy_prefix_at_high_confidence():
    slope = {'minutes': 25, 'tier': 'med', 'intermittent': False, 'horizon': False}
    trend = nc.compute_precip_trend(
        timeline=None, is_raining=False, edge=_edge(intensity=45),
        edge_attempted=True, motion={'speed_kmh': 40, 'source': 'radar'},
        fallback_minutes=25, now_ms=T0, utc_offset_sec=0)
    # fallback slope gives agreement; expect high + Heavy prefix
    assert trend['summary'].startswith('Heavy rain starting ~')


def test_light_prefix_at_med_confidence():
    trend = nc.compute_precip_trend(
        timeline=None, is_raining=False, edge=_edge(intensity=22, hits=2),
        edge_attempted=True, motion={'speed_kmh': 40, 'source': 'radar'},
        now_ms=T0, utc_offset_sec=0)
    assert trend['summary'].startswith('Light rain likely in ~')


def test_null_intensity_renders_legacy_strings():
    trend = nc.compute_precip_trend(
        timeline=None, is_raining=False, edge=_edge(intensity=None, hits=2),
        edge_attempted=True, motion={'speed_kmh': 40, 'source': 'radar'},
        now_ms=T0, utc_offset_sec=0)
    assert trend['summary'].startswith('Rain likely in ~')


def test_consensus_keeps_edge_intensity():
    t = nc.apply_rv_consensus(
        {'minutes': 30, 'confidence': 'med', 'method': 'edge', 'intensityDbz': 45},
        rv_minutes=28, rv_intensity_dbz=20)
    assert t['method'] == 'consensus'
    assert t['intensityDbz'] == 45     # edge's observed echo wins over RV's


def test_rv_only_carries_rv_intensity():
    t = nc.apply_rv_consensus(
        {'minutes': None, 'confidence': 'low', 'method': 'none', 'intensityDbz': None},
        rv_minutes=25, rv_intensity_dbz=42)
    assert t['method'] == 'rv'
    assert t['intensityDbz'] == 42


def test_slope_never_gets_intensity():
    slope = {'minutes': 25, 'tier': 'med', 'intermittent': False, 'horizon': False}
    t = nc.derive_dry_timing(None, slope, None)
    assert t['intensityDbz'] is None


def test_edge_diagnostic_includes_intensity():
    trend = nc.compute_precip_trend(
        timeline=None, is_raining=False, edge=_edge(intensity=33, hits=2),
        edge_attempted=True, motion={'speed_kmh': 40, 'source': 'radar'},
        now_ms=T0)
    assert trend['edge']['intensityDbz'] == 33
