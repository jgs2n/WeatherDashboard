// Sanitize text for safe HTML display
function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Extract short display name (city) from full location string
function extractDisplayName(fullName) {
    if (!fullName) return '';
    const parts = fullName.split(',');
    return parts[0].trim();
}

// Build location label with state (US) or country code (international)
// Falls back to city name only for old saved locations lacking these fields
function locationLabel(location) {
    const city = extractDisplayName(location.name);
    if (!city) return '';
    if (location.countryCode === 'US' && location.stateCode) return `${city}, ${location.stateCode}`;
    if (location.countryCode) return `${city}, ${location.countryCode}`;
    return city;
}
