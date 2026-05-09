# Weather HQ — Cleanup Roadmap

Phased cleanup plan ordered by impact and risk. Each phase is independent — complete one before starting the next.

Quick wins (Phase 0) are done. Remaining work below.

---

## Phase 1: Critical Duplication (est. 3–4 hours)

These are the highest-value changes — they eliminate the most maintenance burden with the least risk.

### 1A. Merge `fetchWeatherData` / `fetchWeatherDataDirect`
- **File**: `src/main.js`
- **Why**: 68% identical code. Every bug fix requires two edits. The only difference is geocoding.
- **How**: Keep `fetchWeatherDataDirect(lat, lon, location)`. Remove `fetchWeatherData()`. Move geocoding to its one caller (`init()` fallback path).
- **Lines removed**: ~70
- **Risk**: Low — callers already pass coordinates directly in most paths.

### 1B. Extract shared chart helpers
- **Files**: `src/ui/pressureChart.js`, `src/ui/aqiChart.js`, `src/ui/precipChart.js` → new `src/utils/chartHelpers.js`
- **Why**: `_pcXLabels()`, `_acXLabels()`, `_rrXLabels()` are copy-pasted. Same for `_niceStep()` and SVG grid construction.
- **How**: Create `chartHelpers.js` with `buildChartXLabels()`, `buildChartGrid()`, `niceStep()`. Replace in all three chart files.
- **Lines removed**: ~150
- **Risk**: Low — pure functions, easy to verify output matches.

### 1C. Consolidate distance calculations
- **Files**: `lightning.js`, `observations.js`, `geolocation.js` → new `src/utils/geo.js`
- **Why**: Three implementations of haversine with inconsistent units (miles vs meters).
- **How**: Create `geo.js` with `haversineDistanceMi(lat1, lon1, lat2, lon2)`. Replace in `observations.js` and `geolocation.js`. Lightning keeps its fast flat-earth approximation (add comment explaining why: hot path, <50mi range where error is <1%).
- **Lines removed**: ~20
- **Risk**: Low — math is well-understood; easy to unit test.

---

## Phase 2: Architecture — renderDashboard.js (est. 2–3 hours)

The largest file in the project. Extract business logic that doesn't belong in the UI layer.

### 2A. Extract nowcast display logic to service layer
- **From**: `src/ui/renderDashboard.js`
- **To**: new `src/services/nowcastDisplay.js`
- **Move these functions**:
  - `_pickNowcastLabel(state)` — condition label + icon selection
  - `_buildRationale(state)` — evidence sentence assembly
  - `_applyDisplayDamping(desc)` — hysteresis for label jitter
  - `_displayMemory` state object
  - `_isEscalation(oldDesc, newDesc)` — helper for damping
- **Why**: These are business logic (what condition to show), not rendering (how to show it). Currently called from both `renderCurrentCard()` and `updateNowcastDisplay()`, and also from `main.js` background fetch.
- **Risk**: Low — functions are pure or use isolated module state. No DOM access.

### 2B. Extract model spread computation
- **From**: `src/ui/renderDashboard.js` (inside `renderForecastGrid()`)
- **To**: `src/services/modelComparison.js` (existing file, add function)
- **Why**: 30+ lines of nested loops computing model temperature spread, embedded inside HTML generation.
- **Risk**: Low — pure data transformation.

---

## Phase 3: Reliability Fixes (est. 2 hours)

### 3A. Lightning polling race condition
- **File**: `src/services/lightning.js`
- **Why**: `stopLightning()` sets a flag but doesn't cancel in-flight fetches. Stale data can update the buffer after a location switch.
- **How**: Add `AbortController` to `startLightning()`. Pass `signal` to all fetch calls in `_lxPoll()`. Abort on `stopLightning()`. Check `_lxStopped` after each await.
- **Risk**: Low — `AbortController` is well-supported. Fetch already accepts `signal`.

### 3B. SW caches error responses
- **File**: `sw.js`
- **Why**: Network-first strategy caches 5xx responses indefinitely. If an API returns an error once, it's served from cache until the next SW version bump.
- **How**: Add `if (response.ok)` check before `cache.put()`. Add console.warn for failed precache fetches.
- **Risk**: Very low — 2-line change.

