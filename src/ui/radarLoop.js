// Future Radar — observed NEXRAD loop running into HRRR forecast reflectivity
// A Leaflet map with raster tiles only (no WebGL). Only one exists at a time; it
// is torn down whenever the Weather Maps card re-renders or the location changes.
// Tiles: IEM (CORS *). Observed = ridge::USCOMP-N0Q composite at 5-min steps;
// forecast = HRRR simulated reflectivity (hrrr::REFD), pinned to one model run.
// Globals read: L (Leaflet), cachedUtcOffsetSec, _isDataConstrained (lightning.js),
//               formatClockTimeRounded (format.js)

const RADAR_LOOP_CFG = {
    IEM:              'https://mesonet.agron.iastate.edu',
    PAST_FRAMES:      12,    // 1 h of observed radar at 5-min steps
    PAST_FRAMES_LITE: 6,     // data saver
    FINE_STEP_MIN:    15,    // HRRR steps for the first FINE_HOURS…
    FINE_HOURS:       6,     // …then hourly out to the HRRR horizon
    HRRR_MAX_MIN:     1080,  // IEM serves REFD out to 18 h
    FRAME_MS:         700,   // playback speed
    END_PAUSE_MS:     1500,  // hold on the last frame before looping
    MAX_LOAD_WAITS:   6,     // × 250 ms waiting for the next frame's tiles
    KEEP_AROUND:      3,     // frames kept loaded either side of the current one
    REBUILD_AFTER_MS: 10 * 60 * 1000, // refresh the frame list when this stale
    PREFETCH_DELAY_MS: 1500,          // after the map card renders, so its embed loads first
    PREFETCH_FRESH_MS: 4 * 60 * 1000, // HRRR tiles cache for 5 min, so reuse within 4
    BASEMAP:          'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    ZOOM:             7,
    OPACITY:          0.75,
    // IEM's N0Q composite and the HRRR domain cover the lower 48 only
    BOUNDS:           { south: 22, north: 52, west: -128, east: -64 },
};

// ── State ────────────────────────────────────────────────────────────────────

let _rlMap = null;
let _rlFrames = [];        // [{ kind: 'obs'|'hrrr', validMs, url, layer, loaded }]
let _rlIndex = 0;
let _rlTimer = null;
let _rlPlaying = false;
let _rlLoadWaits = 0;
let _rlGen = 0;            // bumps on every start/stop so stale async work drops out
let _rlLocation = null;
let _rlInitMs = null;      // HRRR run init time (null = no forecast frames)
let _rlBuiltAt = 0;
let _rlPrefetch = null;    // { key, at, meta: Promise<{ newestObsMs, initMs }>, images: [] }
let _rlPrefetchTimer = null;

function radarLoopCovers(location) {
    const b = RADAR_LOOP_CFG.BOUNDS;
    return location.lat >= b.south && location.lat <= b.north &&
        location.lon >= b.west && location.lon <= b.east;
}

// ── Frame list ───────────────────────────────────────────────────────────────

function _rlStamp(ms) {
    const d = new Date(ms);
    return d.getUTCFullYear().toString() +
        String(d.getUTCMonth() + 1).padStart(2, '0') +
        String(d.getUTCDate()).padStart(2, '0') +
        String(d.getUTCHours()).padStart(2, '0') +
        String(d.getUTCMinutes()).padStart(2, '0');
}

// Newest composite IEM has actually built — the current 5-min slot often isn't ready yet
async function _rlNewestObsMs() {
    try {
        const r = await fetch(`${RADAR_LOOP_CFG.IEM}/json/tms.json`, { cache: 'no-store' });
        const j = await r.json();
        const svc = (j.services || []).find(s => s.id === 'ridge_uscomp_n0q');
        const ms = svc ? Date.parse(svc.utc_valid) : NaN;
        if (Number.isFinite(ms)) return ms;
    } catch (e) {
        console.warn('[RadarLoop] tms.json failed:', e.message);
    }
    const slot = 5 * 60 * 1000;
    return Math.floor(Date.now() / slot) * slot - slot;
}

// Init time of the HRRR run IEM is serving (it lags real time by ~2–3 h)
async function _rlHrrrInitMs() {
    try {
        const r = await fetch(`${RADAR_LOOP_CFG.IEM}/data/gis/images/4326/hrrr/refd_0000.json`, { cache: 'no-store' });
        const j = await r.json();
        const ms = Date.parse(j.model_init_utc);
        return Number.isFinite(ms) ? ms : null;
    } catch (e) {
        console.warn('[RadarLoop] HRRR run lookup failed:', e.message);
        return null;
    }
}

