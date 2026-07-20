"""
Observation fetching and caching from IEM ASOS.

Uses the same Iowa Environmental Mesonet endpoint as the Weather HQ app
(src/services/observations.js lines 206-209). Caches per station per day
as CSV files so repeated benchmark runs don't re-fetch.
"""

import os
import json
import math
import time
import logging
from datetime import date, datetime, timezone, timedelta
from typing import Optional

import pandas as pd
import requests

from .utils import (
    knots_to_mph, has_thunder, metar_wx_to_category,
    parse_metar_temp, celsius_to_fahrenheit,
)

logger = logging.getLogger(__name__)

IEM_ASOS_URL = 'https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py'
IEM_NETWORK_URL = 'https://mesonet.agron.iastate.edu/geojson/network/{network}.geojson'

# Fields we request from IEM
IEM_DATA_FIELDS = 'tmpf,dwpf,relh,drct,sknt,gust,p01i,vsby,wxcodes,metar,skyc1,skyc2,skyc3,skyc4'

# In-process cache for IEM network station lists (keyed by network name, e.g. "FL_ASOS")
_network_station_cache: dict = {}


# ── IEM ASOS fetching ────────────────────────────────────────────────────────

def fetch_observations(
    station: str,
    start_date: date,
    end_date: date,
    cache_dir: str,
    lat: Optional[float] = None,
    lon: Optional[float] = None,
    state_code: Optional[str] = None,
) -> pd.DataFrame:
    """
    Fetch IEM ASOS observations for a station and date range.
    Uses local cache for past dates; always re-fetches today.

    If the primary station returns no data and lat/lon/state_code are provided,
    automatically falls back to the nearest IEM ASOS station for that state.

    Returns a DataFrame with hourly-bucketed observations.
    """
    all_frames = []
    # Fetch one day before start so the 23:53Z obs from the prior day is
    # available for snapshots taken in the first few minutes of start_date UTC.
    current = start_date - timedelta(days=1)
    today = date.today()

    while current <= end_date:
        cached = _load_cached(station, current, cache_dir)
        if cached is not None and current < today:
            all_frames.append(cached)
        else:
            try:
                raw = _fetch_day(station, current)
                if raw is not None and not raw.empty:
                    _save_cache(raw, station, current, cache_dir)
                    all_frames.append(raw)
                else:
                    logger.warning(f'No IEM data for {station} on {current}')
            except Exception as e:
                logger.warning(f'IEM fetch failed for {station} {current}: {e}')
        current += timedelta(days=1)

    if not all_frames:
        # Primary station returned nothing — walk through nearest IEM ASOS stations
        # until one returns data.  OBE/KOBE etc. may be in IEM's station list but
        # have no actual data (AWOS, sparse coverage), so we need N candidates.
        if lat is not None and lon is not None and state_code:
            candidates = _ranked_fallback_stations(lat, lon, state_code, max_results=5)
            # Normalise the primary station ID for comparison (strip leading K for ICAO→FAA)
            primary_variants = {station.upper(), station.lstrip('K').upper()}
            for fallback_id, dist_km in candidates:
                if fallback_id.upper() in primary_variants:
                    continue  # same airport, different identifier — skip
                logger.info(
                    f'{station} not in IEM — trying {fallback_id} ({dist_km:.1f} km)'
                )
                result_df, _, _ = fetch_observations(fallback_id, start_date, end_date, cache_dir)
                if not result_df.empty:
                    return result_df, fallback_id, dist_km
                logger.info(f'{fallback_id} also returned no data, continuing search')
        logger.warning(f'No observations found for {station} from {start_date} to {end_date}')
        return pd.DataFrame(), station, 0.0

    combined = pd.concat(all_frames, ignore_index=True)
    return bucket_to_hourly(combined), station, 0.0


