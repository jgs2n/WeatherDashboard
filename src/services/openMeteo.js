// Open-Meteo service — all fetch functions return data objects, no DOM

async function fetchForecast(lat, lon) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
        `&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl,cloud_cover,uv_index,dew_point_2m` +
        `&hourly=temperature_2m,relative_humidity_2m,dew_point_2m,apparent_temperature,precipitation_probability,precipitation,snowfall,snow_depth,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,uv_index,pressure_msl` +
        `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,sunrise,sunset,snowfall_sum,uv_index_max` +
        `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=auto&past_days=3&forecast_days=10`;
    const response = await fetch(url);
    return await response.json();
}

async function fetchAirQuality(lat, lon) {
    try {
        const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=us_aqi,pm10,pm2_5&hourly=us_aqi&past_days=3&forecast_days=7&timezone=auto`;
        const response = await fetch(url);
        return await response.json();
    } catch (error) {
        console.error('Air quality fetch error:', error);
        return null;
    }
}

// Fetch GFS + ECMWF daily temps for model confidence comparison
async function fetchModelComparison(lat, lon) {
    try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,temperature_2m_min&models=gfs_seamless,ecmwf_ifs025&temperature_unit=fahrenheit&timezone=auto&forecast_days=10`;
        const response = await fetch(url);
        return await response.json();
    } catch (error) {
        console.error('Model comparison fetch error:', error);
        return null;
    }
}

// Lightweight fetch for tab temperature badges
// Returns { temp, code } or null on error
async function fetchTabTemp(lat, lon) {
    try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&temperature_unit=fahrenheit&timezone=auto`;
        const response = await fetch(url);
        const data = await response.json();
        if (data.current) {
            return {
                temp: Math.round(data.current.temperature_2m),
                code: data.current.weather_code
            };
        }
        return null;
    } catch (error) {
        return null;
    }
}
