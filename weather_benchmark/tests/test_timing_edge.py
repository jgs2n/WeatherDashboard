"""Parity + unit tests for the edge-geometry rain timing (v1.47.0).

Replaces test_timing_upstream.py. The edge pipeline is train/serve-critical:
these pure-function fixtures pin the Python port against the JS reference
(_findLeadingEdge / _findTrailingEdge / _deriveDryTiming / _deriveWetTiming /
_clampPrecision / _summarizeTrend in radarSampler.js + nowcast.js).

Pure-function tests — no network.
"""

import re

from collector_lib import nowcast as nc
from collector_lib.radar_sampler import (
    RadarSampler, RADAR_CFG, _find_leading_edge, _find_trailing_edge,
)

BEGIN = RADAR_CFG['BEGIN_SIGNAL_DBZ']    # 18
DRY = RADAR_CFG['EDGE_DRY_DBZ']          # 15
STEP = RADAR_CFG['EDGE_STEP_KM']         # 2

NOW_MS = 1_760_000_000_000  # fixed epoch for deterministic clock strings


def _profile(dbz_list):
    return [{'distKm': i * STEP, 'dbz': d} for i, d in enumerate(dbz_list)]


# ── _find_leading_edge ───────────────────────────────────────────────────────

def test_leading_edge_at_sustained_run():
    # dry until index 10 (20 km), then sustained wet
    prof = _profile([None] * 10 + [BEGIN + 5, BEGIN + 8, BEGIN + 10])
    edge = _find_leading_edge(prof)
    assert edge == {'distKm': 20}


def test_leading_edge_ignores_single_blip():
    # one wet sample surrounded by dry — run of 1 < EDGE_WET_RUN_SAMPLES (2)
    prof = _profile([None, None, BEGIN + 5, None, None, None])
    assert _find_leading_edge(prof) is None


def test_leading_edge_all_dry():
    assert _find_leading_edge(_profile([None, 5, 10, None, 12])) is None


def test_leading_edge_at_origin():
    prof = _profile([BEGIN + 2, BEGIN + 4, BEGIN + 6])
    assert _find_leading_edge(prof) == {'distKm': 0}


# ── _find_trailing_edge ──────────────────────────────────────────────────────

def test_trailing_edge_after_wet_region():
    # wet 0–20 km (indices 0-10), then sustained dry
    prof = _profile([30] * 11 + [None] * 6)
    edge = _find_trailing_edge(prof)
    assert edge is not None
    assert edge['distKm'] == 22          # first dry sample
    assert edge['wetExtentKm'] == 20     # last wet sample


def test_trailing_edge_skips_small_hole():
    # 2-sample hole (4 km) inside the storm < EDGE_DRY_GAP_SAMPLES (4) — not clearing
    prof = _profile([30] * 5 + [None, None] + [30] * 5 + [None] * 5)
    edge = _find_trailing_edge(prof)
    assert edge is not None
    assert edge['distKm'] == 24          # after the second wet block, not the hole


def test_trailing_edge_none_when_rain_past_horizon():
    assert _find_trailing_edge(_profile([30] * 20)) is None


# ── derive_dry_timing confidence ladder ──────────────────────────────────────

def _edge(begin=None, end=None, hits=3):
    return {'beginInMin': begin, 'endInMin': end, 'edgeDistKm': 20,
            'closingSpeedKmh': 40, 'lateralHits': hits}


def test_dry_high_needs_spread_speed_and_slope():
    slope = {'minutes': 25, 'tier': 'med', 'intermittent': False}
    t = nc.derive_dry_timing(_edge(begin=30, hits=3), slope, {'speed_kmh': 40})
    assert t == {'minutes': 30, 'confidence': 'high', 'method': 'edge'}


def test_dry_med_without_slope_agreement():
    t = nc.derive_dry_timing(_edge(begin=30, hits=2), None, {'speed_kmh': 40})
    assert t['confidence'] == 'med'


def test_dry_low_with_marginal_spread():
    slope = {'minutes': 25, 'tier': 'med', 'intermittent': False}
    t = nc.derive_dry_timing(_edge(begin=30, hits=1), slope, {'speed_kmh': 40})
    assert t['confidence'] == 'low'


def test_dry_slope_fallback_without_edge():
    slope = {'minutes': 25, 'tier': 'med', 'intermittent': False}
    t = nc.derive_dry_timing(None, slope, {'speed_kmh': 40})
    assert t == {'minutes': 25, 'confidence': 'med', 'method': 'slope'}


def test_dry_nothing():
    t = nc.derive_dry_timing(None, None, None)
    assert t == {'minutes': None, 'confidence': 'low', 'method': 'none'}


# ── derive_wet_timing ────────────────────────────────────────────────────────

def test_wet_high_with_fast_motion():
    t = nc.derive_wet_timing(_edge(end=35), None, {'speed_kmh': 30}, True)
    assert t == {'minutes': 35, 'confidence': 'high', 'method': 'edge'}


def test_wet_med_with_slow_motion():
    t = nc.derive_wet_timing(_edge(end=35), None, {'speed_kmh': 7}, True)
    assert t['confidence'] == 'med'


def test_wet_horizon_when_no_trailing_edge():
    t = nc.derive_wet_timing(None, None, {'speed_kmh': 30}, True)
    assert t == {'minutes': None, 'confidence': 'med', 'method': 'edge-horizon'}


def test_wet_slope_fallback_when_stationary():
    slope = {'minutes': 40, 'tier': 'med', 'intermittent': False}
    t = nc.derive_wet_timing(None, slope, {'speed_kmh': 2}, False)
    assert t == {'minutes': 40, 'confidence': 'med', 'method': 'slope'}


