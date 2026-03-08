// WMO Weather Code lookup table
const WEATHER_CODES = {
    0: { desc: 'Clear sky', icon: '☀️' },
    1: { desc: 'Mainly clear', icon: '🌤️' },
    2: { desc: 'Partly cloudy', icon: '⛅' },
    3: { desc: 'Overcast', icon: '☁️' },
    45: { desc: 'Foggy', icon: '🌫️' },
    48: { desc: 'Rime fog', icon: '🌫️' },
    51: { desc: 'Light drizzle', icon: '🌦️' },
    53: { desc: 'Moderate drizzle', icon: '🌦️' },
    55: { desc: 'Dense drizzle', icon: '🌧️' },
    56: { desc: 'Light freezing drizzle', icon: '🌧️' },
    57: { desc: 'Heavy freezing drizzle', icon: '🌧️' },
    61: { desc: 'Slight rain', icon: '🌧️' },
    63: { desc: 'Moderate rain', icon: '🌧️' },
    65: { desc: 'Heavy rain', icon: '⛈️' },
    66: { desc: 'Light freezing rain', icon: '🌨️' },
    67: { desc: 'Heavy freezing rain', icon: '🌨️' },
    71: { desc: 'Slight snow', icon: '🌨️' },
    73: { desc: 'Moderate snow', icon: '❄️' },
    75: { desc: 'Heavy snow', icon: '❄️' },
    77: { desc: 'Snow grains', icon: '🌨️' },
    80: { desc: 'Slight rain showers', icon: '🌦️' },
    81: { desc: 'Moderate rain showers', icon: '🌧️' },
    82: { desc: 'Violent rain showers', icon: '⛈️' },
    85: { desc: 'Slight snow showers', icon: '🌨️' },
    86: { desc: 'Heavy snow showers', icon: '❄️' },
    95: { desc: 'Thunderstorm', icon: '⛈️' },
    96: { desc: 'Thunderstorm with hail', icon: '⛈️' },
    99: { desc: 'Thunderstorm with heavy hail', icon: '⛈️' }
};

// Look up a WMO weather code and return { desc, icon }.
// Returns an 'Unknown' sentinel (never Clear sky) when the code is missing or unrecognized.
function getWeatherInfo(code) {
    if (code === undefined || code === null) {
        console.warn('[WeatherCodes] Missing weather code in payload');
        return { desc: 'Unknown', icon: '❓' };
    }
    const info = WEATHER_CODES[String(code)];
    if (!info) {
        console.warn(`[WeatherCodes] Unrecognized weather code: ${code}`);
        return { desc: `Unknown (code: ${code})`, icon: '❓' };
    }
    return info;
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
