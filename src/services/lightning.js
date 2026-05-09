// Lightning Service — NOAA GOES GLM polling, rolling flash buffer, state summarization
// Polls NOAA GLM (Geostationary Lightning Mapper) for recent lightning flash data
// in the Americas (~52N–52S). Accumulates flashes in a rolling 20-minute buffer.
// On each nowcast poll cycle, summarizeLightningBuffer() classifies the lightning state.
//
// GLM provides storm-scale flash detection at ~10 km resolution — this is NOT
// precise cloud-to-ground strike localization. Distance bands and confidence
// levels are intentionally broader than the old Blitzortung source.
//
// Coverage: Americas only (GOES-East + GOES-West). Outside coverage → METAR fallback.
// Provider abstraction: getLightningDataSource(lat, lon, country) returns the active provider.
//
// Exports (globals): startLightning, stopLightning, summarizeLightningBuffer, getLightningDataSource

// ── Configuration ────────────────────────────────────────────────────────────

const LIGHTNING_CFG = {
    // ── Adapter boundary ─────────────────────────────────────────────────────
    // fetchGlmFlashes() is the sole data ingestion point. Default uses nowCOAST
    // ArcGIS MapServer. To use a custom proxy, set GLM_ENDPOINT to its URL.
    // The proxy should accept ?bbox=W,S,E,N&minutes=N and return JSON:
    //   { flashes: [{ lat, lon, timeMs, energy? }] }
    GLM_ENDPOINT: null, // null = use nowCOAST default

    // nowCOAST ArcGIS MapServer — lightning strike density layer
    // Returns JSON features within a bounding box and time window.
    NOWCOAST_BASE: 'https://nowcoast.noaa.gov/arcgis/rest/services/nowcoast/sat_meteo_emulated_imagery_lightningstrikedensity_goes_time/MapServer/0/query',

    // ── Buffer / classification ──────────────────────────────────────────────
    BUFFER_MAX_AGE_MS: 20 * 60 * 1000,   // 20 min rolling window
    BAND_10MI_WINDOW:  10 * 60 * 1000,   // within 10 mi in last 10 min
    BAND_20MI_WINDOW:  15 * 60 * 1000,   // within 20 mi in last 15 min
    BAND_40MI_WINDOW:  20 * 60 * 1000,   // within 40 mi in last 20 min

    BBOX_PADDING_DEG:  0.6,              // ~40 mi padding for fetch area
    MILES_PER_DEG_LAT: 69.0,             // approximate

    // ── Polling cadence ──────────────────────────────────────────────────────
    POLL_ACTIVE_MS:  60 * 1000,          // active storms: 60 sec
    POLL_NORMAL_MS: 120 * 1000,          // unsettled: 2 min
    POLL_QUIET_MS:  300 * 1000,          // dry/quiet: 5 min

    // ── Coverage bounds (GOES-East + GOES-West combined) ─────────────────────
    COVERAGE_LAT_MIN: -52,
    COVERAGE_LAT_MAX:  52,
    COVERAGE_LON_MIN: -170,
    COVERAGE_LON_MAX:  -15,

    // ── GOES S3 direct access ──────────────────────────────────────────────
    S3_BUCKET_EAST: 'https://noaa-goes19.s3.amazonaws.com',  // GOES-East (G19)
    S3_BUCKET_WEST: 'https://noaa-goes18.s3.amazonaws.com',  // GOES-West (G18)
    S3_SAT_LON_THRESHOLD: -105,     // auto mode: lon > threshold → GOES-East
    S3_SAT_SELECT: 'auto',          // 'auto' | 'east' | 'west'
    S3_PRODUCT_PREFIX: 'GLM-L2-LCFA',
    S3_MAX_FILES_PER_POLL: 5,       // cap after time-based filtering
    S3_FILE_MAX_AGE_MS: 3 * 60 * 1000,  // only fetch files with embedded ts ≤ 3 min old
    S3_FILE_SIZE_CAP: 2 * 1024 * 1024,  // skip files > 2 MB

    // ── Fetch timeout ────────────────────────────────────────────────────────
    FETCH_TIMEOUT_MS: 15000,
};

