// Weather HQ — main.js
// Bootstrap, event wiring, location management, data fetching orchestration.
// Loaded last in index.html. All dependencies are globals from prior <script> tags.

// Render location tabs
function renderTabs() {
    const tabsContainer = document.getElementById('locationTabs');

    const locationTabs = savedLocations.map((loc, index) => {
        return `
        <div class="location-tab ${activeLocation && activeLocation.name === loc.name ? 'active' : ''}"
             ${!isTouchDevice ? 'draggable="true"' : ''}
             data-index="${index}"
             onclick="${`switchLocation(${index})`}"
             ${!isTouchDevice ? `ondragstart="handleDragStart(event, ${index})"
             ondragover="handleDragOver(event)"
             ondrop="handleDrop(event, ${index})"
             ondragend="handleDragEnd(event)"` : ''}>
            <div class="location-tab-content">
                <span>${loc.displayName}</span>
                ${locationTemps[loc.name] ? `<span class="tab-temp">${(WEATHER_CODES[locationTemps[loc.name].code] || WEATHER_CODES[0]).icon} ${locationTemps[loc.name].temp}°F</span>` : ''}
            </div>
            ${savedLocations.length > 1 ? `<button class="remove-btn" onclick="event.stopPropagation(); confirmRemove(this, ${index})" title="Remove location">×</button>` : ''}
        </div>
    `}).join('');

    const addButton = `<div class="header-btn add-btn" onclick="showAddLocationPrompt()">+ ADD</div>`;

    const editButton = savedLocations.length > 1
        ? `<div class="header-btn edit-btn ${touchDragState.editMode ? 'edit-tab--active' : ''}" id="editTabBtn" onclick="toggleEditMode()">${touchDragState.editMode ? 'DONE' : '✏️ EDIT'}</div>`
        : '';

    document.getElementById('headerActions').innerHTML = addButton + editButton;
    tabsContainer.innerHTML = `<div class="location-tabs-inner">${locationTabs}</div>`;

    // Re-attach long-press listeners on touch devices
    if (isTouchDevice) {
        initTouchReorder();
    }
}

// Fetch current temps for all non-active locations in background
async function fetchAllLocationTemps() {
    for (const loc of savedLocations) {
        if (!loc.lat || !loc.lon) continue;
        if (locationTemps[loc.name]) continue; // already have it
        const result = await fetchTabTemp(loc.lat, loc.lon);
        if (result) {
            locationTemps[loc.name] = result;
            renderTabs();
        } else {
            console.log('Background temp fetch failed for', loc.name);
        }
    }
}

// Update the last refresh timestamp
function updateRefreshTime() {
    lastRefreshTime = new Date();
    const el = document.getElementById('lastUpdated');
    if (el) {
        el.textContent = lastRefreshTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    }
}

// Refresh weather data
function refreshWeather() {
    if (_pendingUpdate) { window.location.reload(); return; }
    if (!activeLocation) return;

    const btn = document.getElementById('refreshBtn');
    if (btn) btn.classList.add('refreshing');

    // Clear cached temps so all get re-fetched
    locationTemps = {};

    const done = () => {
        if (btn) btn.classList.remove('refreshing');
    };

    if (activeLocation.lat && activeLocation.lon) {
        fetchWeatherDataDirect(activeLocation.lat, activeLocation.lon, activeLocation).then(done).catch(done);
    } else {
        fetchWeatherData().then(done).catch(done);
    }
}

// Show Add Location modal — search, GPS, or coordinates
async function showAddLocationPrompt() {
    try {
        const location = await showAddLocationModal();

        const exists = savedLocations.find(loc =>
            loc.lat && Math.abs(loc.lat - location.lat) < 0.01 &&
            loc.lon && Math.abs(loc.lon - location.lon) < 0.01
        );
        if (exists) {
            alert('This location is already saved!');
            return;
        }

        const newLocation = {
            name: location.name,
            displayName: extractDisplayName(location.name),
            lat: location.lat,
            lon: location.lon,
            country: location.country
        };

        savedLocations.push(newLocation);
        activeLocation = newLocation;
        saveLocations();
        renderTabs();
        fetchWeatherDataDirect(location.lat, location.lon, location);
    } catch (error) {
        if (error.message !== 'Location selection cancelled') {
            alert('Error: ' + error.message);
        }
    }
}

