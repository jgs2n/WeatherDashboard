"""
Lead-target truth labeling for ML training.

For each nowcast log record, looks ahead +10/20/30/45/60 minutes in the
truth sources and labels what actually happened:
  - precip_active: was it raining?
  - thunder_active: was there thunder?
  - condition: category string
  - precip_intensity: inches (ASOS p01i) or in/hr (MRMS rate)

These truth labels become the ML training targets.

Truth v2 (2026-10-25) — one-sided matching:
  A label for target time T comes from the first observation AT OR AFTER T
  (within a per-source max lag), never from an earlier one and never from a
  bucket that aggregates later weather. ASOS input is the raw 5-min/special
  METAR frame (``observations.metar_frame``), so precip/thunder come from that
  single observation's present-weather codes. Every label also records
  ``truth_lag_min_+N`` (obs time − target) so analyses can tighten the window.

  ``legacy=True`` reproduces the pre-v2 behaviour (two-sided nearest match on
  the hourly-bucketed ASOS frame, precip = p01i > 0.01) for comparisons only.
"""

import logging
import math
from datetime import timedelta
from typing import Optional

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

LEAD_MINUTES = [10, 20, 30, 45, 60]

# One-sided max lag per source (minutes after the target time).
MRMS_MAX_LAG_MIN = 10      # one grid per 10-min backtest cadence
MESONET_MAX_LAG_MIN = 15
ASOS_MAX_LAG_MIN = 20      # 5-min feed → usually <= 5; covers hourly-only sites partly

# Legacy two-sided tolerances (pre-v2), kept for --truth legacy.
_LEGACY_GAPS = {'mrms': 4, 'mesonet': 15, 'asos': 40}
_LEGACY_CURRENT_GAPS = {'mrms': 4, 'mesonet': 20, 'asos': 65}


def _has(df) -> bool:
    return df is not None and not df.empty


def label_lead_targets(log_record,
                       observations: pd.DataFrame,
                       mesonet_obs: Optional[pd.DataFrame] = None,
                       mrms_obs: Optional[pd.DataFrame] = None,
                       *, legacy: bool = False,
                       max_lag: Optional[dict] = None) -> dict:
    """
    Generate truth labels at each lead time for a single log record.

    Args:
        log_record: A LogRecord from ingest.py
        observations: ASOS frame — raw per-observation (``metar_frame``) for
                      v2, hourly-bucketed (``bucket_to_hourly``) for legacy.
        mesonet_obs:  Optional mesonet DataFrame in the same shape.
        mrms_obs:     Optional MRMS DataFrame (``mrms_observations``).
        legacy:       Reproduce the pre-v2 two-sided nearest matching.
        max_lag:      Optional per-source override {'mrms','mesonet','asos'}.

    Precedence at each lead time: MRMS → mesonet → ASOS → `none`.

    Returns:
        Dict with keys like 'precip_active_+10', 'thunder_active_+10',
        'condition_+10', 'precip_intensity_+10', 'truth_source_+10' and
        'truth_lag_min_+10' for each lead time. Values are None if no
        observation is available.
    """
    if not (_has(observations) or _has(mesonet_obs) or _has(mrms_obs)):
        return _empty_labels()

    snap_ts = _utc(log_record.timestamp)
    labels = {}
    for lead in LEAD_MINUTES:
        target_ts = snap_ts + timedelta(minutes=lead)
        t = resolve_truth(target_ts, observations, mesonet_obs, mrms_obs,
                          legacy=legacy, max_lag=max_lag, gaps=_LEGACY_GAPS)
        suffix = f'+{lead}'
        labels[f'precip_active_{suffix}'] = t['precip_active']
        labels[f'thunder_active_{suffix}'] = t['thunder']
        labels[f'condition_{suffix}'] = t['condition']
        labels[f'precip_intensity_{suffix}'] = t['precip_in']
        labels[f'truth_source_{suffix}'] = t['source']
        labels[f'truth_lag_min_{suffix}'] = t['lag_min']
    return labels


def label_current_truth(log_record,
                        observations: pd.DataFrame,
                        mesonet_obs: Optional[pd.DataFrame] = None,
                        mrms_obs: Optional[pd.DataFrame] = None,
                        *, legacy: bool = False,
                        max_lag: Optional[dict] = None) -> dict:
    """
    Label what was actually happening at the moment of the log record.
    Same precedence and matching rules as `label_lead_targets`.
    """
    if not (_has(observations) or _has(mesonet_obs) or _has(mrms_obs)):
        return {
            'obs_precip_active': None,
            'obs_thunder': None,
            'obs_condition': None,
            'obs_precip_in': None,
            'truth_source': 'none',
            'truth_lag_min': None,
        }
    t = resolve_truth(_utc(log_record.timestamp), observations, mesonet_obs, mrms_obs,
                      legacy=legacy, max_lag=max_lag, gaps=_LEGACY_CURRENT_GAPS)
    return {
        'obs_precip_active': t['precip_active'],
        'obs_thunder': t['thunder'],
        'obs_condition': t['condition'],
        'obs_precip_in': t['precip_in'],
        'truth_source': t['source'],
        'truth_lag_min': t['lag_min'],
    }


