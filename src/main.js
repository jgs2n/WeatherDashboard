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

// Show prompt to add new location
function showAddLocationPrompt() {
    const locationName = prompt('Enter city name (e.g., "Denver" or "Seattle"):');
    if (locationName && locationName.trim()) {
        addNewLocation(locationName.trim());
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

        const [openMeteoData, airQualityData, nwsData, modelData, meteostatRaw] = await Promise.all([
            fetchForecast(location.lat, location.lon),
            fetchAirQuality(location.lat, location.lon),
            fetchNWS(location.lat, location.lon),
            fetchModelComparison(location.lat, location.lon),
            fetchRecentPrecip(location.lat, location.lon)
        ]);

        const recentPrecipData = buildRecentPrecip(meteostatRaw, openMeteoData.hourly, openMeteoData.timezone || 'UTC');
        renderWeatherDashboard(openMeteoData, airQualityData, nwsData, location, modelData, recentPrecipData);
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
        const [openMeteoData, airQualityData, nwsData, modelData, meteostatRaw] = await Promise.all([
            fetchForecast(lat, lon),
            fetchAirQuality(lat, lon),
            fetchNWS(lat, lon),
            fetchModelComparison(lat, lon),
            fetchRecentPrecip(lat, lon)
        ]);

        const recentPrecipData = buildRecentPrecip(meteostatRaw, openMeteoData.hourly, openMeteoData.timezone || 'UTC');
        renderWeatherDashboard(openMeteoData, airQualityData, nwsData, location, modelData, recentPrecipData);
    } catch (error) {
        container.innerHTML = `<div class="card"><div class="alert-title">Error</div><p>${error.message}</p></div>`;
    }
}

// Initialize the dashboard
function init() {
    console.log(`Weather Command Center v${APP_VERSION}`);
    loadSavedLocations();
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
            <div class="card" style="text-align: center; padding: 2rem 1.5rem;">
                <div style="font-size: 4rem; margin-bottom: 1rem;">🌤️</div>
                <h2 style="font-family: 'Bebas Neue', cursive; font-size: clamp(1.8rem, 5vw, 2.5rem); color: var(--accent-primary); margin-bottom: 1rem; letter-spacing: 0.1rem;">Welcome to Weather Command Center</h2>
                <p style="font-size: clamp(0.85rem, 2.5vw, 1.1rem); color: var(--text-secondary); margin-bottom: 2rem; line-height: 1.6;">
                    Get started by adding your first location.<br>
                    Click the <span style="color: var(--accent-primary); font-weight: 600;">+ Add Location</span> button above, or enter a location below.
                </p>
                <div style="display: flex; gap: 0.75rem; justify-content: center; align-items: center; flex-wrap: wrap;">
                    <input type="text" id="welcomeInput" class="location-input" placeholder="Enter your location (e.g., Miami, Portland)" style="max-width: 400px; width: 100%; font-size: 16px;">
                    <button onclick="addFirstLocation()" class="btn">Get Started</button>
                </div>
            </div>
        `;
    }
}

// Add first location from welcome screen
async function addFirstLocation() {
    const input = document.getElementById('welcomeInput');
    const locationName = input ? input.value.trim() : '';

    if (!locationName) {
        alert('Please enter a location name');
        return;
    }

    try {
        const geocodeResult = await geocodeLocation(locationName);
        const location = Array.isArray(geocodeResult)
            ? await showLocationPicker(geocodeResult)
            : geocodeResult;

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
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(reg => {
        console.log('Service Worker registered:', reg.scope);
    }).catch(err => {
        console.log('SW registration (expected if not served over HTTPS):', err.message);
    });
}

// Load weather on page load
init();
