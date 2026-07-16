"""MRMS (Multi-Radar Multi-Sensor) PrecipRate as a truth source.

For each city's date window, we download MRMS PrecipRate GRIB2 grids
at a configurable cadence and use `wgrib2` to extract the surface rain
rate (mm/hr) at the city's coordinates. The resulting time series has
the same DataFrame shape as IEM ASOS / state-mesonet truth so the
labeler can consume it through the same precedence chain.

Why this matters: ASOS labels can be 30+ minutes off in time and many
km away in space. MRMS is 2-min cadence, 1 km × 1 km, calibrated to
surface gauges. For "did surface rain actually happen at this exact
point at this exact moment" the precision is dramatically better —
specifically useful for the Atlanta virga / elevated-return scenarios
that inflate the ASOS-based false-alarm metric.

This module is **truth-side only**. The collector, the browser, and the
prediction algorithm are untouched. No train/serve skew.

Auth: none. wgrib2 binary required (see COLLECTOR.md). NCEP NOMADS and
the Iowa State archive are both public.
"""

import os
import re
import gzip
import shutil
import logging
import subprocess
import tempfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Optional, List

import pandas as pd
import requests

logger = logging.getLogger(__name__)

NCEP_BASE = 'https://mrms.ncep.noaa.gov/data/2D/PrecipRate'
ARCHIVE_BASE = 'https://mtarchive.geol.iastate.edu'
WGRIB2_VAL_RE = re.compile(r'val=([\d.eE+\-]+)')

# Default cadence: 1 MRMS grid every N minutes. MRMS publishes every 2 min;
# 10 min is a reasonable backtest-time tradeoff between precision and
# download volume (one CONUS grid is ~600 KB compressed).
DEFAULT_FETCH_CADENCE_MIN = 10

# Sentinel wgrib2 uses for missing values
MISSING_VALUE = 9.999e20


# ── Public API ────────────────────────────────────────────────────────────────

def is_enabled(wgrib2_path: Optional[str]) -> bool:
    """Return True iff the wgrib2 binary at `wgrib2_path` (or on PATH) works."""
    return resolve_wgrib2(wgrib2_path) is not None


def resolve_wgrib2(explicit_path: Optional[str] = None) -> Optional[str]:
    """Find a usable wgrib2 binary.

    Order:
      1. `explicit_path` from config (if given and exists)
      2. `wgrib2` on PATH
      3. `wgrib/wgrib2.exe` relative to the project root (Windows convention)
    Returns absolute path or None.
    """
    if explicit_path:
        p = Path(explicit_path)
        if p.is_file():
            return str(p.resolve())

    found = shutil.which('wgrib2')
    if found:
        return found

    # Project-local fallback: matches where the dev installed it
    project_root = Path(__file__).resolve().parents[2]
    for candidate in (
        project_root / 'wgrib' / 'wgrib2.exe',
        project_root / 'wgrib' / 'wgrib2',
        project_root / 'wgrib2.exe',
        project_root / 'wgrib2',
    ):
        if candidate.is_file():
            return str(candidate.resolve())

    return None


def fetch_mrms_observations(
    lat: float,
    lon: float,
    start_date: date,
    end_date: date,
    cache_dir: str,
    wgrib2_path: Optional[str] = None,
    fetch_cadence_min: int = DEFAULT_FETCH_CADENCE_MIN,
    city_slug: Optional[str] = None,
) -> pd.DataFrame:
    """Build a per-city time series of MRMS surface rain rate.

    Returns a DataFrame with columns: time_utc, precip_in, has_thunder,
    condition_category, source — matching the IEM ASOS / mesonet shape so
    `lead_targets._nearest_obs` can consume it through the same code path.

    `precip_in` is converted from MRMS mm/hr → inches/hr to match ASOS p01i
    units. (Yes, "hourly accumulation" vs "instantaneous rate" is a slight
    semantic mismatch — but for the active/inactive boolean and intensity
    tiers used by the labeler, they're interchangeable at the granularity
    we care about.)

    Returns empty DataFrame if wgrib2 is unavailable.
    """
    wgrib2 = resolve_wgrib2(wgrib2_path)
    if not wgrib2:
        logger.info('MRMS disabled: wgrib2 binary not found')
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
                day_df = _fetch_day(lat, lon, current, wgrib2, fetch_cadence_min)
                if day_df is not None and not day_df.empty:
                    _save_cache(day_df, slug, current, cache_dir)
                    all_frames.append(day_df)
                else:
                    logger.info('MRMS: no data for %s on %s', slug, current)
            except Exception as e:
                logger.warning('MRMS fetch failed for %s on %s: %s', slug, current, e)
        current += timedelta(days=1)

    if not all_frames:
        return pd.DataFrame()
    df = pd.concat(all_frames, ignore_index=True)
    df['time_utc'] = pd.to_datetime(df['time_utc'], utc=True, errors='coerce')
    df = df.dropna(subset=['time_utc']).sort_values('time_utc').reset_index(drop=True)
    return df


