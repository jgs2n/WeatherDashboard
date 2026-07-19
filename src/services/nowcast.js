// Nowcast Service — orchestrator
// Produces four nowcast products per poll cycle:
//   skyState       — background atmospheric state (overcast, fog, clear, etc.)
//   precipStateNow — is it precipitating right now? (radar-primary)
//   precipTrend60m — 0–60 min precipitation timeline + confidence-aware summary
//   lightningState — merged lightning (GOES GLM) + METAR thunder + radar context
//
// Also produces a synthesized nowcastState that independently answers:
//   precip? (radar > METAR drizzle override > model gap-fill)
//   sky?    (METAR > model gap-fill, with hysteresis)
//   thunder? (lightning > METAR fallback, normalized)
//
// Exports (globals): getNowSummary, startNowcastPolling, stopNowcastPolling, deriveNowcastState

// ── Tunable thresholds ──────────────────────────────────────────────────────
const SCORE_RADAR_WET_US     = 0.90;
const SCORE_RADAR_DRY_US     = 0.75;
const SCORE_RADAR_WET_INTL   = 0.85;
const SCORE_RADAR_DRY_INTL   = 0.65;
const SCORE_METAR_PRECIP_MAX = 0.70;
const SCORE_METAR_DRY_MAX    = 0.55;
const SCORE_METAR_SKY_MAX    = 0.90;
const SCORE_MODEL_PRECIP     = 0.30;
const SCORE_MODEL_SKY        = 0.35;
const SKY_HYSTERESIS_DOWN    = 0.25;
const SKY_HYSTERESIS_UP      = 0.45;
// Module-level state for sky hysteresis
let _prevSkySource = null; // 'metar' | 'model' | null

// Reset sky hysteresis — call before processing a different location
// to prevent cross-location bleed in background fetches.
function resetSkyHysteresis() { _prevSkySource = null; }

// Dewpoint from temp + relative humidity (Magnus / Lawrence 2005, ±0.35°C).
function _dewpointC(tempC, rhPct) {
    const a = 17.625, b = 243.04;
    const gamma = Math.log(rhPct / 100) + (a * tempC) / (b + tempC);
    return (b * gamma) / (a - gamma);
}

/**
 * Get a fused nowcast summary for a location.
 * @param {{ lat:number, lon:number, country:string }} loc
 * @returns {Promise<{ skyState, precipStateNow, precipTrend60m, lightningState }>}
 */
async function getNowSummary({ lat, lon, country, modelWMO: explicitWMO, locationName: explicitName, stateCode: explicitStateCode, modelContext: explicitModelCtx, modelHourlyContext: explicitModelHourly }) {
    const isUS = country === 'United States';
    let obs = null;

    // Fresh radar tiles for this poll cycle (motion grid + upstream march
    // share decoded tiles within the cycle)
    if (typeof beginSampleCycle === 'function') beginSampleCycle();

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
    // Fallback: steering-level model wind when correlation (and its 15-min
    // persistence) fail — convection often defeats the correlation grid.
    // Downstream confidence is capped at med for model-wind motion.
    if (!motion && explicitModelCtx && typeof _fallbackMotionFromWind === 'function') {
        motion = _fallbackMotionFromWind(
            explicitModelCtx.steeringSpeedMph, explicitModelCtx.steeringDirFromDeg);
    }

    const currentDbz = radarState ? radarState.dbz : null;
    const isRaining  = radarState ? radarState.isRaining : false;

    // Four products (legacy)
    const skyState       = _computeSkyState(obs, country);
    const precipStateNow = _computePrecipNow(obs, radarState, country);
    const precipTrend60m = await _computePrecipTrend60m(lat, lon, isUS, currentDbz, isRaining, motion);
    const lightningState = _computeLightningState(lat, lon, obs, radarState, motion);

    // Synthesized nowcast state (new architecture)
    // Use explicit WMO code if provided (background tab fetch), else fall back to active location's cached data
    const modelWMO = explicitWMO != null ? explicitWMO
        : (typeof cachedCurrentData !== 'undefined' && cachedCurrentData)
            ? cachedCurrentData.weather_code : null;
    // Open-Meteo surface precip rate (in/hr) — used as secondary signal in dry veto
    // Prefer explicit per-city model context; fall back to cachedCurrentData only for active city.
    const omPrecipInHr = explicitModelCtx ? (explicitModelCtx.precipitation ?? null)
        : (typeof cachedCurrentData !== 'undefined' && cachedCurrentData)
            ? (cachedCurrentData.precipitation ?? null) : null;
    const nowcastState = deriveNowcastState(radarState, obs, modelWMO, lightningState, precipTrend60m, country, omPrecipInHr);

    const summary = { skyState, precipStateNow, precipTrend60m, lightningState, nowcastState };
    return summary;
}

// ── Thunder helper ───────────────────────────────────────────────────────────

function _detectThunderFromSources(obs, radarState) {
    const pw = obs && obs.obs ? obs.obs.presentWeather : null;
    const text = obs && obs.obs ? obs.obs.textDescription : null;
    const dbz = radarState ? radarState.dbz : null;
    return detectThunder(pw, text, dbz);
}