// ── jsfive lazy loader ────────────────────────────────────────────────────────
// Pure JS HDF5 reader (176 KB) from NIST. Loaded on first lightning poll only.
// Vendored locally — no CDN runtime dependency.

let _jsfive = null;

async function _loadJsfive() {
    if (_jsfive) return _jsfive;
    try {
        // Resolve relative to page root using absolute path
        const mod = await import('/lib/jsfive.esm.js');
        _jsfive = mod;
        console.log('[Lightning] jsfive HDF5 reader loaded');
        return _jsfive;
    } catch (err) {
        console.warn('[Lightning] Failed to load jsfive:', err.message);
        return null;
    }
}

// ── State ────────────────────────────────────────────────────────────────────

let _lxBuffer = [];               // [{ lat, lon, timeMs, energy }]
let _lxDedup  = new Set();        // O(1) dedup keys for buffer entries
let _lxPollTimer = null;
let _lxLastPollOk = false;        // did last poll succeed?
let _lxLat = null;
let _lxLon = null;
let _lxLastFlashAt = null;
let _lxStopped = true;
let _lxAbortController = null;  // cancels in-flight fetches on stop/restart
let _lxSeenFiles = new Map();     // S3 key → seenAt (epoch ms), pruned by 60-min age
let _lxSizeWarnLogged = false;    // log file-size-cap warning only once

// ── Distance helper ──────────────────────────────────────────────────────────
// Equirectangular approximation — intentionally NOT consolidated into geo.js.
// Hot path during flash processing; exact haversine is slower and error is <1% at <50mi.

function _flashMiles(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * LIGHTNING_CFG.MILES_PER_DEG_LAT;
    const avgLatRad = ((lat1 + lat2) / 2) * Math.PI / 180;
    const dLon = (lon2 - lon1) * LIGHTNING_CFG.MILES_PER_DEG_LAT * Math.cos(avgLatRad);
    return Math.sqrt(dLat * dLat + dLon * dLon);
}

// ── Coverage check ───────────────────────────────────────────────────────────

function _isInGlmCoverage(lat, lon) {
    return lat >= LIGHTNING_CFG.COVERAGE_LAT_MIN
        && lat <= LIGHTNING_CFG.COVERAGE_LAT_MAX
        && lon >= LIGHTNING_CFG.COVERAGE_LON_MIN
        && lon <= LIGHTNING_CFG.COVERAGE_LON_MAX;
}

// ── S3 helpers ──────────────────────────────────────────────────────────────

/** Pick GOES bucket URL based on config + longitude. */
function _pickSatBucket(lon) {
    const sel = LIGHTNING_CFG.S3_SAT_SELECT;
    if (sel === 'east') return LIGHTNING_CFG.S3_BUCKET_EAST;
    if (sel === 'west') return LIGHTNING_CFG.S3_BUCKET_WEST;
    return lon > LIGHTNING_CFG.S3_SAT_LON_THRESHOLD
        ? LIGHTNING_CFG.S3_BUCKET_EAST
        : LIGHTNING_CFG.S3_BUCKET_WEST;
}

/** Build S3 listing URL for a given bucket + UTC hour. */
function _buildS3ListUrl(bucket, utcDate) {
    const yyyy = utcDate.getUTCFullYear();
    const jan1 = new Date(Date.UTC(yyyy, 0, 1));
    const ddd = String(Math.floor((utcDate - jan1) / 86400000) + 1).padStart(3, '0');
    const hh = String(utcDate.getUTCHours()).padStart(2, '0');
    const prefix = `${LIGHTNING_CFG.S3_PRODUCT_PREFIX}/${yyyy}/${ddd}/${hh}/`;
    return `${bucket}/?list-type=2&prefix=${prefix}&delimiter=/`;
}

/** Parse S3 ListBucketResult XML → sorted array of { key, size }. */
function _parseS3Listing(xmlText) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, 'application/xml');
    const contents = doc.getElementsByTagName('Contents');
    const entries = [];
    for (let i = 0; i < contents.length; i++) {
        const keyEl = contents[i].getElementsByTagName('Key')[0];
        const sizeEl = contents[i].getElementsByTagName('Size')[0];
        if (keyEl && keyEl.textContent) {
            entries.push({
                key: keyEl.textContent,
                size: sizeEl ? parseInt(sizeEl.textContent, 10) : 0,
            });
        }
    }
    entries.sort((a, b) => a.key.localeCompare(b.key));
    return entries;
}

