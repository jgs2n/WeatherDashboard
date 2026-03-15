// Nowcast Service — orchestrator
// Produces four nowcast products per poll cycle:
//   skyState       — background atmospheric state (overcast, fog, clear, etc.)
//   precipStateNow — is it precipitating right now? (radar-primary)
//   precipTrend60m — 0–60 min precipitation timeline + confidence-aware summary
//   lightningState — merged lightning (Blitzortung) + METAR thunder + radar context
//
// Exports (globals): getNowSummary, startNowcastPolling, stopNowcastPolling

/**
 * Get a fused nowcast summary for a location.
 * @param {{ lat:number, lon:number, country:string }} loc
 * @returns {Promise<{ skyState, precipStateNow, precipTrend60m, lightningState }>}
 */
async function getNowSummary({ lat, lon, country }) {
    const isUS = country === 'United States';
    let obs = null;

    if (isUS) {
        obs = await fetchStationObservation(lat, lon);
    }

    // Sample radar at point (loads history on first call)
    let radarState = null;
    try {
        radarState = await sampleRadarAtPoint(lat, lon, isUS);
    } catch (err) {
        console.warn('[Nowcast] Radar sampling failed:', err.message);
    }

    // Motion vector (used by precip trend + lightning approaching detection)
    let motion = null;
    try {
        motion = await estimateMotionVector(lat, lon, isUS);
    } catch (err) {
        console.warn('[Nowcast] Motion estimation failed:', err.message);
    }

    const currentDbz = radarState ? radarState.dbz : null;
    const isRaining  = radarState ? radarState.isRaining : false;

    // Four products
    const skyState       = _computeSkyState(obs, country);
    const precipStateNow = _computePrecipNow(obs, radarState, country);
    const precipTrend60m = _computePrecipTrend60m(currentDbz, isRaining, motion);
    const lightningState = _computeLightningState(lat, lon, obs, radarState, motion);

    return { skyState, precipStateNow, precipTrend60m, lightningState };
}

// ── Thunder helper ───────────────────────────────────────────────────────────

function _detectThunderFromSources(obs, radarState) {
    const pw = obs && obs.obs ? obs.obs.presentWeather : null;
    const text = obs && obs.obs ? obs.obs.textDescription : null;
    const dbz = radarState ? radarState.dbz : null;
    return detectThunder(pw, text, dbz);
}

// ── Lightning State (merged: Blitzortung + METAR + radar context) ─────────────
// Merges three sources into a single lightningState object.
// Lightning (Blitzortung) is primary truth; METAR is fallback/confirmation;
// radar dBZ alone never promotes to thunderstorm.

function _computeLightningState(lat, lon, obs, radarState, motion) {
    // 1. Base classification from Blitzortung buffer
    const lx = typeof summarizeLightningBuffer === 'function'
        ? summarizeLightningBuffer(lat, lon)
        : _emptyLightningState();

    // 2. METAR thunder signal (for merge confirmation / fallback)
    const metar = _detectThunderFromSources(obs, radarState);
    const metarAge = obs && obs.obs ? metarAgeMinutes(obs.obs.timestamp) : Infinity;
    // Only explicit METAR TS codes (not radar-inferred) qualify for fallback path
    const metarExplicit = metar.isThunder && metar.source === 'METAR';

    let state = lx.state;
    let confidence = lx.confidence;
    let source = lx.state !== 'none' ? 'lightning' : 'none';
    let nearestMi = lx.nearestStrikeMi;

    // ── Rule 1: Lightning ≤ 10 mi + METAR confirms → promote to active, high
    if (lx.strikeCounts.within10mi > 0 && metar.isThunder) {
        state = 'active';
        confidence = 'high';
        source = 'merged';
    }
    // ── Confidence boost: lightning + METAR agree at any distance
    else if (state !== 'none' && metar.isThunder) {
        confidence = 'high';
        source = 'merged';
    }

    // ── Rules 5-6: No lightning data + explicit METAR TS → fallback
    if (state === 'none' && metarExplicit) {
        if (metarAge < 20) {
            state = 'nearby';
            confidence = 'medium';
            source = 'metar-fallback';
            nearestMi = 10;
        } else if (metarAge < 45) {
            state = 'nearby';
            confidence = 'low';
            source = 'metar-fallback';
            nearestMi = 10;
        }
    }

    // ── Motion-aware approaching: motion vector indicates organized storm movement
    let isApproaching = false;
    if (state === 'approaching' && motion && motion.speed_kmh > 10) {
        isApproaching = true;
    }

    return {
        state,
        nearestStrikeMi: nearestMi,
        strikeCounts: lx.strikeCounts,
        updatedAt: lx.updatedAt,
        source,
        confidence,
        wsConnected: lx.wsConnected,
        bufferAgeMs: lx.bufferAgeMs,
        lastStrikeAt: lx.lastStrikeAt,
        _isApproaching: isApproaching,
    };
}

