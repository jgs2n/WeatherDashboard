// Geocoding service — returns data only, no DOM
// Single result  → { lat, lon, name, country }
// Multiple results → raw results array (caller handles picker UI)
// No results → throws 'Location not found'

async function geocodeLocation(locationName) {
    const response = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(locationName)}&count=10&language=en&format=json`
    );
    const data = await response.json();

    if (data.results && data.results.length > 0) {
        if (data.results.length === 1) {
            return {
                lat: data.results[0].latitude,
                lon: data.results[0].longitude,
                name: data.results[0].name,
                country: data.results[0].country
            };
        }
        // Multiple results — return array; caller shows picker
        return data.results;
    }
    throw new Error('Location not found');
}

// Reverse geocode lat/lon → { lat, lon, name, country } using Nominatim
// Returns null on failure — callers must handle gracefully
async function reverseGeocodeLocation(lat, lon) {
    try {
        const response = await fetch(
            `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=10&accept-language=en`
        );
        if (!response.ok) return null;
        const data = await response.json();
        if (!data.address) return null;

        const addr = data.address;
        const city = addr.city || addr.town || addr.village || addr.suburb || addr.hamlet || addr.county;
        const region = addr.state || addr.country;
        const name = city
            ? (region ? `${city}, ${region}` : city)
            : (data.display_name ? data.display_name.split(',')[0].trim() : null);

        return {
            lat,
            lon,
            name: name || 'My Location',
            country: addr.country_code ? addr.country_code.toUpperCase() : addr.country
        };
    } catch (e) {
        console.warn('Reverse geocode failed:', e);
        return null;
    }
}
