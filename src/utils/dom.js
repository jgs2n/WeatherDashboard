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
