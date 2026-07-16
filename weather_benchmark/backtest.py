"""
Nowcast Backtest Pipeline

Loads JSONL logs from the app's nowcast logger, fetches IEM ASOS observations
for ground truth, scores each snapshot, generates lead-target truth labels
for ML training, and exports weekly report JSON for the viewer.

Usage:
    python backtest.py                      # Last 7 days, all cities
    python backtest.py --days 14            # Last 14 days
    python backtest.py --city "Arden, NC"   # Single city
    python backtest.py --export-ml          # Also export ML feature CSV
"""

import argparse
import json
import logging
import os
import sys
import math
from datetime import date, timedelta, datetime, timezone
from pathlib import Path

import pandas as pd

# Add src/ to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from src.ingest import load_jsonl_logs, LogRecord
from src.observations import fetch_observations
from src.mesonet_observations import (
    fetch_mesonet_observations,
    is_enabled as mesonet_enabled,
)
from src.mrms_observations import (
    fetch_mrms_observations,
    resolve_wgrib2,
)
from src.nowcast_scoring import (
    score_wording, score_presence_intensity, score_lightning_state,
    build_nowcast_obs_window, score_precip_timing_nowcast,
    detect_precision_violations, NowcastMetrics,
)
from src.lead_targets import label_lead_targets, label_current_truth, LEAD_MINUTES
from src.utils import metar_wx_to_category

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)-5s %(name)s: %(message)s',
    datefmt='%H:%M:%S',
)
logger = logging.getLogger('backtest')

# ── Config loading ──────────────────────────────────────────────────────────

def load_config(config_path: str) -> dict:
    """Load YAML config. Falls back to defaults if missing."""
    try:
        import yaml
        with open(config_path, 'r') as f:
            return yaml.safe_load(f)
    except ImportError:
        logger.warning('PyYAML not installed — using defaults. pip install pyyaml')
        return _default_config()
    except FileNotFoundError:
        logger.warning(f'Config not found: {config_path} — using defaults')
        return _default_config()


def _default_config():
    return {
        'locations': [
            {'name': 'Arden, NC', 'lat': 35.47, 'lon': -82.53, 'station': 'KAVL'},
        ],
        'backtest': {
            'lookback_days': 7,
            'log_dir': './data/logs',
            'obs_cache_dir': './data/observations',
            'report_dir': './reports',
            'ml_output_dir': './data/ml',
        },
        'nowcast_scoring': {
            'precip_timing_window_min': 60,
            'precision_violation_thresholds': {
                'low_confidence_max_precision_min': 15,
                'med_confidence_max_precision_min': 10,
            },
        },
    }


# ── Per-city backtest ───────────────────────────────────────────────────────

