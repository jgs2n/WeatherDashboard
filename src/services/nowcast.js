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

    // Log snapshot for ML training (silent no-op if logger not loaded or server unavailable)
    if (typeof logNowcastSnapshot === 'function') {
        logNowcastSnapshot({ lat, lon, country, radarState, motion, obs, summary, locationName: explicitName, stateCode: explicitStateCode, modelContext: explicitModelCtx, modelHourlyContext: explicitModelHourly });
    }

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

// ── Product 3: Precipitation Trend 0–60 min ──────────────────────────────────
// Builds a 12-bucket timeline from radar extrapolation and summarizes it into
// confidence-aware human language.

async function _computePrecipTrend60m(lat, lon, isUS, currentDbz, isRaining, motion) {
    const timeline = buildPrecipTimeline(currentDbz, isRaining);

    // ── Wet case: slope-only clearing prediction (unchanged) ─────────────────
    if (isRaining) {
        let endInMin = null;
        if (timeline) {
            const lastWet = [...timeline].reverse().find(b => b.precipClass > 0);
            if (lastWet) endInMin = lastWet.minute;
        } else {
            const t = estimateRainTiming(motion, currentDbz, isRaining);
            endInMin = t.endInMin;
        }
        const summaryResult = _summarizePrecipTimeline(timeline, true, null, endInMin, null, false);
        return {
            timeline,
            summary:           summaryResult ? summaryResult.text : null,
            summaryConfidence: summaryResult ? summaryResult.confidence : 'low',
            beginInMin: null,
            endInMin
        };
    }

    // ── Dry case: upstream sampling primary, slope as confirmation ───────────
    // Slope-derived beginInMin (fallback / confirmation signal)
    let slopeBeginInMin = null;
    if (timeline) {
        const firstWet = timeline.find(b => b.precipClass > 0);
        if (firstWet) slopeBeginInMin = firstWet.minute;
    } else {
        const t = estimateRainTiming(motion, currentDbz, isRaining);
        slopeBeginInMin = t.beginInMin;
    }

    // Upstream sampling — requires motion vector
    let beginInMin = slopeBeginInMin;
    let trackCertainty = null; // null = no upstream result, 'fair', or 'good'
    const slopeAlsoFires = slopeBeginInMin !== null;

    if (motion && motion.speed_kmh >= 5) {
        try {
            const upstream = await sampleUpstreamTimeline(lat, lon, isUS, motion);
            if (upstream) {
                // Find earliest bucket where center shows rain (dBZ ≥ BEGIN_SIGNAL_DBZ)
                // and lateral spread passes the track-over-point gate (≥2/3 hits)
                for (const bucket of upstream) {
                    const centerRain = bucket.centerDbz !== null && bucket.centerDbz >= RADAR_CFG.BEGIN_SIGNAL_DBZ;
                    if (!centerRain) continue;

                    // lateralHits counts all 3 points (center included); need ≥2
                    if (bucket.lateralHits < 2) {
                        // Marginal — only set 'fair' if nothing better found yet
                        if (trackCertainty === null) {
                            beginInMin     = bucket.minute;
                            trackCertainty = 'fair';
                        }
                    } else {
                        // Good spread: motion consistent check
                        const motionConsistent = motion.speed_kmh >= 10; // proxy for reliable vector
                        beginInMin     = bucket.minute;
                        trackCertainty = motionConsistent ? 'good' : 'fair';
                        break; // use earliest qualifying bucket
                    }
                }
            }
        } catch (err) {
            console.warn('[Nowcast] Upstream sampling failed:', err.message);
        }
    }

    const summaryResult = _summarizePrecipTimeline(timeline, false, beginInMin, null, trackCertainty, slopeAlsoFires);
    return {
        timeline,
        summary:           summaryResult ? summaryResult.text : null,
        summaryConfidence: summaryResult ? summaryResult.confidence : 'low',
        beginInMin,
        endInMin: null
    };
}

