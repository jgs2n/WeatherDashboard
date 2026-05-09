// Nowcast display logic — condition label selection, evidence lines, rationale,
// and display damping. Pure business logic (no DOM access).
// Extracted from renderDashboard.js (Phase 2A cleanup).

const JITTER_CONFIRM_CYCLES = 2;

// Display memory for label stability (UI layer only — resets on page load)
let _displayMemory = {
    lastLabel: null,
    pendingLabel: null,
    pendingCount: 0
};

function resetDisplayMemory() {
    _displayMemory = { lastLabel: null, pendingLabel: null, pendingCount: 0 };
}

/**
 * Pick the primary condition label from synthesized nowcast state.
 * Priority: thunder → precip → visibility → cover.
 * Returns { desc, icon }.
 */
function _pickNowcastLabel(state) {
    const { precip, sky, thunder } = state;

    // 1. Active thunder + precip
    if (thunder.state === 'active' && precip.active) {
        if (precip.intensity === 'heavy') {
            return { desc: 'Thunderstorm', icon: 'thunderstorms-rain' };
        }
        if (precip.type === 'snow') {
            return { desc: 'Snow with thunder', icon: 'snow' };
        }
        return { desc: 'Rain with thunder', icon: 'thunderstorms-rain' };
    }

    // 2. Active thunder, no precip, close flashes (GLM: 10 mi threshold, broader than point-strike)
    if (thunder.state === 'active' && !precip.active && thunder.nearestMi != null && thunder.nearestMi <= 10) {
        return { desc: 'Thunder nearby', icon: 'thunderstorms-rain' };
    }

    // 3. Precip active
    if (precip.active) {
        let desc;
        if (precip.type === 'snow') {
            desc = precip.intensity === 'heavy' ? 'Heavy Snow'
                 : precip.intensity === 'light' ? 'Light Snow' : 'Snow';
        } else if (precip.type === 'mixed' || precip.type === 'ice') {
            desc = 'Wintry Mix';
        } else {
            desc = precip.intensity === 'heavy' ? 'Heavy Rain'
                 : precip.intensity === 'light' ? 'Light Rain' : 'Rain';
        }
        let icon = precip.icon || 'rain';

        // Nearby thunder modifier (em-dash)
        if (thunder.state === 'nearby') {
            if (precip.type === 'snow') {
                desc = 'Snow \u2014 thunder nearby';
            } else {
                desc = desc + ' \u2014 thunder nearby';
                icon = 'thunderstorms-rain';
            }
        }

        return { desc, icon };
    }

    // 4. Visibility (V1: always null, but ready for future split)
    if (sky.visibility) {
        return { desc: sky.visibility, icon: sky.icon || 'fog-day' };
    }

    // 5. Sky cover
    if (sky.cover) {
        let icon = sky.icon || 'clear-day';
        // If lightning is approaching but no precip/thunder active at our
        // location, the sky isn't "clear" even if cloud cover obs say so.
        // Swap the most optimistic icons for an overcast hint so the icon
        // doesn't contradict the "distant lightning" evidence line.
        if (thunder.state === 'approaching' && (icon === 'clear-day' || icon === 'clear-night' || icon === 'partly-cloudy-day' || icon === 'partly-cloudy-night')) {
            icon = icon.endsWith('-night') ? 'overcast-night' : 'overcast-day';
        }
        return { desc: sky.cover, icon };
    }

    return { desc: 'Unknown', icon: 'not-available' };
}

/**
 * Pick the evidence line — source-aware, calm.
 * "Lightning 8 mi away" | "just now" | "8m ago" | ""
 */
function _pickEvidenceLine(state) {
    const { precip, sky, thunder } = state;

    // Thunder active/nearby → show approximate distance (GLM is ~10 km resolution)
    if ((thunder.state === 'active' || thunder.state === 'nearby') && thunder.nearestMi != null) {
        return `Lightning detected ~${thunder.nearestMi} mi`;
    }

    // Precip from radar → "just now"
    if (precip.active && precip.source === 'radar') {
        return 'just now';
    }

    // Observational timestamp
    const ts = precip.active ? precip.observedAt : sky.observedAt;
    if (ts) {
        const age = metarAgeMinutes(ts);
        return age < 1 ? 'just now' : `${age}m ago`;
    }

    // Model-only → no evidence
    return '';
}

/**
 * Build rationale text — source list + 1-2 short sentences.
 * Generated once from synthesized state.
 */
