// Radar Sampler — tile loading, canvas pixel sampling, dBZ estimation, hysteresis
// Supports IEM NEXRAD (US) and RainViewer (worldwide).
// No DOM side effects visible to user.
//
// Exports (globals): sampleRadarAtPoint, loadRadarHistory, getRadarFrames,
//                    estimateMotionVector, estimateRainTiming, buildPrecipTimeline,
//                    sampleEdgeTiming, beginSampleCycle, resetRadarState

// ── Configuration ────────────────────────────────────────────────────────────

// TODO: virga suppression. 2026-04-15 Chicago backtest showed 7 consecutive
// snapshots at dbz≈25 (sustained, not transient) with KMDW observing dry and
// partly_cloudy — echoes aloft not reaching the surface. A dBZ threshold bump
// won't help here (real light rain is also 18–25 dBZ). The right cross-check
// is surface-level: if temp-dewpoint spread > ~8°F OR station humidity < ~60%,
// treat dBZ 18–25 as "possible" rather than confirmed ON. Needs access to the
// current METAR from this module (or synthesis at the nowcast layer).
const RADAR_CFG = {
    ZOOM:               6,       // tile zoom level (max 7 for RainViewer)
    TILE_SIZE:          256,
    ON_THRESHOLD:       22,      // dBZ to declare rain ON  (raised from 18 — reduces virga/elevated-echo false alarms)
    OFF_THRESHOLD:      12,      // dBZ to declare rain OFF (was 22 — dropped out too aggressively)
    ON_CONFIRM_FRAMES:  2,       // consecutive frames above ON to confirm
    OFF_HOLD_MS:        8 * 60 * 1000,  // 8 min hold after last above-threshold (was 12 min)
    NULL_DECAY_MS:      5 * 60 * 1000,  // 5 min with null frames before ON → HOLDING (was 12 min)
    THUNDER_DBZ:        45,
    FRAME_COUNT:        10,      // number of historical frames to keep
    EDGE_MARGIN:        5,       // pixels from edge to trigger neighbor tile fetch
    NEIGHBORHOOD_RADIUS: 1,      // px radius for neighborhood sampling (3×3 at r=1)
    MIN_VALID_PIXELS:   2,       // minimum valid pixels in neighborhood to return a result
    MAX_COLOR_DIST:     12000,   // max squared RGB distance for palette match
    SLOPE_FRAMES:       6,       // frames used for regression (~30 min)
    MIN_SLOPE_DBZ:      2,       // dBZ/frame minimum meaningful slope
    MOTION_GRID:        9,       // binary correlation grid size (9×9)
    MOTION_MAX_SHIFT:   4,       // ± cells searched — resolves ~107 km/h at 5-min cadence
    MOTION_MIN_OVERLAP: 3,       // min overlap score to accept a shift
    MOTION_PERSIST_MS:  15 * 60 * 1000,  // reuse last good vector this long
    MOTION_WIND_MIN_MPH: 8,      // min steering wind for model-wind fallback
    EDGE_STEP_KM:           2,   // upstream march step (~1 px at zoom 6)
    EDGE_MAX_LOOKAHEAD_MIN: 60,  // don't predict past the hour
    EDGE_MAX_RANGE_KM:      120, // march distance cap
    EDGE_WET_RUN_SAMPLES:   2,   // sustained-wet run to declare leading edge
    EDGE_DRY_GAP_SAMPLES:   4,   // ~8 km sustained dry to declare trailing edge
    EDGE_DRY_DBZ:           15,  // below this counts as dry for trailing edge
    EDGE_LATERAL_KM:        3,   // ± km perpendicular spread for track check
    BEGIN_SIGNAL_DBZ:   18,      // min dBZ in any recent frame to allow "begin" prediction
    END_SIGNAL_DBZ:     30,      // min dBZ in any recent frame to allow "end" prediction
    IEM_BASE:           'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0',
    RAINVIEWER_API:     'https://api.rainviewer.com/public/weather-maps.json',
    DEBUG:              false,
};

// ── State ────────────────────────────────────────────────────────────────────

let _radarFrames = [];      // [{ timestamp, dbz, source }]
let _rainState   = 'OFF';   // OFF | PENDING_ON | ON | HOLDING
let _lastOnTime  = null;    // Date when rain was last confirmed ON
let _lastValidDbzTime = null; // Date.now() when last non-null dBZ was received
let _pendingOnCount = 0;
let _radarHistoryLoaded = false;
let _radarHistoryPending = null;

// Per-poll decoded-tile cache: url → Promise<ImageData|null>.
// One zoom-6 tile spans ~600 km, so the motion grid and upstream march mostly
// hit the same tile — caching collapses dozens of redundant decode+draw cycles
// per poll into a handful. Cleared by beginSampleCycle() so each poll sees
// fresh tiles.
let _tileCache = new Map();

// Clear the tile cache — call once at the start of each nowcast poll cycle.
function beginSampleCycle() {
    _tileCache.clear();
}

// Shared canvas for pixel sampling (created once, never appended to DOM)
let _sampleCanvas = null;
let _sampleCtx    = null;

function _getCanvas() {
    if (!_sampleCanvas) {
        _sampleCanvas = document.createElement('canvas');
        _sampleCanvas.width = RADAR_CFG.TILE_SIZE;
        _sampleCanvas.height = RADAR_CFG.TILE_SIZE;
        _sampleCtx = _sampleCanvas.getContext('2d', { willReadFrequently: true });
    }
    return { canvas: _sampleCanvas, ctx: _sampleCtx };
}

// ── Tile math (slippy map) ───────────────────────────────────────────────────

function _latLonToTile(lat, lon, zoom) {
    const n = Math.pow(2, zoom);
    const tileX = Math.floor((lon + 180) / 360 * n);
    const latRad = lat * Math.PI / 180;
    const tileY = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);

    // Pixel offset within the tile
    const xFrac = ((lon + 180) / 360 * n) - tileX;
    const yFrac = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n) - tileY;
    const pxX = Math.floor(xFrac * RADAR_CFG.TILE_SIZE);
    const pxY = Math.floor(yFrac * RADAR_CFG.TILE_SIZE);

    return { tileX, tileY, pxX, pxY };
}