/**
 * Parse embedded start-time from GLM filename → epoch ms.
 * Filename pattern: OR_GLM-L2-LCFA_G19_sYYYYDDDHHMMSSs_e..._c....nc
 * The 's' field (start time) is YYYYDDDHHMMSSs (14 chars, last is tenths).
 */
function _extractFileTimestamp(key) {
    const match = key.match(/_s(\d{14})/);
    if (!match) return null;
    const s = match[1]; // e.g. 20260761830205
    const yyyy = parseInt(s.substring(0, 4), 10);
    const ddd  = parseInt(s.substring(4, 7), 10);
    const hh   = parseInt(s.substring(7, 9), 10);
    const mm   = parseInt(s.substring(9, 11), 10);
    const ss   = parseInt(s.substring(11, 13), 10);
    const jan1 = new Date(Date.UTC(yyyy, 0, 1));
    return jan1.getTime() + (ddd - 1) * 86400000 + hh * 3600000 + mm * 60000 + ss * 1000;
}

/** Remove entries from _lxSeenFiles older than 60 minutes. */
function _pruneSeenFiles() {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [key, seenAt] of _lxSeenFiles) {
        if (seenAt < cutoff) _lxSeenFiles.delete(key);
    }
}

/**
 * Returns the active lightning data provider for a location.
 * @returns {'glm'|'metar-fallback'|'none'}
 */
function getLightningDataSource(lat, lon, country) {
    if (_isInGlmCoverage(lat, lon)) return 'glm';
    // Outside GLM coverage — METAR thunder codes are the only fallback.
    // Whether METAR is actually available depends on NWS station proximity (US only).
    if (country === 'United States') return 'metar-fallback';
    return 'none';
}

// ── NetCDF parser ───────────────────────────────────────────────────────────
// Extracts flash locations/times from a GLM LCFA HDF5 file.
// Probes candidate variable names defensively — NOAA naming may vary across
// product versions, and jsfive doesn't support all HDF5 features.

const _GLM_LAT_NAMES = ['flash_lat', 'group_lat', 'event_lat'];
const _GLM_LON_NAMES = ['flash_lon', 'group_lon', 'event_lon'];
const _GLM_TIME_NAMES = ['flash_time_offset_of_last_event', 'group_time_offset', 'event_time_offset'];
const _GLM_ENERGY_NAMES = ['flash_energy', 'group_energy', 'event_energy'];
let _glmVarWarnLogged = false;

/** Try to get a dataset by probing a list of candidate names. */
function _probeVar(file, candidates) {
    for (const name of candidates) {
        try {
            const ds = file.get(name);
            if (ds && ds.value && ds.value.length > 0) return { ds, name };
        } catch { /* name not present — try next */ }
    }
    return null;
}

/** Apply scale_factor/add_offset if present on a jsfive dataset. */
function _applyScaleOffset(ds) {
    const raw = ds.value;
    const scale = ds.attrs?.scale_factor ?? ds.attrs?.['scale_factor'] ?? 1;
    const offset = ds.attrs?.add_offset ?? ds.attrs?.['add_offset'] ?? 0;
    if (scale === 1 && offset === 0) return raw;
    return Array.from(raw, v => v * scale + offset);
}

/**
 * Parse a GLM LCFA NetCDF (HDF5) file and extract flash locations/times.
 * @param {ArrayBuffer} buf - raw file bytes
 * @returns {{ flashes: Array<{lat,lon,timeMs,energy}>, refTimeMs: number }}
 */
