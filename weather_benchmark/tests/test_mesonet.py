"""Tests for the Synoptic mesonet observation source.

Three groups:
  - **offline unit tests** (no network, no token) — verify aggregation,
    DataFrame shape, blending logic. Always run.
  - **offline labeler integration** — feed a synthetic mesonet DataFrame
    into label_lead_targets / label_current_truth and verify mesonet is
    preferred over ASOS when both are present.
  - **live smoke test** — requires SYNOPTIC_TOKEN; queries the live API.
    Skipped if the token is missing or NO_NETWORK=1.

Run all:
    pytest weather_benchmark/tests/test_mesonet.py -v

Run only offline:
    NO_NETWORK=1 pytest weather_benchmark/tests/test_mesonet.py -v
"""

import os
from datetime import date, datetime, timezone, timedelta
from dataclasses import dataclass

import pandas as pd
import pytest

from src import mesonet_observations as mo
from src.lead_targets import (
    label_lead_targets, label_current_truth, _empty_labels,
)


# ── Offline unit tests ────────────────────────────────────────────────────────

def test_token_helpers():
    """is_enabled mirrors the environment variable."""
    saved = os.environ.pop(mo.SYNOPTIC_TOKEN_ENV, None)
    try:
        assert mo.synoptic_token() is None
        assert mo.is_enabled() is False
        os.environ[mo.SYNOPTIC_TOKEN_ENV] = 'fake-token-for-testing'
        assert mo.synoptic_token() == 'fake-token-for-testing'
        assert mo.is_enabled() is True
    finally:
        if saved is not None:
            os.environ[mo.SYNOPTIC_TOKEN_ENV] = saved
        else:
            os.environ.pop(mo.SYNOPTIC_TOKEN_ENV, None)


def test_unit_conversions():
    assert mo._c_to_f(0) == pytest.approx(32.0)
    assert mo._c_to_f(100) == pytest.approx(212.0)
    assert mo._ms_to_mph(1.0) == pytest.approx(2.23694, abs=1e-3)
    assert mo._mm_to_in(25.4) == pytest.approx(1.0, abs=1e-6)
    # NaN passthrough
    assert pd.isna(mo._c_to_f(None))
    assert pd.isna(mo._mm_to_in(None))


def test_normalize_condition_categories():
    assert mo._normalize_condition('Thunderstorm') == 'thunder'
    assert mo._normalize_condition('Light Rain Shower') == 'rain'
    assert mo._normalize_condition('Snow') == 'snow'
    assert mo._normalize_condition('Fog') == 'fog'
    assert mo._normalize_condition('Overcast') == 'overcast'
    assert mo._normalize_condition('Clear') == 'clear'
    assert mo._normalize_condition('Unknown weather') is None
    assert mo._normalize_condition(None) is None


def test_has_thunder_str():
    assert mo._has_thunder_str('TSRA') is True
    assert mo._has_thunder_str('thunderstorm') is True
    assert mo._has_thunder_str('rain') is False
    assert mo._has_thunder_str(None) is False


def test_bucket_aggregation():
    """Two stations reporting in the same 10-min bucket should aggregate."""
    raw = pd.DataFrame({
        'time_utc':   pd.to_datetime(['2026-05-17T12:01Z', '2026-05-17T12:05Z',
                                      '2026-05-17T12:03Z', '2026-05-17T12:08Z'], utc=True),
        # station A: rain
        # station B: no rain
        'precip_5m':  [None, None, 2.0, 3.0],     # mm
        'precip_1h':  [0.0, 0.0, None, None],     # mm
        'air_temp':   [20.0, 20.5, 19.5, 20.0],   # C
        'dewpoint':   [10.0, 10.0, 10.0, 10.0],
        'humidity':   [60.0, 60.0, 70.0, 70.0],
        'wind_speed': [5.0, 5.0, 4.0, 4.0],
        'wind_gust':  [7.0, 7.0, 6.0, 6.0],
        'wind_dir':   [180, 180, 200, 200],
        'wx_cond':    ['Clear', 'Clear', 'Light Rain', 'Light Rain'],
        'station_id': ['A', 'A', 'B', 'B'],
    })
    out = mo._bucket(raw)
    # All four readings fall in the 12:00 bucket
    assert len(out) == 1
    row = out.iloc[0]
    # precip = max(0, 2 mm, 3 mm) -> ~0.118 in
    assert row['precip_in'] == pytest.approx(3.0 / 25.4, abs=1e-3)
    # temp median in F
    assert 67 < row['temp_f'] < 70
    # both stations
    assert row['n_stations'] == 2
    # source tag for auditability
    assert row['source'] == 'mesonet'


def test_bucket_handles_empty():
    assert mo._bucket(pd.DataFrame({
        'time_utc': pd.to_datetime([], utc=True),
        'precip_5m': [], 'precip_1h': [], 'air_temp': [], 'dewpoint': [],
        'humidity': [], 'wind_speed': [], 'wind_gust': [], 'wind_dir': [],
        'wx_cond': [], 'station_id': [],
    })).empty


# ── Labeler integration (no network) ─────────────────────────────────────────

