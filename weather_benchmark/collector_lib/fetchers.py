"""HTTP fetchers for IEM tiles, IEM ASOS observations, Open-Meteo.

All IEM calls are gated through the shared token-bucket rate limiter to avoid
429s. Each fetcher has its own retry-with-backoff for transient failures.

IEM ASOS and Open-Meteo go through ``_SESSION`` (urllib3 Retry on connection
errors and 429/5xx). When a fetch still fails, the last good response for the
same station / point is reused if it is <= ``STALE_FALLBACK_MAX_SEC`` old; the
returned dict then carries ``_stale = {'ageMin': ..}`` so the record can be
marked (record_builder ``_staleSources``). Per-source ok/fail/stale counts live
in ``SOURCE_STATS`` for the collector heartbeat.
"""

import copy
import io
import threading
import time
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from PIL import Image

from .rate_limiter import TokenBucket

logger = logging.getLogger(__name__)

IEM_TILE_BASE = 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0'
IEM_ASOS_URL  = 'https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py'
OM_FORECAST   = 'https://api.open-meteo.com/v1/forecast'
RAINVIEWER_MAPS = 'https://api.rainviewer.com/public/weather-maps.json'

# Shared by all city workers (requests.Session is safe for concurrent GETs).
# backoff_factor=1 -> sleeps of ~1, 2, 4 s between attempts, which also keeps
# ASOS retries near IEM's ~1 req/s budget. raise_on_status=False hands the
# final 429/5xx back so raise_for_status() reports it.
_RETRY = Retry(total=3, backoff_factor=1,
               status_forcelist=[429, 500, 502, 503, 504],
               allowed_methods=frozenset(['GET']),
               raise_on_status=False)
_SESSION = requests.Session()
_SESSION.mount('https://', HTTPAdapter(max_retries=_RETRY, pool_maxsize=16))
_SESSION.mount('http://', HTTPAdapter(max_retries=_RETRY, pool_maxsize=16))

STALE_FALLBACK_MAX_SEC = 60 * 60
_last_good = {}            # cache key -> (response dict, time.time() when fetched)
_last_good_lock = threading.Lock()

SOURCE_STATS = {}          # source -> {'ok','fail','stale','lastOkUtc','lastFailUtc'}
_stats_lock = threading.Lock()


def _count(source: str, outcome: str) -> None:
    """outcome: 'ok' | 'fail' | 'stale' (a failure served from the stale cache)."""
    now = datetime.now(timezone.utc).isoformat(timespec='seconds')
    with _stats_lock:
        st = SOURCE_STATS.setdefault(source, {'ok': 0, 'fail': 0, 'stale': 0,
                                              'lastOkUtc': None, 'lastFailUtc': None})
        st[outcome] += 1
        if outcome == 'ok':
            st['lastOkUtc'] = now
        else:
            st['lastFailUtc'] = now


def source_stats_snapshot() -> dict:
    with _stats_lock:
        return copy.deepcopy(SOURCE_STATS)


def _remember(key, value: dict) -> None:
    with _last_good_lock:
        _last_good[key] = (value, time.time())


def _stale_fallback(source: str, key) -> Optional[dict]:
    """Last good response for ``key`` if young enough, tagged ``_stale``."""
    with _last_good_lock:
        hit = _last_good.get(key)
    if hit:
        age = time.time() - hit[1]
        if age <= STALE_FALLBACK_MAX_SEC:
            _count(source, 'stale')
            out = dict(hit[0])
            out['_stale'] = {'ageMin': round(age / 60.0, 1)}
            return out
    _count(source, 'fail')
    return None


_rv_maps_cache = {'data': None, 'ts': 0.0}
_RV_MAPS_TTL_SEC = 5 * 60

# Same fields as observations.py — keep in sync if changed there
IEM_DATA_FIELDS = 'tmpf,dwpf,relh,drct,sknt,gust,p01i,vsby,wxcodes,metar,skyc1,skyc2,skyc3,skyc4'


def fetch_iem_tile(timestamp: str, z: int, x: int, y: int,
                   limiter: TokenBucket, retries: int = 3) -> Optional[Image.Image]:
    """Fetch a single IEM NEXRAD tile as a PIL Image. Returns None on failure."""
    url = f'{IEM_TILE_BASE}/ridge::USCOMP-N0Q-{timestamp}/{z}/{x}/{y}.png'
    for attempt in range(retries):
        if not limiter.acquire():
            logger.warning('Rate limiter timeout for IEM tile %s', url)
            return None
        try:
            r = requests.get(url, timeout=15)
            if r.status_code == 429:
                wait = 5 * (2 ** attempt)
                logger.warning('IEM tile rate-limited (429); waiting %ds', wait)
                time.sleep(wait)
                continue
            r.raise_for_status()
            img = Image.open(io.BytesIO(r.content)).convert('RGBA')
            _count('iem_tile', 'ok')
            return img
        except Exception as e:
            logger.debug('IEM tile %s/%s/%s @ %s failed: %s',
                         z, x, y, timestamp, e)
            time.sleep(1.0)
    _count('iem_tile', 'fail')
    return None


