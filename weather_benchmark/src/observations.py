"""
Observation fetching and caching from IEM ASOS.

Uses the same Iowa Environmental Mesonet endpoint as the Weather HQ app
(src/services/observations.js lines 206-209). Caches per station per day
as CSV files so repeated benchmark runs don't re-fetch.
"""

import os
import re
import json
import math
import time
import hashlib
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

# report_type '3,4' = routine + special METARs (the legacy hourly truth input).
# '1' = the MADIS 5-minute feed; as of 2026-10 it carries wxcodes again
# ('M' = no weather), so '1,3,4' gives ~290 obs/day with per-obs present
# weather at most ASOS sites (military sites like KSVN have no 5-min feed).
LEGACY_REPORT_TYPE = '3,4'
RAW_REPORT_TYPE = '1,3,4'

# Bump when the cached CSV's meaning changes. The cache key also carries the
# report_type and a hash of the requested fields, so a change to either can
# never silently reuse a file fetched under different parameters.
CACHE_VERSION = 2
# A UTC day is only cached once it is this far in the past — IEM keeps
# ingesting late/corrected METARs for a while after the day ends.
CACHE_SETTLE = timedelta(hours=3)
_LEGACY_CACHE_RE = re.compile(r'^[A-Z0-9]{3,5}_\d{4}-\d{2}-\d{2}\.csv$')

