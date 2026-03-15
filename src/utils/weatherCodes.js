// WMO Weather Code lookup table — icons reference Meteocon SVG filenames
// Day/night variants: iconNight is only present when different from icon.
const WEATHER_CODES = {
    0:  { desc: 'Clear sky',              icon: 'clear-day',           iconNight: 'clear-night' },
    1:  { desc: 'Mainly clear',           icon: 'clear-day',           iconNight: 'clear-night' },
    2:  { desc: 'Partly cloudy',          icon: 'partly-cloudy-day',   iconNight: 'partly-cloudy-night' },
    3:  { desc: 'Overcast',               icon: 'overcast-day',        iconNight: 'overcast-night' },
    45: { desc: 'Foggy',                  icon: 'fog-day',             iconNight: 'fog-night' },
    48: { desc: 'Rime fog',               icon: 'fog-day',             iconNight: 'fog-night' },
    51: { desc: 'Light drizzle',          icon: 'drizzle' },
    53: { desc: 'Moderate drizzle',       icon: 'drizzle' },
    55: { desc: 'Dense drizzle',          icon: 'rain' },
    56: { desc: 'Light freezing drizzle', icon: 'sleet' },
    57: { desc: 'Heavy freezing drizzle', icon: 'sleet' },
    61: { desc: 'Slight rain',            icon: 'rain' },
    63: { desc: 'Moderate rain',          icon: 'rain' },
    65: { desc: 'Heavy rain',             icon: 'rain' },
    66: { desc: 'Light freezing rain',    icon: 'sleet' },
    67: { desc: 'Heavy freezing rain',    icon: 'sleet' },
    71: { desc: 'Slight snow',            icon: 'snow' },
    73: { desc: 'Moderate snow',          icon: 'snow' },
    75: { desc: 'Heavy snow',             icon: 'snow' },
    77: { desc: 'Snow grains',            icon: 'snow' },
    80: { desc: 'Slight rain showers',    icon: 'drizzle' },
    81: { desc: 'Moderate rain showers',  icon: 'rain' },
    82: { desc: 'Violent rain showers',   icon: 'thunderstorms-day-rain', iconNight: 'thunderstorms-night-rain' },
    85: { desc: 'Slight snow showers',    icon: 'snow' },
    86: { desc: 'Heavy snow showers',     icon: 'snow' },
    95: { desc: 'Thunderstorm',           icon: 'thunderstorms-day-rain', iconNight: 'thunderstorms-night-rain' },
    96: { desc: 'Thunderstorm with hail', icon: 'hail' },
    99: { desc: 'Thunderstorm with heavy hail', icon: 'hail' }
};

// Day→Night icon name swap for METAR-sourced icons (which default to day).
const _NIGHT_MAP = {
    'clear-day': 'clear-night',
    'partly-cloudy-day': 'partly-cloudy-night',
    'overcast-day': 'overcast-night',
    'fog-day': 'fog-night',
    'thunderstorms-day-rain': 'thunderstorms-night-rain'
};

// Look up a WMO weather code and return { desc, icon }.
// Returns an 'Unknown' sentinel when the code is missing or unrecognized.
function getWeatherInfo(code) {
    if (code === undefined || code === null) {
        console.warn('[WeatherCodes] Missing weather code in payload');
        return { desc: 'Unknown', icon: 'not-available' };
    }
    const info = WEATHER_CODES[String(code)];
    if (!info) {
        console.warn(`[WeatherCodes] Unrecognized weather code: ${code}`);
        return { desc: `Unknown (code: ${code})`, icon: 'not-available' };
    }
    return info;
}

// Resolve the correct icon name for a WMO code, accounting for day/night.
// isDay: true for daytime, false for nighttime.
function getWeatherIcon(code, isDay) {
    const info = WEATHER_CODES[String(code)];
    if (!info) return 'not-available';
    if (!isDay && info.iconNight) return info.iconNight;
    return info.icon;
}

// Swap a day-variant icon name to its night variant (for METAR-sourced icons).
function resolveNightIcon(iconName, isDay) {
    if (isDay) return iconName;
    return _NIGHT_MAP[iconName] || iconName;
}

// Generate an <img> tag for a Meteocon SVG icon.
function weatherIconImg(iconName, cssClass) {
    if (!iconName) return '';
    const cls = cssClass ? ` class="${cssClass}"` : '';
    return `<img src="icons/meteocons/${iconName}.svg" alt=""${cls} loading="lazy">`;
}

// Dev utility — not called at load time.
// Run runWeatherCodeChecks() in the browser console to verify the lookup table.
function runWeatherCodeChecks() {
    const cases = [
        { code: 0,         expect: 'Clear sky' },
        { code: 95,        expect: 'Thunderstorm' },
        { code: 56,        expect: 'Light freezing drizzle' },
        { code: 123,       expectUnknown: true },
        { code: undefined, expectUnknown: true },
        { code: null,      expectUnknown: true },
    ];
    cases.forEach(({ code, expect, expectUnknown }) => {
        const info = getWeatherInfo(code);
        const pass = expectUnknown
            ? info.desc.startsWith('Unknown')
            : info.desc === expect;
        console[pass ? 'log' : 'error'](
            `[WeatherCodes check] code=${code} → "${info.desc}" — ${pass ? 'PASS' : 'FAIL'}`
        );
    });
}