def fetch_rainviewer_maps() -> Optional[dict]:
    """Fetch (and cache for 5 min) the RainViewer weather-maps index.
    Mirrors _fetchRainViewerMaps (JS). Contains radar.past + radar.nowcast."""
    now = time.time()
    if _rv_maps_cache['data'] and (now - _rv_maps_cache['ts']) < _RV_MAPS_TTL_SEC:
        return _rv_maps_cache['data']
    try:
        r = requests.get(RAINVIEWER_MAPS, timeout=15)
        r.raise_for_status()
        data = r.json()
        _rv_maps_cache['data'] = data
        _rv_maps_cache['ts'] = now
        return data
    except Exception as e:
        logger.warning('RainViewer maps fetch failed: %s', e)
        return None


def fetch_rv_tile(host: str, path: str, z: int, x: int, y: int,
                  limiter: Optional[TokenBucket] = None,
                  retries: int = 2) -> Optional[Image.Image]:
    """Fetch a RainViewer radar tile in color scheme 0 (raw dBZ grayscale,
    no smoothing) — decoded by _rv_raw_to_dbz. Matches the JS rvRaw URL."""
    url = f'{host}{path}/256/{z}/{x}/{y}/0/0_0.png'
    for attempt in range(retries):
        if limiter is not None and not limiter.acquire():
            logger.warning('Rate limiter timeout for RV tile %s', url)
            return None
        try:
            r = requests.get(url, timeout=15)
            if r.status_code == 429:
                time.sleep(3 * (2 ** attempt))
                continue
            r.raise_for_status()
            return Image.open(io.BytesIO(r.content)).convert('RGBA')
        except Exception as e:
            logger.debug('RV tile %s/%s/%s failed: %s', z, x, y, e)
            time.sleep(1.0)
    return None


def fetch_iem_latest_metar(station: str, limiter: TokenBucket) -> Optional[dict]:
    """Pull the most recent METAR for a station from IEM ASOS.

    Returns a dict with stationId + obs subfields shaped like the browser's
    ``fetchStationObservation`` output, or None if unavailable.
    """
    key = ('iem_asos', station)
    if not limiter.acquire():
        logger.warning('Rate limiter timeout for IEM ASOS %s', station)
        return _stale_fallback('iem_asos', key)
    # IEM ASOS endpoint — pull last 90 min, take the freshest row
    now = datetime.now(timezone.utc)
    start = now - timedelta(minutes=90)
    params = {
        'station':  station.lstrip('K'),  # ASOS endpoint uses 3-letter for US stations
        'data':     IEM_DATA_FIELDS,
        'year1':    start.year, 'month1': start.month, 'day1': start.day,
        'hour1':    start.hour, 'minute1': start.minute,
        'year2':    now.year,   'month2': now.month,   'day2': now.day,
        'hour2':    now.hour,   'minute2': now.minute,
        'tz':       'UTC',
        'format':   'onlycomma',
        'latlon':   'no',
        'direct':   'no',
        # v1.52.0: '1' (5-min feed) returns rows with wxcodes='M' — thunder and
        # virga signals starved. '3,4' = routine + special METARs with wxcodes.
        'report_type': '3,4',
    }
    try:
        r = _SESSION.get(IEM_ASOS_URL, params=params, timeout=15)
        if r.status_code == 429:
            logger.warning('IEM ASOS rate-limited for %s (after retries)', station)
            return _stale_fallback('iem_asos', key)
        r.raise_for_status()
    except Exception as e:
        logger.warning('IEM ASOS fetch failed for %s: %s', station, e)
        return _stale_fallback('iem_asos', key)

    lines = [ln for ln in r.text.strip().split('\n') if ln and not ln.startswith('#')]
    if len(lines) < 2:
        # Reachable but no METAR in the last 90 min: a real answer, not a
        # transport failure, so no stale fallback.
        _count('iem_asos', 'ok')
        return None
    header = lines[0].split(',')
    rows = [ln.split(',') for ln in lines[1:]]
    if not rows:
        return None
    last = rows[-1]
    obs = dict(zip(header, last))

    # Normalize into the shape the JS uses
    result = _normalize_metar(station, obs)
    _count('iem_asos', 'ok')
    _remember(key, result)
    return result


