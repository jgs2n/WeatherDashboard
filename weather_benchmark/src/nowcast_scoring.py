"""
Nowcast-specific verification.

Scores the real-time nowcast layer separately from multi-day forecasts because
nowcast failures have different causes (radar sampling, confidence thresholds,
wording logic) than forecast model failures (NWP bias, resolution limits).

Evaluates:
  1. Precip start/end timing accuracy
  2. Duration prediction accuracy
  3. Wording appropriateness (overstated / understated / imprecise)
  4. Confidence calibration
  5. "Too precise for confidence level" violations
  6. Lightning state accuracy
  7. Icon agreement
"""

import re
import logging
import math
from dataclasses import dataclass, field
from datetime import timedelta

import numpy as np
import pandas as pd

from .ingest import NowcastSnapshot
from .utils import has_thunder, metar_wx_to_category

logger = logging.getLogger(__name__)


# ── Result dataclass ─────────────────────────────────────────────────────────

@dataclass
class NowcastMetrics:
    """Aggregated nowcast verification metrics."""
    # Precip timing
    precip_start_mae_min: float = float('nan')
    precip_end_mae_min: float = float('nan')
    duration_mae_min: float = float('nan')
    precip_start_errors: list = field(default_factory=list)
    precip_end_errors: list = field(default_factory=list)
    duration_errors: list = field(default_factory=list)

    # Wording appropriateness
    wording_correct_rate: float = float('nan')
    wording_overstated_rate: float = float('nan')
    wording_understated_rate: float = float('nan')
    wording_imprecise_rate: float = float('nan')
    wording_details: list = field(default_factory=list)

    # Confidence calibration
    confidence_calibration: dict = field(default_factory=dict)

    # Precision violations
    precision_violations: list = field(default_factory=list)

    # Lightning
    lightning_pod: float = float('nan')
    lightning_far: float = float('nan')
    lightning_approach_success: float = float('nan')
    lightning_details: list = field(default_factory=list)

    # Icon agreement
    icon_agreement: float = float('nan')

    n_snapshots: int = 0

    def to_dict(self) -> dict:
        d = {}
        for k, v in self.__dict__.items():
            if isinstance(v, float) and math.isnan(v):
                d[k] = None
            else:
                d[k] = v
        return d


# ── Main entry point ─────────────────────────────────────────────────────────

