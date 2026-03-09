# Lightning Nowcast Integration Plan

## Overview

Add real-time lightning strike data to the existing nowcast pipeline via Blitzortung WebSocket. Produces a `lightningState` object that merges with existing METAR thunder detection and influences condition text on the current card. Works globally.

---

## Data Source: Blitzortung WebSocket

**Endpoint**: `wss://ws1.blitzortung.org` (community lightning detection network)

### Pros
- Free, no API key required
- Global coverage (~2000+ stations worldwide)
- Real-time strike data (sub-second latency)
- Well-known in weather community, widely used by hobbyist and semi-pro apps
- Strike data includes lat/lon/time — distance calculation is straightforward

### Cons
- No official public API — community/contributor oriented
- No SLA, no uptime guarantee
- WebSocket can be flaky; disconnects happen
- Data format may change without notice
- Ethical gray area: intended for contributors who run detection stations
- Strike density varies by region (weaker coverage in remote/ocean areas)
- No authentication = no rate limiting feedback, but also no abuse protection

### Mitigations
- Graceful degradation: if WebSocket drops, fall back to METAR thunder detection
- Stale-age metadata on buffer so UI never shows outdated lightning as current
- Reconnect with exponential backoff
- Keep connection lightweight: subscribe only to region around active location

---

## Architecture

### WebSocket + Rolling Buffer + Poll Cycle

```
Blitzortung WebSocket (persistent connection)
  │
  ├─ Receives: { lat, lon, time, ... } per strike
  │
  └─→ Rolling in-memory buffer (30-min window)
       │
       │  On each nowcast poll cycle (2–5 min):
       │
       └─→ summarizeLightningBuffer(lat, lon, buffer)
            │
            └─→ lightningState { state, nearestMi, strikeCounts, confidence, ... }
                 │
                 └─→ Merged into getNowSummary() output
                      │
                      └─→ updateNowcastDisplay() renders to current card
```

### Connection lifecycle
- Open WebSocket when nowcast polling starts for a location
- Subscribe to strikes within ~50 km radius of active location
- On location change: clear buffer, resubscribe to new region
- On disconnect: exponential backoff reconnect (1s → 2s → 4s → ... → 60s cap)
- On tab hidden: keep connection open (strikes are tiny payloads)
- Buffer auto-prunes entries older than 30 min on each poll

---

## LightningState Schema

```javascript
{
  state: 'none' | 'approaching' | 'nearby' | 'active',

  nearestStrikeMi: null | Number,   // miles, nearest strike in relevant window
  strikeCounts: {
    within5mi:  Number,              // count in last 15 min
    within10mi: Number,              // count in last 15 min
    within20mi: Number,              // count in last 30 min
  },
  updatedAt: ISO8601,                // last time buffer was summarized
  source: 'lightning' | 'metar-fallback' | 'merged',
  confidence: 'high' | 'medium' | 'low',

  // Debugging / staleness
  wsConnected: Boolean,
  bufferAgeMs: Number,               // ms since most recent strike in buffer
  lastStrikeAt: ISO8601 | null,      // timestamp of most recent strike
}
```

---

## State Classification

From the rolling buffer, evaluated each poll cycle:

| Condition | State | Confidence |
|---|---|---|
| Strikes ≤ 5 mi in last 15 min | `active` | `high` |
| Strikes 5–10 mi in last 15 min | `nearby` | `high` |
| Strikes 10–20 mi in last 15–30 min | `approaching` | `medium` |
| No strikes within 20 mi in last 30 min | `none` | — |

---

## Data Merge: Lightning + METAR + Radar

Three sources, evaluated each poll cycle. Lightning is primary truth when available.

### Source roles

| Source | Signal | Confidence | Role |
|---|---|---|---|
| Blitzortung strikes | Strike count + nearest distance | High (direct observation) | Primary truth |
| METAR TS/TSRA codes | `presentWeather` contains TS | Medium (station-local, can be stale) | Confirmation / fallback |
| Radar dBZ ≥ 45 | Convective signature | Low (inferred, not direct) | Supporting context only — never promotes to thunderstorm alone |

### Merge rules (evaluated top-down, first match wins)

1. **Lightning ≤ 10 mi + METAR confirms TS** → `active`, confidence `high`
2. **Lightning ≤ 5 mi, no METAR** → `active`, confidence `high` (sufficient alone)
3. **Lightning 5–10 mi, no METAR** → `nearby`, confidence `high`
4. **Lightning 10–20 mi in last 15–30 min** → `approaching`, confidence `medium`
5. **No lightning + METAR TS fresh (< 20 min)** → `nearby`, confidence `medium`
6. **No lightning + METAR TS stale (20–45 min)** → `nearby`, confidence `low`
7. **Radar dBZ ≥ 45, no lightning, no METAR TS** → `none` (do NOT infer thunder)
8. **WebSocket disconnected, buffer stale > 30 min** → fall through to METAR-only (rules 5–6), flag `source: 'metar-fallback'`

### Confidence boost
- If lightning AND METAR agree, bump confidence to `high` regardless of distance band.