def _ranked_fallback_stations(
    lat: float, lon: float, state_code: str, max_results: int = 5
) -> list:
    """
    Return up to max_results IEM ASOS stations in the given state, sorted by
    distance from (lat, lon).  Each element is (station_id, dist_km).

    The state network GeoJSON is fetched once per process and cached.
    Returns an empty list if the network cannot be fetched.
    """
    network = f'{state_code.upper()}_ASOS'

    if network not in _network_station_cache:
        url = IEM_NETWORK_URL.format(network=network)
        try:
            resp = requests.get(url, timeout=15)
            resp.raise_for_status()
            data = resp.json()
            _network_station_cache[network] = data
            logger.debug(
                f'Fetched IEM network {network}: '
                f'{len(data.get("features", []))} stations'
            )
        except Exception as e:
            logger.warning(f'IEM network fetch failed for {network}: {e}')
            _network_station_cache[network] = None

    gj = _network_station_cache.get(network)
    if not gj or not gj.get('features'):
        return []

    scored = []
    lat_r = math.radians(lat)
    for feature in gj['features']:
        geom = feature.get('geometry') or {}
        coords = geom.get('coordinates')  # [lon, lat]
        if not coords or len(coords) < 2:
            continue
        props = feature.get('properties') or {}
        sid = props.get('sid') or props.get('id') or props.get('stationIdentifier')
        if not sid:
            continue
        slat, slon = coords[1], coords[0]
        dlat = math.radians(slat - lat)
        dlon = math.radians(slon - lon)
        a = (math.sin(dlat / 2) ** 2
             + math.cos(lat_r) * math.cos(math.radians(slat)) * math.sin(dlon / 2) ** 2)
        dist_km = 6371 * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
        scored.append((sid, dist_km))

    scored.sort(key=lambda x: x[1])
    top = scored[:max_results]
    if top:
        names = ', '.join(f'{s}({d:.0f}km)' for s, d in top)
        logger.info(f'IEM {network} candidates near ({lat:.4f}, {lon:.4f}): {names}')
    return top


def _fetch_day(station: str, day: date) -> pd.DataFrame:
    """Fetch one day of ASOS data from IEM."""
    params = {
        'station': station,
        'data': IEM_DATA_FIELDS,
        'year1': day.year, 'month1': day.month, 'day1': day.day,
        'hour1': '0', 'minute1': '0',
        'year2': day.year, 'month2': day.month, 'day2': day.day,
        'hour2': '23', 'minute2': '59',
        'tz': 'UTC',
        'format': 'onlycomma',
        'latlon': 'no',
        'direct': 'no',
        # v1.52.0: report_type '1' now returns ZERO rows from IEM (semantics
        # changed upstream) — the scorer silently fell back to thunder-less
        # sources and lightning FAR pinned at 100%. '3,4' = routine + special
        # METARs with wxcodes.
        'report_type': '3,4',
    }

    logger.info(f'Fetching IEM ASOS: {station} {day}')
    for attempt in range(3):
        resp = requests.get(IEM_ASOS_URL, params=params, timeout=30)
        if resp.status_code != 429:
            break
        wait = 5 * (2 ** attempt)  # 5s, 10s, 20s
        logger.warning(f'IEM rate-limited for {station} {day}, retrying in {wait}s (attempt {attempt + 1}/3)')
        time.sleep(wait)
    resp.raise_for_status()

    # Parse IEM CSV response
    lines = resp.text.strip().split('\n')
    # Skip comment lines and find header
    data_lines = [l for l in lines if l and not l.startswith('#')]
    if len(data_lines) < 2:
        return pd.DataFrame()

    header = data_lines[0]
    rows = data_lines[1:]

    # Write to temp string and read with pandas
    csv_text = header + '\n' + '\n'.join(rows)
    from io import StringIO
    df = pd.read_csv(StringIO(csv_text), na_values=['M', 'T', ''])
    return df


# ── Cache management ─────────────────────────────────────────────────────────

def _cache_path(station: str, day: date, cache_dir: str) -> str:
    return os.path.join(cache_dir, f'{station}_{day.isoformat()}.csv')


def _load_cached(station: str, day: date, cache_dir: str) -> pd.DataFrame:
    path = _cache_path(station, day, cache_dir)
    if os.path.isfile(path):
        try:
            return pd.read_csv(path)
        except Exception:
            return None
    return None


