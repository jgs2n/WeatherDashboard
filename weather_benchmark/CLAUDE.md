# Weather Benchmark — Algorithm Improvement Log

**Read this before making any algorithm or scoring changes.** It tracks baseline
metrics, what has been tried, and what problems each change was meant to fix.
This prevents re-introducing regressions or repeating failed approaches.

---

## ⚠ Canonical Source-of-Truth Rule (read first)

The nowcast algorithm now exists in **two parallel implementations** that must
stay in sync:

1. **`src/services/nowcast.js`** + `src/services/radarSampler.js` — browser
   display path; what the user sees in the weather app.
2. **`weather_benchmark/collector_lib/nowcast.py`** + `radar_sampler.py` —
   collector daemon; what gets written to training data.

**Any change to one MUST be mirrored in the other** before the change is
merged. If they drift, the model trained on collector data will reflect a
different algorithm than the browser display, producing train/serve skew
that is hard to detect.

The parity test in `tests/test_collector_parity.py` enforces threshold
agreement. Run it (and the smoke test in `tests/test_collector_smoke.py`)
before any commit that touches scoring, DBZ thresholds, or detection logic.

---

## Key Files

| File | Role |
|---|---|
| `collector.py` | Continuous data collection daemon (the source of training data) |
| `collector_config.yaml` | Polling cadence, rate limits, paths |
| `collector_lib/nowcast.py` | Python port of `src/services/nowcast.js` |
| `collector_lib/radar_sampler.py` | Python port of `src/services/radarSampler.js` |
| `collector_lib/lightning.py` | METAR thunder fallback (GLM not yet polled here) |
| `collector_lib/record_builder.py` | JSONL schema builder (port of `nowcastLogger.js`) |
| `backtest.py` | Scoring pipeline: loads logs, fetches obs, writes report |
| `src/nowcast_scoring.py` | Wording / presence / intensity / icon scoring |
| `src/observations.py` | IEM ASOS fetch + per-day cache; retry-with-backoff |
| `src/ingest.py` | Loads JSONL log files; filename date-range filter |
| `src/lead_targets.py` | Truth labels at +10/+20/+30/+45/+60 min |
| `../server.py` | Dev server (static files + backtest API); no longer collects |
| `viewer.html` | Benchmark report viewer UI |
| `COLLECTOR.md` | Operator guide for the collector |

---

## Data Collection

Log files live in `data/logs/`. Format: `START--END.jsonl`  
Example: `2026-04-25_18-48-39Z--2026-05-01_15-55-17Z.jsonl`

- Filename encodes both session start and stop timestamps (UTC)
- Filename start date = when user clicked Collect; end date = when they stopped
- Ingest filter uses overlap check so multi-day files are included in any
  backtest range that overlaps their span (not just exact date match)
- `acquiring.jsonl` = in-progress session; always excluded from backtest

To run a backtest over a session:
```
python backtest.py --start-date YYYY-MM-DD --end-date YYYY-MM-DD
```

---

## Baseline Metrics — 2026-04-25 → 2026-05-01

Report: `reports/weekly_2026-04-25_2026-05-01.json`  
6 cities scored (Burlington, Denver, Sarasota, Seattle, Savannah had no log data).

| City | Scored | Wording OK | Overstated | Understated | Presence FA | Icon OK | Rain FA | Intensity OK |
|---|---|---|---|---|---|---|---|---|
| Boston | 320/328 | 80.9% | 8.8% | 10.3% | 4.7% | 70.5% | 8.8% | 33% (n=9) |
| Bozeman | 285/285 | **98.9%** | 0.0% | 1.1% | 0.0% | 84.6% | 0.0% | — |
| Chicago | 359/359 | 75.5% | 10.3% | 14.2% | 9.5% | 58.7% | 11.1% | 34% (n=41) |
| Arden | 311/331 | 90.4% | 2.9% | 6.8% | 2.9% | 74.6% | 1.6% | 18% (n=11) |
| Atlanta | 407/407 | 63.1% | **35.9%** | 1.0% | **17.0%** | 51.1% | **36.9%** | — |
| Durham | 355/355 | 77.5% | 17.2% | 5.4% | 11.0% | 59.9% | 17.2% | 38% (n=16) |
| **Avg** | | **81.1%** | **12.5%** | **6.5%** | **7.5%** | **66.6%** | **12.6%** | **31%** |

Radar obs agreement (when radar active): Boston 85%, Chicago 83%, Arden 97%, **Atlanta 53%**, Durham 78%.

**Bozeman is the control city** — dry/clear dominant. Any change that degrades
Bozeman accuracy is almost certainly a regression. Check it first after every change.

