"""
Forecast and nowcast snapshot ingestion.

Reads JSON/CSV files that capture the app's Open-Meteo forecast output and
the nowcast state from getNowSummary().

Supports three input formats:
  1. Forecast JSON — Open-Meteo API response with _meta envelope
  2. Nowcast JSON — getNowSummary() output with _meta envelope (legacy)
  3. JSONL logs — one record per line from collector.py (Phase 2)
"""

import json
import csv
import os
import logging
from dataclasses import dataclass, field
from datetime import datetime, date, timezone
from typing import Optional

logger = logging.getLogger(__name__)


# ── Dataclasses ──────────────────────────────────────────────────────────────

@dataclass
class ForecastSnapshot:
    """One forecast issued at a specific time."""
    issue_time: datetime
    location_name: str
    lat: float
    lon: float
    station: str

    # Hourly arrays (parallel, indexed by hourly_times)
    hourly_times: list           # datetime objects (UTC)
    hourly_temp: list            # temperature_2m (F)
    hourly_precip_prob: list     # precipitation_probability (%)
    hourly_precip: list          # precipitation (inches)
    hourly_snowfall: list        # snowfall (inches)
    hourly_weather_code: list    # WMO codes
    hourly_wind_speed: list      # wind_speed_10m (mph)
    hourly_wind_gusts: list      # wind_gusts_10m (mph)
    hourly_cloud_cover: list     # cloud_cover (%)

    # Daily arrays
    daily_times: list            # date objects
    daily_weather_code: list
    daily_temp_max: list
    daily_temp_min: list
    daily_precip_sum: list
    daily_precip_prob_max: list
    daily_wind_max: list
    daily_wind_gusts_max: list
    daily_snowfall_sum: list

    source_file: str = ''


@dataclass
class NowcastSnapshot:
    """One nowcast state captured at a specific moment."""
    snapshot_time: datetime
    location_name: str
    lat: float
    lon: float
    station: str

    # Precip state now
    precip_phenomenon: str       # dry, rain, heavy rain, drizzle, snow, thunderstorm
    precip_desc: str
    precip_source: str
    precip_confidence: float

    # Lightning state
    lightning_state: str         # none, active, nearby, approaching
    lightning_nearest_mi: Optional[float]
    lightning_flash_counts: dict  # {within10mi, within20mi, within40mi}
    lightning_source: str
    lightning_confidence: str
    lightning_trend: Optional[str]

    # Precip trend 60m
    trend_timeline: Optional[list]   # [{minute, precipClass, confidence}]
    trend_summary: Optional[str]
    trend_summary_confidence: Optional[str]   # high, med, low
    trend_begin_in_min: Optional[float]
    trend_end_in_min: Optional[float]

    # What the app actually displayed
    displayed_condition: str
    displayed_icon: str

    source_file: str = ''


