function getAQICategory(aqi) {
    if (aqi <= 50) return { level: 'Good', color: '#00e400', icon: '✓' };
    if (aqi <= 100) return { level: 'Moderate', color: '#ffff00', icon: '◐' };
    if (aqi <= 150) return { level: 'Unhealthy for Sensitive', color: '#ff7e00', icon: '⚠' };
    if (aqi <= 200) return { level: 'Unhealthy', color: '#ff0000', icon: '⚠' };
    if (aqi <= 300) return { level: 'Very Unhealthy', color: '#8f3f97', icon: '⚠⚠' };
    return { level: 'Hazardous', color: '#7e0023', icon: '⚠⚠⚠' };
}

function calculateFireRisk(temp, humidity, windSpeed) {
    // Simple fire risk calculation based on temperature, humidity, and wind
    let risk = 0;

    // Temperature factor (higher temp = higher risk)
    if (temp > 85) risk += 3;
    else if (temp > 75) risk += 2;
    else if (temp > 65) risk += 1;

    // Humidity factor (lower humidity = higher risk)
    if (humidity < 20) risk += 3;
    else if (humidity < 30) risk += 2;
    else if (humidity < 40) risk += 1;

    // Wind factor (higher wind = higher risk)
    if (windSpeed > 20) risk += 2;
    else if (windSpeed > 15) risk += 1;

    if (risk >= 7) return { level: 'Extreme', color: '#8b0000', icon: '🔥🔥🔥' };
    if (risk >= 5) return { level: 'High', color: '#ff4500', icon: '🔥🔥' };
    if (risk >= 3) return { level: 'Moderate', color: '#ffa500', icon: '🔥' };
    return { level: 'Low', color: '#90ee90', icon: '✓' };
}