// ── Image loading ────────────────────────────────────────────────────────────

function _loadImage(url) {
    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = url;
    });
}

// ── Tile URL + decoded-tile cache ────────────────────────────────────────────

// Build the tile URL for a frame (IEM NEXRAD or RainViewer). Returns null if
// frameInfo doesn't describe a fetchable frame.
function _frameUrl(isUS, frameInfo, tileX, tileY) {
    if (isUS && frameInfo.iemTs) {
        return `${RADAR_CFG.IEM_BASE}/ridge::USCOMP-N0Q-${frameInfo.iemTs}/${RADAR_CFG.ZOOM}/${tileX}/${tileY}.png`;
    }
    if (frameInfo.rvHost && frameInfo.rvPath) {
        // Default color=2 (universal blue), smooth=1, snow=1 — legacy palette
        // sampling. rvRaw requests color=0 (raw dBZ grayscale), no smoothing,
        // which _rvRawToDbz decodes exactly.
        const color = frameInfo.rvRaw ? 0 : 2;
        const opts = frameInfo.rvRaw ? '0_0' : '1_1';
        return `${frameInfo.rvHost}${frameInfo.rvPath}/${RADAR_CFG.TILE_SIZE}/${RADAR_CFG.ZOOM}/${tileX}/${tileY}/${color}/${opts}.png`;
    }
    return null;
}

// Decode a RainViewer color-scheme-0 pixel: dBZ = (R & 127) − 32, high bit is
// the snow flag, alpha 0 = no radar coverage. (Documented RV encoding.)
// Returns null for no-echo / trace / implausible special values.
function _rvRawToDbz(r, g, b, a) {
    if (a < 20) return null;           // no coverage
    const dbz = (r & 127) - 32;        // snow bit stripped — still precip
    if (dbz <= 5) return null;         // clear-air / trace, below any threshold
    if (dbz > 75) return 45;           // special/undefined core values → treat as heavy
    return dbz;
}

// Load + decode a tile to ImageData, memoized per poll cycle. Stores the
// promise so concurrent requests for the same tile share one fetch.
function _getTileImageData(url) {
    if (_tileCache.has(url)) return _tileCache.get(url);
    const p = _loadImage(url).then((img) => {
        if (!img) return null;
        const { canvas, ctx } = _getCanvas();
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, RADAR_CFG.TILE_SIZE, RADAR_CFG.TILE_SIZE);
        return ctx.getImageData(0, 0, RADAR_CFG.TILE_SIZE, RADAR_CFG.TILE_SIZE);
    });
    _tileCache.set(url, p);
    return p;
}

// ── Pixel sampling ───────────────────────────────────────────────────────────

// Sample a (2r+1)×(2r+1) neighborhood and return the median dBZ (or null).
// Requires at least MIN_VALID_PIXELS valid pixels to return a result.
// Median is robust against isolated artifact pixels that max would amplify.
function _sampleNeighborhood(imgData, pxX, pxY, radius, decoder = _colorToDBZ) {
    const size = RADAR_CFG.TILE_SIZE;
    const x0 = Math.max(0, pxX - radius);
    const y0 = Math.max(0, pxY - radius);
    const x1 = Math.min(size - 1, pxX + radius);
    const y1 = Math.min(size - 1, pxY + radius);
    const data = imgData.data;

    const valid = [];
    let _debugMatch = 0;
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            const i = (y * size + x) * 4;
            const dbz = decoder(data[i], data[i + 1], data[i + 2], data[i + 3]);
            if (dbz !== null) {
                valid.push(dbz);
                _debugMatch++;
            }
        }
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;

    if (RADAR_CFG.DEBUG && (valid.length > 0 || _debugMatch > 0)) {
        console.debug(`[RadarSampler] neighborhood ${w}x${h}: ${valid.length} valid, matched=${_debugMatch}`);
    }

    if (valid.length < RADAR_CFG.MIN_VALID_PIXELS) return null;

    // Return median
    valid.sort((a, b) => a - b);
    const mid = Math.floor(valid.length / 2);
    return valid.length % 2 === 0
        ? Math.round((valid[mid - 1] + valid[mid]) / 2)
        : valid[mid];
}

// ── Color-to-dBZ mapping (intensity class approach) ──────────────────────────
// Uses nearest-color matching against reference palette entries.
// Organized as intensity classes with approximate dBZ ranges.

const _INTENSITY_CLASSES = [
    // class 0: no data / transparent
    { r:   0, g:   0, b:   0, dbz: -999, label: 'none' },
    // class 1-3: very light echoes (< 15 dBZ) — not rain
    { r:   0, g: 236, b: 236, dbz:  5,   label: 'trace' },     // light cyan
    { r:   1, g: 160, b: 246, dbz: 10,   label: 'trace' },     // cyan-blue
    { r:   0, g:   0, b: 246, dbz: 15,   label: 'trace' },     // blue
    // class 4-5: light rain (15-25 dBZ)
    { r:   0, g: 255, b:   0, dbz: 20,   label: 'light' },     // bright green
    { r:   0, g: 200, b:   0, dbz: 25,   label: 'light' },     // green
    // class 6-7: moderate rain (25-35 dBZ)
    { r:   0, g: 144, b:   0, dbz: 30,   label: 'moderate' },  // dark green
    { r: 255, g: 255, b:   0, dbz: 35,   label: 'moderate' },  // yellow
    // class 8-9: heavy rain (35-45 dBZ)
    { r: 231, g: 192, b:   0, dbz: 40,   label: 'heavy' },     // gold
    { r: 255, g: 144, b:   0, dbz: 45,   label: 'heavy' },     // orange
    // class 10-11: very heavy / hail (45-55 dBZ)
    { r: 255, g:   0, b:   0, dbz: 50,   label: 'intense' },   // red
    { r: 214, g:   0, b:   0, dbz: 55,   label: 'intense' },   // dark red
    // class 12-13: extreme (55+ dBZ)
    { r: 192, g:   0, b: 192, dbz: 60,   label: 'extreme' },   // magenta
    // White removed — not a real NEXRAD/RainViewer radar color.
    // Actual 70+ dBZ returns render as magenta/pink. White matches map
    // labels, blank tiles, and terrain artifacts → false positives.
];