@dataclass
class LogRecord:
    """One JSONL log record from collector.py — richer than NowcastSnapshot."""
    timestamp: datetime
    lat: float
    lon: float
    country: str
    state_code: Optional[str]
    station: Optional[str]
    location_name: str

    displayed_condition: str
    displayed_icon: str

    # Precip state
    precip_phenomenon: str
    precip_desc: str
    precip_source: str
    precip_confidence: float

    # Sky state
    sky_desc: Optional[str]
    sky_source: Optional[str]
    sky_confidence: Optional[float]

    # Lightning state
    lightning_state: str
    lightning_nearest_mi: Optional[float]
    lightning_flash_counts: dict
    lightning_trend: Optional[str]
    lightning_confidence: str
    lightning_source: str
    lightning_connected: Optional[bool]
    lightning_buffer_age_ms: Optional[float]

    # Precip trend
    trend_summary: Optional[str]
    trend_summary_confidence: Optional[str]
    trend_begin_in_min: Optional[float]
    trend_end_in_min: Optional[float]
    trend_timeline: Optional[list]

    # Radar
    radar_dbz: Optional[float]
    radar_rain_state: Optional[str]
    radar_source: Optional[str]
    radar_motion_speed: Optional[float]
    radar_motion_dir: Optional[float]
    radar_last_valid_dbz_time: Optional[str] = None

    # Model context (current hour)
    model_weather_code: Optional[int] = None
    model_precip_prob: Optional[float] = None
    model_cloud_cover: Optional[float] = None
    model_temp: Optional[float] = None
    model_dewpoint: Optional[float] = None
    model_humidity: Optional[float] = None
    model_wind_speed: Optional[float] = None
    model_wind_dir: Optional[float] = None
    model_pressure: Optional[float] = None

    # Model hourly forecast (next 12h)
    model_hourly: Optional[list] = None

    # Metadata
    schema_version: int = 1
    validation_flags: Optional[list] = None
    source_file: str = ''

    def to_nowcast_snapshot(self) -> NowcastSnapshot:
        """Convert to NowcastSnapshot for scoring compatibility."""
        return NowcastSnapshot(
            snapshot_time=self.timestamp,
            location_name=self.location_name,
            lat=self.lat,
            lon=self.lon,
            station=self.station or '',
            precip_phenomenon=self.precip_phenomenon,
            precip_desc=self.precip_desc,
            precip_source=self.precip_source,
            precip_confidence=self.precip_confidence,
            lightning_state=self.lightning_state,
            lightning_nearest_mi=self.lightning_nearest_mi,
            lightning_flash_counts=self.lightning_flash_counts,
            lightning_source=self.lightning_source,
            lightning_confidence=self.lightning_confidence,
            lightning_trend=self.lightning_trend,
            trend_timeline=self.trend_timeline,
            trend_summary=self.trend_summary,
            trend_summary_confidence=self.trend_summary_confidence,
            trend_begin_in_min=self.trend_begin_in_min,
            trend_end_in_min=self.trend_end_in_min,
            displayed_condition=self.displayed_condition,
            displayed_icon=self.displayed_icon,
            source_file=self.source_file,
        )


# ── Parsing helpers ──────────────────────────────────────────────────────────

def _parse_iso(s: str) -> datetime:
    """Parse an ISO timestamp string to a UTC datetime."""
    if not s:
        raise ValueError('Empty timestamp')
    # Handle both "2026-03-15T12:00:00Z" and "2026-03-15T12:00" formats
    s = s.replace('Z', '+00:00')
    if '+' not in s and len(s) <= 16:
        s += ':00+00:00'
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        # Try without timezone for Open-Meteo local times
        dt = datetime.fromisoformat(s.split('+')[0].split('-00:00')[0])
        dt = dt.replace(tzinfo=timezone.utc)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _parse_date(s: str) -> date:
    """Parse a date string like '2026-03-15'."""
    return date.fromisoformat(s)


def _safe_list(data: dict, key: str) -> list:
    """Get a list from a dict, returning [] if missing."""
    val = data.get(key)
    if val is None:
        return []
    return list(val)


# ── Forecast loading ─────────────────────────────────────────────────────────