function _parseGlmNetcdf(buf) {
    const f = new _jsfive.File(buf);

    // Reference time from global attributes
    let refTimeMs = Date.now();
    try {
        const startAttr = f.attrs?.time_coverage_start
            ?? f.attrs?.['time_coverage_start'];
        if (startAttr) refTimeMs = new Date(startAttr).getTime();
    } catch { /* use Date.now() fallback */ }

    // Probe for lat/lon variables
    const latResult = _probeVar(f, _GLM_LAT_NAMES);
    const lonResult = _probeVar(f, _GLM_LON_NAMES);
    if (!latResult || !lonResult) return { flashes: [], refTimeMs };

    // Warn once if primary name was not found
    if (!_glmVarWarnLogged && (latResult.name !== 'flash_lat' || lonResult.name !== 'flash_lon')) {
        console.warn(`[Lightning] GLM variable name mismatch: using ${latResult.name}/${lonResult.name}`);
        _glmVarWarnLogged = true;
    }

    const lats = _applyScaleOffset(latResult.ds);
    const lons = _applyScaleOffset(lonResult.ds);
    if (!lats || lats.length === 0) return { flashes: [], refTimeMs };

    // Time offsets (seconds from reference time) — optional
    let timeOffsets = null;
    const timeResult = _probeVar(f, _GLM_TIME_NAMES);
    if (timeResult) {
        timeOffsets = _applyScaleOffset(timeResult.ds);
    }

    // Energy — optional
    let energies = null;
    const energyResult = _probeVar(f, _GLM_ENERGY_NAMES);
    if (energyResult) {
        try { energies = energyResult.ds.value; } catch { /* skip */ }
    }

    const flashes = [];
    for (let i = 0; i < lats.length; i++) {
        const lat = typeof lats[i] === 'number' ? lats[i] : lats[i];
        const lon = typeof lons[i] === 'number' ? lons[i] : lons[i];
        if (!isFinite(lat) || !isFinite(lon)) continue;
        const offsetSec = timeOffsets ? timeOffsets[i] : 0;
        const timeMs = refTimeMs + (isFinite(offsetSec) ? offsetSec * 1000 : 0);
        const energy = energies && i < energies.length ? energies[i] : null;
        flashes.push({ lat, lon, timeMs, energy });
    }

    return { flashes, refTimeMs };
}

// ── S3 adapter ──────────────────────────────────────────────────────────────
// Fetches recent GLM flashes directly from NOAA GOES S3 bucket.
// Lists current (and optionally previous) UTC hour, fetches unprocessed files
// whose embedded timestamp falls within the last S3_FILE_MAX_AGE_MS, parses
// NetCDF via jsfive, filters to bounding box + distance radius.

async function _fetchFromS3(lat, lon, signal) {
    const hdf5 = await _loadJsfive();
    if (!hdf5) return [];

    const bucket = _pickSatBucket(lon);
    const now = new Date();
    const nowMs = now.getTime();

    // List current hour
    let usable = await _listAndFilter(bucket, now, nowMs, signal);

    // Fallback: list previous hour if current yielded nothing usable
    if (usable.length === 0) {
        const prev = new Date(nowMs - 3600000);
        usable = await _listAndFilter(bucket, prev, nowMs, signal);
    }

    if (usable.length === 0) return [];

    // Cap at max files per poll
    usable = usable.slice(-LIGHTNING_CFG.S3_MAX_FILES_PER_POLL);

    // Fetch + parse each file
    const pad = LIGHTNING_CFG.BBOX_PADDING_DEG;
    const bboxS = lat - pad, bboxN = lat + pad;
    const bboxW = lon - pad, bboxE = lon + pad;
    const allFlashes = [];

    for (const { key } of usable) {
        try {
            const fileUrl = `${bucket}/${key}`;
            const resp = await fetch(fileUrl, { signal });
            if (!resp.ok) continue;
            const buf = await resp.arrayBuffer();
            const { flashes } = _parseGlmNetcdf(buf);

            for (const fl of flashes) {
                // Bbox prefilter
                if (fl.lat < bboxS || fl.lat > bboxN) continue;
                if (fl.lon < bboxW || fl.lon > bboxE) continue;
                // Distance filter — drop bbox-corner overreach
                if (_flashMiles(lat, lon, fl.lat, fl.lon) > 45) continue;
                allFlashes.push(fl);
            }
            _lxSeenFiles.set(key, Date.now());
        } catch { continue; }
    }

    _pruneSeenFiles();

    if (allFlashes.length > 0) {
        console.log(`[Lightning] S3: ${allFlashes.length} flash(es) from ${usable.length} file(s)`);
    }

    return allFlashes;
}