// Pre-filter: only saturated, distinctly colored pixels are radar candidates.
// Grayscale, near-white, near-black, and semi-transparent pixels are map artifacts.
function _isRadarCandidate(r, g, b, a) {
    if (a < 180) return false;  // semi-transparent = tile seams / artifacts

    const bright = (r + g + b) / 3;
    const sat = Math.max(r, g, b) - Math.min(r, g, b);

    if (bright > 240 && sat < 30) return false;  // near-white
    if (bright < 15) return false;                // near-black

    // Grayscale: all channels within 12 of each other
    if (Math.abs(r - g) <= 12 && Math.abs(r - b) <= 12 && Math.abs(g - b) <= 12) return false;

    return true;
}

function _colorToDBZ(r, g, b, a) {
    // Transparent or near-transparent = no data
    if (a < 20) return null;

    // Reject non-radar pixels before palette matching
    if (!_isRadarCandidate(r, g, b, a)) return null;

    // Find nearest palette color by Euclidean distance in RGB space
    let bestDist = Infinity;
    let bestClass = _INTENSITY_CLASSES[0];
    for (let i = 1; i < _INTENSITY_CLASSES.length; i++) { // skip class 0 (no-data)
        const c = _INTENSITY_CLASSES[i];
        const dist = (r - c.r) ** 2 + (g - c.g) ** 2 + (b - c.b) ** 2;
        if (dist < bestDist) {
            bestDist = dist;
            bestClass = c;
        }
    }

    // Tight distance threshold — pixel must closely match a known radar color
    if (bestDist > RADAR_CFG.MAX_COLOR_DIST) return null;

    return bestClass.dbz;
}

// ── IEM NEXRAD (US) ──────────────────────────────────────────────────────────

function _iemTimestamps(count) {
    // Generate timestamps at 5-min intervals going back from now
    const now = new Date();
    const stamps = [];
    for (let i = 0; i < count; i++) {
        const t = new Date(now.getTime() - i * 5 * 60 * 1000);
        // Round down to nearest 5 min
        t.setUTCMinutes(Math.floor(t.getUTCMinutes() / 5) * 5, 0, 0);
        const ts = t.getUTCFullYear().toString() +
            String(t.getUTCMonth() + 1).padStart(2, '0') +
            String(t.getUTCDate()).padStart(2, '0') +
            String(t.getUTCHours()).padStart(2, '0') +
            String(t.getUTCMinutes()).padStart(2, '0');
        stamps.push({ ts, time: t.getTime() / 1000 });
    }
    return stamps;
}

// ── RainViewer (worldwide) ───────────────────────────────────────────────────

let _rvMapsCache = { data: null, ts: null };
const _RV_MAPS_TTL = 5 * 60 * 1000; // 5 min

async function _fetchRainViewerMaps() {
    if (_rvMapsCache.data && _rvMapsCache.ts && (Date.now() - _rvMapsCache.ts) < _RV_MAPS_TTL) {
        return _rvMapsCache.data;
    }
    try {
        const res = await fetch(RADAR_CFG.RAINVIEWER_API);
        if (!res.ok) return null;
        const data = await res.json();
        _rvMapsCache = { data, ts: Date.now() };
        return data;
    } catch (err) {
        console.warn('[RadarSampler] RainViewer maps fetch failed:', err.message);
        return null;
    }
}

// ── Sample a single frame at a point ─────────────────────────────────────────

async function _sampleFrameAtPoint(lat, lon, isUS, frameInfo) {
    const { tileX, tileY, pxX, pxY } = _latLonToTile(lat, lon, RADAR_CFG.ZOOM);

    const url = _frameUrl(isUS, frameInfo, tileX, tileY);
    if (!url) return null;
    const imgData = await _getTileImageData(url);
    if (!imgData) return null;

    const r = RADAR_CFG.NEIGHBORHOOD_RADIUS;
    const decoder = frameInfo.rvRaw ? _rvRawToDbz : _colorToDBZ;
    let dbz = _sampleNeighborhood(imgData, pxX, pxY, r, decoder);

    // Edge handling: if near tile boundary and neighborhood found nothing, try neighbor tile
    if (dbz === null && (
        pxX < RADAR_CFG.EDGE_MARGIN || pxX > RADAR_CFG.TILE_SIZE - RADAR_CFG.EDGE_MARGIN ||
        pxY < RADAR_CFG.EDGE_MARGIN || pxY > RADAR_CFG.TILE_SIZE - RADAR_CFG.EDGE_MARGIN)) {
        const neighborX = pxX < RADAR_CFG.EDGE_MARGIN ? tileX - 1 : (pxX > RADAR_CFG.TILE_SIZE - RADAR_CFG.EDGE_MARGIN ? tileX + 1 : tileX);
        const neighborY = pxY < RADAR_CFG.EDGE_MARGIN ? tileY - 1 : (pxY > RADAR_CFG.TILE_SIZE - RADAR_CFG.EDGE_MARGIN ? tileY + 1 : tileY);
        if (neighborX !== tileX || neighborY !== tileY) {
            const nPxX = pxX < RADAR_CFG.EDGE_MARGIN ? RADAR_CFG.TILE_SIZE - 1 - r : (pxX > RADAR_CFG.TILE_SIZE - RADAR_CFG.EDGE_MARGIN ? r : pxX);
            const nPxY = pxY < RADAR_CFG.EDGE_MARGIN ? RADAR_CFG.TILE_SIZE - 1 - r : (pxY > RADAR_CFG.TILE_SIZE - RADAR_CFG.EDGE_MARGIN ? r : pxY);
            const nUrl = _frameUrl(isUS, frameInfo, neighborX, neighborY);
            const nData = nUrl ? await _getTileImageData(nUrl) : null;
            if (nData) dbz = _sampleNeighborhood(nData, nPxX, nPxY, r, decoder);
        }
    }

    return dbz;
}

// ── Latest frame lookup (shared by sampler, motion, upstream) ────────────────
// Returns { frameInfo, timestamp } for the most recent available frame, or null.

