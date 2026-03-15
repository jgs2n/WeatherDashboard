// Derive daily forecast icons from hourly data instead of Open-Meteo's worst-case daily weather_code.
// Uses daytime hours only, with precip overrides and mode-based sky scoring.

const THUNDER_CODES = new Set([95, 96, 99]);
const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);
const RAIN_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82]);
const FOG_CODES = new Set([45, 48]);
const PRECIP_THRESHOLD = 0.05; // inches

function deriveDailyIcons(hourly, daily) {
    if (!hourly || !daily || !hourly.time || !daily.time) return [];

    const result = [];
    for (let d = 0; d < daily.time.length; d++) {
        const dayDate = daily.time[d]; // "YYYY-MM-DD"

        // Collect daytime hourly indices for this day
        const dayHours = [];
        for (let h = 0; h < hourly.time.length; h++) {
            if (hourly.time[h].startsWith(dayDate) && hourly.is_day && hourly.is_day[h] === 1) {
                dayHours.push(h);
            }
        }

        // No hourly coverage → null (caller falls back to daily.weather_code)
        if (dayHours.length === 0) {
            result.push(null);
            continue;
        }

        const codes = dayHours.map(h => hourly.weather_code[h]);
        const precips = dayHours.map(h => hourly.precipitation[h] || 0);
        const precipProbs = dayHours.map(h => hourly.precipitation_probability[h] || 0);
        const totalPrecip = precips.reduce((a, b) => a + b, 0);

        // --- Precip overrides (highest priority wins) ---
        const thunderCount = codes.filter(c => THUNDER_CODES.has(c)).length;
        if (thunderCount >= 2 || (thunderCount >= 1 && totalPrecip >= PRECIP_THRESHOLD)) {
            result.push(getWeatherInfo(95));
            continue;
        }

        const snowCount = codes.filter(c => SNOW_CODES.has(c)).length;
        const rainCount = codes.filter(c => RAIN_CODES.has(c)).length;

        // --- Sleet / rain+snow mix detection ---
        // When both rain and snow have meaningful accumulation, show sleet icon
        const dailyPrecip = daily.precipitation_sum ? daily.precipitation_sum[d] : 0;
        const dailySnowfall = daily.snowfall_sum ? daily.snowfall_sum[d] : 0;
        const dailySnowInches = dailySnowfall > 0 ? dailySnowfall / 2.54 : 0;

        if (snowCount >= 1 && rainCount >= 1
            && dailyPrecip >= PRECIP_THRESHOLD
            && dailySnowInches >= PRECIP_THRESHOLD) {
            result.push({ desc: 'Rain/Snow Mix', icon: 'sleet' });
            continue;
        }

        // Pure snow — only if snow codes dominate and rain accumulation is negligible
        if (snowCount >= 2 && dailyPrecip < PRECIP_THRESHOLD) {
            result.push(getWeatherInfo(73));
            continue;
        }
        const highProbHours = precipProbs.filter(p => p >= 50).length;
        // Rain codes alone aren't enough — require meaningful accumulation or high probability
        if ((rainCount >= 3 && totalPrecip >= PRECIP_THRESHOLD) || highProbHours >= 2 || totalPrecip >= PRECIP_THRESHOLD) {
            // Distinguish showers vs steady rain by most common rain code
            const rainCodes = codes.filter(c => RAIN_CODES.has(c));
            const hasShowers = rainCodes.some(c => c >= 80 && c <= 82);
            const hasDrizzle = rainCodes.every(c => c >= 51 && c <= 57);
            if (hasDrizzle && rainCodes.length > 0) {
                result.push(getWeatherInfo(51)); // light drizzle
            } else if (hasShowers && rainCount <= 4) {
                result.push(getWeatherInfo(80)); // slight rain showers
            } else {
                result.push(getWeatherInfo(61)); // slight rain
            }
            continue;
        }

        const fogCount = codes.filter(c => FOG_CODES.has(c)).length;
        if (fogCount >= 3) {
            result.push(getWeatherInfo(45));
            continue;
        }

        // --- Sky-state scoring (daytime only, no precip) ---
        // Four buckets: Clear (WMO 0), Mainly Clear (WMO 1), Partly Cloudy (WMO 2),
        // Cloudy (WMO 3 + leftover precip codes that didn't meet override thresholds)
        let clearCount = 0;        // WMO 0
        let mainlyClearCount = 0;  // WMO 1
        let partlyCount = 0;       // WMO 2
        let cloudyCount = 0;       // WMO 3 + any leftover precip codes

        for (const c of codes) {
            if (c === 0) clearCount++;
            else if (c === 1) mainlyClearCount++;
            else if (c === 2) partlyCount++;
            else cloudyCount++;
        }

        // Cloudy must win by >=2 margin to show cloudy icon
        const bestNonCloudy = Math.max(clearCount, mainlyClearCount, partlyCount);
        if (cloudyCount > bestNonCloudy + 2) {
            result.push(getWeatherInfo(3));
        } else if (partlyCount >= clearCount && partlyCount >= mainlyClearCount && partlyCount >= cloudyCount) {
            result.push(getWeatherInfo(2));
        } else if (mainlyClearCount >= clearCount && mainlyClearCount >= partlyCount && mainlyClearCount >= cloudyCount) {
            result.push(getWeatherInfo(1));
        } else if (clearCount >= mainlyClearCount && clearCount >= partlyCount && clearCount >= cloudyCount) {
            result.push(getWeatherInfo(0));
        } else {
            // Mixed — bias toward partly cloudy
            result.push(getWeatherInfo(2));
        }
    }
    return result;
}