def parse_forecast_json(path: str) -> ForecastSnapshot:
    """Parse a single forecast JSON file into a ForecastSnapshot."""
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    meta = data.get('_meta', {})
    hourly = data.get('hourly', {})
    daily = data.get('daily', {})

    # Parse hourly times
    hourly_times = []
    for t in _safe_list(hourly, 'time'):
        try:
            hourly_times.append(_parse_iso(t))
        except (ValueError, TypeError):
            hourly_times.append(None)

    # Parse daily times
    daily_times = []
    for t in _safe_list(daily, 'time'):
        try:
            daily_times.append(_parse_date(t))
        except (ValueError, TypeError):
            daily_times.append(None)

    return ForecastSnapshot(
        issue_time=_parse_iso(meta.get('issue_time', '')),
        location_name=meta.get('location_name', 'Unknown'),
        lat=float(meta.get('lat', 0)),
        lon=float(meta.get('lon', 0)),
        station=meta.get('station', ''),
        hourly_times=hourly_times,
        hourly_temp=_safe_list(hourly, 'temperature_2m'),
        hourly_precip_prob=_safe_list(hourly, 'precipitation_probability'),
        hourly_precip=_safe_list(hourly, 'precipitation'),
        hourly_snowfall=_safe_list(hourly, 'snowfall'),
        hourly_weather_code=_safe_list(hourly, 'weather_code'),
        hourly_wind_speed=_safe_list(hourly, 'wind_speed_10m'),
        hourly_wind_gusts=_safe_list(hourly, 'wind_gusts_10m'),
        hourly_cloud_cover=_safe_list(hourly, 'cloud_cover'),
        daily_times=daily_times,
        daily_weather_code=_safe_list(daily, 'weather_code'),
        daily_temp_max=_safe_list(daily, 'temperature_2m_max'),
        daily_temp_min=_safe_list(daily, 'temperature_2m_min'),
        daily_precip_sum=_safe_list(daily, 'precipitation_sum'),
        daily_precip_prob_max=_safe_list(daily, 'precipitation_probability_max'),
        daily_wind_max=_safe_list(daily, 'wind_speed_10m_max'),
        daily_wind_gusts_max=_safe_list(daily, 'wind_gusts_10m_max'),
        daily_snowfall_sum=_safe_list(daily, 'snowfall_sum'),
        source_file=path,
    )


