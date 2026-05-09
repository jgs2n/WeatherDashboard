// Nowcast Logger — records every nowcast computation for ML training
// POSTs a feature snapshot to /api/nowcast-log on each nowcast cycle.
// Silently no-ops if the server doesn't support the endpoint.
//
// All logged fields are derived from explicit params — no global reads.

const _NOWCAST_LOG_ENDPOINT = '/api/nowcast-log';
let _loggerEnabled = false; // off until startCollection() enables it
let _lastLogTime = 0;
const _MIN_LOG_INTERVAL_MS = 60_000; // Don't log more than once per minute

/**
 * Log a nowcast computation with full feature vector.
 * Called at the end of getNowSummary() in the polling loop.
 *
 * @param {object} params
 * @param {number} params.lat
 * @param {number} params.lon
 * @param {string} params.country
 * @param {object|null} params.radarState   — from sampleRadarAtPoint
 * @param {object|null} params.motion       — from estimateMotionVector
 * @param {object|null} params.obs          — from fetchStationObservation
 * @param {object} params.summary           — the full getNowSummary result
 * @param {string} [params.locationName]    — explicit city name (avoids activeLocation)
 * @param {string} [params.stateCode]       — explicit state code
 * @param {object|null} [params.modelContext]       — per-city model snapshot (avoids cachedCurrentData)
 * @param {Array|null}  [params.modelHourlyContext] — per-city hourly forecast (avoids cachedHourlyData)
 */
function logNowcastSnapshot({ lat, lon, country, radarState, motion, obs, summary, locationName: explicitName, stateCode: explicitStateCode, modelContext: explicitModel, modelHourlyContext: explicitModelHourly }) {
    if (!_loggerEnabled) return;

    const now = Date.now();
    if (now - _lastLogTime < _MIN_LOG_INTERVAL_MS) return;
    _lastLogTime = now;

    try {
        const record = _buildLogRecord(lat, lon, country, radarState, motion, obs, summary, explicitName, explicitStateCode, explicitModel, explicitModelHourly);
        _validateRecord(record);
        _postLog(record);
    } catch (err) {
        console.debug('[NowcastLogger] Build error:', err.message);
    }
}

