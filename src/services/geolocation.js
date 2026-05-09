// Weather HQ — geolocation.js
// Continuous GPS watch with movement threshold.
// No DOM — service only. Fires callback when user moves ~1km.

let _geoWatchId = null;
let _lastReportedLat = null;
let _lastReportedLon = null;
const MOVEMENT_THRESHOLD_M = 1000;

// haversineDistanceM() is provided by src/utils/geo.js

function startGeoWatch(onPositionUpdate, onError) {
    stopGeoWatch();
    _lastReportedLat = null;
    _lastReportedLon = null;

    _geoWatchId = navigator.geolocation.watchPosition(
        pos => {
            const lat = parseFloat(pos.coords.latitude.toFixed(6));
            const lon = parseFloat(pos.coords.longitude.toFixed(6));

            if (_lastReportedLat !== null) {
                const dist = haversineDistanceM(_lastReportedLat, _lastReportedLon, lat, lon);
                if (dist < MOVEMENT_THRESHOLD_M) return;
            }

            _lastReportedLat = lat;
            _lastReportedLon = lon;
            onPositionUpdate({ lat, lon });
        },
        err => {
            console.warn('[GeoWatch] Error:', err.message);
            if (onError) onError(err);
        },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
    );
}

function stopGeoWatch() {
    if (_geoWatchId !== null) {
        navigator.geolocation.clearWatch(_geoWatchId);
        _geoWatchId = null;
    }
    _lastReportedLat = null;
    _lastReportedLon = null;
}

function isGeoWatchActive() {
    return _geoWatchId !== null;
}