// Add a new location
async function addNewLocation(locationName) {
    try {
        const geocodeResult = await geocodeLocation(locationName);
        const location = Array.isArray(geocodeResult)
            ? await showLocationPicker(geocodeResult)
            : geocodeResult;

        // Check if location already exists by coordinates
        const exists = savedLocations.find(loc =>
            loc.lat && Math.abs(loc.lat - location.lat) < 0.01 &&
            loc.lon && Math.abs(loc.lon - location.lon) < 0.01
        );
        if (exists) {
            alert('This location is already saved!');
            return;
        }

        const newLocation = {
            name: location.name,
            displayName: extractDisplayName(location.name),
            lat: location.lat,
            lon: location.lon,
            country: location.country
        };

        savedLocations.push(newLocation);
        activeLocation = newLocation;
        saveLocations();
        renderTabs();
        fetchWeatherDataDirect(location.lat, location.lon, location);
    } catch (error) {
        if (error.message !== 'Location selection cancelled') {
            alert('Error: ' + error.message);
        }
    }
}

// Switch to a different location tab
function switchLocation(index) {
    // Ignore clicks right after a touch drag or long press
    if (touchDragState && touchDragState.prevented) {
        touchDragState.prevented = false;
        return;
    }
    if (touchDragState.editMode) exitEditMode();
    // Stop nowcast polling + lightning WS for old location + reset radar state
    stopNowcastPolling();
    if (typeof stopLightning === 'function') stopLightning();
    if (typeof resetRadarState === 'function') resetRadarState();
    activeLocation = savedLocations[index];
    saveLocations();
    renderTabs();
    // Use stored coordinates directly - no search needed
    fetchWeatherDataDirect(activeLocation.lat, activeLocation.lon, activeLocation);
}

function confirmRemove(btn, index) {
    const loc = savedLocations[index];
    const name = loc ? (loc.displayName || loc.name) : 'this location';
    if (window.confirm(`Remove ${name}?`)) {
        removeLocation(index);
    }
}

function removeLocation(index) {
    const removedLocation = savedLocations[index];
    savedLocations.splice(index, 1);

    // If we removed the active location, switch to the first one or null
    if (activeLocation && activeLocation.name === removedLocation.name) {
        if (savedLocations.length > 0) {
            activeLocation = savedLocations[0];
            if (activeLocation.lat && activeLocation.lon) {
                fetchWeatherDataDirect(activeLocation.lat, activeLocation.lon, activeLocation);
            } else {
                fetchWeatherData();
            }
        } else {
            activeLocation = null;
            init(); // Show welcome screen
        }
    }

    saveLocations();
    renderTabs();
}

// Alert modal management
function openAlertModal() {
    const modal = document.getElementById('alertModal');
    const body = document.getElementById('alertModalBody');

    let html = '';

    if (cachedAlerts.active.length > 0) {
        html += '<div class="modal-section-label">🔴 Active</div>';
        html += cachedAlerts.active.map(a => `
            <div class="modal-alert-item">
                <div class="modal-alert-event">${escapeHTML(a.properties.event)}</div>
                <div class="modal-alert-headline">${escapeHTML(a.properties.headline)}</div>
                <div class="modal-alert-description">${escapeHTML(a.properties.description || 'No additional details.')}</div>
                ${a.properties.instruction ? `<div class="modal-alert-instruction">⚠️ ${escapeHTML(a.properties.instruction)}</div>` : ''}
            </div>
        `).join('');
    }

    if (cachedAlerts.upcoming.length > 0) {
        html += '<div class="modal-section-label">🟡 Upcoming</div>';
        html += cachedAlerts.upcoming.map(a => {
            const onset = new Date(a.properties.onset);
            const onsetStr = onset.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
            return `
                <div class="modal-alert-item upcoming">
                    <div class="modal-alert-event">${escapeHTML(a.properties.event)}</div>
                    <div class="modal-alert-headline">${escapeHTML(a.properties.headline)}</div>
                    <div class="modal-alert-onset">Starts: ${onsetStr}</div>
                    <div class="modal-alert-description">${escapeHTML(a.properties.description || 'No additional details.')}</div>
                    ${a.properties.instruction ? `<div class="modal-alert-instruction">⚠️ ${escapeHTML(a.properties.instruction)}</div>` : ''}
                </div>
            `;
        }).join('');
    }

    body.innerHTML = html;
    modal.classList.add('visible');
    document.body.style.overflow = 'hidden';
}