function _emptyLightningState() {
    return {
        state: 'none',
        nearestStrikeMi: null,
        strikeCounts: { within5mi: 0, within10mi: 0, within20mi: 0 },
        updatedAt: new Date().toISOString(),
        source: 'unavailable',
        confidence: 'none',
        wsConnected: false,
        bufferAgeMs: null,
        lastStrikeAt: null,
    };
}

// ── Product 1: Sky State ──────────────────────────────────────────────────────
// Represents background atmospheric state (cloud cover, fog, visibility).
// Uses freshness-decayed METAR; returns null to signal model WMO fallback.

function _computeSkyState(obs, country) {
    if (!obs || !obs.obs) return null;

    const age = metarAgeMinutes(obs.obs.timestamp);
    const weight = metarFreshnessWeight(age, 'sky');

    const parsed = parseMetarCondition(obs.obs.presentWeather, obs.obs.textDescription);
    if (parsed.desc === 'Unknown') return null;

    return {
        desc:       parsed.desc,
        icon:       parsed.icon,
        source:     `METAR ${obs.stationId}`,
        confidence: weight,
        observedAt: obs.obs.timestamp
    };
}

// ── Product 2: Precipitation Now ─────────────────────────────────────────────
// Represents current precipitation state. Radar always wins when available —
// this is the fix for the "stale METAR beats fresh radar" bug.
// Priority: radar → METAR (freshness-decayed) → null (caller falls back to model)

function _computePrecipNow(obs, radarState, country) {
    const isUS = country === 'United States';
    const radarSourceName = isUS ? 'NEXRAD' : 'RainViewer';

    // ── Priority 1: Radar ─────────────────────────────────────────────────────
    if (radarState) {
        if (radarState.isRaining) {
            const dbz = radarState.dbz || 0;
            let phenomenon, desc, icon;
            if (dbz >= 50)      { phenomenon = 'heavy rain'; desc = 'Heavy Rain'; icon = 'rain'; }
            else if (dbz >= 35) { phenomenon = 'rain';       desc = 'Rain';       icon = 'rain'; }
            else if (dbz >= 28) { phenomenon = 'rain';       desc = 'Light Rain'; icon = 'drizzle'; }
            else                { phenomenon = 'drizzle';    desc = 'Drizzle';    icon = 'drizzle'; }
            return { phenomenon, desc, icon, source: radarSourceName, confidence: 0.9, observedAt: radarState.timestamp };
        }
        // Radar present but dry — return dry with high confidence
        return { phenomenon: 'dry', desc: 'Dry', icon: '', source: radarSourceName, confidence: 0.85, observedAt: radarState.timestamp };
    }

    // ── Priority 2: METAR (freshness-decayed) ────────────────────────────────
    if (obs && obs.obs) {
        const age = metarAgeMinutes(obs.obs.timestamp);
        const weight = metarFreshnessWeight(age, 'precip');
        if (weight < 0.05) return null; // too stale to be useful

        const parsed = parseMetarCondition(obs.obs.presentWeather, obs.obs.textDescription);
        if (parsed.isRain || parsed.isSnow || parsed.isThunder) {
            const phenomenon = parsed.isThunder ? 'thunderstorm'
                             : parsed.isSnow    ? 'snow'
                             : parsed.desc.toLowerCase().includes('drizzle') ? 'drizzle'
                             : parsed.desc.toLowerCase().includes('heavy')   ? 'heavy rain'
                             : 'rain';
            return { phenomenon, desc: parsed.desc, icon: parsed.icon,
                     source: `METAR ${obs.stationId}`, confidence: weight * 0.8, observedAt: obs.obs.timestamp };
        }
        // METAR reports dry conditions
        return { phenomenon: 'dry', desc: 'Dry', icon: '',
                 source: `METAR ${obs.stationId}`, confidence: weight * 0.7, observedAt: obs.obs.timestamp };
    }

    // ── Priority 3: no usable source ─────────────────────────────────────────
    return null;
}

// ── Product 3: Precipitation Trend 0–60 min ──────────────────────────────────
// Builds a 12-bucket timeline from radar extrapolation and summarizes it into
// confidence-aware human language.

function _computePrecipTrend60m(currentDbz, isRaining, motion) {
    const timeline = buildPrecipTimeline(currentDbz, isRaining);

    // Derive beginInMin / endInMin: from timeline if available, else legacy fallback
    let beginInMin = null, endInMin = null;
    if (timeline) {
        const firstWet = timeline.find(b => b.precipClass > 0);
        const lastWet  = [...timeline].reverse().find(b => b.precipClass > 0);
        if (!isRaining && firstWet) beginInMin = firstWet.minute;
        if (isRaining  && lastWet)  endInMin   = lastWet.minute;
    } else {
        const t = estimateRainTiming(motion, currentDbz, isRaining);
        beginInMin = t.beginInMin;
        endInMin   = t.endInMin;
    }

    const summaryResult = _summarizePrecipTimeline(timeline, isRaining, beginInMin, endInMin);
    return {
        timeline,
        summary:           summaryResult ? summaryResult.text : null,
        summaryConfidence: summaryResult ? summaryResult.confidence : 'low',
        beginInMin,
        endInMin
    };
}