/**
 * List an S3 hour directory and filter to usable files:
 * - Timestamp within S3_FILE_MAX_AGE_MS
 * - Not already seen
 * - Size within S3_FILE_SIZE_CAP
 */
async function _listAndFilter(bucket, utcDate, nowMs, signal) {
    const url = _buildS3ListUrl(bucket, utcDate);
    let entries;
    try {
        const resp = await fetch(url, { signal, cache: 'no-cache' });
        if (!resp.ok) return [];
        entries = _parseS3Listing(await resp.text());
    } catch { return []; }

    const cutoff = nowMs - LIGHTNING_CFG.S3_FILE_MAX_AGE_MS;
    const maxSize = LIGHTNING_CFG.S3_FILE_SIZE_CAP;

    return entries.filter(({ key, size }) => {
        if (_lxSeenFiles.has(key)) return false;
        if (size > maxSize) {
            if (!_lxSizeWarnLogged) {
                console.warn(`[Lightning] Skipping oversized GLM file (${(size / 1024).toFixed(0)} KB): ${key}`);
                _lxSizeWarnLogged = true;
            }
            return false;
        }
        const ts = _extractFileTimestamp(key);
        return ts !== null && ts >= cutoff;
    });
}

// ── Adapter boundary: GLM data fetch ─────────────────────────────────────────
// This function is the SOLE point of GLM data ingestion. Everything downstream
// consumes its normalized output. Default: S3 direct fetch with jsfive parsing.
// If a custom GLM_ENDPOINT is configured, it uses the proxy adapter instead.

async function fetchGlmFlashes(lat, lon, externalSignal) {
    if (!_isInGlmCoverage(lat, lon)) return [];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LIGHTNING_CFG.FETCH_TIMEOUT_MS);

    // Combine external abort (stop/restart) with internal timeout
    const signal = externalSignal
        ? AbortSignal.any([externalSignal, controller.signal])
        : controller.signal;

    try {
        let flashes;
        if (LIGHTNING_CFG.GLM_ENDPOINT) {
            flashes = await _fetchFromProxy(lat, lon, signal);
        } else {
            flashes = await _fetchFromS3(lat, lon, signal);
        }
        return flashes;
    } catch (err) {
        if (err.name !== 'AbortError') {
            console.warn('[Lightning] GLM fetch failed:', err.message);
        }
        return [];
    } finally {
        clearTimeout(timeout);
    }
}

// ── Custom proxy adapter ─────────────────────────────────────────────────────
// Expected proxy response: { flashes: [{ lat, lon, timeMs, energy? }] }

async function _fetchFromProxy(lat, lon, signal) {
    const pad = LIGHTNING_CFG.BBOX_PADDING_DEG;
    const url = `${LIGHTNING_CFG.GLM_ENDPOINT}?bbox=${lon - pad},${lat - pad},${lon + pad},${lat + pad}&minutes=20`;

    const resp = await fetch(url, { signal, cache: 'no-cache' });
    if (!resp.ok) throw new Error(`GLM proxy ${resp.status}`);

    const data = await resp.json();
    if (!data || !Array.isArray(data.flashes)) return [];

    return data.flashes.map(f => ({
        lat: f.lat,
        lon: f.lon,
        timeMs: f.timeMs,
        energy: f.energy || null,
        density: 1,
    }));
}

// ── Buffer management ────────────────────────────────────────────────────────

function _flashKey(lat, lon, timeMs) {
    return `${lat.toFixed(2)}_${lon.toFixed(2)}_${Math.round(timeMs / 5000)}`;
}

function _pruneBuffer(now) {
    const cutoff = now - LIGHTNING_CFG.BUFFER_MAX_AGE_MS;
    _lxBuffer = _lxBuffer.filter(f => f.timeMs >= cutoff);
    _lxDedup = new Set(_lxBuffer.map(f => _flashKey(f.lat, f.lon, f.timeMs)));
}

