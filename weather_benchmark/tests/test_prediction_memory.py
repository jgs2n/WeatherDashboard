"""Unit tests for poll-cycle self-correction (v1.48.0).

Parity with _applyPredictionMemory in nowcast.js: converging predictions
(≤5 min drift, twice) boost one tier with smoothing; diverging (>15 min)
decay a tier; memory expires after 15 min or on kind switch.
"""

from collector_lib.nowcast import (
    apply_prediction_memory, PredictionMemory, compute_precip_trend,
    PRED_MEMORY_MAX_AGE_MS,
)

T0 = 1_760_000_000_000
MIN = 60_000


def test_first_prediction_passes_through():
    out = apply_prediction_memory(None, 'begin', T0 + 30 * MIN, 'med', T0)
    assert out['targetMs'] == T0 + 30 * MIN
    assert out['confidence'] == 'med'
    assert out['memory']['stableCount'] == 0


def test_two_converging_polls_boost_one_tier():
    mem = None
    # Poll 1: predict rain at T0+30min
    out = apply_prediction_memory(mem, 'begin', T0 + 30 * MIN, 'med', T0)
    mem = out['memory']
    # Poll 2 (+2 min): target drifts 1 min → stableCount 1, no boost yet
    out = apply_prediction_memory(mem, 'begin', T0 + 31 * MIN, 'med', T0 + 2 * MIN)
    assert out['confidence'] == 'med'
    mem = out['memory']
    # Poll 3 (+4 min): converging again → stableCount 2 → boost med → high
    out = apply_prediction_memory(mem, 'begin', T0 + 30 * MIN, 'med', T0 + 4 * MIN)
    assert out['confidence'] == 'high'
    assert out['memory']['stableCount'] == 2


def test_converging_target_is_smoothed():
    mem = {'kind': 'begin', 'targetMs': T0 + 30 * MIN, 'updatedAtMs': T0, 'stableCount': 0}
    out = apply_prediction_memory(mem, 'begin', T0 + 34 * MIN, 'med', T0 + 2 * MIN)
    # 0.7·34 + 0.3·30 = 32.8 min
    assert abs(out['targetMs'] - (T0 + 32.8 * MIN)) < 1000


def test_diverging_poll_decays_one_tier():
    mem = {'kind': 'begin', 'targetMs': T0 + 30 * MIN, 'updatedAtMs': T0, 'stableCount': 1}
    out = apply_prediction_memory(mem, 'begin', T0 + 50 * MIN, 'high', T0 + 2 * MIN)
    assert out['confidence'] == 'med'
    assert out['memory']['stableCount'] == 0
    assert out['targetMs'] == T0 + 50 * MIN  # adopted unsmoothed


def test_between_drift_keeps_tier_and_streak():
    mem = {'kind': 'begin', 'targetMs': T0 + 30 * MIN, 'updatedAtMs': T0, 'stableCount': 1}
    out = apply_prediction_memory(mem, 'begin', T0 + 40 * MIN, 'med', T0 + 2 * MIN)
    assert out['confidence'] == 'med'
    assert out['memory']['stableCount'] == 1


def test_memory_expires_after_max_age():
    mem = {'kind': 'begin', 'targetMs': T0 + 30 * MIN, 'updatedAtMs': T0, 'stableCount': 5}
    later = T0 + PRED_MEMORY_MAX_AGE_MS + MIN
    out = apply_prediction_memory(mem, 'begin', later + 5 * MIN, 'med', later)
    assert out['confidence'] == 'med'          # no boost from stale streak
    assert out['memory']['stableCount'] == 0   # fresh start


def test_kind_switch_resets():
    mem = {'kind': 'begin', 'targetMs': T0 + 30 * MIN, 'updatedAtMs': T0, 'stableCount': 3}
    out = apply_prediction_memory(mem, 'end', T0 + 30 * MIN, 'med', T0 + 2 * MIN)
    assert out['memory']['stableCount'] == 0
    assert out['confidence'] == 'med'


def test_boost_never_exceeds_high_and_decay_never_below_low():
    mem = {'kind': 'begin', 'targetMs': T0 + 30 * MIN, 'updatedAtMs': T0, 'stableCount': 2}
    out = apply_prediction_memory(mem, 'begin', T0 + 30 * MIN, 'high', T0 + 2 * MIN)
    assert out['confidence'] == 'high'
    mem2 = {'kind': 'begin', 'targetMs': T0 + 30 * MIN, 'updatedAtMs': T0, 'stableCount': 0}
    out2 = apply_prediction_memory(mem2, 'begin', T0 + 55 * MIN, 'low', T0 + 2 * MIN)
    assert out2['confidence'] == 'low'


def test_compute_precip_trend_with_memory_boosts_on_convergence():
    """End-to-end: stable edge prediction across three polls reaches high."""
    pm = PredictionMemory()
    edge = {'beginInMin': 30, 'endInMin': None, 'edgeDistKm': 20,
            'closingSpeedKmh': 40, 'lateralHits': 2}   # med without slope
    confs = []
    for i, offset_min in enumerate((0, 2, 4)):
        now = T0 + offset_min * MIN
        e = dict(edge)
        e['beginInMin'] = 30 - offset_min   # storm approaching on schedule
        trend = compute_precip_trend(timeline=None, is_raining=False, edge=e,
                                     edge_attempted=True, motion={'speed_kmh': 40},
                                     now_ms=now, utc_offset_sec=0, pred_memory=pm)
        confs.append(trend['summaryConfidence'])
    assert confs[0] == 'med'
    assert confs[-1] == 'high'
    # High tier → clock-time wording
    assert 'Rain starting ~' in trend['summary']