# ── clamp_precision (benchmark floors) ───────────────────────────────────────

def test_clamp_precision_floors():
    assert nc.clamp_precision(5, 'low') == 15
    assert nc.clamp_precision(5, 'med') == 10
    assert nc.clamp_precision(5, 'high') == 5
    assert nc.clamp_precision(30, 'low') == 30
    assert nc.clamp_precision(None, 'high') is None


# ── summarize_trend wording tiers ────────────────────────────────────────────

CLOCK_RE = re.compile(r'~\d{1,2}:\d{2} [AP]M$')


def test_high_dry_uses_clock_time():
    s = nc.summarize_trend(None, False, 25, 'high', 'edge', False, NOW_MS, 0)
    assert s['confidence'] == 'high'
    assert s['text'].startswith('Rain starting ')
    assert CLOCK_RE.search(s['text'])


def test_high_wet_uses_clock_time():
    s = nc.summarize_trend(None, True, 25, 'high', 'edge', False, NOW_MS, 0)
    assert s['text'].startswith('Clearing by ')
    assert CLOCK_RE.search(s['text'])


def test_clock_time_rounds_to_5_min():
    # 23 min from a :00 epoch → rounds to :25
    s = nc.summarize_trend(None, False, 23, 'high', 'edge', False, NOW_MS, 0)
    m = re.search(r':(\d{2}) ', s['text'])
    assert int(m.group(1)) % 5 == 0


def test_med_dry_uses_range():
    s = nc.summarize_trend(None, False, 25, 'med', 'edge', False, NOW_MS, 0)
    assert s == {'text': 'Rain likely in ~20–30 min', 'confidence': 'med'}


def test_med_wet_uses_range():
    s = nc.summarize_trend(None, True, 20, 'med', 'edge', False, NOW_MS, 0)
    assert s == {'text': 'Rain tapering off in ~15–25 min', 'confidence': 'med'}


def test_low_dry_stays_vague():
    s = nc.summarize_trend(None, False, 15, 'low', 'edge', False, NOW_MS, 0)
    assert s == {'text': 'Showers possible soon', 'confidence': 'low'}


def test_wet_horizon_wording():
    s = nc.summarize_trend(None, True, None, 'med', 'edge-horizon', False, NOW_MS, 0)
    assert s == {'text': 'Rain continuing this hour', 'confidence': 'med'}


def test_intermittent_slope_stays_low():
    s = nc.summarize_trend(None, False, 20, 'med', 'slope', True, NOW_MS, 0)
    assert s == {'text': 'Intermittent rain next hour', 'confidence': 'low'}


# ── Precision-violation regression guard ─────────────────────────────────────
# Mirrors detect_precision_violations: no "~N min" with N ≤ 10 at low
# confidence, and emitted begin/end minutes respect the tier floors.

def test_no_precise_minutes_at_low_confidence():
    precise = re.compile(r'~(\d+)\s*min')
    for minutes in (1, 5, 8, 10, 15, 30):
        for is_raining in (False, True):
            s = nc.summarize_trend(None, is_raining, minutes, 'low', 'edge',
                                   False, NOW_MS, 0)
            if s is None:
                continue
            for m in precise.finditer(s['text']):
                assert int(m.group(1)) > 10, (
                    f'low-confidence summary too precise: {s["text"]}')


def test_compute_precip_trend_respects_floors():
    # Marginal edge (hits=1 → low): raw 4 min must be floored to ≥15
    edge = _edge(begin=4, hits=1)
    trend = nc.compute_precip_trend(timeline=None, is_raining=False, edge=edge,
                                    edge_attempted=True, motion={'speed_kmh': 40},
                                    now_ms=NOW_MS)
    assert trend['beginInMin'] >= 15
    assert trend['method'] == 'edge'
    assert trend['edge'] == {'distKm': 20, 'speedKmh': 40, 'lateralHits': 1}


def test_compute_precip_trend_high_end_to_end():
    edge = _edge(begin=30, hits=3)
    slope_timeline = [{'minute': i * 5, 'precipClass': 1 if i >= 6 else 0,
                       'projectedDbz': 25 if i >= 6 else 0,
                       'confidence': max(0.1, 1.0 - i * 0.10)} for i in range(12)]
    trend = nc.compute_precip_trend(timeline=slope_timeline, is_raining=False,
                                    edge=edge, edge_attempted=True,
                                    motion={'speed_kmh': 40},
                                    now_ms=NOW_MS, utc_offset_sec=0)
    assert trend['beginInMin'] == 30
    assert trend['summaryConfidence'] == 'high'
    assert trend['summary'].startswith('Rain starting ')


# ── sample_edge_timing guards ────────────────────────────────────────────────

def test_edge_timing_none_without_motion():
    s = RadarSampler(40.0, -105.0, limiter=None)
    assert s.sample_edge_timing(None, False) is None
    assert s.sample_edge_timing({'speed_kmh': 3, 'direction_deg': 90}, False) is None


# ── Tile cache: hit must avoid network and preserve value ────────────────────

def test_tile_cache_hit_avoids_fetch(monkeypatch):
    s = RadarSampler(40.0, -105.0, limiter=None)
    calls = {'n': 0}

    class _FakeImg:
        pass

    import collector_lib.radar_sampler as rs

    def _fake_fetch(ts, z, x, y, limiter):
        calls['n'] += 1
        return _FakeImg()

    monkeypatch.setattr(rs, 'fetch_iem_tile', _fake_fetch)
    img1 = s._get_tile('202606291600', 6, 11, 24)
    img2 = s._get_tile('202606291600', 6, 11, 24)   # same key → cache hit
    assert img1 is img2
    assert calls['n'] == 1                            # fetched only once