async function _latestFrameInfo(isUS) {
    if (isUS) {
        const stamps = _iemTimestamps(1);
        return { frameInfo: { iemTs: stamps[0].ts }, timestamp: stamps[0].time };
    }
    const maps = await _fetchRainViewerMaps();
    if (!maps || !maps.radar || !maps.radar.past || maps.radar.past.length === 0) return null;
    const latest = maps.radar.past[maps.radar.past.length - 1];
    return { frameInfo: { rvHost: maps.host, rvPath: latest.path }, timestamp: latest.time };
}

// Reconstruct frameInfo for a historical frame from _radarFrames.
async function _histFrameInfo(isUS, frame) {
    if (isUS) {
        const t = new Date(frame.timestamp * 1000);
        const ts = t.getUTCFullYear().toString() +
            String(t.getUTCMonth() + 1).padStart(2, '0') +
            String(t.getUTCDate()).padStart(2, '0') +
            String(t.getUTCHours()).padStart(2, '0') +
            String(Math.floor(t.getUTCMinutes() / 5) * 5).padStart(2, '0');
        return { iemTs: ts };
    }
    const maps = await _fetchRainViewerMaps();
    if (!maps || !maps.radar || !maps.radar.past) return null;
    const match = maps.radar.past.find(f => f.time === frame.timestamp);
    if (!match) return null;
    return { rvHost: maps.host, rvPath: match.path };
}

// ── Hysteresis state machine ─────────────────────────────────────────────────

function _processFrame(timestamp, dbz) {
    const now = Date.now();

    if (dbz === null) {
        // No data — degrade gracefully instead of freezing state
        const nullAge = _lastValidDbzTime ? (now - _lastValidDbzTime) : Infinity;

        if (_rainState === 'PENDING_ON') {
            // No data = no confirmation
            _rainState = 'OFF';
            _pendingOnCount = 0;
        } else if (_rainState === 'ON' && nullAge > RADAR_CFG.NULL_DECAY_MS) {
            // Too long without valid data while ON → degrade to HOLDING
            _rainState = 'HOLDING';
            if (RADAR_CFG.DEBUG) console.debug('[RadarSampler] ON → HOLDING (null decay)');
        } else if (_rainState === 'HOLDING') {
            // HOLDING: check both lastOnTime and null-age timeouts
            const holdExpired = _lastOnTime && (now - _lastOnTime) > RADAR_CFG.OFF_HOLD_MS;
            const nullExpired = nullAge > 2 * RADAR_CFG.NULL_DECAY_MS;
            if (holdExpired || nullExpired) {
                _rainState = 'OFF';
                _pendingOnCount = 0;
                if (RADAR_CFG.DEBUG) console.debug('[RadarSampler] HOLDING → OFF (null decay)');
            }
        }
        return;
    }

    // Valid data — update tracker
    _lastValidDbzTime = now;

    switch (_rainState) {
        case 'OFF':
            if (dbz >= RADAR_CFG.ON_THRESHOLD) {
                _pendingOnCount = 1;
                _rainState = 'PENDING_ON';
            }
            break;

        case 'PENDING_ON':
            if (dbz >= RADAR_CFG.ON_THRESHOLD) {
                _pendingOnCount++;
                if (_pendingOnCount >= RADAR_CFG.ON_CONFIRM_FRAMES) {
                    _rainState = 'ON';
                    _lastOnTime = now;
                }
            } else {
                _rainState = 'OFF';
                _pendingOnCount = 0;
            }
            break;

        case 'ON':
            if (dbz >= RADAR_CFG.OFF_THRESHOLD) {
                _lastOnTime = now;
            } else {
                _rainState = 'HOLDING';
            }
            break;

        case 'HOLDING':
            if (dbz >= RADAR_CFG.OFF_THRESHOLD) {
                _rainState = 'ON';
                _lastOnTime = now;
            } else if (_lastOnTime && (now - _lastOnTime) > RADAR_CFG.OFF_HOLD_MS) {
                _rainState = 'OFF';
                _pendingOnCount = 0;
            }
            break;
    }
}

// ── Public: load radar history ───────────────────────────────────────────────

async function loadRadarHistory(lat, lon, isUS) {
    if (_radarHistoryLoaded) return;
    if (_radarHistoryPending) return _radarHistoryPending;

    _radarHistoryPending = (async () => {
        try {
            const frames = [];
            if (isUS) {
                // IEM: generate timestamps going back
                const stamps = _iemTimestamps(RADAR_CFG.FRAME_COUNT);
                // Fetch oldest first so hysteresis processes in chronological order
                for (const s of stamps.reverse()) {
                    const dbz = await _sampleFrameAtPoint(lat, lon, true, { iemTs: s.ts });
                    frames.push({ timestamp: s.time, dbz, source: 'NEXRAD' });
                    _processFrame(s.time, dbz);
                }
            } else {
                // RainViewer: get frame list from API
                const maps = await _fetchRainViewerMaps();
                if (maps && maps.radar && maps.radar.past) {
                    const pastFrames = maps.radar.past.slice(-RADAR_CFG.FRAME_COUNT);
                    for (const f of pastFrames) {
                        const dbz = await _sampleFrameAtPoint(lat, lon, false, {
                            rvHost: maps.host, rvPath: f.path
                        });
                        frames.push({ timestamp: f.time, dbz, source: 'RainViewer' });
                        _processFrame(f.time, dbz);
                    }
                }
            }
            _radarFrames = frames;
            _radarHistoryLoaded = true;
        } catch (err) {
            console.warn('[RadarSampler] History load failed:', err.message);
        }
    })();

    _radarHistoryPending = _radarHistoryPending.finally(() => { _radarHistoryPending = null; });
    return _radarHistoryPending;
}

// ── Public: sample latest frame ──────────────────────────────────────────────

