"""State mesonet observations via the Synoptic Data API.

Adds a second source of ground truth alongside IEM ASOS. Synoptic aggregates
state mesonets (Oklahoma, Kentucky, Iowa, NJ, etc.), CWOP, NWS COOP, RAWS,
and others — typically 10–50× denser coverage than ASOS alone with 5-min
reporting where the station supports it.

Output DataFrame matches the shape produced by `observations.bucket_to_hourly()`
so the downstream labeler (`lead_targets`) consumes it without changes.

Auth: read API token from environment variable `SYNOPTIC_TOKEN`.
Register a free token at https://synopticdata.com/api.
"""

import os
import json
import logging
import time
from datetime import date, datetime, timezone, timedelta
from typing import Optional, List

import pandas as pd
import requests

logger = logging.getLogger(__name__)

SYNOPTIC_BASE = 'https://api.synopticdata.com/v2'
SYNOPTIC_TOKEN_ENV = 'SYNOPTIC_TOKEN'

# Variables we request from Synoptic. Names follow Synoptic's variable
# vocabulary — see https://developers.synopticdata.com/about/station-variables/
SYNOPTIC_VARS = ','.join([
    'precip_accum_one_hour',
    'precip_accum_5_minute',
    'air_temp',
    'relative_humidity',
    'dew_point_temperature',
    'wind_speed',
    'wind_gust',
    'wind_direction',
    'weather_condition',  # category string when available
])


def synoptic_token() -> Optional[str]:
    return os.environ.get(SYNOPTIC_TOKEN_ENV)


def is_enabled() -> bool:
    return bool(synoptic_token())


# ── Public API ────────────────────────────────────────────────────────────────

def fetch_mesonet_observations(
    lat: float,
    lon: float,
    start_date: date,
    end_date: date,
    cache_dir: str,
    radius_km: float = 30.0,
    min_stations: int = 3,
    city_slug: Optional[str] = None,
) -> pd.DataFrame:
    """Fetch + aggregate nearby mesonet observations for a city/window.

    Returns a DataFrame in the same shape as ``observations.bucket_to_hourly()``:
      time_utc, temp_f, dewpoint_f, humidity, wind_dir, wind_mph,
      wind_gust_mph, precip_in, visibility_mi, wxcodes, has_thunder,
      sky_cover, condition_category, plus 'n_stations' for diagnostics.

    If `SYNOPTIC_TOKEN` is not set, returns an empty DataFrame and logs a warning.
    """
    if not is_enabled():
        logger.info('Mesonet disabled: %s not set', SYNOPTIC_TOKEN_ENV)
        return pd.DataFrame()

    slug = city_slug or f'{lat:.3f}_{lon:.3f}'.replace('.', 'p').replace('-', 'm')
    all_frames = []
    current = start_date - timedelta(days=1)
    today = date.today()

    while current <= end_date:
        cached = _load_cached(slug, current, cache_dir)
        if cached is not None and current < today:
            all_frames.append(cached)
        else:
            try:
                day_df = _fetch_day(lat, lon, current, radius_km, min_stations)
                if day_df is not None and not day_df.empty:
                    _save_cache(day_df, slug, current, cache_dir)
                    all_frames.append(day_df)
                else:
                    logger.info('Mesonet: no data for %s on %s', slug, current)
            except Exception as e:
                logger.warning('Mesonet fetch failed for %s on %s: %s', slug, current, e)
        current += timedelta(days=1)

    if not all_frames:
        return pd.DataFrame()

    df = pd.concat(all_frames, ignore_index=True)
    df['time_utc'] = pd.to_datetime(df['time_utc'], utc=True, errors='coerce')
    df = df.dropna(subset=['time_utc']).sort_values('time_utc').reset_index(drop=True)
    return df


# ── Implementation ────────────────────────────────────────────────────────────

