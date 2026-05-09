// Location picker modal — shown when geocode returns multiple results
// Globals used: window.locationPickerResults, window.locationPickerResolve, window.locationPickerReject

// Add Location modal — search, GPS auto-detect, or manual coordinates
// Returns Promise<{ lat, lon, name, country }>
function showAddLocationModal() {
    return new Promise((resolve, reject) => {
        const searchCache = new Map();
        let debounceTimer = null;
        let gpsCoords = null;

        const overlay = document.createElement('div');
        overlay.className = 'alm-overlay';
        overlay.innerHTML = `
            <div class="alm-content">
                <div class="alm-header">
                    <h3>Add Location</h3>
                    <button class="alm-close" title="Close">×</button>
                </div>

                <div class="alm-gps-section">
                    <button class="alm-gps-btn" id="almGpsBtn">📍 Use My Location</button>
                    <div class="alm-gps-confirm" id="almGpsConfirm">
                        <div class="alm-confirm-label">📍 Detected — edit name if you like</div>
                        <div class="alm-confirm-row">
                            <input type="text" class="alm-name-input" id="almGpsName" placeholder="Location name">
                            <button class="alm-add-btn" id="almGpsAdd">Add</button>
                        </div>
                        <button class="alm-cancel-link" id="almGpsCancel">Cancel</button>
                    </div>
                </div>

                <div class="alm-divider"><span>or search by name</span></div>

                <div class="alm-search-section">
                    <input type="text" class="alm-search-input" id="almSearchInput"
                           placeholder="City, region, or place…"
                           autocomplete="off" autocorrect="off" spellcheck="false">
                    <div class="alm-results" id="almResults"></div>
                </div>

                <div class="alm-coords-section">
                    <button class="alm-coords-toggle" id="almCoordsToggle">▸ Enter coordinates</button>
                    <div class="alm-coords-form" id="almCoordsForm">
                        <div class="alm-coords-row">
                            <input type="number" class="alm-coord-input" id="almLat"
                                   placeholder="Latitude" step="any" min="-90" max="90">
                            <input type="number" class="alm-coord-input" id="almLon"
                                   placeholder="Longitude" step="any" min="-180" max="180">
                        </div>
                        <input type="text" class="alm-name-input" id="almCoordsName"
                               placeholder="Label (optional — reverse geocoded if blank)">
                        <button class="alm-add-btn" id="almCoordsAdd">Add Location</button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        function done(loc) {
            clearTimeout(debounceTimer);
            overlay.remove();
            resolve(loc);
        }

        function cancel() {
            clearTimeout(debounceTimer);
            overlay.remove();
            reject(new Error('Location selection cancelled'));
        }

        overlay.querySelector('.alm-close').onclick = cancel;
        overlay.addEventListener('click', e => { if (e.target === overlay) cancel(); });

        // ── GPS ──────────────────────────────────────────────────────────────
        const gpsBtn = overlay.querySelector('#almGpsBtn');
        const gpsConfirm = overlay.querySelector('#almGpsConfirm');
        const gpsNameInput = overlay.querySelector('#almGpsName');

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

        overlay.querySelector('#almGpsAdd').onclick = () => {
            if (!gpsCoords) return;
            const name = gpsNameInput.value.trim() || 'My Location';
            done({ lat: gpsCoords.lat, lon: gpsCoords.lon, name, country: gpsCoords.country });
        };

        gpsNameInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') overlay.querySelector('#almGpsAdd').click();
        });

        overlay.querySelector('#almGpsCancel').onclick = () => {
            gpsCoords = null;
            gpsConfirm.classList.remove('visible');
            gpsBtn.style.display = '';
            gpsBtn.textContent = '📍 Use My Location';
            gpsBtn.disabled = false;
        };

        // ── Search ───────────────────────────────────────────────────────────
        const searchInput = overlay.querySelector('#almSearchInput');
        const resultsEl = overlay.querySelector('#almResults');

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
                    done({ lat: r.latitude, lon: r.longitude, name: r.name, country: r.country });
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

        // ── Coordinates ──────────────────────────────────────────────────────
        const coordsToggle = overlay.querySelector('#almCoordsToggle');
        const coordsForm = overlay.querySelector('#almCoordsForm');

        coordsToggle.onclick = () => {
            const open = coordsForm.classList.toggle('visible');
            coordsToggle.textContent = (open ? '▾' : '▸') + ' Enter coordinates';
        };

        const latInput = overlay.querySelector('#almLat');
        const lonInput = overlay.querySelector('#almLon');

        latInput.addEventListener('input', () => latInput.classList.remove('alm-input-error'));
        lonInput.addEventListener('input', () => lonInput.classList.remove('alm-input-error'));

        overlay.querySelector('#almCoordsAdd').onclick = async () => {
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

            let name = overlay.querySelector('#almCoordsName').value.trim();
            let country = null;

            if (!name) {
                const addBtn = overlay.querySelector('#almCoordsAdd');
                addBtn.textContent = 'Locating…';
                addBtn.disabled = true;
                const rev = await reverseGeocodeLocation(lat, lon);
                name = rev ? rev.name : `${lat.toFixed(4)}°, ${lon.toFixed(4)}°`;
                country = rev ? rev.country : null;
                addBtn.textContent = 'Add Location';
                addBtn.disabled = false;
            }

            done({ lat, lon, name, country });
        };

        setTimeout(() => searchInput.focus(), 50);
    });
}

async function showLocationPicker(results) {
    return new Promise((resolve, reject) => {
        const modal = document.createElement('div');
        modal.className = 'location-picker-modal';

        const resultsHTML = results.map((result, index) => {
            const parts = [];
            parts.push(result.name);
            if (result.admin1 && result.admin1 !== result.name) {
                parts.push(result.admin1);
            }
            if (result.country) {
                parts.push(result.country);
            }
            const locationName = parts.join(', ');

            return `
                <div class="location-option" onclick="selectLocation(${index})">
                    <div class="location-option-name">${locationName}</div>
                    <div class="location-option-coords">📍 ${result.latitude.toFixed(4)}°, ${result.longitude.toFixed(4)}°</div>
                </div>
            `;
        }).join('');

        modal.innerHTML = `
            <div class="location-picker-content">
                <div class="location-picker-header">
                    <h3>Select Location</h3>
                    <button class="location-picker-close" onclick="closeLocationPicker()">×</button>
                </div>
                <div class="location-picker-results">
                    ${resultsHTML}
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        window.locationPickerResults = results;
        window.locationPickerResolve = resolve;
        window.locationPickerReject = reject;
    });
}

function selectLocation(index) {
    const result = window.locationPickerResults[index];
    const cc = (result.country_code || '').toUpperCase();
    const location = {
        lat: result.latitude,
        lon: result.longitude,
        name: result.name,
        country: result.country,
        countryCode: cc || null,
        stateCode: cc === 'US' ? (result.admin1_code || '').replace(/^US-/, '') || null : null
    };

    const resolve = window.locationPickerResolve;

    window.locationPickerResolve = null;
    window.locationPickerReject = null;
    window.locationPickerResults = null;

    const modal = document.querySelector('.location-picker-modal');
    if (modal) modal.remove();

    resolve(location);
}

function closeLocationPicker() {
    const reject = window.locationPickerReject;

    window.locationPickerResolve = null;
    window.locationPickerReject = null;
    window.locationPickerResults = null;

    const modal = document.querySelector('.location-picker-modal');
    if (modal) modal.remove();

    if (reject) {
        reject(new Error('Location selection cancelled'));
    }
}