@dataclass
class _FakeRecord:
    timestamp: datetime


def _make_obs_df(rows):
    """Build a DataFrame matching the IEM ASOS bucket-to-hourly shape."""
    df = pd.DataFrame(rows)
    df['time_utc'] = pd.to_datetime(df['time_utc'], utc=True)
    return df


def test_labeler_falls_back_to_asos_when_no_mesonet():
    snap = _FakeRecord(timestamp=datetime(2026, 5, 17, 12, 0, tzinfo=timezone.utc))
    asos = _make_obs_df([{
        'time_utc': '2026-05-17T12:00Z', 'precip_in': 0.5,
        'has_thunder': False, 'condition_category': 'rain',
    }])
    out = label_lead_targets(snap, asos, mesonet_obs=None)
    # +10 lead: nearest ASOS row is the 12:00 one — should produce labels
    assert out['precip_active_+10'] is True
    assert out['truth_source_+10'] == 'asos'


def test_labeler_prefers_mesonet_over_asos():
    """When both ASOS and mesonet have readings near the target, mesonet wins."""
    snap = _FakeRecord(timestamp=datetime(2026, 5, 17, 12, 0, tzinfo=timezone.utc))

    asos = _make_obs_df([{
        'time_utc': '2026-05-17T12:00Z', 'precip_in': 0.0,
        'has_thunder': False, 'condition_category': 'clear',
    }])
    # Mesonet at +10: rain detected
    mesonet = _make_obs_df([{
        'time_utc': '2026-05-17T12:10Z', 'precip_in': 0.04,
        'has_thunder': False, 'condition_category': 'rain',
    }])
    out = label_lead_targets(snap, asos, mesonet_obs=mesonet)

    # +10 label should come from mesonet (rain)
    assert out['precip_active_+10'] is True
    assert out['condition_+10'] == 'rain'
    assert out['truth_source_+10'] == 'mesonet'


def test_labeler_falls_back_when_mesonet_too_old():
    """If mesonet's nearest reading is >15 min from target, fall through to ASOS."""
    snap = _FakeRecord(timestamp=datetime(2026, 5, 17, 12, 0, tzinfo=timezone.utc))

    asos = _make_obs_df([{
        'time_utc': '2026-05-17T12:05Z', 'precip_in': 0.0,
        'has_thunder': False, 'condition_category': 'clear',
    }])
    # Mesonet reading 40 min away — outside the 15-min window
    mesonet = _make_obs_df([{
        'time_utc': '2026-05-17T11:25Z', 'precip_in': 0.10,
        'has_thunder': False, 'condition_category': 'rain',
    }])
    out = label_lead_targets(snap, asos, mesonet_obs=mesonet)
    # Should pick up ASOS (which says clear)
    assert out['precip_active_+10'] is False
    assert out['truth_source_+10'] == 'asos'


def test_current_truth_source_field():
    snap = _FakeRecord(timestamp=datetime(2026, 5, 17, 12, 0, tzinfo=timezone.utc))
    mesonet = _make_obs_df([{
        'time_utc': '2026-05-17T12:01Z', 'precip_in': 0.06,
        'has_thunder': True, 'condition_category': 'thunder',
    }])
    out = label_current_truth(snap, pd.DataFrame(), mesonet_obs=mesonet)
    assert out['truth_source'] == 'mesonet'
    assert out['obs_precip_active'] is True
    assert out['obs_thunder'] is True


def test_empty_labels_include_source():
    labels = _empty_labels()
    for lead in (10, 20, 30, 45, 60):
        assert labels[f'truth_source_+{lead}'] == 'none'


# ── Live smoke (skipped without token) ───────────────────────────────────────

pytestmark_live = pytest.mark.skipif(
    not mo.is_enabled() or os.environ.get('NO_NETWORK') == '1',
    reason='SYNOPTIC_TOKEN missing or NO_NETWORK=1 — skipping live smoke'
)


@pytestmark_live
def test_live_stations_near_boston(tmp_path):
    """Hit the real API: yesterday's window near Boston should produce data."""
    yesterday = date.today() - timedelta(days=1)
    df = mo.fetch_mesonet_observations(
        lat=42.358, lon=-71.060,
        start_date=yesterday, end_date=yesterday,
        cache_dir=str(tmp_path),
        radius_km=30.0,
        min_stations=3,
        city_slug='boston_test',
    )
    if df.empty:
        pytest.skip('No mesonet stations reporting near Boston yesterday (or sparse network)')
    # Schema compliance
    expected_cols = {
        'time_utc', 'temp_f', 'dewpoint_f', 'humidity', 'wind_dir',
        'wind_mph', 'wind_gust_mph', 'precip_in', 'has_thunder',
        'condition_category', 'n_stations', 'source',
    }
    assert expected_cols <= set(df.columns), f'Missing columns: {expected_cols - set(df.columns)}'
    assert (df['n_stations'] >= 1).all()
    # Sanity bounds on physical values
    for tf in df['temp_f'].dropna():
        assert -50 < tf < 130, f'temp out of bounds: {tf}'
    for p in df['precip_in'].dropna():
        assert 0 <= p < 10, f'precip out of bounds: {p}'