def _save_cache(df: pd.DataFrame, station: str, day: date, cache_dir: str):
    os.makedirs(cache_dir, exist_ok=True)
    path = _cache_path(station, day, cache_dir)
    df.to_csv(path, index=False)


# ── Hourly bucketing ─────────────────────────────────────────────────────────

def bucket_to_hourly(df: pd.DataFrame) -> pd.DataFrame:
    """
    Aggregate 5-minute ASOS observations into hourly buckets.

    Mirrors the app's approach in observations.js: bucket by hour,
    take max p01i per hour, mean temp, max gust.

    Returns DataFrame with one row per hour:
      time_utc, temp_f, dewpoint_f, humidity, wind_dir, wind_mph,
      wind_gust_mph, precip_in, visibility_mi, wxcodes, has_thunder,
      sky_cover, condition_category
    """
    if df.empty:
        return pd.DataFrame()

    # Parse the 'valid' column (IEM timestamp format: "YYYY-MM-DD HH:MM")
    time_col = 'valid' if 'valid' in df.columns else df.columns[1]
    df = df.copy()
    df['_ts'] = pd.to_datetime(df[time_col], utc=True, errors='coerce')
    df = df.dropna(subset=['_ts'])

    if df.empty:
        return pd.DataFrame()

    # Floor to hour for bucketing
    df['_hour'] = df['_ts'].dt.floor('h')

    hourly_rows = []
    for hour_ts, group in df.groupby('_hour'):
        # Temperature: mean (IEM field: tmpf), fallback to METAR parsing
        temp_f = _safe_col_mean(group, 'tmpf')
        dewpoint_f = _safe_col_mean(group, 'dwpf')
        if pd.isna(temp_f) and 'metar' in group.columns:
            temps_c, dews_c = [], []
            for m in group['metar'].dropna():
                tc, dc = parse_metar_temp(str(m))
                if tc is not None:
                    temps_c.append(tc)
                if dc is not None:
                    dews_c.append(dc)
            if temps_c:
                temp_f = celsius_to_fahrenheit(sum(temps_c) / len(temps_c))
            if dews_c and pd.isna(dewpoint_f):
                dewpoint_f = celsius_to_fahrenheit(sum(dews_c) / len(dews_c))
        humidity = _safe_col_mean(group, 'relh')

        # Wind: mean speed, max gust (IEM: sknt in knots, gust in knots)
        wind_kt = _safe_col_mean(group, 'sknt')
        wind_mph = knots_to_mph(wind_kt) if pd.notna(wind_kt) else float('nan')
        gust_kt = _safe_col_max(group, 'gust')
        wind_gust_mph = knots_to_mph(gust_kt) if pd.notna(gust_kt) else float('nan')
        wind_dir = _safe_col_mean(group, 'drct')

        # Precip: max p01i in the hour (rolling 1-hr accumulation)
        precip_in = _safe_col_max(group, 'p01i')

        # Visibility: min in the hour
        visibility_mi = _safe_col_min(group, 'vsby')

        # Wxcodes: union all codes in the hour
        all_wx = ' '.join(str(v) for v in group.get('wxcodes', []) if pd.notna(v))
        thunder = has_thunder(all_wx)

        # Sky cover: take the most significant (last layer) from the most recent obs
        sky_cover = _best_sky_cover(group)

        # Derive condition category
        condition = metar_wx_to_category(all_wx, sky_cover)

        # Reconcile: the wxcodes union spans the whole hour, so a rain code from
        # minute 0 can "infect" the bucket even if the station is dry by minute
        # 7. If no measurable accumulation and no thunder, trust the sky-cover
        # fallback over potentially stale precip wxcodes. Keep thunder (TS codes
        # are rare and important) and fog (no accumulation expected).
        _precip_cats = {
            'drizzle', 'rain', 'heavy_rain', 'snow', 'heavy_snow',
            'freezing_precip', 'shower',
        }
        precip_accum = precip_in if pd.notna(precip_in) else 0.0
        if condition in _precip_cats and precip_accum <= 0.01 and not thunder:
            # Re-derive from sky cover only (empty wx)
            condition = metar_wx_to_category('', sky_cover)

        hourly_rows.append({
            'time_utc': hour_ts,
            'temp_f': round(temp_f, 1) if pd.notna(temp_f) else None,
            'dewpoint_f': round(dewpoint_f, 1) if pd.notna(dewpoint_f) else None,
            'humidity': round(humidity, 0) if pd.notna(humidity) else None,
            'wind_dir': round(wind_dir, 0) if pd.notna(wind_dir) else None,
            'wind_mph': round(wind_mph, 1) if pd.notna(wind_mph) else None,
            'wind_gust_mph': round(wind_gust_mph, 1) if pd.notna(wind_gust_mph) else None,
            'precip_in': round(precip_in, 3) if pd.notna(precip_in) else 0.0,
            'visibility_mi': round(visibility_mi, 1) if pd.notna(visibility_mi) else None,
            'wxcodes': all_wx.strip() or None,
            'has_thunder': thunder,
            'sky_cover': sky_cover,
            'condition_category': condition,
        })

    result = pd.DataFrame(hourly_rows)
    col = pd.to_datetime(result['time_utc'])
    result['time_utc'] = col.dt.tz_convert('UTC') if col.dt.tz is not None else col.dt.tz_localize('UTC')
    result = result.sort_values('time_utc').reset_index(drop=True)
    return result