def _normalize_metar(station: str, row: dict) -> dict:
    """Shape an IEM ASOS row into the obs object the nowcast layer expects.

    Returns the same dict shape as the browser's fetchStationObservation:
      { stationId, obs: { timestamp, temperature_c, humidity, presentWeather,
                          textDescription, ... } }
    """
    def _f(key):
        v = row.get(key, '').strip()
        if v in ('', 'M', 'T'):
            return None
        try:
            return float(v)
        except ValueError:
            return None

    # Build ISO timestamp
    valid = row.get('valid', '').strip()  # 'YYYY-MM-DD HH:MM'
    if valid:
        try:
            ts = datetime.strptime(valid, '%Y-%m-%d %H:%M').replace(tzinfo=timezone.utc)
            iso = ts.isoformat()
        except ValueError:
            iso = None
    else:
        iso = None

    tmpf = _f('tmpf')
    dwpf = _f('dwpf')
    temp_c = (tmpf - 32) * 5.0 / 9.0 if tmpf is not None else None
    dew_c  = (dwpf - 32) * 5.0 / 9.0 if dwpf is not None else None

    return {
        'stationId': station,
        'obs': {
            'timestamp':       iso,
            'temperature_c':   temp_c,
            'dewpoint_c':      dew_c,
            'humidity':        _f('relh'),
            'wind_speed_kt':   _f('sknt'),
            'wind_dir':        _f('drct'),
            'pressure_mb':     None,  # IEM ASOS doesn't expose pressure in this call
            'visibility_mi':   _f('vsby'),
            'presentWeather':  (row.get('wxcodes', '') or '').strip(),
            'textDescription': (row.get('skyc1', '') or '').strip(),
            'metar':           (row.get('metar', '') or '').strip(),
            'precip_1h_in':    _f('p01i'),
        },
    }


def fetch_open_meteo(lat: float, lon: float, want_hourly: bool = False) -> Optional[dict]:
    """Fetch Open-Meteo current weather (+ optional hourly). Returns shaped dict."""
    params = {
        'latitude':  lat,
        'longitude': lon,
        'current':   'weather_code,temperature_2m,relative_humidity_2m,dew_point_2m,'
                     'apparent_temperature,precipitation,cloud_cover,wind_speed_10m,'
                     'wind_direction_10m,pressure_msl,surface_pressure',
        'temperature_unit': 'fahrenheit',
        'wind_speed_unit':  'mph',
        # v1.53.0 parity fix: the browser fetches precipitation in INCHES but
        # the collector was defaulting to mm — om_precip_in_hr thresholds
        # (0.005/0.01 in) in the dry-veto logic were effectively 25× off.
        'precipitation_unit': 'inch',
        'timezone':         'UTC',
    }
    if want_hourly:
        params['hourly'] = ('weather_code,temperature_2m,precipitation_probability,'
                            'precipitation,cloud_cover,'
                            'wind_speed_700hPa,wind_direction_700hPa')
        params['minutely_15'] = 'precipitation'
        params['forecast_minutely_15'] = 8
        params['forecast_days'] = 1

    key = ('open_meteo', lat, lon, bool(want_hourly))
    try:
        r = _SESSION.get(OM_FORECAST, params=params, timeout=15)
        r.raise_for_status()
        data = r.json()
    except Exception as e:
        logger.warning('Open-Meteo fetch failed for (%s, %s): %s', lat, lon, e)
        return _stale_fallback('open_meteo', key)
    _count('open_meteo', 'ok')
    _remember(key, data)
    return data


def extract_model_context(om_response: dict) -> Optional[dict]:
    """Map Open-Meteo `current` block to the record schema's `model` object."""
    if not om_response or 'current' not in om_response:
        return None
    c = om_response['current']
    return {
        'weatherCode':   c.get('weather_code'),
        'precipProb':    None,  # not in current; available in hourly only
        'precipitation': c.get('precipitation'),
        'cloudCover':    c.get('cloud_cover'),
        'temp':          c.get('temperature_2m'),
        'dewpoint':      c.get('dew_point_2m'),
        'humidity':      c.get('relative_humidity_2m'),
        'windSpeed':     c.get('wind_speed_10m'),
        'windDir':       c.get('wind_direction_10m'),
        'pressure':      c.get('pressure_msl') or c.get('surface_pressure'),
    }


def extract_hourly_context(om_response: dict) -> Optional[list]:
    """Map Open-Meteo `hourly` block to a list of hourly snapshots."""
    if not om_response or 'hourly' not in om_response:
        return None
    h = om_response['hourly']
    times = h.get('time') or []
    rows = []
    for i, t in enumerate(times):
        rows.append({
            'time':          t,
            'weatherCode':   _idx(h.get('weather_code'), i),
            'temp':          _idx(h.get('temperature_2m'), i),
            'precipProb':    _idx(h.get('precipitation_probability'), i),
            'precipitation': _idx(h.get('precipitation'), i),
            'cloudCover':    _idx(h.get('cloud_cover'), i),
        })
    return rows


def _idx(lst, i):
    try:
        return lst[i] if lst is not None else None
    except (IndexError, TypeError):
        return None