function _updateBuffer(flashes, now) {
    if (!flashes || flashes.length === 0) return;

    for (const f of flashes) {
        if (f.lat == null || f.lon == null || !isFinite(f.lat) || !isFinite(f.lon)) continue;
        if (f.timeMs > now + 60000) continue; // reject future timestamps

        // Dedup: skip if a flash at the same rounded lat/lon/time already exists
        const key = _flashKey(f.lat, f.lon, f.timeMs);
        if (_lxDedup.has(key)) continue;
        _lxDedup.add(key);

        _lxBuffer.push({
            lat: f.lat,
            lon: f.lon,
            timeMs: f.timeMs,
            energy: f.energy,
        });

        if (!_lxLastFlashAt || f.timeMs > new Date(_lxLastFlashAt).getTime()) {
            _lxLastFlashAt = new Date(f.timeMs).toISOString();
        }
    }

    _pruneBuffer(now);
}

// ── Public: summarize buffer into lightningState ─────────────────────────────
// Called each nowcast poll cycle. Classifies lightning proximity and recency
// into a state object that the nowcast merge logic consumes.
//
// Distance bands (broader than Blitzortung — honest for GLM ~10 km resolution):
//   within10mi_10m: flashes within 10 mi in the last 10 min
//   within20mi_15m: flashes within 20 mi in the last 15 min
//   within40mi_20m: flashes within 40 mi in the last 20 min

function summarizeLightningBuffer(lat, lon) {
    const now = Date.now();
    _pruneBuffer(now);

    const cutoff10m = now - LIGHTNING_CFG.BAND_10MI_WINDOW;
    const cutoff15m = now - LIGHTNING_CFG.BAND_20MI_WINDOW;
    const cutoff20m = now - LIGHTNING_CFG.BAND_40MI_WINDOW;

    let nearestMi = null;
    let within10mi_10m = 0;
    let within20mi_15m = 0;
    let within40mi_20m = 0;

    // Trend tracking: split into recent (0–10 min) and prior (10–20 min)
    let recentCount = 0;  // 0–10 min, any distance ≤ 40 mi
    let priorCount = 0;   // 10–20 min, any distance ≤ 40 mi

    for (const flash of _lxBuffer) {
        const dist = _flashMiles(lat, lon, flash.lat, flash.lon);
        if (dist > 45) continue; // skip very distant flashes

        // Track nearest from the 20-min window so 'nearby' state always has a distance
        if (flash.timeMs >= cutoff20m) {
            if (nearestMi === null || dist < nearestMi) nearestMi = dist;
        }

        if (dist <= 10 && flash.timeMs >= cutoff10m) within10mi_10m++;
        if (dist <= 20 && flash.timeMs >= cutoff15m) within20mi_15m++;
        if (dist <= 40 && flash.timeMs >= cutoff20m) within40mi_20m++;

        // Trend buckets
        if (dist <= 40) {
            if (flash.timeMs >= cutoff10m) recentCount++;
            else priorCount++;
        }
    }

    if (nearestMi !== null) nearestMi = Math.round(nearestMi);

    // Classify state from distance bands
    let state = 'none';
    let confidence = 'none';

    if (within10mi_10m > 0) {
        state = 'active';
        confidence = 'high';
    } else if (within20mi_15m > 0) {
        state = 'nearby';
        confidence = 'medium';
    } else if (within40mi_20m >= 2) {
        // Require ≥2 flashes in the 40mi/20min band to declare "approaching".
        // A single stale distant flash would otherwise latch the state for up
        // to 20 minutes (see 2026-04-15 Boston backtest: 2h of "approaching"
        // with no thunder ever reaching the station).
        state = 'approaching';
        confidence = 'medium';
    }

    // Trend: rising if recent > prior, falling if recent < prior * 0.5
    let trend = null;
    if (within40mi_20m > 0) {
        if (recentCount > priorCount + 1) trend = 'rising';
        else if (recentCount < priorCount * 0.5 && priorCount >= 2) trend = 'falling';
        else trend = 'steady';
    }

    const provider = (_lxLat != null && _isInGlmCoverage(_lxLat, _lxLon)) ? 'glm' : 'none';

    return {
        state,
        nearestFlashMi: nearestMi,
        flashCounts: {
            within10mi: within10mi_10m,
            within20mi: within20mi_15m,
            within40mi: within40mi_20m,
        },
        updatedAt: new Date().toISOString(),
        source: state !== 'none' ? 'lightning' : (provider === 'glm' ? 'none' : 'unavailable'),
        confidence,
        connected: _lxLastPollOk,
        bufferAgeMs: _lxLastFlashAt
            ? now - new Date(_lxLastFlashAt).getTime()
            : null,
        lastFlashAt: _lxLastFlashAt,
        trend,
        provider,
    };
}

