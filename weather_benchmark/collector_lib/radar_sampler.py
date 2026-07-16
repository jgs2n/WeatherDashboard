"""Python port of src/services/radarSampler.js.

PARITY NOTE: this is the canonical Python equivalent of the browser-side radar
sampler. Any change to the JS must be mirrored here and pass the parity test
(weather_benchmark/tests/test_collector_parity.py). See CLAUDE.md.

Key differences from the JS module:
  - State is per-city (RadarSampler instance per location), not global.
    The JS module-level state corrupts multi-city sampling; this is the
    primary motivation for the Python port.
  - PIL.Image replaces HTML canvas pixel access.
  - Tile fetching is delegated to fetchers.fetch_iem_tile so the rate limiter
    can see every call.
"""

import math
import time
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional, List, Dict, Tuple

from .fetchers import fetch_iem_tile
from .rate_limiter import TokenBucket

logger = logging.getLogger(__name__)

# ── Configuration (must match RADAR_CFG in radarSampler.js) ──────────────────
RADAR_CFG = {
    'ZOOM': 6,
    'TILE_SIZE': 256,
    'ON_THRESHOLD': 22,             # v1.44.0 raised from 18
    'OFF_THRESHOLD': 12,
    'ON_CONFIRM_FRAMES': 2,
    'OFF_HOLD_MS': 8 * 60 * 1000,
    'NULL_DECAY_MS': 5 * 60 * 1000,
    'THUNDER_DBZ': 45,
    'FRAME_COUNT': 10,
    'EDGE_MARGIN': 5,
    'NEIGHBORHOOD_RADIUS': 1,
    'MIN_VALID_PIXELS': 2,
    'MAX_COLOR_DIST': 12000,
    'SLOPE_FRAMES': 6,
    'MIN_SLOPE_DBZ': 2,
    'MOTION_GRID': 9,           # binary correlation grid size (9×9)
    'MOTION_MAX_SHIFT': 4,      # ± cells searched — resolves ~107 km/h at 5-min cadence
    'MOTION_MIN_OVERLAP': 3,    # min overlap score to accept a shift
    'EDGE_STEP_KM': 2,              # upstream march step (~1 px at zoom 6)
    'EDGE_MAX_LOOKAHEAD_MIN': 60,   # don't predict past the hour
    'EDGE_MAX_RANGE_KM': 120,       # march distance cap
    'EDGE_WET_RUN_SAMPLES': 2,      # sustained-wet run to declare leading edge
    'EDGE_DRY_GAP_SAMPLES': 4,      # ~8 km sustained dry to declare trailing edge
    'EDGE_DRY_DBZ': 15,             # below this counts as dry for trailing edge
    'EDGE_LATERAL_KM': 3,           # ± km perpendicular spread for track check
    'BEGIN_SIGNAL_DBZ': 18,
    'END_SIGNAL_DBZ': 30,
}

# Intensity classes — must match _INTENSITY_CLASSES in radarSampler.js
_INTENSITY_CLASSES = [
    {'r':   0, 'g':   0, 'b':   0, 'dbz': -999},
    {'r':   0, 'g': 236, 'b': 236, 'dbz':   5},
    {'r':   1, 'g': 160, 'b': 246, 'dbz':  10},
    {'r':   0, 'g':   0, 'b': 246, 'dbz':  15},
    {'r':   0, 'g': 255, 'b':   0, 'dbz':  20},
    {'r':   0, 'g': 200, 'b':   0, 'dbz':  25},
    {'r':   0, 'g': 144, 'b':   0, 'dbz':  30},
    {'r': 255, 'g': 255, 'b':   0, 'dbz':  35},
    {'r': 231, 'g': 192, 'b':   0, 'dbz':  40},
    {'r': 255, 'g': 144, 'b':   0, 'dbz':  45},
    {'r': 255, 'g':   0, 'b':   0, 'dbz':  50},
    {'r': 214, 'g':   0, 'b':   0, 'dbz':  55},
    {'r': 192, 'g':   0, 'b': 192, 'dbz':  60},
]


# ── Tile math (slippy map) ───────────────────────────────────────────────────

