// Location picker modal — shown when geocode returns multiple results
// Globals used: window.locationPickerResults, window.locationPickerResolve, window.locationPickerReject

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
    const location = {
        lat: result.latitude,
        lon: result.longitude,
        name: result.name,
        country: result.country
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
