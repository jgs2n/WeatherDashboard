// Climatology Service — precipitation totals vs expected (1M/3M/6M/12M)
// Actuals: ERA5 archive daily precipitation for the trailing 365 days, with
// the ~5-day ERA5 latency tail topped up from the already-fetched forecast
// daily block. Expected: mean of the same trailing windows over the 10 prior
// years (single archive call). Only computed aggregates are cached.
//
// No DOM here. Exports (globals): fetchClimatology, getCachedClimatology
//
// All date arithmetic is pure ISO-string / UTC math — daily buckets arrive in
// the location's local calendar (timezone=auto), so no client-tz conversion.

const CLIMO_CFG = {
    WINDOWS: [
        { days: 30,  label: '1M'  },
        { days: 91,  label: '3M'  },
        { days: 182, label: '6M'  },
        { days: 365, label: '12M' },
    ],
    // 30-year baseline (v0.9.4, was 10): matches the NOAA-normals convention
    // and roughly halves the ±10-15% sampling noise a 10-year precip mean
    // carries. One archive call still fetches the whole range (verified:
    // 31 years = 11,323 daily values, no gaps).
    BASELINE_YEARS:    30,
    MIN_BASELINE_YEARS: 20,    // require ≥ this many usable years for "expected"
    MAX_MISSING_FRAC:  0.20,   // > this fraction of days missing → window is null
    MIN_EXPECTED_IN:   0.05,   // expected below this → suppress % departure (deserts)
    ACTUALS_TTL_MS:    12 * 60 * 60 * 1000,       // refetch actuals every 12 h
    BASELINE_TTL_MS:   30 * 24 * 60 * 60 * 1000,  // refetch baseline every 30 d
    STORAGE_KEY:       'climoCacheV2',  // v2: invalidates cached 10-yr entries
    MAX_CACHED_LOCATIONS: 8,
};

// ── Module state ─────────────────────────────────────────────────────────────
const _climoMem = new Map();          // key → entry (session cache)
const _climoPendingByKey = new Map(); // key → in-flight promise

function _climoKey(lat, lon) {
    return `${lat.toFixed(2)}_${lon.toFixed(2)}`;
}

// ── Pure date helpers (ISO 'YYYY-MM-DD' in/out) ──────────────────────────────

