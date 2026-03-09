// Recent Precipitation service
// Primary:  Meteostat point/hourly (requires 'meteostatApiKey' in localStorage)
// Fallback: Open-Meteo snowfall + precipitation (model, always available)
//
// Exports (globals): fetchRecentPrecip, buildRecentPrecip, sliceRecentPrecip, buildFutureHours

let _rpCache    = { data: null, ts: null, key: null };
let _rpPending  = null;
const _RP_TTL   = 30 * 60 * 1000; // 30 minutes

// ── Meteostat raw fetch ───────────────────────────────────────────────────────
// Returns the raw Meteostat JSON response or null if key missing / fetch fails.

async function fetchRecentPrecip(lat, lon) {
    const apiKey = localStorage.getItem('meteostatApiKey');
    if (!apiKey) return null;

    const cacheKey = `${lat.toFixed(2)}_${lon.toFixed(2)}`;
    if (_rpCache.key === cacheKey && _rpCache.ts && (Date.now() - _rpCache.ts) < _RP_TTL) {
        return _rpCache.data;
    }

    if (_rpPending) return _rpPending;

    // Request 3 days back to today (UTC dates)
    const now   = new Date();
    const start = new Date(now.getTime() - 3 * 86400000);
    const fmt   = d => d.toISOString().slice(0, 10);
    const url   = `https://meteostat.p.rapidapi.com/point/hourly?lat=${lat}&lon=${lon}&start=${fmt(start)}&end=${fmt(now)}`;

    _rpPending = fetch(url, {
        headers: {
            'X-RapidAPI-Key':  apiKey,
            'X-RapidAPI-Host': 'meteostat.p.rapidapi.com'
        }
    })
    .then(r => (r.ok ? r.json() : null))
    .then(json => {
        const result = (json && json.data && json.data.length > 0) ? json : null;
        _rpCache = { data: result, ts: Date.now(), key: cacheKey };
        return result;
    })
    .catch(err => {
        console.error('Meteostat fetch error:', err);
        return null;
    })
    .finally(() => { _rpPending = null; });

    return _rpPending;
}

// ── Build normalized RecentPrecip object ──────────────────────────────────────
// Priority: NWS obs history (US, free) → Meteostat (paid key) → Open-Meteo model.
// Always returns a RecentPrecip object (never null) as long as openMeteoHourly exists.

function buildRecentPrecip(meteostatRaw, openMeteoHourly, timezone, nwsHistory) {
    const now = new Date();

    let result = null;

    // 1. IEM ASOS observation history — actual ASOS p01i data, US only, no key required
    if (!result && nwsHistory && nwsHistory.rows && nwsHistory.rows.length >= 3) {
        result = _buildFromNWSHistory(nwsHistory, timezone);
    }

    // 2. Meteostat — station-based, requires paid API key
    if (!result && meteostatRaw && meteostatRaw.data && meteostatRaw.data.length > 0) {
        result = _buildFromMeteostat(meteostatRaw, openMeteoHourly, now, timezone);
    }

    // 3. Open-Meteo model — always available, estimated
    if (!result) {
        result = _buildFallback(openMeteoHourly, now, timezone);
    }

    // Attach 3h forecast from Open-Meteo (separate from observed series)
    if (result) {
        result.futureSeries = buildFutureHours(openMeteoHourly, 3);
    }

    return result;
}

// ── NWS observation history path ──────────────────────────────────────────────
// Builds a 48H series ending at NOW from NWS ASOS precipitationLastHour values.
// Uses a Map for O(1) hour-bucket lookup instead of O(n) find() per slot.

function _buildFromNWSHistory(nwsHistory, timezone) {
    const { station, rows } = nwsHistory;
    const now = new Date();

    const lastRow    = rows[rows.length - 1];
    const asOf       = new Date(lastRow.time);
    const lagMinutes = Math.floor((now - asOf) / 60000);

    // Build hour-bucket → row map (epoch ms floored to the hour)
    const rowMap = new Map();
    for (const r of rows) {
        const bucket = Math.floor(new Date(r.time).getTime() / 3600000);
        rowMap.set(bucket, r);
    }

    // 48 slots ending at the current hour so the chart always shows "last 48h to now"
    const nowHour = Math.floor(now.getTime() / 3600000) * 3600000;
    const series  = [];
    for (let h = 47; h >= 0; h--) {
        const slotMs = nowHour - h * 3600000;
        const bucket = Math.floor(slotMs / 3600000);
        // ±1 bucket tolerance for obs that land slightly off the hour
        const match  = rowMap.get(bucket) || rowMap.get(bucket - 1) || rowMap.get(bucket + 1);
        if (match) {
            series.push({
                time:    new Date(slotMs).toISOString(),
                rainIn:  match.rainIn,    // null = missing data; 0 = dry; >0 = rain
                snowIn:  0,
                present: match.present    // true only when precipitationLastHour was non-null
            });
        } else {
            series.push({ time: new Date(slotMs).toISOString(), rainIn: null, snowIn: null, present: false });
        }
    }

    const presentCount = series.filter(s => s.present).length;
    const flags = ['unit_converted'];
    if (lagMinutes > 180) flags.push('stale');
    if (presentCount < 24) flags.push('partial'); // warn if less than half the window is covered

    return {
        fullSeries:    series,
        asOf:          asOf.toISOString(),
        lagMinutes,
        method:        'iem_asos',
        source: {
            provider:    'IEM ASOS',
            stationId:   station.stationId,
            stationName: station.stationName,
            distanceKm:  station.distance_mi != null ? Math.round(station.distance_mi * 1.609) : null,
            gridProduct: null
        },
        qualityFlags:  flags,
        timezone:      timezone || 'UTC',
        expectedHours: 48,
        reportedHours: presentCount,
        missingHours:  48 - presentCount
    };
}

