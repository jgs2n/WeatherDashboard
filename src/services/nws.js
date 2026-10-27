// NWS service — US-only; returns null for non-US / no NWS coverage, never throws.
// Alerts are independent of the forecast: a failed forecast must not hide a
// warning, so the result is { forecast: data|null, alerts: data|null } whenever
// NWS covers the point. alerts === null means the alerts request failed.

async function fetchNWSAlerts(lat, lon) {
    try {
        const resp = await fetch(`https://api.weather.gov/alerts/active?point=${lat},${lon}`);
        return resp.ok ? await resp.json() : null;
    } catch (error) {
        console.warn('NWS alerts fetch error:', error);
        return null;
    }
}

async function fetchNWS(lat, lon) {
    // Start alerts now; it needs no points lookup.
    const alertsPromise = fetchNWSAlerts(lat, lon);
    let pointsData;
    try {
        const pointsResponse = await fetch(`https://api.weather.gov/points/${lat},${lon}`);
        // 404 = outside NWS coverage (non-US). Other failures are transient.
        if (pointsResponse.status === 404) return null;
        if (!pointsResponse.ok) return { forecast: null, alerts: await alertsPromise };
        pointsData = await pointsResponse.json();
    } catch (error) {
        console.error('NWS points fetch error:', error);
        return { forecast: null, alerts: await alertsPromise };
    }

    // Validate that NWS actually has forecast data for this point
    if (!pointsData.properties || !pointsData.properties.forecast) return null;

    let forecast = null;
    try {
        const forecastResponse = await fetch(pointsData.properties.forecast);
        if (forecastResponse.ok) forecast = await forecastResponse.json();
    } catch (error) {
        console.error('NWS forecast fetch error:', error);
    }
    return { forecast, alerts: await alertsPromise };
}
