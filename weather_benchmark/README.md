# Weather HQ Benchmark

Nowcast verification tool for the Weather HQ app. Scores live nowcast snapshots against IEM ASOS ground-truth observations and generates actionable metrics: precip timing accuracy, wording appropriateness, lightning detection rates, and icon agreement.

---

## Quick Start

```bash
# 1. Install Python dependencies (from repo root)
pip install -r weather_benchmark/requirements.txt

# 2. Start the dev server (serves the app + collects logs)
python server.py            # default port 3000

# 3. Open the app in your browser and use it normally.
#    Nowcast snapshots are logged automatically — no extra steps.
#    Let it run for at least 1–2 days to accumulate useful data.

# 4. Score the logs
cd weather_benchmark
python backtest.py          # scores last 7 days, all cities
```

Reports are written to `weather_benchmark/reports/`.

---

## How It Works

```
App (browser)
  └─ POST /api/nowcast-log  (each poll cycle)
       └─ server.py  →  weather_benchmark/data/logs/YYYY-MM-DD.jsonl

backtest.py
  ├─ reads  data/logs/*.jsonl
  ├─ fetches IEM ASOS observations  →  cached in data/observations/
  ├─ scores each snapshot
  └─ writes reports/
```

Two components:

| File | Role |
|---|---|
| `server.py` (repo root) | Dev server + log collector. Receives `POST /api/nowcast-log`, writes JSONL. |
| `backtest.py` | Main scorer. Reads logs, fetches observations, computes metrics, writes reports. |

---

## Capturing Data

The app automatically POSTs a nowcast snapshot to `http://localhost:3000/api/nowcast-log` every poll cycle when the server is running. No manual intervention needed.

**Log format** — each line in `data/logs/YYYY-MM-DD.jsonl` is a JSON record:

```json
{
  "snapshot_time": "2026-03-22T14:35:00Z",
  "location_name": "Arden, NC",
  "lat": 35.47,
  "lon": -82.53,
  "station": "KAVL",
  "precipStateNow": {
    "phenomenon": "rain",
    "desc": "Light Rain",
    "source": "radar",
    "confidence": 0.85
  },
  "lightningState": {
    "state": "nearby",
    "nearestFlashMi": 14.2,
    "flashCounts": { "within10mi": 0, "within20mi": 3, "within40mi": 8 },
    "confidence": "medium",
    "trend": "rising"
  },
  "precipTrend60m": {
    "summary": "Rain continuing for ~30 min",
    "summaryConfidence": "med",
    "beginInMin": null,
    "endInMin": 30
  },
  "radarDbz": 38.5,
  "modelContext": {
    "weatherCode": 61,
    "precipProbability": 85,
    "cloudCover": 95,
    "temperature": 52.3,
    "humidity": 88,
    "windSpeed": 12.4,
    "pressure": 1008.2
  },
  "displayedCondition": "Light Rain — thunder nearby",
  "displayedIcon": "rain"
}
```

**Cities** are read from `data/cities.json` (managed at runtime) or `config.yaml`. The 5 configured benchmark cities are:

| City | ASOS Station |
|---|---|
| Arden, NC | KAVL |
| Raleigh, NC | KRDU |
| Bozeman, MT | KBZN |
| Sparta, NJ | KCDW |
| Georgetown, Bahamas | MYEG |

---

## Running the Backtest

```bash
cd weather_benchmark

python backtest.py                        # last 7 days, all cities
python backtest.py --days 14             # extend lookback window
python backtest.py --city "Arden, NC"    # single city only
python backtest.py --export-ml           # also write data/ml/features.csv
```

The scorer fetches IEM ASOS observations for each city/day automatically and caches them in `data/observations/` — subsequent runs reuse the cache for past dates.

---

## Report Output

Each run writes timestamped files to `weather_benchmark/reports/`:

| File | Contents |
|---|---|
| `TIMESTAMP_report.md` | Human-readable scorecard, detected weaknesses, recommendations |
| `TIMESTAMP_scorecard.csv` | Metrics table — one row per location/horizon |
| `TIMESTAMP_results.json` | Full machine-readable results for trend tracking |

With `--export-ml`:

| File | Contents |
|---|---|
| `data/ml/features.csv` | Feature rows + truth labels for ML training |

---

## Metrics

### Nowcast scoring