function closeAlertModal() {
    document.getElementById('alertModal').classList.remove('visible');
    document.body.style.overflow = '';
}

// Toggle NWS inline forecasts visibility
function toggleNWS(checked) {
    const card = document.querySelector('.forecast-card');
    if (card) card.classList.toggle('nws-visible', checked);
    localStorage.setItem('nwsShowByDefault', checked);
    nwsShowByDefault = checked;
}

// ─── Settings modal ──────────────────────────────────────────────────────────

const SECTION_LABELS = { hourly: 'Next 48 Hours', forecast: 'Daily Forecast', satellite: 'Weather Maps' };

function openSettings() {
    const overlay = document.getElementById('settingsOverlay');
    const body = document.getElementById('settingsBody');
    renderSettingsBody(body);
    overlay.classList.add('visible');
    document.body.style.overflow = 'hidden';
}

function closeSettings() {
    document.getElementById('settingsOverlay').classList.remove('visible');
    document.body.style.overflow = '';
}

function renderSettingsBody(body) {
    const order = [...sectionOrder];
    body.innerHTML = `
        <div class="settings-section">
            <div class="settings-section-title">Section Order</div>
            <div class="settings-section-desc">Reorder dashboard sections on mobile</div>
            <div class="settings-reorder-list" id="settingsReorderList">
                ${order.map((key, i) => `
                    <div class="settings-reorder-item" data-key="${key}">
                        <div class="settings-reorder-arrows">
                            <button class="settings-arrow-btn" ${i === 0 ? 'disabled' : ''} onclick="moveSection('${key}', -1)">▲</button>
                            <button class="settings-arrow-btn" ${i === order.length - 1 ? 'disabled' : ''} onclick="moveSection('${key}', 1)">▼</button>
                        </div>
                        <span class="settings-reorder-label">${SECTION_LABELS[key]}</span>
                    </div>
                `).join('')}
            </div>
            <button class="settings-reset-btn" onclick="resetSectionOrder()">Reset to Default</button>
        </div>
    `;
}

function moveSection(key, direction) {
    const order = [...sectionOrder];
    const idx = order.indexOf(key);
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= order.length) return;
    [order[idx], order[newIdx]] = [order[newIdx], order[idx]];
    saveSectionOrder(order);
    renderSettingsBody(document.getElementById('settingsBody'));
    // Re-render dashboard if data is loaded
    if (activeLocation && document.querySelector('.grid')) {
        reRenderDashboardOrder();
    }
}

function resetSectionOrder() {
    saveSectionOrder([...DEFAULT_SECTION_ORDER]);
    renderSettingsBody(document.getElementById('settingsBody'));
    if (activeLocation && document.querySelector('.grid')) {
        reRenderDashboardOrder();
    }
}

function reRenderDashboardOrder() {
    const grid = document.querySelector('.grid');
    if (!grid) return;
    const sections = {
        hourly: grid.querySelector('.hourly-card'),
        forecast: grid.querySelector('.forecast-card'),
        satellite: grid.querySelector('.satellite-card')
    };
    const currentCard = grid.querySelector('.current-card');
    const timestamp = grid.querySelector('.timestamp');
    if (!currentCard) return;
    // Detach all, re-append in order
    const fragment = document.createDocumentFragment();
    fragment.appendChild(currentCard);
    for (const key of sectionOrder) {
        if (sections[key]) fragment.appendChild(sections[key]);
    }
    if (timestamp) fragment.appendChild(timestamp);
    grid.innerHTML = '';
    grid.appendChild(fragment);
}

// Close modals on Escape key
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
        if (document.getElementById('precipChartOverlay').classList.contains('visible')) {
            closePrecipChart();
        } else if (document.getElementById('aqiChartOverlay').classList.contains('visible')) {
            closeAQIChart();
        } else if (document.getElementById('pressureChartOverlay').classList.contains('visible')) {
            closePressureChart();
        } else if (document.getElementById('forecastDetailOverlay').classList.contains('visible')) {
            closeForecastDetail();
        } else if (document.getElementById('obsDetailOverlay') && document.getElementById('obsDetailOverlay').classList.contains('visible')) {
            closeConditionDetail();
        } else if (document.getElementById('settingsOverlay').classList.contains('visible')) {
            closeSettings();
        } else {
            closeAlertModal();
        }
    }
});

