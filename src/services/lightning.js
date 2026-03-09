// Lightning Service — Blitzortung WebSocket, rolling buffer, state summarization
// Maintains a persistent WebSocket connection to Blitzortung for real-time lightning
// strike data. Accumulates strikes in a rolling 30-minute buffer. On each nowcast
// poll cycle, summarizeLightningBuffer() classifies the lightning state.
//
// Exports (globals): startLightning, stopLightning, summarizeLightningBuffer

// ── Configuration ────────────────────────────────────────────────────────────

const LIGHTNING_CFG = {
    WS_URLS: [
        'wss://ws1.blitzortung.org/',
        'wss://ws7.blitzortung.org/',
        'wss://ws8.blitzortung.org/',
    ],
    BUFFER_MAX_AGE_MS: 30 * 60 * 1000,  // 30 min rolling window
    ACTIVE_WINDOW_MS:  15 * 60 * 1000,  // 15 min for active/nearby classification
    BBOX_PADDING_DEG:  0.5,             // ~55 km padding around point for WS subscription
    RECONNECT_BASE_MS: 1000,            // exponential backoff base
    RECONNECT_MAX_MS:  60 * 1000,       // 60s cap
    MILES_PER_DEG_LAT: 69.0,            // approximate
};

// ── State ────────────────────────────────────────────────────────────────────

let _lxBuffer = [];               // [{ lat, lon, timeMs }]
let _lxWs = null;
let _lxWsConnected = false;
let _lxReconnectTimer = null;
let _lxReconnectDelay = LIGHTNING_CFG.RECONNECT_BASE_MS;
let _lxWsIndex = 0;               // rotate through WS_URLS on failure
let _lxLat = null;
let _lxLon = null;
let _lxLastStrikeAt = null;
let _lxStopped = true;            // true when stopLightning() has been called

// ── Distance helper ──────────────────────────────────────────────────────────
// Equirectangular approximation — fast, accurate enough within 50 km.

function _strikeMiles(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * LIGHTNING_CFG.MILES_PER_DEG_LAT;
    const avgLatRad = ((lat1 + lat2) / 2) * Math.PI / 180;
    const dLon = (lon2 - lon1) * LIGHTNING_CFG.MILES_PER_DEG_LAT * Math.cos(avgLatRad);
    return Math.sqrt(dLat * dLat + dLon * dLon);
}

// ── Buffer management ────────────────────────────────────────────────────────

function _pruneBuffer() {
    const cutoff = Date.now() - LIGHTNING_CFG.BUFFER_MAX_AGE_MS;
    _lxBuffer = _lxBuffer.filter(s => s.timeMs >= cutoff);
}

function _addStrike(lat, lon, timeMs) {
    if (lat == null || lon == null || !isFinite(lat) || !isFinite(lon)) return;
    if (timeMs > Date.now() + 60000) return; // reject future timestamps (>1 min ahead)

    _lxBuffer.push({ lat, lon, timeMs });
    _lxLastStrikeAt = new Date(timeMs).toISOString();

    // Prune periodically to avoid unbounded growth
    if (_lxBuffer.length % 50 === 0) _pruneBuffer();
}

// ── WebSocket lifecycle ──────────────────────────────────────────────────────

function _lxConnect() {
    if (_lxStopped) return;
    if (_lxWs) {
        try { _lxWs.close(); } catch (_) {}
    }

    const url = LIGHTNING_CFG.WS_URLS[_lxWsIndex % LIGHTNING_CFG.WS_URLS.length];
    console.log(`[Lightning] Connecting to ${url}`);

    try {
        _lxWs = new WebSocket(url);
    } catch (err) {
        console.warn('[Lightning] WebSocket constructor failed:', err.message);
        _lxScheduleReconnect();
        return;
    }

    _lxWs.onopen = () => {
        console.log('[Lightning] WebSocket connected');
        _lxWsConnected = true;
        _lxReconnectDelay = LIGHTNING_CFG.RECONNECT_BASE_MS;

        // Subscribe to area around current location
        if (_lxLat != null && _lxLon != null) {
            _lxSubscribe(_lxLat, _lxLon);
        }
    };

    _lxWs.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.lat != null && data.lon != null && data.time != null) {
                // Blitzortung time is in nanoseconds — convert to ms
                const timeMs = typeof data.time === 'number' && data.time > 1e15
                    ? Math.floor(data.time / 1e6)
                    : data.time;
                _addStrike(data.lat, data.lon, timeMs);
            }
        } catch (_) {
            // Ignore malformed messages
        }
    };

    _lxWs.onerror = () => {
        console.warn('[Lightning] WebSocket error');
    };

    _lxWs.onclose = () => {
        console.log('[Lightning] WebSocket closed');
        _lxWsConnected = false;
        _lxWs = null;
        if (!_lxStopped) _lxScheduleReconnect();
    };
}

