// Nowcast Service — orchestrator
// Fuses NWS station observations + radar + thunder detection
// into a single nowSummary object. Manages adaptive polling.
//
// Exports (globals): getNowSummary, startNowcastPolling, stopNowcastPolling

/**
 * Get a fused nowcast summary for a location.
 * @param {{ lat:number, lon:number, country:string }} loc
 * @returns {Promise<{ condition, rain, thunder }>}
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

    // Thunder detection — combine METAR + radar
    const thunderResult = _detectThunderFromSources(obs, radarState);

    // Motion vector + rain timing
    let timing = { beginInMin: null, endInMin: null };
    try {
        const motion = await estimateMotionVector(lat, lon, isUS);
        const currentDbz = radarState ? radarState.dbz : null;
        const isRaining = radarState ? radarState.isRaining : false;
        timing = estimateRainTiming(motion, currentDbz, isRaining);
    } catch (err) {
        console.warn('[Nowcast] Motion/timing estimation failed:', err.message);
    }

    // Build rain summary
    const rain = radarState ? {
        isRainingNow: radarState.isRaining,
        beginInMin:   timing.beginInMin,
        endInMin:     timing.endInMin,
        updatedAt:    radarState.timestamp,
        source:       [radarState.source],
        confidence:   radarState.isRaining ? 'high' : (timing.confidence || 'low')
    } : null;

    // Build thunder summary
    const thunder = {
        isThunderNow: thunderResult.isThunder,
        withinMi:     thunderResult.isThunder ? 10 : null,
        updatedAt:    obs ? obs.obs.timestamp : (radarState ? radarState.timestamp : new Date().toISOString()),
        source:       [thunderResult.source],
        confidence:   thunderResult.confidence
    };

    return {
        condition: _fuseCondition(obs, radarState, thunderResult, country),
        rain,
        thunder
    };
}

// ── Thunder helper ───────────────────────────────────────────────────────────

function _detectThunderFromSources(obs, radarState) {
    const pw = obs && obs.obs ? obs.obs.presentWeather : null;
    const text = obs && obs.obs ? obs.obs.textDescription : null;
    const dbz = radarState ? radarState.dbz : null;
    return detectThunder(pw, text, dbz);
}

// ── Condition Fusion ─────────────────────────────────────────────────────────
// Priority:
//   1. Thunder detected → "Thunderstorm"
//   2. Radar shows rain → Rain desc by dBZ
//   3. METAR obs age <= 30 min → METAR condition
//   4. null → caller uses Open-Meteo, labeled "Model"

function _fuseCondition(obs, radarState, thunderResult, country) {
    const isUS = country === 'United States';
    const radarSource = isUS ? 'NEXRAD' : 'RainViewer';

    // Priority 1: thunder
    if (thunderResult && thunderResult.isThunder) {
        const sources = [radarSource];
        if (obs) sources.unshift(`METAR ${obs.stationId}`);
        return {
            desc:       'Thunderstorm',
            icon:       '\u26C8\uFE0F', // ⛈️
            source:     sources,
            station:    obs ? { id: obs.stationId, name: obs.stationName, dist_mi: obs.distance_mi } : null,
            updatedAt:  obs ? obs.obs.timestamp : (radarState ? radarState.timestamp : new Date().toISOString()),
            confidence: thunderResult.confidence
        };
    }

    // Priority 2: radar shows rain
    if (radarState && radarState.isRaining) {
        const dbz = radarState.dbz || 0;
        let desc, icon;
        if (dbz >= 50)      { desc = 'Heavy Rain';  icon = '\uD83C\uDF27\uFE0F'; } // 🌧️
        else if (dbz >= 35) { desc = 'Rain';         icon = '\uD83C\uDF27\uFE0F'; }
        else                { desc = 'Light Rain';   icon = '\uD83C\uDF26\uFE0F'; } // 🌦️

        const sources = [radarSource];
        if (obs) sources.push(`METAR ${obs.stationId}`);
        return {
            desc,
            icon,
            source:     sources,
            station:    obs ? { id: obs.stationId, name: obs.stationName, dist_mi: obs.distance_mi } : null,
            updatedAt:  radarState.timestamp,
            confidence: 'high'
        };
    }

    // Priority 3: fresh METAR observation
    if (obs && obs.obs) {
        const age = metarAgeMinutes(obs.obs.timestamp);
        if (age <= 30) {
            const parsed = parseMetarCondition(obs.obs.presentWeather, obs.obs.textDescription);
            const sources = [`METAR ${obs.stationId}`];
            if (radarState) sources.push(radarSource);
            return {
                desc:       parsed.desc,
                icon:       parsed.icon,
                source:     sources,
                station:    { id: obs.stationId, name: obs.stationName, dist_mi: obs.distance_mi },
                updatedAt:  obs.obs.timestamp,
                confidence: age <= 15 ? 'high' : 'med'
            };
        }
    }

    // Priority 4: fallback (null signals caller to use Open-Meteo with "Model" label)
    return null;
}

// ── Adaptive Polling ─────────────────────────────────────────────────────────
// Uses setTimeout (not setInterval) so interval adapts based on rain state.
// Pauses when tab is hidden, resumes when visible.

function _computePollInterval(summary) {
    if (!summary || !summary.rain) return POLL_DEFAULT_MS;
    const rain = summary.rain;
    // Active weather: poll faster
    if (rain.isRainingNow || (rain.beginInMin !== null && rain.beginInMin < 30)) {
        return POLL_ACTIVE_MS;
    }
    // Dry with no echoes: poll slower
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
