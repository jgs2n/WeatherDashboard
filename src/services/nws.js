// NWS service — US-only; always returns null for non-US or on error, never throws

async function fetchNWS(lat, lon) {
    try {
        // Step 1: Check if this location is NWS-supported
        const pointsResponse = await fetch(`https://api.weather.gov/points/${lat},${lon}`);
        if (!pointsResponse.ok) return null;

        const pointsData = await pointsResponse.json();

        // Validate that NWS actually has forecast data for this point
        if (!pointsData.properties || !pointsData.properties.forecast) return null;

        // Step 2: Location is NWS-supported — fetch forecast and alerts in parallel
        const [forecastResponse, alertsResponse] = await Promise.all([
            fetch(pointsData.properties.forecast),
            fetch(`https://api.weather.gov/alerts/active?point=${lat},${lon}`)
        ]);

        if (!forecastResponse.ok) return null;

        const forecastData = await forecastResponse.json();
        const alertsData = alertsResponse.ok ? await alertsResponse.json() : null;

        return {
            forecast: forecastData,
            alerts: alertsData
        };
    } catch (error) {
        console.error('NWS fetch error:', error);
        return null;
    }
}
