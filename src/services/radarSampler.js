// Radar Sampler — tile loading, canvas pixel sampling, dBZ estimation, hysteresis
// Supports IEM NEXRAD (US) and RainViewer (worldwide).
// No DOM side effects visible to user.
//
// Exports (globals): sampleRadarAtPoint, loadRadarHistory, getRadarFrames,
//                    estimateMotionVector, estimateRainTiming, buildPrecipTimeline,
//                    sampleUpstreamTimeline

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

// ── Pixel sampling ───────────────────────────────────────────────────────────

// Sample a (2r+1)×(2r+1) neighborhood and return the median dBZ (or null).
// Requires at least MIN_VALID_PIXELS valid pixels to return a result.
// Median is robust against isolated artifact pixels that max would amplify.
function _sampleNeighborhood(img, pxX, pxY, radius) {
    const { canvas, ctx } = _getCanvas();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, RADAR_CFG.TILE_SIZE, RADAR_CFG.TILE_SIZE);

    const x0 = Math.max(0, pxX - radius);
    const y0 = Math.max(0, pxY - radius);
    const x1 = Math.min(RADAR_CFG.TILE_SIZE - 1, pxX + radius);
    const y1 = Math.min(RADAR_CFG.TILE_SIZE - 1, pxY + radius);
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const imgData = ctx.getImageData(x0, y0, w, h).data;

    const valid = [];
    let _debugGray = 0, _debugDist = 0, _debugMatch = 0;
    for (let i = 0; i < w * h; i++) {
        const dbz = _colorToDBZ(imgData[i * 4], imgData[i * 4 + 1], imgData[i * 4 + 2], imgData[i * 4 + 3]);
        if (dbz !== null) {
            valid.push(dbz);
            _debugMatch++;
        }
    }

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

