// ===== MOON PHASE CALCULATION =====
function getMoonPhase(date = new Date()) {
    // Known new moon reference: Jan 6, 2000 18:14 UTC
    const refNewMoon = new Date(Date.UTC(2000, 0, 6, 18, 14, 0));
    const synodicMonth = 29.53058770576;

    const daysSinceRef = (date.getTime() - refNewMoon.getTime()) / (1000 * 60 * 60 * 24);
    const lunarAge = ((daysSinceRef % synodicMonth) + synodicMonth) % synodicMonth;
    const illumination = Math.round((1 - Math.cos(2 * Math.PI * lunarAge / synodicMonth)) / 2 * 100);

    // Phase breakdown (8 phases)
    const phase = lunarAge / synodicMonth; // 0 to 1
    let name, icon, direction;

    if (phase < 0.0625) {
        name = 'New Moon'; icon = '🌑'; direction = '';
    } else if (phase < 0.1875) {
        name = 'Waxing Crescent'; icon = '🌒'; direction = '▲';
    } else if (phase < 0.3125) {
        name = 'First Quarter'; icon = '🌓'; direction = '▲';
    } else if (phase < 0.4375) {
        name = 'Waxing Gibbous'; icon = '🌔'; direction = '▲';
    } else if (phase < 0.5625) {
        name = 'Full Moon'; icon = '🌕'; direction = '';
    } else if (phase < 0.6875) {
        name = 'Waning Gibbous'; icon = '🌖'; direction = '▼';
    } else if (phase < 0.8125) {
        name = 'Last Quarter'; icon = '🌗'; direction = '▼';
    } else if (phase < 0.9375) {
        name = 'Waning Crescent'; icon = '🌘'; direction = '▼';
    } else {
        name = 'New Moon'; icon = '🌑'; direction = '';
    }

    return { name, icon, illumination, direction, lunarAge: Math.round(lunarAge * 10) / 10, phase };
}

// Approximate moonrise/moonset from lunar age and sunrise/sunset times
function getMoonTimes(sunriseISO, sunsetISO, lunarPhase) {
    if (!sunriseISO || !sunsetISO) return { rise: null, set: null };

    const sunrise = new Date(sunriseISO);
    const sunset = new Date(sunsetISO);
    const sunriseMs = sunrise.getTime();

    // Moon rises ~50 min later each day. At new moon, rises near sunrise.
    // Offset moonrise by (phase * 24h) from sunrise
    const offsetMs = lunarPhase * 24 * 60 * 60 * 1000;
    const moonriseMs = sunriseMs + offsetMs;

    // Moon is above horizon ~12h on average (varies by latitude, but good approx)
    const moonsetMs = moonriseMs + 12 * 60 * 60 * 1000;

    const fmt = (d) => new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    return { rise: fmt(moonriseMs), set: fmt(moonsetMs) };
}
