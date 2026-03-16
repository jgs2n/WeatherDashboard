// Dashboard rendering — current card, forecast grid, hourly strip, radar section
// Globals read/written: cachedHourlyData, activeHourlyIndex, forecastDays, cachedAlerts,
//                       nwsShowByDefault, activeRadarView, showForecastTimeline, locationTemps,
//                       cachedSPCOutlook
let cachedSPCOutlook = null;
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

// ─── Lightning line helpers ──────────────────────────────────────────────────
// Used by both renderCurrentCard (initial HTML) and updateNowcastDisplay (in-place).

function _lightningLineText(ls) {
    if (!ls || ls.state === 'none') return null;

    // METAR-only fallback wording (lightning WS unavailable)
    if (ls.source === 'metar-fallback') return '\u26A1 Thunder reported nearby';

    if (ls.state === 'active') {
        if (ls.nearestStrikeMi != null && ls.nearestStrikeMi <= 5) {
            const d = Math.max(1, Math.round(ls.nearestStrikeMi));
            return `\u26A1 Lightning within ${d} mi`;
        }
        return '\u26A1 Thunder nearby';
    }
    if (ls.state === 'nearby') return '\u26A1 Thunder nearby';
    if (ls.state === 'approaching') {
        // Motion-aware: "Storm approaching" vs "Distant lightning detected"
        if ((ls.nearestStrikeMi != null && ls.nearestStrikeMi > 15) || ls.confidence === 'low') {
            return '\u26A1 Distant lightning detected';
        }
        if (ls._isApproaching) return '\u26A1 Storm approaching';
        return '\u26A1 Distant lightning detected';
    }
    return null;
}

// Apply lightning state to primary condition text.
// active can promote to Thunderstorm; nearby can modify to "X — thunder nearby";
// approaching never changes primary condition.
function _applyLightningConditionOverride(displayCondition, precipPhenomenon, ls) {
    if (!ls || ls.state === 'none' || ls.state === 'approaching') return displayCondition;
    if (precipPhenomenon === 'thunderstorm') return displayCondition; // already correct

    if (ls.state === 'active') {
        if (precipPhenomenon === 'heavy rain' || precipPhenomenon === 'rain') {
            return { desc: 'Thunderstorm', icon: 'thunderstorms-day-rain' };
        }
        if (precipPhenomenon === 'drizzle') {
            return { desc: 'Rain \u2014 thunder nearby', icon: 'thunderstorms-day-rain' };
        }
        if (precipPhenomenon === 'snow') {
            return { desc: 'Snow \u2014 thunder nearby', icon: 'snow' };
        }
        if (precipPhenomenon === 'dry' && ls.nearestStrikeMi != null && ls.nearestStrikeMi <= 5) {
            return { desc: 'Thunder nearby', icon: 'thunderstorms-day-rain' };
        }
    }

    if (ls.state === 'nearby') {
        if (precipPhenomenon === 'rain' || precipPhenomenon === 'heavy rain' || precipPhenomenon === 'drizzle') {
            return { desc: 'Rain \u2014 thunder nearby', icon: displayCondition.icon };
        }
        if (precipPhenomenon === 'snow') {
            return { desc: 'Snow \u2014 thunder nearby', icon: 'snow' };
        }
    }

    return displayCondition;
}

// ─── Sub-renderers ───────────────────────────────────────────────────────────

// Swap the AQI placeholder with live data after a deferred retry
function updateAQITile(airQuality) {
    const placeholder = document.getElementById('aqi-placeholder');
    if (!placeholder) return;
    if (!airQuality || !airQuality.current || !airQuality.current.us_aqi) {
        placeholder.querySelector('.detail-label:last-child').textContent = 'Unavailable';
        return;
    }
    const aqiCategory = getAQICategory(airQuality.current.us_aqi);
    cachedAQI = { value: Math.round(airQuality.current.us_aqi), ...aqiCategory };
    cachedAQIHourly = (airQuality.hourly && airQuality.hourly.us_aqi) ? airQuality.hourly : null;
    const tile = document.createElement('div');
    tile.className = 'detail-item aqi-btn';
    tile.onclick = () => openAQIChart(cachedAQIHourly);
    tile.title = 'View air quality history';
    tile.innerHTML = `
        <div class="detail-label">Air Quality</div>
        <div class="detail-value" style="color: ${aqiCategory.color}">
            ${aqiCategory.icon} ${Math.round(airQuality.current.us_aqi)}
        </div>
        <div class="detail-label" style="margin-top: 0.2rem; font-size: 0.65rem;">${aqiCategory.level}</div>
    `;
    placeholder.replaceWith(tile);
}

