// Model comparison — fetch + spread computation.
// fetchModelComparison moved from openMeteo.js; computeModelSpread extracted
// from renderDashboard.js renderForecastGrid() (Phase 2B cleanup).

// Fetch GFS + ECMWF daily temps for model confidence comparison
async function fetchModelComparison(lat, lon) {
    try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,temperature_2m_min&models=gfs_seamless,ecmwf_ifs025&temperature_unit=fahrenheit&timezone=auto&forecast_days=7`;
        const response = await fetch(url);
        return await response.json();
    } catch (error) {
        console.error('Model comparison fetch error:', error);
        return null;
    }
}

/**
 * Compute per-day model temperature spread from multi-model comparison data.
 * Returns array of spread objects (one per day), or empty array if data is missing.
 * Each entry: { highMin, highMax, lowMin, lowMax, highSpread, lowSpread, models[] } or null.
 */
function computeModelSpread(modelComparison) {
    const modelSpread = [];
    if (!modelComparison || !modelComparison.daily) return modelSpread;

    const d = modelComparison.daily;
    const maxKeys = Object.keys(d).filter(k => k.startsWith('temperature_2m_max_'));
    const minKeys = Object.keys(d).filter(k => k.startsWith('temperature_2m_min_'));

    const modelLabels = {};
    maxKeys.forEach(k => {
        const suffix = k.replace('temperature_2m_max_', '');
        if (suffix.includes('gfs')) modelLabels[suffix] = 'GFS';
        else if (suffix.includes('ecmwf')) modelLabels[suffix] = 'ECMWF';
        else modelLabels[suffix] = suffix.toUpperCase();
    });

    if (maxKeys.length < 2 || minKeys.length < 2) return modelSpread;

    const days = d.time ? d.time.length : 0;
    for (let j = 0; j < days; j++) {
        const highs = maxKeys.map(k => d[k][j]).filter(v => v != null);
        const lows = minKeys.map(k => d[k][j]).filter(v => v != null);

        if (highs.length >= 2 && lows.length >= 2) {
            const highSpread = Math.abs(Math.max(...highs) - Math.min(...highs));
            const lowSpread = Math.abs(Math.max(...lows) - Math.min(...lows));

            const models = maxKeys.map((k, mi) => {
                const suffix = k.replace('temperature_2m_max_', '');
                const minKey = minKeys[mi];
                return {
                    name: modelLabels[suffix] || suffix,
                    high: d[k][j] != null ? Math.round(d[k][j]) : null,
                    low: minKey && d[minKey][j] != null ? Math.round(d[minKey][j]) : null
                };
            }).filter(m => m.high != null && m.low != null);

            modelSpread.push({
                highMin: Math.round(Math.min(...highs)),
                highMax: Math.round(Math.max(...highs)),
                lowMin: Math.round(Math.min(...lows)),
                lowMax: Math.round(Math.max(...lows)),
                highSpread: Math.round(highSpread),
                lowSpread: Math.round(lowSpread),
                models
            });
        } else {
            modelSpread.push(null);
        }
    }

    return modelSpread;
}
