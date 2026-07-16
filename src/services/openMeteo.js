// Open-Meteo service — all fetch functions return data objects, no DOM
//
// All outbound Open-Meteo requests go through _omFetch(), which enforces:
//   - Daily request budget (soft cap, persisted in localStorage by UTC date)
//   - 60-minute cooldown after a 429 (or RateLimit reason) response
//   - Small exponential backoff on 5xx / network errors only (never on 429)
// Status is exposed via getOpenMeteoStatus() so the UI can warn the user
// instead of silently dying.

const _OM_BUDGET_KEY      = 'openMeteoBudget';        // { date: 'YYYY-MM-DD', count: N }
const _OM_COOLDOWN_KEY    = 'openMeteoCooldownUntil'; // epoch ms
const _OM_DAILY_SOFT_CAP  = 7500;                     // stay below the ~10k free-tier ceiling
const _OM_COOLDOWN_MS     = 60 * 60 * 1000;           // 60 min after a 429
const _OM_MAX_RETRIES     = 3;                        // retries on 5xx/network only

let _omWarnedCooldown = false;
let _omWarnedBudget   = false;

function _omTodayUtc() {
    return new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

function _omReadBudget() {
    try {
        const raw = localStorage.getItem(_OM_BUDGET_KEY);
        if (!raw) return { date: _omTodayUtc(), count: 0 };
        const parsed = JSON.parse(raw);
        if (parsed.date !== _omTodayUtc()) {
            // Day rolled over — reset
            return { date: _omTodayUtc(), count: 0 };
        }
        return parsed;
    } catch {
        return { date: _omTodayUtc(), count: 0 };
    }
}

function _omWriteBudget(b) {
    try { localStorage.setItem(_OM_BUDGET_KEY, JSON.stringify(b)); } catch {}
}

function _omIncrementBudget() {
    const b = _omReadBudget();
    b.count += 1;
    _omWriteBudget(b);
    return b;
}

function _omReadCooldownUntil() {
    try {
        const raw = localStorage.getItem(_OM_COOLDOWN_KEY);
        return raw ? parseInt(raw, 10) || 0 : 0;
    } catch { return 0; }
}

function _omSetCooldown(untilMs) {
    try { localStorage.setItem(_OM_COOLDOWN_KEY, String(untilMs)); } catch {}
}

function _omClearCooldown() {
    try { localStorage.removeItem(_OM_COOLDOWN_KEY); } catch {}
    _omWarnedCooldown = false;
}

// Public status object — UI can poll this to render a banner.
function getOpenMeteoStatus() {
    const now = Date.now();
    const cooldownUntil = _omReadCooldownUntil();
    const budget = _omReadBudget();
    const inCooldown = cooldownUntil > now;
    const overBudget = budget.count >= _OM_DAILY_SOFT_CAP;
    return {
        inCooldown,
        cooldownRemainingMs: inCooldown ? (cooldownUntil - now) : 0,
        overBudget,
        budgetUsed: budget.count,
        budgetCap: _OM_DAILY_SOFT_CAP,
        budgetDate: budget.date,
        blocked: inCooldown || overBudget,
    };
}

function _omSleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// Centralized fetch wrapper for ALL Open-Meteo endpoints.
// Throws on rate-limit / budget-exceeded / unrecoverable error so callers
// can choose to swallow (fetchAirQuality, fetchTabTemp) or propagate
// (fetchForecast).
async function _omFetch(url) {
    const status = getOpenMeteoStatus();
    if (status.inCooldown) {
        if (!_omWarnedCooldown) {
            console.warn(`[Open-Meteo] In cooldown for ${Math.round(status.cooldownRemainingMs / 60000)} min — short-circuiting all requests.`);
            _omWarnedCooldown = true;
        }
        throw new Error('Open-Meteo: in cooldown');
    }
    if (status.overBudget) {
        if (!_omWarnedBudget) {
            console.warn(`[Open-Meteo] Daily soft cap reached (${status.budgetUsed}/${status.budgetCap}) — short-circuiting all requests until UTC midnight.`);
            _omWarnedBudget = true;
        }
        throw new Error('Open-Meteo: daily budget exceeded');
    }

    // Reset budget warning when we cross into a new UTC day
    if (status.budgetUsed === 0) _omWarnedBudget = false;

    let lastErr = null;
    for (let attempt = 0; attempt < _OM_MAX_RETRIES; attempt++) {
        try {
            // Count every attempt against budget — Open-Meteo bills attempts, not successes
            _omIncrementBudget();
            const response = await fetch(url);

            // 429: rate limited. Set cooldown immediately. Never retry.
            if (response.status === 429) {
                _omSetCooldown(Date.now() + _OM_COOLDOWN_MS);
                _omWarnedCooldown = false;
                console.warn('[Open-Meteo] Received 429 — entering 60-min cooldown.');
                throw new Error('Open-Meteo: HTTP 429 rate limited');
            }

            // 5xx: retryable
            if (response.status >= 500 && response.status < 600) {
                lastErr = new Error(`Open-Meteo: HTTP ${response.status}`);
                if (attempt < _OM_MAX_RETRIES - 1) {
                    await _omSleep(1000 * Math.pow(2, attempt)); // 1s, 2s, 4s
                    continue;
                }
                throw lastErr;
            }

            if (!response.ok) {
                throw new Error(`Open-Meteo: HTTP ${response.status}`);
            }

            const data = await response.json();
            // Surface API-reported rate limiting from JSON body too
            if (data && data.error && /rate.?limit|too.?many/i.test(data.reason || '')) {
                _omSetCooldown(Date.now() + _OM_COOLDOWN_MS);
                _omWarnedCooldown = false;
                throw new Error(`Open-Meteo: ${data.reason}`);
            }
            // We made it through cleanly — clear any stale cooldown
            if (_omReadCooldownUntil() > 0 && _omReadCooldownUntil() < Date.now()) {
                _omClearCooldown();
            }
            return data;
        } catch (err) {
            // 429 / budget errors are not retryable
            if (/429|cooldown|budget|rate.?limit/i.test(err.message)) throw err;
            lastErr = err;
            // Network error — retry with backoff
            if (attempt < _OM_MAX_RETRIES - 1) {
                await _omSleep(1000 * Math.pow(2, attempt));
                continue;
            }
            throw lastErr;
        }
    }
    throw lastErr || new Error('Open-Meteo: unknown error');
}

async function fetchForecast(lat, lon) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
        `&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl,cloud_cover,uv_index,dew_point_2m,is_day` +
        `&hourly=temperature_2m,relative_humidity_2m,dew_point_2m,apparent_temperature,precipitation_probability,precipitation,snowfall,snow_depth,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,uv_index,pressure_msl,is_day` +
        `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,sunrise,sunset,snowfall_sum,uv_index_max` +
        `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=auto&past_days=7&forecast_days=7`;
    const data = await _omFetch(url);
    if (data.error) throw new Error(data.reason || 'Open-Meteo API error');
    return data;
}