def _safe_col_mean(group: pd.DataFrame, col: str):
    if col not in group.columns:
        return float('nan')
    vals = pd.to_numeric(group[col], errors='coerce')
    return vals.mean()


def _safe_col_max(group: pd.DataFrame, col: str):
    if col not in group.columns:
        return float('nan')
    vals = pd.to_numeric(group[col], errors='coerce')
    return vals.max()


def _safe_col_min(group: pd.DataFrame, col: str):
    if col not in group.columns:
        return float('nan')
    vals = pd.to_numeric(group[col], errors='coerce')
    return vals.min()


def _best_sky_cover(group: pd.DataFrame) -> str:
    """Get the most significant sky cover from ASOS sky layer columns."""
    cover_priority = {'OVC': 5, 'BKN': 4, 'SCT': 3, 'FEW': 2, 'VV': 5, 'CLR': 1, 'SKC': 1}
    best = 'CLR'
    best_p = 0
    for col in ['skyc1', 'skyc2', 'skyc3', 'skyc4']:
        if col in group.columns:
            for val in group[col].dropna():
                val = str(val).strip().upper()
                p = cover_priority.get(val, 0)
                if p > best_p:
                    best_p = p
                    best = val
    return best


# ── Manual observation loading ───────────────────────────────────────────────

def load_observation_json(path: str) -> pd.DataFrame:
    """
    Load observations from a manually-created JSON file.
    Used for sample data and testing.

    Expected format:
    {
      "_meta": { "station": "KAVL", ... },
      "hourly": [
        { "time": "2026-03-15T00:00:00Z", "temp_f": 41.0, ... },
        ...
      ]
    }
    """
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    hourly = data.get('hourly', [])
    if not hourly:
        return pd.DataFrame()

    df = pd.DataFrame(hourly)

    # Normalize time column
    time_col = 'time' if 'time' in df.columns else 'time_utc'
    df['time_utc'] = pd.to_datetime(df[time_col], utc=True, errors='coerce')

    # Ensure required columns with defaults
    defaults = {
        'temp_f': None, 'dewpoint_f': None, 'humidity': None,
        'wind_dir': None, 'wind_mph': None, 'wind_gust_mph': None,
        'precip_in': 0.0, 'visibility_mi': None, 'wxcodes': None,
        'has_thunder': False, 'sky_cover': 'CLR', 'condition_category': 'clear',
    }
    for col, default in defaults.items():
        if col not in df.columns:
            df[col] = default

    return df.sort_values('time_utc').reset_index(drop=True)