def score_nowcasts(
    nowcasts: list,
    observations: pd.DataFrame,
    config: dict,
) -> NowcastMetrics:
    """
    Score all nowcast snapshots against observations.

    Args:
        nowcasts: List of NowcastSnapshot
        observations: Hourly-bucketed DataFrame with time_utc, has_thunder, etc.
        config: nowcast_scoring section of the config

    Returns:
        NowcastMetrics with aggregated scores
    """
    nc_cfg = config.get('nowcast_scoring', {})
    timing_window = nc_cfg.get('precip_timing_window_min', 60)
    precision_cfg = nc_cfg.get('precision_violation_thresholds', {})

    metrics = NowcastMetrics(n_snapshots=len(nowcasts))

    if not nowcasts or observations.empty:
        return metrics

    # Per-snapshot scoring
    start_errors = []
    end_errors = []
    duration_errors = []
    wording_results = []
    confidence_buckets = {'high': [], 'med': [], 'low': []}
    violations = []
    lightning_results = []
    icon_results = []

    for snap in nowcasts:
        try:
            obs_window = build_nowcast_obs_window(snap, observations, window_min=90)
            if obs_window.empty:
                logger.debug(f'No obs window for nowcast at {snap.snapshot_time}')
                continue

            # 1. Precip timing
            se, ee, de = score_precip_timing_nowcast(snap, obs_window)
            if se is not None:
                start_errors.append(se)
            if ee is not None:
                end_errors.append(ee)
            if de is not None:
                duration_errors.append(de)

            # 2. Wording
            wording = score_wording(snap, obs_window)
            wording_results.append(wording)

            # 3. Confidence calibration
            conf_level = (snap.trend_summary_confidence or '').lower()
            if conf_level in confidence_buckets:
                # Did the precip state match reality?
                obs_at_time = _obs_nearest(obs_window, snap.snapshot_time)
                if obs_at_time is not None:
                    obs_precip = obs_at_time.get('precip_in', 0) or 0
                    obs_raining = obs_precip > 0.01
                    fcst_raining = snap.precip_phenomenon not in ('dry', '')
                    correct = (fcst_raining == obs_raining)
                    confidence_buckets[conf_level].append(correct)

            # 4. Precision violations
            pvs = detect_precision_violations(snap, precision_cfg)
            violations.extend(pvs)

            # 5. Lightning
            lr = score_lightning_state(snap, obs_window, nowcasts)
            if lr is not None:
                lightning_results.append(lr)

            # 6. Icon agreement
            obs_at_time = _obs_nearest(obs_window, snap.snapshot_time)
            if obs_at_time is not None and snap.displayed_icon:
                obs_cat = obs_at_time.get('condition_category', 'clear')
                icon_match = _icon_matches_category(snap.displayed_icon, obs_cat)
                icon_results.append(icon_match)

        except Exception as e:
            logger.warning(f'Nowcast scoring error at {snap.snapshot_time}: {e}')

    # Aggregate
    if start_errors:
        metrics.precip_start_errors = start_errors
        metrics.precip_start_mae_min = float(np.mean(np.abs(start_errors)))
    if end_errors:
        metrics.precip_end_errors = end_errors
        metrics.precip_end_mae_min = float(np.mean(np.abs(end_errors)))
    if duration_errors:
        metrics.duration_errors = duration_errors
        metrics.duration_mae_min = float(np.mean(np.abs(duration_errors)))

    if wording_results:
        metrics.wording_details = wording_results
        cats = [w['category'] for w in wording_results]
        total = len(cats)
        metrics.wording_correct_rate = cats.count('correct') / total
        metrics.wording_overstated_rate = cats.count('overstated') / total
        metrics.wording_understated_rate = cats.count('understated') / total
        metrics.wording_imprecise_rate = cats.count('imprecise') / total

    metrics.confidence_calibration = {
        level: float(np.mean(vals)) if vals else None
        for level, vals in confidence_buckets.items()
    }

    metrics.precision_violations = violations

    if lightning_results:
        metrics.lightning_details = lightning_results
        thunder_obs = [r for r in lightning_results if r['obs_thunder']]
        thunder_fcst = [r for r in lightning_results
                        if r['lightning_state'] in ('active', 'nearby')]
        if thunder_obs:
            hits = sum(1 for r in thunder_obs
                       if r['lightning_state'] in ('active', 'nearby'))
            metrics.lightning_pod = hits / len(thunder_obs)
        if thunder_fcst:
            false_alarms = sum(1 for r in thunder_fcst if not r['obs_thunder'])
            metrics.lightning_far = false_alarms / len(thunder_fcst)
        # Approach success
        approaches = [r for r in lightning_results
                      if r['lightning_state'] == 'approaching']
        if approaches:
            successes = sum(1 for r in approaches if r.get('thunder_followed', False))
            metrics.lightning_approach_success = successes / len(approaches)

    if icon_results:
        metrics.icon_agreement = float(np.mean(icon_results))

    return metrics


# ── Precip timing scoring ────────────────────────────────────────────────────

