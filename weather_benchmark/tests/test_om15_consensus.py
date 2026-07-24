"""Tests for the Open-Meteo 15-minutely consensus + v1.53.0 motion tuning.

Replaces the RainViewer nowcast consensus source (free future frames
discontinued upstream). Also pins the calibrated steering-wind speed factor
and the adaptive small-cell correlation gate.
"""

from datetime import datetime, timezone

from collector_lib import nowcast as nc
from collector_lib.radar_sampler import (
    RADAR_CFG, fallback_motion_from_wind, _best_shift,
)

# Fixed epoch: 2026-07-23T20:00:00Z
T0 = datetime(2026, 7, 23, 20, 0, tzinfo=timezone.utc).timestamp() * 1000


def _m15(precips, start='2026-07-23T20:00'):
    base = datetime.fromisoformat(start)
    times = []
    for i in range(len(precips)):
        t = base.replace(minute=(base.minute + 15 * i) % 60,
                         hour=base.hour + (base.minute + 15 * i) // 60)
        times.append(t.strftime('%Y-%m-%dT%H:%M'))
    return {'time': times, 'precipitation': precips}


# ── derive_om15_timing ───────────────────────────────────────────────────────

def test_om15_begin_at_first_wet_slot():
    # dry, dry, wet at +30..45 → transition between slot midpoints 22.5 and 37.5 → ~30
    m15 = _m15([0.0, 0.0, 0.05, 0.08])
    t = nc.derive_om15_timing(m15, False, T0, 0)
    assert t['endInMin'] is None
    assert 25 <= t['beginInMin'] <= 35


def test_om15_end_when_raining():
    # wet slots at +0..30, dry from +30 → end ≈ 30 (midpoint of 23 and 38)
    m15 = _m15([0.06, 0.04, 0.0, 0.0])
    t = nc.derive_om15_timing(m15, True, T0, 0)
    assert t['beginInMin'] is None
    assert 25 <= t['endInMin'] <= 35


def test_om15_trace_below_threshold_is_dry():
    m15 = _m15([0.0, 0.005, 0.005, 0.005])   # all below OM15_WET_IN
    assert nc.derive_om15_timing(m15, False, T0, 0)['beginInMin'] is None


def test_om15_no_data():
    assert nc.derive_om15_timing(None, False, T0, 0) == {'beginInMin': None, 'endInMin': None}
    assert nc.derive_om15_timing({'time': [], 'precipitation': []}, False, T0, 0)['beginInMin'] is None


def test_om15_skips_past_slots():
    # First two slots are in the past relative to T0+40min
    m15 = _m15([0.9, 0.9, 0.0, 0.05])
    t = nc.derive_om15_timing(m15, False, T0 + 40 * 60000, 0)
    assert t['beginInMin'] is not None
    assert t['beginInMin'] <= 15   # wet slot at +45..60 from base = ~5-13 from T0+40


def test_om15_utc_offset_applied():
    # Times written in UTC-4 local; with offset −14400 the wet slot is the same
    # wall-clock instant as the offset-0 case shifted by 4 h
    m15 = _m15([0.0, 0.0, 0.05, 0.08], start='2026-07-23T16:00')
    t = nc.derive_om15_timing(m15, False, T0, -4 * 3600)
    tref = nc.derive_om15_timing(_m15([0.0, 0.0, 0.05, 0.08]), False, T0, 0)
    assert t['beginInMin'] == tref['beginInMin']


# ── consensus with om15 label ────────────────────────────────────────────────

def test_om15_only_fills_method_none():
    trend = nc.compute_precip_trend(timeline=None, is_raining=False, edge=None,
                                    edge_attempted=False, motion=None,
                                    om15_minutes=25, now_ms=T0)
    assert trend['method'] == 'om15'
    assert trend['summaryConfidence'] == 'med'
    assert trend['beginInMin'] == 25
    # model source → no intensity claim
    assert trend['summary'].startswith('Rain likely in ~')


def test_rv_takes_priority_over_om15():
    trend = nc.compute_precip_trend(timeline=None, is_raining=False, edge=None,
                                    edge_attempted=False, motion=None,
                                    rv_minutes=20, om15_minutes=40, now_ms=T0)
    assert trend['method'] == 'rv'
    assert trend['beginInMin'] == 20


def test_om15_consensus_boosts_edge():
    edge = {'beginInMin': 30, 'endInMin': None, 'edgeDistKm': 20,
            'closingSpeedKmh': 40, 'lateralHits': 2, 'intensityDbz': 45}
    trend = nc.compute_precip_trend(timeline=None, is_raining=False, edge=edge,
                                    edge_attempted=True,
                                    motion={'speed_kmh': 40, 'source': 'radar'},
                                    om15_minutes=28, now_ms=T0, utc_offset_sec=0)
    assert trend['method'] == 'consensus'
    assert trend['summaryConfidence'] == 'high'
    assert trend['summary'].startswith('Heavy rain starting ~')


# ── v1.53.0 motion tuning ────────────────────────────────────────────────────

def test_fallback_speed_factor_applied():
    m = fallback_motion_from_wind(20.0, 270.0)
    # 20 mph × 1.609 × 0.75 = 24.135 → 24
    assert m['speed_kmh'] == 24
    assert m['direction_deg'] == 90


def test_small_cell_passes_adaptive_gate():
    """A 2-px echo maxes at overlap 2 — previously always rejected (min 3)."""
    g = 9
    prev = [0] * 81; curr = [0] * 81
    for x, y in ((2, 4), (3, 4)): prev[y * g + x] = 1
    for x, y in ((4, 4), (5, 4)): curr[y * g + x] = 1   # translated +2 east
    shift = _best_shift(prev, curr, g, 4)
    assert shift['score'] == 2
    min_overlap = min(RADAR_CFG['MOTION_MIN_OVERLAP'], max(2, min(sum(prev), sum(curr))))
    assert shift['score'] >= min_overlap   # passes with the adaptive gate
