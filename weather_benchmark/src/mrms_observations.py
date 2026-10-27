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
from concurrent.futures import ThreadPoolExecutor
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

# Truth thresholds on the instantaneous surface rate (mm/hr). Rain/no-rain at
# 0.25 mm/h (~0.01 in/h, the ASOS "measurable" bar). Intensity tiers follow
# the AMS rain-rate definitions so they line up with METAR -RA / RA / +RA:
# light < 2.5, moderate 2.5–7.6, heavy >= 7.6.
RAIN_RATE_MIN_MMHR = 0.25
MODERATE_RATE_MMHR = 2.5
HEAVY_RATE_MMHR = 7.6

# Bump when the cached CSV's meaning changes (v2: archive URL fix, rate_mmhr +
# precip_active columns, only UTC-complete days cached).
CACHE_VERSION = 2
CACHE_SETTLE = timedelta(hours=3)
# Require this share of the day's grids before caching it as complete.
MIN_DAY_COVERAGE = 0.9


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

    Single-point wrapper around ``fetch_mrms_multi`` (use that one directly
    when several cities share the window — each CONUS grid is then
    downloaded once instead of once per city).

    Returns a DataFrame with columns: time_utc, rate_mmhr, precip_in (in/hr),
    precip_active, condition_category, has_thunder (always NaN — MRMS has no
    thunder; the labeler takes thunder from ASOS), source='mrms'.
    Empty DataFrame if wgrib2 is unavailable.
    """
    slug = city_slug or f'{lat:.3f}_{lon:.3f}'.replace('.', 'p').replace('-', 'm')
    out = fetch_mrms_multi({slug: (lat, lon)}, start_date, end_date, cache_dir,
                           wgrib2_path=wgrib2_path, fetch_cadence_min=fetch_cadence_min,
                           workers=1)
    return out.get(slug, pd.DataFrame())


def fetch_mrms_multi(
    points: dict,
    start_date: date,
    end_date: date,
    cache_dir: str,
    wgrib2_path: Optional[str] = None,
    fetch_cadence_min: int = DEFAULT_FETCH_CADENCE_MIN,
    workers: int = 3,
) -> dict:
    """MRMS rate series for many points at once: {slug: DataFrame}.

    ``points`` maps slug -> (lat, lon). Per UTC day, only the slugs without a
    valid cache file are extracted; every grid is downloaded once and all
    those points are read from it in a single wgrib2 call. Days are cached
    only when UTC-complete and at least MIN_DAY_COVERAGE of grids were found.
    """
    wgrib2 = resolve_wgrib2(wgrib2_path)
    if not wgrib2:
        logger.info('MRMS disabled: wgrib2 binary not found')
        return {slug: pd.DataFrame() for slug in points}

    frames = {slug: [] for slug in points}
    current = start_date - timedelta(days=1)
    while current <= end_date:
        complete = _day_is_complete(current)
        missing = {}
        for slug, ll in points.items():
            cached = _load_cached(slug, current, cache_dir, fetch_cadence_min) if complete else None
            if cached is not None:
                frames[slug].append(cached)
            else:
                missing[slug] = ll
        if missing:
            try:
                by_slug, coverage = _fetch_day_multi(missing, current, wgrib2,
                                                     fetch_cadence_min, workers)
            except Exception as e:
                logger.warning('MRMS fetch failed for %s: %s', current, e)
                by_slug, coverage = {}, 0.0
            logger.info('MRMS %s: %d point(s), grid coverage %.0f%%',
                        current, len(missing), coverage * 100)
            for slug, df in by_slug.items():
                if df is None or df.empty:
                    continue
                if complete and coverage >= MIN_DAY_COVERAGE:
                    _save_cache(df, slug, current, cache_dir, fetch_cadence_min)
                frames[slug].append(df)
        current += timedelta(days=1)

    out = {}
    for slug, fl in frames.items():
        if not fl:
            out[slug] = pd.DataFrame()
            continue
        df = pd.concat(fl, ignore_index=True)
        df['time_utc'] = pd.to_datetime(df['time_utc'], utc=True, errors='coerce')
        out[slug] = (df.dropna(subset=['time_utc'])
                       .drop_duplicates(subset=['time_utc'])
                       .sort_values('time_utc').reset_index(drop=True))
    return out


def rate_to_row(ts: datetime, rate_mmhr: float) -> dict:
    """One truth row from an MRMS surface rate."""
    if rate_mmhr >= HEAVY_RATE_MMHR:
        cat = 'heavy_rain'
    elif rate_mmhr >= MODERATE_RATE_MMHR:
        cat = 'rain'
    elif rate_mmhr >= RAIN_RATE_MIN_MMHR:
        cat = 'drizzle'          # light tier — same severity as METAR -RA
    else:
        cat = 'clear'
    return {
        'time_utc': ts.isoformat(),
        'rate_mmhr': round(rate_mmhr, 3),
        'precip_in': round(rate_mmhr / 25.4, 4),   # in/hr
        'precip_active': rate_mmhr >= RAIN_RATE_MIN_MMHR,
        'condition_category': cat,
        'has_thunder': None,                        # MRMS has no thunder signal
        'source': 'mrms',
    }


# ── Implementation ───────────────────────────────────────────────────────────

def _day_is_complete(day: date, now: Optional[datetime] = None) -> bool:
    now = now or datetime.now(timezone.utc)
    day_end = datetime(day.year, day.month, day.day, tzinfo=timezone.utc) + timedelta(days=1)
    return now >= day_end + CACHE_SETTLE


def _fetch_day_multi(points: dict, day: date, wgrib2_path: str,
                     cadence_min: int, workers: int):
    """One UTC day of MRMS rates at several points.

    Returns ({slug: DataFrame}, grid_coverage_fraction).
    """
    start = datetime.combine(day, datetime.min.time(), tzinfo=timezone.utc)
    end = start + timedelta(days=1)
    now = datetime.now(timezone.utc)
    if end > now:
        end = now - timedelta(minutes=2)   # don't ask for unpublished grids
    if start >= end:
        return {}, 0.0

    targets = []
    t = start
    while t < end:
        targets.append(_snap_to_mrms_cycle(t))
        t += timedelta(minutes=cadence_min)

    slugs = list(points)
    coords = [points[s] for s in slugs]

    def _one(ts):
        gb = _download_grid_with_fallback(ts, ts.date())
        if gb is None:
            return ts, None
        return ts, _extract_points(gb, coords, wgrib2_path)

    rows = {s: [] for s in slugs}
    found = 0
    with ThreadPoolExecutor(max_workers=max(1, workers)) as ex:
        for ts, vals in ex.map(_one, targets):
            if vals is None:
                continue
            found += 1
            for slug, v in zip(slugs, vals):
                if v is not None:
                    rows[slug].append(rate_to_row(ts, v))
    coverage = found / len(targets) if targets else 0.0
    return {s: pd.DataFrame(r) for s, r in rows.items()}, coverage


def _fetch_day(lat: float, lon: float, day: date,
               wgrib2_path: str, cadence_min: int) -> Optional[pd.DataFrame]:
    """Fetch one day of MRMS rates at a single point (compat shim)."""
    by_slug, _ = _fetch_day_multi({'p': (lat, lon)}, day, wgrib2_path, cadence_min, 1)
    df = by_slug.get('p')
    return df if df is not None and not df.empty else None


def _snap_to_mrms_cycle(ts: datetime) -> datetime:
    """Round down to the nearest 2-min mark (MRMS publish cadence)."""
    return ts.replace(minute=(ts.minute // 2) * 2, second=0, microsecond=0)


def _download_grid_with_fallback(ts: datetime, day: date) -> Optional[bytes]:
    """Try NCEP NOMADS, then the Iowa State archive. Return raw GRIB2 bytes."""
    stamp = ts.strftime('%Y%m%d-%H%M%S')

    # NCEP NOMADS holds the last ~24-48 hours; skip the round-trip for older grids
    gz = None
    if datetime.now(timezone.utc) - ts < timedelta(hours=36):
        gz = _http_get(f'{NCEP_BASE}/MRMS_PrecipRate_00.00_{stamp}.grib2.gz')
    if gz is None:
        # Iowa State mirror for older windows
        # The archive drops the "MRMS_" prefix NCEP uses (verified 2026-10;
        # the prefixed name 404s, so the archive path never worked before).
        archive_url = (
            f'{ARCHIVE_BASE}/{day.year}/{day.month:02d}/{day.day:02d}'
            f'/mrms/ncep/PrecipRate/PrecipRate_00.00_{stamp}.grib2.gz'
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
    """Run wgrib2 to extract the surface rate at (lat, lon) from a GRIB2."""
    vals = _extract_points(grib_bytes, [(lat, lon)], wgrib2_path)
    return vals[0] if vals else None


def _extract_points(grib_bytes: bytes, coords: List, wgrib2_path: str) -> Optional[List]:
    """Rates (mm/hr, or None per point) at several (lat, lon) in one wgrib2 run.

    wgrib2 accepts repeated ``-lon LON LAT`` and prints one
    ``lon=..,lat=..,val=V`` group per point, in order. Returns None if wgrib2
    failed outright.
    """
    with tempfile.NamedTemporaryFile(suffix='.grib2', delete=False) as f:
        f.write(grib_bytes)
        tmp_path = f.name
    try:
        cmd = [wgrib2_path, tmp_path]
        for lat, lon in coords:
            cmd += ['-lon', str(lon), str(lat)]   # longitude first
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            logger.debug('wgrib2 nonzero exit (%d): %s', result.returncode,
                         result.stderr.strip()[:200])
            return None
        raw = WGRIB2_VAL_RE.findall(result.stdout)
        if len(raw) != len(coords):
            return None
        out = []
        for m in raw:
            v = float(m)
            out.append(None if (v >= MISSING_VALUE * 0.9 or v < 0) else v)
        return out
    except subprocess.TimeoutExpired:
        logger.warning('wgrib2 timeout for %d point(s)', len(coords))
        return None
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


# ── Cache (mirror of observations.py pattern) ────────────────────────────────

def _cache_path(slug: str, day: date, cache_dir: str, cadence_min: int) -> str:
    return os.path.join(cache_dir, f'{slug}_{day.isoformat()}__v{CACHE_VERSION}_c{cadence_min}.csv')


def _load_cached(slug: str, day: date, cache_dir: str, cadence_min: int) -> Optional[pd.DataFrame]:
    path = _cache_path(slug, day, cache_dir, cadence_min)
    if os.path.isfile(path):
        try:
            return pd.read_csv(path)
        except Exception:
            return None
    return None


def _save_cache(df: pd.DataFrame, slug: str, day: date, cache_dir: str, cadence_min: int) -> None:
    os.makedirs(cache_dir, exist_ok=True)
    path = _cache_path(slug, day, cache_dir, cadence_min)
    df.to_csv(path + '.tmp', index=False)
    os.replace(path + '.tmp', path)