async function sampleRadarAtPoint(lat, lon, isUS) {
    // Ensure history is loaded first
    if (!_radarHistoryLoaded) {
        await loadRadarHistory(lat, lon, isUS);
    }

    let dbz = null;
    let timestamp = Date.now() / 1000;
    let source = isUS ? 'NEXRAD' : 'RainViewer';

    try {
        const latest = await _latestFrameInfo(isUS);
        if (latest) {
            dbz = await _sampleFrameAtPoint(lat, lon, isUS, latest.frameInfo);
            timestamp = latest.timestamp;
        }
    } catch (err) {
        console.warn('[RadarSampler] Sample failed:', err.message);
    }

    // Update hysteresis
    _processFrame(timestamp, dbz);

    // Append to frame history (limit to FRAME_COUNT)
    _radarFrames.push({ timestamp, dbz, source });
    if (_radarFrames.length > RADAR_CFG.FRAME_COUNT) {
        _radarFrames = _radarFrames.slice(-RADAR_CFG.FRAME_COUNT);
    }

    const isRaining = _rainState === 'ON' || _rainState === 'HOLDING';

    return {
        dbz,
        isRaining,
        rainState: _rainState,
        timestamp: new Date(timestamp * 1000).toISOString(),
        source,
        lastValidDbzTime: _lastValidDbzTime ? new Date(_lastValidDbzTime).toISOString() : null,
    };
}

// ── Public: get current frame list (for debugging) ───────────────────────────

function getRadarFrames() {
    return _radarFrames.slice();
}

// ── Public: reset state for a different location ─────────────────────────────
// Call before fetching nowcast for a city other than the main active location
// (e.g. background tab temperature/icon refresh) to prevent one city's rain
// state from bleeding into another city's poll.

function resetRadarState() {
    _rainState           = 'OFF';
    _lastOnTime          = null;
    _lastValidDbzTime    = null;
    _pendingOnCount      = 0;
    _radarHistoryLoaded  = false;
    _radarHistoryPending = null;
    _radarFrames         = [];
    _lastMotion          = null;
    _tileCache.clear();
}

// ── Motion Vector Estimation (coarse correlation) ────────────────────────────
// Samples a grid around the point for multiple frames, finds best shift via
// binary mask overlap with parabolic sub-cell refinement. Returns null if
// motion is inconsistent. 9×9 grid with ±4-cell search resolves ~107 km/h
// (the old 5×5/±2 saturated at ~53 km/h — squall lines clipped or failed).

// Sample a gridSize×gridSize binary rain mask centered on (lat, lon).
async function _sampleBinaryGrid(lat, lon, isUS, frameInfo, gridSize, spacingDeg) {
    const half = Math.floor(gridSize / 2);
    const grid = [];
    for (let gy = 0; gy < gridSize; gy++) {
        for (let gx = 0; gx < gridSize; gx++) {
            const gLat = lat + (gy - half) * spacingDeg;
            const gLon = lon + (gx - half) * spacingDeg;
            const dbz = await _sampleFrameAtPoint(gLat, gLon, isUS, frameInfo);
            grid.push(dbz !== null && dbz >= RADAR_CFG.OFF_THRESHOLD ? 1 : 0);
        }
    }
    return grid;
}

// Best binary-overlap shift between two masks. Returns the full score surface
// for sub-cell refinement.
function _bestShift(prev, curr, gridSize, maxShift) {
    const dim = 2 * maxShift + 1;
    const scores = new Array(dim * dim).fill(0);
    let bestScore = -1, bestDx = 0, bestDy = 0;
    for (let dy = -maxShift; dy <= maxShift; dy++) {
        for (let dx = -maxShift; dx <= maxShift; dx++) {
            let score = 0;
            for (let gy = 0; gy < gridSize; gy++) {
                for (let gx = 0; gx < gridSize; gx++) {
                    const sy = gy + dy;
                    const sx = gx + dx;
                    if (sy < 0 || sy >= gridSize || sx < 0 || sx >= gridSize) continue;
                    if (prev[sy * gridSize + sx] === 1 && curr[gy * gridSize + gx] === 1) score++;
                }
            }
            scores[(dy + maxShift) * dim + (dx + maxShift)] = score;
            if (score > bestScore) { bestScore = score; bestDx = dx; bestDy = dy; }
        }
    }
    return { dx: bestDx, dy: bestDy, score: bestScore, scores, dim };
}

// Parabolic peak interpolation on the score surface around the best shift.
// Halves the per-cell speed quantization (~13 km/h residual at 2 km / 5 min).
function _refineSubcell(shift, maxShift) {
    const { scores, dim } = shift;
    const cx = shift.dx + maxShift, cy = shift.dy + maxShift;
    const at = (x, y) => (x < 0 || x >= dim || y < 0 || y >= dim) ? 0 : scores[y * dim + x];
    let fx = 0, fy = 0;
    const denX = at(cx - 1, cy) - 2 * at(cx, cy) + at(cx + 1, cy);
    if (denX < 0) fx = 0.5 * (at(cx - 1, cy) - at(cx + 1, cy)) / denX;
    const denY = at(cx, cy - 1) - 2 * at(cx, cy) + at(cx, cy + 1);
    if (denY < 0) fy = 0.5 * (at(cx, cy - 1) - at(cx, cy + 1)) / denY;
    fx = Math.max(-0.5, Math.min(0.5, fx));
    fy = Math.max(-0.5, Math.min(0.5, fy));
    return { dx: shift.dx + fx, dy: shift.dy + fy };
}

// Last successful correlation vector — reused for up to MOTION_PERSIST_MS when
// a fresh estimate fails (small cells drop in and out of the correlation grid;
// storm motion doesn't change that fast).
let _lastMotion = null;    // { vec, atMs }

// PURE — motion estimate from steering-level wind (Open-Meteo 700 hPa, mph,
// meteorological "from" direction). Storm heading = from + 180. Used only when
// no radar correlation vector is available; consumers cap confidence at med.
function _fallbackMotionFromWind(speedMph, dirFromDeg) {
    if (speedMph === null || speedMph === undefined || dirFromDeg === null || dirFromDeg === undefined) return null;
    if (speedMph < RADAR_CFG.MOTION_WIND_MIN_MPH) return null;
    return {
        speed_kmh: Math.round(speedMph * 1.609),
        direction_deg: Math.round((dirFromDeg + 180) % 360),
        dx: null, dy: null,
        source: 'model-wind',
    };
}

