"""Tests for the MRMS truth source.

Two layers:
  - **offline unit tests** — parsing wgrib2 stdout, cycle snapping, value
    bounds. No network, no wgrib2 required.
  - **live smoke test** — requires `wgrib2` on PATH (or at the
    project-local fallback). Downloads a recent MRMS grid and extracts
    values at known cities. Skipped if wgrib2 missing or NO_NETWORK=1.

Plus three labeler-integration tests verifying the MRMS > mesonet > ASOS
precedence chain.

Run all:
    pytest weather_benchmark/tests/test_mrms.py -v
"""

import os
from datetime import date, datetime, timezone, timedelta
from dataclasses import dataclass

import pandas as pd
import pytest

from src import mrms_observations as mr
from src.lead_targets import label_lead_targets, label_current_truth


# ── Offline unit tests ────────────────────────────────────────────────────────

def test_resolve_wgrib2_finds_project_binary():
    """The project-local fallback (wgrib/wgrib2.exe) should be discoverable."""
    p = mr.resolve_wgrib2(None)
    # Either PATH has wgrib2 or the project-local fallback exists
    if p is None:
        pytest.skip('No wgrib2 binary found in any expected location')
    assert os.path.isfile(p)


def test_resolve_wgrib2_uses_explicit_path():
    """An explicit path that exists should be returned verbatim."""
    # Use this test file as a stand-in "exists" target
    p = mr.resolve_wgrib2(__file__)
    assert p is not None
    assert os.path.normcase(p) == os.path.normcase(os.path.abspath(__file__))


def test_resolve_wgrib2_returns_none_for_bogus_path():
    """Non-existent path falls through to PATH/fallback search."""
    # Will return either a real binary or None — but never the bogus path
    p = mr.resolve_wgrib2('/does/not/exist/wgrib2')
    if p is not None:
        # Some real binary was found via PATH/fallback
        assert p != '/does/not/exist/wgrib2'


def test_snap_to_mrms_cycle():
    """MRMS publishes on even minutes; snap rounds down."""
    cases = [
        (datetime(2026, 5, 17, 15, 38, 41, tzinfo=timezone.utc),
         datetime(2026, 5, 17, 15, 38, 0,  tzinfo=timezone.utc)),
        (datetime(2026, 5, 17, 15, 39, 0,  tzinfo=timezone.utc),
         datetime(2026, 5, 17, 15, 38, 0,  tzinfo=timezone.utc)),
        (datetime(2026, 5, 17, 15, 40, 1,  tzinfo=timezone.utc),
         datetime(2026, 5, 17, 15, 40, 0,  tzinfo=timezone.utc)),
        (datetime(2026, 5, 17, 15,  1, 0,  tzinfo=timezone.utc),
         datetime(2026, 5, 17, 15,  0, 0,  tzinfo=timezone.utc)),
    ]
    for inp, expected in cases:
        assert mr._snap_to_mrms_cycle(inp) == expected, f'snap({inp}) != {expected}'


def test_wgrib2_val_regex():
    """Parse 'val=N' from a wgrib2 stdout line."""
    line = '1:0:lon=288.945,lat=42.355,val=0:lon=275.615,lat=33.745,val=1.234e-02'
    matches = mr.WGRIB2_VAL_RE.findall(line)
    assert matches == ['0', '1.234e-02']


def test_missing_value_constant_sane():
    """wgrib2 uses 9.999e+20 as missing — our filter must catch it."""
    assert mr.MISSING_VALUE > 1e19


# ── Labeler precedence (no network) ──────────────────────────────────────────

@dataclass
class _FakeRecord:
    timestamp: datetime


def _make_obs_df(rows):
    df = pd.DataFrame(rows)
    df['time_utc'] = pd.to_datetime(df['time_utc'], utc=True)
    return df


def test_mrms_wins_over_mesonet_and_asos():
    """When all three sources have readings near the target, MRMS wins."""
    snap = _FakeRecord(timestamp=datetime(2026, 5, 17, 12, 0, tzinfo=timezone.utc))

    # All three disagree to make the precedence visible:
    asos = _make_obs_df([{
        'time_utc': '2026-05-17T12:00Z', 'precip_in': 0.0,
        'has_thunder': False, 'condition_category': 'clear',
    }])
    meso = _make_obs_df([{
        'time_utc': '2026-05-17T12:09Z', 'precip_in': 0.05,
        'has_thunder': False, 'condition_category': 'rain',
    }])
    mrms = _make_obs_df([{
        'time_utc': '2026-05-17T12:10Z', 'precip_in': 0.12,
        'has_thunder': False, 'condition_category': 'rain',
    }])

    out = label_lead_targets(snap, asos, mesonet_obs=meso, mrms_obs=mrms)

    # +10 target: MRMS has a reading at exactly +10 → wins
    assert out['truth_source_+10'] == 'mrms'
    assert out['precip_intensity_+10'] == 0.12


