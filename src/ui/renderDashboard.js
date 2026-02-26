// Dashboard rendering — current card, forecast grid, hourly strip, radar section
// Globals read/written: cachedHourlyData, activeHourlyIndex, forecastDays, cachedAlerts,
//                       nwsShowByDefault, activeRadarView, showForecastTimeline, locationTemps
// Utils: WEATHER_CODES, calculateFireRisk, getPressureTrend, formatSunTime, getWindDirection,
//        getAQICategory, getMoonPhase, getMoonTimes, escapeHTML, extractDisplayName

// ─── Radar / Maps section ───────────────────────────────────────────────────

function cacheLocationTemp(locationName, temp, weatherCode) {
    locationTemps[locationName] = { temp: Math.round(temp), code: weatherCode };
    renderTabs();
}

function switchRadarView(view, location) {
    activeRadarView = view;
    renderRadarSection(location);
}

function toggleForecastTimeline(location) {
    showForecastTimeline = !showForecastTimeline;
    renderRadarSection(location);
}

function getWindyUrl(view, lat, lon) {
    const height = 1000;
    const detail = showForecastTimeline ? 'true' : '';
    const baseUrl = `https://embed.windy.com/embed2.html?lat=${lat}&lon=${lon}&detailLat=${lat}&detailLon=${lon}&width=650&height=${height}&zoom=9&level=surface`;
    const common = `&menu=&message=&marker=&calendar=now&pressure=&type=map&location=coordinates&detail=${detail}&metricWind=mph&metricTemp=%C2%B0F&radarRange=-1`;

    const overlays = {
        radar: '&overlay=radar&product=radar',
        satellite: '&overlay=satellite&product=satellite',
        wind: '&overlay=wind&product=ecmwf',
        temp: '&overlay=temp&product=ecmwf',
        clouds: '&overlay=clouds&product=ecmwf',
        rain: '&overlay=rain&product=ecmwf'
    };

    return baseUrl + overlays[view] + common;
}

function renderRadarSection(location) {
    const radarCard = document.querySelector('.satellite-card');
    if (!radarCard) return;

    const views = [
        { id: 'radar', name: 'Radar', icon: '📡', forecast: false },
        { id: 'satellite', name: 'Satellite', icon: '🛰️', forecast: false },
        { id: 'wind', name: 'Wind', icon: '💨', forecast: true },
        { id: 'temp', name: 'Temperature', icon: '🌡️', forecast: true },
        { id: 'clouds', name: 'Clouds', icon: '☁️', forecast: true },
        { id: 'rain', name: 'Rain', icon: '🌧️', forecast: true }
    ];

    const activeView = views.find(v => v.id === activeRadarView) || views[0];
    const isObservational = !activeView.forecast;

    const tabsHTML = views.map(view => `
        <div class="radar-tab ${activeRadarView === view.id ? 'active' : ''}"
             onclick="switchRadarView('${view.id}', { lat: ${location.lat}, lon: ${location.lon}, name: '${(location.name || '').replace(/'/g, "\\'")}' })">
            <span class="radar-tab-icon">${view.icon}</span>
            ${view.name}
        </div>
    `).join('');

    const timelineHint = isObservational
        ? '<span class="map-hint">⏪ Past data only — drag timeline backward</span>'
        : '<span class="map-hint">⏩ Forecast — drag timeline to see future conditions</span>';

    radarCard.innerHTML = `
        <div class="card-header">
            <div class="card-title">WEATHER MAPS — ${extractDisplayName(location.name)}</div>
            <div class="source-badge">Windy</div>
        </div>
        <div class="radar-tabs">
            ${tabsHTML}
            <div class="forecast-timeline-toggle"
                 onclick="toggleForecastTimeline({ lat: ${location.lat}, lon: ${location.lon}, name: '${(location.name || '').replace(/'/g, "\\'")}' })"
                 title="Toggle hourly forecast detail panel (click hours to navigate)">
                <span class="toggle-icon">${showForecastTimeline ? '📊' : '📈'}</span>
                <span class="toggle-text">${showForecastTimeline ? 'Hide' : 'Show'} Forecast Detail</span>
            </div>
        </div>
        <div style="padding: 0.3rem 0; opacity: 0.6; font-size: 0.7rem;">${timelineHint}</div>
        <div class="satellite-container">
            <iframe
                src="${getWindyUrl(activeRadarView, location.lat, location.lon)}"
                frameborder="0"
                allow="fullscreen; autoplay"
                class="windy-iframe"
                style="width: 100%; height: 1000px; border-radius: 8px;">
            </iframe>
        </div>
    `;
}