def backtest_city(
    city: dict,
    log_records: list,
    observations: pd.DataFrame,
    config: dict,
    mesonet_obs: pd.DataFrame = None,
    mrms_obs: pd.DataFrame = None,
) -> dict:
    """
    Run backtest for a single city.

    Returns a dict with:
      - city metadata
      - per-snapshot scored results
      - aggregate metrics
      - lead-target labels (for ML)
    """
    nc_cfg = config.get('nowcast_scoring', {})
    precision_cfg = nc_cfg.get('precision_violation_thresholds', {})

    snapshots = []
    wording_results = []
    pi_results = []
    lightning_results = []
    start_errors, end_errors, duration_errors = [], [], []
    violations = []
    icon_results = []
    ml_rows = []

    for rec in log_records:
        snap = rec.to_nowcast_snapshot()
        obs_window = build_nowcast_obs_window(snap, observations, window_min=90)

        scored = {
            'timestamp': rec.timestamp.isoformat(),
            'location': city['name'],
            'displayed_condition': rec.displayed_condition,
            'displayed_icon': rec.displayed_icon,
            'precip_phenomenon': rec.precip_phenomenon,
            'lightning_state': rec.lightning_state,
            'radar_dbz': rec.radar_dbz,
            'radar_rain_state': rec.radar_rain_state,
            'trend_summary': rec.trend_summary,
            'trend_confidence': rec.trend_summary_confidence,
        }

        # Current-state truth: MRMS > mesonet > ASOS precedence
        current_truth = label_current_truth(rec, observations,
                                            mesonet_obs=mesonet_obs,
                                            mrms_obs=mrms_obs)
        scored.update(current_truth)

        # Wording score
        if not obs_window.empty:
            wording = score_wording(snap, obs_window)
            scored['wording_category'] = wording['category']
            scored['wording_detail'] = wording['detail']
            scored['fcst_severity'] = wording.get('fcst_severity')
            scored['obs_severity'] = wording.get('obs_severity')
            wording_results.append(wording)

            # Two-axis scoring: presence + intensity
            pi = score_presence_intensity(snap, obs_window)
            scored['presence_category'] = pi['presence']
            scored['intensity_category'] = pi['intensity']
            pi_results.append(pi)

            # Precip timing
            se, ee, de = score_precip_timing_nowcast(snap, obs_window)
            if se is not None:
                start_errors.append(se)
                scored['precip_start_error_min'] = round(se, 1)
            if ee is not None:
                end_errors.append(ee)
                scored['precip_end_error_min'] = round(ee, 1)
            if de is not None:
                duration_errors.append(de)
                scored['duration_error_min'] = round(de, 1)

            # Lightning
            lr = score_lightning_state(snap, obs_window, [snap])
            if lr is not None:
                lightning_results.append(lr)
                scored['lightning_obs_thunder'] = lr['obs_thunder']

            # Precision violations
            pvs = detect_precision_violations(snap, precision_cfg)
            if pvs:
                violations.extend(pvs)
                scored['precision_violations'] = len(pvs)

            # Icon agreement
            from src.nowcast_scoring import _obs_nearest, _icon_matches_category
            obs_at_time = _obs_nearest(obs_window, snap.snapshot_time)
            if obs_at_time is not None and snap.displayed_icon:
                obs_cat = obs_at_time.get('condition_category', 'clear')
                icon_score = _icon_matches_category(snap.displayed_icon, obs_cat)
                icon_results.append(icon_score)
                scored['icon_agreement'] = icon_score
                scored['obs_condition_category'] = obs_cat
        else:
            scored['wording_category'] = None
            scored['wording_detail'] = 'no observations'

        # Lead-target truth labels (MRMS > mesonet > ASOS precedence)
        lead_labels = label_lead_targets(rec, observations,
                                         mesonet_obs=mesonet_obs,
                                         mrms_obs=mrms_obs)
        scored.update(lead_labels)

        snapshots.append(scored)

        # ML feature row
        ml_rows.append(_build_ml_row(rec, current_truth, lead_labels, scored))

    # Aggregate metrics
    agg = _aggregate_metrics(
        wording_results, pi_results, lightning_results,
        start_errors, end_errors, duration_errors,
        icon_results, violations, len(log_records),
        snapshots=snapshots,
    )

    return {
        'city': city,
        'period': {
            'start': log_records[0].timestamp.isoformat() if log_records else None,
            'end': log_records[-1].timestamp.isoformat() if log_records else None,
            'n_snapshots': len(log_records),
        },
        'snapshots': snapshots,
        'metrics': agg,
        'ml_rows': ml_rows,
    }