---

## Failure Modes (Priority Order)

### 1. Intensity understating — ~69% of precip events scored wrong
Consistent one-tier understatement when precip is active ("Light Rain" when obs
shows moderate). Zero overstating observed. Root cause: DBZ-to-intensity thresholds
too conservative.

### 2. Rain false alarms — Atlanta 36.9%, Durham 17.2%, Chicago 11.1%
App declares rain when none reaches the ground. Atlanta radar active 46.9% of
snapshots but only 53.1% obs agreement — strong signal of virga or elevated
radar returns being counted as surface precip. Worst in Southeast/mid-Atlantic.

### 3. Icon disagreement — 33% average
Largely downstream of false alarms: incorrect rain detection → incorrect rain icon.
Fixing false alarms should improve icon agreement proportionally.

### 4. Wording overstating — Atlanta 35.9%, Durham 17.2%
Same root cause as false alarms. Not an independent problem.

### 5. Precip start timing — Boston start MAE 56.5 min
Trend model predicts rain start nearly an hour too early. Radar motion
extrapolation too aggressive at low confidence levels.

---

## Proposed Improvements (not yet implemented)

### A — Raise DBZ rain-active threshold
**Targets:** Rain FA (Atlanta −20pp, Durham −10pp), wording overstated  
**Risk:** May increase misses in very light precip  
**Approach:** Find where `rain_state` transitions OFF→ON in scoring; raise
minimum DBZ threshold (currently ~18 dBZ) to ~22–25 dBZ.  
**Validate:** Bozeman false alarms stay 0%; Chicago/Durham miss rate doesn't rise.

### B — Require METAR wx-code confirmation for rain declaration
**Targets:** Rain FA (Atlanta especially), radar obs agreement (Atlanta 53% → 70%+)  
**Risk:** Adds ~5–10 min latency; METAR updates only hourly  
**Approach:** AND condition: DBZ threshold AND METAR wxcodes contains precip
(RA, DZ, SN, etc.). Fall back to radar-only when METAR is stale (>90 min).

### C — Recalibrate DBZ-to-intensity mapping
**Targets:** Intensity correct (31% → 60%+)  
**Risk:** Could flip understate bias to overstate — test all cities  
**Approach:** Shift intensity tier thresholds down ~5 dBZ so "moderate" fires
earlier. Requires ≥50 intensity-scored events to validate; Chicago (n=41) is
the best test city for this.

### D — Confidence discount on trend start predictions
**Targets:** Precip start MAE (Boston 56.5 min → <30 min)  
**Risk:** Low — affects trend display only, not wording score  
**Approach:** Suppress "rain starting in X min" unless trend confidence ≥ 0.6
at that minute mark; decay confidence faster with distance in the timeline.

---

## Change Log

Newest first. **Before implementing a change, add an entry here** with rationale
and which metric you expect to move. Update with actual results after re-running
the benchmark.

---

### [2026-05-17] MRMS truth-augmentation (Phase A of new-sources plan)

**Problem:** ASOS labels are noisy in time and space — up to ~30 min off
the snapshot they grade, sometimes >10 km from the city's actual location.
For the Atlanta virga / elevated-return failure mode in particular, ASOS
under-reports "no rain at surface" because radar at distance can read as
echoes that never reach the ground.

**MRMS (Multi-Radar Multi-Sensor)** is NOAA's combined-radar/gauge product:
1 km × 1 km, 2-min cadence, surface-calibrated, beam-blockage-corrected.
Using MRMS as the truth label means each snapshot is graded against a
co-located, time-matched ground reality.

**Changes (backtest-side only — no collector, browser, or schema change):**
- New `src/mrms_observations.py`: downloads MRMS PrecipRate GRIB2 from
  NCEP NOMADS (real-time) or Iowa State archive (historical), extracts
  the rate at each city's (lat, lon) via `wgrib2` subprocess. Per-city
  per-day disk cache. Returns the same DataFrame shape as ASOS/mesonet
  so the labeler consumes it through one code path.
- `src/lead_targets.py`: extended the precedence chain. Now
  **MRMS (within 4 min) → mesonet (within 15 min) → ASOS (within 40 min) → none**.
  Each lead-target label emits `truth_source_+N` so any metric shift is
  auditable.
- `backtest.py`: per-city MRMS fetch; new `--mrms` CLI flag.
- `config.yaml`: new `mrms:` block (`enabled`, `wgrib2_path`,
  `fetch_cadence_min`).
- `tests/test_mrms.py`: 10 offline unit tests + 2 live smoke tests
  (skipped if wgrib2 missing or NO_NETWORK=1).

