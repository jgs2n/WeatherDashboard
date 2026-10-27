"""Truth v2 + input-provenance tests (2026-10-25 benchmark-truth overhaul).

Covers: raw per-observation ASOS frame, one-sided (no-leak) truth matching,
MRMS thunder fallback, versioned/UTC-complete IEM cache, radar sampleStatus,
record schema v3, ingest skip accounting, Blitzortung coverage windows.
No network.
"""

import json
import os
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import pytest
from PIL import Image

from src import observations as obs_mod
from src.lead_targets import label_current_truth, label_lead_targets, resolve_truth
from src.mrms_observations import rate_to_row
from src.ingest import load_jsonl_logs
from collector_lib.radar_sampler import (
    RadarSampler, RADAR_CFG, SAMPLE_OK, SAMPLE_NO_ECHO, SAMPLE_FETCH_FAILED,
)
from collector_lib.record_builder import build_record, SCHEMA_VERSION
import lightning_truth_eval as lte

UTC = timezone.utc


@dataclass
class _Rec:
    timestamp: datetime


def _raw(rows):
    """IEM-shaped raw rows: (valid 'YYYY-MM-DD HH:MM', wxcodes, metar-suffix)."""
    return pd.DataFrame([{
        'station': 'TST', 'valid': v, 'wxcodes': wx, 'p01i': None,
        'metar': f'KTST {kind}', 'skyc1': 'OVC' if wx else 'CLR',
        'skyc2': None, 'skyc3': None, 'skyc4': None,
    } for v, wx, kind in rows])


# ── Raw METAR frame ──────────────────────────────────────────────────────────

def test_wx_has_precip_codes():
    assert obs_mod.wx_has_precip('-DZ BR')
    assert obs_mod.wx_has_precip('+TSRA')
    assert obs_mod.wx_has_precip('SHRA')
    assert obs_mod.wx_has_precip('UP')
    assert not obs_mod.wx_has_precip('VCSH')     # vicinity, not at station
    assert not obs_mod.wx_has_precip('TS')       # thunder without precip
    assert not obs_mod.wx_has_precip('BLSN')     # blowing snow
    assert not obs_mod.wx_has_precip('BR HZ')
    assert not obs_mod.wx_has_precip(None)
    assert not obs_mod.wx_has_precip(float('nan'))


def test_metar_frame_keeps_every_obs_and_its_own_wx():
    f = obs_mod.metar_frame(_raw([
        ('2026-09-24 12:00', None, 'MADISHF'),
        ('2026-09-24 12:05', '-RA', 'MADISHF'),
        ('2026-09-24 12:10', None, 'MADISHF'),
        ('2026-09-24 12:52', 'TSRA', 'RMK AO2'),
    ]))
    assert len(f) == 4                                   # no bucketing
    assert f['precip_active'].tolist() == [False, True, False, True]
    assert f['has_thunder'].tolist() == [False, False, False, True]
    assert f['report_kind'].tolist() == ['5min', '5min', '5min', 'metar']
    assert f.loc[1, 'condition_category'] == 'drizzle'   # -RA → light tier
    assert f.loc[3, 'condition_category'] == 'thunderstorm'


# ── One-sided matching / leakage ─────────────────────────────────────────────

def _frame_5min(start, wet_from, wet_to, n=24):
    rows = []
    t0 = datetime.fromisoformat(start)
    for i in range(n):
        t = t0 + timedelta(minutes=5 * i)
        wet = wet_from <= i < wet_to
        rows.append((t.strftime('%Y-%m-%d %H:%M'), '-RA' if wet else None, 'MADISHF'))
    return obs_mod.metar_frame(_raw(rows))


def test_current_truth_never_uses_an_earlier_obs():
    f = _frame_5min('2026-09-24 12:00', 0, 3)            # wet 12:00–12:10, dry from 12:15
    out = label_current_truth(_Rec(datetime(2026, 9, 24, 12, 12, tzinfo=UTC)), f)
    assert out['truth_source'] == 'asos'
    assert out['obs_precip_active'] is False             # 12:15 obs, not the wet 12:10
    assert out['truth_lag_min'] == 3.0