def _fetch_day(lat: float, lon: float, day: date,
               radius_km: float, min_stations: int) -> Optional[pd.DataFrame]:
    """Fetch one day of nearby-station observations and bucket to 10-min."""
    token = synoptic_token()
    if not token:
        return None

    start_utc = datetime.combine(day, datetime.min.time(), tzinfo=timezone.utc)
    end_utc = start_utc + timedelta(days=1)
    radius_mi = radius_km * 0.621371

    params = {
        'token': token,
        'radius': f'{lat},{lon},{radius_mi:.2f}',
        'start': start_utc.strftime('%Y%m%d%H%M'),
        'end':   end_utc.strftime('%Y%m%d%H%M'),
        'vars':  SYNOPTIC_VARS,
        'obtimezone': 'UTC',
    }
    url = f'{SYNOPTIC_BASE}/stations/timeseries'

    for attempt in range(3):
        try:
            r = requests.get(url, params=params, timeout=30)
        except requests.RequestException as e:
            logger.debug('Synoptic request error (attempt %d): %s', attempt + 1, e)
            time.sleep(2 ** attempt)
            continue
        if r.status_code == 429:
            wait = 5 * (2 ** attempt)
            logger.warning('Synoptic rate-limited; retrying in %ds', wait)
            time.sleep(wait)
            continue
        if r.status_code >= 500:
            logger.warning('Synoptic %d (attempt %d)', r.status_code, attempt + 1)
            time.sleep(2 ** attempt)
            continue
        r.raise_for_status()
        break
    else:
        return None

    payload = r.json()
    stations = payload.get('STATION') or []
    if not stations:
        return None
    if len(stations) < min_stations:
        logger.info('Mesonet: only %d stations near (%.2f,%.2f) on %s (need %d) — skip',
                    len(stations), lat, lon, day, min_stations)
        return None

    # Each station has OBSERVATIONS = { date_time: [...], var_name: [...], ... }
    per_station_frames = []
    for st in stations:
        obs = st.get('OBSERVATIONS') or {}
        times = obs.get('date_time') or []
        if not times:
            continue
        df = pd.DataFrame({
            'time_utc': times,
            'precip_1h': obs.get('precip_accum_one_hour_set_1', [None] * len(times)),
            'precip_5m': obs.get('precip_accum_5_minute_set_1', [None] * len(times)),
            'air_temp': obs.get('air_temp_set_1', [None] * len(times)),
            'dewpoint': obs.get('dew_point_temperature_set_1', [None] * len(times)),
            'humidity': obs.get('relative_humidity_set_1', [None] * len(times)),
            'wind_speed': obs.get('wind_speed_set_1', [None] * len(times)),
            'wind_gust':  obs.get('wind_gust_set_1', [None] * len(times)),
            'wind_dir':   obs.get('wind_direction_set_1', [None] * len(times)),
            'wx_cond':    obs.get('weather_condition_set_1d', [None] * len(times)),
            'station_id': st.get('STID', '?'),
        })
        per_station_frames.append(df)

    if not per_station_frames:
        return None

    raw = pd.concat(per_station_frames, ignore_index=True)
    raw['time_utc'] = pd.to_datetime(raw['time_utc'], utc=True, errors='coerce')
    raw = raw.dropna(subset=['time_utc'])
    if raw.empty:
        return None

    return _bucket(raw)


def _bucket(raw: pd.DataFrame) -> pd.DataFrame:
    """Bucket multi-station per-minute obs into 10-min city-aggregated rows.

    Aggregation rules:
      - precip_in     : max across stations (catch the heaviest reading in the radius)
      - temp_f, dewpoint_f, humidity, wind_*: median (robust to outlier stations)
      - has_thunder   : any station reporting TS code → True
      - condition_category, wxcodes: mode (most common)
      - n_stations    : count of unique station_ids reporting in the bucket
    """
    raw = raw.copy()
    # Synoptic returns Celsius for air_temp / dew_point and m/s for wind_speed.
    # The IEM-shape DataFrame expects Fahrenheit and mph. Convert here so
    # downstream code that's used to ASOS-shape data needs no special-casing.
    raw['temp_f']      = raw['air_temp'].apply(_c_to_f)
    raw['dewpoint_f']  = raw['dewpoint'].apply(_c_to_f)
    raw['wind_mph']    = raw['wind_speed'].apply(_ms_to_mph)
    raw['wind_gust_mph'] = raw['wind_gust'].apply(_ms_to_mph)

    # Prefer 5-minute totals where present, fall back to hourly accumulation.
    # Both arrive as mm — convert to inches to match ASOS p01i.
    raw['precip_in'] = raw.apply(
        lambda r: _mm_to_in(r['precip_5m'] if pd.notna(r['precip_5m']) else r['precip_1h']),
        axis=1,
    )

    raw['has_thunder'] = raw['wx_cond'].apply(_has_thunder_str)
    raw['cond_norm']   = raw['wx_cond'].apply(_normalize_condition)

    raw['_bucket'] = raw['time_utc'].dt.floor('10min')

    rows = []
    for ts, group in raw.groupby('_bucket'):
        rows.append({
            'time_utc':            ts.isoformat(),
            'temp_f':              _safe_median(group, 'temp_f'),
            'dewpoint_f':          _safe_median(group, 'dewpoint_f'),
            'humidity':            _safe_median(group, 'humidity'),
            'wind_dir':            _safe_median(group, 'wind_dir'),
            'wind_mph':            _safe_median(group, 'wind_mph'),
            'wind_gust_mph':       _safe_max(group, 'wind_gust_mph'),
            'precip_in':           _safe_max(group, 'precip_in'),
            'visibility_mi':       float('nan'),  # Synoptic visibility not requested here
            'wxcodes':             '',  # placeholder; condition_category is the better field
            'has_thunder':         bool(group['has_thunder'].any()),
            'sky_cover':           '',
            'condition_category':  _mode(group['cond_norm']),
            'n_stations':          int(group['station_id'].nunique()),
            'source':              'mesonet',
        })
    if not rows:
        return pd.DataFrame()
    out = pd.DataFrame(rows).sort_values('time_utc').reset_index(drop=True)
    return out