// Derive nightly icons — only returns non-null for "notable" nights
// (precip, storms, snow, fog). Clear/cloudy nights return null.
function deriveNightlyIcons(hourly, daily) {
    if (!hourly || !daily || !hourly.time || !daily.time) return [];

    const result = [];
    for (let d = 0; d < daily.time.length; d++) {
        const dayDate = daily.time[d];

        // Collect nighttime hourly indices for this day
        const nightHours = [];
        for (let h = 0; h < hourly.time.length; h++) {
            if (hourly.time[h].startsWith(dayDate) && hourly.is_day && hourly.is_day[h] === 0) {
                nightHours.push(h);
            }
        }

        if (nightHours.length === 0) {
            result.push(null);
            continue;
        }

        const codes = nightHours.map(h => hourly.weather_code[h]);
        const precips = nightHours.map(h => hourly.precipitation[h] || 0);
        const precipProbs = nightHours.map(h => hourly.precipitation_probability[h] || 0);
        const totalPrecip = precips.reduce((a, b) => a + b, 0);

        // --- Precip overrides only — sky-state returns null ---
        const thunderCount = codes.filter(c => THUNDER_CODES.has(c)).length;
        if (thunderCount >= 2 || (thunderCount >= 1 && totalPrecip >= PRECIP_THRESHOLD)) {
            result.push({ desc: 'Thunderstorm', icon: getWeatherIcon(95, false) });
            continue;
        }

        const snowCount = codes.filter(c => SNOW_CODES.has(c)).length;
        const rainCount = codes.filter(c => RAIN_CODES.has(c)).length;

        const dailyPrecip = daily.precipitation_sum ? daily.precipitation_sum[d] : 0;
        const dailySnowfall = daily.snowfall_sum ? daily.snowfall_sum[d] : 0;
        const dailySnowInches = dailySnowfall > 0 ? dailySnowfall / 2.54 : 0;

        if (snowCount >= 1 && rainCount >= 1
            && dailyPrecip >= PRECIP_THRESHOLD
            && dailySnowInches >= PRECIP_THRESHOLD) {
            result.push({ desc: 'Rain/Snow Mix', icon: 'sleet' });
            continue;
        }

        if (snowCount >= 2 && dailyPrecip < PRECIP_THRESHOLD) {
            result.push({ desc: 'Snow', icon: getWeatherIcon(73, false) });
            continue;
        }

        const highProbHours = precipProbs.filter(p => p >= 50).length;
        if ((rainCount >= 3 && totalPrecip >= PRECIP_THRESHOLD) || highProbHours >= 2 || totalPrecip >= PRECIP_THRESHOLD) {
            const rainCodes = codes.filter(c => RAIN_CODES.has(c));
            const hasDrizzle = rainCodes.every(c => c >= 51 && c <= 57);
            if (hasDrizzle && rainCodes.length > 0) {
                result.push({ desc: 'Drizzle', icon: getWeatherIcon(51, false) });
            } else {
                result.push({ desc: 'Rain', icon: getWeatherIcon(61, false) });
            }
            continue;
        }

        const fogCount = codes.filter(c => FOG_CODES.has(c)).length;
        if (fogCount >= 3) {
            result.push({ desc: 'Fog', icon: getWeatherIcon(45, false) });
            continue;
        }

        // Sky-state only (clear/partly cloudy/overcast) — not notable
        result.push(null);
    }
    return result;
}