# ── Implementation ───────────────────────────────────────────────────────────

def _fetch_day(lat: float, lon: float, day: date,
               wgrib2_path: str, cadence_min: int) -> Optional[pd.DataFrame]:
    """Fetch one day of MRMS rates at a single point.

    Iterates through expected grid timestamps at `cadence_min` cadence and
    downloads each, extracting the value at (lat, lon). Returns a bucketed
    DataFrame. Stops at "now" for today's date.
    """
    cadence = timedelta(minutes=cadence_min)
    cycle_offset = cadence_min // 2  # MRMS publishes at HH:00:00, HH:02:00, ...
    start = datetime.combine(day, datetime.min.time(), tzinfo=timezone.utc)
    end = start + timedelta(days=1)
    now = datetime.now(timezone.utc)

    # Don't bother trying to fetch grids that haven't been published yet
    if end > now:
        end = now - timedelta(minutes=2)
    if start >= end:
        return None

    rows = []
    target = start
    while target < end:
        # Round target to nearest 2-min cycle (MRMS publishes on even minutes)
        snapped = _snap_to_mrms_cycle(target)
        grib_bytes = _download_grid_with_fallback(snapped, day)
        if grib_bytes is not None:
            value = _extract_point(grib_bytes, lat, lon, wgrib2_path)
            if value is not None:
                rows.append({
                    'time_utc': snapped.isoformat(),
                    # mm/hr → in/hr (close enough to ASOS p01i for our use)
                    'precip_in': round(value / 25.4, 4),
                    'has_thunder': False,            # MRMS doesn't classify thunder
                    'condition_category': 'rain' if value > 0.25 else 'clear',
                    'source': 'mrms',
                })
        target += cadence

    return pd.DataFrame(rows) if rows else None


def _snap_to_mrms_cycle(ts: datetime) -> datetime:
    """Round down to the nearest 2-min mark (MRMS publish cadence)."""
    return ts.replace(minute=(ts.minute // 2) * 2, second=0, microsecond=0)


def _download_grid_with_fallback(ts: datetime, day: date) -> Optional[bytes]:
    """Try NCEP NOMADS, then the Iowa State archive. Return raw GRIB2 bytes."""
    stamp = ts.strftime('%Y%m%d-%H%M%S')

    # NCEP NOMADS holds the last ~24-48 hours
    ncep_url = f'{NCEP_BASE}/MRMS_PrecipRate_00.00_{stamp}.grib2.gz'
    gz = _http_get(ncep_url)
    if gz is None:
        # Iowa State mirror for older windows
        archive_url = (
            f'{ARCHIVE_BASE}/{day.year}/{day.month:02d}/{day.day:02d}'
            f'/mrms/ncep/PrecipRate/MRMS_PrecipRate_00.00_{stamp}.grib2.gz'
        )
        gz = _http_get(archive_url)
    if gz is None:
        logger.debug('MRMS grid not found at %s', stamp)
        return None
    try:
        return gzip.decompress(gz)
    except OSError as e:
        logger.warning('MRMS gzip decompress failed for %s: %s', stamp, e)
        return None


def _http_get(url: str, timeout: int = 20) -> Optional[bytes]:
    """GET binary content from url; return None on any failure."""
    try:
        r = requests.get(url, timeout=timeout)
        if r.status_code == 200:
            return r.content
        return None
    except requests.RequestException:
        return None


def _extract_point(grib_bytes: bytes, lat: float, lon: float,
                   wgrib2_path: str) -> Optional[float]:
    """Run wgrib2 to extract the surface rate at (lat, lon) from a GRIB2.

    wgrib2 takes longitude in 0–360 range; we convert. Output line is
    formatted as `1:0:lon=L,lat=A,val=V`. We parse `val=` and return the
    float (None if missing).
    """
    with tempfile.NamedTemporaryFile(suffix='.grib2', delete=False) as f:
        f.write(grib_bytes)
        tmp_path = f.name
    try:
        # wgrib2 -lon takes longitude first, then latitude
        result = subprocess.run(
            [wgrib2_path, tmp_path, '-lon', str(lon), str(lat)],
            capture_output=True, text=True, timeout=15,
        )
        if result.returncode != 0:
            logger.debug('wgrib2 nonzero exit (%d): %s', result.returncode,
                         result.stderr.strip()[:200])
            return None
        m = WGRIB2_VAL_RE.search(result.stdout)
        if not m:
            return None
        v = float(m.group(1))
        if v >= MISSING_VALUE * 0.9 or v < 0:
            return None
        return v
    except subprocess.TimeoutExpired:
        logger.warning('wgrib2 timeout for (%.3f, %.3f)', lat, lon)
        return None
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


# ── Cache (mirror of observations.py pattern) ────────────────────────────────

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
