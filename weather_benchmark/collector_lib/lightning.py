"""Python lightning module — GOES GLM port.

Two layers:

1. **METAR fallback** (``detect_thunder``) — explicit ``TS`` codes promote
   thunder when GLM is unavailable or out of coverage.
2. **GOES GLM ingestion** (``GlmFetcher`` + ``summarize_lightning_buffer``) —
   a single shared poller downloads GLM L2 LCFA NetCDF files directly from the
   NOAA GOES-East S3 bucket, parses flashes with h5py, and maintains a rolling
   20-minute buffer. Each city summarizes that shared buffer against its own
   lat/lon. This is the Python port of ``src/services/lightning.js``.

PARITY NOTE: ``summarize_lightning_buffer`` is the train/serve-critical
classifier and must match ``summarizeLightningBuffer`` in lightning.js exactly
(distance bands, the >=2-flash "approaching" rule, trend logic). The parity
tests pin this. The S3/NetCDF ingestion is I/O and not unit-tested for parity,
but the classification math it feeds is.
"""

import io
import logging
import math
import re
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional

logger = logging.getLogger('collector.lightning')


def empty_lightning_state() -> Dict:
    """Equivalent to JS _emptyLightningState() — used when GLM is unavailable."""
    return {
        'state': 'none',
        'nearestFlashMi': None,
        'flashCounts': {'within10mi': 0, 'within20mi': 0, 'within40mi': 0},
        'updatedAt': datetime.now(timezone.utc).isoformat(),
        'source': 'unavailable',
        'confidence': 'none',
        'connected': False,
        'bufferAgeMs': None,
        'lastFlashAt': None,
        'trend': None,
    }


def detect_thunder(present_weather: str, text_description: str,
                   radar_dbz: Optional[int]) -> Dict:
    """Port of detectThunder() in src/utils/metarParse.js.

    Args mirror the JS function. ``present_weather`` is the raw wxcodes string
    from IEM ASOS (e.g. "TSRA"), since IEM returns it as a single field rather
    than the parsed METAR object the browser's NWS service produces.
    """
    pw = (present_weather or '').upper()
    if pw:
        # \bTS\b|TSRA|TSSN|TSGS — same regex as JS
        if re.search(r'\bTS\b|TSRA|TSSN|TSGS', pw):
            return {'isThunder': True, 'confidence': 'high', 'source': 'METAR'}

    if text_description and 'thunder' in text_description.lower():
        return {'isThunder': True, 'confidence': 'high', 'source': 'METAR'}

    # Radar + convective METAR fallback
    if radar_dbz is not None and radar_dbz >= 45 and pw:
        if re.search(r'\+RA|GR|GS|SQ', pw):
            return {'isThunder': True, 'confidence': 'med', 'source': 'NEXRAD+METAR'}

    return {'isThunder': False, 'confidence': 'none', 'source': 'none'}


def metar_age_minutes(timestamp_iso: Optional[str]) -> float:
    """Minutes since the METAR was observed. Returns inf if timestamp missing."""
    if not timestamp_iso:
        return float('inf')
    try:
        t = datetime.fromisoformat(timestamp_iso.replace('Z', '+00:00'))
    except (ValueError, AttributeError):
        return float('inf')
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    delta = datetime.now(timezone.utc) - t
    return delta.total_seconds() / 60.0


# ══════════════════════════════════════════════════════════════════════════════
# GOES GLM ingestion — port of src/services/lightning.js
# ══════════════════════════════════════════════════════════════════════════════

# ── Configuration (mirrors LIGHTNING_CFG in lightning.js) ─────────────────────

BUFFER_MAX_AGE_MS = 30 * 60 * 1000      # 30-min rolling window (v0.9.5, was 20)
BAND_10MI_WINDOW = 10 * 60 * 1000       # within 10 mi in last 10 min
BAND_20MI_WINDOW = 15 * 60 * 1000       # within 20 mi in last 15 min
# v0.9.5: 20 -> 30 min. Truth verification (Blitzortung join, 2026-08-20)
# showed the outer ring missed 21% of distant activity at near-zero
# false-alarm cost.
BAND_40MI_WINDOW = 30 * 60 * 1000       # within 40 mi in last 30 min