function _climoAddDays(iso, n) {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

// Same month/day yearsBack earlier; Feb 29 clamps to Feb 28.
function _climoAnchor(iso, yearsBack) {
    const [y, m, d] = iso.split('-').map(Number);
    const day = (m === 2 && d === 29) ? 28 : d;
    return `${y - yearsBack}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Map 'YYYY-MM-DD' → value (null preserved as null).
function _climoDateMap(times, values) {
    const map = new Map();
    if (!times || !values) return map;
    for (let i = 0; i < times.length; i++) {
        map.set(times[i], values[i] !== undefined ? values[i] : null);
    }
    return map;
}

// Sum the `days` daily values ending at endIso (inclusive).
// Returns { sum, missing } — missing counts null or absent dates.
function _climoSumWindow(map, endIso, days) {
    let sum = 0, missing = 0;
    let d = endIso;
    for (let i = 0; i < days; i++) {
        const v = map.get(d);
        if (v === null || v === undefined) missing++;
        else sum += v;
        d = _climoAddDays(d, -1);
    }
    return { sum, missing };
}

// ── Pure window computation ──────────────────────────────────────────────────
// Returns the windows array for the cache entry. baselineMap may span ~11
// years of dailies; asOf is the last date with actual data.

function _climoComputeWindows(actualMap, snowMap, baselineMap, asOf) {
    return CLIMO_CFG.WINDOWS.map(({ days, label }) => {
        const maxMissing = days * CLIMO_CFG.MAX_MISSING_FRAC;

        const a = _climoSumWindow(actualMap, asOf, days);
        const actualIn = a.missing > maxMissing ? null : Math.round(a.sum * 100) / 100;

        let snowActualIn = null;
        if (snowMap && snowMap.size > 0) {
            const s = _climoSumWindow(snowMap, asOf, days);
            if (s.missing <= maxMissing) snowActualIn = Math.round(s.sum * 100) / 100;
        }

        // Expected: mean of the same-length windows ending at the same
        // calendar date in each of the prior BASELINE_YEARS years.
        const yearSums = [];
        for (let k = 1; k <= CLIMO_CFG.BASELINE_YEARS; k++) {
            const y = _climoSumWindow(baselineMap, _climoAnchor(asOf, k), days);
            if (y.missing <= maxMissing) yearSums.push(y.sum);
        }
        const expectedIn = yearSums.length >= CLIMO_CFG.MIN_BASELINE_YEARS
            ? Math.round((yearSums.reduce((s, v) => s + v, 0) / yearSums.length) * 100) / 100
            : null;

        let pctDeparture = null;
        if (actualIn !== null && expectedIn !== null && expectedIn >= CLIMO_CFG.MIN_EXPECTED_IN) {
            pctDeparture = Math.round((actualIn - expectedIn) / expectedIn * 100);
        }

        return { days, label, actualIn, expectedIn, snowActualIn, pctDeparture,
                 yearsUsed: yearSums.length };
    });
}

// ── ERA5 latency top-up ──────────────────────────────────────────────────────
// Fill trailing null dates in the actuals map from the forecast daily block
// (past_days=7, already in inches). Never fills future dates.

function _climoTopUp(actualMap, forecastDaily, todayIso) {
    if (!forecastDaily || !forecastDaily.time || !forecastDaily.precipitation_sum) return;
    for (let i = 0; i < forecastDaily.time.length; i++) {
        const date = forecastDaily.time[i];
        if (date > todayIso) continue;
        const existing = actualMap.get(date);
        if (existing !== null && existing !== undefined) continue;
        const v = forecastDaily.precipitation_sum[i];
        if (v !== null && v !== undefined && actualMap.has(date)) {
            actualMap.set(date, v);
        }
    }
}

// Last date ≤ todayIso in the map with a non-null value.
function _climoLastDataDate(actualMap, todayIso) {
    let d = todayIso;
    for (let i = 0; i < 30; i++) {
        const v = actualMap.get(d);
        if (v !== null && v !== undefined) return d;
        d = _climoAddDays(d, -1);
    }
    return null;
}

// ── localStorage persistence (aggregates only, keyed by location) ────────────

function _climoLoadStore() {
    try {
        const raw = localStorage.getItem(CLIMO_CFG.STORAGE_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch (_) { return {}; }
}

function _climoSaveEntry(key, entry) {
    try {
        const store = _climoLoadStore();
        store[key] = entry;
        // LRU prune by _savedAt
        const keys = Object.keys(store);
        if (keys.length > CLIMO_CFG.MAX_CACHED_LOCATIONS) {
            keys.sort((a, b) => new Date(store[a]._savedAt) - new Date(store[b]._savedAt));
            for (const k of keys.slice(0, keys.length - CLIMO_CFG.MAX_CACHED_LOCATIONS)) {
                delete store[k];
            }
        }
        localStorage.setItem(CLIMO_CFG.STORAGE_KEY, JSON.stringify(store));
    } catch (err) {
        console.warn('[Climo] cache save failed:', err.message);
    }
}

// ── Public: synchronous cache read (any age) for first paint ─────────────────

function getCachedClimatology(lat, lon) {
    const key = _climoKey(lat, lon);
    if (_climoMem.has(key)) return _climoMem.get(key);
    const entry = _climoLoadStore()[key] || null;
    if (entry) _climoMem.set(key, entry);
    return entry;
}

// ── Public: fetch (cache-first, dedupe, stale-if-error) ──────────────────────
// forecastDaily: openMeteoData.daily from the Tier-1 forecast (for tail top-up).

async function fetchClimatology(lat, lon, forecastDaily) {
    const key = _climoKey(lat, lon);
    const now = Date.now();

    const cached = getCachedClimatology(lat, lon);
    const actualsFresh = cached && (now - new Date(cached._savedAt)) < CLIMO_CFG.ACTUALS_TTL_MS;
    if (actualsFresh) return cached;

    if (_climoPendingByKey.has(key)) return _climoPendingByKey.get(key);

    const promise = (async () => {
        try {
            const todayIso = new Date().toISOString().slice(0, 10);

            // Call A — actuals (last 365 days)
            const actualsDaily = await fetchArchiveDaily(
                lat, lon,
                _climoAddDays(todayIso, -364), todayIso,
                'precipitation_sum,snowfall_sum'
            );
            if (!actualsDaily) throw new Error('archive returned no daily block');

            const actualMap = _climoDateMap(actualsDaily.time, actualsDaily.precipitation_sum);
            // Open-Meteo snowfall stays in cm even with precipitation_unit=inch
            const snowMap = _climoDateMap(
                actualsDaily.time,
                (actualsDaily.snowfall_sum || []).map(v => v === null || v === undefined ? null : v / 2.54)
            );
            _climoTopUp(actualMap, forecastDaily, todayIso);

            const asOf = _climoLastDataDate(actualMap, todayIso);
            if (!asOf) throw new Error('no recent archive data for location');
            let gap = 0;
            for (let d = todayIso; d > asOf; d = _climoAddDays(d, -1)) gap++;

            const baselineFresh = cached && cached._baselineSavedAt &&
                (now - new Date(cached._baselineSavedAt)) < CLIMO_CFG.BASELINE_TTL_MS;

            let windows, baselineYears, baselineSavedAt;
            if (baselineFresh) {
                // Baseline aggregates still valid — recompute actuals only and
                // reuse stored expected values (anchor drift within 30 d is noise).
                windows = _climoComputeWindows(actualMap, snowMap, new Map(), asOf)
                    .map(w => {
                        const prev = cached.windows.find(p => p.days === w.days);
                        if (!prev) return w;
                        const expectedIn = prev.expectedIn;
                        let pctDeparture = null;
                        if (w.actualIn !== null && expectedIn !== null && expectedIn >= CLIMO_CFG.MIN_EXPECTED_IN) {
                            pctDeparture = Math.round((w.actualIn - expectedIn) / expectedIn * 100);
                        }
                        return { ...w, expectedIn, pctDeparture, yearsUsed: prev.yearsUsed };
                    });
                baselineYears = cached.baselineYears;
                baselineSavedAt = cached._baselineSavedAt;
            } else {
                // Call B — baseline (10 prior years, one call)
                const baseStart = _climoAddDays(_climoAnchor(todayIso, CLIMO_CFG.BASELINE_YEARS), -364);
                const baseEnd = _climoAnchor(todayIso, 1);
                const baselineDaily = await fetchArchiveDaily(
                    lat, lon, baseStart, baseEnd, 'precipitation_sum'
                );
                if (!baselineDaily) throw new Error('archive returned no baseline block');
                const baselineMap = _climoDateMap(baselineDaily.time, baselineDaily.precipitation_sum);

                windows = _climoComputeWindows(actualMap, snowMap, baselineMap, asOf);
                const thisYear = Number(todayIso.slice(0, 4));
                baselineYears = Array.from({ length: CLIMO_CFG.BASELINE_YEARS },
                    (_, i) => thisYear - CLIMO_CFG.BASELINE_YEARS + i);
                baselineSavedAt = new Date().toISOString();
            }

            const entry = {
                windows, asOf, baselineYears,
                source: 'ERA5',
                actualsGapDays: gap,
                _savedAt: new Date().toISOString(),
                _baselineSavedAt: baselineSavedAt,
            };
            _climoMem.set(key, entry);
            _climoSaveEntry(key, entry);
            return entry;
        } catch (err) {
            console.warn('[Climo] fetch failed:', err.message);
            return cached || null;   // stale-if-error
        } finally {
            _climoPendingByKey.delete(key);
        }
    })();

    _climoPendingByKey.set(key, promise);
    return promise;
}