def score_precip_timing_nowcast(snap: NowcastSnapshot, obs_window: pd.DataFrame):
    """
    Score precip start/end timing predictions against observations.

    Returns (start_error_min, end_error_min, duration_error_min) — any can be None.
    """
    start_error = None
    end_error = None
    duration_error = None

    # Start timing: snap predicted beginInMin
    if snap.trend_begin_in_min is not None:
        predicted_start = snap.snapshot_time + timedelta(minutes=snap.trend_begin_in_min)
        actual_start = _find_precip_transition(obs_window, dry_to_wet=True,
                                                after=snap.snapshot_time)
        if actual_start is not None:
            diff = (actual_start - predicted_start).total_seconds() / 60.0
            if abs(diff) <= 90:  # within reasonable window
                start_error = diff  # positive = actual was later than predicted

    # End timing: snap predicted endInMin
    if snap.trend_end_in_min is not None:
        predicted_end = snap.snapshot_time + timedelta(minutes=snap.trend_end_in_min)
        actual_end = _find_precip_transition(obs_window, dry_to_wet=False,
                                              after=snap.snapshot_time)
        if actual_end is not None:
            diff = (actual_end - predicted_end).total_seconds() / 60.0
            if abs(diff) <= 90:
                end_error = diff

    # Duration: if currently raining and endInMin is set
    if snap.precip_phenomenon not in ('dry', '') and snap.trend_end_in_min is not None:
        predicted_remaining = snap.trend_end_in_min
        actual_end = _find_precip_transition(obs_window, dry_to_wet=False,
                                              after=snap.snapshot_time)
        if actual_end is not None:
            actual_remaining = (actual_end - snap.snapshot_time).total_seconds() / 60.0
            if actual_remaining >= 0:
                duration_error = predicted_remaining - actual_remaining

    return start_error, end_error, duration_error


def _find_precip_transition(obs: pd.DataFrame, dry_to_wet: bool, after=None):
    """Find the first precip transition in the observation window."""
    if obs.empty or len(obs) < 2:
        return None

    obs_sorted = obs.sort_values('time_utc')
    if after is not None:
        after_ts = pd.Timestamp(after)
        if after_ts.tz is None:
            after_ts = after_ts.tz_localize('UTC')
        else:
            after_ts = after_ts.tz_convert('UTC')
        obs_sorted = obs_sorted[obs_sorted['time_utc'] >= after_ts]

    precip_vals = obs_sorted['precip_in'].fillna(0).values
    times = obs_sorted['time_utc'].values

    for i in range(1, len(precip_vals)):
        was_dry = precip_vals[i-1] <= 0.01
        is_wet = precip_vals[i] > 0.01
        if dry_to_wet and was_dry and is_wet:
            ts = pd.Timestamp(times[i])
            return ts if ts.tz else ts.tz_localize('UTC')
        elif not dry_to_wet and not was_dry and not is_wet:
            ts = pd.Timestamp(times[i])
            return ts if ts.tz else ts.tz_localize('UTC')
    return None


# ── Wording scoring ──────────────────────────────────────────────────────────

# Severity ordering for comparison (keyed on precip_phenomenon)
_SEVERITY_ORDER = {
    'dry': 0, '': 0,
    'drizzle': 1, 'light rain': 1,
    'rain': 2, 'snow': 2,
    'heavy rain': 3, 'heavy snow': 3,
    'thunderstorm': 4,
}

# Precip-presence set: condition_categories that indicate precipitation (METAR-based)
_PRECIP_PRESENT_CATS = frozenset({
    'drizzle', 'rain', 'heavy_rain', 'snow', 'heavy_snow',
    'freezing_precip', 'thunderstorm', 'shower',
})

# Intensity severity map keyed on condition_category (for two-axis scoring)
_CAT_SEVERITY = {
    'drizzle': 1,
    'rain': 2, 'shower': 2, 'snow': 2, 'freezing_precip': 2,
    'heavy_rain': 3, 'heavy_snow': 3,
    'thunderstorm': 4,
}