| Metric | What it measures |
|---|---|
| `precip_start_mae_min` | Mean absolute error in predicted precip start time (minutes) |
| `precip_end_mae_min` | Mean absolute error in predicted precip end time |
| `duration_mae_min` | Predicted vs actual event duration |
| `wording_correct_pct` | % snapshots where displayed condition matched observations |
| `overstated_pct` | % snapshots where forecast was more severe than reality |
| `understated_pct` | % snapshots where forecast was less severe than reality |
| `imprecise_pct` | % snapshots with precise timing language at low confidence |
| `precision_violation_pct` | % snapshots with confidence/precision mismatch (e.g. "in ~3 min" at low confidence) |
| `lightning_pod` | Probability of detection for active/nearby lightning state |
| `lightning_far` | False alarm ratio for active/nearby lightning state |
| `icon_agreement_pct` | Icon match score: 1.0 exact, 0.5 close (rain↔drizzle), 0.0 mismatch |
| `rain_false_alarm_pct` | % forecasts of rain with no observed precip |
| `rain_miss_pct` | % observed rain events with no forecast |

### Wording severity levels

`dry (0) → drizzle (1) → rain (2) → heavy rain (3) → thunderstorm (4)`

A snapshot is `overstated` if the forecast severity exceeds observed severity, `understated` if lower, `imprecise` if precise timing language appears at low confidence.

### Precision violation thresholds (from config.yaml)

- Low confidence: don't claim precip start within 15 min
- Medium confidence: don't claim precip start within 10 min

---

## Configuration

`config.yaml` controls all settings:

```yaml
locations:
  - name: Arden, NC
    lat: 35.47
    lon: -82.53
    station: KAVL

backtest:
  lookback_days: 7
  log_dir: ./data/logs
  obs_cache_dir: ./data/observations
  report_dir: ./reports
  ml_output_dir: ./data/ml

nowcast_scoring:
  precip_timing_window_min: 60
  precision_violation_thresholds:
    low_confidence_max_precision_min: 15
    med_confidence_max_precision_min: 10
```

Copy `config.example.yaml` to `config.yaml` if starting fresh.

---

## Adding Cities

Edit `config.yaml` and add a location entry. The ASOS station ID must match an IEM ASOS station that reports hourly observations. For non-US locations (like Georgetown, Bahamas), GLM lightning is available but NWS data is not — the benchmark handles this gracefully.

Alternatively, update the cities list at runtime via the server API:

```
PUT http://localhost:3000/api/cities
Content-Type: application/json

[{"name": "Denver, CO", "lat": 39.86, "lon": -104.67, "station": "KDEN"}]
```

This writes to `data/cities.json` which the app reads on next load.

---

## Ground Truth Reliability

The benchmark scores against **IEM ASOS** (`mesonet.agron.iastate.edu`) — the same source used by the app's live observation feed. It fetches routine METAR observations (`report_type=1`) and buckets them into 1-hour windows.

### What it's reliable for

| Metric | Reliability | Notes |
|---|---|---|
| Precip occurrence (yes/no) | High | Best metric to trust |
| Wording / icon accuracy | High | Best metric to trust |
| Sky cover | High | CLR/FEW/SCT/BKN/OVC from ASOS layers |
| Thunder detection | Medium | Reliable only when storm is directly overhead; misses distant thunder |
| Precip timing (sub-hour) | Low | 1-hour buckets hide all errors under ~30 min |

### Known scoring gaps

- **Timing MAE is coarse** — `precip_start_mae_min` and `precip_end_mae_min` are dominated by the 60-minute bucket size. Errors under ~30 min are essentially invisible. Treat timing scores as directional, not precise.
- **Lightning FAR is biased high** — GLM detects flashes at 20–40 mi; ASOS only logs thunder directly overhead. A legitimate `nearby` or `approaching` classification frequently won't show `TS` in the METAR, inflating the false alarm ratio.
- **`report_type=1` skips special obs** — rapid storm arrivals mid-hour may be missed if they weren't captured in a routine report.
- **Georgetown, Bahamas (MYEG)** — IEM coverage of non-US stations is patchy. Verify you actually have data before relying on scores for this city: `python backtest.py --city "Georgetown, Bahamas" --days 7`

### When to run the backtest

IEM archives data with a 1–4 hour lag. Today's data is always re-fetched live; past dates are cached locally after the first fetch.

| Scenario | Guidance |
|---|---|
| Yesterday and older | Run anytime — data is fully archived and will be cached |
| Today's data | Wait 2–4 hours after the event before trusting scores |
| Mid-event | Don't run — ground truth is incomplete for the current hour |

**Best workflow:** collect all day with collection mode running, then run `backtest.py` the following morning.

---

## Dependencies

```
pyyaml>=6.0
pandas>=2.0
requests>=2.28
numpy>=1.24
```

Python 3.10+ recommended. No other runtime dependencies.
