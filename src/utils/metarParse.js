// METAR / NWS present-weather parsing utilities
// Pure functions — no DOM, no fetch.
// Exports (globals): parseMetarCondition, metarAgeMinutes, mapNWSTextToCondition, metarFreshnessWeight

// ── NWS presentWeather rawString → condition mapping ─────────────────────────
// NWS present-weather objects have { rawString, ... } with METAR abbreviations.
// Order matters: first match wins, so more specific patterns come first.

const _METAR_PATTERNS = [
    // Thunderstorm variants
    { rx: /\+TS/,            desc: 'Heavy Thunderstorm',  icon: 'thunderstorms-rain', isThunder: true,  isRain: true,  isSnow: false },
    { rx: /TSRA|TSSN|TSGS/,  desc: 'Thunderstorm',        icon: 'thunderstorms-rain', isThunder: true,  isRain: true,  isSnow: false },
    { rx: /\bTS\b/,          desc: 'Thunderstorm',        icon: 'thunderstorms-rain', isThunder: true,  isRain: false, isSnow: false },
    // Freezing precip
    { rx: /FZRA/,            desc: 'Freezing Rain',       icon: 'sleet',              isThunder: false, isRain: true,  isSnow: false },
    { rx: /FZDZ/,            desc: 'Freezing Drizzle',    icon: 'sleet',              isThunder: false, isRain: true,  isSnow: false },
    // Snow
    { rx: /\+SN/,            desc: 'Heavy Snow',          icon: 'snow',               isThunder: false, isRain: false, isSnow: true },
    { rx: /\bSN\b/,          desc: 'Snow',                icon: 'snow',               isThunder: false, isRain: false, isSnow: true },
    { rx: /-SN/,             desc: 'Light Snow',          icon: 'snow',               isThunder: false, isRain: false, isSnow: true },
    { rx: /SG|IC|PE|PL|GS/,  desc: 'Wintry Mix',          icon: 'sleet',              isThunder: false, isRain: true,  isSnow: true },
    // Rain
    { rx: /\+RA/,            desc: 'Heavy Rain',          icon: 'rain',               isThunder: false, isRain: true,  isSnow: false },
    { rx: /\bRA\b/,          desc: 'Rain',                icon: 'rain',               isThunder: false, isRain: true,  isSnow: false },
    { rx: /-RA/,             desc: 'Light Rain',          icon: 'drizzle',            isThunder: false, isRain: true,  isSnow: false },
    // Drizzle
    { rx: /\bDZ\b|\+DZ|-DZ/, desc: 'Drizzle',             icon: 'drizzle',            isThunder: false, isRain: true,  isSnow: false },
    // Showers
    { rx: /\+SH/,            desc: 'Heavy Showers',       icon: 'rain',               isThunder: false, isRain: true,  isSnow: false },
    { rx: /SHRA/,            desc: 'Rain Showers',        icon: 'drizzle',            isThunder: false, isRain: true,  isSnow: false },
    { rx: /\bSH\b|-SH/,     desc: 'Light Showers',       icon: 'drizzle',            isThunder: false, isRain: true,  isSnow: false },
    // Fog / visibility
    { rx: /FG/,              desc: 'Fog',                 icon: 'fog-day',            isThunder: false, isRain: false, isSnow: false },
    { rx: /BR/,              desc: 'Mist',                icon: 'mist',               isThunder: false, isRain: false, isSnow: false },
    { rx: /HZ/,              desc: 'Haze',                icon: 'mist',               isThunder: false, isRain: false, isSnow: false },
    // Other
    { rx: /FU|VA/,           desc: 'Smoke',               icon: 'mist',               isThunder: false, isRain: false, isSnow: false },
    { rx: /DU|SA|SS|DS/,     desc: 'Dust/Sand',           icon: 'mist',               isThunder: false, isRain: false, isSnow: false },
];

// ── NWS textDescription → condition fallback mapping ─────────────────────────
const _TEXT_PATTERNS = [
    { rx: /thunder/i,                    desc: 'Thunderstorm',    icon: 'thunderstorms-rain', isThunder: true,  isRain: true,  isSnow: false },
    { rx: /freezing rain/i,              desc: 'Freezing Rain',   icon: 'sleet',              isThunder: false, isRain: true,  isSnow: false },
    { rx: /heavy (rain|precip)/i,        desc: 'Heavy Rain',      icon: 'rain',               isThunder: false, isRain: true,  isSnow: false },
    { rx: /rain|showers/i,              desc: 'Rain',            icon: 'rain',               isThunder: false, isRain: true,  isSnow: false },
    { rx: /light rain|drizzle/i,        desc: 'Light Rain',      icon: 'drizzle',            isThunder: false, isRain: true,  isSnow: false },
    { rx: /heavy snow|blizzard/i,       desc: 'Heavy Snow',      icon: 'snow',               isThunder: false, isRain: false, isSnow: true },
    { rx: /snow|flurries/i,             desc: 'Snow',            icon: 'snow',               isThunder: false, isRain: false, isSnow: true },
    { rx: /sleet|ice|wintry|freezing/i, desc: 'Wintry Mix',      icon: 'sleet',              isThunder: false, isRain: true,  isSnow: true },
    { rx: /fog/i,                       desc: 'Fog',             icon: 'fog-day',            isThunder: false, isRain: false, isSnow: false },
    { rx: /mist|haze/i,                 desc: 'Mist',            icon: 'mist',               isThunder: false, isRain: false, isSnow: false },
    { rx: /smoke/i,                     desc: 'Smoke',           icon: 'mist',               isThunder: false, isRain: false, isSnow: false },
    { rx: /overcast|cloudy/i,           desc: 'Overcast',        icon: 'overcast-day',       isThunder: false, isRain: false, isSnow: false },
    { rx: /mostly cloudy/i,             desc: 'Mostly Cloudy',   icon: 'overcast-day',       isThunder: false, isRain: false, isSnow: false },
    { rx: /partly (cloudy|sunny)/i,     desc: 'Partly Cloudy',   icon: 'partly-cloudy-day',  isThunder: false, isRain: false, isSnow: false },
    { rx: /mostly (clear|sunny)/i,      desc: 'Mostly Clear',    icon: 'clear-day',          isThunder: false, isRain: false, isSnow: false },
    { rx: /fair|clear|sunny/i,          desc: 'Clear',           icon: 'clear-day',          isThunder: false, isRain: false, isSnow: false },
];