// ── Lightning State (merged: GOES GLM + METAR + radar context) ───────────────
// Merges three sources into a single lightningState object.
// GLM flashes are primary truth in the Americas; METAR is fallback/confirmation;
// radar dBZ alone never promotes to thunderstorm.

function _computeLightningState(lat, lon, obs, radarState, motion) {
    // 1. Base classification from GLM flash buffer
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
    let nearestMi = lx.nearestFlashMi;

    // ── Rule 1: GLM active/nearby + fresh METAR explicit thunder → boost confidence
    if ((state === 'active' || state === 'nearby') && metarExplicit && metarAge < 20) {
        confidence = 'high';
        source = 'merged';
    }

    // ── Rule 2: GLM active within 10 mi + METAR explicit thunder → promote to active high
    if (lx.flashCounts.within10mi > 0 && metarExplicit) {
        state = 'active';
        confidence = 'high';
        source = 'merged';
    }

    // ── Rule 3: GLM present without METAR thunder → keep GLM classification as-is
    // (no code needed — default path)

    // ── Rule 4: No GLM data + explicit METAR TS + age < 20 min → metar-fallback
    if (state === 'none' && metarExplicit) {
        if (metarAge < 20) {
            state = 'nearby';
            confidence = 'medium';
            source = 'metar-fallback';
            nearestMi = 10;
        }
        // ── Rule 5: No GLM data + explicit METAR TS + age 20–45 min
        else if (metarAge < 45) {
            state = 'nearby';
            confidence = 'low';
            source = 'metar-fallback';
            nearestMi = 10;
        }
    }

    // ── Rule 6: Radar alone NEVER promotes thunderstorm or thunder-nearby state
    // (enforced by not using radar dBZ in this function)

    // ── Motion-aware approaching ─────────────────────────────────────────────
    // Use radar motion vector more heavily for GLM than Blitzortung did.
    let isApproaching = false;
    if (state === 'approaching' && motion && motion.speed_kmh > 10) {
        isApproaching = true;
    }
    // Strengthen approaching if trend is rising + radar inbound
    if (state === 'approaching' && lx.trend === 'rising' && motion && motion.speed_kmh > 5) {
        isApproaching = true;
    }

    return {
        state,
        nearestFlashMi: nearestMi,
        flashCounts: lx.flashCounts,
        updatedAt: lx.updatedAt,
        source,
        confidence,
        connected: lx.connected,
        bufferAgeMs: lx.bufferAgeMs,
        lastFlashAt: lx.lastFlashAt,
        trend: lx.trend,
        _isApproaching: isApproaching,
    };
}