// Model comparison tooltip
function showModelTooltip(event, text) {
    event.stopPropagation();
    dismissModelTooltip();

    const tooltip = document.createElement('div');
    tooltip.className = 'model-tooltip';
    tooltip.textContent = text;
    document.body.appendChild(tooltip);

    // Position near the tap
    const rect = event.currentTarget.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();

    let left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
    let top = rect.bottom + 8;

    // Keep on screen
    if (left < 8) left = 8;
    if (left + tooltipRect.width > window.innerWidth - 8) left = window.innerWidth - tooltipRect.width - 8;
    if (top + tooltipRect.height > window.innerHeight - 8) top = rect.top - tooltipRect.height - 8;

    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
    activeTooltip = tooltip;

    // Auto dismiss after 3 seconds
    setTimeout(dismissModelTooltip, 3000);
}

function dismissModelTooltip() {
    if (activeTooltip) {
        activeTooltip.remove();
        activeTooltip = null;
    }
}

// Dismiss tooltip on any outside tap
document.addEventListener('click', dismissModelTooltip);

async function fetchWeatherData() {
    const container = document.getElementById('weatherContainer');
    const previousContent = container.innerHTML;
    container.innerHTML = '<div class="loading"><div class="spinner"></div>Loading weather data...</div>';

    try {
        let locationName = activeLocation ? activeLocation.name : '';

        if (!locationName) {
            throw new Error('No location specified');
        }

        const geocodeResult = await geocodeLocation(locationName);
        const location = Array.isArray(geocodeResult)
            ? await showLocationPicker(geocodeResult)
            : geocodeResult;

        const [openMeteoData, airQualityData, nwsData, modelData, meteostatRaw, nowSummary, nwsObsHistory, stationObs] = await Promise.all([
            fetchForecast(location.lat, location.lon),
            fetchAirQuality(location.lat, location.lon),
            fetchNWS(location.lat, location.lon),
            fetchModelComparison(location.lat, location.lon),
            fetchRecentPrecip(location.lat, location.lon),
            getNowSummary({ lat: location.lat, lon: location.lon, country: location.country }),
            fetchObservationHistory(location.lat, location.lon),
            fetchStationObservation(location.lat, location.lon)
        ]);

        const recentPrecipData = buildRecentPrecip(meteostatRaw, openMeteoData.hourly, openMeteoData.timezone || 'UTC', nwsObsHistory);
        cachedStationObs = stationObs;
        cachedNowSummary = nowSummary;
        saveNowcastState(nowSummary, location.lat, location.lon);
        renderWeatherDashboard(openMeteoData, airQualityData, nwsData, location, modelData, recentPrecipData, nowSummary);

        // Start nowcast polling + lightning WebSocket
        startNowcastPolling(location.lat, location.lon, location.country);
        if (typeof startLightning === 'function') startLightning(location.lat, location.lon);

        // Deferred AQI retry — if the initial fetch failed, try once more after 2s
        if (!airQualityData) {
            setTimeout(async () => {
                try {
                    const retryData = await fetchAirQuality(location.lat, location.lon);
                    if (retryData) updateAQITile(retryData);
                } catch (_) { /* already logged by fetchAirQuality */ }
            }, 2000);
        }
    } catch (error) {
        // If user cancelled location picker, restore previous view
        if (error.message === 'Location selection cancelled') {
            container.innerHTML = previousContent;
            return;
        }
        container.innerHTML = `<div class="card"><div class="alert-title">Error</div><p>${error.message}</p></div>`;
    }
}