MILES_PER_DEG_LAT = 69.0

# GOES disk coverage (GOES-East + GOES-West combined)
COVERAGE_LAT_MIN, COVERAGE_LAT_MAX = -52.0, 52.0
COVERAGE_LON_MIN, COVERAGE_LON_MAX = -170.0, -15.0

# S3 direct access (anonymous HTTPS — not behind the IEM rate limiter)
S3_BUCKET_EAST = 'https://noaa-goes19.s3.amazonaws.com'   # GOES-East (G19)
S3_BUCKET_WEST = 'https://noaa-goes18.s3.amazonaws.com'   # GOES-West (G18)
S3_PRODUCT_PREFIX = 'GLM-L2-LCFA'
S3_MAX_FILES_PER_POLL = 5               # cap after time-based filtering
COLD_START_MAX_FILES = 30               # first poll backfills ~10 min of files
# v1.52.0: raised 3 -> 10 min. GOES S3 publication latency sometimes exceeds
# 3 min for hours; the old gate then rejected EVERY file and ingest silently
# starved (measured 23 h outage on 2026-07-16/17 while 'connected' stayed true).
S3_FILE_MAX_AGE_MS = 10 * 60 * 1000     # only fetch files whose embedded ts <= 10 min old
INGEST_STARVED_WARN_MS = 30 * 60 * 1000  # warn when no files ingested this long
S3_FILE_SIZE_CAP = 2 * 1024 * 1024      # skip files > 2 MB
SEEN_FILE_TTL_MS = 60 * 60 * 1000       # forget processed S3 keys after 60 min

FETCH_TIMEOUT_SEC = 15

# h5py is imported lazily so the rest of the collector still runs if it is
# missing (GLM simply stays unavailable, exactly like out-of-coverage).
_h5py = None
_h5py_failed = False


def _load_h5py():
    global _h5py, _h5py_failed
    if _h5py is not None:
        return _h5py
    if _h5py_failed:
        return None
    try:
        import h5py  # noqa: WPS433 (lazy import is intentional)
        _h5py = h5py
        return _h5py
    except ImportError:
        _h5py_failed = True
        logger.warning('h5py not installed — GLM lightning disabled, '
                       'falling back to METAR thunder only')
        return None


# ── Distance / coverage (equirectangular, matches _flashMiles in JS) ──────────