def _aggregate_metrics(
    wording_results, pi_results, lightning_results,
    start_errors, end_errors, duration_errors,
    icon_results, violations, n_total,
    snapshots=None,
) -> dict:
    """Compute aggregate metrics from per-snapshot results."""
    import numpy as np

    metrics = {'n_scored': len(wording_results), 'n_total': n_total}

    # Wording (legacy single-axis)
    if wording_results:
        cats = [w['category'] for w in wording_results]
        total = len(cats)
        metrics['wording_correct_pct'] = round(cats.count('correct') / total * 100, 1)
        metrics['wording_overstated_pct'] = round(cats.count('overstated') / total * 100, 1)
        metrics['wording_understated_pct'] = round(cats.count('understated') / total * 100, 1)
        metrics['wording_imprecise_pct'] = round(cats.count('imprecise') / total * 100, 1)

    # Two-axis: presence + intensity
    def _pct(lst, val):
        return round(lst.count(val) / len(lst) * 100, 1) if lst else None

    if pi_results:
        presence = [r['presence'] for r in pi_results if r.get('presence')]
        intensity = [r['intensity'] for r in pi_results if r.get('intensity')]
        if presence:
            metrics['presence_correct_pct']    = _pct(presence, 'correct')
            metrics['presence_false_alarm_pct'] = _pct(presence, 'false_alarm')
            metrics['presence_miss_pct']        = _pct(presence, 'miss')
        if intensity:
            metrics['intensity_n']               = len(intensity)
            metrics['intensity_correct_pct']     = _pct(intensity, 'correct')
            metrics['intensity_overstated_pct']  = _pct(intensity, 'overstated')
            metrics['intensity_understated_pct'] = _pct(intensity, 'understated')

    # Precip timing
    if start_errors:
        metrics['precip_start_mae_min'] = round(float(np.mean(np.abs(start_errors))), 1)
    if end_errors:
        metrics['precip_end_mae_min'] = round(float(np.mean(np.abs(end_errors))), 1)
    if duration_errors:
        metrics['duration_mae_min'] = round(float(np.mean(np.abs(duration_errors))), 1)

    # Lightning
    if lightning_results:
        thunder_obs = [r for r in lightning_results if r['obs_thunder']]
        thunder_fcst = [r for r in lightning_results
                        if r['lightning_state'] in ('active', 'nearby')]
        if thunder_obs:
            hits = sum(1 for r in thunder_obs
                       if r['lightning_state'] in ('active', 'nearby'))
            metrics['lightning_pod'] = round(hits / len(thunder_obs) * 100, 1)
        if thunder_fcst:
            fa = sum(1 for r in thunder_fcst if not r['obs_thunder'])
            metrics['lightning_far'] = round(fa / len(thunder_fcst) * 100, 1)

    # Icon agreement
    if icon_results:
        metrics['icon_agreement_pct'] = round(float(np.mean(icon_results)) * 100, 1)

    # Violations
    metrics['precision_violations'] = len(violations)

    # Binary rain accuracy — "hallucination" and "miss" rates
    if snapshots:
        rain_snaps = [s for s in snapshots if s.get('obs_precip_active') is not None]
        if rain_snaps:
            fcst_rain = [s.get('precip_phenomenon') not in ('dry', '', None) for s in rain_snaps]
            obs_rain  = [s['obs_precip_active'] for s in rain_snaps]
            fa   = sum(1 for f, o in zip(fcst_rain, obs_rain) if f and not o)
            miss = sum(1 for f, o in zip(fcst_rain, obs_rain) if not f and o)
            metrics['rain_false_alarm_pct'] = round(fa   / len(rain_snaps) * 100, 1)
            metrics['rain_miss_pct']        = round(miss / len(rain_snaps) * 100, 1)

        ts_snaps = [s for s in snapshots
                    if s.get('lightning_obs_thunder') is not None
                    and s.get('lightning_state') is not None]
        if ts_snaps:
            fcst_ts = [s['lightning_state'] in ('active', 'nearby') for s in ts_snaps]
            obs_ts  = [s['lightning_obs_thunder'] for s in ts_snaps]
            tfa = sum(1 for f, o in zip(fcst_ts, obs_ts) if f and not o)
            metrics['thunder_false_alarm_pct'] = round(tfa / len(ts_snaps) * 100, 1)

        # Radar signal stats
        n_with_dbz = sum(1 for s in snapshots if s.get('radar_dbz') is not None)
        metrics['radar_coverage_pct'] = round(n_with_dbz / n_total * 100, 1) if n_total else 0

        n_radar_active = sum(
            1 for s in snapshots
            if s.get('radar_rain_state') not in (None, 'OFF')
            or (s.get('radar_dbz') is not None and s['radar_dbz'] > 5)
        )
        metrics['radar_active_pct'] = round(n_radar_active / n_total * 100, 1) if n_total else 0

        # Agreement: radar rain signal vs observed precip (only where radar data exists)
        radar_obs_snaps = [
            s for s in snapshots
            if s.get('obs_precip_active') is not None
            and (s.get('radar_dbz') is not None or s.get('radar_rain_state') is not None)
        ]
        if radar_obs_snaps:
            radar_says_rain = [
                s.get('radar_rain_state') not in (None, 'OFF')
                or (s.get('radar_dbz') is not None and s['radar_dbz'] > 5)
                for s in radar_obs_snaps
            ]
            obs_says_rain = [s['obs_precip_active'] for s in radar_obs_snaps]
            agree = sum(1 for r, o in zip(radar_says_rain, obs_says_rain) if r == o)
            metrics['radar_obs_agreement_pct'] = round(agree / len(radar_obs_snaps) * 100, 1)

    return metrics


