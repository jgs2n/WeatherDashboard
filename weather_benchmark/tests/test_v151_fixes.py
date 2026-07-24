"""Tests for the v1.51.0 data-driven fixes (from the 3-day collection review):

1. Slope horizon pegging — wet projections reaching the timeline's final
   bucket are 'Rain continuing', not a perpetual '~55 min' end prediction.
2. Prediction-memory boost cap — slope-only / model-wind predictions can
   never be boosted to 'high' just by being consistent.
3. Motion fallback (700 hPa model wind) + 15-min persistence.
4. RainViewer color-scheme-0 dBZ decoding (replaces broken palette matching).
"""

from collector_lib import nowcast as nc
from collector_lib.radar_sampler import (
    RadarSampler, RADAR_CFG, fallback_motion_from_wind, _rv_raw_to_dbz,
)

T0 = 1_760_000_000_000
MIN = 60_000


def _timeline(wet_from_min, wet_to_min=55):
    return [{'minute': i * 5,
             'precipClass': 1 if wet_from_min <= i * 5 <= wet_to_min else 0,
             'projectedDbz': 25, 'confidence': max(0.1, 1.0 - i * 0.10)}
            for i in range(12)]


# ── 1. Slope horizon ─────────────────────────────────────────────────────────

def test_wet_slope_through_horizon_is_marked():
    s = nc.slope_signal(_timeline(0, 55), is_raining=True)
    assert s['horizon'] is True
    assert s['minutes'] is None


def test_wet_slope_with_real_clearing_keeps_minutes():
    s = nc.slope_signal(_timeline(0, 30), is_raining=True)
    assert s['horizon'] is False
    assert s['minutes'] == 30


def test_dry_slope_never_horizon():
    s = nc.slope_signal(_timeline(20), is_raining=False)
    assert s['horizon'] is False
    assert s['minutes'] == 20


def test_derive_wet_slope_horizon_method():
    s = {'minutes': None, 'tier': 'med', 'intermittent': False, 'horizon': True}
    t = nc.derive_wet_timing(None, s, None, False)
    assert t == {'minutes': None, 'confidence': 'med', 'method': 'slope-horizon'}


def test_slope_horizon_wording():
    out = nc.summarize_trend(None, True, None, 'med', 'slope-horizon', False, T0, 0)
    assert out == {'text': 'Rain continuing this hour', 'confidence': 'med'}


def test_compute_trend_pegged_wet_slope_never_emits_end():
    """The exact failure from the field data: wet through the whole timeline
    must NOT produce endInMin≈55, and repeated polls must NOT reach high."""
    pm = nc.PredictionMemory()
    for i in range(5):
        trend = nc.compute_precip_trend(
            timeline=_timeline(0, 55), is_raining=True, edge=None,
            edge_attempted=False, motion=None,
            now_ms=T0 + i * 3 * MIN, pred_memory=pm)
        assert trend['endInMin'] is None
        assert trend['method'] == 'slope-horizon'
        assert trend['summary'] == 'Rain continuing this hour'
        assert trend['summaryConfidence'] == 'med'


# ── 2. Memory boost cap ──────────────────────────────────────────────────────

def test_memory_boost_capped_at_med():
    mem = {'kind': 'end', 'targetMs': T0 + 50 * MIN, 'updatedAtMs': T0, 'stableCount': 1}
    out = nc.apply_prediction_memory(mem, 'end', T0 + 50 * MIN, 'med',
                                     T0 + 3 * MIN, max_confidence='med')
    assert out['confidence'] == 'med'   # would have boosted to high without cap


def test_memory_boost_uncapped_default_still_boosts():
    mem = {'kind': 'end', 'targetMs': T0 + 50 * MIN, 'updatedAtMs': T0, 'stableCount': 1}
    out = nc.apply_prediction_memory(mem, 'end', T0 + 50 * MIN, 'med', T0 + 3 * MIN)
    assert out['confidence'] == 'high'


def test_slope_predictions_never_reach_high_via_memory():
    pm = nc.PredictionMemory()
    confs = []
    for i in range(6):
        trend = nc.compute_precip_trend(
            timeline=_timeline(0, 30), is_raining=True, edge=None,
            edge_attempted=False, motion=None,
            now_ms=T0 + i * 3 * MIN, pred_memory=pm)
        confs.append(trend['summaryConfidence'])
    assert 'high' not in confs


# ── 3. Motion fallback + caps + persistence ──────────────────────────────────

def test_fallback_motion_conversion():
    m = fallback_motion_from_wind(20.0, 270.0)   # 20 mph from the west
    assert m['source'] == 'model-wind'
    assert m['speed_kmh'] == 24                  # 20 × 1.609 × 0.75 (calibrated)
    assert m['direction_deg'] == 90              # moving east