**Prerequisite:** `wgrib2` binary (v3.1.3 or later). NOAA-EMC GitHub
releases are source-only on Windows; download a pre-built Windows binary
and either add it to PATH or set `mrms.wgrib2_path` in config.yaml.
Currently shipped with the project at `wgrib/wgrib2.exe` (auto-detected).

**Auth:** none. NCEP NOMADS and the Iowa State archive are public.

**Train/serve skew:** None. This is truth-side only. The prediction
algorithm runs with the inputs it always has had.

**Expected metric impact:**
- Atlanta `rain_false_alarm_pct`: 36.9% should drop notably as MRMS
  catches the virga / overshoot scenarios that ASOS misses.
- `n_scored` per city: ↑ everywhere — MRMS is dense and reliable inside
  CONUS, fills holes where ASOS reporting gaps exist.
- Reports gain `mrms_enabled` + `mrms_samples` per city in `period`,
  plus `truth_source_+N` per snapshot lead time.

**Triple-truth precedence rule:**
1. MRMS reading within 4 min of target → use it (`mrms`)
2. Else mesonet reading within 15 min → use it (`mesonet`)
3. Else ASOS reading within 40 min (lead) / 65 min (current) → `asos`
4. Else `None` labels with `truth_source = 'none'`

This phase is the **evaluation** step — if Atlanta false alarms drop
significantly under MRMS truth, that's evidence MRMS would also help
as a *feature* in the live dashboard. The dashboard integration is
deliberately deferred until that evidence exists (separate plan).

---

### [2026-05-17] Mesonet truth-augmentation (Phase B of new-sources plan)

**Problem:** IEM ASOS is the only truth source for benchmark labels — sparse
(~1 station / 5,000 km², hourly) and often ~30 min off in time from the snapshot
it's grading. Atlanta's 36.9% rain-false-alarm rate is partly label noise.

**Changes (backtest-side only — no collector, browser, or schema change):**
- New `src/mesonet_observations.py`: Synoptic Data API client. Queries
  stations within `radius_km` of each city, aggregates across stations into
  10-min buckets, mirrors the ASOS DataFrame shape so the labeler doesn't
  need to know which source produced a row. Per-city per-day disk cache.
- `src/lead_targets.py`: `label_lead_targets()` and `label_current_truth()`
  now accept optional `mesonet_obs=` argument. Mesonet preferred when within
  15 min of target; ASOS fallback otherwise. Emits new `truth_source_+N`
  fields (per lead time) and `truth_source` (current) so any metric movement
  is auditable.
- `backtest.py`: per-city mesonet fetch; new `--mesonet` CLI flag.
- `config.yaml`: new `mesonet:` block (`enabled`, `radius_km`, `min_stations`).
- `tests/test_mesonet.py`: 11 offline tests + 1 live smoke test (skipped
  unless `SYNOPTIC_TOKEN` set).