// Fetch weather data using coordinates directly (no search/picker)
async function fetchWeatherDataDirect(lat, lon, location) {
    const container = document.getElementById('weatherContainer');
    container.innerHTML = '<div class="loading"><div class="spinner"></div>Loading weather data...</div>';

    try {
        const [openMeteoData, airQualityData, nwsData, modelData, meteostatRaw, nowSummary, nwsObsHistory, stationObs] = await Promise.all([
            fetchForecast(lat, lon),
            fetchAirQuality(lat, lon),
            fetchNWS(lat, lon),
            fetchModelComparison(lat, lon),
            fetchRecentPrecip(lat, lon),
            getNowSummary({ lat, lon, country: location.country }),
            fetchObservationHistory(lat, lon),
            fetchStationObservation(lat, lon)
        ]);

        const recentPrecipData = buildRecentPrecip(meteostatRaw, openMeteoData.hourly, openMeteoData.timezone || 'UTC', nwsObsHistory);
        cachedStationObs = stationObs;
        cachedNowSummary = nowSummary;
        saveNowcastState(nowSummary, lat, lon);
        renderWeatherDashboard(openMeteoData, airQualityData, nwsData, location, modelData, recentPrecipData, nowSummary);

        // Start nowcast polling + lightning WebSocket
        startNowcastPolling(lat, lon, location.country);
        if (typeof startLightning === 'function') startLightning(lat, lon);

        if (!airQualityData) {
            setTimeout(async () => {
                try {
                    const retryData = await fetchAirQuality(lat, lon);
                    if (retryData) updateAQITile(retryData);
                } catch (_) { /* already logged by fetchAirQuality */ }
            }, 2000);
        }
    } catch (error) {
        container.innerHTML = `<div class="card"><div class="alert-title">Error</div><p>${error.message}</p></div>`;
    }
}

// Initialize the dashboard
function init() {
    console.log(`Weather Command Center v${APP_VERSION}`);
    loadSavedLocations();
    loadNowcastState();
    renderTabs();

    if (activeLocation) {
        // Use stored coordinates if available, otherwise search
        if (activeLocation.lat && activeLocation.lon) {
            fetchWeatherDataDirect(activeLocation.lat, activeLocation.lon, activeLocation);
        } else {
            fetchWeatherData();
        }
    } else {
        // Show welcome message for new users
        const container = document.getElementById('weatherContainer');
        container.innerHTML = `
            <div class="card welcome-card" style="text-align: center; padding: 2rem 1.5rem;">
                <div style="font-size: 4rem; margin-bottom: 1rem;">🌤️</div>
                <h2 style="font-family: 'Bebas Neue', cursive; font-size: clamp(1.8rem, 5vw, 2.5rem); color: var(--accent-primary); margin-bottom: 1rem; letter-spacing: 0.1rem;">Welcome to Weather Command Center</h2>
                <p style="font-size: clamp(0.85rem, 2.5vw, 1.1rem); color: var(--text-secondary); margin-bottom: 1.5rem; line-height: 1.6;">
                    Get started by adding your first location.
                </p>

                <div class="alm-gps-section">
                    <button class="alm-gps-btn" id="welcomeGpsBtn">📍 Use My Location</button>
                    <div class="alm-gps-confirm" id="welcomeGpsConfirm">
                        <div class="alm-confirm-label">📍 Detected — edit name if you like</div>
                        <div class="alm-confirm-row">
                            <input type="text" class="alm-name-input" id="welcomeGpsName" placeholder="Location name">
                            <button class="alm-add-btn" id="welcomeGpsAdd">Add</button>
                        </div>
                        <button class="alm-cancel-link" id="welcomeGpsCancel">Cancel</button>
                    </div>
                </div>

                <div class="alm-divider"><span>or search by name</span></div>

                <div class="alm-search-section">
                    <input type="text" class="alm-search-input" id="welcomeSearchInput"
                           placeholder="City, region, or place…"
                           autocomplete="off" autocorrect="off" spellcheck="false">
                    <div class="alm-results" id="welcomeResults"></div>
                </div>

                <div class="alm-coords-section">
                    <button class="alm-coords-toggle" id="welcomeCoordsToggle">▸ Enter coordinates</button>
                    <div class="alm-coords-form" id="welcomeCoordsForm">
                        <div class="alm-coords-row">
                            <input type="number" class="alm-coord-input" id="welcomeLat"
                                   placeholder="Latitude" step="any" min="-90" max="90">
                            <input type="number" class="alm-coord-input" id="welcomeLon"
                                   placeholder="Longitude" step="any" min="-180" max="180">
                        </div>
                        <input type="text" class="alm-name-input" id="welcomeCoordsName"
                               placeholder="Label (optional — reverse geocoded if blank)">
                        <button class="alm-add-btn" id="welcomeCoordsAdd">Add Location</button>
                    </div>
                </div>
            </div>
        `;
        wireWelcomeEvents();
    }
}