function _emptyLightningState() {
    return {
        state: 'none',
        nearestFlashMi: null,
        flashCounts: { within10mi: 0, within20mi: 0, within40mi: 0 },
        updatedAt: new Date().toISOString(),
        source: 'unavailable',
        confidence: 'none',
        connected: false,
        bufferAgeMs: null,
        lastFlashAt: null,
        trend: null,
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
            if (dbz >= 45)      { phenomenon = 'heavy rain'; desc = 'Heavy Rain'; icon = 'rain'; }
            else if (dbz >= 30) { phenomenon = 'rain';       desc = 'Rain';       icon = 'rain'; }
            else if (dbz >= 22) { phenomenon = 'rain';       desc = 'Light Rain'; icon = 'rain'; }
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

// ── Poll-cycle self-correction (prediction memory) ───────────────────────────
// Each poll compares the new begin/end target time against the previous one.
// Converging predictions (≤ 5 min drift, twice in a row) earn a one-tier
// confidence boost and light smoothing; diverging ones (> 15 min drift) decay
// a tier and re-derive. Memory expires after 15 min or on kind change.

const PRED_MEMORY_MAX_AGE_MS = 15 * 60 * 1000;
const PRED_STABLE_DRIFT_MIN  = 5;   // ≤ this drift counts as converging
const PRED_DIVERGE_DRIFT_MIN = 15;  // > this drift counts as diverging

let _predMemory = null; // { kind: 'begin'|'end', targetMs, updatedAtMs, stableCount }

// Reset prediction memory — call on location change (alongside resetRadarState).
function resetPredictionMemory() { _predMemory = null; }

const _CONF_TIERS = ['low', 'med', 'high'];
function _confShift(conf, delta) {
    const i = Math.max(0, Math.min(_CONF_TIERS.length - 1, _CONF_TIERS.indexOf(conf) + delta));
    return _CONF_TIERS[i];
}

// PURE — apply memory rules. Returns { targetMs, confidence, memory }.
// maxConfidence caps the convergence boost — slope-only and model-wind
// predictions can never be boosted to 'high' just by being consistent
// (v1.51.0: a horizon-pegged slope value is consistent but not accurate).
function _applyPredictionMemory(memory, kind, newTargetMs, confidence, nowMs, maxConfidence = 'high') {
    const fresh = { kind, targetMs: newTargetMs, updatedAtMs: nowMs, stableCount: 0 };
    if (!memory || memory.kind !== kind ||
        (nowMs - memory.updatedAtMs) > PRED_MEMORY_MAX_AGE_MS) {
        return { targetMs: newTargetMs, confidence, memory: fresh };
    }
    const driftMin = Math.abs(newTargetMs - memory.targetMs) / 60000;
    if (driftMin <= PRED_STABLE_DRIFT_MIN) {
        const stableCount = memory.stableCount + 1;
        const targetMs = Math.round(0.7 * newTargetMs + 0.3 * memory.targetMs);
        let conf = stableCount >= 2 ? _confShift(confidence, +1) : confidence;
        if (_CONF_TIERS.indexOf(conf) > _CONF_TIERS.indexOf(maxConfidence)) conf = maxConfidence;
        return { targetMs, confidence: conf,
                 memory: { kind, targetMs, updatedAtMs: nowMs, stableCount } };
    }
    if (driftMin > PRED_DIVERGE_DRIFT_MIN) {
        return { targetMs: newTargetMs, confidence: _confShift(confidence, -1), memory: fresh };
    }
    // In-between drift: adopt new target, keep tier and streak count
    return { targetMs: newTargetMs, confidence,
             memory: { kind, targetMs: newTargetMs, updatedAtMs: nowMs, stableCount: memory.stableCount } };
}

// ── Product 3: Precipitation Trend 0–60 min ──────────────────────────────────
// Primary signal: edge geometry (sampleEdgeTiming) — leading/trailing echo edge
// along the storm track ÷ closing speed. Slope timeline is fallback and
// confirmation. Emitted begin/end minutes are floored by _clampPrecision so we
// never claim tighter timing than the confidence tier supports.

// PURE — benchmark precision floors: low → ≥15 min, med → ≥10 min.
function _clampPrecision(minutes, confidence) {
    if (minutes === null || minutes === undefined) return null;
    if (confidence === 'low') return Math.max(minutes, 15);
    if (confidence === 'med') return Math.max(minutes, 10);
    return minutes;
}

// PURE — slope tier from timeline wet buckets (legacy logic, capped at med).
// Returns { minutes, tier, intermittent, horizon } or null when slope predicts
// nothing. Wet case: if the projection stays wet through the final bucket, the
// "end" is just the timeline horizon, not a real clearing signal — v1.51.0
// marks it horizon (minutes null) instead of emitting a perpetual "~55 min"
// prediction that rolls forward every poll.
function _slopeSignal(timeline, isRaining) {
    if (!timeline) return null;
    const wetBuckets = timeline.filter(b => b.precipClass > 0);
    if (wetBuckets.length === 0) return null;

    let runCount = 0, prevWet = false;
    for (const b of timeline) {
        const wet = b.precipClass > 0;
        if (wet && !prevWet) runCount++;
        prevWet = wet;
    }

    const avgConf = wetBuckets.reduce((s, b) => s + b.confidence, 0) / wetBuckets.length;
    let tier = avgConf >= 0.7 ? 'high' : avgConf >= 0.4 ? 'med' : 'low';
    if (tier === 'high') tier = 'med'; // slope-only never exceeds med
    const lastBucketMin = timeline[timeline.length - 1].minute;
    if (isRaining && wetBuckets[wetBuckets.length - 1].minute >= lastBucketMin) {
        return { minutes: null, tier, intermittent: runCount >= 3, horizon: true };
    }
    const minutes = isRaining
        ? wetBuckets[wetBuckets.length - 1].minute   // last wet bucket ≈ clearing
        : wetBuckets[0].minute;                      // first wet bucket ≈ onset
    return { minutes, tier, intermittent: runCount >= 3, horizon: false };
}

// PURE — fuse edge + slope for the dry case → { minutes, confidence, method }.
// Model-wind fallback motion caps edge confidence at med.
function _deriveDryTiming(edge, slope, motion) {
    const observedMotion = motion && motion.source !== 'model-wind';
    if (edge && edge.beginInMin !== null) {
        const slopeAgrees = slope !== null;
        const fastEnough = motion && motion.speed_kmh >= 10;
        if (edge.lateralHits >= 2 && fastEnough && slopeAgrees && observedMotion) {
            return { minutes: edge.beginInMin, confidence: 'high', method: 'edge' };
        }
        if (edge.lateralHits >= 2) {
            return { minutes: edge.beginInMin, confidence: 'med', method: 'edge' };
        }
        return { minutes: edge.beginInMin, confidence: 'low', method: 'edge' };
    }
    if (slope !== null) {
        return { minutes: slope.minutes, confidence: slope.tier, method: 'slope' };
    }
    return { minutes: null, confidence: 'low', method: 'none' };
}

// ── RainViewer nowcast consensus ─────────────────────────────────────────────
const RV_AGREE_MIN    = 10; // |edge − rv| ≤ this → consensus boost
const RV_DISAGREE_MIN = 20; // |edge − rv| > this → cap edge at med

// PURE — merge RainViewer's model nowcast with the derived timing.
//   edge + RV agree      → boost one tier, blend 0.7·edge + 0.3·rv ('consensus')
//   edge + RV disagree   → keep edge (observational geometry wins), cap at med
//   RV only (method none)→ RV timing at med cap ('rv') — covers stationary /
//                          cold-start / no-motion cases, incl. internationally
//   slope / edge-horizon → unchanged (RV never overrides a live-radar signal
//                          that already has its own fallback semantics)
function _applyRvConsensus(timing, rvMinutes) {
    if (rvMinutes === null || rvMinutes === undefined) return timing;
    if (timing.method === 'edge' && timing.minutes !== null) {
        const diff = Math.abs(timing.minutes - rvMinutes);
        if (diff <= RV_AGREE_MIN) {
            return {
                minutes: Math.round(0.7 * timing.minutes + 0.3 * rvMinutes),
                confidence: _confShift(timing.confidence, +1),
                method: 'consensus',
            };
        }
        if (diff > RV_DISAGREE_MIN && timing.confidence === 'high') {
            return { minutes: timing.minutes, confidence: 'med', method: 'edge' };
        }
        return timing;
    }
    if (timing.method === 'none') {
        return { minutes: rvMinutes, confidence: 'med', method: 'rv' };
    }
    return timing;
}

// PURE — fuse edge + slope for the wet case → { minutes, confidence, method }.
// '*-horizon' = rain extends past the prediction range: continues all hour.
// Model-wind fallback motion caps edge confidence at med (it's an estimate,
// not an observed vector).
function _deriveWetTiming(edge, slope, motion, edgeAttempted) {
    const observedMotion = motion && motion.source !== 'model-wind';
    if (edge && edge.endInMin !== null) {
        const fastEnough = motion && motion.speed_kmh >= 10;
        return { minutes: edge.endInMin,
                 confidence: (fastEnough && observedMotion) ? 'high' : 'med', method: 'edge' };
    }
    // Edge march ran (motion available) but found no trailing edge in range
    if (edgeAttempted && motion && motion.speed_kmh >= 5) {
        return { minutes: null, confidence: 'med', method: 'edge-horizon' };
    }
    if (slope !== null) {
        if (slope.horizon) {
            return { minutes: null, confidence: 'med', method: 'slope-horizon' };
        }
        return { minutes: slope.minutes, confidence: slope.tier, method: 'slope' };
    }
    return { minutes: null, confidence: 'low', method: 'none' };
}

async function _computePrecipTrend60m(lat, lon, isUS, currentDbz, isRaining, motion) {
    const timeline = buildPrecipTimeline(currentDbz, isRaining);

    // Slope signal (fallback / confirmation). When the timeline is missing
    // (< 3 frames), estimateRainTiming can still produce a rough minute value.
    let slope = _slopeSignal(timeline, isRaining);
    if (!slope && !timeline) {
        const t = estimateRainTiming(motion, currentDbz, isRaining);
        const m = isRaining ? t.endInMin : t.beginInMin;
        if (m !== null) slope = { minutes: m, tier: 'low', intermittent: false };
    }

    // Edge-geometry timing (primary)
    let edge = null;
    let edgeAttempted = false;
    if (motion && motion.speed_kmh >= 5) {
        edgeAttempted = true;
        try {
            edge = await sampleEdgeTiming(lat, lon, isUS, motion, isRaining);
        } catch (err) {
            console.warn('[Nowcast] Edge timing failed:', err.message);
            edgeAttempted = false;
        }
    }

    let timing = isRaining
        ? _deriveWetTiming(edge, slope, motion, edgeAttempted)
        : _deriveDryTiming(edge, slope, motion);

    // RainViewer nowcast cross-check (worldwide, works with no motion vector)
    try {
        if (typeof sampleRainviewerNowcast === 'function') {
            const rvSamples = await sampleRainviewerNowcast(lat, lon);
            const rvTiming = _deriveRvTiming(rvSamples, isRaining);
            const rvMinutes = isRaining ? rvTiming.endInMin : rvTiming.beginInMin;
            timing = _applyRvConsensus(timing, rvMinutes);
            // Consensus built on estimated (model-wind) motion caps at med —
            // two model-derived signals agreeing is not observation-grade.
            if (timing.method === 'consensus' && motion && motion.source === 'model-wind'
                && timing.confidence === 'high') {
                timing = { ...timing, confidence: 'med' };
            }
        }
    } catch (err) {
        console.warn('[Nowcast] RainViewer nowcast failed:', err.message);
    }

    // Self-correction: compare against last poll's prediction (memory expires
    // on its own after 15 min, so a single missed cycle doesn't clear it)
    const nowMs = Date.now();
    let rawMinutes = timing.minutes;
    let confidence = timing.confidence;
    if (rawMinutes !== null) {
        const kind = isRaining ? 'end' : 'begin';
        // Boost ceiling: only observed-motion edge/consensus can reach high
        const observedMotion = motion && motion.source !== 'model-wind';
        const maxConf = ((timing.method === 'edge' || timing.method === 'consensus') && observedMotion)
            ? 'high' : 'med';
        const applied = _applyPredictionMemory(
            _predMemory, kind, nowMs + rawMinutes * 60000, confidence, nowMs, maxConf);
        _predMemory = applied.memory;
        rawMinutes = Math.max(0, Math.round((applied.targetMs - nowMs) / 60000));
        confidence = applied.confidence;
    }

    const minutes = _clampPrecision(rawMinutes, confidence);

    const summaryResult = _summarizeTrend({
        timeline, isRaining,
        minutes,
        confidence,
        method: timing.method,
        intermittent: slope ? slope.intermittent : false,
        nowMs,
        utcOffsetSec: (typeof cachedUtcOffsetSec !== 'undefined') ? cachedUtcOffsetSec : null,
    });

    return {
        timeline,
        summary:           summaryResult ? summaryResult.text : null,
        summaryConfidence: summaryResult ? summaryResult.confidence : 'low',
        beginInMin: isRaining ? null : minutes,
        endInMin:   isRaining ? minutes : null,
        method: timing.method,
        edge: edge ? {
            distKm: edge.edgeDistKm,
            speedKmh: edge.closingSpeedKmh,
            lateralHits: edge.lateralHits,
        } : null,
    };
}

// ── Trend Summarizer ─────────────────────────────────────────────────────────
// Converts fused timing into confidence-aware human language.
// Wording rules (docs/nowcast-rules.txt §8 + benchmark precision checks):
//   high → clock times rounded to 5 min ("Rain starting ~3:45 PM")
//   med  → ±5 min ranges ("Rain likely in ~20–30 min")
//   low  → vague strings only, never minute digits ≤ 10
// Returns { text, confidence } or null if nothing to say.

function _summarizeTrend({ timeline, isRaining, minutes, confidence, method, intermittent, nowMs, utcOffsetSec }) {
    // Intermittent cells (3+ wet runs in slope timeline) — slope path only;
    // the edge march has its own gap handling (EDGE_DRY_GAP_SAMPLES).
    if (method === 'slope' && intermittent) {
        return { text: 'Intermittent rain next hour', confidence: 'low' };
    }

    if (isRaining) {
        if (minutes === null) {
            if (method === 'edge-horizon' || method === 'slope-horizon') {
                return { text: 'Rain continuing this hour', confidence: 'med' };
            }
            return { text: 'Rain now, clearing later', confidence: 'low' };
        }
        if (confidence === 'high') {
            const t = formatClockTimeRounded(nowMs + minutes * 60000, 5, utcOffsetSec);
            return { text: `Clearing by ~${t}`, confidence: 'high' };
        }
        if (confidence === 'med') {
            return { text: `Rain tapering off in ~${Math.max(5, minutes - 5)}–${minutes + 5} min`, confidence: 'med' };
        }
        return { text: 'Rain now, clearing later', confidence: 'low' };
    }

    // Dry case
    if (minutes === null) return null;
    if (confidence === 'high') {
        const t = formatClockTimeRounded(nowMs + minutes * 60000, 5, utcOffsetSec);
        return { text: `Rain starting ~${t}`, confidence: 'high' };
    }
    if (confidence === 'med') {
        return { text: `Rain likely in ~${Math.max(5, minutes - 5)}–${minutes + 5} min`, confidence: 'med' };
    }
    return { text: 'Showers possible soon', confidence: 'low' };
}

// ── Synthesized Nowcast State ────────────────────────────────────────────────
// Independently answers: precip? sky? thunder? Then merges into one state object.

/**
 * Score precipitation from available sources.
 * Radar is authority. METAR overrides only for radar-blind drizzle/mist.
 * Model fills gap only when both radar and METAR are absent.
 * omPrecipInHr: Open-Meteo current.precipitation (in/hr) as secondary veto signal.
 */
function _scorePrecipNow(radarState, obs, modelWMO, isUS, omPrecipInHr = null) {
    const radarSourceName = isUS ? 'NEXRAD' : 'RainViewer';
    const scoreWet = isUS ? SCORE_RADAR_WET_US : SCORE_RADAR_WET_INTL;
    const scoreDry = isUS ? SCORE_RADAR_DRY_US : SCORE_RADAR_DRY_INTL;

    // Parse METAR if available
    let metarParsed = null, metarAge = Infinity, metarWeight = 0;
    if (obs && obs.obs) {
        metarAge = metarAgeMinutes(obs.obs.timestamp);
        metarWeight = metarFreshnessWeight(metarAge, 'precip');
        metarParsed = parseMetarCondition(obs.obs.presentWeather, obs.obs.textDescription);
    }

    // ── Radar available ─────────────────────────────────────────────────────
    if (radarState) {
        if (radarState.isRaining) {
            const dbz = radarState.dbz || 0;

            // Surface dry veto: METAR with no precip codes challenges radar below dBZ 50.
            // Covers virga, beam overshoot, and holdtime tails after surface rain stops.
            // At dBZ ≥ 50 (very heavy / hail) trust radar over a single station.
            if (dbz < 50 && metarParsed) {
                const hasPrecipCode = obs.obs.presentWeather && obs.obs.presentWeather.length > 0;
                const descHasPrecip = /rain|drizzle|shower|snow|sleet|mist|freezing/i.test(
                    obs.obs.textDescription || ''
                );
                if (!hasPrecipCode && !descHasPrecip) {
                    const omAlsoDry = omPrecipInHr === null || omPrecipInHr < 0.01;

                    // Tier 1 — light dBZ (< 30): METAR alone can veto, no OM needed.
                    // These echoes are too weak to confirm surface rain; a recent surface
                    // obs reporting dry should be trusted even if OM disagrees.
                    // 45-min window covers the typical ASOS 20–60 min reporting cycle.
                    const tier1 = dbz < 30 && metarWeight > 0.1 && metarAge < 45;

                    // Tier 2 — moderate dBZ (30–49): require OM agreement OR a virga
                    // signature. Lowered spread threshold from 10°C → 6°C and added
                    // humidity < 60% — both indicate a dry sub-cloud layer (virga likely).
                    let virga = false;
                    if (obs.obs.temperature_c != null && obs.obs.humidity != null) {
                        const td = _dewpointC(obs.obs.temperature_c, obs.obs.humidity);
                        virga = (obs.obs.temperature_c - td) > 6 || obs.obs.humidity < 60;
                    }
                    const tier2 = dbz >= 30 && metarWeight > 0.3 && metarAge < 20 && (omAlsoDry || virga);

                    if (tier1 || tier2) {
                        return {
                            active: false, type: null, intensity: null, icon: null,
                            source: 'radar', sourceDetail: radarSourceName,
                            confidence: scoreDry * 0.8,
                            observedAt: radarState.timestamp
                        };
                    }
                }
            }

            let type = 'rain', intensity = 'moderate', icon = 'rain';
            if (dbz >= 45)      { intensity = 'heavy'; }
            else if (dbz >= 30) { intensity = 'moderate'; }
            else if (dbz >= 22) { intensity = 'light'; icon = 'rain'; }
            else                { type = 'rain'; intensity = 'light'; icon = 'rain'; }
            // Note: 'drizzle' icon is reserved for radar-blind METAR-only detection.
            // HOLDING state (dBZ < 28) previously confirmed rain — keep icon = 'rain'.

            // Snow detection: if METAR says snow and radar is wet, trust METAR for type
            if (metarParsed && metarParsed.isSnow && metarWeight > 0.1) {
                type = 'snow'; icon = 'snow';
            }

            return {
                active: true, type, intensity, icon,
                source: 'radar', sourceDetail: radarSourceName,
                confidence: scoreWet, observedAt: radarState.timestamp
            };
        }

        // Radar dry — check for METAR override
        // Sub-threshold flag: when radar dBZ < 15 the beam cannot confirm dryness
        // (very light rain falls below NEXRAD detection floor of ~10 dBZ).
        const radarDbzDry = radarState.dbz || 0;
        const radarSubThreshold = radarDbzDry < 15;

        // Age window: 30 min (was 15). ASOS stations report every 20-60 min, so 15 min
        // was rejecting most valid snow and light-rain observations on the next cycle.
        // metarWeight already discounts stale obs; the hard cutoff is the main blocker.
        if (metarParsed && metarWeight > 0.1 && metarAge < 30) {
            const descLower = metarParsed.desc.toLowerCase();
            // Classic radar-blind case (any dBZ): drizzle / mist too fine for radar
            const isClassicRadarBlind = descLower.includes('drizzle') || descLower.includes('mist')
                || descLower.includes('freezing drizzle') || (metarParsed.isRain && descLower.includes('light'));
            // Sub-threshold extension: dBZ < 15 means radar can't rule out rain —
            // trust any METAR precip code (Rain, Snow, Thunder) at slightly reduced confidence.
            const isSubThresholdPrecip = radarSubThreshold
                && (metarParsed.isRain || metarParsed.isSnow || metarParsed.isThunder);

            if (isClassicRadarBlind || isSubThresholdPrecip) {
                const type = metarParsed.isSnow ? 'snow' : 'rain';
                const intensity = 'light';
                const conf = isClassicRadarBlind
                    ? SCORE_METAR_PRECIP_MAX * metarWeight
                    : SCORE_METAR_PRECIP_MAX * metarWeight * 0.85; // slight penalty for sub-threshold
                return {
                    active: true, type, intensity, icon: metarParsed.icon,
                    source: 'metar', sourceDetail: `METAR ${obs.stationId}`,
                    confidence: conf, observedAt: obs.obs.timestamp
                };
            }
        }

        // Sub-threshold radar + model WMO precip signal: allow model to fill even
        // though radar is available, because dBZ < 15 cannot confirm the surface is dry.
        if (radarSubThreshold && modelWMO != null && modelWMO >= 51) {
            const omWet = omPrecipInHr !== null && omPrecipInHr > 0.005;
            if (omWet || modelWMO >= 61) {   // WMO 61+ = definite rain/snow (not just drizzle)
                const isSnow = (modelWMO >= 71 && modelWMO <= 77) || (modelWMO >= 85 && modelWMO <= 86);
                const type = isSnow ? 'snow' : 'rain';
                return {
                    active: true, type, intensity: 'light',
                    icon: isSnow ? 'snow' : 'drizzle',
                    source: 'model', sourceDetail: 'model (sub-threshold radar)',
                    confidence: SCORE_MODEL_PRECIP * 1.5,  // 0.45 — between model (0.30) and METAR
                    observedAt: null
                };
            }
        }

        // Radar dry, nothing overrides
        return {
            active: false, type: null, intensity: null, icon: null,
            source: 'radar', sourceDetail: radarSourceName,
            confidence: scoreDry, observedAt: radarState.timestamp
        };
    }

    // ── No radar — METAR only ───────────────────────────────────────────────
    if (metarParsed && metarWeight > 0.05) {
        if (metarParsed.isRain || metarParsed.isSnow || metarParsed.isThunder) {
            const type = metarParsed.isSnow ? 'snow'
                       : metarParsed.isThunder ? 'rain'
                       : 'rain';
            const descLower = metarParsed.desc.toLowerCase();
            const intensity = descLower.includes('heavy') ? 'heavy'
                            : descLower.includes('light') || descLower.includes('drizzle') ? 'light'
                            : 'moderate';
            return {
                active: true, type, intensity, icon: metarParsed.icon,
                source: 'metar', sourceDetail: `METAR ${obs.stationId}`,
                confidence: SCORE_METAR_PRECIP_MAX * metarWeight,
                observedAt: obs.obs.timestamp
            };
        }
        // METAR reports dry
        return {
            active: false, type: null, intensity: null, icon: null,
            source: 'metar', sourceDetail: `METAR ${obs.stationId}`,
            confidence: SCORE_METAR_DRY_MAX * metarWeight,
            observedAt: obs.obs.timestamp
        };
    }

    // ── No radar, no METAR — model gap-fill ─────────────────────────────────
    if (modelWMO != null) {
        const info = getWeatherInfo(modelWMO);
        const isPrecip = modelWMO >= 51; // WMO codes 51+ are precipitation
        if (isPrecip) {
            const isSnow = modelWMO >= 71 && modelWMO <= 77 || modelWMO >= 85 && modelWMO <= 86;
            const type = isSnow ? 'snow' : 'rain';
            const intensity = (modelWMO === 65 || modelWMO === 75 || modelWMO === 82 || modelWMO === 86)
                ? 'heavy' : (modelWMO === 61 || modelWMO === 71 || modelWMO === 80 || modelWMO === 51)
                ? 'light' : 'moderate';
            return {
                active: true, type, intensity, icon: info.icon,
                source: 'model', sourceDetail: 'model',
                confidence: SCORE_MODEL_PRECIP, observedAt: null
            };
        }
        return {
            active: false, type: null, intensity: null, icon: null,
            source: 'model', sourceDetail: 'model',
            confidence: SCORE_MODEL_PRECIP, observedAt: null
        };
    }

    return {
        active: false, type: null, intensity: null, icon: null,
        source: 'none', sourceDetail: null,
        confidence: 0, observedAt: null
    };
}

/**
 * Score sky state from METAR observation or model WMO gap-fill.
 * Includes anti-jitter hysteresis for METAR ↔ model transitions.
 */
function _scoreSkyState(obs, modelWMO) {
    let metarScore = 0, metarCover = null, metarVisibility = null, metarIcon = null;
    let metarSourceDetail = null, metarObservedAt = null;

    if (obs && obs.obs) {
        const age = metarAgeMinutes(obs.obs.timestamp);
        const parsed = parseMetarCondition(obs.obs.presentWeather, obs.obs.textDescription);

        if (parsed.desc !== 'Unknown') {
            // Score based on age
            if (age <= 20)      metarScore = SCORE_METAR_SKY_MAX;
            else if (age <= 40) metarScore = 0.70;
            else if (age <= 60) metarScore = 0.50;
            else                metarScore = 0.30;

            // V1: cover = desc, visibility = null (full split is a follow-up)
            metarCover = parsed.desc;
            metarVisibility = null;
            metarIcon = parsed.icon;
            metarSourceDetail = `METAR ${obs.stationId}`;
            metarObservedAt = obs.obs.timestamp;
        }
    }

    // Model sky from WMO code
    let modelCover = null, modelIcon = null;
    if (modelWMO != null) {
        const info = getWeatherInfo(modelWMO);
        if (info.desc !== 'Unknown') {
            // Map WMO codes to cover descriptions
            if (modelWMO <= 1)       modelCover = 'Clear';
            else if (modelWMO === 2) modelCover = 'Partly Cloudy';
            else if (modelWMO === 3) modelCover = 'Overcast';
            else if (modelWMO === 45 || modelWMO === 48) modelCover = 'Fog';
            else modelCover = info.desc;
            modelIcon = info.icon;
        }
    }

    // Hysteresis: prevent oscillation at METAR/model boundary
    if (_prevSkySource === 'metar') {
        // METAR must drop below DOWN threshold to yield to model
        if (metarScore >= SKY_HYSTERESIS_DOWN && metarCover) {
            _prevSkySource = 'metar';
            return {
                cover: metarCover, visibility: metarVisibility, icon: metarIcon,
                source: 'metar', sourceDetail: metarSourceDetail,
                confidence: metarScore, observedAt: metarObservedAt
            };
        }
    } else if (_prevSkySource === 'model') {
        // METAR must exceed UP threshold to reclaim from model
        if (metarScore < SKY_HYSTERESIS_UP && modelCover) {
            _prevSkySource = 'model';
            return {
                cover: modelCover, visibility: null, icon: modelIcon,
                source: 'model', sourceDetail: 'model',
                confidence: SCORE_MODEL_SKY, observedAt: null
            };
        }
    }

    // Default: pick the better source
    if (metarCover && metarScore > SCORE_MODEL_SKY) {
        _prevSkySource = 'metar';
        return {
            cover: metarCover, visibility: metarVisibility, icon: metarIcon,
            source: 'metar', sourceDetail: metarSourceDetail,
            confidence: metarScore, observedAt: metarObservedAt
        };
    }
    if (modelCover) {
        _prevSkySource = 'model';
        return {
            cover: modelCover, visibility: null, icon: modelIcon,
            source: 'model', sourceDetail: 'model',
            confidence: SCORE_MODEL_SKY, observedAt: null
        };
    }

    _prevSkySource = null;
    return {
        cover: null, visibility: null, icon: null,
        source: 'none', sourceDetail: null,
        confidence: 0, observedAt: null
    };
}

/**
 * Normalize lightning state: pass-through existing _computeLightningState
 * with confidence string → number conversion.
 */
function _normalizeThunder(lightningState) {
    if (!lightningState || lightningState.state === 'none') {
        return {
            state: 'none', nearestMi: null,
            source: lightningState ? lightningState.source : 'none',
            confidence: 0,
            updatedAt: lightningState ? lightningState.updatedAt : null
        };
    }

    // Convert string confidence to number (GLM confidence is slightly softer)
    const confMap = { high: 0.85, medium: 0.55, low: 0.3, none: 0 };
    const numConf = confMap[lightningState.confidence] || 0;

    return {
        state: lightningState.state,
        nearestMi: lightningState.nearestFlashMi,
        source: lightningState.source,
        confidence: numConf,
        updatedAt: lightningState.updatedAt || lightningState.lastFlashAt
    };
}

/**
 * Derive a synthesized nowcast state from all available sources.
 * Each question (precip, sky, thunder) is answered independently.
 * @param {object|null} radarState - from sampleRadarAtPoint
 * @param {object|null} obs - from fetchStationObservation
 * @param {number|null} modelWMO - WMO weather code from Open-Meteo current
 * @param {object|null} lightningState - from _computeLightningState
 * @param {object|null} trend - precipTrend60m pass-through
 * @param {string} country - location country
 * @returns {object} NowcastState
 */
function deriveNowcastState(radarState, obs, modelWMO, lightningState, trend, country, omPrecipInHr = null) {
    const isUS = country === 'United States';

    const precip  = _scorePrecipNow(radarState, obs, modelWMO, isUS, omPrecipInHr);
    const sky     = _scoreSkyState(obs, modelWMO);
    const thunder = _normalizeThunder(lightningState);

    // Derive sources list from active fields
    const sources = [];
    if (precip.sourceDetail && precip.sourceDetail !== 'model') sources.push(precip.sourceDetail);
    if (sky.sourceDetail && sky.sourceDetail !== precip.sourceDetail && sky.sourceDetail !== 'model') sources.push(sky.sourceDetail);
    if (thunder.state !== 'none' && thunder.source === 'lightning') sources.push('GOES GLM');
    else if (thunder.state !== 'none' && thunder.source === 'merged') sources.push('GOES GLM');
    if (sources.length === 0 && (precip.sourceDetail === 'model' || sky.sourceDetail === 'model')) sources.push('Model forecast');

    return { precip, sky, thunder, trend, sources };
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

function startNowcastPolling(lat, lon, country, locationName, stateCode, modelCtx, modelWMO) {
    stopNowcastPolling();

    let _pollLat = lat;
    let _pollLon = lon;
    let _pollCountry = country;
    let _pollModelCtx = modelCtx || null;
    let _pollModelWMO = modelWMO ?? null;
    let _paused = false;
    const myGen = ++_nowcastPollGen; // capture generation — stale polls see a mismatch

    async function poll() {
        if (_paused || myGen !== _nowcastPollGen) return;
        try {
            const summary = await getNowSummary({ lat: _pollLat, lon: _pollLon, country: _pollCountry, locationName, stateCode, modelContext: _pollModelCtx, modelWMO: _pollModelWMO });
            if (myGen !== _nowcastPollGen) return; // location changed during fetch — discard
            cachedNowSummary = summary;
            saveNowcastState(summary, _pollLat, _pollLon);
            // In-place DOM update (no full re-render)
            if (typeof updateNowcastDisplay === 'function') {
                updateNowcastDisplay(summary);
            }
        } catch (err) {
            if (myGen !== _nowcastPollGen) return;
            console.warn('[Nowcast] Poll error:', err.message);
        }

        if (myGen !== _nowcastPollGen) return;
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
    ++_nowcastPollGen; // invalidate any in-flight polls
    if (_nowcastPollTimer) {
        clearTimeout(_nowcastPollTimer);
        _nowcastPollTimer = null;
    }
    if (startNowcastPolling._visCleanup) {
        startNowcastPolling._visCleanup();
        startNowcastPolling._visCleanup = null;
    }
}