def _lat_lon_to_tile(lat: float, lon: float, zoom: int):
    n = 2 ** zoom
    tile_x = int((lon + 180.0) / 360.0 * n)
    lat_rad = math.radians(lat)
    y = (1.0 - math.log(math.tan(lat_rad) + 1.0 / math.cos(lat_rad)) / math.pi) / 2.0
    tile_y = int(y * n)
    x_frac = (lon + 180.0) / 360.0 * n - tile_x
    y_frac = y * n - tile_y
    px_x = int(x_frac * RADAR_CFG['TILE_SIZE'])
    px_y = int(y_frac * RADAR_CFG['TILE_SIZE'])
    return tile_x, tile_y, px_x, px_y


# ── Color to dBZ ─────────────────────────────────────────────────────────────

def _is_radar_candidate(r, g, b, a) -> bool:
    if a < 180:
        return False
    bright = (r + g + b) / 3
    sat = max(r, g, b) - min(r, g, b)
    if bright > 240 and sat < 30:
        return False
    if bright < 15:
        return False
    if abs(r - g) <= 12 and abs(r - b) <= 12 and abs(g - b) <= 12:
        return False
    return True


def _color_to_dbz(r, g, b, a) -> Optional[int]:
    if a < 20:
        return None
    if not _is_radar_candidate(r, g, b, a):
        return None
    best_dist = float('inf')
    best_dbz = -999
    for c in _INTENSITY_CLASSES[1:]:  # skip class 0 (no-data)
        d = (r - c['r']) ** 2 + (g - c['g']) ** 2 + (b - c['b']) ** 2
        if d < best_dist:
            best_dist = d
            best_dbz = c['dbz']
    if best_dist > RADAR_CFG['MAX_COLOR_DIST']:
        return None
    return best_dbz


def _sample_neighborhood(img, px_x: int, px_y: int, radius: int) -> Optional[int]:
    """Sample a (2r+1)×(2r+1) neighborhood, return median dBZ or None."""
    tile = RADAR_CFG['TILE_SIZE']
    x0 = max(0, px_x - radius)
    y0 = max(0, px_y - radius)
    x1 = min(tile - 1, px_x + radius)
    y1 = min(tile - 1, px_y + radius)
    valid = []
    pixels = img.load()
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            p = pixels[x, y]
            if len(p) == 4:
                r, g, b, a = p
            else:
                r, g, b = p
                a = 255
            dbz = _color_to_dbz(r, g, b, a)
            if dbz is not None:
                valid.append(dbz)
    if len(valid) < RADAR_CFG['MIN_VALID_PIXELS']:
        return None
    valid.sort()
    mid = len(valid) // 2
    if len(valid) % 2 == 0:
        return round((valid[mid - 1] + valid[mid]) / 2)
    return valid[mid]


