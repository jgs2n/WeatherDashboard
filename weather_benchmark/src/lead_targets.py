"""
Lead-target truth labeling for ML training.

For each nowcast log record, looks ahead +10/20/30/45/60 minutes in
IEM ASOS observations and labels what actually happened:
  - precip_active: was it raining?
  - thunder_active: was there thunder?
  - condition: category string
  - precip_intensity: inches accumulated

These truth labels become the ML training targets.
"""

import logging
from datetime import timedelta
from typing import Optional

import pandas as pd

logger = logging.getLogger(__name__)

LEAD_MINUTES = [10, 20, 30, 45, 60]


def label_lead_targets(log_record,
                       observations: pd.DataFrame,
                       mesonet_obs: Optional[pd.DataFrame] = None,
                       mrms_obs: Optional[pd.DataFrame] = None) -> dict:
    """
    Generate truth labels at each lead time for a single log record.

    Args:
        log_record: A LogRecord from ingest.py
        observations: ASOS hourly-bucketed DataFrame (time_utc, precip_in,
                      has_thunder, condition_category, ...)
        mesonet_obs:  Optional 10-min-bucketed mesonet DataFrame in the same
                      shape (from `mesonet_observations.fetch_mesonet_observations`).
        mrms_obs:     Optional 10-min-cadence MRMS DataFrame in the same
                      shape (from `mrms_observations.fetch_mrms_observations`).
                      MRMS is co-located with the snapshot in space and time —
                      preferred over mesonet/ASOS when present.

    Precedence at each lead time: MRMS (within 4 min) → mesonet (within
    15 min) → ASOS (within 40 min) → `none`. Emits `truth_source_+N`.

    Returns:
        Dict with keys like 'precip_active_+10', 'thunder_active_+10',
        'condition_+10', 'precip_intensity_+10' for each lead time, plus
        'truth_source_+10' indicating where each label came from.
        Values are None if no observation available.
    """
    has_asos = observations is not None and not observations.empty
    has_meso = mesonet_obs is not None and not mesonet_obs.empty
    has_mrms = mrms_obs is not None and not mrms_obs.empty
    if not (has_asos or has_meso or has_mrms):
        return _empty_labels()

    snap_ts = pd.Timestamp(log_record.timestamp)
    if snap_ts.tz is None:
        snap_ts = snap_ts.tz_localize('UTC')

    labels = {}
    for lead in LEAD_MINUTES:
        target_ts = snap_ts + timedelta(minutes=lead)
        suffix = f'+{lead}'

        # Precedence: MRMS > mesonet > ASOS. MRMS is 2-min cadence so a
        # 4-min gap covers any single missed publish cycle.
        obs_row = None
        source = 'none'

        if has_mrms:
            obs_row = _nearest_obs(mrms_obs, target_ts, max_gap_min=4)
            if obs_row is not None:
                source = 'mrms'

        if obs_row is None and has_meso:
            obs_row = _nearest_obs(mesonet_obs, target_ts, max_gap_min=15)
            if obs_row is not None:
                source = 'mesonet'

        if obs_row is None and has_asos:
            obs_row = _nearest_obs(observations, target_ts, max_gap_min=40)
            if obs_row is not None:
                source = 'asos'

        if obs_row is not None:
            precip_in = obs_row.get('precip_in', 0) or 0
            labels[f'precip_active_{suffix}'] = precip_in > 0.01
            labels[f'thunder_active_{suffix}'] = bool(obs_row.get('has_thunder', False))
            labels[f'condition_{suffix}'] = obs_row.get('condition_category', 'clear')
            labels[f'precip_intensity_{suffix}'] = round(precip_in, 3)
            labels[f'truth_source_{suffix}'] = source
        else:
            labels[f'precip_active_{suffix}'] = None
            labels[f'thunder_active_{suffix}'] = None
            labels[f'condition_{suffix}'] = None
            labels[f'precip_intensity_{suffix}'] = None
            labels[f'truth_source_{suffix}'] = 'none'

    return labels


def label_current_truth(log_record,
                        observations: pd.DataFrame,
                        mesonet_obs: Optional[pd.DataFrame] = None,
                        mrms_obs: Optional[pd.DataFrame] = None) -> dict:
    """
    Label what was actually happening at the moment of the log record.
    Same MRMS > mesonet > ASOS precedence as `label_lead_targets`.
    """
    has_asos = observations is not None and not observations.empty
    has_meso = mesonet_obs is not None and not mesonet_obs.empty
    has_mrms = mrms_obs is not None and not mrms_obs.empty
    if not (has_asos or has_meso or has_mrms):
        return {
            'obs_precip_active': None,
            'obs_thunder': None,
            'obs_condition': None,
            'obs_precip_in': None,
            'truth_source': 'none',
        }

    snap_ts = pd.Timestamp(log_record.timestamp)
    if snap_ts.tz is None:
        snap_ts = snap_ts.tz_localize('UTC')

    obs_row = None
    source = 'none'

    if has_mrms:
        obs_row = _nearest_obs(mrms_obs, snap_ts, max_gap_min=4)
        if obs_row is not None:
            source = 'mrms'

    if obs_row is None and has_meso:
        obs_row = _nearest_obs(mesonet_obs, snap_ts, max_gap_min=20)
        if obs_row is not None:
            source = 'mesonet'

    if obs_row is None and has_asos:
        obs_row = _nearest_obs(observations, snap_ts, max_gap_min=65)
        if obs_row is not None:
            source = 'asos'

    if obs_row is None:
        return {
            'obs_precip_active': None,
            'obs_thunder': None,
            'obs_condition': None,
            'obs_precip_in': None,
            'truth_source': source,
        }

    precip_in = obs_row.get('precip_in', 0) or 0
    return {
        'obs_precip_active': precip_in > 0.01,
        'obs_thunder': bool(obs_row.get('has_thunder', False)),
        'obs_condition': obs_row.get('condition_category', 'clear'),
        'obs_precip_in': round(precip_in, 3),
        'truth_source': source,
    }


def _nearest_obs(observations: pd.DataFrame, target_ts, max_gap_min: int = 40):
    """Find the observation nearest to target_ts within max_gap_min."""
    if observations.empty:
        return None

    diffs = (observations['time_utc'] - target_ts).abs()
    min_idx = diffs.idxmin()
    min_gap = diffs.loc[min_idx]

    if min_gap > timedelta(minutes=max_gap_min):
        return None

    return observations.loc[min_idx].to_dict()


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
    return labels
