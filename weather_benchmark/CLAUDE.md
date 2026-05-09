# Weather Benchmark — Algorithm Improvement Log

**Read this before making any algorithm or scoring changes.** It tracks baseline
metrics, what has been tried, and what problems each change was meant to fix.
This prevents re-introducing regressions or repeating failed approaches.

---

## Key Files

| File | Role |
|---|---|
| `backtest.py` | Main pipeline: loads logs, fetches obs, scores, writes report |
| `src/nowcast_scoring.py` | Core scoring logic — wording, presence, intensity, icon |
| `src/observations.py` | IEM ASOS fetch + per-day cache; retry logic for 429s |
| `src/ingest.py` | Loads JSONL log files; filename date-range filter |
| `../server.py` | Dev server; manages `acquiring.jsonl` → `START--END.jsonl` rename |
| `viewer.html` | Benchmark report viewer UI |

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