// ── Precipitation Timeline Summarizer ────────────────────────────────────────
// Converts the 12-bucket timeline into a confidence-aware human string.
// Returns { text, confidence } or null if no precipitation is predicted.

// trackCertainty: null | 'fair' | 'good'  — from upstream sampling (dry case only)
// slopeAlsoFires: bool — slope timeline also predicted rain (enables premium tier)
function _summarizePrecipTimeline(timeline, isRaining, beginInMin, endInMin, trackCertainty = null, slopeAlsoFires = false) {
    // No timeline (< 3 radar frames) — fall back to vague strings at low confidence.
    // Do NOT include exact minute counts here: confidence is always 'low' in this
    // branch, and the benchmark precision-violation check flags exact timing below
    // 15 min at low confidence.
    if (!timeline) {
        if (isRaining)                        return { text: 'Rain now, clearing later', confidence: 'low' };
        if (!isRaining && beginInMin != null) return { text: 'Showers possible soon',   confidence: 'low' };
        return null;
    }

    // ── Wet case: slope-based clearing (unchanged) ───────────────────────────
    if (isRaining) {
        const wetBuckets = timeline.filter(b => b.precipClass > 0);
        if (wetBuckets.length === 0) return null;

        let runCount = 0, prevWet = false;
        for (const b of timeline) {
            const wet = b.precipClass > 0;
            if (wet && !prevWet) runCount++;
            prevWet = wet;
        }
        if (runCount >= 3) return { text: 'Intermittent rain next hour', confidence: 'low' };

        const avgConf = wetBuckets.reduce((s, b) => s + b.confidence, 0) / wetBuckets.length;
        const tier = avgConf >= 0.7 ? 'high' : avgConf >= 0.4 ? 'med' : 'low';
        const lastWet = wetBuckets[wetBuckets.length - 1];
        const duration = lastWet.minute;
        if (tier === 'high') return { text: `Rain continuing for ~${duration} min`, confidence: 'high' };
        if (tier === 'med')  return { text: `Rain may continue ~${duration} min`,   confidence: 'med'  };
        return { text: 'Rain now, clearing later', confidence: 'low' };
    }

    // ── Dry case: upstream-aware phrasing ────────────────────────────────────
    if (trackCertainty !== null && beginInMin !== null) {
        // Upstream sampling result is available — use it as the primary signal.
        // Premium tier: upstream + slope both agree.
        if (trackCertainty === 'good' && slopeAlsoFires) {
            return { text: `Rain beginning in ~${beginInMin} min`, confidence: 'high' };
        }
        if (trackCertainty === 'good') {
            return { text: `Rain likely in ~${beginInMin} min`, confidence: 'med' };
        }
        // fair certainty
        return { text: `Rain possible in ~${beginInMin} min`, confidence: 'low' };
    }

    // No upstream result — slope-only prediction; cap at 'med' (no exact-minute claims
    // without upstream confirmation — slope extrapolation alone has ~56 min start MAE).
    const wetBuckets = timeline.filter(b => b.precipClass > 0);
    if (wetBuckets.length === 0) return null;

    let runCount = 0, prevWet = false;
    for (const b of timeline) {
        const wet = b.precipClass > 0;
        if (wet && !prevWet) runCount++;
        prevWet = wet;
    }
    if (runCount >= 3) return { text: 'Intermittent rain next hour', confidence: 'low' };

    const avgConf = wetBuckets.reduce((s, b) => s + b.confidence, 0) / wetBuckets.length;
    let tier = avgConf >= 0.7 ? 'high' : avgConf >= 0.4 ? 'med' : 'low';
    if (tier === 'high') tier = 'med'; // slope-only: cap at med without upstream confirmation
    const firstWet = wetBuckets[0];
    const start = firstWet.minute;
    if (tier === 'med')  return { text: `Rain possible in ~${Math.max(0, start - 5)}–${start + 5} min`, confidence: 'med'  };
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