// ── Meteostat path ────────────────────────────────────────────────────────────

function _buildFromMeteostat(raw, openMeteoHourly, now, timezone) {
    const rows = raw.data; // UTC time strings, fields: prcp (mm), snow (mm depth)

    // Find asOf: last row with non-null prcp
    let asOfIdx = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].prcp !== null && rows[i].prcp !== undefined) { asOfIdx = i; break; }
    }
    if (asOfIdx < 0) return null;

    const asOf       = new Date(rows[asOfIdx].time + 'Z');
    const lagMinutes = Math.floor((now - asOf) / 60000);
    const flags      = ['unit_converted'];

    if (lagMinutes > 360) { flags.push('very_stale'); return null; } // trigger fallback
    if (lagMinutes > 180) flags.push('stale');

    // Build full 48H series working back from asOf
    const windowStart = new Date(asOf.getTime() - 48 * 3600000);
    const series      = [];

    for (let h = 0; h < 48; h++) {
        const slotTime = new Date(windowStart.getTime() + h * 3600000);

        // Find matching Meteostat row within ±5 min
        const match = rows.find(r => Math.abs(new Date(r.time + 'Z') - slotTime) <= 5 * 60000);

        if (match && match.prcp !== null && match.prcp !== undefined) {
            const rainIn = Math.round((match.prcp / 25.4) * 1000) / 1000;

            // Snow: positive snow-depth delta between consecutive rows
            let snowIn = 0;
            const mi = rows.indexOf(match);
            if (mi > 0 && rows[mi - 1].snow !== null && rows[mi - 1].snow !== undefined
                       && match.snow !== null && match.snow !== undefined) {
                const delta = match.snow - rows[mi - 1].snow;
                if (delta > 0) {
                    // depth delta mm → estimated snow inches (10:1 SWE ratio)
                    snowIn = Math.round((delta / 25.4 / 10) * 1000) / 1000;
                    if (!flags.includes('snow_density_assumed')) flags.push('snow_density_assumed');
                    // Discard if Open-Meteo says it's too warm for snow
                    if (openMeteoHourly) {
                        const omIdx = _nearestHourIdx(openMeteoHourly.time, slotTime);
                        if (omIdx >= 0 && openMeteoHourly.temperature_2m[omIdx] > 35) snowIn = 0;
                    }
                }
            }

            series.push({ time: slotTime.toISOString(), rainIn, snowIn, present: true });
        } else {
            series.push({ time: slotTime.toISOString(), rainIn: null, snowIn: null, present: false });
        }
    }

    const presentCount = series.filter(s => s.present).length;
    if (presentCount < 48) flags.push('partial');

    // Station metadata from Meteostat response
    let source = { provider: 'Meteostat', stationId: null, stationName: null, distanceKm: null, gridProduct: null };
    if (raw.meta && raw.meta.stations && raw.meta.stations.length > 0) {
        const st = raw.meta.stations[0];
        source.stationId   = st.id   || null;
        source.stationName = (st.name && st.name.en) ? st.name.en : (typeof st.name === 'string' ? st.name : null);
        source.distanceKm  = (st.distance != null) ? Math.round(st.distance / 100) / 10 : null;
    }

    return {
        fullSeries:    series,
        asOf:          asOf.toISOString(),
        lagMinutes,
        method:        'meteostat_hourly',
        source,
        qualityFlags:  flags,
        timezone:      timezone || 'UTC',
        expectedHours: 48,
        reportedHours: presentCount,
        missingHours:  48 - presentCount
    };
}

// ── Open-Meteo fallback path ──────────────────────────────────────────────────