def score_wording(snap: NowcastSnapshot, obs_window: pd.DataFrame) -> dict:
    """
    Classify the displayed condition wording as:
      correct, overstated, understated, or imprecise.
    """
    obs_at_time = _obs_nearest(obs_window, snap.snapshot_time)
    if obs_at_time is None:
        return {'category': 'correct', 'detail': 'no obs to compare'}

    obs_cat = obs_at_time.get('condition_category', 'clear')
    obs_thunder = obs_at_time.get('has_thunder', False)

    displayed = (snap.displayed_condition or '').lower()
    phenomenon = (snap.precip_phenomenon or '').lower()

    # Determine forecast severity
    fcst_severity = _SEVERITY_ORDER.get(phenomenon, 0)
    if 'thunder' in displayed:
        fcst_severity = max(fcst_severity, 4)

    # Determine observed severity from the condition category directly.
    # Previously we gated on precip_in > 0.01 (trace threshold), which caused
    # obs like "heavy_rain wx codes + trace accumulation" to collapse to
    # severity 0 and then score "Dry" displays as correct. Category alone is
    # the authoritative signal now; obs_reconciliation in bucket_to_hourly
    # already downgrades precipitating categories when precip_in is trace and
    # no thunder, so this is safe.
    if obs_thunder:
        obs_severity = 4
    elif obs_cat in _CAT_SEVERITY:
        obs_severity = _CAT_SEVERITY[obs_cat]
    elif obs_cat == 'fog':
        obs_severity = 1
    else:
        obs_severity = 0

    diff = fcst_severity - obs_severity

    # Check for precision violation as a separate category
    conf = (snap.trend_summary_confidence or '').lower()
    summary = snap.trend_summary or ''
    if conf == 'low' and _has_precise_timing(summary):
        return {
            'category': 'imprecise',
            'detail': f'"{summary}" at {conf} confidence',
            'fcst_severity': fcst_severity,
            'obs_severity': obs_severity,
        }

    if diff == 0:
        category = 'correct'
    elif diff > 0:
        category = 'overstated'
    else:
        category = 'understated'

    return {
        'category': category,
        'detail': f'displayed="{snap.displayed_condition}" vs obs={obs_cat}',
        'fcst_severity': fcst_severity,
        'obs_severity': obs_severity,
    }


def score_presence_intensity(snap: NowcastSnapshot, obs_window: pd.DataFrame) -> dict:
    """
    Two-axis scoring:
      - presence: did we correctly detect whether precip was occurring?
                  Truth = METAR condition_category (not precip_in accumulation)
      - intensity: when both sides agree precip is happening, was the tier right?
                   Truth = condition_category severity tier

    presence values: 'correct' | 'false_alarm' | 'miss' | None (no obs)
    intensity values: 'correct' | 'overstated' | 'understated' | None (not applicable)
    """
    obs_at_time = _obs_nearest(obs_window, snap.snapshot_time)
    if obs_at_time is None:
        return {'presence': None, 'intensity': None, 'detail': 'no obs'}

    obs_cat = obs_at_time.get('condition_category', 'clear')
    obs_thunder = bool(obs_at_time.get('has_thunder', False))
    phenomenon = (snap.precip_phenomenon or '').lower()
    displayed = (snap.displayed_condition or '').lower()

    # Presence axis — METAR condition_category as ground truth
    obs_precip_present = obs_cat in _PRECIP_PRESENT_CATS
    # Score presence against what the user sees (displayed_condition), not the internal
    # precip_phenomenon which can diverge when the display suppresses a weak signal.
    fcst_precip_present = phenomenon not in ('dry', '') and displayed not in ('dry', '')

    if fcst_precip_present == obs_precip_present:
        presence = 'correct'
    elif fcst_precip_present:
        presence = 'false_alarm'  # said rain, nothing there
    else:
        presence = 'miss'         # said dry, precip was happening

    # Intensity axis — only scored when both sides have precip
    intensity = None
    if fcst_precip_present and obs_precip_present:
        obs_sev = _CAT_SEVERITY.get(obs_cat, 2)
        if obs_thunder:
            obs_sev = max(obs_sev, 4)
        fcst_sev = _SEVERITY_ORDER.get(phenomenon, 0)
        if 'thunder' in displayed:
            fcst_sev = max(fcst_sev, 4)
        diff = fcst_sev - obs_sev
        if diff == 0:
            intensity = 'correct'
        elif diff > 0:
            intensity = 'overstated'
        else:
            intensity = 'understated'

    return {
        'presence': presence,
        'intensity': intensity,
        'obs_precip_present': obs_precip_present,
        'fcst_precip_present': fcst_precip_present,
        'detail': f'phenomenon="{phenomenon}" obs_cat={obs_cat}',
    }