# ── Cache helpers (mirror observations.py) ───────────────────────────────────

def _cache_path(slug: str, day: date, cache_dir: str) -> str:
    return os.path.join(cache_dir, f'{slug}_{day.isoformat()}.csv')


def _load_cached(slug: str, day: date, cache_dir: str) -> Optional[pd.DataFrame]:
    path = _cache_path(slug, day, cache_dir)
    if os.path.isfile(path):
        try:
            return pd.read_csv(path)
        except Exception:
            return None
    return None


def _save_cache(df: pd.DataFrame, slug: str, day: date, cache_dir: str) -> None:
    os.makedirs(cache_dir, exist_ok=True)
    df.to_csv(_cache_path(slug, day, cache_dir), index=False)


# ── Aggregation helpers ──────────────────────────────────────────────────────

def _safe_median(group: pd.DataFrame, col: str) -> float:
    if col not in group:
        return float('nan')
    s = pd.to_numeric(group[col], errors='coerce').dropna()
    return float(s.median()) if not s.empty else float('nan')


def _safe_max(group: pd.DataFrame, col: str) -> float:
    if col not in group:
        return float('nan')
    s = pd.to_numeric(group[col], errors='coerce').dropna()
    return float(s.max()) if not s.empty else float('nan')


def _mode(series: pd.Series) -> Optional[str]:
    s = series.dropna()
    if s.empty:
        return None
    counts = s.value_counts()
    return counts.index[0] if not counts.empty else None


def _c_to_f(c) -> float:
    if c is None or pd.isna(c):
        return float('nan')
    try:
        return float(c) * 9.0 / 5.0 + 32.0
    except (TypeError, ValueError):
        return float('nan')


def _ms_to_mph(ms) -> float:
    if ms is None or pd.isna(ms):
        return float('nan')
    try:
        return float(ms) * 2.23694
    except (TypeError, ValueError):
        return float('nan')


def _mm_to_in(mm) -> float:
    if mm is None or pd.isna(mm):
        return float('nan')
    try:
        return float(mm) / 25.4
    except (TypeError, ValueError):
        return float('nan')


def _has_thunder_str(s) -> bool:
    if s is None or pd.isna(s):
        return False
    return 'thunder' in str(s).lower() or 'TS' in str(s).upper()


def _normalize_condition(s) -> Optional[str]:
    """Map Synoptic weather_condition strings to the categories used by lead_targets.

    Targets the same vocabulary IEM ASOS produces via `metar_wx_to_category`:
    'clear' | 'overcast' | 'rain' | 'snow' | 'thunder' | 'fog' | 'mist' | None
    """
    if s is None or pd.isna(s):
        return None
    s_low = str(s).lower()
    if any(k in s_low for k in ('thunder', 'lightning')):
        return 'thunder'
    if any(k in s_low for k in ('snow', 'sleet', 'ice pellets', 'graupel')):
        return 'snow'
    if any(k in s_low for k in ('rain', 'drizzle', 'shower')):
        return 'rain'
    if 'fog' in s_low:
        return 'fog'
    if 'mist' in s_low or 'haze' in s_low:
        return 'mist'
    if any(k in s_low for k in ('overcast', 'cloudy')):
        return 'overcast'
    if 'clear' in s_low or 'sunny' in s_low or 'fair' in s_low:
        return 'clear'
    return None