async function estimateMotionVector(lat, lon, isUS) {
    const fresh = await _estimateMotionCorrelation(lat, lon, isUS);
    if (fresh) {
        _lastMotion = { vec: fresh, atMs: Date.now() };
        return fresh;
    }
    if (_lastMotion && (Date.now() - _lastMotion.atMs) <= RADAR_CFG.MOTION_PERSIST_MS) {
        return { ..._lastMotion.vec, source: 'persisted' };
    }
    return null;
}

async function _estimateMotionCorrelation(lat, lon, isUS) {
    if (_radarFrames.length < 3) return null;

    const recent = _radarFrames.slice(-3);
    // Need at least 2 frames with data
    const withData = recent.filter(f => f.dbz !== null);
    if (withData.length < 2) return null;

    const gridSize = RADAR_CFG.MOTION_GRID;
    const maxShift = RADAR_CFG.MOTION_MAX_SHIFT;
    // RainViewer frames are 10 min apart (vs IEM 5) — double the spacing so the
    // same ±maxShift window covers the same speed range.
    const spacingDeg = isUS ? 0.02 : 0.04;

    const grids = [];
    for (const frame of recent) {
        const frameInfo = await _histFrameInfo(isUS, frame);
        if (!frameInfo) { grids.push(null); continue; }
        grids.push(await _sampleBinaryGrid(lat, lon, isUS, frameInfo, gridSize, spacingDeg));
    }

    // Per-pair velocity vectors (km/h) — intervals come from frame timestamps,
    // so RainViewer's 10-min cadence no longer inflates speed 2×.
    const gridSpacingKm = spacingDeg * 111;
    const velocities = [];
    let sumDx = 0, sumDy = 0;
    for (let p = 0; p < grids.length - 1; p++) {
        const prev = grids[p];
        const curr = grids[p + 1];
        if (!prev || !curr) continue;
        if (prev.reduce((a, b) => a + b, 0) < 2 || curr.reduce((a, b) => a + b, 0) < 2) {
            continue; // Not enough rain to correlate
        }

        const shift = _bestShift(prev, curr, gridSize, maxShift);
        if (shift.score < RADAR_CFG.MOTION_MIN_OVERLAP) continue;
        const refined = _refineSubcell(shift, maxShift);

        let intervalMin = (recent[p + 1].timestamp - recent[p].timestamp) / 60;
        if (!(intervalMin > 0)) intervalMin = isUS ? 5 : 10;

        // The shift d aligns prev→curr as curr(g) ≈ prev(g + d), so true storm
        // motion = −d. Grid axes: +x = east, +y = north (see _sampleBinaryGrid).
        // (The pre-v1.46.0 code skipped this negation and mixed math/compass
        // conventions downstream — upstream sampling pointed 90° off.)
        velocities.push({
            vE: -refined.dx * gridSpacingKm / (intervalMin / 60),
            vN: -refined.dy * gridSpacingKm / (intervalMin / 60),
        });
        sumDx += refined.dx;
        sumDy += refined.dy;
    }

    if (velocities.length === 0) return null;

    // If we have 2 velocity vectors, check direction consistency
    if (velocities.length === 2) {
        const dir1 = Math.atan2(velocities[0].vN, velocities[0].vE);
        const dir2 = Math.atan2(velocities[1].vN, velocities[1].vE);
        const angleDiff = Math.abs(dir1 - dir2);
        if (angleDiff > Math.PI / 4 && angleDiff < 7 * Math.PI / 4) {
            return null; // Inconsistent direction — growth-in-place or chaotic
        }
    }

    const avgVE = velocities.reduce((s, v) => s + v.vE, 0) / velocities.length;
    const avgVN = velocities.reduce((s, v) => s + v.vN, 0) / velocities.length;
    const speed = Math.sqrt(avgVE ** 2 + avgVN ** 2);
    // Compass heading the storm is moving TOWARD (0 = N, 90 = E) — the
    // convention the upstream bearing math (cos→north, sin→east) expects.
    const direction = (Math.atan2(avgVE, avgVN) * 180 / Math.PI + 360) % 360;

    if (speed < 1) return null; // Essentially stationary

    return {
        dx: sumDx / velocities.length,
        dy: sumDy / velocities.length,
        speed_kmh: Math.round(speed),
        direction_deg: Math.round(direction),
        source: 'radar',
    };
}

// ── Slope Helpers ─────────────────────────────────────────────────────────────

// Least-squares slope for an equally-spaced series (returns dBZ per frame step).
function _lsSlope(values) {
    const n = values.length;
    if (n < 2) return 0;
    const meanX = (n - 1) / 2;
    const meanY = values.reduce((s, v) => s + v, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
        num += (i - meanX) * (values[i] - meanY);
        den += (i - meanX) ** 2;
    }
    return den === 0 ? 0 : num / den;
}

// Returns true if the consecutive differences change sign at most once (trend is clear).
function _hasConsistentDirection(values) {
    let flips = 0;
    for (let i = 2; i < values.length; i++) {
        const d1 = values[i - 1] - values[i - 2];
        const d2 = values[i]     - values[i - 1];
        if (d1 * d2 < 0) flips++;
    }
    return flips <= 1;
}

// ── Rain Timing Estimation ───────────────────────────────────────────────────

