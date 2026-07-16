"""Unit tests for RainViewer nowcast consensus (v1.49.0).

Parity with _deriveRvTiming (radarSampler.js) and _applyRvConsensus
(nowcast.js). Pure functions — no network.
"""

from collector_lib.radar_sampler import derive_rv_timing, RADAR_CFG
from collector_lib.nowcast import apply_rv_consensus

ON = RADAR_CFG['ON_THRESHOLD']  # 22


def _s(minute, dbz):
    return {'minuteAhead': minute, 'dbz': dbz}


# ── derive_rv_timing ─────────────────────────────────────────────────────────

def test_rv_begin_is_midpoint_of_dry_wet_transition():
    # dry at +10, wet at +20 → begin ≈ 15
    samples = [_s(10, None), _s(20, ON + 5), _s(30, ON + 10)]
    t = derive_rv_timing(samples, is_raining=False)
    assert t == {'beginInMin': 15, 'endInMin': None}


def test_rv_begin_first_frame_wet():
    # wet already at +10 → midpoint of (0, 10) = 5
    samples = [_s(10, ON + 5), _s(20, ON + 5)]
    t = derive_rv_timing(samples, is_raining=False)
    assert t['beginInMin'] == 5


def test_rv_no_begin_when_all_dry():
    samples = [_s(10, None), _s(20, 10), _s(30, None)]
    assert derive_rv_timing(samples, False) == {'beginInMin': None, 'endInMin': None}


def test_rv_end_is_midpoint_of_wet_dry_transition():
    # wet at +10, dry at +20 → end ≈ 15
    samples = [_s(10, ON + 5), _s(20, 5), _s(30, None)]
    t = derive_rv_timing(samples, is_raining=True)
    assert t == {'beginInMin': None, 'endInMin': 15}


def test_rv_no_end_when_wet_throughout():
    samples = [_s(10, ON + 5), _s(20, ON + 5), _s(30, ON + 5)]
    assert derive_rv_timing(samples, True) == {'beginInMin': None, 'endInMin': None}


def test_rv_empty_or_none():
    assert derive_rv_timing(None, False) == {'beginInMin': None, 'endInMin': None}
    assert derive_rv_timing([], False) == {'beginInMin': None, 'endInMin': None}


# ── apply_rv_consensus ───────────────────────────────────────────────────────

def _edge_timing(minutes=30, conf='med', method='edge'):
    return {'minutes': minutes, 'confidence': conf, 'method': method}


def test_consensus_agreement_boosts_and_blends():
    out = apply_rv_consensus(_edge_timing(30, 'med'), 20)  # diff 10 ≤ RV_AGREE_MIN
    assert out['method'] == 'consensus'
    assert out['confidence'] == 'high'
    assert out['minutes'] == round(0.7 * 30 + 0.3 * 20)  # 27


def test_consensus_disagreement_caps_high_at_med():
    out = apply_rv_consensus(_edge_timing(30, 'high'), 55)  # diff 25 > RV_DISAGREE_MIN
    assert out == {'minutes': 30, 'confidence': 'med', 'method': 'edge'}


def test_consensus_disagreement_keeps_med_unchanged():
    out = apply_rv_consensus(_edge_timing(30, 'med'), 55)
    assert out == {'minutes': 30, 'confidence': 'med', 'method': 'edge'}


def test_consensus_between_zone_no_change():
    out = apply_rv_consensus(_edge_timing(30, 'med'), 45)  # diff 15: between 10 and 20
    assert out == {'minutes': 30, 'confidence': 'med', 'method': 'edge'}


def test_rv_only_fills_method_none_at_med():
    out = apply_rv_consensus({'minutes': None, 'confidence': 'low', 'method': 'none'}, 25)
    assert out == {'minutes': 25, 'confidence': 'med', 'method': 'rv'}


def test_rv_never_overrides_slope_or_horizon():
    slope = {'minutes': 40, 'confidence': 'med', 'method': 'slope'}
    assert apply_rv_consensus(slope, 20) == slope
    horizon = {'minutes': None, 'confidence': 'med', 'method': 'edge-horizon'}
    assert apply_rv_consensus(horizon, 20) == horizon


def test_rv_none_is_neutral():
    t = _edge_timing(30, 'high')
    assert apply_rv_consensus(t, None) == t
