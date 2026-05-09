# Weather HQ — Claude Guide

A lightweight weather dashboard (vanilla JS, no frameworks, no build step). Supports multiple saved locations, fetches from Open-Meteo, NWS, AQI, and optional model comparison. Works as a PWA on iPhone.

**Primary goal: stay lean and fast.**

---

## Hard constraints

- No frameworks (React, Vue, etc.)
- No build tools unless explicitly requested
- No new dependencies without justification (explain why, size, alternatives)
- ES modules only; small files with single responsibilities
- Don't change UI behavior unless the task explicitly asks for it

---

## File map

| File/Folder | Purpose |
|---|---|
| `index.html` | Minimal shell — links CSS, loads `src/main.js` as a module |
| `css/styles.css` | All CSS, organized by section (layout, cards, modal, mobile, dark mode) |
| `src/main.js` | Bootstrap + orchestration: load settings, wire events, call services, call renderers |
| `src/state/store.js` | Single source of truth: selected location, saved locations, preferences, last fetch |
| `src/services/*` | **No DOM here.** Fetch + normalize data only. |
| `src/ui/*` | **No fetch here.** DOM rendering only. |
| `src/utils/format.js` | Pure formatting helpers — raw primitives in, strings out |
| `src/utils/dom.js` | Tiny DOM helpers (createEl, qs, qsa) |
| `src/utils/risk.js` | Derived metrics and risk classification |

### Services
- `openMeteo.js` — forecast, current conditions, derived metrics
- `nws.js` — US-only: points → forecast + alerts. Returns null if unavailable.
- `airQuality.js` — AQI fetch + normalize
- `modelComparison.js` — model spread fetch + normalize
- `geocode.js` — location search + normalize
- `lightning.js` — GOES GLM S3 direct fetch (NetCDF/jsfive), rolling 20-min flash buffer, `summarizeLightningBuffer()`, `fetchGlmFlashes()` adapter boundary
- `nowcast.js` — orchestrator: sky state, precip now, precip trend, lightning state (merged)
- `radarSampler.js` — radar tile loading, pixel sampling, hysteresis, motion vectors
- `observations.js` — NWS station observation fetch + parsing
- `recentPrecip.js` — historical rain accumulation

### UI
- `renderDashboard.js` — main render pipeline
- `locationPicker.js` — modal UI + callbacks
- `hourly.js` — hourly strip
- `tabs.js` — tab switching

---

## Coding style

- Modern JS: `const`/`let`, `async`/`await`
- Functions under ~50 lines
- Pure functions for data transformations
- Comments only where logic isn't obvious
- Errors: user-friendly message in the UI + detail in the console
- Render once after all data resolves — avoid repeated renders or DOM churn

---

## Lightning / nowcast rules

Lightning data comes from NOAA GOES GLM (Americas only, ~10 km resolution). The nowcast merges three sources:

1. **GOES GLM flashes** (primary truth) — poll-based, distance-band classification
2. **METAR TS codes** (fallback / confirmation) — explicit thunderstorm only
3. **Radar dBZ** (supporting context) — **never** promotes to thunderstorm alone

GLM is a storm-scale flash detector, NOT a precise strike locator. UI language must be honest about this.

**State classification** (from flash buffer, broader bands than former Blitzortung):
- `active` — flashes ≤ 10 mi in last 10 min
- `nearby` — flashes ≤ 20 mi in last 15 min
- `approaching` — flashes ≤ 40 mi in last 20 min
- `none` — no flashes within 40 mi

**Condition override ladder** (do not change this without discussion):
- `active` can promote precip to **Thunderstorm**
- `nearby` can modify to **Rain — thunder nearby**
- `approaching` — secondary line only, **never** changes primary condition
- Radar dBZ ≥ 45 alone → **Heavy Rain**, not thunderstorm
- Dry background + `active` requires ≥ 2 close flashes for "Thunder nearby" (conservative for GLM)

**Key files**: `src/services/lightning.js` (GLM polling + buffer), `src/services/nowcast.js` (`_computeLightningState` merge), `src/ui/renderDashboard.js` (`_lightningLineText`, `_applyLightningConditionOverride`)

**Adapter boundary**: `fetchGlmFlashes()` in lightning.js is the sole data ingestion point. Default reads GOES GLM LCFA NetCDF files directly from NOAA S3 (`noaa-goes19` / `noaa-goes18` buckets). Uses jsfive (176KB, pure JS HDF5 reader) loaded lazily on first lightning poll. Set `LIGHTNING_CFG.GLM_ENDPOINT` to swap in a proxy. Set `LIGHTNING_CFG.S3_SAT_SELECT` to `'east'`/`'west'` to force a specific satellite (default `'auto'` uses longitude threshold).

**External dependency**: `lib/jsfive.esm.js` — jsfive 0.4.0 from NIST. Pure JavaScript HDF5 reader. 176KB vendored locally. No WASM, no CDN runtime dependency. Lazy-loaded only when lightning polling starts.

**Coverage**: Americas only (~52N–52S). Outside coverage → METAR fallback (US) or no lightning source.

**Degradation**: if S3 or GLM is unavailable, buffer drains over 20 min, then METAR fallback. See `docs/nowcast-rules.txt` for full spec.

---

## NWS / US-only rule

NWS logic must fail gracefully. It should never break anything for non-US locations. Keep it isolated.

---

## Service worker — important

After **any JS or CSS edit**, bump the version in `sw.js` (e.g. `weather-hq-v0.7.2`).

This forces the service worker to reinstall and clear the old cache. If you skip this, the browser will silently serve stale files even on hard reload. The `{ cache: 'no-cache' }` in the install handler is intentional — do not remove it.

---

## iOS / dark mode

Avoid CSS that triggers automatic dimming on iOS. Use explicit background colors.

---

## Workflow

1. Ask clarifying questions only if truly necessary.
2. Default to the **smallest viable change**.
3. After changes, verify with `preview_*` tools (screenshot, snapshot, logs). Do not ask the user to test manually.

---

## Definition of done

- Multi-location flow works
- Refresh works
- Open-Meteo forecast renders
- NWS renders when available, fails gracefully otherwise
- AQI displays (or is explicitly disabled with explanation)
- Model comparison displays (or is explicitly disabled with explanation)
- No console errors on load