function _rlBuildFrames(newestObsMs, initMs, lite) {
    const cfg = RADAR_LOOP_CFG;
    const frames = [];
    const pastCount = lite ? cfg.PAST_FRAMES_LITE : cfg.PAST_FRAMES;
    for (let i = pastCount - 1; i >= 0; i--) {
        const t = newestObsMs - i * 5 * 60 * 1000;
        frames.push({
            kind: 'obs', validMs: t,
            url: `${cfg.IEM}/c/tile.py/1.0.0/ridge::USCOMP-N0Q-${_rlStamp(t)}/{z}/{x}/{y}.png`
        });
    }
    if (initMs === null) return frames;

    // HRRR frames valid after the newest observation: 15-min steps for the first
    // hours, hourly after that (hourly only on data saver). Init is on the hour,
    // so m % 60 === 0 means the frame is valid on the hour.
    const initTs = _rlStamp(initMs);
    const fineEnd = newestObsMs + cfg.FINE_HOURS * 3600 * 1000;
    for (let m = 0; m <= cfg.HRRR_MAX_MIN; m += cfg.FINE_STEP_MIN) {
        const t = initMs + m * 60000;
        if (t <= newestObsMs) continue;
        if ((lite || t > fineEnd) && m % 60 !== 0) continue;
        frames.push({
            kind: 'hrrr', validMs: t,
            url: `${cfg.IEM}/cache/tile.py/1.0.0/hrrr::REFD-F${String(m).padStart(4, '0')}-${initTs}/{z}/{x}/{y}.png`
        });
    }
    return frames;
}

// ── Background prefetch ──────────────────────────────────────────────────────
// While another map tab is showing, fetch the frame list and load the tiles the
// Future Radar tab paints first, so tapping it opens without a wait.

function _rlKey(location) {
    return `${location.lat.toFixed(3)},${location.lon.toFixed(3)}`;
}

function _rlFetchMeta() {
    return Promise.all([_rlNewestObsMs(), _rlHrrrInitMs()])
        .then(([newestObsMs, initMs]) => ({ newestObsMs, initMs }));
}

// Frame-list inputs for this location: a fresh prefetch if there is one
function _rlMetaFor(location) {
    const p = _rlPrefetch;
    if (p && p.key === _rlKey(location) && Date.now() - p.at < RADAR_LOOP_CFG.PREFETCH_FRESH_MS) return p.meta;
    return _rlFetchMeta();
}

// The tiles Leaflet will request for a map this size centred on the location —
// same maths as L.GridLayer (floored pixel centre ± half size → floor/ceil tile range)
function _rlTileRange(lat, lon, zoom, width, height) {
    const n = Math.pow(2, zoom);
    const s = Math.sin(lat * Math.PI / 180);
    const px = Math.floor((lon + 180) / 360 * 256 * n);
    const py = Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * n);
    const x0 = Math.floor((px - width / 2) / 256), x1 = Math.ceil((px + width / 2) / 256) - 1;
    const y0 = Math.max(0, Math.floor((py - height / 2) / 256));
    const y1 = Math.min(n - 1, Math.ceil((py + height / 2) / 256) - 1);
    const tiles = [];
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) tiles.push({ x: ((x % n) + n) % n, y });
    }
    return tiles;
}

async function prefetchRadarLoop(location) {
    if (!radarLoopCovers(location)) return;
    const cfg = RADAR_LOOP_CFG;
    const key = _rlKey(location);
    if (_rlPrefetch && _rlPrefetch.key === key && Date.now() - _rlPrefetch.at < cfg.PREFETCH_FRESH_MS) return;
    const entry = { key, at: Date.now(), meta: _rlFetchMeta(), images: [] };
    _rlPrefetch = entry;
    // On data saver only the (tiny) frame list is fetched ahead
    if (typeof _isDataConstrained === 'function' && _isDataConstrained()) return;

    const { newestObsMs, initMs } = await entry.meta;
    if (_rlPrefetch !== entry) return;
    // Size of the map the tab will open with (.radar-loop-map: 560px, max 65vh)
    const box = document.querySelector('.satellite-card .satellite-container');
    const width = box ? box.clientWidth : window.innerWidth;
    const height = Math.min(560, Math.round(window.innerHeight * 0.65));
    const frames = _rlBuildFrames(newestObsMs, initMs, false);
    const now = frames.filter(f => f.kind === 'obs').length - 1;
    // The basemap plus the frames _rlShow loads around "now" (now-1 … now+2)
    const templates = [cfg.BASEMAP, ...frames.slice(Math.max(0, now - 1), now + 3).map(f => f.url)];
    for (const tpl of templates) {
        for (const { x, y } of _rlTileRange(location.lat, location.lon, cfg.ZOOM, width, height)) {
            const img = new Image();
            img.src = tpl.replace('{z}', cfg.ZOOM).replace('{x}', x).replace('{y}', y);
            entry.images.push(img); // held so the page keeps the loaded tiles for Leaflet to reuse
        }
    }
}