function _buildLogRecord(lat, lon, country, radarState, motion, obs, summary, explicitName, explicitStateCode, explicitModel, explicitModelHourly) {
    const { skyState, precipStateNow, precipTrend60m, lightningState, nowcastState } = summary;

    // Location identity — prefer explicitly passed name (per-city fetch) over activeLocation
    // to avoid all background cities being logged under the currently viewed city's name.
    const locationName = explicitName
        || ((typeof activeLocation !== 'undefined' && activeLocation)
            ? activeLocation.name : `${lat.toFixed(2)},${lon.toFixed(2)}`);
    const stateCode = explicitStateCode !== undefined
        ? explicitStateCode
        : ((typeof activeLocation !== 'undefined' && activeLocation)
            ? (activeLocation.stateCode || null) : null);
    const station = obs ? obs.stationId : null;

    // Displayed condition + icon — both derived from nowcastState (single authoritative source)
    // to avoid icon/condition mismatch between legacy _computePrecipNow and new _scorePrecipNow.
    const precipNS = nowcastState?.precip;
    const precipActive = precipNS?.active === true;
    // Condition and icon must both derive from the same authority (precipNS).
    // precipStateNow is a legacy parallel signal that can disagree with precipNS;
    // using it here when precipActive=false produces clear-icon + rain-cond mismatches.
    const displayedCondition = precipActive
        ? _descFromScoredPrecip(precipNS)
        : 'Dry';
    // Icon must come from the same branch as condition to prevent mismatches:
    //   precipActive=true  → precipNS.icon only (no sky fallback; avoids overcast + rain-cond)
    //   precipActive=false → sky icon only, filtered to exclude rain-like icons (avoids rain-sky + dry-cond)
    let displayedIcon;
    if (precipActive) {
        displayedIcon = precipNS.icon || null;
    } else {
        const skyIcon = nowcastState?.sky?.icon || null;
        displayedIcon = (skyIcon && /rain|drizzle|thunder|snow|sleet/.test(skyIcon)) ? null : skyIcon;
    }

    // Model context — use explicit per-city data; never read cachedCurrentData/cachedHourlyData globals
    const model = explicitModel || null;

    // Next few hours of model forecast — use explicit per-city data
    const modelHourly = explicitModelHourly || null;

    // Build sky as an object even when null (normalized schema)
    const sky = skyState ? {
        desc: skyState.desc,
        source: skyState.source,
        confidence: skyState.confidence,
    } : { desc: null, source: null, confidence: null };

    // Build trend with normalized timeline
    const trend = precipTrend60m ? {
        summary: precipTrend60m.summary,
        summaryConfidence: precipTrend60m.summaryConfidence,
        beginInMin: precipTrend60m.beginInMin,
        endInMin: precipTrend60m.endInMin,
        timeline: precipTrend60m.timeline || null,
    } : { summary: null, summaryConfidence: null, beginInMin: null, endInMin: null, timeline: null };

    return {
        _schemaVersion: 2,
        timestamp: new Date().toISOString(),
        lat,
        lon,
        country,
        stateCode,
        station,
        locationName,

        displayedCondition,
        displayedIcon,

        precip: precipStateNow ? {
            phenomenon: precipStateNow.phenomenon,
            desc: precipStateNow.desc,
            source: precipStateNow.source,
            confidence: precipStateNow.confidence,
        } : null,

        sky,

        lightning: lightningState ? {
            state: lightningState.state,
            nearestFlashMi: lightningState.nearestFlashMi,
            flashCounts: lightningState.flashCounts,
            trend: lightningState.trend,
            confidence: lightningState.confidence,
            source: lightningState.source,
            connected: lightningState.connected,
            bufferAgeMs: lightningState.bufferAgeMs,
        } : null,

        trend,

        radar: radarState ? {
            dbz: radarState.dbz,
            rainState: radarState.rainState,
            source: radarState.source,
            lastValidDbzTime: radarState.lastValidDbzTime || null,
            motionSpeed: motion ? motion.speed_kmh : null,
            motionDir: motion ? motion.direction_deg : null,
        } : null,

        model,
        modelHourly,
    };
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Convert scored precip { type, intensity } → human-readable description. */
function _descFromScoredPrecip(precip) {
    if (!precip || !precip.active) return 'Dry';
    const { type, intensity } = precip;
    if (type === 'snow') return intensity === 'heavy' ? 'Heavy Snow' : intensity === 'light' ? 'Light Snow' : 'Snow';
    if (type === 'rain') {
        if (intensity === 'heavy') return 'Heavy Rain';
        if (intensity === 'light') return 'Light Rain';
        return 'Rain';
    }
    return precip.type || 'Precipitation';
}

// ── Row-level validation ───────────────────────────────────────────────────

function _validateRecord(record) {
    const flags = [];

    // V1: Icon ↔ condition coherence
    if (record.displayedIcon && record.displayedCondition) {
        const iconIsRain = /rain|drizzle|thunder|snow|sleet/.test(record.displayedIcon);
        const condIsDry = record.displayedCondition === 'Dry';
        const iconIsClear = /clear|cloudy|overcast/.test(record.displayedIcon) && !iconIsRain;
        const condIsRain = /drizzle|rain|thunder|snow|sleet/i.test(record.displayedCondition);
        if (iconIsRain && condIsDry) flags.push('rain_icon_dry_cond');
        if (iconIsClear && condIsRain) flags.push('clear_icon_rain_cond');
    }

    // V2: Model data present check — flag if null (background poll without model context)
    if (record.model === null) {
        flags.push('model_unavailable');
    }

    // V3: Radar state vs dbz coherence
    if (record.radar) {
        const { dbz, rainState } = record.radar;
        if (dbz === null && (rainState === 'ON' || rainState === 'HOLDING')) {
            flags.push('radar_state_no_dbz');
        }
    }

    if (flags.length > 0) {
        record._validationFlags = flags;
    }
}

function setNowcastLoggingEnabled(enabled) { _loggerEnabled = enabled; }

function _postLog(record) {
    if (!_loggerEnabled) return;
    fetch(_NOWCAST_LOG_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record),
    }).catch(() => {
        // Silent fail — server may not support logging
    });
}