// Wire welcome screen interactive elements
function wireWelcomeEvents() {
    let gpsCoords = null;
    let debounceTimer = null;
    const searchCache = new Map();

    function saveAndFetch(loc) {
        clearTimeout(debounceTimer);
        const newLocation = {
            name: loc.name,
            displayName: extractDisplayName(loc.name),
            lat: loc.lat,
            lon: loc.lon,
            country: loc.country
        };
        savedLocations.push(newLocation);
        activeLocation = newLocation;
        saveLocations();
        renderTabs();
        fetchWeatherDataDirect(loc.lat, loc.lon, loc);
    }

    // ── GPS ──
    const gpsBtn = document.getElementById('welcomeGpsBtn');
    const gpsConfirm = document.getElementById('welcomeGpsConfirm');
    const gpsNameInput = document.getElementById('welcomeGpsName');

    gpsBtn.onclick = () => {
        if (!navigator.geolocation) {
            gpsBtn.textContent = 'Not supported on this device';
            return;
        }
        gpsBtn.textContent = '⏳ Detecting…';
        gpsBtn.disabled = true;

        navigator.geolocation.getCurrentPosition(
            async pos => {
                const lat = parseFloat(pos.coords.latitude.toFixed(6));
                const lon = parseFloat(pos.coords.longitude.toFixed(6));
                gpsCoords = { lat, lon, country: null };

                const rev = await reverseGeocodeLocation(lat, lon);
                gpsCoords.country = rev ? rev.country : null;
                gpsNameInput.value = rev ? rev.name : 'My Location';

                gpsBtn.style.display = 'none';
                gpsConfirm.classList.add('visible');
                gpsNameInput.focus();
                gpsNameInput.select();
            },
            err => {
                console.warn('Geolocation error:', err);
                gpsBtn.textContent = '📍 Use My Location';
                gpsBtn.disabled = false;
            },
            { timeout: 10000, maximumAge: 60000 }
        );
    };

    document.getElementById('welcomeGpsAdd').onclick = () => {
        if (!gpsCoords) return;
        const name = gpsNameInput.value.trim() || 'My Location';
        saveAndFetch({ lat: gpsCoords.lat, lon: gpsCoords.lon, name, country: gpsCoords.country });
    };

    gpsNameInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') document.getElementById('welcomeGpsAdd').click();
    });

    document.getElementById('welcomeGpsCancel').onclick = () => {
        gpsCoords = null;
        gpsConfirm.classList.remove('visible');
        gpsBtn.style.display = '';
        gpsBtn.textContent = '📍 Use My Location';
        gpsBtn.disabled = false;
    };

    // ── Search ──
    const searchInput = document.getElementById('welcomeSearchInput');
    const resultsEl = document.getElementById('welcomeResults');

    function renderResults(results) {
        if (!results.length) {
            resultsEl.innerHTML = '<div class="alm-no-results">No locations found</div>';
            return;
        }
        resultsEl.innerHTML = results.map((r, i) => {
            const parts = [r.name];
            if (r.admin1 && r.admin1 !== r.name) parts.push(r.admin1);
            if (r.country) parts.push(r.country);
            return `
                <div class="alm-result-item" data-i="${i}">
                    <div class="alm-result-name">${escapeHTML(parts.join(', '))}</div>
                    <div class="alm-result-coords">${r.latitude.toFixed(4)}°, ${r.longitude.toFixed(4)}°</div>
                </div>`;
        }).join('');

        resultsEl.querySelectorAll('.alm-result-item').forEach(el => {
            el.onclick = () => {
                const r = results[parseInt(el.dataset.i)];
                saveAndFetch({ lat: r.latitude, lon: r.longitude, name: r.name, country: r.country });
            };
        });
    }

    async function doSearch(q) {
        q = q.trim();
        if (!q) { resultsEl.innerHTML = ''; return; }

        const key = q.toLowerCase();
        if (searchCache.has(key)) { renderResults(searchCache.get(key)); return; }

        resultsEl.innerHTML = '<div class="alm-searching">Searching…</div>';
        try {
            const raw = await geocodeLocation(q);
            const list = Array.isArray(raw)
                ? raw
                : [{ name: raw.name, latitude: raw.lat, longitude: raw.lon, country: raw.country, admin1: null }];
            if (searchCache.size >= 30) searchCache.delete(searchCache.keys().next().value);
            searchCache.set(key, list);
            renderResults(list);
        } catch (_) {
            resultsEl.innerHTML = '<div class="alm-no-results">No locations found</div>';
        }
    }

    searchInput.addEventListener('input', e => {
        clearTimeout(debounceTimer);
        const q = e.target.value;
        if (!q.trim()) { resultsEl.innerHTML = ''; return; }
        debounceTimer = setTimeout(() => doSearch(q), 350);
    });

    searchInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') { clearTimeout(debounceTimer); doSearch(searchInput.value); }
    });

    // ── Coordinates ──
    const coordsToggle = document.getElementById('welcomeCoordsToggle');
    const coordsForm = document.getElementById('welcomeCoordsForm');

    coordsToggle.onclick = () => {
        const open = coordsForm.classList.toggle('visible');
        coordsToggle.textContent = (open ? '▾' : '▸') + ' Enter coordinates';
    };

    const latInput = document.getElementById('welcomeLat');
    const lonInput = document.getElementById('welcomeLon');

    latInput.addEventListener('input', () => latInput.classList.remove('alm-input-error'));
    lonInput.addEventListener('input', () => lonInput.classList.remove('alm-input-error'));

    document.getElementById('welcomeCoordsAdd').onclick = async () => {
        const lat = parseFloat(latInput.value);
        const lon = parseFloat(lonInput.value);

        if (isNaN(lat) || lat < -90 || lat > 90) {
            latInput.focus();
            latInput.classList.add('alm-input-error');
            return;
        }
        if (isNaN(lon) || lon < -180 || lon > 180) {
            lonInput.focus();
            lonInput.classList.add('alm-input-error');
            return;
        }

        let name = document.getElementById('welcomeCoordsName').value.trim();
        let country = null;

        if (!name) {
            const addBtn = document.getElementById('welcomeCoordsAdd');
            addBtn.textContent = 'Locating…';
            addBtn.disabled = true;
            const rev = await reverseGeocodeLocation(lat, lon);
            name = rev ? rev.name : `${lat.toFixed(4)}°, ${lon.toFixed(4)}°`;
            country = rev ? rev.country : null;
            addBtn.textContent = 'Add Location';
            addBtn.disabled = false;
        }

        saveAndFetch({ lat, lon, name, country });
    };
}