function _buildFallback(openMeteoHourly, now, timezone) {
    if (!openMeteoHourly || !openMeteoHourly.time) return null;

    const flags = ['estimated'];

    // asOf = last Open-Meteo hour at or before now
    let asOfIdx = -1;
    for (let i = 0; i < openMeteoHourly.time.length; i++) {
        if (new Date(openMeteoHourly.time[i]) <= now) asOfIdx = i;
        else break;
    }
    if (asOfIdx < 0) return null;

    const asOf       = new Date(openMeteoHourly.time[asOfIdx]);
    const lagMinutes = Math.floor((now - asOf) / 60000);
    const windowStart = new Date(asOf.getTime() - 48 * 3600000);
    const series     = [];

    for (let h = 0; h < 48; h++) {
        const slotTime = new Date(windowStart.getTime() + h * 3600000);
        const omIdx    = _nearestHourIdx(openMeteoHourly.time, slotTime);

        if (omIdx >= 0 && new Date(openMeteoHourly.time[omIdx]) <= now) {
            const rainIn = openMeteoHourly.precipitation[omIdx] != null
                ? Math.round(openMeteoHourly.precipitation[omIdx] * 1000) / 1000
                : 0;
            // snowfall is cm/hr → divide by 2.54 for inches
            const snowIn = (openMeteoHourly.snowfall && openMeteoHourly.snowfall[omIdx] != null)
                ? Math.round((openMeteoHourly.snowfall[omIdx] / 2.54) * 1000) / 1000
                : 0;
            series.push({ time: slotTime.toISOString(), rainIn, snowIn, present: true });
        } else {
            series.push({ time: slotTime.toISOString(), rainIn: null, snowIn: null, present: false });
        }
    }

    const presentCount = series.filter(s => s.present).length;
    if (presentCount < 48) flags.push('partial');

    return {
        fullSeries:    series,
        asOf:          asOf.toISOString(),
        lagMinutes,
        method:        'open_meteo_model',
        source:        { provider: 'Open-Meteo model', stationId: null, stationName: null, distanceKm: null, gridProduct: null },
        qualityFlags:  flags,
        timezone:      timezone || 'UTC',
        expectedHours: 48,
        reportedHours: presentCount,
        missingHours:  48 - presentCount
    };
}

// ── Window slicer (used by card renderer and chart) ───────────────────────────
// Returns a derived object with window-specific totals and a sliced series.

function sliceRecentPrecip(rp, windowHours) {
    if (!rp || !rp.fullSeries) return null;

    const series  = rp.fullSeries.slice(Math.max(0, rp.fullSeries.length - windowHours));
    const present = series.filter(s => s.present);

    const rainTotal = present.length > 0
        ? Math.round(present.reduce((sum, s) => sum + (s.rainIn || 0), 0) * 100) / 100
        : null;
    const snowTotal = present.some(s => (s.snowIn || 0) > 0)
        ? Math.round(present.reduce((sum, s) => sum + (s.snowIn || 0), 0) * 100) / 100
        : 0;

    // Future forecast data (pass through, compute totals)
    const futureSeries = rp.futureSeries || [];
    const forecastRainTotal = futureSeries.length > 0
        ? Math.round(futureSeries.reduce((sum, s) => sum + (s.rainIn || 0), 0) * 100) / 100
        : 0;
    const forecastSnowTotal = futureSeries.some(s => (s.snowIn || 0) > 0)
        ? Math.round(futureSeries.reduce((sum, s) => sum + (s.snowIn || 0), 0) * 100) / 100
        : 0;

    return {
        ...rp,
        windowHours,
        series,
        futureSeries,
        coverageStart:  series.length > 0 ? series[0].time : null,
        coverageEnd:    rp.asOf,
        expectedHours:  windowHours,
        reportedHours:  present.length,
        missingHours:   windowHours - present.length,
        rainTotal,
        snowTotal,
        forecastRainTotal,
        forecastSnowTotal
    };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _nearestHourIdx(times, target) {
    let bestIdx = -1, bestDiff = Infinity;
    for (let i = 0; i < times.length; i++) {
        const diff = Math.abs(new Date(times[i]) - target);
        if (diff < bestDiff && diff <= 30 * 60000) { bestDiff = diff; bestIdx = i; }
    }
    return bestIdx;
}

// ── Future hours extraction (Open-Meteo forecast) ────────────────────────────
// Extracts the next `count` hours of forecast precipitation from Open-Meteo
// hourly arrays. Returns entries marked with forecast:true.

function buildFutureHours(openMeteoHourly, count = 3) {
    if (!openMeteoHourly || !openMeteoHourly.time) return [];
    const now = new Date();
    // Find first future hour (strictly after now)
    let startIdx = -1;
    for (let i = 0; i < openMeteoHourly.time.length; i++) {
        if (new Date(openMeteoHourly.time[i]) > now) { startIdx = i; break; }
    }
    if (startIdx < 0) return [];

    const result = [];
    for (let i = startIdx; i < Math.min(startIdx + count, openMeteoHourly.time.length); i++) {
        const rainIn = openMeteoHourly.precipitation[i] != null
            ? Math.round(openMeteoHourly.precipitation[i] * 1000) / 1000
            : 0;
        const snowIn = (openMeteoHourly.snowfall && openMeteoHourly.snowfall[i] != null)
            ? Math.round((openMeteoHourly.snowfall[i] / 2.54) * 1000) / 1000
            : 0;
        result.push({
            time: openMeteoHourly.time[i],
            rainIn,
            snowIn,
            present: true,
            forecast: true
        });
    }
    return result;
}