def _build_ml_row(rec: LogRecord, current_truth: dict, lead_labels: dict, scored: dict) -> dict:
    """Build one row of the ML feature CSV."""
    row = {
        'timestamp': rec.timestamp.isoformat(),
        'lat': rec.lat,
        'lon': rec.lon,
        'station': rec.station,
        'location': scored.get('location', rec.station),

        # Features: precip state
        'precip_phenomenon': rec.precip_phenomenon,
        'precip_confidence': rec.precip_confidence,
        'precip_source': rec.precip_source,

        # Features: radar
        'radar_dbz': rec.radar_dbz,
        'radar_rain_state': rec.radar_rain_state,
        'radar_motion_speed': rec.radar_motion_speed,
        'radar_motion_dir': rec.radar_motion_dir,

        # Features: lightning
        'lightning_state': rec.lightning_state,
        'lightning_nearest_mi': rec.lightning_nearest_mi,
        'lightning_flashes_10mi': rec.lightning_flash_counts.get('within10mi', 0),
        'lightning_flashes_20mi': rec.lightning_flash_counts.get('within20mi', 0),
        'lightning_flashes_40mi': rec.lightning_flash_counts.get('within40mi', 0),
        'lightning_trend': rec.lightning_trend,
        'lightning_confidence': rec.lightning_confidence,

        # Features: trend
        'trend_summary_confidence': rec.trend_summary_confidence,
        'trend_begin_in_min': rec.trend_begin_in_min,
        'trend_end_in_min': rec.trend_end_in_min,

        # Features: model context
        'model_weather_code': rec.model_weather_code,
        'model_precip_prob': rec.model_precip_prob,
        'model_cloud_cover': rec.model_cloud_cover,
        'model_temp': rec.model_temp,
        'model_dewpoint': rec.model_dewpoint,
        'model_humidity': rec.model_humidity,
        'model_wind_speed': rec.model_wind_speed,
        'model_wind_dir': rec.model_wind_dir,
        'model_pressure': rec.model_pressure,

        # Current-state truth
        'obs_precip_active': current_truth.get('obs_precip_active'),
        'obs_thunder': current_truth.get('obs_thunder'),
        'obs_condition': current_truth.get('obs_condition'),

        # Wording score
        'wording_category': scored.get('wording_category'),
        'wording_correct': scored.get('wording_category') == 'correct',
    }

    # Lead-target truth labels
    row.update(lead_labels)

    return row


# ── ML CSV export ───────────────────────────────────────────────────────────

def export_ml_csv(all_ml_rows: list, output_dir: str):
    """Export ML feature rows to CSV."""
    if not all_ml_rows:
        logger.warning('No ML rows to export')
        return

    os.makedirs(output_dir, exist_ok=True)
    path = os.path.join(output_dir, 'features.csv')

    df = pd.DataFrame(all_ml_rows)
    df.to_csv(path, index=False)
    logger.info(f'Exported {len(df)} ML feature rows -> {path}')
    return path


# ── Report generation ───────────────────────────────────────────────────────