function scheduleRadarLoopPrefetch(location) {
    clearTimeout(_rlPrefetchTimer);
    if (!radarLoopCovers(location)) return;
    _rlPrefetchTimer = setTimeout(() => {
        _rlPrefetchTimer = null;
        prefetchRadarLoop(location);
    }, RADAR_LOOP_CFG.PREFETCH_DELAY_MS);
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

async function startRadarLoop(location, autoplay = false) {
    stopRadarLoop();
    const gen = _rlGen;
    const el = document.getElementById('radarLoopMap');
    if (!el || typeof L === 'undefined') return;
    const cfg = RADAR_LOOP_CFG;
    _rlLocation = location;

    const map = L.map(el, {
        center: [location.lat, location.lon],
        zoom: cfg.ZOOM,
        minZoom: 4,
        maxZoom: 10,
        scrollWheelZoom: false,          // don't trap page scrolling
        dragging: !L.Browser.mobile,     // one finger scrolls the page; pinch zooms
    });
    _rlMap = map;

    // Keyless OSM tiles (fine for a small app under the OSM tile policy), darkened
    // by the .rl-basemap CSS filter to match the app; the radar layers stay unfiltered
    L.tileLayer(cfg.BASEMAP, {
        className: 'rl-basemap',
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors · Radar: NOAA via <a href="https://mesonet.agron.iastate.edu" target="_blank" rel="noopener">IEM</a>'
    }).addTo(map);
    L.circleMarker([location.lat, location.lon], {
        radius: 6, color: '#fff', weight: 2, fillColor: '#3b82f6', fillOpacity: 1, interactive: false
    }).addTo(map);

    const lite = typeof _isDataConstrained === 'function' && _isDataConstrained();
    const { newestObsMs, initMs } = await _rlMetaFor(location);
    if (gen !== _rlGen) return; // card re-rendered or location switched meanwhile

    _rlInitMs = initMs;
    _rlFrames = _rlBuildFrames(newestObsMs, initMs, lite);
    _rlBuiltAt = Date.now();
    _rlRenderControls();
    _rlShow(_rlFrames.filter(f => f.kind === 'obs').length - 1); // open on "now"
    if (autoplay) _rlSetPlaying(true);
}

function stopRadarLoop() {
    _rlGen++;
    clearTimeout(_rlTimer);
    _rlTimer = null;
    // A pending prefetch belongs to the card being torn down (or the old location)
    clearTimeout(_rlPrefetchTimer);
    _rlPrefetchTimer = null;
    _rlPlaying = false;
    _rlLoadWaits = 0;
    if (_rlMap) {
        try { _rlMap.remove(); } catch (e) { /* container already detached */ }
        _rlMap = null;
    }
    _rlFrames = [];
}

// False (and tears down) once the dashboard re-render has detached the map
function _rlAlive() {
    if (_rlMap && document.body.contains(_rlMap.getContainer())) return true;
    stopRadarLoop();
    return false;
}

// ── Frames on the map ────────────────────────────────────────────────────────

function _rlEnsureLayer(i) {
    const f = _rlFrames[i];
    if (!f || f.layer) return;
    f.loaded = false;
    // Opacity 0 still loads the tiles, which is how frames preload
    f.layer = L.tileLayer(f.url, { opacity: 0, zIndex: 10 });
    f.layer.on('load', () => { f.loaded = true; });
    f.layer.addTo(_rlMap);
}

// Keep only a window of frames on the map so a phone doesn't hold every tile
function _rlDropFarLayers() {
    const n = _rlFrames.length;
    const keep = RADAR_LOOP_CFG.KEEP_AROUND;
    _rlFrames.forEach((f, i) => {
        if (!f.layer) return;
        const d = Math.abs(i - _rlIndex);
        if (Math.min(d, n - d) > keep) {   // wrap-around: the loop restarts at 0
            _rlMap.removeLayer(f.layer);
            f.layer = null;
            f.loaded = false;
        }
    });
}

function _rlShow(i) {
    if (!_rlMap || !_rlFrames.length) return;
    _rlIndex = Math.max(0, Math.min(i, _rlFrames.length - 1));
    for (let k = _rlIndex - 1; k <= _rlIndex + 2; k++) _rlEnsureLayer((k + _rlFrames.length) % _rlFrames.length);
    _rlFrames.forEach((f, k) => {
        if (f.layer) f.layer.setOpacity(k === _rlIndex ? RADAR_LOOP_CFG.OPACITY : 0);
    });
    _rlDropFarLayers();
    _rlUpdateLabel();
}

// ── Playback ─────────────────────────────────────────────────────────────────

function _rlStep() {
    _rlTimer = null;
    if (!_rlPlaying || document.hidden || !_rlAlive()) return;
    const cfg = RADAR_LOOP_CFG;
    if (Date.now() - _rlBuiltAt > cfg.REBUILD_AFTER_MS) {
        startRadarLoop(_rlLocation, true);
        return;
    }
    const next = (_rlIndex + 1) % _rlFrames.length;
    _rlEnsureLayer(next);
    // Wait briefly for the next frame's tiles so the loop doesn't flash blank frames
    if (!_rlFrames[next].loaded && _rlLoadWaits < cfg.MAX_LOAD_WAITS) {
        _rlLoadWaits++;
        _rlTimer = setTimeout(_rlStep, 250);
        return;
    }
    _rlLoadWaits = 0;
    _rlShow(next);
    _rlTimer = setTimeout(_rlStep, next === _rlFrames.length - 1 ? cfg.END_PAUSE_MS : cfg.FRAME_MS);
}

function _rlSetPlaying(playing) {
    _rlPlaying = playing;
    clearTimeout(_rlTimer);
    _rlTimer = playing ? setTimeout(_rlStep, RADAR_LOOP_CFG.FRAME_MS) : null;
    const btn = document.getElementById('radarLoopPlay');
    if (btn) {
        btn.textContent = playing ? '⏸' : '▶';
        btn.setAttribute('aria-label', playing ? 'Pause radar loop' : 'Play radar loop');
    }
}

function toggleRadarLoopPlay() {
    if (!_rlAlive() || !_rlFrames.length) return;
    _rlSetPlaying(!_rlPlaying);
}

function seekRadarLoop(i) {
    if (!_rlAlive()) return;
    _rlSetPlaying(false);
    _rlShow(Number(i));
}

function recenterRadarLoop(location) {
    if (_rlMap) _rlMap.setView([location.lat, location.lon], RADAR_LOOP_CFG.ZOOM);
}

// Pause while the app is hidden; a resume after a long absence rebuilds the frames
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        clearTimeout(_rlTimer);
        _rlTimer = null;
    } else if (_rlPlaying && _rlAlive() && !_rlTimer) {
        _rlTimer = setTimeout(_rlStep, RADAR_LOOP_CFG.FRAME_MS);
    }
});