def test_falls_back_to_mesonet_when_mrms_too_far():
    """If MRMS has no reading within 4 min, mesonet takes over."""
    snap = _FakeRecord(timestamp=datetime(2026, 5, 17, 12, 0, tzinfo=timezone.utc))
    asos = _make_obs_df([{
        'time_utc': '2026-05-17T12:00Z', 'precip_in': 0.0,
        'has_thunder': False, 'condition_category': 'clear',
    }])
    meso = _make_obs_df([{
        'time_utc': '2026-05-17T12:09Z', 'precip_in': 0.05,
        'has_thunder': False, 'condition_category': 'rain',
    }])
    # MRMS reading 30 min away from any +N target — well outside the 4-min tolerance
    mrms = _make_obs_df([{
        'time_utc': '2026-05-17T13:00Z', 'precip_in': 0.5,
        'has_thunder': False, 'condition_category': 'rain',
    }])
    out = label_lead_targets(snap, asos, mesonet_obs=meso, mrms_obs=mrms)
    assert out['truth_source_+10'] == 'mesonet'


def test_falls_back_to_asos_when_both_far():
    """If neither MRMS nor mesonet has a near-target reading, ASOS wins."""
    snap = _FakeRecord(timestamp=datetime(2026, 5, 17, 12, 0, tzinfo=timezone.utc))
    asos = _make_obs_df([{
        'time_utc': '2026-05-17T12:10Z', 'precip_in': 0.0,
        'has_thunder': False, 'condition_category': 'clear',
    }])
    # Both higher-priority sources too far away to match +10 target (12:10)
    meso = _make_obs_df([{
        'time_utc': '2026-05-17T11:00Z', 'precip_in': 0.05,
        'has_thunder': False, 'condition_category': 'rain',
    }])
    mrms = _make_obs_df([{
        'time_utc': '2026-05-17T11:00Z', 'precip_in': 0.5,
        'has_thunder': False, 'condition_category': 'rain',
    }])
    out = label_lead_targets(snap, asos, mesonet_obs=meso, mrms_obs=mrms)
    assert out['truth_source_+10'] == 'asos'


def test_current_truth_mrms_precedence():
    """label_current_truth also respects the precedence chain."""
    snap = _FakeRecord(timestamp=datetime(2026, 5, 17, 12, 0, tzinfo=timezone.utc))
    mrms = _make_obs_df([{
        'time_utc': '2026-05-17T11:58Z', 'precip_in': 0.20,
        'has_thunder': False, 'condition_category': 'rain',
    }])
    out = label_current_truth(snap, pd.DataFrame(), mrms_obs=mrms)
    assert out['truth_source'] == 'mrms'
    assert out['obs_precip_active'] is True


# ── Live smoke (skipped without wgrib2 or with NO_NETWORK) ──────────────────

_WGRIB2 = mr.resolve_wgrib2()

pytestmark_live = pytest.mark.skipif(
    _WGRIB2 is None or os.environ.get('NO_NETWORK') == '1',
    reason='wgrib2 binary not found or NO_NETWORK=1 — skipping live smoke'
)


@pytestmark_live
def test_live_download_and_extract():
    """Download a recent MRMS grid, extract values at three cities, verify bounds."""
    target = datetime.now(timezone.utc) - timedelta(minutes=5)
    snapped = mr._snap_to_mrms_cycle(target)
    gb = mr._download_grid_with_fallback(snapped, snapped.date())
    if gb is None:
        pytest.skip(f'MRMS grid for {snapped} not available — endpoint may be lagged')
    assert len(gb) > 100_000, 'grid suspiciously small'

    for name, lat, lon in [('Boston', 42.358, -71.060),
                            ('Atlanta', 33.749, -84.388),
                            ('Bozeman', 45.680, -111.040)]:
        v = mr._extract_point(gb, lat, lon, _WGRIB2)
        # Either a finite rate or None (out-of-CONUS, missing pixel)
        if v is not None:
            assert 0 <= v <= 200, f'{name} rate {v} out of bounds'


@pytestmark_live
def test_live_fetch_observations_short_window(tmp_path):
    """End-to-end: build a small per-city time series for the current hour."""
    now = datetime.now(timezone.utc)
    today = now.date()
    df = mr.fetch_mrms_observations(
        lat=42.358, lon=-71.060,
        start_date=today, end_date=today,
        cache_dir=str(tmp_path),
        fetch_cadence_min=20,        # coarser to keep test fast
        city_slug='boston_test',
    )
    if df.empty:
        pytest.skip('MRMS returned no samples — endpoint lag or wgrib2 problem')
    # Schema compliance with the IEM ASOS shape
    expected = {'time_utc', 'precip_in', 'has_thunder', 'condition_category', 'source'}
    assert expected <= set(df.columns)
    assert (df['source'] == 'mrms').all()
    for v in df['precip_in'].dropna():
        assert 0 <= v <= 10, f'precip_in {v} out of bounds for in/hr'