// ─── Sub-renderers ───────────────────────────────────────────────────────────

// Current conditions card — returns HTML string, writes cachedAlerts, cachedRecentPrecip
function renderCurrentCard(openMeteo, airQuality, nws, location, locLabel, recentPrecip) {
    const current = openMeteo.current;
    const weatherCode = WEATHER_CODES[current.weather_code] || WEATHER_CODES[0];

    const fireRisk = calculateFireRisk(current.temperature_2m, current.relative_humidity_2m, current.wind_speed_10m);
    const pressureTrend = getPressureTrend(openMeteo.hourly);
    const todaySunrise = openMeteo.daily.sunrise ? formatSunTime(openMeteo.daily.sunrise[0]) : null;
    const todaySunset = openMeteo.daily.sunset ? formatSunTime(openMeteo.daily.sunset[0]) : null;

    let aqiHTML = '';
    cachedAQI = null;
    if (airQuality && airQuality.current && airQuality.current.us_aqi) {
        const aqiCategory = getAQICategory(airQuality.current.us_aqi);
        cachedAQI = { value: Math.round(airQuality.current.us_aqi), ...aqiCategory };
        aqiHTML = `
            <div class="detail-item">
                <div class="detail-label">Air Quality</div>
                <div class="detail-value" style="color: ${aqiCategory.color}">
                    ${aqiCategory.icon} ${Math.round(airQuality.current.us_aqi)}
                </div>
                <div class="detail-label" style="margin-top: 0.2rem; font-size: 0.65rem;">${aqiCategory.level}</div>
            </div>
        `;
    }

    // Recent precipitation spark tile
    let precipHTML = '';
    cachedRecentPrecip = null;
    if (recentPrecip && recentPrecip.fullSeries) {
        cachedRecentPrecip = recentPrecip;
        const rpWindow = parseInt(localStorage.getItem('precipWindow')) || 12;
        const rpSliced = sliceRecentPrecip(recentPrecip, rpWindow);
        if (rpSliced) precipHTML = renderPrecipSpark(rpSliced);
    }

    // Build alert banners and cache alert data
    let alertBannerHTML = '';
    if (nws && nws.alerts && nws.alerts.features && nws.alerts.features.length > 0) {
        const now = new Date();
        cachedAlerts = { active: [], upcoming: [] };

        nws.alerts.features.forEach(alert => {
            const onset = new Date(alert.properties.onset);
            if (onset <= now) {
                cachedAlerts.active.push(alert);
            } else {
                cachedAlerts.upcoming.push(alert);
            }
        });

        const totalCount = cachedAlerts.active.length + cachedAlerts.upcoming.length;

        if (cachedAlerts.active.length > 0) {
            const firstEvent = cachedAlerts.active[0].properties.event;
            const extra = totalCount > 1 ? ` + ${totalCount - 1} more` : '';
            alertBannerHTML += `
                <div class="alert-banner severity-active" onclick="openAlertModal()">
                    <span class="alert-banner-icon">🚨</span>
                    <div class="alert-banner-text">
                        <div class="alert-banner-event">${firstEvent}${extra}</div>
                    </div>
                    <span class="alert-banner-arrow">▸</span>
                </div>
            `;
        } else if (cachedAlerts.upcoming.length > 0) {
            const firstEvent = cachedAlerts.upcoming[0].properties.event;
            const extra = totalCount > 1 ? ` + ${totalCount - 1} more` : '';
            alertBannerHTML += `
                <div class="alert-banner severity-upcoming" onclick="openAlertModal()">
                    <span class="alert-banner-icon">🔔</span>
                    <div class="alert-banner-text">
                        <div class="alert-banner-event">${firstEvent}${extra}</div>
                    </div>
                    <span class="alert-banner-arrow">▸</span>
                </div>
            `;
        }
    } else {
        cachedAlerts = { active: [], upcoming: [] };
    }

    const moon = getMoonPhase();
    const dirClass = moon.direction === '▼' ? 'waning' : '';
    const moonTimes = getMoonTimes(
        openMeteo.daily.sunrise ? openMeteo.daily.sunrise[0] : null,
        openMeteo.daily.sunset ? openMeteo.daily.sunset[0] : null,
        moon.phase
    );

    return `
        <div class="card">
            <div class="card-header">
                <div class="card-title">CURRENT — ${locLabel}</div>
                <div style="display: flex; align-items: center; gap: 0.5rem;">
                    <div class="source-badge">Live</div>
                    <button class="share-btn" onclick="shareCurrentCard()" title="Share current conditions">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>
                            <polyline points="16 6 12 2 8 6"/>
                            <line x1="12" y1="2" x2="12" y2="15"/>
                        </svg>
                    </button>
                </div>
            </div>
            ${alertBannerHTML}
            <div class="weather-main">
                <div class="temperature">${Math.round(current.temperature_2m)}°F</div>
                ${renderWindCompass(current.wind_direction_10m, Math.round(current.wind_speed_10m), Math.round(current.wind_gusts_10m), false, false)}
                <div class="weather-icon-wrap">
                    <div class="weather-icon">${weatherCode.icon}</div>
                    <div class="weather-condition">${weatherCode.desc}</div>
                </div>
            </div>
            <div class="weather-details">
                <!-- Row 2: feels like / humidity / dew point -->
                <div class="detail-item">
                    <div class="detail-label">Feels Like</div>
                    <div class="detail-value">${Math.round(current.apparent_temperature)}°F</div>
                </div>
                <div class="detail-item">
                    <div class="detail-label">Humidity</div>
                    <div class="detail-value">${current.relative_humidity_2m}%</div>
                </div>
                <div class="detail-item">
                    <div class="detail-label">Dew Point</div>
                    <div class="detail-value">${Math.round(current.dew_point_2m)}°F</div>
                </div>
                <!-- Row 3: pressure / uv / aqi -->
                <div class="detail-item pressure-btn" onclick="openPressureChart(cachedHourlyData)" title="View pressure history">
                    <div class="detail-label">Pressure</div>
                    <div class="detail-value">${Math.round(current.pressure_msl)} hPa ${pressureTrend.arrow ? `<span style="color: ${pressureTrend.color}; font-size: 0.85rem;">${pressureTrend.arrow} ${pressureTrend.label}</span>` : ''}</div>
                </div>
                <div class="detail-item">
                    <div class="detail-label">UV Index</div>
                    <div class="detail-value">${current.uv_index.toFixed(1)}</div>
                </div>
                ${aqiHTML}
                <!-- Row 4: sunrise / sunset -->
                ${(todaySunrise || todaySunset) ? `
                <div class="detail-item-paired">
                    <div class="detail-item">
                        <div class="detail-label">Sunrise</div>
                        <div class="detail-value">${todaySunrise || '—'}</div>
                    </div>
                    <div class="detail-item">
                        <div class="detail-label">Sunset</div>
                        <div class="detail-value">${todaySunset || '—'}</div>
                    </div>
                </div>` : ''}
                <!-- Row 6: moonrise / moonset -->
                ${moonTimes.rise ? `
                <div class="detail-item-paired">
                    <div class="detail-item">
                        <div class="detail-label">Moonrise</div>
                        <div class="detail-value">${moonTimes.rise}</div>
                    </div>
                    <div class="detail-item">
                        <div class="detail-label">Moonset</div>
                        <div class="detail-value">${moonTimes.set}</div>
                    </div>
                </div>` : ''}
                <!-- Row 7: moon phase / fire risk -->
                <div class="detail-item-paired">
                    <div class="detail-item">
                        <div class="detail-label">Moon</div>
                        <div class="detail-value">${moon.icon} ${moon.direction ? `<span class="moon-direction ${dirClass}">${moon.direction}</span> ` : ''}${moon.name}</div>
                        <div class="detail-sub">${moon.illumination}% · Day ${moon.lunarAge} of 29.5</div>
                    </div>
                    <div class="detail-item">
                        <div class="detail-label">Fire Risk</div>
                        <div class="detail-value" style="color: ${fireRisk.color}">${fireRisk.icon} ${fireRisk.level}</div>
                    </div>
                </div>
                <!-- Row 8: recent precip (full width) -->
                ${precipHTML}
            </div>
        </div>
    `;
}