def generate_report(city_results: list, output_dir: str, date_range: tuple) -> str:
    """Generate weekly report JSON for the viewer."""
    os.makedirs(output_dir, exist_ok=True)

    start_str = date_range[0].isoformat()
    end_str = date_range[1].isoformat()

    report = {
        'generated': datetime.now(timezone.utc).isoformat(),
        'period': {'start': start_str, 'end': end_str},
        'cities': [],
    }

    for result in city_results:
        city_report = {
            'city': result['city'],
            'period': result['period'],
            'metrics': result['metrics'],
            'snapshots': result['snapshots'],
        }
        report['cities'].append(city_report)

    fname = f'weekly_{start_str}_{end_str}.json'
    path = os.path.join(output_dir, fname)

    class _Encoder(json.JSONEncoder):
        def default(self, o):
            if isinstance(o, (datetime, date)):
                return o.isoformat()
            if isinstance(o, float) and math.isnan(o):
                return None
            return super().default(o)

    with open(path, 'w', encoding='utf-8') as f:
        json.dump(report, f, indent=2, cls=_Encoder)

    logger.info(f'Report -> {path}')
    return path


# ── Main pipeline ───────────────────────────────────────────────────────────

def run_backtest(config: dict, args) -> list:
    """Run the full backtest pipeline."""
    bt_cfg = config.get('backtest', config)
    log_dir = bt_cfg.get('log_dir', './data/logs')
    obs_cache_dir = bt_cfg.get('obs_cache_dir', config.get('observation_dir', './data/observations'))
    report_dir = bt_cfg.get('report_dir', config.get('report_dir', './reports'))
    ml_dir = bt_cfg.get('ml_output_dir', './data/ml')
    mesonet_cache_dir = bt_cfg.get('mesonet_cache_dir', './data/obs_cache/mesonet')
    mrms_cache_dir = bt_cfg.get('mrms_cache_dir', './data/obs_cache/mrms')

    # Mesonet config: opt-in via --mesonet CLI flag OR config.mesonet.enabled.
    # Auto-disable if SYNOPTIC_TOKEN missing, regardless of flag.
    mesonet_cfg = config.get('mesonet', {})
    cli_mesonet = hasattr(args, 'mesonet') and args.mesonet
    use_mesonet = (cli_mesonet or mesonet_cfg.get('enabled', False)) and mesonet_enabled()
    mesonet_radius_km = mesonet_cfg.get('radius_km', 30)
    mesonet_min_stations = mesonet_cfg.get('min_stations', 3)
    if cli_mesonet and not mesonet_enabled():
        logger.warning('--mesonet requested but SYNOPTIC_TOKEN not set; falling back to ASOS only')

    # MRMS config: opt-in via --mrms CLI flag OR config.mrms.enabled.
    # Auto-disable if wgrib2 binary not found.
    mrms_cfg = config.get('mrms', {})
    cli_mrms = hasattr(args, 'mrms') and args.mrms
    mrms_wgrib2_path = mrms_cfg.get('wgrib2_path')   # None → auto-resolve
    mrms_resolved = resolve_wgrib2(mrms_wgrib2_path)
    use_mrms = (cli_mrms or mrms_cfg.get('enabled', False)) and mrms_resolved is not None
    mrms_fetch_cadence_min = mrms_cfg.get('fetch_cadence_min', 10)
    if cli_mrms and mrms_resolved is None:
        logger.warning('--mrms requested but wgrib2 binary not found; install it or set '
                       'mrms.wgrib2_path in config.yaml; falling back to ASOS/mesonet only')
    elif use_mrms:
        logger.info('MRMS enabled (wgrib2=%s, cadence=%dmin)',
                    mrms_resolved, mrms_fetch_cadence_min)

    # Resolve paths relative to config file location
    base = Path(__file__).parent
    log_dir = str(base / log_dir)
    obs_cache_dir = str(base / obs_cache_dir)
    report_dir = str(base / report_dir)
    ml_dir = str(base / ml_dir)
    mesonet_cache_dir = str(base / mesonet_cache_dir)
    mrms_cache_dir = str(base / mrms_cache_dir)

    # Date range
    if hasattr(args, 'start_date') and args.start_date:
        start_date = date.fromisoformat(args.start_date)
        end_date = date.fromisoformat(args.end_date) if (hasattr(args, 'end_date') and args.end_date) else start_date
        days = (end_date - start_date).days + 1
    else:
        days = args.days if hasattr(args, 'days') and args.days else bt_cfg.get('lookback_days', 7)
        end_date = date.today()
        start_date = end_date - timedelta(days=days)
    date_range = (start_date, end_date)

    logger.info(f'Backtest period: {start_date} -> {end_date} ({days} days)')

    # Load cities: prefer cities.json (GUI-managed), fall back to config.yaml
    cities_json = Path(__file__).parent / 'data' / 'cities.json'
    if cities_json.is_file():
        with open(cities_json, 'r', encoding='utf-8') as f:
            cities = json.load(f)
        logger.info(f'Loaded {len(cities)} cities from cities.json')
    else:
        cities = config.get('locations', [])
    if hasattr(args, 'city') and args.city:
        city_lower = args.city.lower()
        cities = [c for c in cities if city_lower in c['name'].lower()]
        if not cities:
            logger.error(f'No city matching "{args.city}" in config')
            return []

    # Load all logs
    all_logs = load_jsonl_logs(log_dir, date_range=date_range)
    if not all_logs:
        logger.warning('No log records found. Is the app logging to server.py?')
        return []

    logger.info(f'Loaded {len(all_logs)} total log records')

    # Auto-detect cities from logs if none of the configured cities match
    if all_logs and not any(_filter_logs_for_city(all_logs, c) for c in cities):
        detected = _extract_cities_from_logs(all_logs)
        if detected:
            # Sanity-check: if every detected city ended up with the same name, the
            # app was sending a wrong/default locationName for all locations (a known
            # bug where background-tab fetches inherit the active city's name).
            # In that case, skip the auto-save so we don't overwrite good data in
            # cities.json with a list of identically-named duplicates.
            unique_names = {c['name'] for c in detected}
            if len(unique_names) == 1 and len(detected) > 1:
                logger.warning(
                    f'Auto-detect found {len(detected)} stations but all share the '
                    f'name "{next(iter(unique_names))}". This usually means the app '
                    f'was logging all cities under the active city\'s name. '
                    f'Skipping auto-save to protect cities.json.'
                )
            else:
                logger.info(
                    f'No configured cities matched logs — auto-detected '
                    f'{len(detected)} location(s): {[c["name"] for c in detected]}'
                )
                cities = detected
                _save_cities_json(cities, base / 'data' / 'cities.json')

    city_results = []
    all_ml_rows = []

    for city in cities:
        station = city.get('station', '')
        city_name = city['name']
        logger.info(f'\n{"="*60}\nProcessing: {city_name} (station={station})\n{"="*60}')

        # Filter logs for this city (by location name or coordinates)
        city_logs = _filter_logs_for_city(all_logs, city)
        if not city_logs:
            logger.warning(f'No logs for {city_name}')
            continue

        logger.info(f'Found {len(city_logs)} logs for {city_name}')

        # Fetch observations — pass coordinates so fetch_observations can fall
        # back to a nearby IEM ASOS station when the logged station is not in IEM.
        lat = city.get('lat')
        lon = city.get('lon')
        # stateCode comes from cities.json or is inferred from log records
        state_code = city.get('stateCode') or city.get('state_code')
        if not state_code and city_logs:
            state_code = next((r.state_code for r in city_logs if r.state_code), None)

        if station:
            observations, obs_station, obs_dist_km = fetch_observations(
                station, start_date, end_date, obs_cache_dir,
                lat=lat, lon=lon, state_code=state_code,
            )
            if obs_station != station:
                logger.info(
                    f'Fetched {len(observations)} hourly obs via fallback '
                    f'{obs_station} ({obs_dist_km:.1f} km from {city_name})'
                )
            else:
                logger.info(f'Fetched {len(observations)} hourly obs for {obs_station}')
        else:
            observations, obs_station, obs_dist_km = pd.DataFrame(), '', 0.0
            logger.warning(f'No station for {city_name} — scoring will be limited')

        # Optional: mesonet truth (Synoptic API). Empty DataFrame if disabled
        # or if the token is unavailable; lead_targets will fall back to ASOS.
        mesonet_df = pd.DataFrame()
        if use_mesonet and lat is not None and lon is not None:
            try:
                mesonet_df = fetch_mesonet_observations(
                    lat, lon, start_date, end_date, mesonet_cache_dir,
                    radius_km=mesonet_radius_km,
                    min_stations=mesonet_min_stations,
                    city_slug=city_name.lower().replace(' ', '_'),
                )
                if not mesonet_df.empty:
                    logger.info(f'Fetched {len(mesonet_df)} mesonet bucket(s) within '
                                f'{mesonet_radius_km} km of {city_name}')
                else:
                    logger.info(f'No mesonet data near {city_name} — ASOS only')
            except Exception as e:
                logger.warning(f'Mesonet fetch failed for {city_name}: {e}')

        # Optional: MRMS truth (wgrib2 + NCEP NOMADS / Iowa State archive).
        mrms_df = pd.DataFrame()
        if use_mrms and lat is not None and lon is not None:
            try:
                mrms_df = fetch_mrms_observations(
                    lat, lon, start_date, end_date, mrms_cache_dir,
                    wgrib2_path=mrms_resolved,
                    fetch_cadence_min=mrms_fetch_cadence_min,
                    city_slug=city_name.lower().replace(' ', '_'),
                )
                if not mrms_df.empty:
                    logger.info(f'Fetched {len(mrms_df)} MRMS sample(s) for {city_name}')
                else:
                    logger.info(f'No MRMS data for {city_name} window — falling back')
            except Exception as e:
                logger.warning(f'MRMS fetch failed for {city_name}: {e}')

        # Run backtest
        result = backtest_city(
            city, city_logs, observations, config,
            mesonet_obs=mesonet_df if not mesonet_df.empty else None,
            mrms_obs=mrms_df if not mrms_df.empty else None,
        )
        result['period']['obs_station'] = obs_station
        result['period']['obs_station_dist_km'] = round(obs_dist_km, 1)
        result['period']['obs_is_fallback'] = obs_station != station
        result['period']['mesonet_enabled'] = bool(use_mesonet and not mesonet_df.empty)
        result['period']['mesonet_buckets'] = int(len(mesonet_df))
        result['period']['mrms_enabled'] = bool(use_mrms and not mrms_df.empty)
        result['period']['mrms_samples'] = int(len(mrms_df))
        city_results.append(result)
        all_ml_rows.extend(result['ml_rows'])

        # Log summary
        m = result['metrics']
        logger.info(f'{city_name}: {m.get("n_scored", 0)}/{m.get("n_total", 0)} scored')
        if 'wording_correct_pct' in m:
            logger.info(f'  Wording: {m["wording_correct_pct"]}% correct, '
                        f'{m.get("wording_overstated_pct", 0)}% overstated, '
                        f'{m.get("wording_understated_pct", 0)}% understated')

    # Generate report
    if city_results:
        report_path = generate_report(city_results, report_dir, date_range)
        logger.info(f'\nReport saved: {report_path}')

    # Export ML CSV
    if (hasattr(args, 'export_ml') and args.export_ml) and all_ml_rows:
        ml_path = export_ml_csv(all_ml_rows, ml_dir)
        logger.info(f'ML features: {ml_path}')

    return city_results


