// Weather HQ — geolocation.js
// Continuous GPS watch with movement threshold.
// No DOM — service only. Fires callback when user moves ~1km.

let _geoWatchId = null;
let _lastReportedLat = null;
let _lastReportedLon = null;
const MOVEMENT_THRESHOLD_M = 1000;

function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
              Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function startGeoWatch(onPositionUpdate, onError) {
    stopGeoWatch();
    _lastReportedLat = null;
    _lastReportedLon = null;

    _geoWatchId = navigator.geolocation.watchPosition(
        pos => {
            const lat = parseFloat(pos.coords.latitude.toFixed(6));
            const lon = parseFloat(pos.coords.longitude.toFixed(6));

            if (_lastReportedLat !== null) {
                const dist = haversineDistance(_lastReportedLat, _lastReportedLon, lat, lon);
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