function estimateRainTiming(motionVector, currentDbz, isRaining) {
    const NONE = { beginInMin: null, endInMin: null, confidence: 'low' };

    if (!motionVector || motionVector.speed_kmh < 5) return NONE;

    const recentFrames = _radarFrames.slice(-RADAR_CFG.SLOPE_FRAMES);
    const recentDbz = recentFrames.map(f => f.dbz !== null ? f.dbz : 0);
    if (recentDbz.length < 3) return NONE;

    const slope = _lsSlope(recentDbz);
    const consistent = _hasConsistentDirection(recentDbz);

    if (!isRaining) {
        // Gate: slope must be rising, consistent, and a nearby echo must exist
        if (slope < RADAR_CFG.MIN_SLOPE_DBZ) return NONE;
        if (!consistent) return NONE;
        if (!recentDbz.some(d => d >= RADAR_CFG.BEGIN_SIGNAL_DBZ)) return NONE;

        const gapDbz = RADAR_CFG.ON_THRESHOLD - (currentDbz !== null && currentDbz !== undefined ? currentDbz : 0);
        if (gapDbz <= 0) return NONE;

        const beginInMin = Math.round((gapDbz / slope) * 5);
        if (beginInMin <= 0 || beginInMin > 60) return NONE;

        const confidence = slope >= 5 ? 'high' : slope >= 3 ? 'med' : 'low';
        return { beginInMin, endInMin: null, confidence };
    }

    // Raining — gate: slope must be falling, consistent, and meaningful rain must exist
    if (slope > -RADAR_CFG.MIN_SLOPE_DBZ) return NONE;
    if (!consistent) return NONE;
    if (!recentDbz.some(d => d >= RADAR_CFG.END_SIGNAL_DBZ)) return NONE;

    const currentIntensity = (currentDbz !== null && currentDbz !== undefined) ? currentDbz : RADAR_CFG.ON_THRESHOLD;

    // Already below OFF_THRESHOLD — hold timer is running
    if (currentIntensity <= RADAR_CFG.OFF_THRESHOLD) {
        return { beginInMin: null, endInMin: (RADAR_CFG.OFF_HOLD_MS / 60000), confidence: 'med' };
    }

    // Time to cross OFF_THRESHOLD + hold period
    const framesToCross = (currentIntensity - RADAR_CFG.OFF_THRESHOLD) / Math.abs(slope);
    const endInMin = Math.round(framesToCross * 5) + (RADAR_CFG.OFF_HOLD_MS / 60000);
    if (endInMin <= 0 || endInMin > 60) return NONE;

    const confidence = Math.abs(slope) >= 5 ? 'high' : Math.abs(slope) >= 3 ? 'med' : 'low';
    return { beginInMin: null, endInMin, confidence };
}

// ── Precipitation Timeline (0–60 min, 5-min buckets) ─────────────────────────
// Projects current dBZ forward using the least-squares slope from recent frames.
// Returns null if insufficient frame history (< 3 frames).
//
// precipClass values:
//   0 = dry        (< 18 dBZ)
//   1 = drizzle    (18–27 dBZ)
//   2 = rain       (28–34 dBZ)
//   3 = heavy rain (35–49 dBZ)
//   4 = convective (≥ 50 dBZ)
//
// Note: these intensity bands differ from hysteresis ON/OFF thresholds (28/22)
// intentionally — timeline uses descriptive intensity, not state-machine gates.

function _dbzToPrecipClass(dbz) {
    if (dbz < 22) return 0;   // dry  (matches ON_THRESHOLD)
    if (dbz < 30) return 1;   // drizzle / very light
    if (dbz < 40) return 2;   // light-moderate rain
    if (dbz < 50) return 3;   // heavy rain
    return 4;                  // convective
}

function buildPrecipTimeline(currentDbz, isRaining) {
    const recentFrames = _radarFrames.slice(-RADAR_CFG.SLOPE_FRAMES);
    if (recentFrames.length < 3) return null;

    const slope = _lsSlope(recentFrames.map(f => f.dbz !== null ? f.dbz : 0));
    const baseDbz = (currentDbz !== null && currentDbz !== undefined)
        ? currentDbz
        : (isRaining ? RADAR_CFG.ON_THRESHOLD : 0);

    return Array.from({ length: 12 }, (_, i) => {
        const projected = Math.max(0, baseDbz + slope * i);
        return {
            minute:       i * 5,
            precipClass:  _dbzToPrecipClass(projected),
            projectedDbz: Math.round(projected),
            confidence:   Math.max(0.1, 1.0 - i * 0.10)  // faster decay — slope extrapolation loses reliability quickly
        };
    });
}

// ── Edge Timing (Lagrangian advection along the storm track) ─────────────────
// Marches upstream along the motion vector on the latest frame, finds the
// leading edge (dry case) or trailing edge (wet case) of the echo, and derives
// arrival/clearing time from edge distance ÷ closing speed. This is geometry,
// not slope extrapolation — the core of the 5–10 min timing accuracy.

// Point at distKm upstream of (lat, lon) along motion.direction_deg (compass
// heading storm moves toward), offset lateralKm perpendicular to the track.
function _upstreamPoint(lat, lon, directionDeg, distKm, lateralKm) {
    const upB = ((directionDeg + 180) % 360) * Math.PI / 180;   // compass: 0=N
    const perpB = upB + Math.PI / 2;
    const kmPerDegLat = 111;
    const kmPerDegLon = 111 * Math.cos(lat * Math.PI / 180);
    return {
        lat: lat + (distKm * Math.cos(upB) + lateralKm * Math.cos(perpB)) / kmPerDegLat,
        lon: lon + (distKm * Math.sin(upB) + lateralKm * Math.sin(perpB)) / kmPerDegLon,
    };
}

// Sample the latest frame along the upstream ray. Returns [{ distKm, dbz }].
// Max distance = what the storm covers in EDGE_MAX_LOOKAHEAD_MIN, capped.
async function _marchUpstream(lat, lon, isUS, motion, frameInfo) {
    const maxKm = Math.min(
        motion.speed_kmh * (RADAR_CFG.EDGE_MAX_LOOKAHEAD_MIN / 60),
        RADAR_CFG.EDGE_MAX_RANGE_KM
    );
    const profile = [];
    for (let distKm = 0; distKm <= maxKm; distKm += RADAR_CFG.EDGE_STEP_KM) {
        const p = _upstreamPoint(lat, lon, motion.direction_deg, distKm, 0);
        let dbz = null;
        try {
            dbz = await _sampleFrameAtPoint(p.lat, p.lon, isUS, frameInfo);
        } catch (_) { /* treat as no echo */ }
        profile.push({ distKm, dbz });
    }
    return profile;
}

