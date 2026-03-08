// Radar Sampler — tile loading, canvas pixel sampling, dBZ estimation, hysteresis
// Supports IEM NEXRAD (US) and RainViewer (worldwide).
// No DOM side effects visible to user.
//
// Exports (globals): sampleRadarAtPoint, loadRadarHistory, getRadarFrames,
//                    estimateMotionVector, estimateRainTiming

// ── Configuration ────────────────────────────────────────────────────────────

const RADAR_CFG = {
    ZOOM:               6,       // tile zoom level (max 7 for RainViewer)
    TILE_SIZE:          256,
    ON_THRESHOLD:       28,      // dBZ to declare rain ON
    OFF_THRESHOLD:      22,      // dBZ to declare rain OFF
    ON_CONFIRM_FRAMES:  2,       // consecutive frames above ON to confirm
    OFF_HOLD_MS:        12 * 60 * 1000, // 12 min hold after last above-threshold
    OFF_HOLD_MIN:       12,      // must equal OFF_HOLD_MS / 60000
    THUNDER_DBZ:        45,
    FRAME_COUNT:        10,      // number of historical frames to keep
    EDGE_MARGIN:        5,       // pixels from edge to trigger neighbor tile fetch
    NEIGHBORHOOD_RADIUS: 1,      // px radius for neighborhood sampling (3×3 at r=1)
    SLOPE_FRAMES:       6,       // frames used for regression (~30 min)
    MIN_SLOPE_DBZ:      2,       // dBZ/frame minimum meaningful slope
    BEGIN_SIGNAL_DBZ:   18,      // min dBZ in any recent frame to allow "begin" prediction
    END_SIGNAL_DBZ:     30,      // min dBZ in any recent frame to allow "end" prediction
    IEM_BASE:           'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0',
    RAINVIEWER_API:     'https://api.rainviewer.com/public/weather-maps.json',
};

// ── State ────────────────────────────────────────────────────────────────────

let _radarFrames = [];      // [{ timestamp, dbz, source }]
let _rainState   = 'OFF';   // OFF | PENDING_ON | ON | HOLDING
let _lastOnTime  = null;    // Date when rain was last confirmed ON
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

// Sample a (2r+1)×(2r+1) neighborhood and return the max dBZ found (or null).
function _sampleNeighborhoodMax(img, pxX, pxY, radius) {
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

    let maxDbz = null;
    for (let i = 0; i < w * h; i++) {
        const dbz = _colorToDBZ(imgData[i * 4], imgData[i * 4 + 1], imgData[i * 4 + 2], imgData[i * 4 + 3]);
        if (dbz !== null && (maxDbz === null || dbz > maxDbz)) maxDbz = dbz;
    }
    return maxDbz;
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
    { r: 255, g: 255, b: 255, dbz: 70,   label: 'extreme' },   // white
];

function _colorToDBZ(r, g, b, a) {
    // Transparent or near-transparent = no data
    if (a < 20) return null;

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

    // If the match is very poor (dist > 30000), treat as unknown/no-data
    if (bestDist > 30000) return null;

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
    let dbz = _sampleNeighborhoodMax(img, pxX, pxY, r);

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
            if (nImg) dbz = _sampleNeighborhoodMax(nImg, nPxX, nPxY, r);
        }
    }

    return dbz;
}

// ── Hysteresis state machine ─────────────────────────────────────────────────

function _processFrame(timestamp, dbz) {
    const now = Date.now();

    if (dbz === null) {
        // No data — don't change state, but if HOLDING, check timeout
        if (_rainState === 'HOLDING' && _lastOnTime && (now - _lastOnTime) > RADAR_CFG.OFF_HOLD_MS) {
            _rainState = 'OFF';
            _pendingOnCount = 0;
        }
        return;
    }

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
        source
    };
}

// ── Public: get current frame list (for debugging) ───────────────────────────

function getRadarFrames() {
    return _radarFrames.slice();
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
        return { beginInMin: null, endInMin: RADAR_CFG.OFF_HOLD_MIN, confidence: 'med' };
    }

    // Time to cross OFF_THRESHOLD + hold period
    const framesToCross = (currentIntensity - RADAR_CFG.OFF_THRESHOLD) / Math.abs(slope);
    const endInMin = Math.round(framesToCross * 5) + RADAR_CFG.OFF_HOLD_MIN;
    if (endInMin <= 0 || endInMin > 60) return NONE;

    const confidence = Math.abs(slope) >= 5 ? 'high' : Math.abs(slope) >= 3 ? 'med' : 'low';
    return { beginInMin: null, endInMin, confidence };
}

// ── Reset (called on location change) ────────────────────────────────────────

function resetRadarState() {
    _radarFrames = [];
    _rainState = 'OFF';
    _lastOnTime = null;
    _pendingOnCount = 0;
    _radarHistoryLoaded = false;
    _radarHistoryPending = null;
}