def test_future_rain_does_not_leak_into_current_truth():
    """Rain from 13:30 must not label a 12:40 snapshot as raining.

    The legacy hourly bucket for 13:00 unions 13:00–13:59 wx codes and is the
    two-sided nearest row to 12:40, so legacy says "rain" here.
    """
    f = _frame_5min('2026-09-24 12:00', 18, 24)          # wet 13:30 onward
    snap = _Rec(datetime(2026, 9, 24, 12, 40, tzinfo=UTC))
    assert label_current_truth(snap, f)['obs_precip_active'] is False

    raw = _raw([(t.strftime('%Y-%m-%d %H:%M'), wx, 'RMK AO2') for t, wx in [
        (datetime(2026, 9, 24, 12, 52), None),
        (datetime(2026, 9, 24, 13, 30), 'RA'),
    ]])
    raw['p01i'] = [0.0, 0.2]
    hourly = obs_mod.bucket_to_hourly(raw)
    legacy = label_current_truth(snap, hourly, legacy=True)
    assert legacy['obs_precip_active'] is True           # the leak v2 removes


def test_lead_labels_differ_across_10_20_30():
    f = _frame_5min('2026-09-24 12:00', 4, 6)            # wet 12:20–12:25 only
    out = label_lead_targets(_Rec(datetime(2026, 9, 24, 12, 0, tzinfo=UTC)), f)
    assert out['precip_active_+10'] is False
    assert out['precip_active_+20'] is True
    assert out['precip_active_+30'] is False
    assert {out[f'truth_lag_min_+{m}'] for m in (10, 20, 30)} == {0.0}


def test_no_obs_within_lag_gives_none():
    f = _frame_5min('2026-09-24 12:00', 0, 0, n=2)       # 12:00, 12:05 only
    out = label_current_truth(_Rec(datetime(2026, 9, 24, 12, 30, tzinfo=UTC)), f)
    assert out['truth_source'] == 'none' and out['obs_precip_active'] is None


def test_mrms_thunder_comes_from_asos_or_stays_unknown():
    mrms = pd.DataFrame([rate_to_row(datetime(2026, 9, 24, 12, 0, tzinfo=UTC), 12.0)])
    mrms['time_utc'] = pd.to_datetime(mrms['time_utc'], utc=True)
    asos = obs_mod.metar_frame(_raw([('2026-09-24 12:03', 'TSRA', 'RMK AO2')]))
    t = resolve_truth(pd.Timestamp('2026-09-24T12:00Z'), asos, mrms=mrms)
    assert t['source'] == 'mrms' and t['condition'] == 'heavy_rain' and t['thunder'] is True
    t2 = resolve_truth(pd.Timestamp('2026-09-24T12:00Z'), pd.DataFrame(), mrms=mrms)
    assert t2['thunder'] is None


def test_mrms_rate_tiers():
    ts = datetime(2026, 9, 24, tzinfo=UTC)
    assert rate_to_row(ts, 0.1)['precip_active'] is False
    assert rate_to_row(ts, 0.3)['condition_category'] == 'drizzle'
    assert rate_to_row(ts, 3.0)['condition_category'] == 'rain'
    assert rate_to_row(ts, 8.0)['condition_category'] == 'heavy_rain'


# ── IEM cache ────────────────────────────────────────────────────────────────

def test_only_utc_complete_days_are_cacheable():
    now = datetime(2026, 10, 25, 2, 0, tzinfo=UTC)
    assert not obs_mod._day_is_complete(date(2026, 10, 25), now)
    assert not obs_mod._day_is_complete(date(2026, 10, 24), now)   # within settle window
    assert obs_mod._day_is_complete(date(2026, 10, 24), now + timedelta(hours=2))