def _extract_cities_from_logs(logs: list) -> list:
    """
    Derive unique city entries from JSONL log records.
    Deduplicates by station code; takes the most common location name per station.
    """
    from collections import Counter, defaultdict
    by_station = defaultdict(list)
    for rec in logs:
        if rec.station:
            by_station[rec.station].append(rec)

    cities = []
    for station, recs in by_station.items():
        name_counts = Counter(rec.location_name for rec in recs if rec.location_name)
        name = name_counts.most_common(1)[0][0] if name_counts else station
        # Average coordinates (they're constant per location, but average for safety)
        lat = sum(r.lat for r in recs) / len(recs)
        lon = sum(r.lon for r in recs) / len(recs)
        # Most common stateCode across records (present after nowcastLogger.js fix)
        sc_counts = Counter(r.state_code for r in recs if r.state_code)
        state_code = sc_counts.most_common(1)[0][0] if sc_counts else None
        entry = {'name': name, 'lat': round(lat, 5), 'lon': round(lon, 5), 'station': station}
        if state_code:
            entry['stateCode'] = state_code
        cities.append(entry)

    return sorted(cities, key=lambda c: c['name'])


def _save_cities_json(cities: list, path):
    """Persist cities list to data/cities.json."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(cities, f, indent=2)
    logger.info(f'Saved {len(cities)} cities -> {path}')


def _filter_logs_for_city(logs: list, city: dict) -> list:
    """Filter log records that belong to a specific city.

    Matching priority (stops at first tier that yields results):
      1. Station code — most reliable; immune to name collisions across cities.
      2. Location name substring — for records logged before station was set.
      3. Coordinate proximity (within ~0.5 degrees) — last resort.
    """
    station = city.get('station', '').upper()
    city_name = city['name'].lower()
    lat, lon = city['lat'], city['lon']

    # Tier 1: exact station match
    if station:
        matched = [rec for rec in logs if rec.station and rec.station.upper() == station]
        if matched:
            return matched

    # Tier 2: location name substring
    matched = [rec for rec in logs if city_name in rec.location_name.lower()]
    if matched:
        return matched

    # Tier 3: coordinate proximity
    return [rec for rec in logs
            if abs(rec.lat - lat) < 0.5 and abs(rec.lon - lon) < 0.5]


# ── CLI ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Nowcast Backtest Pipeline')
    parser.add_argument('--days', type=int, default=None,
                        help='Number of days to look back (default: from config)')
    parser.add_argument('--city', type=str, default=None,
                        help='Filter to a single city name')
    parser.add_argument('--start-date', type=str, default=None,
                        help='Start date YYYY-MM-DD (overrides --days)')
    parser.add_argument('--end-date', type=str, default=None,
                        help='End date YYYY-MM-DD (overrides --days)')
    parser.add_argument('--export-ml', action='store_true',
                        help='Export ML feature CSV')
    parser.add_argument('--mesonet', action='store_true',
                        help='Augment ASOS truth with nearby state-mesonet observations '
                             'via the Synoptic Data API (requires SYNOPTIC_TOKEN env var)')
    parser.add_argument('--mrms', action='store_true',
                        help='Augment ASOS truth with MRMS quantitative precipitation '
                             '(NCEP NOMADS + Iowa State archive; requires wgrib2 on PATH '
                             'or mrms.wgrib2_path set in config.yaml)')
    parser.add_argument('--config', type=str,
                        default=str(Path(__file__).parent / 'config.yaml'),
                        help='Path to config.yaml')
    args = parser.parse_args()

    config = load_config(args.config)
    results = run_backtest(config, args)

    if not results:
        logger.warning('No results produced. Check that logs exist and cities match.')
        sys.exit(1)

    # Print summary
    print('\n' + '=' * 60)
    print('BACKTEST SUMMARY')
    print('=' * 60)
    for r in results:
        city = r['city']['name']
        m = r['metrics']
        n = m.get('n_scored', 0)
        print(f'\n{city}: {n} snapshots scored')
        if 'wording_correct_pct' in m:
            print(f'  Wording:  {m["wording_correct_pct"]}% correct | '
                  f'{m.get("wording_overstated_pct", 0)}% over | '
                  f'{m.get("wording_understated_pct", 0)}% under')
        if 'precip_start_mae_min' in m:
            print(f'  Precip timing: start MAE={m["precip_start_mae_min"]} min')
        if 'lightning_pod' in m:
            print(f'  Lightning: POD={m["lightning_pod"]}% | FAR={m.get("lightning_far", "N/A")}%')
        if 'icon_agreement_pct' in m:
            print(f'  Icon agreement: {m["icon_agreement_pct"]}%')
    print()


if __name__ == '__main__':
    main()
