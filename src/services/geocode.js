// Geocoding service — returns data only, no DOM
// Single result  → { lat, lon, name, country, countryCode, stateCode }
// Multiple results → raw results array (caller handles picker UI)
// No results → throws 'Location not found'

const US_STATE_CODES = {
    'Alabama': 'AL', 'Alaska': 'AK', 'Arizona': 'AZ', 'Arkansas': 'AR',
    'California': 'CA', 'Colorado': 'CO', 'Connecticut': 'CT', 'Delaware': 'DE',
    'Florida': 'FL', 'Georgia': 'GA', 'Hawaii': 'HI', 'Idaho': 'ID',
    'Illinois': 'IL', 'Indiana': 'IN', 'Iowa': 'IA', 'Kansas': 'KS',
    'Kentucky': 'KY', 'Louisiana': 'LA', 'Maine': 'ME', 'Maryland': 'MD',
    'Massachusetts': 'MA', 'Michigan': 'MI', 'Minnesota': 'MN', 'Mississippi': 'MS',
    'Missouri': 'MO', 'Montana': 'MT', 'Nebraska': 'NE', 'Nevada': 'NV',
    'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY',
    'North Carolina': 'NC', 'North Dakota': 'ND', 'Ohio': 'OH', 'Oklahoma': 'OK',
    'Oregon': 'OR', 'Pennsylvania': 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC',
    'South Dakota': 'SD', 'Tennessee': 'TN', 'Texas': 'TX', 'Utah': 'UT',
    'Vermont': 'VT', 'Virginia': 'VA', 'Washington': 'WA', 'West Virginia': 'WV',
    'Wisconsin': 'WI', 'Wyoming': 'WY', 'District of Columbia': 'DC'
};

async function geocodeLocation(locationName) {
    const response = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(locationName)}&count=10&language=en&format=json`
    );
    const data = await response.json();

    if (data.results && data.results.length > 0) {
        if (data.results.length === 1) {
            const r = data.results[0];
            const cc = (r.country_code || '').toUpperCase();
            return {
                lat: r.latitude,
                lon: r.longitude,
                name: r.name,
                country: r.country,
                countryCode: cc || null,
                stateCode: cc === 'US' ? (r.admin1_code || '').replace(/^US-/, '') || null : null
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

        const cc = addr.country_code ? addr.country_code.toUpperCase() : null;
        return {
            lat,
            lon,
            name: name || 'My Location',
            country: cc || addr.country,
            countryCode: cc,
            stateCode: cc === 'US' ? (US_STATE_CODES[addr.state] || null) : null
        };
    } catch (e) {
        console.warn('Reverse geocode failed:', e);
        return null;
    }
}