// Current conditions card — returns HTML string, writes cachedAlerts, cachedRecentPrecip
function renderCurrentCard(openMeteo, airQuality, nws, location, locLabel, recentPrecip, nowSummary) {
    const current = openMeteo.current;
    const weatherInfo = getWeatherInfo(current.weather_code);

    // Determine condition to display.
    // Priority: active precipitation (precipStateNow) → sky state (skyState) → model WMO fallback
    let displayCondition, conditionSubtitle;
    const _isWet = nowSummary && nowSummary.precipStateNow && nowSummary.precipStateNow.phenomenon !== 'dry';
    const _sky   = nowSummary && nowSummary.skyState;
    const _trend = nowSummary && nowSummary.precipTrend60m;

    if (_isWet) {
        const ps = nowSummary.precipStateNow;
        displayCondition = { desc: ps.desc, icon: ps.icon };
        const ageMins = metarAgeMinutes(ps.observedAt);
        conditionSubtitle = ageMins < 1 ? 'just now' : `${ageMins}m ago`;
    } else if (_sky) {
        displayCondition = { desc: _sky.desc, icon: _sky.icon };
        const ageMins = metarAgeMinutes(_sky.observedAt);
        conditionSubtitle = _sky.observedAt ? (ageMins < 1 ? 'just now' : `${ageMins}m ago`) : '';
    } else {
        displayCondition = weatherInfo;
        conditionSubtitle = '';
    }

    // Lightning condition override — active/nearby can promote primary condition text
    const _ls = nowSummary && nowSummary.lightningState;
    const _precipPhenomenon = nowSummary && nowSummary.precipStateNow
        ? nowSummary.precipStateNow.phenomenon : 'dry';
    const _preOverrideDesc = displayCondition.desc;
    displayCondition = _applyLightningConditionOverride(displayCondition, _precipPhenomenon, _ls);

    // Build icon rationale — explains why this icon was chosen
    let _rationale = '';
    if (_isWet) {
        const ps = nowSummary.precipStateNow;
        const dbzNote = ps.source === 'NEXRAD' || ps.source === 'RainViewer'
            ? ` (${Math.round(ps.confidence * 100)}% confidence)`
            : '';
        _rationale = `${ps.source} detecting ${ps.desc.toLowerCase()}${dbzNote}.`;
    } else if (_sky) {
        _rationale = `${_sky.source} observing ${_sky.desc.toLowerCase()}.`;
    } else {
        _rationale = `Model forecast (WMO ${current.weather_code}): ${weatherInfo.desc}.`;
    }
    if (displayCondition.desc !== _preOverrideDesc && _ls) {
        _rationale += ` Lightning ${_ls.state} (${_ls.source}) promoted to ${displayCondition.desc}.`;
    }

    // Rain timing and lightning are now rendered in the blue hazard lane

    const fireRisk = calculateFireRisk(current.temperature_2m, current.relative_humidity_2m, current.wind_speed_10m);
    const pressureTrend = getPressureTrend(openMeteo.hourly);
    const todaySunrise = openMeteo.daily.sunrise ? formatSunTime(openMeteo.daily.sunrise[0]) : null;
    const todaySunset = openMeteo.daily.sunset ? formatSunTime(openMeteo.daily.sunset[0]) : null;

    let aqiHTML = '';
    cachedAQI = null;
    cachedAQIHourly = null;
    if (airQuality && airQuality.current && airQuality.current.us_aqi) {
        const aqiCategory = getAQICategory(airQuality.current.us_aqi);
        cachedAQI = { value: Math.round(airQuality.current.us_aqi), ...aqiCategory };
        cachedAQIHourly = (airQuality.hourly && airQuality.hourly.us_aqi) ? airQuality.hourly : null;
        const aqiBtnClass = 'detail-item aqi-btn';
        const aqiClick = ` onclick="openAQIChart(cachedAQIHourly)" title="View air quality history"`;
        aqiHTML = `
            <div class="${aqiBtnClass}"${aqiClick}>
                <div class="detail-label">Air Quality</div>
                <div class="detail-value" style="color: ${aqiCategory.color}">
                    ${aqiCategory.icon} ${Math.round(airQuality.current.us_aqi)}
                </div>
                <div class="detail-label" style="margin-top: 0.2rem; font-size: 0.65rem;">${aqiCategory.level}</div>
            </div>
        `;
    } else {
        aqiHTML = `
            <div class="detail-item" id="aqi-placeholder">
                <div class="detail-label">Air Quality</div>
                <div class="detail-value" style="color: rgba(255,255,255,0.3)">—</div>
                <div class="detail-label" style="margin-top: 0.2rem; font-size: 0.65rem; color: rgba(255,255,255,0.3)">Loading…</div>
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

    // Alert data is populated by updateRedLane in Tier 2
    cachedAlerts = { active: [], upcoming: [] };

    const moon = getMoonPhase();
    const dirClass = moon.direction === '▼' ? 'waning' : '';
    const moonTimes = getMoonTimes(
        openMeteo.daily.sunrise ? openMeteo.daily.sunrise[0] : null,
        openMeteo.daily.sunset ? openMeteo.daily.sunset[0] : null,
        moon.phase
    );

    return `
        <div class="card current-card">
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
            <div class="hazard-panel">
                <div class="hazard-lane lane-red alert-none" id="hazard-red" onclick="openAlertModal()">
                    <div class="lane-label">NWS Alerts</div>
                    <div class="lane-body">
                        <div class="lane-status">None</div>
                    </div>
                    <span class="lane-arrow">▸</span>
                </div>
                <div class="hazard-lane lane-yellow spc-none" id="hazard-yellow" onclick="openForecastRiskModal()">
                    <div class="lane-label">Storm Risk</div>
                    <div class="lane-body">
                        <div class="lane-status">None</div>
                    </div>
                    <span class="lane-arrow">▸</span>
                </div>
                <div class="hazard-lane lane-blue storm-quiet" id="hazard-blue">
                    <div class="lane-label">Storms Nearby</div>
                    <div class="lane-body">
                        <div class="lane-status">Quiet</div>
                        <div class="lane-secondary"></div>
                    </div>
                </div>
            </div>
            <div class="weather-main">
                <div class="temperature">${Math.round(current.temperature_2m)}°F</div>
                ${renderWindCompass(current.wind_direction_10m, Math.round(current.wind_speed_10m), Math.round(current.wind_gusts_10m), false, false)}
                <div class="weather-icon-wrap" onclick="this.querySelector('.nowcast-rationale').classList.toggle('visible')" style="cursor:pointer" title="Tap for icon rationale">
                    <div class="weather-icon">${weatherIconImg(displayCondition.icon, 'condition-icon')}</div>
                    <div class="weather-condition">${displayCondition.desc}</div>
                    <div class="nowcast-subtitle">${conditionSubtitle}</div>
                    <div class="nowcast-rationale">${_rationale}</div>
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
                <!-- Row 4: sunrise / moonrise -->
                <div class="detail-item-paired">
                    <div class="detail-item">
                        <div class="detail-label">Sunrise</div>
                        <div class="detail-value"><span class="time-sunrise">${todaySunrise || '—'}</span></div>
                    </div>
                    <div class="detail-item">
                        <div class="detail-label">Moonrise</div>
                        <div class="detail-value"><span class="time-moonrise">${moonTimes.rise || '—'}</span></div>
                    </div>
                </div>
                <!-- Row 5: sunset / moonset -->
                <div class="detail-item-paired">
                    <div class="detail-item">
                        <div class="detail-label">Sunset</div>
                        <div class="detail-value"><span class="time-sunset">${todaySunset || '—'}</span></div>
                    </div>
                    <div class="detail-item">
                        <div class="detail-label">Moonset</div>
                        <div class="detail-value"><span class="time-moonset">${moonTimes.set || '—'}</span></div>
                    </div>
                </div>
                <!-- Row 6: fire risk / moon phase -->
                <div class="detail-item-paired">
                    <div class="detail-item">
                        <div class="detail-label">Fire Risk</div>
                        <div class="detail-value" style="color: ${fireRisk.color}">${fireRisk.icon} ${fireRisk.level}</div>
                    </div>
                    <div class="detail-item">
                        <div class="detail-label">Moon</div>
                        <div class="detail-value">${moon.icon} ${moon.direction ? `<span class="moon-direction ${dirClass}">${moon.direction}</span> ` : ''}${moon.name}</div>
                        <div class="detail-sub">${moon.illumination}% · Day ${moon.lunarAge} of 29.5</div>
                    </div>
                </div>
                <!-- Row 8: recent precip (full width) -->
                ${precipHTML}
            </div>
        </div>
    `;
}

// 10-day forecast grid — returns HTML string, writes forecastDays global
function renderForecastGrid(daily, derivedIcons, derivedNightIcons, nws, modelComparison, locLabel) {
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
        ? daily.time.slice(startIdx, startIdx + 7).some((_, i) => (daily.snowfall_sum[startIdx + i] || 0) > 0)
        : false;
    const forecastHTML = daily.time.slice(startIdx, startIdx + 7).map((date, i) => {
        const di = startIdx + i; // index into daily arrays (offset by past days)
        const dayInfo = (derivedIcons && derivedIcons[di]) || getWeatherInfo(daily.weather_code[di]);
        const _baseIcon = n => n.replace(/-day\b|-night\b/, '').replace(/^drizzle$/, 'rain');
        const _rawNight = derivedNightIcons ? derivedNightIcons[di] : null;
        const nightInfo = (_rawNight && _baseIcon(_rawNight.icon) !== _baseIcon(dayInfo.icon)) ? _rawNight : null;

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
            icon: dayInfo.icon, desc: dayInfo.desc,
            nightIcon: nightInfo ? nightInfo.icon : null,
            nightDesc: nightInfo ? nightInfo.desc : null,
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
                <div class="forecast-icon${nightInfo ? ' forecast-icon-duo' : ''}">${weatherIconImg(dayInfo.icon, 'forecast-icon-img')}${nightInfo ? `<span class="night-icon-pill">${weatherIconImg(nightInfo.icon, 'forecast-night-icon')}</span>` : ''}</div>
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
                <div class="card-title">7-DAY FORECAST — ${locLabel}</div>
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
        const hourCode = isNow && current ? current.weather_code : hourly.weather_code[i];
        const hourIsDay = hourly.is_day[i] === 1;
        const hourIconName = getWeatherIcon(hourCode, hourIsDay);
        const hourInfo = getWeatherInfo(hourCode);
        const temp = isNow && current ? Math.round(current.temperature_2m) : Math.round(hourly.temperature_2m[i]);
        const precip = hourly.precipitation_probability[i] || 0;  // always from hourly
        const precipAmt = hourly.precipitation[i] || 0;
        const snowAmt = hourly.snowfall[i] || 0;
        const precipIntensity = getPrecipIntensity(precipAmt, snowAmt);
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
                <span class="hourly-icon">${weatherIconImg(hourIconName, 'hourly-icon-img')}</span>
                <span class="hourly-temp">${temp}°</span>
                ${precip > 0 ? `<span class="hourly-precip has-precip${precipIntensity.type !== 'none' ? ` precip-${precipIntensity.type}-${precipIntensity.level}` : ''}">${precipIntensity.type === 'snow' ? '❄️' : '💧'}${precip}%</span>` : `<span class="hourly-precip">&nbsp;</span>`}
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

// ─── Lazy radar loading ──────────────────────────────────────────────────────

function lazyLoadRadar(location) {
    const radarCard = document.querySelector('.satellite-card');
    if (!radarCard) return;

    radarCard.innerHTML = `
        <div class="card-header">
            <div class="card-title">WEATHER MAPS — ${extractDisplayName(location.name)}</div>
            <div class="source-badge">Windy</div>
        </div>
        <div class="skeleton-block skeleton-map"></div>
    `;

    if ('IntersectionObserver' in window) {
        const observer = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting) {
                observer.disconnect();
                renderRadarSection(location);
            }
        }, { rootMargin: '200px' });
        observer.observe(radarCard);
    } else {
        setTimeout(() => renderRadarSection(location), 2000);
    }
}

// ─── Tier 2 in-place updaters ────────────────────────────────────────────────

// ─── Hazard lane updaters ────────────────────────────────────────────────────

const _CRITICAL_EVENTS = [
    'Tornado Warning', 'Flash Flood Warning', 'Extreme Wind Warning',
    'Storm Surge Warning', 'Tsunami Warning', 'Hurricane Warning'
];

function _classifyAlert(event) {
    const e = event || '';
    if (_CRITICAL_EVENTS.some(c => e.includes(c))) return 'alert-critical';
    if (e.includes('Warning')) return 'alert-warning';
    if (e.includes('Watch'))   return 'alert-watch';
    return 'alert-advisory';
}

const _ALERT_PRIORITY = { 'alert-critical': 4, 'alert-warning': 3, 'alert-watch': 2, 'alert-advisory': 1 };

function updateRedLane(nws) {
    const lane = document.getElementById('hazard-red');
    if (!lane) return;

    // Parse alerts
    if (nws && nws.alerts && nws.alerts.features && nws.alerts.features.length > 0) {
        const now = new Date();
        cachedAlerts = { active: [], upcoming: [] };
        nws.alerts.features.forEach(a => {
            const onset = new Date(a.properties.onset);
            if (onset <= now) cachedAlerts.active.push(a);
            else cachedAlerts.upcoming.push(a);
        });
    } else {
        cachedAlerts = { active: [], upcoming: [] };
    }

    const allAlerts = [...cachedAlerts.active, ...cachedAlerts.upcoming];
    // Reset classes
    lane.className = 'hazard-lane lane-red';

    if (allAlerts.length === 0) {
        lane.classList.add('alert-none');
        lane.querySelector('.lane-status').textContent = 'None';
        return;
    }

    // Find highest priority alert
    let bestAlert = allAlerts[0];
    let bestClass = _classifyAlert(bestAlert.properties.event);
    for (let i = 1; i < allAlerts.length; i++) {
        const cls = _classifyAlert(allAlerts[i].properties.event);
        if ((_ALERT_PRIORITY[cls] || 0) > (_ALERT_PRIORITY[bestClass] || 0)) {
            bestAlert = allAlerts[i]; bestClass = cls;
        }
    }

    lane.classList.add(bestClass);
    const title = allAlerts.length === 1 ? bestAlert.properties.event : `${allAlerts.length} NWS Alerts`;
    // Append time period for the highest-priority alert
    const expires = bestAlert.properties.expires || bestAlert.properties.ends;
    let timeText = '';
    if (expires) {
        const exp = new Date(expires);
        if (!isNaN(exp)) {
            timeText = 'through ' + exp.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) +
                ' ' + exp.toLocaleDateString([], { weekday: 'short' });
        }
    }
    const statusEl = lane.querySelector('.lane-status');
    statusEl.textContent = title;
    if (timeText) {
        const sub = document.createElement('div');
        sub.className = 'lane-sub';
        sub.textContent = timeText;
        statusEl.appendChild(sub);
    }
}

function updateYellowLane(spcData) {
    const lane = document.getElementById('hazard-yellow');
    if (!lane) return;

    lane.className = 'hazard-lane lane-yellow';

    if (!spcData) {
        lane.classList.add('spc-none');
        lane.querySelector('.lane-status').textContent = 'None';
        return;
    }

    cachedSPCOutlook = spcData;
    const classMap = { MRGL: 'spc-mrgl', SLGT: 'spc-slgt', ENH: 'spc-enh', MDT: 'spc-mdt', HIGH: 'spc-high' };
    lane.classList.add(classMap[spcData.category] || 'spc-none');

    const statusEl = lane.querySelector('.lane-status');
    statusEl.textContent = spcData.label;
    if (spcData.expire) {
        const m = spcData.expire.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/);
        if (m) {
            const exp = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
            const sub = document.createElement('div');
            sub.className = 'lane-sub';
            sub.textContent = 'through ' + exp.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) +
                ' ' + exp.toLocaleDateString([], { weekday: 'short' });
            statusEl.appendChild(sub);
        }
    }
}

function _deriveBlueLaneState(nowSummary) {
    if (!nowSummary) return { cls: 'storm-quiet', status: 'Quiet', secondary: '' };

    const ls = nowSummary.lightningState;
    const ps = nowSummary.precipStateNow;
    const trend = nowSummary.precipTrend60m;
    const isWet = ps && ps.phenomenon !== 'dry';
    const hasTrend = trend && trend.summary;

    // Lightning active within 5mi
    if (ls && ls.state === 'active' && ls.nearestStrikeMi != null && ls.nearestStrikeMi <= 5) {
        const d = Math.max(1, Math.round(ls.nearestStrikeMi));
        return { cls: 'storm-lightning', status: 'Lightning nearby', secondary: `Within ${d} mi` };
    }
    // Lightning active or nearby (>5mi)
    if (ls && (ls.state === 'active' || ls.state === 'nearby')) {
        const sec = hasTrend ? trend.summary : '';
        return { cls: 'storm-nearby', status: 'Storm nearby', secondary: sec };
    }
    // Lightning approaching
    if (ls && ls.state === 'approaching') {
        if (ls._isApproaching) {
            const sec = hasTrend ? trend.summary : '';
            return { cls: 'storm-approaching', status: 'Storm approaching', secondary: sec };
        }
        return { cls: 'storm-nearby', status: 'Distant lightning', secondary: '' };
    }
    // METAR fallback thunderstorm
    if (ls && ls.source === 'metar-fallback') {
        return { cls: 'storm-nearby', status: 'Thunder reported nearby', secondary: '' };
    }
    // Rain with no lightning
    if (isWet) {
        const sec = hasTrend ? trend.summary : '';
        return { cls: 'storm-rain', status: 'Rain nearby', secondary: sec };
    }
    // Trend predicts rain soon but not wet yet
    if (hasTrend) {
        return { cls: 'storm-rain', status: 'Rain expected', secondary: trend.summary };
    }
    return { cls: 'storm-quiet', status: 'Quiet', secondary: '' };
}

function updateBlueLane(nowSummary) {
    const lane = document.getElementById('hazard-blue');
    if (!lane) return;

    const state = _deriveBlueLaneState(nowSummary);
    lane.className = 'hazard-lane lane-blue ' + state.cls;
    lane.querySelector('.lane-status').textContent = state.status;
    const secEl = lane.querySelector('.lane-secondary');
    if (secEl) secEl.textContent = state.secondary;
}

// ─── Hazard lane suppression ─────────────────────────────────────────────────
const _CONVECTIVE_EVENTS = ['Tornado', 'Severe Thunderstorm'];

function _shouldSuppressForecastRisk() {
    // Suppress if a convective NWS watch/warning covers the same hazard
    const allAlerts = [...(cachedAlerts?.active || []), ...(cachedAlerts?.upcoming || [])];
    const hasConvectiveAlert = allAlerts.some(a => {
        const e = a.properties.event || '';
        return _CONVECTIVE_EVENTS.some(c => e.includes(c)) &&
               (e.includes('Warning') || e.includes('Watch'));
    });
    if (hasConvectiveAlert) return true;

    // Suppress if blue lane shows active storm state (storms already here)
    const blue = document.getElementById('hazard-blue');
    if (blue && (blue.classList.contains('storm-lightning') ||
                 blue.classList.contains('storm-nearby') ||
                 blue.classList.contains('storm-approaching'))) {
        return true;
    }

    return false;
}

function _applySuppression() {
    const lane = document.getElementById('hazard-yellow');
    if (!lane) return;
    if (lane.classList.contains('spc-none')) return;
    lane.style.display = _shouldSuppressForecastRisk() ? 'none' : '';
}

function updateNWSForecasts(nws, daily) {
    if (!nws || !nws.forecast || !nws.forecast.properties || !nws.forecast.properties.periods) return;

    const periods = nws.forecast.properties.periods;
    const forecastItems = document.querySelectorAll('.forecast-item');
    if (!forecastItems.length) return;

    const _now = new Date();
    const _todayStr = `${_now.getFullYear()}-${String(_now.getMonth()+1).padStart(2,'0')}-${String(_now.getDate()).padStart(2,'0')}`;
    const startIdx = Math.max(0, daily.time.findIndex(d => d >= _todayStr));

    forecastItems.forEach((item, i) => {
        const di = startIdx + i;
        if (di >= daily.time.length) return;

        const date = daily.time[di];
        const dateParts = date.split('-');
        const year = parseInt(dateParts[0]);
        const month = parseInt(dateParts[1]) - 1;
        const day = parseInt(dateParts[2]);

        const matchingPeriods = periods.filter(period => {
            const ps = new Date(period.startTime);
            return ps.getFullYear() === year && ps.getMonth() === month && ps.getDate() === day;
        });

        if (matchingPeriods.length > 0) {
            const nwsHTML = `<div class="nws-inline">${matchingPeriods.map(p =>
                `<div class="nws-inline-period"><span class="nws-inline-name">${p.name}:</span><span class="nws-inline-text">${p.detailedForecast}</span></div>`
            ).join('')}</div>`;
            item.insertAdjacentHTML('beforeend', nwsHTML);
        } else {
            item.insertAdjacentHTML('beforeend', `<div class="nws-inline"><div class="nws-inline-period nws-no-data">Extended forecast — NWS data unavailable</div></div>`);
        }

        // Update forecastDays for detail modal
        if (forecastDays[i]) {
            forecastDays[i].nwsPeriods = matchingPeriods;
        }
    });
}

function updateNWSToggle() {
    const forecastCard = document.querySelector('.forecast-card');
    if (!forecastCard || document.getElementById('nwsCheck')) return;

    const cardHeader = forecastCard.querySelector('.card-header');
    if (!cardHeader) return;

    const label = document.createElement('label');
    label.className = 'nws-toggle';
    label.innerHTML = '<input type="checkbox" id="nwsCheck" onchange="toggleNWS(this.checked)"><span>NWS</span>';
    cardHeader.appendChild(label);

    const nwsDefault = nwsShowByDefault !== null ? nwsShowByDefault : window.innerWidth > 768;
    forecastCard.classList.toggle('nws-visible', nwsDefault);
    document.getElementById('nwsCheck').checked = nwsDefault;
}

function updateModelSpread(daily, modelComparison) {
    if (!modelComparison || !modelComparison.daily) return;

    const d = modelComparison.daily;
    const maxKeys = Object.keys(d).filter(k => k.startsWith('temperature_2m_max_'));
    const minKeys = Object.keys(d).filter(k => k.startsWith('temperature_2m_min_'));
    if (maxKeys.length < 2 || minKeys.length < 2) return;

    const modelLabels = {};
    maxKeys.forEach(k => {
        const suffix = k.replace('temperature_2m_max_', '');
        if (suffix.includes('gfs')) modelLabels[suffix] = 'GFS';
        else if (suffix.includes('ecmwf')) modelLabels[suffix] = 'ECMWF';
        else modelLabels[suffix] = suffix.toUpperCase();
    });

    const THRESHOLD = 3;
    const forecastItems = document.querySelectorAll('.forecast-item');
    const days = d.time ? d.time.length : 0;

    for (let j = 0; j < Math.min(days, forecastItems.length); j++) {
        const highs = maxKeys.map(k => d[k][j]).filter(v => v != null);
        const lows = minKeys.map(k => d[k][j]).filter(v => v != null);
        if (highs.length < 2 || lows.length < 2) continue;

        const highSpread = Math.abs(Math.max(...highs) - Math.min(...highs));
        const lowSpread = Math.abs(Math.max(...lows) - Math.min(...lows));
        if (highSpread <= THRESHOLD && lowSpread <= THRESHOLD) continue;

        const tempRange = forecastItems[j].querySelector('.forecast-temp-range');
        if (!tempRange) continue;

        if (highSpread > THRESHOLD) {
            const highEl = tempRange.querySelector('.temp-high');
            if (highEl) highEl.textContent = `${Math.round(Math.min(...highs))}-${Math.round(Math.max(...highs))}°`;
        }
        if (lowSpread > THRESHOLD) {
            const lowEl = tempRange.querySelector('.temp-low');
            if (lowEl) lowEl.textContent = `${Math.round(Math.min(...lows))}-${Math.round(Math.max(...lows))}°`;
        }

        const models = maxKeys.map((k, mi) => {
            const suffix = k.replace('temperature_2m_max_', '');
            return { name: modelLabels[suffix], high: Math.round(d[k][j]), low: minKeys[mi] && d[minKeys[mi]][j] != null ? Math.round(d[minKeys[mi]][j]) : null };
        }).filter(m => m.high != null && m.low != null);

        const tooltipData = models.map(m => `${m.name}: ${m.high}\u00B0/${m.low}\u00B0`).join(' \u00B7 ');
        tempRange.classList.add('has-model-spread');
        tempRange.setAttribute('data-tooltip', tooltipData);
        tempRange.onclick = (event) => showModelTooltip(event, tooltipData);

        if (forecastDays[j]) {
            if (highSpread > THRESHOLD) forecastDays[j].highDisplay = `${Math.round(Math.min(...highs))}-${Math.round(Math.max(...highs))}\u00B0`;
            if (lowSpread > THRESHOLD) forecastDays[j].lowDisplay = `${Math.round(Math.min(...lows))}-${Math.round(Math.max(...lows))}\u00B0`;
            forecastDays[j].hasSpread = true;
            forecastDays[j].tooltipData = tooltipData;
        }
    }
}

function updateRecentPrecipTile(recentPrecip) {
    if (!recentPrecip || !recentPrecip.fullSeries) return;

    cachedRecentPrecip = recentPrecip;
    const rpWindow = parseInt(localStorage.getItem('precipWindow')) || 12;
    const rpSliced = sliceRecentPrecip(recentPrecip, rpWindow);
    if (!rpSliced) return;

    const precipHTML = renderPrecipSpark(rpSliced);
    if (!precipHTML) return;

    const weatherDetails = document.querySelector('.weather-details');
    if (weatherDetails) weatherDetails.insertAdjacentHTML('beforeend', precipHTML);
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

function renderWeatherDashboard(openMeteo, airQuality, nws, location, modelComparison, recentPrecip, nowSummary) {
    const container = document.getElementById('weatherContainer');
    const locLabel = extractDisplayName(location.name);

    const currentCardHTML = renderCurrentCard(openMeteo, airQuality, nws, location, locLabel, recentPrecip, nowSummary);
    const derivedIcons = deriveDailyIcons(openMeteo.hourly, openMeteo.daily);
    const derivedNightIcons = deriveNightlyIcons(openMeteo.hourly, openMeteo.daily);
    const forecastGridHTML = renderForecastGrid(openMeteo.daily, derivedIcons, derivedNightIcons, nws, modelComparison, locLabel);
    const hourlyStripHTML = renderHourlyStrip(openMeteo.hourly, openMeteo.current, locLabel);

    const satelliteHTML = `<div class="card satellite-card"><!-- Radar section rendered by renderRadarSection() --></div>`;
    const timestampHTML = `<div class="timestamp">Location: ${location.name}, ${location.country} | <span class="version-link" onclick="openChangelog()">v${APP_VERSION}</span> | <a href="about.html" target="_blank" rel="noopener" class="timestamp-about-link">About</a></div>`;

    // Build section order (mobile-customizable)
    const sectionMap = { hourly: hourlyStripHTML, forecast: forecastGridHTML, satellite: satelliteHTML };
    const orderedSections = sectionOrder
        .filter(key => sectionVisibility[key] !== false)
        .map(key => sectionMap[key] || '').join('\n');

    container.innerHTML = `
        <div class="grid">
            ${currentCardHTML}
            ${orderedSections}
            ${timestampHTML}
        </div>
    `;

    lazyLoadRadar(location);
    cacheLocationTemp(location.name, openMeteo.current.temperature_2m, openMeteo.current.weather_code);
    updateRefreshTime();

    // Apply NWS toggle default if NWS data is already available (Tier 1 render may not have it)
    if (nws) {
        const nwsDefault = nwsShowByDefault !== null ? nwsShowByDefault : window.innerWidth > 768;
        const forecastCard = document.querySelector('.forecast-card');
        const nwsCheck = document.getElementById('nwsCheck');
        if (forecastCard) {
            forecastCard.classList.toggle('nws-visible', nwsDefault);
            if (nwsCheck) nwsCheck.checked = nwsDefault;
        }
    }

    fetchAllLocationTemps();
}

// ─── In-place nowcast update (called by polling, no full re-render) ──────────

function updateNowcastDisplay(nowSummary) {
    if (!nowSummary) return;

    const condEl = document.querySelector('.weather-condition');
    const iconEl = document.querySelector('.weather-icon');
    const subEl  = document.querySelector('.nowcast-subtitle');

    // Primary icon/condition — same priority as renderCurrentCard
    const _isWet = nowSummary.precipStateNow && nowSummary.precipStateNow.phenomenon !== 'dry';
    const _sky   = nowSummary.skyState;
    const _trend = nowSummary.precipTrend60m;

    let _displayDesc = null, _displayIcon = null, _subtitleText = '';
    if (_isWet) {
        const ps = nowSummary.precipStateNow;
        _displayDesc = ps.desc; _displayIcon = ps.icon;
        const age = metarAgeMinutes(ps.observedAt);
        _subtitleText = age < 1 ? 'just now' : `${age}m ago`;
    } else if (_sky) {
        _displayDesc = _sky.desc; _displayIcon = _sky.icon;
        if (_sky.observedAt) {
            const age = metarAgeMinutes(_sky.observedAt);
            _subtitleText = age < 1 ? 'just now' : `${age}m ago`;
        }
    }
    // else: leave icon/desc at model values from initial render (no update)

    // Lightning condition override (same logic as renderCurrentCard)
    const _ls2 = nowSummary.lightningState;
    const _precipPhen = nowSummary.precipStateNow ? nowSummary.precipStateNow.phenomenon : 'dry';
    if (_displayDesc !== null && _ls2) {
        const _overridden = _applyLightningConditionOverride(
            { desc: _displayDesc, icon: _displayIcon }, _precipPhen, _ls2
        );
        _displayDesc = _overridden.desc;
        _displayIcon = _overridden.icon;
    }

    if (_displayDesc !== null) {
        if (condEl) condEl.textContent = _displayDesc;
        if (iconEl) iconEl.innerHTML = weatherIconImg(_displayIcon, 'condition-icon');
    }
    if (subEl) {
        subEl.textContent = _subtitleText;
        subEl.classList.remove('stale');
    }

    // Update rationale text in-place
    const ratEl = document.querySelector('.nowcast-rationale');
    if (ratEl) {
        let rat = '';
        if (_isWet) {
            const ps = nowSummary.precipStateNow;
            const dbzNote = (ps.source === 'NEXRAD' || ps.source === 'RainViewer')
                ? ` (${Math.round(ps.confidence * 100)}% confidence)` : '';
            rat = `${ps.source} detecting ${ps.desc.toLowerCase()}${dbzNote}.`;
        } else if (_sky) {
            rat = `${_sky.source} observing ${_sky.desc.toLowerCase()}.`;
        }
        if (rat && _displayDesc !== _sky?.desc && _displayDesc !== nowSummary.precipStateNow?.desc && _ls2) {
            rat += ` Lightning ${_ls2.state} (${_ls2.source}) promoted to ${_displayDesc}.`;
        }
        if (rat) ratEl.textContent = rat;
    }

    // Update blue hazard lane with lightning/rain/nowcast state
    updateBlueLane(nowSummary);
    _applySuppression();
}

// ─── Condition Detail Modal ───────────────────────────────────────────────────

function openConditionDetail() {
    const overlay = document.getElementById('obsDetailOverlay');
    const body = document.getElementById('obsDetailBody');
    if (!overlay || !body) return;

    const obs = cachedStationObs && cachedStationObs.obs;
    const station = cachedStationObs || null;
    const nc = cachedNowSummary && cachedNowSummary.skyState;

    let html = '<div class="obs-detail">';

    // Station header
    const stId   = station ? station.stationId   : (nc && nc.station ? nc.station.id   : null);
    const stName  = station ? station.stationName  : (nc && nc.station ? nc.station.name : null);
    const stDist  = station ? station.distance_mi  : (nc && nc.station ? nc.station.dist_mi : null);
    if (stId) {
        const distStr = stDist != null ? ` · ${stDist} mi` : '';
        html += `<div class="obs-station">${stId}${stName && stName !== stId ? ' — ' + escapeHTML(stName) : ''}${distStr}</div>`;
    }

    if (obs) {
        const ageMin = metarAgeMinutes(obs.timestamp);
        const ageStr = ageMin < 1 ? 'just now' : ageMin < 60 ? `${ageMin}m ago` : `${Math.round(ageMin / 60)}h ago`;
        html += `<div class="obs-age">Observed ${ageStr}</div>`;

        // Parsed condition
        const cond = parseMetarCondition(obs.presentWeather, obs.textDescription);
        if (cond.desc !== 'Unknown') {
            html += `<div class="obs-cond-label">${weatherIconImg(cond.icon, 'obs-icon-img')} ${cond.desc}</div>`;
        }

        // Data grid
        html += '<div class="obs-grid">';

        if (obs.temperature_c != null) {
            const tempF = Math.round(obs.temperature_c * 9 / 5 + 32);
            html += `<div class="obs-item"><div class="obs-label">Temperature</div><div class="obs-value">${tempF}°F</div></div>`;
        }
        if (obs.humidity != null) {
            html += `<div class="obs-item"><div class="obs-label">Humidity</div><div class="obs-value">${Math.round(obs.humidity)}%</div></div>`;
        }
        if (obs.wind_speed_kmh != null) {
            const windMph  = Math.round(obs.wind_speed_kmh * 0.621371);
            const gustMph  = obs.wind_gust_kmh ? Math.round(obs.wind_gust_kmh * 0.621371) : null;
            const dir      = obs.wind_dir != null ? getWindDirection(obs.wind_dir) : '';
            const gustStr  = gustMph ? ` G${gustMph}` : '';
            html += `<div class="obs-item"><div class="obs-label">Wind</div><div class="obs-value">${dir} ${windMph}${gustStr} mph</div></div>`;
        }
        if (obs.visibility_m != null) {
            const visMi = (obs.visibility_m / 1609.34).toFixed(obs.visibility_m >= 16093 ? 0 : 1);
            html += `<div class="obs-item"><div class="obs-label">Visibility</div><div class="obs-value">${visMi} mi</div></div>`;
        }
        if (obs.pressure_pa != null) {
            const inHg = (obs.pressure_pa / 3386.39).toFixed(2);
            html += `<div class="obs-item"><div class="obs-label">Altimeter</div><div class="obs-value">${inHg} inHg</div></div>`;
        }

        html += '</div>'; // end obs-grid

        // Raw METAR
        if (obs.rawMessage) {
            html += `<div class="obs-metar">${escapeHTML(obs.rawMessage)}</div>`;
        }
    } else if (!stId) {
        html += '<div class="obs-no-data">Station data unavailable for this location.</div>';
    } else {
        html += '<div class="obs-no-data">Observation details unavailable.</div>';
    }

    html += '</div>';
    body.innerHTML = html;
    overlay.classList.add('visible');
    document.body.style.overflow = 'hidden';
}

function closeConditionDetail() {
    const overlay = document.getElementById('obsDetailOverlay');
    if (overlay) overlay.classList.remove('visible');
    document.body.style.overflow = '';
}