def _iem_timestamps(count: int) -> List[Tuple[str, int]]:
    """Generate (YYYYMMDDHHMM, unix_seconds) tuples for the last N 5-min frames."""
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    # Round down to nearest 5 min
    now = now.replace(minute=(now.minute // 5) * 5)
    out = []
    for i in range(count):
        t = now - timedelta(minutes=i * 5)
        ts = t.strftime('%Y%m%d%H%M')
        out.append((ts, int(t.timestamp())))
    return out


# ── Per-city sampler ─────────────────────────────────────────────────────────

class RadarSampler:
    """Per-city radar state: hysteresis, history, motion estimate.

    Construct one instance per location and call ``sample()`` on the polling
    schedule. State persists across calls (just like the JS module-level state
    persists across polls in the browser).
    """

    def __init__(self, lat: float, lon: float, limiter: TokenBucket):
        self.lat = lat
        self.lon = lon
        self._limiter = limiter
        self._frames: List[Dict] = []           # [{ timestamp, dbz, source }]
        self._rain_state = 'OFF'
        self._last_on_time: Optional[float] = None
        self._last_valid_dbz_time: Optional[float] = None
        self._pending_on_count = 0
        self._history_loaded = False
        # Per-poll tile cache, keyed by (timestamp, z, x, y). One zoom-6 tile
        # spans ~600 km, so motion-grid and upstream samples mostly hit the same
        # tile — caching collapses ~75 redundant fetches/poll into a handful.
        # Cleared at the start of every sample() so each poll fetches fresh tiles.
        self._tile_cache: Dict = {}

    # ── Public surface ────────────────────────────────────────────────────

    def sample(self) -> Optional[Dict]:
        """Sample latest frame; advance hysteresis; return state dict."""
        self._tile_cache = {}   # fresh tiles each poll
        if not self._history_loaded:
            self._load_history()

        stamps = _iem_timestamps(1)
        if not stamps:
            return None
        ts_str, ts_unix = stamps[0]

        dbz = self._sample_frame(ts_unix, ts_str)
        self._process_frame(ts_unix, dbz)

        self._frames.append({'timestamp': ts_unix, 'dbz': dbz, 'source': 'NEXRAD'})
        if len(self._frames) > RADAR_CFG['FRAME_COUNT']:
            self._frames = self._frames[-RADAR_CFG['FRAME_COUNT']:]

        is_raining = self._rain_state in ('ON', 'HOLDING')
        return {
            'dbz': dbz,
            'isRaining': is_raining,
            'rainState': self._rain_state,
            'timestamp': datetime.fromtimestamp(ts_unix, timezone.utc).isoformat(),
            'source': 'NEXRAD',
            'lastValidDbzTime': (datetime.fromtimestamp(self._last_valid_dbz_time / 1000, timezone.utc).isoformat()
                                 if self._last_valid_dbz_time else None),
        }

    def estimate_motion(self) -> Optional[Dict]:
        """Coarse correlation-based motion vector with sub-cell refinement.

        Mirrors estimateMotionVector (JS, v1.46.0): 9×9 grid, ±4-cell search
        (resolves ~107 km/h; the old 5×5/±2 saturated at ~53 km/h), parabolic
        sub-cell peak interpolation, per-pair intervals from frame timestamps.
        Returns None if inconsistent.
        """
        if len(self._frames) < 3:
            return None

        recent = self._frames[-3:]
        with_data = [f for f in recent if f['dbz'] is not None]
        if len(with_data) < 2:
            return None

        grid_size = RADAR_CFG['MOTION_GRID']
        max_shift = RADAR_CFG['MOTION_MAX_SHIFT']
        grid_spacing_deg = 0.02   # collector is IEM-only (5-min cadence)
        half = grid_size // 2
        grids = []
        for frame in recent:
            grid = []
            ts_unix = frame['timestamp']
            t = datetime.fromtimestamp(ts_unix, timezone.utc)
            ts_str = t.strftime('%Y%m%d%H%M')
            for gy in range(grid_size):
                for gx in range(grid_size):
                    g_lat = self.lat + (gy - half) * grid_spacing_deg
                    g_lon = self.lon + (gx - half) * grid_spacing_deg
                    d = self._sample_frame_at(g_lat, g_lon, ts_str)
                    grid.append(1 if (d is not None and d >= RADAR_CFG['OFF_THRESHOLD']) else 0)
            grids.append(grid)

        km_per_deg = grid_spacing_deg * 111
        velocities = []
        sum_dx = sum_dy = 0.0
        for p in range(len(grids) - 1):
            prev, curr = grids[p], grids[p + 1]
            if sum(prev) < 2 or sum(curr) < 2:
                continue
            shift = _best_shift(prev, curr, grid_size, max_shift)
            if shift['score'] < RADAR_CFG['MOTION_MIN_OVERLAP']:
                continue
            r_dx, r_dy = _refine_subcell(shift, max_shift)
            interval_min = (recent[p + 1]['timestamp'] - recent[p]['timestamp']) / 60
            if not interval_min > 0:
                interval_min = 5
            # Shift d aligns prev→curr as curr(g) ≈ prev(g + d) → motion = −d.
            # Grid axes: +x = east, +y = north. Velocities are (east, north)
            # components of true storm motion in km/h.
            velocities.append((-r_dx * km_per_deg / (interval_min / 60),
                               -r_dy * km_per_deg / (interval_min / 60)))
            sum_dx += r_dx
            sum_dy += r_dy

        if not velocities:
            return None

        if len(velocities) == 2:
            dir1 = math.atan2(velocities[0][1], velocities[0][0])
            dir2 = math.atan2(velocities[1][1], velocities[1][0])
            ad = abs(dir1 - dir2)
            if math.pi / 4 < ad < 7 * math.pi / 4:
                return None

        avg_ve = sum(v[0] for v in velocities) / len(velocities)
        avg_vn = sum(v[1] for v in velocities) / len(velocities)
        speed_kmh = math.sqrt(avg_ve ** 2 + avg_vn ** 2)
        if speed_kmh < 1:
            return None
        # Compass heading the storm moves TOWARD (0 = N, 90 = E) — matches the
        # upstream bearing math (cos→north, sin→east). Pre-v1.46.0 this was a
        # mixed math/compass convention that pointed upstream sampling 90° off.
        direction_deg = (math.degrees(math.atan2(avg_ve, avg_vn)) + 360) % 360
        return {
            'speed_kmh': round(speed_kmh),
            'direction_deg': round(direction_deg),
            'dx': sum_dx / len(velocities),
            'dy': sum_dy / len(velocities),
        }

    def build_timeline(self, current_dbz: Optional[int], is_raining: bool) -> Optional[List[Dict]]:
        """Project a 12-bucket (0–60 min) timeline using the recent dBZ slope."""
        recent = self._frames[-RADAR_CFG['SLOPE_FRAMES']:]
        if len(recent) < 3:
            return None
        values = [f['dbz'] if f['dbz'] is not None else 0 for f in recent]
        slope = _ls_slope(values)
        base = current_dbz if current_dbz is not None else (RADAR_CFG['ON_THRESHOLD'] if is_raining else 0)
        out = []
        for i in range(12):
            projected = max(0, base + slope * i)
            out.append({
                'minute': i * 5,
                'precipClass': _dbz_to_precip_class(projected),
                'projectedDbz': round(projected),
                'confidence': max(0.1, 1.0 - i * 0.10),
            })
        return out

    def estimate_rain_timing(self, motion: Optional[Dict],
                             current_dbz: Optional[int], is_raining: bool) -> Dict:
        NONE = {'beginInMin': None, 'endInMin': None, 'confidence': 'low'}
        if not motion or motion.get('speed_kmh', 0) < 5:
            return NONE
        recent = self._frames[-RADAR_CFG['SLOPE_FRAMES']:]
        recent_dbz = [f['dbz'] if f['dbz'] is not None else 0 for f in recent]
        if len(recent_dbz) < 3:
            return NONE
        slope = _ls_slope(recent_dbz)
        consistent = _has_consistent_direction(recent_dbz)

        if not is_raining:
            if slope < RADAR_CFG['MIN_SLOPE_DBZ'] or not consistent:
                return NONE
            if not any(d >= RADAR_CFG['BEGIN_SIGNAL_DBZ'] for d in recent_dbz):
                return NONE
            cur = current_dbz if current_dbz is not None else 0
            gap = RADAR_CFG['ON_THRESHOLD'] - cur
            if gap <= 0:
                return NONE
            begin_min = round((gap / slope) * 5)
            if begin_min <= 0 or begin_min > 60:
                return NONE
            conf = 'high' if slope >= 5 else 'med' if slope >= 3 else 'low'
            return {'beginInMin': begin_min, 'endInMin': None, 'confidence': conf}

        # Raining
        if slope > -RADAR_CFG['MIN_SLOPE_DBZ'] or not consistent:
            return NONE
        if not any(d >= RADAR_CFG['END_SIGNAL_DBZ'] for d in recent_dbz):
            return NONE
        cur = current_dbz if current_dbz is not None else RADAR_CFG['ON_THRESHOLD']
        hold_min = RADAR_CFG['OFF_HOLD_MS'] / 60000
        if cur <= RADAR_CFG['OFF_THRESHOLD']:
            return {'beginInMin': None, 'endInMin': hold_min, 'confidence': 'med'}
        frames_to_cross = (cur - RADAR_CFG['OFF_THRESHOLD']) / abs(slope)
        end_min = round(frames_to_cross * 5) + hold_min
        if end_min <= 0 or end_min > 60:
            return NONE
        conf = 'high' if abs(slope) >= 5 else 'med' if abs(slope) >= 3 else 'low'
        return {'beginInMin': None, 'endInMin': end_min, 'confidence': conf}

    def march_upstream(self, motion: Dict, ts_str: str) -> List[Dict]:
        """Sample the latest frame along the upstream ray — port of
        _marchUpstream (JS). Returns [{'distKm', 'dbz'}] at EDGE_STEP_KM steps
        out to min(speed × lookahead, EDGE_MAX_RANGE_KM)."""
        max_km = min(
            motion['speed_kmh'] * (RADAR_CFG['EDGE_MAX_LOOKAHEAD_MIN'] / 60.0),
            RADAR_CFG['EDGE_MAX_RANGE_KM'],
        )
        profile = []
        dist_km = 0.0
        while dist_km <= max_km:
            s_lat, s_lon = _upstream_point(self.lat, self.lon,
                                           motion['direction_deg'], dist_km, 0.0)
            dbz = self._sample_frame_at(s_lat, s_lon, ts_str)
            profile.append({'distKm': dist_km, 'dbz': dbz})
            dist_km += RADAR_CFG['EDGE_STEP_KM']
        return profile

    def _lateral_spread_hits(self, motion: Dict, ts_str: str, dist_km: float) -> int:
        """Track-over-point check at the edge: center + ±EDGE_LATERAL_KM."""
        hits = 0
        for lateral in (0.0, RADAR_CFG['EDGE_LATERAL_KM'], -RADAR_CFG['EDGE_LATERAL_KM']):
            s_lat, s_lon = _upstream_point(self.lat, self.lon,
                                           motion['direction_deg'], dist_km, lateral)
            dbz = self._sample_frame_at(s_lat, s_lon, ts_str)
            if dbz is not None and dbz >= RADAR_CFG['BEGIN_SIGNAL_DBZ']:
                hits += 1
        return hits

    def sample_edge_timing(self, motion: Optional[Dict], is_raining: bool) -> Optional[Dict]:
        """Edge-geometry timing — port of sampleEdgeTiming (JS).

        Dry case → beginInMin from the leading echo edge along the storm track;
        wet case → endInMin from the trailing edge. time = distance ÷ speed.
        Returns None when motion is missing/too slow, no edge is in range, or
        the profile has no data at all (likely tile failure).
        """
        if not motion or motion.get('speed_kmh', 0) < 5:
            return None
        stamps = _iem_timestamps(1)
        if not stamps:
            return None
        ts_str, _ = stamps[0]

        profile = self.march_upstream(motion, ts_str)
        if not profile or not any(p['dbz'] is not None for p in profile):
            return None

        if not is_raining:
            edge = _find_leading_edge(profile)
            if not edge:
                return None
            begin_in_min = round(edge['distKm'] / motion['speed_kmh'] * 60)
            if begin_in_min > RADAR_CFG['EDGE_MAX_LOOKAHEAD_MIN']:
                return None
            lateral_hits = self._lateral_spread_hits(motion, ts_str, edge['distKm'])
            return {'beginInMin': begin_in_min, 'endInMin': None,
                    'edgeDistKm': edge['distKm'],
                    'closingSpeedKmh': motion['speed_kmh'],
                    'lateralHits': lateral_hits}

        edge = _find_trailing_edge(profile)
        if not edge:
            return None  # rain extends past the march horizon
        end_in_min = round(edge['distKm'] / motion['speed_kmh'] * 60)
        if end_in_min > RADAR_CFG['EDGE_MAX_LOOKAHEAD_MIN']:
            return None
        return {'beginInMin': None, 'endInMin': end_in_min,
                'edgeDistKm': edge['distKm'],
                'closingSpeedKmh': motion['speed_kmh'],
                'lateralHits': None}

    def sample_rainviewer_nowcast(self, rv_limiter=None) -> Optional[List[Dict]]:
        """Sample RainViewer's model-extrapolated future frames at the point —
        port of sampleRainviewerNowcast (JS). Returns [{'minuteAhead', 'dbz'}]
        or None. Uses the per-poll tile cache. (No neighbor-tile edge fallback
        here — acceptable for fixed collector cities.)"""
        from .fetchers import fetch_rainviewer_maps, fetch_rv_tile
        maps = fetch_rainviewer_maps()
        if not maps or not maps.get('radar') or not maps['radar'].get('nowcast'):
            return None
        now_sec = time.time()
        tile_x, tile_y, px_x, px_y = _lat_lon_to_tile(self.lat, self.lon, RADAR_CFG['ZOOM'])
        samples = []
        for f in maps['radar']['nowcast']:
            minute_ahead = round((f['time'] - now_sec) / 60)
            if minute_ahead < 0:
                continue  # stale future frame
            key = ('rv', f['path'], RADAR_CFG['ZOOM'], tile_x, tile_y)
            if key in self._tile_cache:
                img = self._tile_cache[key]
            else:
                img = fetch_rv_tile(maps['host'], f['path'], RADAR_CFG['ZOOM'],
                                    tile_x, tile_y, rv_limiter)
                self._tile_cache[key] = img
            dbz = (_sample_neighborhood(img, px_x, px_y, RADAR_CFG['NEIGHBORHOOD_RADIUS'])
                   if img is not None else None)
            samples.append({'minuteAhead': minute_ahead, 'dbz': dbz})
        return samples or None

    # ── Internals ─────────────────────────────────────────────────────────

    def _load_history(self):
        stamps = list(reversed(_iem_timestamps(RADAR_CFG['FRAME_COUNT'])))
        for ts_str, ts_unix in stamps:
            dbz = self._sample_frame(ts_unix, ts_str)
            self._frames.append({'timestamp': ts_unix, 'dbz': dbz, 'source': 'NEXRAD'})
            self._process_frame(ts_unix, dbz)
        self._history_loaded = True

    def _sample_frame(self, ts_unix: int, ts_str: str) -> Optional[int]:
        return self._sample_frame_at(self.lat, self.lon, ts_str)

    def _get_tile(self, ts_str: str, z: int, x: int, y: int):
        """Fetch a tile, memoized per poll. Many samples share the same tile."""
        key = (ts_str, z, x, y)
        if key in self._tile_cache:
            return self._tile_cache[key]
        img = fetch_iem_tile(ts_str, z, x, y, self._limiter)
        self._tile_cache[key] = img
        return img

    def _sample_frame_at(self, lat: float, lon: float, ts_str: str) -> Optional[int]:
        tile_x, tile_y, px_x, px_y = _lat_lon_to_tile(lat, lon, RADAR_CFG['ZOOM'])
        img = self._get_tile(ts_str, RADAR_CFG['ZOOM'], tile_x, tile_y)
        if img is None:
            return None
        r = RADAR_CFG['NEIGHBORHOOD_RADIUS']
        dbz = _sample_neighborhood(img, px_x, px_y, r)

        # Edge handling — try neighbor tile if we're near the edge and got nothing
        if dbz is None:
            tile = RADAR_CFG['TILE_SIZE']
            margin = RADAR_CFG['EDGE_MARGIN']
            near_edge = (px_x < margin or px_x > tile - margin
                         or px_y < margin or px_y > tile - margin)
            if near_edge:
                nx = tile_x - 1 if px_x < margin else (tile_x + 1 if px_x > tile - margin else tile_x)
                ny = tile_y - 1 if px_y < margin else (tile_y + 1 if px_y > tile - margin else tile_y)
                if (nx, ny) != (tile_x, tile_y):
                    n_img = self._get_tile(ts_str, RADAR_CFG['ZOOM'], nx, ny)
                    if n_img is not None:
                        n_px = (tile - 1 - r if px_x < margin
                                else r if px_x > tile - margin else px_x)
                        n_py = (tile - 1 - r if px_y < margin
                                else r if px_y > tile - margin else px_y)
                        dbz = _sample_neighborhood(n_img, n_px, n_py, r)
        return dbz

    def _process_frame(self, ts_unix: int, dbz: Optional[int],
                       now_ms: Optional[float] = None):
        # Wall-clock time base, matching JS _processFrame's Date.now(). The
        # hold/decay timers age off real time, NOT the radar frame timestamp —
        # so history-replay (frames processed back-to-back) doesn't expire
        # state, exactly like the browser. ``_last_on_time`` /
        # ``_last_valid_dbz_time`` are stored in wall-clock ms. ``ts_unix`` is
        # retained for the frame record only. ``now_ms`` is injectable for tests.
        if now_ms is None:
            now_ms = time.time() * 1000

        if dbz is None:
            null_age = (now_ms - self._last_valid_dbz_time
                        if self._last_valid_dbz_time else float('inf'))
            if self._rain_state == 'PENDING_ON':
                self._rain_state = 'OFF'
                self._pending_on_count = 0
            elif self._rain_state == 'ON' and null_age > RADAR_CFG['NULL_DECAY_MS']:
                self._rain_state = 'HOLDING'
            elif self._rain_state == 'HOLDING':
                hold_expired = (self._last_on_time
                                and now_ms - self._last_on_time > RADAR_CFG['OFF_HOLD_MS'])
                null_expired = null_age > 2 * RADAR_CFG['NULL_DECAY_MS']
                if hold_expired or null_expired:
                    self._rain_state = 'OFF'
                    self._pending_on_count = 0
            return

        self._last_valid_dbz_time = now_ms

        if self._rain_state == 'OFF':
            if dbz >= RADAR_CFG['ON_THRESHOLD']:
                self._pending_on_count = 1
                self._rain_state = 'PENDING_ON'
        elif self._rain_state == 'PENDING_ON':
            if dbz >= RADAR_CFG['ON_THRESHOLD']:
                self._pending_on_count += 1
                if self._pending_on_count >= RADAR_CFG['ON_CONFIRM_FRAMES']:
                    self._rain_state = 'ON'
                    self._last_on_time = now_ms
            else:
                self._rain_state = 'OFF'
                self._pending_on_count = 0
        elif self._rain_state == 'ON':
            if dbz >= RADAR_CFG['OFF_THRESHOLD']:
                self._last_on_time = now_ms
            else:
                self._rain_state = 'HOLDING'
        elif self._rain_state == 'HOLDING':
            if dbz >= RADAR_CFG['OFF_THRESHOLD']:
                self._rain_state = 'ON'
                self._last_on_time = now_ms
            elif (self._last_on_time
                  and now_ms - self._last_on_time > RADAR_CFG['OFF_HOLD_MS']):
                self._rain_state = 'OFF'
                self._pending_on_count = 0


# ── Helpers ──────────────────────────────────────────────────────────────────

def _upstream_point(lat: float, lon: float, direction_deg: float,
                    dist_km: float, lateral_km: float) -> Tuple[float, float]:
    """Point dist_km upstream along the storm track (direction_deg = compass
    heading the storm moves toward), offset lateral_km perpendicular.
    Parity with _upstreamPoint (JS)."""
    up_b = math.radians((direction_deg + 180) % 360)   # compass: 0 = N
    perp_b = up_b + math.pi / 2
    km_per_deg_lat = 111.0
    km_per_deg_lon = 111.0 * math.cos(math.radians(lat))
    return (
        lat + (dist_km * math.cos(up_b) + lateral_km * math.cos(perp_b)) / km_per_deg_lat,
        lon + (dist_km * math.sin(up_b) + lateral_km * math.sin(perp_b)) / km_per_deg_lon,
    )


def _find_leading_edge(profile: List[Dict]) -> Optional[Dict]:
    """PURE — start of the first run of ≥ EDGE_WET_RUN_SAMPLES consecutive
    samples at ≥ BEGIN_SIGNAL_DBZ. Parity with _findLeadingEdge (JS)."""
    run = 0
    for i, p in enumerate(profile):
        wet = p['dbz'] is not None and p['dbz'] >= RADAR_CFG['BEGIN_SIGNAL_DBZ']
        if not wet:
            run = 0
            continue
        run += 1
        if run >= RADAR_CFG['EDGE_WET_RUN_SAMPLES']:
            return {'distKm': profile[i - run + 1]['distKm']}
    return None


def _find_trailing_edge(profile: List[Dict]) -> Optional[Dict]:
    """PURE — start of the first run of ≥ EDGE_DRY_GAP_SAMPLES consecutive dry
    samples (dBZ < EDGE_DRY_DBZ or no echo). The ~8 km gap requirement keeps a
    small hole inside a storm complex from reading as clearing. Returns
    {'distKm', 'wetExtentKm'} or None (rain past horizon). Parity with
    _findTrailingEdge (JS)."""
    dry_run = 0
    for i, p in enumerate(profile):
        dry = p['dbz'] is None or p['dbz'] < RADAR_CFG['EDGE_DRY_DBZ']
        if not dry:
            dry_run = 0
            continue
        dry_run += 1
        if dry_run >= RADAR_CFG['EDGE_DRY_GAP_SAMPLES']:
            edge_idx = i - dry_run + 1
            return {'distKm': profile[edge_idx]['distKm'],
                    'wetExtentKm': profile[edge_idx - 1]['distKm'] if edge_idx > 0 else 0}
    return None


def derive_rv_timing(rv_samples: Optional[List[Dict]], is_raining: bool) -> Dict:
    """PURE — begin/end from RainViewer nowcast samples. Begin ≈ midpoint of
    last-dry/first-wet frame (10-min frames → ±5 min quantization); end ≈
    midpoint of last-wet/first-dry frame. Parity with _deriveRvTiming (JS)."""
    none = {'beginInMin': None, 'endInMin': None}
    if not rv_samples:
        return none
    prev_minute = 0
    for s in rv_samples:
        wet = s['dbz'] is not None and s['dbz'] >= RADAR_CFG['ON_THRESHOLD']
        if not is_raining and wet:
            return {'beginInMin': round((prev_minute + s['minuteAhead']) / 2),
                    'endInMin': None}
        if is_raining and not wet:
            return {'beginInMin': None,
                    'endInMin': round((prev_minute + s['minuteAhead']) / 2)}
        prev_minute = s['minuteAhead']
    return none


def _best_shift(prev: List[int], curr: List[int], grid_size: int, max_shift: int) -> Dict:
    """Best binary-overlap shift between two masks; returns the full score
    surface for sub-cell refinement. Parity with _bestShift (JS)."""
    dim = 2 * max_shift + 1
    scores = [0] * (dim * dim)
    best_score, best_dx, best_dy = -1, 0, 0
    for dy in range(-max_shift, max_shift + 1):
        for dx in range(-max_shift, max_shift + 1):
            score = 0
            for gy in range(grid_size):
                for gx in range(grid_size):
                    sy, sx = gy + dy, gx + dx
                    if 0 <= sy < grid_size and 0 <= sx < grid_size:
                        if prev[sy * grid_size + sx] == 1 and curr[gy * grid_size + gx] == 1:
                            score += 1
            scores[(dy + max_shift) * dim + (dx + max_shift)] = score
            if score > best_score:
                best_score, best_dx, best_dy = score, dx, dy
    return {'dx': best_dx, 'dy': best_dy, 'score': best_score,
            'scores': scores, 'dim': dim}


def _refine_subcell(shift: Dict, max_shift: int) -> Tuple[float, float]:
    """Parabolic peak interpolation around the best shift. Parity with
    _refineSubcell (JS). Returns fractional (dx, dy)."""
    scores, dim = shift['scores'], shift['dim']
    cx, cy = shift['dx'] + max_shift, shift['dy'] + max_shift

    def at(x, y):
        if x < 0 or x >= dim or y < 0 or y >= dim:
            return 0
        return scores[y * dim + x]

    fx = fy = 0.0
    den_x = at(cx - 1, cy) - 2 * at(cx, cy) + at(cx + 1, cy)
    if den_x < 0:
        fx = 0.5 * (at(cx - 1, cy) - at(cx + 1, cy)) / den_x
    den_y = at(cx, cy - 1) - 2 * at(cx, cy) + at(cx, cy + 1)
    if den_y < 0:
        fy = 0.5 * (at(cx, cy - 1) - at(cx, cy + 1)) / den_y
    fx = max(-0.5, min(0.5, fx))
    fy = max(-0.5, min(0.5, fy))
    return shift['dx'] + fx, shift['dy'] + fy


def _ls_slope(values: List[float]) -> float:
    n = len(values)
    if n < 2:
        return 0.0
    mean_x = (n - 1) / 2
    mean_y = sum(values) / n
    num = den = 0.0
    for i, v in enumerate(values):
        num += (i - mean_x) * (v - mean_y)
        den += (i - mean_x) ** 2
    return 0.0 if den == 0 else num / den


def _has_consistent_direction(values: List[float]) -> bool:
    flips = 0
    for i in range(2, len(values)):
        d1 = values[i - 1] - values[i - 2]
        d2 = values[i] - values[i - 1]
        if d1 * d2 < 0:
            flips += 1
    return flips <= 1


def _dbz_to_precip_class(dbz: float) -> int:
    if dbz < 22:
        return 0
    if dbz < 30:
        return 1
    if dbz < 40:
        return 2
    if dbz < 50:
        return 3
    return 4