// 10-day forecast grid — returns HTML string, writes forecastDays global
function renderForecastGrid(daily, nws, modelComparison, locLabel) {
    // Build model confidence spread for each day
    const modelSpread = [];
    if (modelComparison && modelComparison.daily) {
        const d = modelComparison.daily;
        const maxKeys = Object.keys(d).filter(k => k.startsWith('temperature_2m_max_'));
        const minKeys = Object.keys(d).filter(k => k.startsWith('temperature_2m_min_'));

        const modelLabels = {};
        maxKeys.forEach(k => {
            const suffix = k.replace('temperature_2m_max_', '');
            if (suffix.includes('gfs')) modelLabels[suffix] = 'GFS';
            else if (suffix.includes('ecmwf')) modelLabels[suffix] = 'ECMWF';
            else modelLabels[suffix] = suffix.toUpperCase();
        });

        if (maxKeys.length >= 2 && minKeys.length >= 2) {
            const days = d.time ? d.time.length : 0;
            for (let j = 0; j < days; j++) {
                const highs = maxKeys.map(k => d[k][j]).filter(v => v != null);
                const lows = minKeys.map(k => d[k][j]).filter(v => v != null);

                if (highs.length >= 2 && lows.length >= 2) {
                    const highSpread = Math.abs(Math.max(...highs) - Math.min(...highs));
                    const lowSpread = Math.abs(Math.max(...lows) - Math.min(...lows));

                    const models = maxKeys.map((k, mi) => {
                        const suffix = k.replace('temperature_2m_max_', '');
                        const minKey = minKeys[mi];
                        return {
                            name: modelLabels[suffix] || suffix,
                            high: d[k][j] != null ? Math.round(d[k][j]) : null,
                            low: minKey && d[minKey][j] != null ? Math.round(d[minKey][j]) : null
                        };
                    }).filter(m => m.high != null && m.low != null);

                    modelSpread.push({
                        highMin: Math.round(Math.min(...highs)),
                        highMax: Math.round(Math.max(...highs)),
                        lowMin: Math.round(Math.min(...lows)),
                        lowMax: Math.round(Math.max(...lows)),
                        highSpread: Math.round(highSpread),
                        lowSpread: Math.round(lowSpread),
                        models
                    });
                } else {
                    modelSpread.push(null);
                }
            }
        }
    }

    forecastDays = [];
    // Skip any past days Open-Meteo returns due to past_days=2 in the API call
    const _now = new Date();
    const _todayStr = `${_now.getFullYear()}-${String(_now.getMonth()+1).padStart(2,'0')}-${String(_now.getDate()).padStart(2,'0')}`;
    const startIdx = Math.max(0, daily.time.findIndex(d => d >= _todayStr));
    const hasAnySnow = daily.snowfall_sum
        ? daily.time.slice(startIdx, startIdx + 10).some((_, i) => (daily.snowfall_sum[startIdx + i] || 0) > 0)
        : false;
    const forecastHTML = daily.time.slice(startIdx, startIdx + 10).map((date, i) => {
        const di = startIdx + i; // index into daily arrays (offset by past days)
        const dayCode = WEATHER_CODES[daily.weather_code[di]] || WEATHER_CODES[0];

        const dateParts = date.split('-');
        const year = parseInt(dateParts[0]);
        const month = parseInt(dateParts[1]) - 1;
        const day = parseInt(dateParts[2]);
        const localDate = new Date(year, month, day);

        const dayName = localDate.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
        const fullDayName = localDate.toLocaleDateString('en-US', { weekday: 'long' });
        const dateDisplay = localDate.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });

        const precipProb = daily.precipitation_probability_max[di] || 0;
        const precipAmount = daily.precipitation_sum[di] || 0;
        const snowfall = daily.snowfall_sum ? (daily.snowfall_sum[di] || 0) : 0;
        const windSpeed = Math.round(daily.wind_speed_10m_max[di]);
        const gustSpeed = daily.wind_gusts_10m_max ? Math.round(daily.wind_gusts_10m_max[di]) : null;
        const windDir = getWindDirection(daily.wind_direction_10m_dominant[di]);
        const uvMax = daily.uv_index_max ? Math.round(daily.uv_index_max[di]) : null;

        const bestHigh = Math.round(daily.temperature_2m_max[di]);
        const bestLow = Math.round(daily.temperature_2m_min[di]);
        const spread = modelSpread[i]; // modelSpread has no past_days offset — already today-aligned
        const THRESHOLD = 3;
        const hasSpread = spread && (spread.highSpread > THRESHOLD || spread.lowSpread > THRESHOLD);

        let highDisplay, lowDisplay;
        if (spread && spread.highSpread > THRESHOLD) {
            highDisplay = `${spread.highMin}-${spread.highMax}°`;
        } else {
            highDisplay = `${bestHigh}°`;
        }
        if (spread && spread.lowSpread > THRESHOLD) {
            lowDisplay = `${spread.lowMin}-${spread.lowMax}°`;
        } else {
            lowDisplay = `${bestLow}°`;
        }

        let tooltipData = '';
        if (hasSpread && spread.models && spread.models.length >= 2) {
            tooltipData = spread.models.map(m => `${m.name}: ${m.high}°/${m.low}°`).join(' · ');
        }

        let nwsForecastSection = '';
        if (nws && nws.forecast && nws.forecast.properties.periods) {
            const periods = nws.forecast.properties.periods;
            const matchingPeriods = periods.filter(period => {
                const periodStart = new Date(period.startTime);
                return periodStart.getFullYear() === year &&
                       periodStart.getMonth() === month &&
                       periodStart.getDate() === day;
            });

            if (matchingPeriods.length > 0) {
                nwsForecastSection = `
                    <div class="nws-inline">
                        ${matchingPeriods.map(p => `
                            <div class="nws-inline-period">
                                <span class="nws-inline-name">${p.name}:</span>
                                <span class="nws-inline-text">${p.detailedForecast}</span>
                            </div>
                        `).join('')}
                    </div>
                `;
            } else {
                nwsForecastSection = `
                    <div class="nws-inline">
                        <div class="nws-inline-period nws-no-data">Extended forecast — NWS data unavailable</div>
                    </div>
                `;
            }
        }

        forecastDays.push({
            dayName, fullDayName, dateDisplay,
            icon: dayCode.icon, desc: dayCode.desc,
            high: bestHigh, low: bestLow,
            highDisplay, lowDisplay, hasSpread, tooltipData,
            precipProb, precipAmount, snowfall,
            windSpeed, gustSpeed, windDir, windDegrees: daily.wind_direction_10m_dominant[di], uvMax,
            sunrise: daily.sunrise ? daily.sunrise[di] : null,
            sunset: daily.sunset ? daily.sunset[di] : null,
            nwsPeriods: (nws && nws.forecast && nws.forecast.properties && nws.forecast.properties.periods)
                ? nws.forecast.properties.periods.filter(p => {
                    const s = new Date(p.startTime);
                    return s.getFullYear() === year && s.getMonth() === month && s.getDate() === day;
                  })
                : []
        });

        const rainContent = `💧 ${precipProb}%${precipAmount > 0 ? ` ${precipAmount.toFixed(1)}″` : ''}`;
        const snowContent = hasAnySnow
            ? (snowfall > 0 ? `❄️ ${(snowfall / 2.54).toFixed(1)}″` : '')
            : null;

        return `
            <div class="forecast-item" onclick="openForecastDetail(${i})">
                <div class="forecast-day">${dayName}</div>
                <div class="forecast-date">${dateDisplay}</div>
                <div class="forecast-icon">${dayCode.icon}</div>
                <div class="forecast-temp-range ${hasSpread ? 'has-model-spread' : ''}"
                     ${hasSpread ? `onclick="showModelTooltip(event, '${tooltipData}')" data-tooltip="${tooltipData}"` : ''}>
                    <div class="temp-high">${highDisplay}</div>
                    <div class="temp-low">${lowDisplay}</div>
                </div>
                ${renderWindCompass(daily.wind_direction_10m_dominant[di], windSpeed, gustSpeed, true)}
                <div class="forecast-row precip-row">${rainContent}</div>
                ${snowContent !== null ? `<div class="forecast-row snow-row">${snowContent}</div>` : ''}
                ${nwsForecastSection}
            </div>
        `;
    }).join('');

    return `
        <div class="card forecast-card">
            <div class="card-header">
                <div class="card-title">10-DAY FORECAST — ${locLabel}</div>
                ${nws ? `<label class="nws-toggle"><input type="checkbox" id="nwsCheck" onchange="toggleNWS(this.checked)"><span>NWS</span></label>` : ''}
            </div>
            <div class="forecast-grid">
                ${forecastHTML}
            </div>
        </div>
    `;
}

