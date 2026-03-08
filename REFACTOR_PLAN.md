# Weather HQ — Refactor Plan

Splitting the monolithic `index.html` (4,492 lines) into a maintainable multi-file structure using native ES modules. No build step, no bundler.

## Target Structure

```
WeatherDashboard/
  index.html             ← minimal shell (~70 lines when done)
  css/
    styles.css           ← all CSS (extracted from index.html)
  src/
    main.js              ← bootstrap, init(), event wiring
    state/
      store.js           ← savedLocations, activeLocation, preferences
    services/
      openMeteo.js       ← fetchOpenMeteo(), fetchAirQuality(), fetchModelComparison()
      nws.js             ← fetchNWS() (US-only, fails gracefully)
      geocode.js         ← geocodeLocation()
    ui/
      renderDashboard.js ← renderWeatherDashboard() + sub-renderers
      locationPicker.js  ← showLocationPicker(), selectLocation()
      hourly.js          ← toggleHourlyDetail(), scrollHourlyStrip()
      forecastModal.js   ← openForecastDetail(), renderForecastDetailDay()
      share.js           ← shareCurrentCard(), captureCardAsCanvas()
      tabDrag.js         ← touch drag state machine, desktop drag/drop
    utils/
      weatherCodes.js    ← WEATHER_CODES constant
      moon.js            ← getMoonPhase(), getMoonTimes()
      format.js          ← formatSunTime(), getWindDirection(), getPressureTrend()
      risk.js            ← calculateFireRisk(), getAQICategory()
      dom.js             ← escapeHTML()
  pwa/
    sw.js                ← service worker (currently embedded as string)
    manifest.json        ← PWA manifest (currently generated inline)
  serve.ps1              ← local dev server (no changes needed)
  REFACTOR_PLAN.md       ← this file
```

---

## Phases

### ✅ Phase 1 — Extract CSS
**Status:** Done (2026-02-22)
- Move `<style>` block → `css/styles.css`
- `index.html` gets `<link rel="stylesheet" href="css/styles.css">`
- Service worker cache updated

### ✅ Phase 2 — Extract PWA artifacts
**Status:** Done (2026-02-22)
- `sw.js` at root — service worker extracted from inline blob string (note: must be at root, not `pwa/`, for scope reasons)
- `pwa/manifest.json` — PWA manifest extracted from inline JS
- SW registration simplified from blob URL to `navigator.serviceWorker.register('sw.js')`
- Manifest link added statically to `<head>`

### ✅ Phase 3 — Extract pure utilities
**Status:** Done (2026-02-22)
- `src/utils/weatherCodes.js` — WEATHER_CODES constant
- `src/utils/moon.js` — getMoonPhase(), getMoonTimes()
- `src/utils/format.js` — getWindDirection(), formatSunTime(), getPressureTrend()
- `src/utils/risk.js` — getAQICategory(), calculateFireRisk()
- `src/utils/dom.js` — escapeHTML()
- Loaded as classic `<script src>` tags (inline handlers stay until Phase 7)

### ✅ Phase 4 — Extract services (fetch layer)
**Status:** Done (2026-02-23)
- `src/services/geocode.js` — `geocodeLocation()` (returns array for multi-results; caller handles picker)
- `src/services/openMeteo.js` — `fetchForecast()`, `fetchAirQuality()`, `fetchModelComparison()`, `fetchTabTemp()`
- `src/services/nws.js` — `fetchNWS()` (returns null for non-US, never throws)
- `fetchOpenMeteo` renamed → `fetchForecast` in service + all callers updated
- SW cache bumped to `weather-hq-v0.5.0`

### ✅ Phase 5 — Extract UI modules (Done 2026-02-23)
- `src/ui/locationPicker.js`
- `src/ui/forecastModal.js`
- `src/ui/hourly.js`
- `src/ui/share.js`
- `src/ui/renderDashboard.js` (split into sub-renderers)
- SW bumped to `weather-hq-v0.6.0`

### ✅ Phase 6 — Extract state + drag/reorder
**Status:** Done (2026-02-23)
- `src/state/store.js`
- `src/ui/tabDrag.js`

### ✅ Phase 7 — Wire main.js, finalize index.html
**Status:** Done (2026-02-23)
- `src/main.js` — init(), event wiring, refreshWeather(), all location management, alert/tooltip/NWS helpers
- `index.html` reduced to 72-line shell (HTML structure + script tags only)
- SW cache bumped to `weather-hq-v0.7.0`, `src/main.js` added to precache list
- `APP_VERSION` updated to `0.7.0` in `store.js`

**Definition of Done — verified:**
- [x] No console errors on load
- [x] Open-Meteo forecast renders (CURRENT + 7-DAY + NEXT 48 HOURS cards)
- [x] AQI displays
- [x] Model comparison data loaded (has-model-spread on forecast rows)
- [x] NWS checkbox present, toggles nws-visible class, persists to localStorage
- [x] Refresh button triggers refreshing spinner
- [x] Forecast day detail modal opens on click
- [x] Escape key closes forecast modal
- [x] All modals present in DOM (alert, forecast detail)

---

## Dev Server
```
.\serve.ps1
```
Opens at `http://localhost:9876`. Already handles `.js` and `.css` MIME types correctly — no changes needed for ES modules.

---

## Definition of Done (each phase)
- [ ] Multi-location flow works
- [ ] Refresh works
- [ ] Open-Meteo forecast renders
- [ ] NWS renders for US, skips gracefully for non-US
- [ ] AQI displays
- [ ] Model comparison displays
- [ ] No console errors on load

---

## Architecture Rules (from Claude.md.txt)
1. Services return data objects — never HTML
2. UI modules render — they do not fetch
3. Keep functions < 40–60 lines
4. Use `store.js` for global state — avoid scattered globals
5. NWS code must fail gracefully and never break non-US locations
