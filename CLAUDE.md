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
- `lightning.js` — Blitzortung WebSocket, rolling 30-min strike buffer, `summarizeLightningBuffer()`
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

Lightning data comes from Blitzortung WebSocket (global). The nowcast merges three sources:

1. **Blitzortung strikes** (primary truth) — real-time, distance-based classification
2. **METAR TS codes** (fallback / confirmation) — explicit thunderstorm only
3. **Radar dBZ** (supporting context) — **never** promotes to thunderstorm alone

**State classification** (from strike buffer):
- `active` — strikes ≤ 5 mi in last 15 min
- `nearby` — strikes 5–10 mi in last 15 min
- `approaching` — strikes 10–20 mi in last 30 min
- `none` — no strikes within 20 mi

**Condition override ladder** (do not change this without discussion):
- `active` can promote precip to **Thunderstorm**
- `nearby` can modify to **Rain — thunder nearby**
- `approaching` — secondary line only, **never** changes primary condition
- Radar dBZ ≥ 45 alone → **Heavy Rain**, not thunderstorm

**Key files**: `src/services/lightning.js` (WebSocket + buffer), `src/services/nowcast.js` (`_computeLightningState` merge), `src/ui/renderDashboard.js` (`_lightningLineText`, `_applyLightningConditionOverride`)

**Degradation**: if WebSocket disconnects, buffer drains over 30 min, then METAR fallback. See `docs/lightning-nowcast-plan.md` for full spec.

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