// ── Controls ─────────────────────────────────────────────────────────────────

function _rlRenderControls() {
    const slider = document.getElementById('radarLoopSlider');
    if (!slider) return;
    slider.max = String(Math.max(0, _rlFrames.length - 1));
    slider.disabled = _rlFrames.length < 2;
    // Track colour changes where observed radar ends and the HRRR forecast begins
    const obsCount = _rlFrames.filter(f => f.kind === 'obs').length;
    const seamPct = _rlFrames.length > 1 ? ((obsCount - 0.5) / (_rlFrames.length - 1)) * 100 : 100;
    slider.style.setProperty('--rl-seam', `${Math.min(100, seamPct).toFixed(1)}%`);
    const note = document.getElementById('radarLoopNote');
    if (note && _rlInitMs === null) note.textContent = 'HRRR forecast radar is unavailable right now — showing observed radar only.';
}

function _rlFormatAhead(min) {
    if (min < 60) return `+${min} min`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `+${h} h ${m} min` : `+${h} h`;
}

function _rlUpdateLabel() {
    const slider = document.getElementById('radarLoopSlider');
    if (slider) slider.value = String(_rlIndex);
    const el = document.getElementById('radarLoopTime');
    const f = _rlFrames[_rlIndex];
    if (!el || !f) return;
    const offset = typeof cachedUtcOffsetSec !== 'undefined' ? cachedUtcOffsetSec : null;
    const clock = formatClockTimeRounded(f.validMs, 5, offset);
    if (f.kind === 'obs') {
        const ago = Math.max(0, Math.round((Date.now() - f.validMs) / 60000));
        el.innerHTML = `<span class="rl-tag rl-tag-obs">Observed</span> ${clock} · ${ago} min ago`;
    } else {
        const ahead = Math.round((f.validMs - Date.now()) / 60000);
        const when = ahead > 0 ? _rlFormatAhead(ahead) : 'now';
        const run = `${String(new Date(_rlInitMs).getUTCHours()).padStart(2, '0')}Z run`;
        el.innerHTML = `<span class="rl-tag rl-tag-hrrr">HRRR forecast</span> ${clock} · ${when} · ${run}`;
    }
}
