// NWS Station Observation Service
// Fetches nearest station + latest observation for US locations.
// Returns null on any failure (graceful, like nws.js).
// No DOM — data only.
//
// Exports (globals): fetchStationObservation

// ── Caches (recentPrecip.js pattern) ─────────────────────────────────────────

let _stationCache   = { data: null, ts: null, key: null };
let _stationPending = null;
const _STATION_TTL  = 30 * 60 * 1000; // 30 min — station list rarely changes

let _obsCache   = { data: null, ts: null, key: null };
let _obsPending = null;
const _OBS_TTL  = 3 * 60 * 1000; // 3 min

let _obsHistCache = { data: null, ts: null, key: null };
const _OBS_HIST_TTL = 15 * 60 * 1000; // 15 min

// ── Helpers ──────────────────────────────────────────────────────────────────

function _haversineMi(lat1, lon1, lat2, lon2) {
    const R = 3958.8; // Earth radius in miles
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// METAR/ASOS/AWOS stations have 4-char ICAO ids starting with K (CONUS)
// or P (Pacific), or C (Canada near border). Prefer these over COOP/other.
function _isMetarStation(id) {
    return /^[KPC][A-Z0-9]{3}$/.test(id);
}

// ── Fetch nearest station ────────────────────────────────────────────────────

async function _fetchNearestStation(lat, lon) {
    const cacheKey = `${lat.toFixed(2)}_${lon.toFixed(2)}`;
    if (_stationCache.key === cacheKey && _stationCache.ts &&
        (Date.now() - _stationCache.ts) < _STATION_TTL) {
        return _stationCache.data;
    }
    if (_stationPending) return _stationPending;

    _stationPending = (async () => {
        try {
            // Step 1: get observation stations URL from NWS points
            const ptRes = await fetch(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`, {
                headers: { 'Accept': 'application/geo+json' }
            });
            if (!ptRes.ok) return null;
            const ptData = await ptRes.json();
            const stationsUrl = ptData.properties && ptData.properties.observationStations;
            if (!stationsUrl) return null;

            // Step 2: fetch station list
            const stRes = await fetch(stationsUrl, {
                headers: { 'Accept': 'application/geo+json' }
            });
            if (!stRes.ok) return null;
            const stData = await stRes.json();
            const features = stData.features || stData.observationStations;
            if (!features || features.length === 0) return null;

            // Step 3: pick best station — prefer METAR, then nearest
            let best = null;
            let bestDist = Infinity;
            let bestMetar = null;
            let bestMetarDist = Infinity;

            for (const f of features) {
                const props = f.properties || {};
                const coords = f.geometry && f.geometry.coordinates; // [lon, lat]
                if (!coords) continue;
                const id = props.stationIdentifier || '';
                const dist = _haversineMi(lat, lon, coords[1], coords[0]);

                if (dist < bestDist) {
                    bestDist = dist;
                    best = { stationId: id, stationName: props.name || id, distance_mi: Math.round(dist * 10) / 10 };
                }
                if (_isMetarStation(id) && dist < bestMetarDist) {
                    bestMetarDist = dist;
                    bestMetar = { stationId: id, stationName: props.name || id, distance_mi: Math.round(dist * 10) / 10 };
                }
            }

            // Prefer METAR station if within 30 mi; otherwise use nearest
            const result = (bestMetar && bestMetarDist <= 30) ? bestMetar : best;
            _stationCache = { data: result, ts: Date.now(), key: cacheKey };
            return result;
        } catch (err) {
            console.warn('[Observations] Station lookup failed:', err.message);
            return null;
        }
    })();

    _stationPending = _stationPending.finally(() => { _stationPending = null; });
    return _stationPending;
}

// ── Fetch latest observation ─────────────────────────────────────────────────

async function _fetchLatestObs(stationId) {
    try {
        const res = await fetch(
            `https://api.weather.gov/stations/${stationId}/observations/latest?require_qc=false`,
            { headers: { 'Accept': 'application/geo+json' } }
        );
        if (!res.ok) return null;
        const data = await res.json();
        const p = data.properties;
        if (!p) return null;

        return {
            timestamp:      p.timestamp,
            textDescription: p.textDescription || '',
            temperature_c:  p.temperature && p.temperature.value,
            humidity:        p.relativeHumidity && p.relativeHumidity.value,
            wind_speed_kmh: p.windSpeed && p.windSpeed.value,
            wind_dir:       p.windDirection && p.windDirection.value,
            wind_gust_kmh:  p.windGust && p.windGust.value,
            pressure_pa:    p.barometricPressure && p.barometricPressure.value,
            visibility_m:   p.visibility && p.visibility.value,
            presentWeather: p.presentWeather || [],
            icon:           p.icon || null,
            rawMessage:     p.rawMessage || ''
        };
    } catch (err) {
        console.warn('[Observations] Obs fetch failed for', stationId, ':', err.message);
        return null;
    }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch station observation for a US location.
 * @param {number} lat
 * @param {number} lon
 * @returns {Promise<{stationId, stationName, distance_mi, obs:{...}}|null>}
 */
async function fetchStationObservation(lat, lon) {
    const cacheKey = `${lat.toFixed(2)}_${lon.toFixed(2)}`;
    if (_obsCache.key === cacheKey && _obsCache.ts &&
        (Date.now() - _obsCache.ts) < _OBS_TTL) {
        return _obsCache.data;
    }
    if (_obsPending) return _obsPending;

    _obsPending = (async () => {
        try {
            const station = await _fetchNearestStation(lat, lon);
            if (!station) return null;

            const obs = await _fetchLatestObs(station.stationId);
            if (!obs) return null;

            const result = {
                stationId:   station.stationId,
                stationName: station.stationName,
                distance_mi: station.distance_mi,
                obs
            };
            _obsCache = { data: result, ts: Date.now(), key: cacheKey };
            return result;
        } catch (err) {
            console.warn('[Observations] fetchStationObservation failed:', err.message);
            return null;
        }
    })();

    _obsPending = _obsPending.finally(() => { _obsPending = null; });
    return _obsPending;
}

// ── Fetch observation history via IEM ASOS (for recent precip) ────────────────
// Uses Iowa Environmental Mesonet ASOS API which reliably parses the METAR
// P-group (p01i = precip last 1 hour, inches) from 5-minute ASOS observations.
// NWS observations API does not populate precipitationLastHour for many US
// stations (including KAVL), making IEM the better source.
//
// Returns { station, rows: [{time, rainIn, present}] } bucketed by hour, or null.
// present is always true for returned rows (missing rows = no entry, not null).

async function fetchObservationHistory(lat, lon, hoursBack = 49) {
    const cacheKey = `${lat.toFixed(2)}_${lon.toFixed(2)}`;
    if (_obsHistCache.key === cacheKey && _obsHistCache.ts &&
        (Date.now() - _obsHistCache.ts) < _OBS_HIST_TTL) {
        return _obsHistCache.data;
    }

    try {
        const station = await _fetchNearestStation(lat, lon);
        if (!station) return null;

        // Build IEM ASOS request for p01i (precip last hour, inches) in UTC
        const now   = new Date();
        const start = new Date(now.getTime() - hoursBack * 3600000);
        const p = d => ({ y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours() });
        const s = p(start), e = p(now);
        const url = `https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=${station.stationId}&data=p01i` +
            `&year1=${s.y}&month1=${s.mo}&day1=${s.d}&hour1=${s.h}&minute1=0` +
            `&year2=${e.y}&month2=${e.mo}&day2=${e.d}&hour2=${e.h}&minute2=59` +
            `&tz=UTC&format=onlycomma&latlon=no&direct=no&report_type=1`;

        const res = await fetch(url);
        if (!res.ok) return null;
        const text = await res.text();

        // Parse CSV: skip comment lines (#) and header row
        // Bucket 5-minute observations into hours; take the max p01i per hour
        // (p01i is a rolling 1-hour window — max captures peak accumulation)
        const hourMap = new Map(); // epoch-hour → max rainIn
        for (const line of text.split('\n')) {
            if (!line || line.startsWith('#') || line.startsWith('station')) continue;
            const parts = line.split(',');
            if (parts.length < 3) continue;
            const p01iStr = parts[2].trim();
            if (p01iStr === 'M' || p01iStr === 'T' || p01iStr === '') continue; // missing / trace / blank
            const rainIn = parseFloat(p01iStr);
            if (isNaN(rainIn)) continue;

            // Parse "YYYY-MM-DD HH:MM" UTC → ISO
            const isoStr = parts[1].trim().replace(' ', 'T') + ':00Z';
            const obsTime = new Date(isoStr);
            if (isNaN(obsTime.getTime())) continue;

            const bucket = Math.floor(obsTime.getTime() / 3600000);
            const cur = hourMap.get(bucket);
            if (cur === undefined || rainIn > cur) hourMap.set(bucket, rainIn);
        }

        if (hourMap.size === 0) return null;

        // Build oldest-first rows array
        const rows = Array.from(hourMap.entries())
            .sort(([a], [b]) => a - b)
            .map(([bucket, rainIn]) => ({
                time:    new Date(bucket * 3600000).toISOString(),
                rainIn:  Math.round(rainIn * 1000) / 1000,
                present: true
            }));

        const result = { station, rows };
        _obsHistCache = { data: result, ts: Date.now(), key: cacheKey };
        return result;
    } catch (err) {
        console.warn('[Observations] fetchObservationHistory failed:', err.message);
        return null;
    }
}