// ===== PWA SETUP =====
// Generate app icon dynamically (canvas-based PNG for iOS)
function generateAppIcon() {
    const canvas = document.createElement('canvas');
    canvas.width = 180;
    canvas.height = 180;
    const ctx = canvas.getContext('2d');

    // Background
    const radius = 36;
    ctx.beginPath();
    ctx.moveTo(radius, 0);
    ctx.lineTo(180 - radius, 0);
    ctx.quadraticCurveTo(180, 0, 180, radius);
    ctx.lineTo(180, 180 - radius);
    ctx.quadraticCurveTo(180, 180, 180 - radius, 180);
    ctx.lineTo(radius, 180);
    ctx.quadraticCurveTo(0, 180, 0, 180 - radius);
    ctx.lineTo(0, radius);
    ctx.quadraticCurveTo(0, 0, radius, 0);
    ctx.closePath();
    ctx.fillStyle = '#0a0e1a';
    ctx.fill();

    // Gradient accent bar at top
    const grad = ctx.createLinearGradient(0, 0, 180, 0);
    grad.addColorStop(0, '#00d4ff');
    grad.addColorStop(1, '#ff6b9d');
    ctx.fillStyle = grad;
    ctx.fillRect(20, 12, 140, 4);

    // Emoji
    ctx.font = '80px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🌤️', 90, 100);

    const link = document.createElement('link');
    link.rel = 'apple-touch-icon';
    link.href = canvas.toDataURL('image/png');
    document.head.appendChild(link);
}
generateAppIcon();

// Register service worker for PWA + offline caching
let _pendingUpdate = false;
if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
        console.log('Service Worker registered:', reg.scope);
    }).catch(err => {
        console.log('SW registration (expected if not served over HTTPS):', err.message);
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (hadController) {
            _pendingUpdate = true;
            const btn = document.getElementById('refreshBtn');
            if (btn) btn.classList.add('update-available');
        }
    });
}

// Load weather on page load
init();