/**
 * Parse NWS present-weather array + textDescription into a condition object.
 * @param {Array|null} presentWeather - NWS presentWeather array [{rawString,...}]
 * @param {string|null} textDescription - NWS human-readable description
 * @returns {{ desc:string, icon:string, isThunder:boolean, isRain:boolean, isSnow:boolean }}
 */
function parseMetarCondition(presentWeather, textDescription) {
    // Try presentWeather rawStrings first (most specific)
    if (presentWeather && presentWeather.length > 0) {
        for (const pw of presentWeather) {
            const raw = pw.rawString || pw.weather || '';
            for (const pat of _METAR_PATTERNS) {
                if (pat.rx.test(raw)) return { ...pat, rx: undefined };
            }
        }
    }

    // Fall back to textDescription
    if (textDescription) {
        for (const pat of _TEXT_PATTERNS) {
            if (pat.rx.test(textDescription)) return { ...pat, rx: undefined };
        }
    }

    // Unknown
    return { desc: 'Unknown', icon: 'not-available', isThunder: false, isRain: false, isSnow: false };
}

/**
 * Compute how many minutes old an observation is.
 * @param {string} isoTimestamp - ISO 8601 timestamp from NWS observation
 * @returns {number} minutes since observation (floored)
 */
function metarAgeMinutes(isoTimestamp) {
    if (!isoTimestamp) return Infinity;
    return Math.floor((Date.now() - new Date(isoTimestamp).getTime()) / 60000);
}

/**
 * Freshness weight for a METAR observation based on age and phenomenon type.
 * Sky observations (cloud cover, fog) age more slowly than precipitation reports.
 * @param {number} ageMinutes - result of metarAgeMinutes()
 * @param {'precip'|'sky'} phenomenon
 * @returns {number} weight 0..1
 */
function metarFreshnessWeight(ageMinutes, phenomenon) {
    if (phenomenon === 'sky') {
        if (ageMinutes <= 20) return 1.0;
        if (ageMinutes <= 40) return 0.7;
        if (ageMinutes <= 60) return 0.4;
        return 0.1;
    }
    // 'precip' — precipitation truth decays faster
    if (ageMinutes <= 10) return 1.0;
    if (ageMinutes <= 20) return 0.7;
    if (ageMinutes <= 30) return 0.4;
    if (ageMinutes <= 40) return 0.15;
    return 0.05;
}

/**
 * Map NWS textDescription to a condition (used when presentWeather is empty).
 * Alias for parseMetarCondition(null, text).
 */
function mapNWSTextToCondition(textDescription) {
    return parseMetarCondition(null, textDescription);
}

/**
 * Detect thunderstorm from METAR data + radar dBZ.
 * Conservative: prefers "Heavy rain" over false thunder claims.
 *
 * @param {Array|null} presentWeather - NWS presentWeather array
 * @param {string|null} textDescription - NWS text description
 * @param {number|null} radarDbz - current radar reflectivity at point
 * @returns {{ isThunder:boolean, confidence:string, source:string }}
 */
function detectThunder(presentWeather, textDescription, radarDbz) {
    // Check METAR for explicit thunderstorm
    if (presentWeather && presentWeather.length > 0) {
        for (const pw of presentWeather) {
            const raw = (pw.rawString || pw.weather || '').toUpperCase();
            if (/\bTS\b|TSRA|TSSN|TSGS/.test(raw)) {
                return { isThunder: true, confidence: 'high', source: 'METAR' };
            }
        }
    }

    // Check textDescription for thunder
    if (textDescription && /thunder/i.test(textDescription)) {
        return { isThunder: true, confidence: 'high', source: 'METAR' };
    }

    // Radar + convective METAR: high dBZ AND station reports convective wx
    if (radarDbz !== null && radarDbz >= 45 && presentWeather && presentWeather.length > 0) {
        for (const pw of presentWeather) {
            const raw = (pw.rawString || pw.weather || '').toUpperCase();
            // Convective indicators: heavy rain, hail, squalls
            if (/\+RA|GR|GS|SQ/.test(raw)) {
                return { isThunder: true, confidence: 'med', source: 'NEXRAD+METAR' };
            }
        }
    }

    // dBZ >= 45 alone → do NOT claim thunder (prefer "Heavy rain")
    // This is the conservative approach from the spec
    return { isThunder: false, confidence: 'none', source: 'none' };
}