def test_fallback_motion_below_threshold():
    assert fallback_motion_from_wind(5.0, 270.0) is None
    assert fallback_motion_from_wind(None, 270.0) is None
    assert fallback_motion_from_wind(20.0, None) is None


def _edge(begin=None, end=None, hits=3):
    return {'beginInMin': begin, 'endInMin': end, 'edgeDistKm': 20,
            'closingSpeedKmh': 40, 'lateralHits': hits}


def test_model_wind_motion_caps_dry_at_med():
    slope = {'minutes': 25, 'tier': 'med', 'intermittent': False, 'horizon': False}
    wind = {'speed_kmh': 40, 'direction_deg': 90, 'source': 'model-wind'}
    t = nc.derive_dry_timing(_edge(begin=30, hits=3), slope, wind)
    assert t['confidence'] == 'med'   # all high-tier conditions met except observed motion


def test_model_wind_motion_caps_wet_at_med():
    wind = {'speed_kmh': 40, 'direction_deg': 90, 'source': 'model-wind'}
    t = nc.derive_wet_timing(_edge(end=25), None, wind, True)
    assert t['confidence'] == 'med'


def test_observed_motion_still_reaches_high():
    slope = {'minutes': 25, 'tier': 'med', 'intermittent': False, 'horizon': False}
    radar = {'speed_kmh': 40, 'direction_deg': 90, 'source': 'radar'}
    t = nc.derive_dry_timing(_edge(begin=30, hits=3), slope, radar)
    assert t['confidence'] == 'high'


def test_motion_persistence(monkeypatch):
    s = RadarSampler(40.0, -105.0, limiter=None)
    monkeypatch.setattr(s, '_estimate_motion_correlation', lambda: None)
    vec = {'speed_kmh': 30, 'direction_deg': 90, 'dx': 0, 'dy': 0, 'source': 'radar'}
    s._last_motion = {'vec': vec, 'atMs': T0}
    # Within the window → persisted copy
    m = s.estimate_motion(now_ms=T0 + 10 * MIN)
    assert m['source'] == 'persisted'
    assert m['speed_kmh'] == 30
    # Expired → None
    assert s.estimate_motion(now_ms=T0 + 16 * MIN) is None


def test_fresh_estimate_updates_persistence(monkeypatch):
    s = RadarSampler(40.0, -105.0, limiter=None)
    vec = {'speed_kmh': 44, 'direction_deg': 45, 'dx': 0, 'dy': 0, 'source': 'radar'}
    monkeypatch.setattr(s, '_estimate_motion_correlation', lambda: dict(vec))
    m = s.estimate_motion(now_ms=T0)
    assert m['source'] == 'radar'
    assert s._last_motion['atMs'] == T0


# ── 4. RainViewer color-0 decoding ───────────────────────────────────────────

def test_rv_raw_decode_basic():
    assert _rv_raw_to_dbz(54, 54, 54, 255) == 22      # (54 & 127) − 32
    assert _rv_raw_to_dbz(62, 62, 62, 255) == 30
    assert _rv_raw_to_dbz(77, 77, 77, 255) == 45


def test_rv_raw_decode_snow_bit_stripped():
    # 54 | 128 = 182 → snow-flagged 22 dBZ, still precip
    assert _rv_raw_to_dbz(182, 0, 0, 255) == 22


def test_rv_raw_decode_no_coverage_and_trace():
    assert _rv_raw_to_dbz(100, 100, 100, 0) is None    # transparent = no coverage
    assert _rv_raw_to_dbz(0, 0, 0, 255) is None        # −32 = no echo
    assert _rv_raw_to_dbz(37, 37, 37, 255) is None     # 5 dBZ trace


def test_rv_raw_decode_special_values_clamped():
    assert _rv_raw_to_dbz(127, 127, 127, 255) == 45    # 95 dBZ impossible → heavy
    assert _rv_raw_to_dbz(255, 255, 255, 255) == 45


def test_consensus_with_model_wind_caps_at_med():
    """Edge (model-wind) + RV agreement must not produce high confidence."""
    wind = {'speed_kmh': 40, 'direction_deg': 90, 'source': 'model-wind'}
    trend = nc.compute_precip_trend(
        timeline=None, is_raining=False, edge=_edge(begin=30, hits=2),
        edge_attempted=True, motion=wind, rv_minutes=28, now_ms=T0)
    assert trend['method'] == 'consensus'
    assert trend['summaryConfidence'] == 'med'
