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

import pandas as pd

logger = logging.getLogger(__name__)

LEAD_MINUTES = [10, 20, 30, 45, 60]


def label_lead_targets(log_record, observations: pd.DataFrame) -> dict:
    """
    Generate truth labels at each lead time for a single log record.

    Args:
        log_record: A LogRecord from ingest.py
        observations: Hourly-bucketed DataFrame with time_utc, precip_in,
                      has_thunder, condition_category, etc.

    Returns:
        Dict with keys like 'precip_active_+10', 'thunder_active_+10',
        'condition_+10', 'precip_intensity_+10' for each lead time.
        Values are None if no observation available.
    """
    if observations.empty:
        return _empty_labels()

    snap_ts = pd.Timestamp(log_record.timestamp)
    if snap_ts.tz is None:
        snap_ts = snap_ts.tz_localize('UTC')

    labels = {}
    for lead in LEAD_MINUTES:
        target_ts = snap_ts + timedelta(minutes=lead)
        obs_row = _nearest_obs(observations, target_ts, max_gap_min=40)

        suffix = f'+{lead}'
        if obs_row is not None:
            precip_in = obs_row.get('precip_in', 0) or 0
            labels[f'precip_active_{suffix}'] = precip_in > 0.01
            labels[f'thunder_active_{suffix}'] = bool(obs_row.get('has_thunder', False))
            labels[f'condition_{suffix}'] = obs_row.get('condition_category', 'clear')
            labels[f'precip_intensity_{suffix}'] = round(precip_in, 3)
        else:
            labels[f'precip_active_{suffix}'] = None
            labels[f'thunder_active_{suffix}'] = None
            labels[f'condition_{suffix}'] = None
            labels[f'precip_intensity_{suffix}'] = None

    return labels


def label_current_truth(log_record, observations: pd.DataFrame) -> dict:
    """
    Label what was actually happening at the moment of the log record.
    Used for scoring the nowcast's current-state accuracy.
    """
    if observations.empty:
        return {
            'obs_precip_active': None,
            'obs_thunder': None,
            'obs_condition': None,
            'obs_precip_in': None,
        }

    snap_ts = pd.Timestamp(log_record.timestamp)
    if snap_ts.tz is None:
        snap_ts = snap_ts.tz_localize('UTC')

    obs_row = _nearest_obs(observations, snap_ts, max_gap_min=65)
    if obs_row is None:
        return {
            'obs_precip_active': None,
            'obs_thunder': None,
            'obs_condition': None,
            'obs_precip_in': None,
        }

    precip_in = obs_row.get('precip_in', 0) or 0
    return {
        'obs_precip_active': precip_in > 0.01,
        'obs_thunder': bool(obs_row.get('has_thunder', False)),
        'obs_condition': obs_row.get('condition_category', 'clear'),
        'obs_precip_in': round(precip_in, 3),
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
    return labels