// ── Poll loop ────────────────────────────────────────────────────────────────

function _computeLightningPollInterval() {
    // Use the most recent summary to decide cadence
    if (_lxBuffer.length === 0) return LIGHTNING_CFG.POLL_QUIET_MS;

    const now = Date.now();
    const recent = _lxBuffer.filter(f => f.timeMs >= now - 10 * 60 * 1000);
    if (recent.length > 0) return LIGHTNING_CFG.POLL_ACTIVE_MS;

    const medium = _lxBuffer.filter(f => f.timeMs >= now - 20 * 60 * 1000);
    if (medium.length > 0) return LIGHTNING_CFG.POLL_NORMAL_MS;

    return LIGHTNING_CFG.POLL_QUIET_MS;
}

async function _lxPoll() {
    if (_lxStopped || _lxLat == null) return;

    const now = Date.now();
    try {
        const signal = _lxAbortController ? _lxAbortController.signal : undefined;
        const flashes = await fetchGlmFlashes(_lxLat, _lxLon, signal);
        if (_lxStopped) return; // location changed during fetch — discard stale data
        _lxLastPollOk = true;
        _updateBuffer(flashes, now);

        // First successful poll with data: immediately refresh nowcast display
        if (_lxBuffer.length > 0 && !_lxFirstRefreshDone) {
            _lxFirstRefreshDone = true;
            if (typeof getNowSummary === 'function' && typeof updateNowcastDisplay === 'function') {
                getNowSummary({ lat: _lxLat, lon: _lxLon, country: _lxCountry })
                    .then(summary => {
                        if (_lxStopped) return; // location changed — discard
                        // Guard: verify active location still matches this lightning poll
                        if (activeLocation && (activeLocation.lat !== _lxLat || activeLocation.lon !== _lxLon)) return;
                        cachedNowSummary = summary;
                        updateNowcastDisplay(summary);
                    })
                    .catch(() => {}); // non-critical
            }
        }
    } catch (err) {
        if (_lxStopped) return;
        _lxLastPollOk = false;
        if (err.name !== 'AbortError') {
            console.warn('[Lightning] Poll error:', err.message);
        }
    }

    if (_lxStopped) return;

    const interval = _computeLightningPollInterval();
    _lxPollTimer = setTimeout(_lxPoll, interval);
}

// ── Public: start / stop ─────────────────────────────────────────────────────

let _lxCountry = null;
let _lxFirstRefreshDone = false;

function startLightning(lat, lon, country) {
    _lxLat = lat;
    _lxLon = lon;
    _lxCountry = country || null;
    _lxBuffer = [];
    _lxDedup = new Set();
    _lxLastFlashAt = null;
    _lxLastPollOk = false;
    _lxStopped = false;
    _lxAbortController = new AbortController();
    _lxFirstRefreshDone = false;
    _lxSeenFiles.clear();
    _lxSizeWarnLogged = false;

    if (!_isInGlmCoverage(lat, lon)) {
        console.log('[Lightning] Location outside GLM coverage — METAR fallback only');
        return;
    }

    console.log('[Lightning] Starting GLM polling');

    // First poll immediately
    _lxPoll();
}

function stopLightning() {
    _lxStopped = true;
    if (_lxAbortController) { _lxAbortController.abort(); _lxAbortController = null; }
    if (_lxPollTimer) {
        clearTimeout(_lxPollTimer);
        _lxPollTimer = null;
    }
    _lxBuffer = [];
    _lxDedup = new Set();
    _lxLastFlashAt = null;
    _lxLastPollOk = false;
    _lxLat = null;
    _lxLon = null;
    _lxSeenFiles.clear();
}