async function _fetchIEMTile(timestamp, z, x, y) {
    const url = `${RADAR_CFG.IEM_BASE}/ridge::USCOMP-N0Q-${timestamp}/${z}/${x}/${y}.png`;
    return _loadImage(url);
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

async function _fetchRVTile(host, path, z, x, y) {
    // color=2 (universal blue), smooth=1, snow=1
    const url = `${host}${path}/${RADAR_CFG.TILE_SIZE}/${z}/${x}/${y}/2/1_1.png`;
    return _loadImage(url);
}

// ── Sample a single frame at a point ─────────────────────────────────────────

async function _sampleFrameAtPoint(lat, lon, isUS, frameInfo) {
    const { tileX, tileY, pxX, pxY } = _latLonToTile(lat, lon, RADAR_CFG.ZOOM);

    let img;
    if (isUS && frameInfo.iemTs) {
        img = await _fetchIEMTile(frameInfo.iemTs, RADAR_CFG.ZOOM, tileX, tileY);
    } else if (frameInfo.rvHost && frameInfo.rvPath) {
        img = await _fetchRVTile(frameInfo.rvHost, frameInfo.rvPath, RADAR_CFG.ZOOM, tileX, tileY);
    }
    if (!img) return null;

    const r = RADAR_CFG.NEIGHBORHOOD_RADIUS;
    let dbz = _sampleNeighborhood(img, pxX, pxY, r);

    // Edge handling: if near tile boundary and neighborhood found nothing, try neighbor tile
    if (dbz === null && (
        pxX < RADAR_CFG.EDGE_MARGIN || pxX > RADAR_CFG.TILE_SIZE - RADAR_CFG.EDGE_MARGIN ||
        pxY < RADAR_CFG.EDGE_MARGIN || pxY > RADAR_CFG.TILE_SIZE - RADAR_CFG.EDGE_MARGIN)) {
        const neighborX = pxX < RADAR_CFG.EDGE_MARGIN ? tileX - 1 : (pxX > RADAR_CFG.TILE_SIZE - RADAR_CFG.EDGE_MARGIN ? tileX + 1 : tileX);
        const neighborY = pxY < RADAR_CFG.EDGE_MARGIN ? tileY - 1 : (pxY > RADAR_CFG.TILE_SIZE - RADAR_CFG.EDGE_MARGIN ? tileY + 1 : tileY);
        if (neighborX !== tileX || neighborY !== tileY) {
            const nPxX = pxX < RADAR_CFG.EDGE_MARGIN ? RADAR_CFG.TILE_SIZE - 1 - r : (pxX > RADAR_CFG.TILE_SIZE - RADAR_CFG.EDGE_MARGIN ? r : pxX);
            const nPxY = pxY < RADAR_CFG.EDGE_MARGIN ? RADAR_CFG.TILE_SIZE - 1 - r : (pxY > RADAR_CFG.TILE_SIZE - RADAR_CFG.EDGE_MARGIN ? r : pxY);
            let nImg;
            if (isUS && frameInfo.iemTs) {
                nImg = await _fetchIEMTile(frameInfo.iemTs, RADAR_CFG.ZOOM, neighborX, neighborY);
            } else if (frameInfo.rvHost && frameInfo.rvPath) {
                nImg = await _fetchRVTile(frameInfo.rvHost, frameInfo.rvPath, RADAR_CFG.ZOOM, neighborX, neighborY);
            }
            if (nImg) dbz = _sampleNeighborhood(nImg, nPxX, nPxY, r);
        }
    }

    return dbz;
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
        if (isUS) {
            const stamps = _iemTimestamps(1);
            dbz = await _sampleFrameAtPoint(lat, lon, true, { iemTs: stamps[0].ts });
            timestamp = stamps[0].time;
        } else {
            const maps = await _fetchRainViewerMaps();
            if (maps && maps.radar && maps.radar.past && maps.radar.past.length > 0) {
                const latest = maps.radar.past[maps.radar.past.length - 1];
                dbz = await _sampleFrameAtPoint(lat, lon, false, {
                    rvHost: maps.host, rvPath: latest.path
                });
                timestamp = latest.time;
            }
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
}

// ── Motion Vector Estimation (coarse correlation) ────────────────────────────
// Samples a grid around the point for multiple frames, finds best shift via
// binary mask overlap. Returns null if motion is inconsistent.

async function estimateMotionVector(lat, lon, isUS) {
    if (_radarFrames.length < 3) return null;

    const recent = _radarFrames.slice(-3);
    // Need at least 2 frames with data
    const withData = recent.filter(f => f.dbz !== null);
    if (withData.length < 2) return null;

    // Sample a 5x5 grid around the point for each frame
    const gridSize = 5;
    const gridSpacingDeg = 0.02; // ~2km at mid-latitudes
    const grids = [];

    for (const frame of recent) {
        const grid = [];
        for (let gy = 0; gy < gridSize; gy++) {
            for (let gx = 0; gx < gridSize; gx++) {
                const gLat = lat + (gy - 2) * gridSpacingDeg;
                const gLon = lon + (gx - 2) * gridSpacingDeg;

                let frameInfo;
                if (isUS) {
                    // Reconstruct IEM timestamp from unix time
                    const t = new Date(frame.timestamp * 1000);
                    const ts = t.getUTCFullYear().toString() +
                        String(t.getUTCMonth() + 1).padStart(2, '0') +
                        String(t.getUTCDate()).padStart(2, '0') +
                        String(t.getUTCHours()).padStart(2, '0') +
                        String(Math.floor(t.getUTCMinutes() / 5) * 5).padStart(2, '0');
                    frameInfo = { iemTs: ts };
                } else {
                    const maps = await _fetchRainViewerMaps();
                    if (!maps) return null;
                    const matchFrame = maps.radar.past.find(f => f.time === frame.timestamp);
                    if (!matchFrame) continue;
                    frameInfo = { rvHost: maps.host, rvPath: matchFrame.path };
                }

                const dbz = await _sampleFrameAtPoint(gLat, gLon, isUS, frameInfo);
                grid.push(dbz !== null && dbz >= RADAR_CFG.OFF_THRESHOLD ? 1 : 0);
            }
        }
        grids.push(grid);
    }

    if (grids.length < 2) return null;

    // Coarse correlation: find best shift between consecutive frame pairs
    const shifts = [];
    for (let p = 0; p < grids.length - 1; p++) {
        const prev = grids[p];
        const curr = grids[p + 1];

        // Check if either frame has any rain pixels
        if (prev.reduce((a, b) => a + b, 0) < 2 || curr.reduce((a, b) => a + b, 0) < 2) {
            continue; // Not enough rain to correlate
        }

        let bestScore = -1;
        let bestDx = 0, bestDy = 0;

        // Search over ±2 pixel shifts
        for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
                let score = 0;
                for (let gy = 0; gy < gridSize; gy++) {
                    for (let gx = 0; gx < gridSize; gx++) {
                        const sy = gy + dy;
                        const sx = gx + dx;
                        if (sy < 0 || sy >= gridSize || sx < 0 || sx >= gridSize) continue;
                        // Overlap: shifted prev[sy*5+sx] matches curr[gy*5+gx]
                        if (prev[sy * gridSize + sx] === 1 && curr[gy * gridSize + gx] === 1) {
                            score++;
                        }
                    }
                }
                if (score > bestScore) {
                    bestScore = score;
                    bestDx = dx;
                    bestDy = dy;
                }
            }
        }

        if (bestScore >= 2) {
            shifts.push({ dx: bestDx, dy: bestDy });
        }
    }

    if (shifts.length === 0) return null;

    // If we have 2 shifts, check consistency
    if (shifts.length === 2) {
        const dir1 = Math.atan2(shifts[0].dy, shifts[0].dx);
        const dir2 = Math.atan2(shifts[1].dy, shifts[1].dx);
        const angleDiff = Math.abs(dir1 - dir2);
        if (angleDiff > Math.PI / 4 && angleDiff < 7 * Math.PI / 4) {
            return null; // Inconsistent direction — growth-in-place or chaotic
        }
    }

    // Average the shifts
    const avgDx = shifts.reduce((s, v) => s + v.dx, 0) / shifts.length;
    const avgDy = shifts.reduce((s, v) => s + v.dy, 0) / shifts.length;

    // Convert grid units to approximate km/h
    // At 5-min frame intervals and ~2km grid spacing
    const frameIntervalMin = 5;
    const gridSpacingKm = gridSpacingDeg * 111; // rough conversion
    const speed = Math.sqrt(avgDx ** 2 + avgDy ** 2) * gridSpacingKm / (frameIntervalMin / 60);
    const direction = (Math.atan2(-avgDy, avgDx) * 180 / Math.PI + 360) % 360;

    if (speed < 1) return null; // Essentially stationary

    return { dx: avgDx, dy: avgDy, speed_kmh: Math.round(speed), direction_deg: Math.round(direction) };
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

// ── Upstream Sampling (Lagrangian advection, dry-case only) ──────────────────
// For each lookahead bucket, computes the point that is currently upstream
// along the motion vector by distance = speed × (t/60) km.  Samples the
// current (latest) radar frame at that point plus ±LATERAL_KM perpendicular
// spread for a track-over-point check.
//
// Returns an array of bucket results:
//   { minute, centerDbz, lateralHits, upstreamLat, upstreamLon }
//   lateralHits: how many of the 3 spread points (center + ±lateral) show dBZ ≥ 18.
//
// Returns null if motion vector is missing or too slow.

const UPSTREAM_LATERAL_KM = 3; // ±km perpendicular spread for track check

async function sampleUpstreamTimeline(lat, lon, isUS, motion, buckets = [10, 20, 30]) {
    if (!motion || motion.speed_kmh < 5) return null;

    // Latest frameInfo — needed to call _sampleFrameAtPoint
    let latestFrameInfo = null;
    if (isUS) {
        const stamps = _iemTimestamps(1);
        latestFrameInfo = { iemTs: stamps[0].ts };
    } else {
        const maps = await _fetchRainViewerMaps();
        if (!maps || !maps.radar || !maps.radar.past || maps.radar.past.length === 0) return null;
        const latest = maps.radar.past[maps.radar.past.length - 1];
        latestFrameInfo = { rvHost: maps.host, rvPath: latest.path };
    }

    // Upstream bearing: opposite of motion direction
    const upstreamBearing = ((motion.direction_deg + 180) % 360) * Math.PI / 180;
    const latRad = lat * Math.PI / 180;
    const kmPerDegLat = 111;
    const kmPerDegLon = 111 * Math.cos(latRad);

    // Perpendicular bearing (90° offset from upstream)
    const perpBearing = (((motion.direction_deg + 180) % 360) + 90) * Math.PI / 180;

    const results = [];

    for (const minute of buckets) {
        const distKm = motion.speed_kmh * (minute / 60);

        // Center upstream point
        const uLat = lat + (distKm * Math.cos(upstreamBearing)) / kmPerDegLat;
        const uLon = lon + (distKm * Math.sin(upstreamBearing)) / kmPerDegLon;

        // Three spread points: center, +lateral, -lateral
        const spreadPoints = [
            { sLat: uLat, sLon: uLon },
            {
                sLat: uLat + (UPSTREAM_LATERAL_KM * Math.cos(perpBearing)) / kmPerDegLat,
                sLon: uLon + (UPSTREAM_LATERAL_KM * Math.sin(perpBearing)) / kmPerDegLon,
            },
            {
                sLat: uLat - (UPSTREAM_LATERAL_KM * Math.cos(perpBearing)) / kmPerDegLat,
                sLon: uLon - (UPSTREAM_LATERAL_KM * Math.sin(perpBearing)) / kmPerDegLon,
            },
        ];

        let centerDbz = null;
        let lateralHits = 0;

        for (let i = 0; i < spreadPoints.length; i++) {
            const { sLat, sLon } = spreadPoints[i];
            try {
                const dbz = await _sampleFrameAtPoint(sLat, sLon, isUS, latestFrameInfo);
                if (i === 0) centerDbz = dbz;
                if (dbz !== null && dbz >= RADAR_CFG.BEGIN_SIGNAL_DBZ) lateralHits++;
            } catch (_) {
                // treat as null — no rain signal
            }
        }

        results.push({ minute, centerDbz, lateralHits, upstreamLat: uLat, upstreamLon: uLon });
    }

    return results;
}

// ── Reset (called on location change) ────────────────────────────────────────

function resetRadarState() {
    _radarFrames = [];
    _rainState = 'OFF';
    _lastOnTime = null;
    _lastValidDbzTime = null;
    _pendingOnCount = 0;
    _radarHistoryLoaded = false;
    _radarHistoryPending = null;
}