def parse_forecast_csv(path: str) -> ForecastSnapshot:
    """
    Parse a flat CSV forecast file.

    Expected columns:
      issue_time, target_time, location, lat, lon, station,
      temp_f, precip_in, precip_prob, weather_code,
      wind_mph, wind_gust_mph, cloud_cover, snowfall
    """
    rows = []
    with open(path, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append(row)

    if not rows:
        raise ValueError(f'Empty CSV: {path}')

    first = rows[0]
    issue_time = _parse_iso(first.get('issue_time', ''))
    location = first.get('location', 'Unknown')
    lat = float(first.get('lat', 0))
    lon = float(first.get('lon', 0))
    station = first.get('station', '')

    hourly_times, temps, probs, precips, codes = [], [], [], [], []
    winds, gusts, clouds, snows = [], [], [], []

    for row in rows:
        try:
            hourly_times.append(_parse_iso(row['target_time']))
        except (ValueError, KeyError):
            continue
        temps.append(float(row.get('temp_f', 'nan') or 'nan'))
        probs.append(float(row.get('precip_prob', 'nan') or 'nan'))
        precips.append(float(row.get('precip_in', 'nan') or 'nan'))
        codes.append(int(row.get('weather_code', 0) or 0))
        winds.append(float(row.get('wind_mph', 'nan') or 'nan'))
        gusts.append(float(row.get('wind_gust_mph', 'nan') or 'nan'))
        clouds.append(float(row.get('cloud_cover', 'nan') or 'nan'))
        snows.append(float(row.get('snowfall', 'nan') or 'nan'))

    return ForecastSnapshot(
        issue_time=issue_time,
        location_name=location,
        lat=lat, lon=lon, station=station,
        hourly_times=hourly_times,
        hourly_temp=temps,
        hourly_precip_prob=probs,
        hourly_precip=precips,
        hourly_snowfall=snows,
        hourly_weather_code=codes,
        hourly_wind_speed=winds,
        hourly_wind_gusts=gusts,
        hourly_cloud_cover=clouds,
        daily_times=[], daily_weather_code=[], daily_temp_max=[],
        daily_temp_min=[], daily_precip_sum=[], daily_precip_prob_max=[],
        daily_wind_max=[], daily_wind_gusts_max=[], daily_snowfall_sum=[],
        source_file=path,
    )


def load_forecasts(
    forecast_dir: str,
    date_range: tuple = None,
    location: str = None,
) -> list:
    """
    Load all forecast snapshots from a directory.

    Args:
        forecast_dir: Path to directory containing forecast files
        date_range: Optional (start_date, end_date) to filter
        location: Optional location name to filter

    Returns:
        List of ForecastSnapshot sorted by issue_time
    """
    forecasts = []
    if not os.path.isdir(forecast_dir):
        logger.warning(f'Forecast directory not found: {forecast_dir}')
        return forecasts

    for fname in os.listdir(forecast_dir):
        path = os.path.join(forecast_dir, fname)
        try:
            if fname.endswith('.json'):
                snap = parse_forecast_json(path)
            elif fname.endswith('.csv'):
                snap = parse_forecast_csv(path)
            else:
                continue
            forecasts.append(snap)
        except Exception as e:
            logger.warning(f'Failed to parse {path}: {e}')
            continue

    # Filter by location
    if location:
        loc_lower = location.lower()
        forecasts = [f for f in forecasts
                     if loc_lower in f.location_name.lower()]

    # Filter by date range
    if date_range:
        start, end = date_range
        forecasts = [f for f in forecasts
                     if start <= f.issue_time.date() <= end]

    forecasts.sort(key=lambda f: f.issue_time)
    logger.info(f'Loaded {len(forecasts)} forecast snapshot(s) from {forecast_dir}')
    return forecasts


# ── Nowcast loading ──────────────────────────────────────────────────────────

def parse_nowcast_json(path: str) -> NowcastSnapshot:
    """Parse a single nowcast JSON file into a NowcastSnapshot."""
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    # Support both single-snapshot and array-of-snapshots formats
    if isinstance(data, list):
        # Return first; caller should use load_nowcasts for arrays
        snapshots = [_parse_one_nowcast(s, path) for s in data]
        return snapshots[0] if snapshots else None

    return _parse_one_nowcast(data, path)


def _parse_one_nowcast(data: dict, path: str) -> NowcastSnapshot:
    """Parse one nowcast dict."""
    meta = data.get('_meta', {})
    precip = data.get('precipStateNow', {})
    lightning = data.get('lightningState', {})
    trend = data.get('precipTrend60m', {})

    return NowcastSnapshot(
        snapshot_time=_parse_iso(meta.get('snapshot_time', '')),
        location_name=meta.get('location_name', 'Unknown'),
        lat=float(meta.get('lat', 0)),
        lon=float(meta.get('lon', 0)),
        station=meta.get('station', ''),
        precip_phenomenon=precip.get('phenomenon', 'dry'),
        precip_desc=precip.get('desc', ''),
        precip_source=precip.get('source', ''),
        precip_confidence=float(precip.get('confidence', 0) or 0),
        lightning_state=lightning.get('state', 'none'),
        lightning_nearest_mi=lightning.get('nearestFlashMi'),
        lightning_flash_counts=lightning.get('flashCounts', {}),
        lightning_source=lightning.get('source', 'none'),
        lightning_confidence=str(lightning.get('confidence', 'none')),
        lightning_trend=lightning.get('trend'),
        trend_timeline=trend.get('timeline'),
        trend_summary=trend.get('summary'),
        trend_summary_confidence=trend.get('summaryConfidence'),
        trend_begin_in_min=trend.get('beginInMin'),
        trend_end_in_min=trend.get('endInMin'),
        displayed_condition=data.get('displayedCondition', ''),
        displayed_icon=data.get('displayedIcon', ''),
        source_file=path,
    )


def load_nowcasts(
    nowcast_dir: str,
    date_range: tuple = None,
    location: str = None,
) -> list:
    """
    Load all nowcast snapshots from a directory.
    Supports both single-snapshot and array-of-snapshots JSON files.
    """
    nowcasts = []
    if not os.path.isdir(nowcast_dir):
        logger.warning(f'Nowcast directory not found: {nowcast_dir}')
        return nowcasts

    for fname in os.listdir(nowcast_dir):
        if not fname.endswith('.json'):
            continue
        path = os.path.join(nowcast_dir, fname)
        try:
            with open(path, 'r', encoding='utf-8') as f:
                data = json.load(f)

            if isinstance(data, list):
                for item in data:
                    nowcasts.append(_parse_one_nowcast(item, path))
            else:
                nowcasts.append(_parse_one_nowcast(data, path))
        except Exception as e:
            logger.warning(f'Failed to parse nowcast {path}: {e}')
            continue

    # Filter
    if location:
        loc_lower = location.lower()
        nowcasts = [n for n in nowcasts
                    if loc_lower in n.location_name.lower()]
    if date_range:
        start, end = date_range
        nowcasts = [n for n in nowcasts
                    if start <= n.snapshot_time.date() <= end]

    nowcasts.sort(key=lambda n: n.snapshot_time)
    logger.info(f'Loaded {len(nowcasts)} nowcast snapshot(s) from {nowcast_dir}')
    return nowcasts


# ── Horizon computation ──────────────────────────────────────────────────────

def compute_horizon_hours(issue_time: datetime, target_time: datetime) -> float:
    """Return the forecast horizon in hours (target - issue)."""
    delta = target_time - issue_time
    return delta.total_seconds() / 3600.0


def horizon_bucket_label(hours: float) -> str:
    """Map a horizon in hours to a bucket label for scoring."""
    if hours < 0:
        return 'past'
    elif hours <= 24:
        return '0-24h'
    elif hours <= 48:
        return 'Day 1'
    elif hours <= 96:
        return 'Day 3'
    elif hours <= 144:
        return 'Day 5'
    elif hours <= 192:
        return 'Day 7'
    else:
        return 'Day 7+'


# ── JSONL log loading ───────────────────────────────────────────────────────

def _parse_one_log_record(data: dict, source_file: str) -> LogRecord:
    """Parse one JSONL log record from collector.py."""
    precip = data.get('precip') or {}
    sky = data.get('sky') or {}
    lightning = data.get('lightning') or {}
    trend = data.get('trend') or {}
    radar = data.get('radar') or {}
    model = data.get('model') or {}

    return LogRecord(
        timestamp=_parse_iso(data.get('timestamp', '')),
        lat=float(data.get('lat', 0)),
        lon=float(data.get('lon', 0)),
        country=data.get('country', ''),
        state_code=data.get('stateCode'),
        station=data.get('station'),
        location_name=data.get('locationName', 'Unknown'),

        displayed_condition=data.get('displayedCondition', ''),
        displayed_icon=data.get('displayedIcon', ''),

        precip_phenomenon=precip.get('phenomenon', 'dry'),
        precip_desc=precip.get('desc', ''),
        precip_source=precip.get('source', ''),
        precip_confidence=float(precip.get('confidence', 0) or 0),

        sky_desc=sky.get('desc'),
        sky_source=sky.get('source'),
        sky_confidence=float(sky.get('confidence', 0) or 0) if sky.get('confidence') is not None else None,

        lightning_state=lightning.get('state', 'none'),
        lightning_nearest_mi=lightning.get('nearestFlashMi'),
        lightning_flash_counts=lightning.get('flashCounts', {}),
        lightning_trend=lightning.get('trend'),
        lightning_confidence=str(lightning.get('confidence', 'none')),
        lightning_source=lightning.get('source', 'none'),
        lightning_connected=lightning.get('connected'),
        lightning_buffer_age_ms=lightning.get('bufferAgeMs'),

        trend_summary=trend.get('summary'),
        trend_summary_confidence=trend.get('summaryConfidence'),
        trend_begin_in_min=trend.get('beginInMin'),
        trend_end_in_min=trend.get('endInMin'),
        trend_timeline=trend.get('timeline'),

        radar_dbz=radar.get('dbz'),
        radar_rain_state=radar.get('rainState'),
        radar_source=radar.get('source'),
        radar_motion_speed=radar.get('motionSpeed'),
        radar_motion_dir=radar.get('motionDir'),
        radar_last_valid_dbz_time=radar.get('lastValidDbzTime'),

        model_weather_code=model.get('weatherCode'),
        model_precip_prob=model.get('precipProb'),
        model_cloud_cover=model.get('cloudCover'),
        model_temp=model.get('temp'),
        model_dewpoint=model.get('dewpoint'),
        model_humidity=model.get('humidity'),
        model_wind_speed=model.get('windSpeed'),
        model_wind_dir=model.get('windDir'),
        model_pressure=model.get('pressure'),

        model_hourly=data.get('modelHourly'),

        schema_version=data.get('_schemaVersion', 1),
        validation_flags=data.get('_validationFlags'),
        source_file=source_file,
    )


def load_jsonl_logs(
    log_dir: str,
    date_range: tuple = None,
    location: str = None,
    station: str = None,
) -> list:
    """
    Load JSONL log records from the nowcastLogger output directory.

    Args:
        log_dir: Path containing YYYY-MM-DD.jsonl files
        date_range: Optional (start_date, end_date) to filter
        location: Optional location name substring to filter
        station: Optional station ID to filter

    Returns:
        List of LogRecord sorted by timestamp
    """
    records = []
    if not os.path.isdir(log_dir):
        logger.warning(f'Log directory not found: {log_dir}')
        return records

    # Walk both the top-level dir (legacy flat layout from browser collection)
    # AND city subdirectories (new layout from collector.py). Each yields
    # (relpath, basename) where basename is what we date-filter against.
    candidates = []
    for entry in sorted(os.listdir(log_dir)):
        full = os.path.join(log_dir, entry)
        if os.path.isfile(full) and entry.endswith('.jsonl'):
            candidates.append((full, entry))
        elif os.path.isdir(full):
            for sub in sorted(os.listdir(full)):
                if sub.endswith('.jsonl'):
                    candidates.append((os.path.join(full, sub), sub))

    for path, fname in candidates:
        # Skip in-progress acquisition file — not yet finalized
        if fname == 'acquiring.jsonl':
            continue

        # Quick date filter on filename — supports legacy (YYYY-MM-DD_*.jsonl),
        # new START--END (YYYY-MM-DD_HH-MM-SSZ--YYYY-MM-DD_HH-MM-SSZ.jsonl),
        # and city-partitioned (YYYY-MM-DD.jsonl from collector.py).
        if date_range:
            try:
                if '--' in fname:
                    sep = fname.index('--')
                    file_start = date.fromisoformat(fname[:10])
                    file_end = date.fromisoformat(fname[sep + 2:sep + 12])
                else:
                    file_start = file_end = date.fromisoformat(fname[:10])
                start, end = date_range
                if file_end < start or file_start > end:
                    continue
            except ValueError:
                pass  # Non-date filename, load anyway
        try:
            with open(path, 'r', encoding='utf-8') as f:
                for line_num, line in enumerate(f, 1):
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        data = json.loads(line)
                        # Skip test records
                        if data.get('test'):
                            continue
                        rec = _parse_one_log_record(data, f'{path}:{line_num}')
                        records.append(rec)
                    except Exception as e:
                        logger.debug(f'Skip line {line_num} in {fname}: {e}')
        except Exception as e:
            logger.warning(f'Failed to read {path}: {e}')

    # Filter by location
    if location:
        loc_lower = location.lower()
        records = [r for r in records if loc_lower in r.location_name.lower()]

    # Filter by station
    if station:
        st_upper = station.upper()
        records = [r for r in records if r.station and r.station.upper() == st_upper]

    # Filter by date range (on actual timestamp, not just filename)
    if date_range:
        start, end = date_range
        records = [r for r in records if start <= r.timestamp.date() <= end]

    records.sort(key=lambda r: r.timestamp)
    logger.info(f'Loaded {len(records)} log record(s) from {log_dir}')
    return records