def test_cache_key_includes_version_report_type_and_fields(tmp_path):
    a = obs_mod._cache_path('KBOS', date(2026, 9, 1), str(tmp_path), '1,3,4')
    b = obs_mod._cache_path('KBOS', date(2026, 9, 1), str(tmp_path), '3,4')
    assert a != b
    assert f'v{obs_mod.CACHE_VERSION}_rt134_' in os.path.basename(a)


def test_purge_removes_only_legacy_cache_files(tmp_path):
    (tmp_path / 'KBOS_2026-07-19.csv').write_text('x')
    keep = tmp_path / os.path.basename(obs_mod._cache_path('KBOS', date(2026, 9, 1), str(tmp_path)))
    keep.write_text('x')
    (tmp_path / 'notes.txt').write_text('x')
    assert obs_mod.purge_legacy_cache(str(tmp_path)) == 1
    assert sorted(p.name for p in tmp_path.iterdir()) == sorted([keep.name, 'notes.txt'])


def test_current_day_is_fetched_but_not_cached(tmp_path, monkeypatch):
    today = datetime.now(UTC).date()
    calls = []

    def fake_fetch(station, day, report_type=None):
        calls.append(day)
        return _raw([(f'{day} 00:00', None, 'MADISHF')])

    monkeypatch.setattr(obs_mod, '_fetch_day', fake_fetch)
    obs_mod.fetch_raw_observations('KTST', today, today, str(tmp_path))
    assert today in calls
    cached = [p.name for p in tmp_path.iterdir() if today.isoformat() in p.name]
    assert cached == []


# ── Radar sampleStatus ───────────────────────────────────────────────────────

def _on_sampler():
    s = RadarSampler(40.0, -105.0, limiter=None)
    s._history_loaded = True
    s._rain_state = 'ON'
    s._last_on_time = 0.0
    s._last_valid_dbz_time = 0.0          # "long ago" → a real null would decay
    return s


def test_fetch_failure_does_not_feed_hysteresis(monkeypatch):
    s = _on_sampler()
    monkeypatch.setattr(s, '_get_tile', lambda *a, **k: None)
    out = s.sample()
    assert out['sampleStatus'] == SAMPLE_FETCH_FAILED
    assert out['dbz'] is None
    assert out['rainState'] == 'ON'                       # not aged toward OFF
    assert s._frames[-1]['status'] == SAMPLE_FETCH_FAILED


def test_no_echo_still_feeds_hysteresis(monkeypatch):
    s = _on_sampler()
    blank = Image.new('RGBA', (RADAR_CFG['TILE_SIZE'], RADAR_CFG['TILE_SIZE']), (0, 0, 0, 0))
    monkeypatch.setattr(s, '_get_tile', lambda *a, **k: blank)
    out = s.sample()
    assert out['sampleStatus'] == SAMPLE_NO_ECHO
    assert out['rainState'] != 'ON'                       # null decay applied


def test_js_sampler_mirrors_sample_status():
    js = (Path(__file__).resolve().parents[2] / 'src' / 'services' / 'radarSampler.js').read_text(
        encoding='utf-8')
    m = re.search(r"SAMPLE_STATUS = Object\.freeze\(\{([^}]*)\}\)", js)
    assert m, 'radarSampler.js must define SAMPLE_STATUS'
    values = set(re.findall(r"'(\w+)'", m.group(1)))
    assert values == {SAMPLE_OK, SAMPLE_NO_ECHO, SAMPLE_FETCH_FAILED}
    assert 'sampleStatus: status' in js
    assert 'if (status !== SAMPLE_STATUS.FETCH_FAILED) _processFrame' in js


# ── Record schema v3 ─────────────────────────────────────────────────────────

def _summary():
    return {'nowcastState': {'precip': {'active': False}, 'sky': {'icon': 'clear-day'}},
            'skyState': None, 'precipStateNow': None, 'precipTrend60m': {},
            'lightningState': None}


