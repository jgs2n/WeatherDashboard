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