def flash_miles(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    d_lat = (lat2 - lat1) * MILES_PER_DEG_LAT
    avg_lat_rad = math.radians((lat1 + lat2) / 2.0)
    d_lon = (lon2 - lon1) * MILES_PER_DEG_LAT * math.cos(avg_lat_rad)
    return math.sqrt(d_lat * d_lat + d_lon * d_lon)


def in_glm_coverage(lat: float, lon: float) -> bool:
    return (COVERAGE_LAT_MIN <= lat <= COVERAGE_LAT_MAX
            and COVERAGE_LON_MIN <= lon <= COVERAGE_LON_MAX)


# ── Buffer summarization — PARITY-CRITICAL (port of summarizeLightningBuffer) ──

def summarize_lightning_buffer(buffer: List[Dict], lat: float, lon: float,
                               now_ms: float, *, in_coverage: bool = True,
                               last_poll_ok: bool = False,
                               last_flash_at_ms: Optional[float] = None) -> Dict:
    """Classify a flash buffer into a lightning state for one location.

    Pure function of its arguments (no clock, no shared state) so the parity
    test can pin it against the JS reference. ``buffer`` is a list of
    ``{'lat','lon','timeMs','energy'}`` dicts; ``now_ms`` is epoch milliseconds.
    """
    cutoff_10m = now_ms - BAND_10MI_WINDOW
    cutoff_15m = now_ms - BAND_20MI_WINDOW
    cutoff_20m = now_ms - BAND_40MI_WINDOW

    nearest_mi: Optional[float] = None
    within10mi = within20mi = within40mi = 0
    recent_count = prior_count = 0   # 0-10 min vs 10-20 min, any dist <= 40

    for flash in buffer:
        dist = flash_miles(lat, lon, flash['lat'], flash['lon'])
        if dist > 45:
            continue
        t = flash['timeMs']
        if t >= cutoff_20m and (nearest_mi is None or dist < nearest_mi):
            nearest_mi = dist
        if dist <= 10 and t >= cutoff_10m:
            within10mi += 1
        if dist <= 20 and t >= cutoff_15m:
            within20mi += 1
        if dist <= 40 and t >= cutoff_20m:
            within40mi += 1
        if dist <= 40:
            if t >= cutoff_10m:
                recent_count += 1
            else:
                prior_count += 1

    if nearest_mi is not None:
        # JS Math.round is round-half-up; match it for positive distances.
        nearest_mi = int(math.floor(nearest_mi + 0.5))

    state, confidence = 'none', 'none'
    if within10mi > 0:
        state, confidence = 'active', 'high'
    elif within20mi > 0:
        state, confidence = 'nearby', 'medium'
    elif within40mi >= 2:
        # Require >=2 flashes in the 40mi/20min band before declaring
        # "approaching" — a single stale distant flash would otherwise latch
        # the state for up to 20 minutes.
        state, confidence = 'approaching', 'medium'

    trend = None
    if within40mi > 0:
        if recent_count > prior_count + 1:
            trend = 'rising'
        elif recent_count < prior_count * 0.5 and prior_count >= 2:
            trend = 'falling'
        else:
            trend = 'steady'

    provider = 'glm' if in_coverage else 'none'
    if state != 'none':
        source = 'lightning'
    else:
        source = 'none' if provider == 'glm' else 'unavailable'

    return {
        'state': state,
        'nearestFlashMi': nearest_mi,
        'flashCounts': {
            'within10mi': within10mi,
            'within20mi': within20mi,
            'within40mi': within40mi,
        },
        'updatedAt': _ms_to_iso(now_ms),
        'source': source,
        'confidence': confidence,
        'connected': last_poll_ok,
        'bufferAgeMs': (now_ms - last_flash_at_ms) if last_flash_at_ms else None,
        'lastFlashAt': _ms_to_iso(last_flash_at_ms) if last_flash_at_ms else None,
        'trend': trend,
        'provider': provider,
    }


# ── NetCDF (HDF5) parsing — port of _parseGlmNetcdf ───────────────────────────

_GLM_LAT_NAMES = ('flash_lat', 'group_lat', 'event_lat')
_GLM_LON_NAMES = ('flash_lon', 'group_lon', 'event_lon')
_GLM_TIME_NAMES = ('flash_time_offset_of_last_event', 'group_time_offset',
                   'event_time_offset')
_GLM_ENERGY_NAMES = ('flash_energy', 'group_energy', 'event_energy')


def _attr_scalar(ds, name: str, default: float) -> float:
    """Read an HDF5 attribute that may be a 0-d/1-element numpy array."""
    if name not in ds.attrs:
        return default
    val = ds.attrs[name]
    try:
        return float(val.item() if hasattr(val, 'item') else val[0]
                     if hasattr(val, '__len__') else val)
    except (TypeError, ValueError, IndexError):
        return default


def _read_scaled(f, names):
    """Probe candidate dataset names; return a float64 array with
    scale_factor/add_offset applied, or None if none present."""
    import numpy as np
    for name in names:
        if name in f:
            ds = f[name]
            raw = np.asarray(ds[:], dtype='f8')
            if raw.size == 0:
                continue
            sf = _attr_scalar(ds, 'scale_factor', 1.0)
            ao = _attr_scalar(ds, 'add_offset', 0.0)
            if sf != 1.0 or ao != 0.0:
                raw = raw * sf + ao
            return raw, name
    return None, None


def _ref_time_ms(f, fallback_ms: float) -> float:
    val = f.attrs.get('time_coverage_start')
    if val is None:
        return fallback_ms
    if isinstance(val, bytes):
        val = val.decode('utf-8', 'ignore')
    try:
        s = str(val).strip().replace('Z', '+00:00')
        t = datetime.fromisoformat(s)
        if t.tzinfo is None:
            t = t.replace(tzinfo=timezone.utc)
        return t.timestamp() * 1000.0
    except (ValueError, TypeError):
        return fallback_ms


def parse_glm_netcdf(file_bytes: bytes, now_ms: float) -> List[Dict]:
    """Parse a GLM L2 LCFA NetCDF (HDF5) file → list of flash dicts."""
    h5 = _load_h5py()
    if h5 is None:
        return []
    flashes: List[Dict] = []
    with h5.File(io.BytesIO(file_bytes), 'r') as f:
        ref_ms = _ref_time_ms(f, now_ms)
        lats, lat_name = _read_scaled(f, _GLM_LAT_NAMES)
        lons, _ = _read_scaled(f, _GLM_LON_NAMES)
        if lats is None or lons is None:
            return []
        offsets, _ = _read_scaled(f, _GLM_TIME_NAMES)
        energies, _ = _read_scaled(f, _GLM_ENERGY_NAMES)
        n = min(len(lats), len(lons))
        for i in range(n):
            la, lo = lats[i], lons[i]
            if not (math.isfinite(la) and math.isfinite(lo)):
                continue
            off = offsets[i] if (offsets is not None and i < len(offsets)) else 0.0
            t_ms = ref_ms + (off * 1000.0 if math.isfinite(off) else 0.0)
            energy = (float(energies[i]) if (energies is not None
                      and i < len(energies) and math.isfinite(energies[i]))
                      else None)
            flashes.append({'lat': float(la), 'lon': float(lo),
                            'timeMs': t_ms, 'energy': energy})
    return flashes


# ── S3 listing helpers ────────────────────────────────────────────────────────

def _build_s3_list_url(bucket: str, utc: datetime) -> str:
    ddd = f'{utc.timetuple().tm_yday:03d}'
    prefix = f'{S3_PRODUCT_PREFIX}/{utc.year}/{ddd}/{utc:%H}/'
    return f'{bucket}/?list-type=2&prefix={prefix}'


def _parse_s3_listing(xml_text: str):
    """Return [(key, size)] from an S3 ListBucketResult XML body."""
    out = []
    for block in re.findall(r'<Contents>(.*?)</Contents>', xml_text, re.S):
        k = re.search(r'<Key>([^<]+)</Key>', block)
        s = re.search(r'<Size>(\d+)</Size>', block)
        if k:
            out.append((k.group(1), int(s.group(1)) if s else 0))
    out.sort(key=lambda kv: kv[0])
    return out


def extract_file_timestamp_ms(key: str) -> Optional[float]:
    """Embedded start time from a GLM filename → epoch ms.
    Pattern: ..._sYYYYDDDHHMMSSt..._e..._c....nc (14-digit start field)."""
    m = re.search(r'_s(\d{14})', key)
    if not m:
        return None
    s = m.group(1)
    yyyy, ddd = int(s[0:4]), int(s[4:7])
    hh, mm, ss, tenths = int(s[7:9]), int(s[9:11]), int(s[11:13]), int(s[13])
    base = datetime(yyyy, 1, 1, tzinfo=timezone.utc)
    t = base + timedelta(days=ddd - 1, hours=hh, minutes=mm, seconds=ss,
                         milliseconds=tenths * 100)
    return t.timestamp() * 1000.0


# ── Shared GLM fetcher ────────────────────────────────────────────────────────

class GlmFetcher:
    """One shared GLM poller for all cities.

    A single GOES LCFA file spans the whole satellite disk, so one download per
    poll serves every city. The fetcher keeps a global rolling 20-min flash
    buffer; each ``CityWorker`` calls :meth:`summarize` with its own lat/lon.
    Thread-safe: the poll loop and the worker reads share ``_lock``.
    """

    def __init__(self, config: Dict, session=None):
        import requests
        self.poll_interval = config.get('glm_poll_interval_sec', 60)
        sat = (config.get('glm_satellite') or 'east').lower()
        self.bucket = S3_BUCKET_WEST if sat == 'west' else S3_BUCKET_EAST
        self.session = session or requests.Session()
        self._last_ingest_ms: Optional[float] = time.time() * 1000.0  # watchdog baseline
        self._buffer: List[Dict] = []
        self._dedup = set()
        self._seen_files: Dict[str, float] = {}
        self._last_poll_ok = False
        self._last_flash_at_ms: Optional[float] = None
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self.stats = {'polls': 0, 'files': 0, 'flashes': 0, 'errors': 0}

    # -- lifecycle --
    def start(self):
        if _load_h5py() is None:
            logger.warning('GLM fetcher not started (h5py unavailable)')
            return
        self._thread = threading.Thread(target=self._run, name='glm-fetcher',
                                        daemon=True)
        self._thread.start()
        logger.info('GLM fetcher started (bucket=%s, interval=%ds)',
                    self.bucket, self.poll_interval)

    def stop(self, timeout: float = 5.0):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=timeout)

    def _run(self):
        # Poll immediately, then every interval until stopped.
        while not self._stop.is_set():
            try:
                self.poll_once()
            except Exception:
                logger.exception('GLM poll error')
                self.stats['errors'] += 1
            self._stop.wait(self.poll_interval)

    # -- polling --
    def poll_once(self) -> int:
        """Run one S3 list+download cycle; return flashes ingested. Synchronous
        (used by the poll loop and by ``collector.py --once``)."""
        now_ms = time.time() * 1000.0
        self.stats['polls'] += 1
        ok, files = self._list_recent(now_ms)
        new_flashes: List[Dict] = []
        for key, _size in files:
            try:
                resp = self.session.get(f'{self.bucket}/{key}',
                                        timeout=FETCH_TIMEOUT_SEC)
                if resp.status_code != 200:
                    continue
                new_flashes.extend(parse_glm_netcdf(resp.content, now_ms))
                self.stats['files'] += 1
                with self._lock:
                    self._seen_files[key] = now_ms
            except Exception:
                continue
        with self._lock:
            self._last_poll_ok = ok
            self._update_buffer(new_flashes, now_ms)
            self._prune_seen(now_ms)
        self.stats['flashes'] += len(new_flashes)
        if new_flashes:
            logger.info('GLM: +%d flash(es) from %d file(s)',
                        len(new_flashes), len(files))
            self._last_ingest_ms = now_ms
        else:
            # Starvation watchdog: listing keeps succeeding but nothing ingests.
            # This is the silent-outage mode measured on 2026-07-16/17.
            last = getattr(self, '_last_ingest_ms', None)
            if last is not None and (now_ms - last) > INGEST_STARVED_WARN_MS:
                logger.warning('GLM ingest starved: no files ingested for %.0f min '
                               '(listing ok=%s) — resetting HTTP session',
                               (now_ms - last) / 60000, ok)
                import requests
                self.session = requests.Session()
                self._last_ingest_ms = now_ms  # re-arm so we warn every 30 min, not every poll
        return len(new_flashes)

    def _list_recent(self, now_ms: float):
        """List the current (and, if needed, previous) UTC hour and filter to
        unseen, recent, size-capped files. Returns (listing_ok, [(key,size)]).
        The first poll backfills up to COLD_START_MAX_FILES (~10 min) so the
        band windows are populated immediately — parity with the app's
        cold-start backfill (v0.9.5)."""
        cold_start = self.stats['polls'] <= 1
        cap = COLD_START_MAX_FILES if cold_start else S3_MAX_FILES_PER_POLL
        now = datetime.now(timezone.utc)
        ok, usable = self._list_and_filter(now, now_ms)
        if ok and (not usable or (cold_start and len(usable) < cap)):
            prev = now - timedelta(hours=1)
            ok2, prev_usable = self._list_and_filter(prev, now_ms)
            ok = ok and ok2
            usable = prev_usable + usable
        # Cap at the most recent N files.
        return ok, usable[-cap:]

    def _list_and_filter(self, utc: datetime, now_ms: float):
        url = _build_s3_list_url(self.bucket, utc)
        try:
            resp = self.session.get(url, timeout=FETCH_TIMEOUT_SEC)
            if resp.status_code != 200:
                return False, []
            entries = _parse_s3_listing(resp.text)
        except Exception:
            return False, []
        cutoff = now_ms - S3_FILE_MAX_AGE_MS
        unseen = [(k, s) for k, s in entries
                  if k not in self._seen_files and s <= S3_FILE_SIZE_CAP]
        usable = []
        for key, size in unseen:
            ts = extract_file_timestamp_ms(key)
            if ts is not None and ts >= cutoff:
                usable.append((key, size))
        if not usable and unseen:
            # Latency fallback: everything is "too old" (S3 publication lag) —
            # take the newest unseen file so ingest degrades to laggy, not dead.
            usable = unseen[-1:]
        return True, usable

    # -- buffer --
    @staticmethod
    def _flash_key(flash: Dict) -> str:
        # math.floor(x + 0.5) matches JS Math.round (half-up) for positive ms;
        # Python's built-in round() is banker's rounding and would diverge at
        # exact .5 bucket boundaries.
        bucket = math.floor(flash['timeMs'] / 5000 + 0.5)
        return f"{flash['lat']:.2f}_{flash['lon']:.2f}_{bucket}"

    def _update_buffer(self, flashes: List[Dict], now_ms: float):
        for f in flashes:
            la, lo = f.get('lat'), f.get('lon')
            if la is None or lo is None or not (math.isfinite(la) and math.isfinite(lo)):
                continue
            if f['timeMs'] > now_ms + 60000:   # reject future timestamps
                continue
            key = self._flash_key(f)
            if key in self._dedup:
                continue
            self._dedup.add(key)
            self._buffer.append(f)
            if self._last_flash_at_ms is None or f['timeMs'] > self._last_flash_at_ms:
                self._last_flash_at_ms = f['timeMs']
        self._prune_buffer(now_ms)

    def _prune_buffer(self, now_ms: float):
        cutoff = now_ms - BUFFER_MAX_AGE_MS
        self._buffer = [f for f in self._buffer if f['timeMs'] >= cutoff]
        self._dedup = {self._flash_key(f) for f in self._buffer}

    def _prune_seen(self, now_ms: float):
        cutoff = now_ms - SEEN_FILE_TTL_MS
        self._seen_files = {k: v for k, v in self._seen_files.items()
                            if v >= cutoff}

    # -- per-city summary --
    def summarize(self, lat: float, lon: float) -> Dict:
        """Lightning state for one location from the shared buffer."""
        if not in_glm_coverage(lat, lon):
            return empty_lightning_state()
        now_ms = time.time() * 1000.0
        with self._lock:
            self._prune_buffer(now_ms)
            buf = list(self._buffer)
            ok = self._last_poll_ok
            last_flash = self._last_flash_at_ms
        return summarize_lightning_buffer(
            buf, lat, lon, now_ms, in_coverage=True,
            last_poll_ok=ok, last_flash_at_ms=last_flash,
        )


def _ms_to_iso(ms: Optional[float]) -> Optional[str]:
    if ms is None:
        return None
    return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc).isoformat()