### Key principle
Radar dBZ informs precipitation intensity but **never independently promotes** a condition to thunderstorm. It can only support a lightning or METAR signal.

---

## Condition Text Rules

### Secondary line (current card, same location as existing thunder line)

| State | Distance | Text |
|---|---|---|
| `active` | ≤ 5 mi | `⚡ Lightning within {d} mi` |
| `active` | 5–10 mi | `⚡ Thunder nearby` |
| `nearby` | 5–10 mi | `⚡ Thunder nearby` |
| `approaching` | 10–15 mi | `⚡ Storm approaching` |
| `approaching` | 15–20 mi or low confidence | `⚡ Distant lightning detected` |
| `none` | — | *(hidden)* |

Motion-aware distinction for `approaching`: if motion vector data is available and indicates the storm is moving toward the point, use `"Storm approaching"`. If stationary or moving away, use `"Distant lightning detected"`.

#### METAR fallback wording
When lightning feed is unavailable but METAR has TS:
- Secondary line: `⚡ Thunder reported nearby`

### Primary condition text overrides

Lightning state can promote or modify the main condition label:

| precipStateNow | lightningState | Resulting primary condition |
|---|---|---|
| Heavy Rain (dBZ ≥ 50) | `active` | **Thunderstorm** |
| Rain (dBZ 35–49) | `active` | **Thunderstorm** |
| Rain (dBZ 28–34) | `active` or `nearby` | **Rain — thunder nearby** |
| Light Rain / Drizzle | `active` or `nearby` | **Rain — thunder nearby** |
| Dry | `active` (≤ 5 mi) | **Thunder nearby** |
| Dry | `nearby` or `approaching` | *(no change)* |
| Heavy Rain (dBZ ≥ 50) | `none` | **Heavy Rain** (not thunderstorm) |
| Snow / Wintry | `active` or `nearby` | **Snow — thunder nearby** |
| Any precip | `approaching` | *(no change — secondary line only)* |

### Confidence ladder summary
- `active` → can promote to **Thunderstorm**
- `nearby` → can modify to **X — thunder nearby**
- `approaching` → secondary line only, never changes primary

---

## File Changes

### New file
- `src/services/lightning.js` — WebSocket connection, rolling buffer, `summarizeLightningBuffer()`, reconnect logic, region subscription

### Modified files
- `src/services/nowcast.js` — Import lightning service, call `summarizeLightningBuffer()` in `getNowSummary()`, merge lightning + METAR in new `_computeLightningState()` function, replace existing `thunder` output with `lightningState`
- `src/services/metarParse.js` — No changes to `detectThunder()` itself (it remains as fallback), but its output feeds into the merge
- `src/ui/renderDashboard.js` — Update thunder line rendering to use `lightningState`, add primary condition override logic, update `updateNowcastDisplay()` for in-place lightning updates
- `src/state/store.js` — Add `lightningWsConnected` status flag if needed for debugging
- `src/main.js` — Start/stop lightning WebSocket on location change alongside nowcast polling
- `sw.js` — Bump version

### Not changed
- `src/services/radarSampler.js` — No changes (radar stays as-is)
- `src/ui/hourly.js` — No lightning in hourly strip (yet)
- `src/ui/tabs.js` — No changes
- `src/utils/format.js` — No changes unless distance formatting is needed (likely already has helpers)

---

## New Service: `src/services/lightning.js`

### Responsibilities
- Manage Blitzortung WebSocket lifecycle (connect, subscribe, reconnect)
- Maintain rolling 30-min strike buffer (array of `{ lat, lon, time }`)
- Auto-prune expired entries
- Expose `summarizeLightningBuffer(lat, lon)` → computes distances, counts, classifies state
- Expose `startLightning(lat, lon)` / `stopLightning()` for lifecycle
- Track `wsConnected` and `bufferAgeMs` for degradation awareness

### Buffer design
```javascript
// In-memory array, pruned on each access
const _buffer = [];  // [{ lat, lon, time (ms), ... }]

// On each WS message: push strike, prune entries > 30 min old
// On summarize: compute haversine distance for each strike, bucket by distance/time
```

### Distance calculation
- Haversine formula for lat/lon → miles
- Precompute on summarize, not on receive (buffer could be large in active storms)

---

## Graceful Degradation

| Scenario | Behavior |
|---|---|
| WebSocket never connects | METAR thunder detection works as before, `source: 'metar-fallback'` |
| WebSocket disconnects mid-session | Buffer drains over 30 min, then falls back to METAR |
| No strikes in buffer + no METAR TS | `state: 'none'`, lightning line hidden |
| Blitzortung sends bad data | Validate lat/lon/time before buffering, discard malformed |
| Non-US location (no METAR) | Lightning-only, no METAR fallback available — works fine |

---

## Constraints

- Do NOT redesign the nowcast architecture
- Reuse the existing nowcast / condition fusion flow
- Keep changes minimally invasive
- Keep code readable and debuggable
- Add comments where logic may not be obvious
- Radar dBZ alone never implies thunder
- `approaching` state never modifies primary condition
- Service worker version must be bumped after changes