function _lxSubscribe(lat, lon) {
    if (!_lxWs || _lxWs.readyState !== WebSocket.OPEN) return;

    const pad = LIGHTNING_CFG.BBOX_PADDING_DEG;
    const msg = JSON.stringify({
        west:  Math.round((lon - pad) * 10) / 10,
        east:  Math.round((lon + pad) * 10) / 10,
        north: Math.round((lat + pad) * 10) / 10,
        south: Math.round((lat - pad) * 10) / 10
    });
    _lxWs.send(msg);
    console.log('[Lightning] Subscribed to region:', msg);
}

function _lxScheduleReconnect() {
    if (_lxReconnectTimer || _lxStopped) return;

    _lxReconnectTimer = setTimeout(() => {
        _lxReconnectTimer = null;
        _lxWsIndex++;
        _lxConnect();
    }, _lxReconnectDelay);

    // Exponential backoff
    _lxReconnectDelay = Math.min(
        _lxReconnectDelay * 2,
        LIGHTNING_CFG.RECONNECT_MAX_MS
    );
}

// ── Public: start / stop ─────────────────────────────────────────────────────

function startLightning(lat, lon) {
    _lxLat = lat;
    _lxLon = lon;
    _lxBuffer = [];
    _lxLastStrikeAt = null;
    _lxStopped = false;

    // If already connected, just resubscribe to new region
    if (_lxWs && _lxWs.readyState === WebSocket.OPEN) {
        _lxSubscribe(lat, lon);
        return;
    }

    _lxConnect();
}

function stopLightning() {
    _lxStopped = true;
    if (_lxReconnectTimer) {
        clearTimeout(_lxReconnectTimer);
        _lxReconnectTimer = null;
    }
    if (_lxWs) {
        try { _lxWs.close(); } catch (_) {}
        _lxWs = null;
    }
    _lxWsConnected = false;
    _lxBuffer = [];
    _lxLastStrikeAt = null;
    _lxLat = null;
    _lxLon = null;
}

// ── Public: summarize buffer into lightningState ────────────────────────────
// Called each nowcast poll cycle. Classifies lightning proximity and recency
// into a state object that the nowcast merge logic uses.

function summarizeLightningBuffer(lat, lon) {
    _pruneBuffer();

    const now = Date.now();
    const activeWindow = now - LIGHTNING_CFG.ACTIVE_WINDOW_MS;

    // Compute distances and bucket strikes by proximity and recency
    let nearestMi = null;
    let within5mi_15m  = 0;
    let within10mi_15m = 0;
    let within20mi_30m = 0;

    for (const strike of _lxBuffer) {
        const dist = _strikeMiles(lat, lon, strike.lat, strike.lon);
        if (dist > 25) continue; // skip distant strikes

        // Track nearest from the active window only
        if (strike.timeMs >= activeWindow) {
            if (nearestMi === null || dist < nearestMi) nearestMi = dist;
        }

        if (dist <= 5  && strike.timeMs >= activeWindow) within5mi_15m++;
        if (dist <= 10 && strike.timeMs >= activeWindow) within10mi_15m++;
        if (dist <= 20) within20mi_30m++;  // full 30-min window (already pruned)
    }

    if (nearestMi !== null) nearestMi = Math.round(nearestMi * 10) / 10;

    // Classify state from distance/recency thresholds
    let state = 'none';
    let confidence = 'none';

    if (within5mi_15m > 0) {
        state = 'active';
        confidence = 'high';
    } else if (within10mi_15m > 0) {
        state = 'nearby';
        confidence = 'high';
    } else if (within20mi_30m > 0) {
        state = 'approaching';
        confidence = 'medium';
    }

    return {
        state,
        nearestStrikeMi: nearestMi,
        strikeCounts: {
            within5mi:  within5mi_15m,
            within10mi: within10mi_15m,
            within20mi: within20mi_30m,
        },
        updatedAt: new Date().toISOString(),
        source: 'lightning',
        confidence,
        wsConnected: _lxWsConnected,
        bufferAgeMs: _lxLastStrikeAt
            ? now - new Date(_lxLastStrikeAt).getTime()
            : null,
        lastStrikeAt: _lxLastStrikeAt,
    };
}