**Auth:** Synoptic Data API free token (https://synopticdata.com/api).
Set via env var `SYNOPTIC_TOKEN`. Never committed.

**Train/serve skew:** None. This is a truth-side enhancement. The browser
and collector are untouched. The prediction algorithm uses only the inputs
it always has had (NEXRAD, METAR, Open-Meteo); we're just grading those
predictions against a higher-quality reality.

**Expected metric impact:**
- Atlanta `rain_false_alarm_pct`: 36.9% → maybe ~20-25% (some "false alarms"
  against ASOS will turn out to be real events caught by closer mesonet
  stations). This is *label correction*, not algorithm improvement.
- `n_scored` per city: ↑ in covered states (denser truth = more snapshots
  with matchable labels).
- Reports gain new `truth_source` field showing which source produced each
  label, enabling honest auditing of any metric shift.

**Dual-truth precedence rule:**
1. Mesonet reading within 15 min of target → use it (`truth_source = 'mesonet'`)
2. Else ASOS reading within 40 min of target (lead) / 65 min (current) → use it (`asos`)
3. Else `None` labels with `truth_source = 'none'`

This is the **evaluation** step of the source-integration pipeline. If
metric shifts are large + concentrated where mesonets are dense, that's
signal to consider adding mesonet inputs to the live algorithm (a separate
future task).

---

### [2026-05-03] Collection moved from browser to Python daemon

**Problem:** Browser-driven collection had six concrete issues for ML data quality
(see plan `~/.claude/plans/big-picture-is-there-warm-hamming.md`): user-driven
gaps, rotation-based undersampling, shared radar state corrupting cities,
tangled responsibilities, brittle acquisition recovery, and feedback coupling
between collected data and the displayed algorithm.

**Changes:**
- Removed `src/services/nowcastLogger.js`, all `toggleCollection`/`startCollection`
  /`stopCollection` machinery in `main.js`, the Collect button in `index.html`,
  and the `/api/nowcast-log` + `/api/acquisition-end` server routes.
- Added `collector.py` daemon + `collector_lib/` package: Python port of the JS
  nowcast (`nowcast.py`, `radar_sampler.py`, `lightning.py`, `record_builder.py`,
  `rate_limiter.py`, `fetchers.py`). One thread per city, independent state,
  shared token-bucket rate limiter for IEM endpoints.
- Per-city write path: `data/logs/<city_slug>/YYYY-MM-DD.jsonl`. No more
  `acquiring.jsonl` rename machinery.
- Added validation tests: `tests/test_collector_smoke.py` (Layer 1, ~6 min,
  hits live endpoints) and `tests/test_collector_parity.py` (Layer 2, <1 s,
  no network).
- Added `COLLECTOR.md` operator guide.
- Established the **canonical-source-of-truth rule** above: JS and Python
  nowcast must change together.

**Expected metric impact:** none direct — this is infrastructure. The downstream
benefit (after collection runs for 3-4 weeks): much denser per-city coverage,
no cross-city state corruption, and a clean dataset suitable for ML training.

**sw.js bumped:** v1.44.1 → v1.45.0

---

### [2026-05-02] Algorithm improvements A–D — awaiting benchmark results

**Changes (all in `src/services/` JS files — app-side algorithm, not benchmark scorer):**

**A — Raised DBZ ON_THRESHOLD: 18 → 22** (`radarSampler.js` `RADAR_CFG.ON_THRESHOLD`)  
Requires stronger echo before declaring rain active. Targets Atlanta/Durham false alarms
from virga and elevated returns that resolve at 18–21 dBZ.

**B — Stronger virga/dry-layer detection** (`nowcast.js` `_scorePrecipNow` surface-dry veto)  
Lowered temp–dewpoint spread threshold from >10°C → >6°C; added humidity <60% as
an OR condition. Tier 1 veto boundary updated from <28 dBZ → <30 dBZ; Tier 2 from
≥28 → ≥30 dBZ to stay consistent with new intensity thresholds.

**C — Recalibrated DBZ-to-intensity mapping** (both `_computePrecipNow` and `_scorePrecipNow`)  
Old: Heavy ≥50 / Rain ≥35 / Light Rain ≥28 / Drizzle ≥18  
New: Heavy ≥45 / Rain ≥30 / Light Rain ≥22 / Drizzle ≥18 (drizzle only for METAR-blind path)  
Also updated `_dbzToPrecipClass` in `radarSampler.js` for timeline consistency.  
Targets intensity understatement (~69% of scored precip events wrong).

**D — Capped slope-only trend confidence at 'med'** (`nowcast.js` `_summarizePrecipTimeline`)  
Without upstream sampling confirmation, exact "Rain beginning in ~X min" (high confidence)
is suppressed in favor of "Rain possible in ~X±5 min" (med). Upstream-confirmed predictions
still reach high confidence. Also increased timeline confidence decay from 0.07 → 0.10/step.  
Targets precip start MAE (Boston 56.5 min).

**Expected metric movements:**  
- Rain false alarms: Atlanta −15–20pp, Durham −8–12pp (A+B combined)  
- Wording overstated: follows false alarm improvement proportionally  
- Intensity correct: 31% → 55–65% (C)  
- Precip start MAE: 56.5 min → <35 min (D)  
- **Watch:** rain miss rate — if it rises >5pp vs baseline, A threshold (22) may be too aggressive

**sw.js bumped:** v1.43.2 → v1.44.0

---

### [2026-05-02] Infrastructure — no scoring algorithm change

**Problem:** Several unrelated issues causing bad data and incomplete scoring.

**Changes:**
- `../server.py`: Files now named `START--END.jsonl`; tracks `_first_log_time`
  so filename reflects actual session window, not just stop time.
- `../server.py` `_run_backtest_thread`: Parses `--` separator to pass correct
  `--start-date` / `--end-date` to backtest (was using stop-date for both).
- `src/ingest.py` `load_jsonl_logs`: Date filter uses overlap check for
  `START--END` files; backward-compatible with old single-date filenames.
- `src/observations.py` `_fetch_day`: Retry-with-backoff for IEM 429 errors
  (3 attempts: wait 5s, 10s, 20s). Was causing 28–47% of snapshots to go
  unscored due to missing obs days.

**Expected:** Scored/total ratio improves from ~65–75% to ~90–95%. No change
to wording/presence/intensity scores — pure data pipeline fix.