// 48-hour hourly strip — returns HTML string, writes cachedHourlyData + activeHourlyIndex
function renderHourlyStrip(hourly, current, locLabel) {
    cachedHourlyData = hourly || null;
    cachedCurrentData = current || null;
    activeHourlyIndex = null;

    if (!hourly || !hourly.time) return '';

    const now = new Date();
    const currentHourIndex = hourly.time.findIndex(t => new Date(t) >= now);
    const startIndex = Math.max(0, currentHourIndex);
    cachedNowIndex = startIndex;
    const endIndex = Math.min(startIndex + 48, hourly.time.length);

    let lastDay = '';
    const pills = [];

    for (let i = startIndex; i < endIndex; i++) {
        const time = new Date(hourly.time[i]);
        const isNow = i === startIndex;
        const hourCode = isNow && current
            ? (WEATHER_CODES[current.weather_code] || WEATHER_CODES[0])
            : (WEATHER_CODES[hourly.weather_code[i]] || WEATHER_CODES[0]);
        const temp = isNow && current ? Math.round(current.temperature_2m) : Math.round(hourly.temperature_2m[i]);
        const precip = hourly.precipitation_probability[i] || 0;  // always from hourly
        const wind = isNow && current ? Math.round(current.wind_speed_10m) : Math.round(hourly.wind_speed_10m[i]);
        const gusts = isNow && current ? Math.round(current.wind_gusts_10m) : Math.round(hourly.wind_gusts_10m[i]);
        const windDir = isNow && current ? current.wind_direction_10m : hourly.wind_direction_10m[i];

        const dayLabel = time.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
        if (dayLabel !== lastDay && !isNow) {
            pills.push(`<div class="hourly-day-sep">${dayLabel}</div>`);
            lastDay = dayLabel;
        } else if (isNow) {
            lastDay = dayLabel;
        }

        const timeLabel = isNow ? 'Now' : time.toLocaleTimeString('en-US', { hour: 'numeric' });

        pills.push(`
            <div class="hourly-pill ${isNow ? 'now-pill' : ''}" data-hourly-index="${i}" onclick="toggleHourlyDetail(${i})">
                <span class="hourly-time">${timeLabel}</span>
                <span class="hourly-icon">${hourCode.icon}</span>
                <span class="hourly-temp">${temp}°</span>
                ${precip > 0 ? `<span class="hourly-precip has-precip">💧${precip}%</span>` : `<span class="hourly-precip">&nbsp;</span>`}
                ${renderWindCompass(windDir, wind, gusts, true)}
            </div>
        `);
    }

    return `
        <div class="card hourly-card">
            <div class="card-header">
                <div class="card-title">NEXT 48 HOURS — ${locLabel}</div>
                <div class="source-badge">Hourly</div>
            </div>
            <div class="hourly-strip-wrapper">
                <button class="hourly-scroll-btn scroll-left" onclick="scrollHourlyStrip(-1)">◂</button>
                <div class="hourly-strip" id="hourlyStrip">
                    ${pills.join('')}
                </div>
                <button class="hourly-scroll-btn scroll-right" onclick="scrollHourlyStrip(1)">▸</button>
            </div>
            <div class="hourly-detail-panel" id="hourlyDetailPanel"></div>
        </div>
    `;
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

function renderWeatherDashboard(openMeteo, airQuality, nws, location, modelComparison, recentPrecip) {
    const container = document.getElementById('weatherContainer');
    const locLabel = extractDisplayName(location.name);

    const currentCardHTML = renderCurrentCard(openMeteo, airQuality, nws, location, locLabel, recentPrecip);
    const forecastGridHTML = renderForecastGrid(openMeteo.daily, nws, modelComparison, locLabel);
    const hourlyStripHTML = renderHourlyStrip(openMeteo.hourly, openMeteo.current, locLabel);

    container.innerHTML = `
        <div class="grid">
            ${currentCardHTML}
            ${forecastGridHTML}
        </div>

        ${hourlyStripHTML}

        <div class="card satellite-card">
            <!-- Radar section rendered by renderRadarSection() -->
        </div>

        <div class="timestamp">
            Location: ${location.name}, ${location.country} | <span style="opacity: 0.6;">v${APP_VERSION}</span>
        </div>
    `;

    renderRadarSection(location);
    cacheLocationTemp(location.name, openMeteo.current.temperature_2m, openMeteo.current.weather_code);
    updateRefreshTime();

    // Apply NWS toggle default: on for desktop, off for mobile (unless user set it)
    const nwsDefault = nwsShowByDefault !== null ? nwsShowByDefault : window.innerWidth > 768;
    const forecastCard = document.querySelector('.forecast-card');
    const nwsCheck = document.getElementById('nwsCheck');
    if (forecastCard && nws) {
        forecastCard.classList.toggle('nws-visible', nwsDefault);
        if (nwsCheck) nwsCheck.checked = nwsDefault;
    }

    fetchAllLocationTemps();
}
