// Hourly strip — scroll and detail panel
// Globals used: cachedHourlyData, activeHourlyIndex, WEATHER_CODES, getWindDirection

function scrollHourlyStrip(direction) {
    const strip = document.getElementById('hourlyStrip');
    if (strip) {
        strip.scrollBy({ left: direction * 300, behavior: 'smooth' });
    }
}

function toggleHourlyDetail(index) {
    const panel = document.getElementById('hourlyDetailPanel');
    if (!panel || !cachedHourlyData) return;

    const hourly = cachedHourlyData;

    // Tapping the same pill closes the panel
    if (activeHourlyIndex === index) {
        panel.classList.remove('visible');
        activeHourlyIndex = null;
        document.querySelectorAll('.hourly-pill').forEach(p => p.classList.remove('active'));
        return;
    }

    activeHourlyIndex = index;

    document.querySelectorAll('.hourly-pill').forEach(p => p.classList.remove('active'));
    const activePill = document.querySelector(`.hourly-pill[data-hourly-index="${index}"]`);
    if (activePill) activePill.classList.add('active');

    const isNow = !!(cachedCurrentData && index === cachedNowIndex);
    const cur = isNow ? cachedCurrentData : null;

    const time = new Date(hourly.time[index]);
    const code = isNow
        ? (WEATHER_CODES[cachedCurrentData.weather_code] || WEATHER_CODES[0])
        : (WEATHER_CODES[hourly.weather_code[index]] || WEATHER_CODES[0]);
    const timeStr = isNow
        ? 'Now'
        : time.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });

    panel.innerHTML = `
        <div class="hourly-detail-header">
            <div class="hourly-detail-title">${code.icon} ${timeStr} — ${code.desc}</div>
            <button class="hourly-detail-close" onclick="toggleHourlyDetail(${index})">×</button>
        </div>
        <div class="hourly-detail-grid">
            <div class="hourly-detail-item">
                <div class="hourly-detail-label">Temperature</div>
                <div class="hourly-detail-value">${Math.round(isNow ? cur.temperature_2m : hourly.temperature_2m[index])}°F</div>
            </div>
            <div class="hourly-detail-item">
                <div class="hourly-detail-label">Feels Like</div>
                <div class="hourly-detail-value">${Math.round(isNow ? cur.apparent_temperature : hourly.apparent_temperature[index])}°F</div>
            </div>
            <div class="hourly-detail-item">
                <div class="hourly-detail-label">Humidity</div>
                <div class="hourly-detail-value">${isNow ? cur.relative_humidity_2m : hourly.relative_humidity_2m[index]}%</div>
            </div>
            <div class="hourly-detail-item">
                <div class="hourly-detail-label">Dew Point</div>
                <div class="hourly-detail-value">${Math.round(isNow ? cur.dew_point_2m : hourly.dew_point_2m[index])}°F</div>
            </div>
            <div class="hourly-detail-item">
                <div class="hourly-detail-label">Wind</div>
                <div class="hourly-detail-value">${Math.round(isNow ? cur.wind_speed_10m : hourly.wind_speed_10m[index])} mph ${getWindDirection(isNow ? cur.wind_direction_10m : hourly.wind_direction_10m[index])}</div>
            </div>
            <div class="hourly-detail-item">
                <div class="hourly-detail-label">Gusts</div>
                <div class="hourly-detail-value">${Math.round(isNow ? cur.wind_gusts_10m : hourly.wind_gusts_10m[index])} mph</div>
            </div>
            <div class="hourly-detail-item">
                <div class="hourly-detail-label">Precip Chance</div>
                <div class="hourly-detail-value">${hourly.precipitation_probability[index] || 0}%</div>
            </div>
            <div class="hourly-detail-item">
                <div class="hourly-detail-label">Precipitation</div>
                <div class="hourly-detail-value">${(() => {
                    const amt = (isNow ? cur.precipitation : hourly.precipitation[index]) || 0;
                    const snow = hourly.snowfall[index] || 0;
                    const intensity = getPrecipIntensity(amt, snow);
                    const label = intensity.label ? ` <span class="precip-intensity-label">\u00b7 ${intensity.label}</span>` : '';
                    return `${amt.toFixed(2)} in${label}`;
                })()}</div>
            </div>
            <div class="hourly-detail-item">
                <div class="hourly-detail-label">Cloud Cover</div>
                <div class="hourly-detail-value">${isNow ? cur.cloud_cover : hourly.cloud_cover[index]}%</div>
            </div>
            <div class="hourly-detail-item">
                <div class="hourly-detail-label">UV Index</div>
                <div class="hourly-detail-value">${(isNow ? cur.uv_index : hourly.uv_index[index]).toFixed(1)}</div>
            </div>
        </div>
    `;

    panel.classList.add('visible');

    setTimeout(() => {
        panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 100);
}