// PURE — leading edge: start of the first run of ≥ EDGE_WET_RUN_SAMPLES
// consecutive samples at ≥ BEGIN_SIGNAL_DBZ. Returns { distKm } or null.
function _findLeadingEdge(profile) {
    let run = 0;
    for (let i = 0; i < profile.length; i++) {
        const wet = profile[i].dbz !== null && profile[i].dbz >= RADAR_CFG.BEGIN_SIGNAL_DBZ;
        if (!wet) { run = 0; continue; }
        run++;
        if (run >= RADAR_CFG.EDGE_WET_RUN_SAMPLES) {
            return { distKm: profile[i - run + 1].distKm };
        }
    }
    return null;
}

// PURE — trailing edge: start of the first run of ≥ EDGE_DRY_GAP_SAMPLES
// consecutive dry samples (dBZ < EDGE_DRY_DBZ or no echo). The gap length
// requirement (~8 km) keeps a small hole inside a storm complex from reading
// as clearing. Returns { distKm, wetExtentKm } or null (rain past horizon).
function _findTrailingEdge(profile) {
    let dryRun = 0;
    for (let i = 0; i < profile.length; i++) {
        const dry = profile[i].dbz === null || profile[i].dbz < RADAR_CFG.EDGE_DRY_DBZ;
        if (!dry) { dryRun = 0; continue; }
        dryRun++;
        if (dryRun >= RADAR_CFG.EDGE_DRY_GAP_SAMPLES) {
            const edgeIdx = i - dryRun + 1;
            return {
                distKm: profile[edgeIdx].distKm,
                wetExtentKm: edgeIdx > 0 ? profile[edgeIdx - 1].distKm : 0,
            };
        }
    }
    return null;
}

// Track-over-point check at the edge: center + ±EDGE_LATERAL_KM perpendicular.
// Returns 0–3 hits at ≥ BEGIN_SIGNAL_DBZ.
async function _lateralSpreadHits(lat, lon, isUS, frameInfo, motion, distKm) {
    let hits = 0;
    for (const lateral of [0, RADAR_CFG.EDGE_LATERAL_KM, -RADAR_CFG.EDGE_LATERAL_KM]) {
        const p = _upstreamPoint(lat, lon, motion.direction_deg, distKm, lateral);
        try {
            const dbz = await _sampleFrameAtPoint(p.lat, p.lon, isUS, frameInfo);
            if (dbz !== null && dbz >= RADAR_CFG.BEGIN_SIGNAL_DBZ) hits++;
        } catch (_) { /* no hit */ }
    }
    return hits;
}

// PUBLIC — edge-geometry timing. Dry case → beginInMin from the leading edge;
// wet case → endInMin from the trailing edge. Returns null when motion is
// missing/too slow, no edge is found in range, or the profile has no data at
// all (likely tile failure — don't mistake it for instant clearing).
async function sampleEdgeTiming(lat, lon, isUS, motion, isRaining) {
    if (!motion || motion.speed_kmh < 5) return null;
    const latest = await _latestFrameInfo(isUS);
    if (!latest) return null;

    const profile = await _marchUpstream(lat, lon, isUS, motion, latest.frameInfo);
    if (profile.length === 0 || !profile.some(p => p.dbz !== null)) return null;

    if (!isRaining) {
        const edge = _findLeadingEdge(profile);
        if (!edge) return null;
        const beginInMin = Math.round(edge.distKm / motion.speed_kmh * 60);
        if (beginInMin > RADAR_CFG.EDGE_MAX_LOOKAHEAD_MIN) return null;
        const lateralHits = await _lateralSpreadHits(lat, lon, isUS, latest.frameInfo, motion, edge.distKm);
        return {
            beginInMin, endInMin: null,
            edgeDistKm: edge.distKm, closingSpeedKmh: motion.speed_kmh, lateralHits,
        };
    }

    const edge = _findTrailingEdge(profile);
    if (!edge) return null; // rain extends past the march horizon
    const endInMin = Math.round(edge.distKm / motion.speed_kmh * 60);
    if (endInMin > RADAR_CFG.EDGE_MAX_LOOKAHEAD_MIN) return null;
    return {
        beginInMin: null, endInMin,
        edgeDistKm: edge.distKm, closingSpeedKmh: motion.speed_kmh, lateralHits: null,
    };
}

// ── RainViewer Nowcast Frames (model-extrapolated future radar) ──────────────
// The weather-maps.json we already fetch contains a radar.nowcast array
// (~3 future frames at 10-min steps) that provides an independent, worldwide
// begin/end signal — RainViewer's own advection nowcast. Sampled at the point
// through the same tile pipeline (color=2 palette, tile cache).

// Sample all future frames at the point → [{ minuteAhead, dbz }] or null.
async function sampleRainviewerNowcast(lat, lon) {
    const maps = await _fetchRainViewerMaps();
    if (!maps || !maps.radar || !maps.radar.nowcast || maps.radar.nowcast.length === 0) return null;
    const nowSec = Date.now() / 1000;
    const samples = [];
    for (const f of maps.radar.nowcast) {
        const minuteAhead = Math.round((f.time - nowSec) / 60);
        if (minuteAhead < 0) continue; // stale future frame
        const dbz = await _sampleFrameAtPoint(lat, lon, false, {
            rvHost: maps.host, rvPath: f.path, rvRaw: true,
        });
        samples.push({ minuteAhead, dbz });
    }
    return samples.length > 0 ? samples : null;
}

// PURE — begin/end from RV nowcast samples. Begin ≈ midpoint of the last dry
// and first wet frame (frames are 10 min apart, so ±5 min quantization);
// end ≈ midpoint of last wet and first dry frame.
function _deriveRvTiming(rvSamples, isRaining) {
    const NONE = { beginInMin: null, endInMin: null };
    if (!rvSamples || rvSamples.length === 0) return NONE;
    let prevMinute = 0;
    for (const s of rvSamples) {
        const wet = s.dbz !== null && s.dbz >= RADAR_CFG.ON_THRESHOLD;
        if (!isRaining && wet) {
            return { beginInMin: Math.round((prevMinute + s.minuteAhead) / 2), endInMin: null };
        }
        if (isRaining && !wet) {
            return { beginInMin: null, endInMin: Math.round((prevMinute + s.minuteAhead) / 2) };
        }
        prevMinute = s.minuteAhead;
    }
    return NONE;
}