# In-process cache for IEM network station lists (keyed by network name, e.g. "FL_ASOS")
_network_station_cache: dict = {}
_purged_dirs: set = set()


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
    Legacy truth: routine+special METARs bucketed to hourly rows.

    Kept so old-vs-new truth comparisons can be reproduced (backtest
    ``--truth legacy``). The hourly floor + wxcode union leaks up to 59 min of
    future weather into each bucket; new code should use
    ``fetch_raw_observations`` + ``metar_frame`` instead.

    Returns (DataFrame, station_used, fallback_dist_km).
    """
    raw, used, dist = fetch_raw_observations(
        station, start_date, end_date, cache_dir, lat=lat, lon=lon,
        state_code=state_code, report_type=LEGACY_REPORT_TYPE)
    if raw.empty:
        return pd.DataFrame(), used, dist
    return bucket_to_hourly(raw), used, dist


def fetch_raw_observations(
    station: str,
    start_date: date,
    end_date: date,
    cache_dir: str,
    lat: Optional[float] = None,
    lon: Optional[float] = None,
    state_code: Optional[str] = None,
    report_type: str = RAW_REPORT_TYPE,
):
    """
    Fetch raw (un-bucketed) IEM ASOS rows for a station and date range.

    Only UTC-complete days (ended more than CACHE_SETTLE ago) are written to
    or read from the disk cache; anything newer is fetched every run.

    If the primary station returns no data and lat/lon/state_code are provided,
    automatically falls back to the nearest IEM ASOS station for that state.

    Returns (raw DataFrame, station_used, fallback_dist_km).
    """
    purge_legacy_cache(cache_dir)
    all_frames = []
    # Fetch one day before start so the 23:53Z obs from the prior day is
    # available for snapshots taken in the first few minutes of start_date UTC.
    current = start_date - timedelta(days=1)

    while current <= end_date:
        cacheable = _day_is_complete(current)
        cached = _load_cached(station, current, cache_dir, report_type) if cacheable else None
        if cached is not None:
            all_frames.append(cached)
        else:
            try:
                raw = _fetch_day(station, current, report_type)
                if raw is not None and not raw.empty:
                    if cacheable:
                        _save_cache(raw, station, current, cache_dir, report_type)
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
                result_df, _, _ = fetch_raw_observations(
                    fallback_id, start_date, end_date, cache_dir, report_type=report_type)
                if not result_df.empty:
                    return result_df, fallback_id, dist_km
                logger.info(f'{fallback_id} also returned no data, continuing search')
        logger.warning(f'No observations found for {station} from {start_date} to {end_date}')
        return pd.DataFrame(), station, 0.0

    return pd.concat(all_frames, ignore_index=True), station, 0.0


def _day_is_complete(day: date, now: Optional[datetime] = None) -> bool:
    """True once the whole UTC day is in the past by at least CACHE_SETTLE."""
    now = now or datetime.now(timezone.utc)
    day_end = datetime(day.year, day.month, day.day, tzinfo=timezone.utc) + timedelta(days=1)
    return now >= day_end + CACHE_SETTLE


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


def _fetch_day(station: str, day: date, report_type: str = LEGACY_REPORT_TYPE) -> pd.DataFrame:
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
        # v1.52.0: report_type '1' alone returned ZERO rows for a while
        # (upstream change) — hence the legacy '3,4' (routine + special).
        # '1,3,4' adds the 5-minute feed back for raw-obs truth.
        'report_type': report_type,
    }

    logger.info(f'Fetching IEM ASOS: {station} {day}')
    for attempt in range(3):
        wait = 5 * (2 ** attempt)  # 5s, 10s, 20s
        try:
            resp = requests.get(IEM_ASOS_URL, params=params, timeout=30)
        except requests.ConnectionError as e:
            if attempt == 2:
                raise
            logger.warning(f'IEM connection error for {station} {day} ({e}), retrying in {wait}s')
            time.sleep(wait)
            continue
        if resp.status_code != 429:
            break
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

def _cache_key(report_type: str) -> str:
    fields_hash = hashlib.sha1(IEM_DATA_FIELDS.encode()).hexdigest()[:8]
    return f'v{CACHE_VERSION}_rt{report_type.replace(",", "")}_{fields_hash}'


def _cache_path(station: str, day: date, cache_dir: str,
                report_type: str = LEGACY_REPORT_TYPE) -> str:
    return os.path.join(cache_dir, f'{station}_{day.isoformat()}__{_cache_key(report_type)}.csv')


def _load_cached(station: str, day: date, cache_dir: str,
                 report_type: str = LEGACY_REPORT_TYPE) -> pd.DataFrame:
    path = _cache_path(station, day, cache_dir, report_type)
    if os.path.isfile(path):
        try:
            return pd.read_csv(path)
        except Exception:
            return None
    return None


def _save_cache(df: pd.DataFrame, station: str, day: date, cache_dir: str,
                report_type: str = LEGACY_REPORT_TYPE):
    os.makedirs(cache_dir, exist_ok=True)
    path = _cache_path(station, day, cache_dir, report_type)
    tmp = path + '.tmp'
    df.to_csv(tmp, index=False)
    os.replace(tmp, path)   # never leave a half-written cache file behind


def purge_legacy_cache(cache_dir: str) -> int:
    """Delete pre-v2 cache files (``STATION_YYYY-MM-DD.csv``).

    Those were keyed only by station+day, so they may hold partial current-day
    data (saved mid-day and then reused forever — e.g. KBOS_2026-07-19.csv
    stops at 13:xxZ) or rows fetched under an older report_type. Runs once per
    directory per process. Returns the number of files removed.
    """
    if cache_dir in _purged_dirs or not os.path.isdir(cache_dir):
        return 0
    _purged_dirs.add(cache_dir)
    removed = 0
    for name in os.listdir(cache_dir):
        if _LEGACY_CACHE_RE.match(name):
            try:
                os.remove(os.path.join(cache_dir, name))
                removed += 1
            except OSError as e:
                logger.warning(f'Could not purge stale cache {name}: {e}')
    if removed:
        logger.info(f'Purged {removed} legacy (unversioned) IEM cache file(s) from {cache_dir}')
    return removed


# ── Raw per-observation frame (v2 truth) ─────────────────────────────────────

# Present-weather precipitation codes. Descriptors (TS/SH/FZ) may prefix them;
# BL/DR (blowing/drifting) and VC (vicinity) do not mean precip at the station.
_PRECIP_CODES = ('DZ', 'RA', 'SN', 'SG', 'IC', 'PL', 'GR', 'GS', 'UP')


def wx_has_precip(wxcodes) -> bool:
    """True if a METAR present-weather string reports precip AT the station."""
    if not isinstance(wxcodes, str) or not wxcodes.strip():
        return False
    for tok in wxcodes.upper().split():
        tok = tok.lstrip('+-')
        if tok.startswith(('VC', 'BL', 'DR')):
            continue
        if any(code in tok for code in _PRECIP_CODES):
            return True
    return False


def metar_frame(raw: pd.DataFrame) -> pd.DataFrame:
    """
    One row per raw observation (5-min, routine or special) — no bucketing.

    Every label comes from that single observation's own present-weather
    codes and sky layers, so nothing from later in the hour can leak in.

    Columns: time_utc, wxcodes, precip_active, has_thunder, condition_category,
             precip_in (p01i as reported; NaN on 5-min rows), sky_cover,
             report_kind ('5min' | 'metar'), source='asos'
    """
    if raw is None or raw.empty:
        return pd.DataFrame()
    time_col = 'valid' if 'valid' in raw.columns else raw.columns[1]
    df = raw.copy()
    df['_ts'] = pd.to_datetime(df[time_col], utc=True, errors='coerce')
    df = df.dropna(subset=['_ts'])
    if df.empty:
        return pd.DataFrame()

    def _col(name, fill=''):
        if name not in df.columns:
            return [fill] * len(df)
        return [v.strip() if isinstance(v, str) else fill for v in df[name]]

    wx = _col('wxcodes')
    metar = _col('metar')
    cover_priority = {'OVC': 5, 'BKN': 4, 'SCT': 3, 'FEW': 2, 'VV': 5, 'CLR': 1, 'SKC': 1}
    layers = list(zip(*[_col(c) for c in ('skyc1', 'skyc2', 'skyc3', 'skyc4')]))
    sky = []
    for ls in layers:
        best, best_p = 'CLR', 0
        for v in ls:
            p = cover_priority.get(v.upper(), 0)
            if p > best_p:
                best, best_p = v.upper(), p
        sky.append(best)

    out = pd.DataFrame({
        'time_utc': df['_ts'].values,
        'wxcodes': wx,
        'precip_active': [wx_has_precip(w) for w in wx],
        'has_thunder': [has_thunder(w) for w in wx],
        'precip_in': (pd.to_numeric(df['p01i'], errors='coerce').values
                      if 'p01i' in df.columns else float('nan')),
        'sky_cover': sky,
        'report_kind': ['5min' if 'MADISHF' in m else 'metar' for m in metar],
        'source': 'asos',
    })
    out['condition_category'] = [metar_wx_to_category(w, c, legacy=False)
                                 for w, c in zip(out['wxcodes'], out['sky_cover'])]
    out['time_utc'] = pd.to_datetime(out['time_utc'], utc=True)
    out = (out.sort_values('time_utc', kind='stable')
              .drop_duplicates(subset=['time_utc', 'report_kind'], keep='last')
              .reset_index(drop=True))
    return out


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