def resolve_truth(target_ts, asos, mesonet=None, mrms=None, *, legacy=False,
                  max_lag=None, gaps=_LEGACY_GAPS) -> dict:
    """Truth at one instant via the MRMS → mesonet → ASOS chain.

    Returns {precip_active, thunder, condition, precip_in, source, lag_min,
    row}. ``row`` is the matched observation dict (None when nothing matched).
    """
    target_ts = _utc(target_ts)
    lags = {'mrms': MRMS_MAX_LAG_MIN, 'mesonet': MESONET_MAX_LAG_MIN,
            'asos': ASOS_MAX_LAG_MIN}
    if max_lag:
        lags.update(max_lag)

    row, source = None, 'none'
    for name, df in (('mrms', mrms), ('mesonet', mesonet), ('asos', asos)):
        if not _has(df):
            continue
        if legacy:
            row = _nearest_obs(df, target_ts, max_gap_min=gaps[name])
        else:
            row = next_obs(df, target_ts, max_lag_min=lags[name])
        if row is not None:
            source = name
            break

    if row is None:
        return {'precip_active': None, 'thunder': None, 'condition': None,
                'precip_in': None, 'source': 'none', 'lag_min': None, 'row': None}

    precip_in = _num(row.get('precip_in'))
    if legacy or _isnull(row.get('precip_active')):
        precip_active = (precip_in or 0) > 0.01
    else:
        precip_active = bool(row.get('precip_active'))

    thunder = row.get('has_thunder')
    if _isnull(thunder):
        # MRMS carries no thunder signal — take it from ASOS at the same target.
        thunder = None
        if source != 'asos' and _has(asos):
            arow = (_nearest_obs(asos, target_ts, max_gap_min=gaps['asos']) if legacy
                    else next_obs(asos, target_ts, max_lag_min=lags['asos']))
            if arow is not None and not _isnull(arow.get('has_thunder')):
                thunder = bool(arow.get('has_thunder'))
    else:
        thunder = bool(thunder)

    lag = (_utc(row['time_utc']) - target_ts).total_seconds() / 60.0
    return {
        'precip_active': precip_active,
        'thunder': thunder,
        'condition': row.get('condition_category', 'clear'),
        'precip_in': round(precip_in, 3) if precip_in is not None else None,
        'source': source,
        'lag_min': round(lag, 1),
        'row': row,
    }


# ── Matching ─────────────────────────────────────────────────────────────────

# Small identity-keyed cache of sorted int64 time arrays so per-record lookups
# are O(log n) instead of rebuilding the array every call.
_TIME_INDEX: dict = {}


def _time_index(df: pd.DataFrame):
    key = id(df)
    hit = _TIME_INDEX.get(key)
    if hit is not None and hit[0] is df and hit[3] == len(df):
        return hit[1], hit[2]
    times = pd.to_datetime(df['time_utc'], utc=True)
    ns = times.values.astype('datetime64[ns]').astype('int64')
    order = np.argsort(ns, kind='stable')
    ns = ns[order]
    if len(_TIME_INDEX) > 16:
        _TIME_INDEX.clear()
    _TIME_INDEX[key] = (df, ns, order, len(df))
    return ns, order


def next_obs(observations: pd.DataFrame, target_ts, max_lag_min: float):
    """First observation with target_ts <= time <= target_ts + max_lag_min."""
    if observations is None or observations.empty:
        return None
    ns, order = _time_index(observations)
    t = _utc(target_ts).value
    i = int(np.searchsorted(ns, t, side='left'))
    if i >= len(ns) or ns[i] - t > max_lag_min * 60 * 1e9:
        return None
    return observations.iloc[order[i]].to_dict()


def obs_between(observations: pd.DataFrame, start_ts, end_ts) -> pd.DataFrame:
    """Rows with start_ts <= time <= end_ts, time-sorted (timing windows)."""
    if observations is None or observations.empty:
        return pd.DataFrame()
    ns, order = _time_index(observations)
    lo = int(np.searchsorted(ns, _utc(start_ts).value, side='left'))
    hi = int(np.searchsorted(ns, _utc(end_ts).value, side='right'))
    return observations.iloc[order[lo:hi]]


def _nearest_obs(observations: pd.DataFrame, target_ts, max_gap_min: int = 40):
    """Legacy: observation nearest to target_ts (either side) within max_gap_min."""
    if observations.empty:
        return None

    diffs = (observations['time_utc'] - target_ts).abs()
    min_idx = diffs.idxmin()
    min_gap = diffs.loc[min_idx]

    if min_gap > timedelta(minutes=max_gap_min):
        return None

    return observations.loc[min_idx].to_dict()


def _utc(ts) -> pd.Timestamp:
    ts = pd.Timestamp(ts)
    return ts.tz_localize('UTC') if ts.tz is None else ts.tz_convert('UTC')


def _isnull(v) -> bool:
    if v is None:
        return True
    return isinstance(v, float) and math.isnan(v)


def _num(v):
    if _isnull(v):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _empty_labels() -> dict:
    """Return a dict with None for all lead targets."""
    labels = {}
    for lead in LEAD_MINUTES:
        suffix = f'+{lead}'
        labels[f'precip_active_{suffix}'] = None
        labels[f'thunder_active_{suffix}'] = None
        labels[f'condition_{suffix}'] = None
        labels[f'precip_intensity_{suffix}'] = None
        labels[f'truth_source_{suffix}'] = 'none'
        labels[f'truth_lag_min_{suffix}'] = None
    return labels