def _has_precise_timing(summary: str) -> bool:
    """Check if a trend summary uses precise timing language."""
    if not summary:
        return False
    # Matches patterns like "in ~5 min", "in ~3 min", "ending in ~5 min"
    match = re.search(r'~?\s*(\d+)\s*min', summary)
    if match:
        minutes = int(match.group(1))
        return minutes <= 10  # Very precise = 10 min or less
    return False


# ── Precision violation detection ────────────────────────────────────────────

def detect_precision_violations(snap: NowcastSnapshot, cfg: dict) -> list:
    """
    Flag cases where the nowcast is more precise than its confidence supports.

    Examples:
      - "Rain in ~3 min" at low confidence
      - Exact beginInMin when summaryConfidence is low
      - Lightning "nearby" with confidence "low"
    """
    violations = []
    low_max = cfg.get('low_confidence_max_precision_min', 15)
    med_max = cfg.get('med_confidence_max_precision_min', 10)
    conf = (snap.trend_summary_confidence or '').lower()
    summary = snap.trend_summary or ''

    # Check beginInMin precision vs confidence
    if snap.trend_begin_in_min is not None:
        begin = snap.trend_begin_in_min
        if conf == 'low' and begin < low_max:
            violations.append({
                'type': 'precip_start_too_precise',
                'detail': f'beginInMin={begin} but confidence={conf}',
                'snapshot_time': str(snap.snapshot_time),
                'suggestion': f'Round to >{low_max} min or suppress at low confidence',
            })
        elif conf == 'med' and begin < med_max:
            violations.append({
                'type': 'precip_start_too_precise',
                'detail': f'beginInMin={begin} but confidence={conf}',
                'snapshot_time': str(snap.snapshot_time),
                'suggestion': f'Round to >{med_max} min at medium confidence',
            })

    # Check endInMin precision vs confidence
    if snap.trend_end_in_min is not None:
        end_min = snap.trend_end_in_min
        if conf == 'low' and end_min < low_max:
            violations.append({
                'type': 'precip_end_too_precise',
                'detail': f'endInMin={end_min} but confidence={conf}',
                'snapshot_time': str(snap.snapshot_time),
                'suggestion': f'Round to >{low_max} min or use vague wording',
            })

    # Check summary text for precise language at low confidence
    if conf == 'low' and _has_precise_timing(summary):
        violations.append({
            'type': 'summary_too_precise',
            'detail': f'"{summary}" at confidence={conf}',
            'snapshot_time': str(snap.snapshot_time),
            'suggestion': 'Use "Rain possible soon" instead of exact timing',
        })

    # Lightning state precision vs confidence
    if snap.lightning_state in ('nearby', 'active'):
        if snap.lightning_confidence in ('low', 'none'):
            violations.append({
                'type': 'lightning_state_too_precise',
                'detail': f'state={snap.lightning_state} but confidence={snap.lightning_confidence}',
                'snapshot_time': str(snap.snapshot_time),
                'suggestion': 'Downgrade to "possible thunder" or suppress',
            })

    return violations


# ── Lightning scoring ────────────────────────────────────────────────────────