async function fetchAirQuality(lat, lon) {
    try {
        const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=us_aqi,pm10,pm2_5&hourly=us_aqi&past_days=7&forecast_days=7&timezone=auto`;
        const data = await _omFetch(url);
        if (data.error) {
            console.warn('[AQI] API returned error:', data.reason || data.error);
            return null;
        }
        return data;
    } catch (error) {
        console.warn('[AQI] fetch failed:', error.message);
        return null;
    }
}

// Historical daily data from the ERA5 archive (climatology feature).
// Routed through _omFetch so budget / 429 cooldown / backoff all apply.
// dailyVars: comma-separated list, e.g. 'precipitation_sum,snowfall_sum'.
// Returns the `daily` block ({ time: [...], <var>: [...] }) or null.
async function fetchArchiveDaily(lat, lon, startDate, endDate, dailyVars) {
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}` +
        `&start_date=${startDate}&end_date=${endDate}` +
        `&daily=${dailyVars}` +
        `&precipitation_unit=inch&timezone=auto`;
    const data = await _omFetch(url);
    if (data.error) throw new Error(data.reason || 'Open-Meteo archive error');
    return data.daily || null;
}

// fetchModelComparison moved to src/services/modelComparison.js

// Lightweight fetch for tab temperature badges + model context for logging.
// Returns { temp, code, is_day, modelContext } or null on error.
async function fetchTabTemp(lat, lon) {
    try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
            + `&current=temperature_2m,weather_code,is_day,cloud_cover,dew_point_2m`
            + `,relative_humidity_2m,wind_speed_10m,wind_direction_10m,pressure_msl,precipitation`
            + `&temperature_unit=fahrenheit&timezone=auto`;
        const data = await _omFetch(url);
        if (data.current) {
            const c = data.current;
            return {
                temp: Math.round(c.temperature_2m),
                code: c.weather_code,
                is_day: c.is_day === 1,
                modelContext: {
                    weatherCode: c.weather_code ?? null,
                    precipProb: null, // not available in current endpoint
                    precipitation: c.precipitation ?? null,
                    cloudCover: c.cloud_cover ?? null,
                    temp: c.temperature_2m ?? null,
                    dewpoint: c.dew_point_2m ?? null,
                    humidity: c.relative_humidity_2m ?? null,
                    windSpeed: c.wind_speed_10m ?? null,
                    windDir: c.wind_direction_10m ?? null,
                    pressure: c.pressure_msl ?? null,
                },
            };
        }
        return null;
    } catch (error) {
        return null;
    }
}