def test_record_v3_logs_obs_status_and_provenance():
    now = datetime.now(UTC)
    obs = {'stationId': 'KBOS', 'obs': {
        'timestamp': (now - timedelta(minutes=12)).isoformat(), 'presentWeather': '-RA BR',
        'temperature_c': 12.5, 'dewpoint_c': 11.0, 'humidity': 90.0,
        'metar': 'KBOS 251254Z 05012KT 3SM -RA BR OVC008 12/11 A3001'}}
    radar = {'dbz': None, 'rainState': 'ON', 'source': 'NEXRAD', 'sampleStatus': 'fetch_failed'}
    rec = build_record(lat=42.36, lon=-71.06, country='United States', location_name='Boston',
                       state_code='MA', station='KBOS', radar_state=radar, motion=None,
                       obs=obs, summary=_summary(), model_context={}, model_hourly=None)
    assert rec['_schemaVersion'] == SCHEMA_VERSION == 3
    assert 'algoVersion' in rec and 'gitSha' in rec
    assert rec['radar']['sampleStatus'] == 'fetch_failed'
    assert 'radar_fetch_failed' in rec['_validationFlags']
    o = rec['obs']
    assert o['presentWeather'] == '-RA BR' and o['tempC'] == 12.5 and o['dewpointC'] == 11.0
    assert 11.5 <= o['ageMin'] <= 12.5
    assert o['raw'].startswith('KBOS')


def test_record_without_obs_has_null_obs_block():
    rec = build_record(lat=0, lon=0, country='United States', location_name='X', state_code=None,
                       station=None, radar_state=None, motion=None, obs=None,
                       summary=_summary(), model_context=None, model_hourly=None)
    assert rec['obs'] is None


def test_ingest_counts_skipped_lines_and_schema_versions(tmp_path):
    d = tmp_path / 'boston'
    d.mkdir()
    good = {'_schemaVersion': 3, 'timestamp': '2026-10-25T12:00:00+00:00', 'lat': 1, 'lon': 2,
            'radar': {'sampleStatus': 'ok'}, 'obs': {'presentWeather': 'RA'}}
    (d / '2026-10-25.jsonl').write_text(
        json.dumps(good) + '\n{not json\n' + json.dumps({'test': True}) + '\n', encoding='utf-8')
    stats = {}
    recs = load_jsonl_logs(str(tmp_path), stats=stats)
    assert len(recs) == 1
    assert stats['skipped_lines'] == 1 and stats['test_records'] == 1
    assert stats['schema_versions'] == {'3': 1}
    assert recs[0].radar_sample_status == 'ok' and recs[0].obs_present_weather == 'RA'


# ── Blitzortung coverage ─────────────────────────────────────────────────────

def test_coverage_windows():
    m = 60_000
    events = [(0, 'connect'), (1 * m, 'heartbeat'), (2 * m, 'heartbeat'), (40 * m, 'heartbeat'),
              (41 * m, 'disconnect'),
              (41 * m + 5_000, 'connect'), (60 * m, 'heartbeat'),       # quick reconnect, then crash
              (200 * m, 'connect'), (240 * m, 'disconnect')]
    merged, first = lte.merge_coverage(events)
    # heartbeats inside an interval extend it; the crash ends 90 s after the last heartbeat
    assert merged[0] == (0, 60 * m + lte.HEARTBEAT_GRACE_MS)
    assert lte.window_coverage(merged, first, 5 * m, 35 * m) == 'covered'
    assert lte.window_coverage(merged, first, 50 * m, 80 * m) == 'uncovered'
    assert lte.window_coverage(merged, first, 205 * m, 235 * m) == 'covered'
    assert lte.window_coverage(merged, first, -10 * m, 20 * m) == 'unknown'
    assert lte.window_coverage([], None, 0, 1) == 'unknown'