function _buildRationale(state) {
    const { precip, sky, thunder, sources } = state;

    // Source line
    const srcLine = sources.join(' + ');

    // Sentences
    const sentences = [];

    // Precip sentence
    if (precip.active && precip.source === 'radar') {
        sentences.push(`Radar shows ${precip.intensity || ''} ${precip.type || 'rain'}`.trim() + '.');
    } else if (precip.active && precip.source === 'metar') {
        sentences.push(`Station reports ${precip.intensity || ''} ${precip.type || 'rain'}`.trim() + '.');
    } else if (!precip.active && precip.source === 'radar') {
        sentences.push('Radar shows dry.');
    }

    // Sky sentence (only if sky is from a different source or adds info)
    if (sky.cover && sky.source === 'metar' && precip.source !== 'metar') {
        sentences.push(`Station reports ${sky.cover.toLowerCase()}.`);
    } else if (sky.cover && sky.source === 'metar' && precip.source === 'metar') {
        // Both from same station — combine if sky differs from precip desc
        sentences.push(`Station confirms ${sky.cover.toLowerCase()}.`);
    }

    // Radar dry + METAR drizzle override explanation
    if (precip.active && precip.source === 'metar' && state.precip.confidence < 0.5) {
        const idx = sentences.findIndex(s => s.startsWith('Radar'));
        if (idx === -1) sentences.push('Radar dry; station reports drizzle \u2014 using station.');
    }

    // No observational data
    if (precip.source === 'model' || (precip.source === 'none' && sky.source === 'model')) {
        sentences.length = 0;
        sentences.push('No station or radar data available.');
    } else if (precip.source === 'none' && sky.source === 'none') {
        sentences.length = 0;
        sentences.push('No data available.');
    }

    // Station too old
    if (sky.source === 'model' && precip.source !== 'none' && precip.source !== 'model') {
        sentences.push('Station data too old.');
    }

    // Thunder promotion (GLM-aware language)
    if (thunder.state === 'active') {
        sentences.push('Lightning detected nearby \u2014 promoted to thunderstorm.');
    } else if (thunder.state === 'nearby') {
        sentences.push('Nearby lightning detected.');
    } else if (thunder.state === 'approaching') {
        sentences.push('Lightning remains distant \u2014 no condition change.');
    }

    // Cap at 2 sentences
    const capped = sentences.slice(0, 2).join(' ');
    return srcLine ? `${srcLine}\n${capped}` : capped;
}

/**
 * Check if a label transition is an escalation (instant switch allowed).
 * Escalation = more impactful weather: dry → precip, precip → thunderstorm, clear → fog.
 */
function _isEscalation(fromLabel, toLabel) {
    if (!fromLabel || !toLabel) return true;
    const from = fromLabel.toLowerCase();
    const to = toLabel.toLowerCase();

    // Dry/clear/cloudy → any precip or thunder
    const fromDry = !from.includes('rain') && !from.includes('snow') && !from.includes('thunder')
        && !from.includes('drizzle') && !from.includes('fog');
    const toPrecip = to.includes('rain') || to.includes('snow') || to.includes('thunder')
        || to.includes('drizzle');
    if (fromDry && toPrecip) return true;

    // Any precip → thunderstorm
    if (!from.includes('thunder') && to.includes('thunder')) return true;

    // Clear/cloudy → fog
    if (!from.includes('fog') && to.includes('fog')) return true;

    return false;
}

/**
 * Apply display damping to prevent label jitter on de-escalations.
 * Escalations are instant; de-escalations require JITTER_CONFIRM_CYCLES polls.
 * Returns the label to actually display.
 */
function _applyDisplayDamping(newLabel) {
    if (!_displayMemory.lastLabel) {
        _displayMemory.lastLabel = newLabel;
        _displayMemory.pendingLabel = null;
        _displayMemory.pendingCount = 0;
        return newLabel;
    }

    if (newLabel === _displayMemory.lastLabel) {
        _displayMemory.pendingLabel = null;
        _displayMemory.pendingCount = 0;
        return newLabel;
    }

    // Escalation → switch immediately
    if (_isEscalation(_displayMemory.lastLabel, newLabel)) {
        _displayMemory.lastLabel = newLabel;
        _displayMemory.pendingLabel = null;
        _displayMemory.pendingCount = 0;
        return newLabel;
    }

    // De-escalation or lateral move → require confirmation cycles
    if (newLabel === _displayMemory.pendingLabel) {
        _displayMemory.pendingCount++;
        if (_displayMemory.pendingCount >= JITTER_CONFIRM_CYCLES) {
            _displayMemory.lastLabel = newLabel;
            _displayMemory.pendingLabel = null;
            _displayMemory.pendingCount = 0;
            return newLabel;
        }
    } else {
        _displayMemory.pendingLabel = newLabel;
        _displayMemory.pendingCount = 1;
    }

    return _displayMemory.lastLabel;
}