def score_lightning_state(
    snap: NowcastSnapshot,
    obs_window: pd.DataFrame,
    all_nowcasts: list,
) -> dict:
    """Score lightning state against observed thunder."""
    obs_at_time = _obs_nearest(obs_window, snap.snapshot_time)
    if obs_at_time is None:
        return None

    obs_thunder = obs_at_time.get('has_thunder', False)

    result = {
        'snapshot_time': str(snap.snapshot_time),
        'lightning_state': snap.lightning_state,
        'obs_thunder': obs_thunder,
    }

    # For "approaching" state, check if thunder followed within 30 min
    if snap.lightning_state == 'approaching':
        snap_ts = pd.Timestamp(snap.snapshot_time)
        if snap_ts.tz is None:
            snap_ts = snap_ts.tz_localize('UTC')
        else:
            snap_ts = snap_ts.tz_convert('UTC')
        future_obs = obs_window[
            obs_window['time_utc'] > snap_ts
        ]
        snap_ts_30 = snap_ts + pd.Timedelta(minutes=30)
        future_obs = future_obs[
            future_obs['time_utc'] <= snap_ts_30
        ]
        thunder_followed = future_obs['has_thunder'].any() if not future_obs.empty else False
        result['thunder_followed'] = bool(thunder_followed)

    return result


# ── Icon matching ────────────────────────────────────────────────────────────

# Map icon names to condition categories for comparison
_ICON_TO_CATEGORY = {
    'clear-day': 'clear', 'clear-night': 'clear',
    'partly-cloudy-day': 'partly_cloudy', 'partly-cloudy-night': 'partly_cloudy',
    'overcast-day': 'overcast', 'overcast-night': 'overcast',
    'fog-day': 'fog', 'fog-night': 'fog',
    'drizzle': 'drizzle',
    'rain': 'rain',
    'snow': 'snow',
    'sleet': 'freezing_precip',
    'hail': 'thunderstorm',
    'thunderstorms-day-rain': 'thunderstorm',
    'thunderstorms-night-rain': 'thunderstorm',
    'mist': 'fog',
    'not-available': 'clear',
}

# Categories that are "close enough" for icon matching
_ICON_CLOSE = {
    frozenset({'clear', 'partly_cloudy'}),
    frozenset({'rain', 'drizzle'}),
    frozenset({'rain', 'heavy_rain'}),
    frozenset({'snow', 'heavy_snow'}),
}


def _icon_matches_category(icon: str, obs_category: str) -> float:
    """Return 1.0 for match, 0.5 for close, 0.0 for mismatch."""
    icon_cat = _ICON_TO_CATEGORY.get(icon, 'clear')
    if icon_cat == obs_category:
        return 1.0
    if frozenset({icon_cat, obs_category}) in _ICON_CLOSE:
        return 0.5
    return 0.0


# ── Helpers ──────────────────────────────────────────────────────────────────

def build_nowcast_obs_window(
    snap: NowcastSnapshot,
    observations: pd.DataFrame,
    window_min: int = 90,
) -> pd.DataFrame:
    """
    Extract the observation window around a nowcast snapshot.
    Includes observations from 30 min before to window_min after.
    """
    if observations.empty:
        return pd.DataFrame()

    snap_ts = pd.Timestamp(snap.snapshot_time)
    if snap_ts.tz is None:
        snap_ts = snap_ts.tz_localize('UTC')
    else:
        snap_ts = snap_ts.tz_convert('UTC')
    start = snap_ts - timedelta(minutes=30)
    end = snap_ts + timedelta(minutes=window_min)

    mask = (observations['time_utc'] >= start) & (observations['time_utc'] <= end)
    return observations[mask].copy()


def _obs_nearest(obs_window: pd.DataFrame, target_time) -> dict:
    """Get the observation row nearest to the target time."""
    if obs_window.empty:
        return None

    target_ts = pd.Timestamp(target_time)
    if target_ts.tz is None:
        target_ts = target_ts.tz_localize('UTC')
    else:
        target_ts = target_ts.tz_convert('UTC')
    diffs = (obs_window['time_utc'] - target_ts).abs()
    min_idx = diffs.idxmin()
    row = obs_window.loc[min_idx]
    return row.to_dict()