// ── Precipitation Timeline Summarizer ────────────────────────────────────────
// Converts the 12-bucket timeline into a confidence-aware human string.
// Returns { text, confidence } or null if no precipitation is predicted.

function _summarizePrecipTimeline(timeline, isRaining, beginInMin, endInMin) {
    // No timeline (< 3 radar frames) — fall back to simple timing strings at low confidence
    if (!timeline) {
        if (isRaining && endInMin != null)   return { text: `Rain ending in ~${endInMin} min`,   confidence: 'low' };
        if (!isRaining && beginInMin != null) return { text: `Rain in ~${beginInMin} min`,        confidence: 'low' };
        return null;
    }

    const wetBuckets = timeline.filter(b => b.precipClass > 0);
    if (wetBuckets.length === 0) return null;

    // Detect intermittent: count transitions from dry → wet
    let runCount = 0, prevWet = false;
    for (const b of timeline) {
        const wet = b.precipClass > 0;
        if (wet && !prevWet) runCount++;
        prevWet = wet;
    }
    if (runCount >= 3) return { text: 'Intermittent rain next hour', confidence: 'low' };

    // Average confidence of wet buckets determines phrasing tier
    const avgConf = wetBuckets.reduce((s, b) => s + b.confidence, 0) / wetBuckets.length;
    const tier = avgConf >= 0.7 ? 'high' : avgConf >= 0.4 ? 'med' : 'low';

    if (isRaining) {
        const lastWet = wetBuckets[wetBuckets.length - 1];
        const duration = lastWet.minute;
        if (tier === 'high') return { text: `Rain continuing for ~${duration} min`, confidence: 'high' };
        if (tier === 'med')  return { text: `Rain may continue ~${duration} min`,   confidence: 'med'  };
        return { text: 'Rain now, clearing later', confidence: 'low' };
    }

    // Not raining — rain is approaching
    const firstWet = wetBuckets[0];
    const start = firstWet.minute;
    if (tier === 'high') return { text: `Rain beginning in ~${start} min`,                          confidence: 'high' };
    if (tier === 'med')  return { text: `Rain may begin in ~${Math.max(0, start - 5)}–${start + 5} min`, confidence: 'med' };
    return { text: 'Showers possible soon', confidence: 'low' };
}

// ── Adaptive Polling ─────────────────────────────────────────────────────────
// Uses setTimeout (not setInterval) so interval adapts based on rain state.
// Pauses when tab is hidden, resumes when visible.

function _computePollInterval(summary) {
    if (!summary) return POLL_DEFAULT_MS;
    const isRaining = summary.precipStateNow && summary.precipStateNow.phenomenon !== 'dry';
    const rainSoon  = summary.precipTrend60m && summary.precipTrend60m.beginInMin !== null && summary.precipTrend60m.beginInMin < 30;
    const lightningActive = summary.lightningState && summary.lightningState.state !== 'none';
    if (isRaining || rainSoon || lightningActive) return POLL_ACTIVE_MS;
    return POLL_DRY_MS;
}

function startNowcastPolling(lat, lon, country) {
    stopNowcastPolling();

    let _pollLat = lat;
    let _pollLon = lon;
    let _pollCountry = country;
    let _paused = false;

    async function poll() {
        if (_paused) return;
        try {
            const summary = await getNowSummary({ lat: _pollLat, lon: _pollLon, country: _pollCountry });
            cachedNowSummary = summary;
            saveNowcastState(summary, _pollLat, _pollLon);
            // In-place DOM update (no full re-render)
            if (typeof updateNowcastDisplay === 'function') {
                updateNowcastDisplay(summary);
            }
        } catch (err) {
            console.warn('[Nowcast] Poll error:', err.message);
        }

        // Schedule next poll at adaptive interval
        const interval = _computePollInterval(cachedNowSummary);
        _nowcastPollTimer = setTimeout(poll, interval);
    }

    // Schedule first poll (initial data already fetched by Promise.all)
    const interval = _computePollInterval(cachedNowSummary);
    _nowcastPollTimer = setTimeout(poll, interval);

    // Pause/resume on visibility change
    function onVisChange() {
        if (document.hidden) {
            _paused = true;
            if (_nowcastPollTimer) {
                clearTimeout(_nowcastPollTimer);
                _nowcastPollTimer = null;
            }
        } else {
            _paused = false;
            // Resume immediately with a poll
            if (!_nowcastPollTimer) {
                _nowcastPollTimer = setTimeout(poll, 500);
            }
        }
    }
    document.addEventListener('visibilitychange', onVisChange);
    // Store cleanup ref
    startNowcastPolling._visCleanup = () => {
        document.removeEventListener('visibilitychange', onVisChange);
    };
}

function stopNowcastPolling() {
    if (_nowcastPollTimer) {
        clearTimeout(_nowcastPollTimer);
        _nowcastPollTimer = null;
    }
    if (startNowcastPolling._visCleanup) {
        startNowcastPolling._visCleanup();
        startNowcastPolling._visCleanup = null;
    }
}