### 3C. Server.py error handling
- **File**: `server.py`
- **Why**: Bare `Exception` catches leak internal paths. Same error handler copy-pasted 3x.
- **How**: Extract `_send_error(self, status, message)` helper. Catch `json.JSONDecodeError`, `ValueError`, `FileNotFoundError` specifically. Log to stderr.
- **Risk**: Low — dev server only, not production.

---

## Phase 4: Code Quality (est. 2–3 hours)

Lower urgency but improves long-term maintainability.

### 4A. Break `wireWelcomeEvents()` into small functions
- **File**: `src/main.js`
- **Why**: 183 lines, 6 nested closures, closure state leaks on re-invocation.
- **How**: Extract `_handleWelcomeGPS()`, `_handleWelcomeSearch()`, `_handleWelcomeCoords()`. Move `gpsCoords`, `debounceTimer`, `searchCache` to module scope with cleanup in `wireWelcomeEvents()`.
- **Risk**: Medium — closure scope changes require careful testing of welcome flow.

### 4B. Standardize cache patterns
- **Files**: `observations.js`, `recentPrecip.js`, `spc.js`
- **Why**: Three different cache implementations. Inconsistent key precision.
- **How**: Standardize on `{ data, ts, key }` pattern. Increase cache key precision to `toFixed(4)`. Consider extracting a tiny `_cachedFetch(key, ttl, fetchFn)` helper if pattern repeats.
- **Risk**: Low — isolated to each service file.

### 4C. Lightning buffer dedup optimization
- **File**: `src/services/lightning.js`
- **Why**: `_lxBuffer.some()` is O(n) per incoming flash. Under heavy activity, could have thousands of buffer entries.
- **How**: Add a `Set` keyed by `${roundedLat}_${roundedLon}_${roundedTimeMs}`. Check Set before scanning buffer.
- **Risk**: Low — additive optimization, doesn't change behavior.

---

## Phase 5: Cosmetic / Low Priority (do when touching these files)

| Item | File | What |
|------|------|------|
| Move `getShareStyleOverrides()` CSS to external file | `share.js` | 96 lines of CSS-in-JS |
| Name METAR age decay constants | `nowcast.js` | Replace magic numbers 20/40/60 with named consts |
| Add JSDoc to store.js globals | `store.js` | Document which modules read/write each global |
| `updateRefreshTime()` — verify if dead | `main.js` | May be orphaned; delete if unused |

---

## Do Not Touch (risky, marginal gain)

| Change | Why Avoid |
|--------|-----------|
| Convert store.js to getter/setter | Touches every file; high regression risk |
| Migrate 25+ inline onclick to addEventListener | Easy to miss one; breaks everything |
| Convert to ES modules | Rewrites all globals; breaks load order |
| Full split of renderDashboard.js | Working file; implicit state deps make splitting fragile |
| Replace flat-earth distance in lightning.js | Hot path; exact haversine slower for <50mi |

---

## Bug Fix: Tab Icon Crosstalk (2026-03-22)

Separate from the phased roadmap, fixed a recurring bug where location tab icons showed the wrong weather condition after switching tabs.

**Root cause**: `locationNowcastIcons` was written from 4+ async code paths (renderCurrentCard, updateNowcastDisplay, fetchAllLocationTemps background loop) all keyed by `activeLocation.name` which changes on tab switch. Async races meant stale writes overwrote correct data.

**Fix (two-phase)**:
1. **Delete**: Removed `locationNowcastIcons` entirely — variable, load/save functions, localStorage key, and all 4 write sites across `store.js`, `renderDashboard.js`, and `main.js`.
2. **Rebuild**: Tab icons now derived at render time from `locationTemps[loc.name].code` + `is_day` via `getWeatherIcon()`. Since `locationTemps` is always keyed by location name (not `activeLocation`), there are no races.

**Files changed**: `src/state/store.js`, `src/main.js`, `src/ui/renderDashboard.js`, `sw.js`

---

## Progress Tracker

| Phase | Status | Lines Removed |
|-------|--------|---------------|
| Phase 0: Quick wins | DONE | ~60 lines removed, 6 fixes |
| Phase 1: Critical duplication | DONE (2026-03-22) | est. ~240 lines |
| Phase 2: Architecture | TODO | est. ~100 lines moved |
| Phase 3: Reliability | DONE (2026-03-22) | est. ~20 lines changed |
| Phase 4: Code quality | TODO | est. ~50 lines |
| Phase 5: Cosmetic | TODO | varies |
| Tab icon crosstalk fix | DONE (2026-03-22) | ~40 lines removed |
