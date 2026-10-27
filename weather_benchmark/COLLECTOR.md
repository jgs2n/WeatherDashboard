# Collector — Operator Guide

The collector is a Python daemon that continuously polls every configured
city and writes JSONL snapshots for the benchmark and ML training. It
replaced the browser-driven collection in v1.45.0.

## Quick start

From `weather_benchmark/`:

```
pip install -r requirements.txt   # pandas, requests, pyyaml, Pillow, h5py
python collector.py               # runs forever — Ctrl-C to stop
```

Logs accumulate at `data/logs/<city_slug>/YYYY-MM-DD.jsonl`. Files rotate at
UTC midnight automatically — no rename step needed.

## Configuration

`collector_config.yaml` controls global cadence and rate limits. Per-city
overrides live in `data/cities.json`:

```json
{
  "name": "Atlanta",
  "lat": 33.749,
  "lon": -84.388,
  "station": "KATL",
  "stateCode": "GA",
  "poll_interval_sec": 180,
  "holdout": true
}
```

Fields:
- `poll_interval_sec` — override the global cadence for this city. Optional.
- `holdout` — reserve this city for evaluation. Excluded from collection by
  default; include with `--include-holdout`.

## Common operations

| Goal | Command |
|---|---|
| Single poll per city, then exit (smoke test) | `python collector.py --once` |
| Collect just two specific cities | `python collector.py --cities Boston Bozeman` |
| Use a different config file | `python collector.py --config alt.yaml` |
| Verify install + run unit tests | `pytest tests/ -v` |

## What gets written

Each snapshot mirrors the schema produced by the (now-removed)
`src/services/nowcastLogger.js`. See `src/ingest.py::LogRecord` for the
authoritative field list. Key blocks:

- **location identity:** lat, lon, country, stateCode, station, locationName
- **displayed prediction:** displayedCondition, displayedIcon
- **inputs at prediction time:** radar (dbz, rainState, sampleStatus, motion),
  obs (the METAR the algorithm used: presentWeather, tempC/dewpointC, ageMin,
  raw text), model (Open-Meteo current), modelHourly, lightning, trend
- **provenance:** `algoVersion` (sw.js release the collector ports) and
  `gitSha` (`git describe --always --dirty`), both read at collector startup
- **schema version:** `_schemaVersion: 3` (v3 added `obs`, `radar.sampleStatus`,
  `algoVersion`, `gitSha` — 2026-10-25; older records lack them)

`radar.sampleStatus` is `ok` (echo sampled), `no_echo` (tile read, nothing
there) or `fetch_failed` (tile could not be fetched). A failed fetch does not
advance the rain hysteresis and is flagged `radar_fetch_failed` in
`_validationFlags`, so exclude those polls from radar-skill analyses.

Truth labels (`obs_precip_active`, `condition_+10`, etc.) are **not** in the
JSONL — they're added later by `backtest.py`, which matches each target time
to the first raw 5-min/special observation at or after it (truth v2, see
`src/lead_targets.py`).

**Collector code changes only take effect after a collector restart.**

Blitzortung truth recorder coverage (connect / per-minute heartbeat /
disconnect) goes to `data/lightning_truth/coverage/YYYY-MM-DD.jsonl`;
`lightning_truth_eval.py` drops polls whose 30-min truth window was not
covered.

## Rate limit awareness

The IEM Mesonet endpoints (NEXRAD tiles + ASOS) throttle at roughly 1
sustained request per second. The collector enforces this with a token
bucket shared by all city workers:

- 5 burst tokens
- Refills at 1 tok/sec (configurable: `iem_rate_limit_rps`)
- Both tile fetches and ASOS fetches consume tokens

When throttled, calls block (up to a 30s deadline) rather than 429-erroring.
The retry-with-backoff inside `_fetch_day` (used by `backtest.py`, not the
collector) is a separate layer that recovers from accidental bursts.

**Open-Meteo** allows 10,000 free calls/day. At 11 cities × 20 polls/hour ×
24 h × 2 endpoints = 10,560/day — tight. The collector caches the hourly
forecast for 30 min and the current weather for 5 min by default. Adjust
`openmeteo_*_cache_min` in the config if you change city count or cadence.

## Stopping

`SIGINT` (Ctrl-C) or `SIGTERM` triggers graceful shutdown. Workers finish
their current poll up to `graceful_shutdown_sec` (default 30 s), then exit.
No `acquiring.jsonl` machinery — per-day files are always closed properly
between polls.

## Supervision and alerts (Windows)

Run once from an **elevated** PowerShell (again after any change to it):

```
powershell -ExecutionPolicy Bypass -File setup_collector_task.ps1
```

It registers two independent tasks, both "run whether user is logged on or
not" (LogonType S4U, no stored password):

| Task | Runs | Triggers |
|---|---|---|
| WeatherHQ Collector | `run_collector.cmd` | at startup, at logon, every 5 min (IgnoreNew → no-op while alive) |
| WeatherHQ Health Alert | `run_health_check.cmd` → `health_check.py --alert` | every 15 min |

Both launchers find Python through `find_python.cmd` (`WEATHERHQ_PYTHON` env
var, `.venv`, the per-user python.org installs, `py -3`, then PATH; the first
that can import requests/yaml/Pillow wins). The setup script restarts the
collector (a few seconds of gap); `-HealthOnly` registers just the alert task.

Files:
- `collector.log` (+ `.1`–`.5`): the collector's log, ISO-8601 UTC
  timestamps, rotated at `log_max_mb`. `collector.out.log` only holds output
  from before logging starts (import errors, launcher lines).
- `data/heartbeat.json`: rewritten every `metrics_interval_sec` — pid, start
  time, per-city `lastWriteUtc` / polls / writes / errors, per-source
  (`iem_asos`, `open_meteo`, `iem_tile`) ok/fail/stale counts.
- `data/health_check_last.txt`: the alert task's last report.

`python health_check.py` checks recency (FAIL when any city's newest record
is older than `alerts.stale_after_min`, 15 min), duplicates (polls per city
above one collector's 86400 / `poll_interval_sec`, e.g. 480/day — two
collectors double it), 24 h coverage, longest gap, heartbeat and recent
record quality. With `--alert` it notifies on Recency/Duplicates failures
(again every `alerts.repeat_hours`, plus one "recovered" note):
- desktop: a toast when run interactively; from the S4U task (no desktop)
  a `msg.exe` popup to John's session — only seen while logged on;
- phone: set `alerts.ntfy_topic` in `collector_config.yaml` (or env
  `WEATHERHQ_NTFY_TOPIC`) and subscribe to the topic in the ntfy app. This is
  the only channel that reaches you while nobody is logged on.

`python health_check.py --test-alert` sends a test on every channel;
`--now <ISO time in the future>` simulates a stale collector.

**Fetch retries.** IEM ASOS and Open-Meteo go through one `requests.Session`
that retries connection errors and 429/5xx 3× (backoff 1/2/4 s). If the
fetch still fails, the last good response for that station/point is reused
when ≤60 min old and the record gets `_staleSources: {obs|model|modelHourly:
ageMin}` plus the `stale_cache` validation flag — exclude those polls where
input freshness matters.

**Verify the task survives a reboot without logon:** restart the PC and do
not log in for ~10 minutes. Then log in and run `python health_check.py`:
Longest gap should be about the reboot time only, and `startedUtc` in
`data/heartbeat.json` should be *before* your logon time. In Task Scheduler,
"WeatherHQ Collector" should show Last Run Time = boot time and
`(Get-ScheduledTask "WeatherHQ Collector").Principal.LogonType` = `S4U`.

## Validation

Three test layers, per the plan:

| Layer | Command | Time | When |
|---|---|---|---|
| 1 — Smoke | `pytest tests/test_collector_smoke.py` | ~6 min | every commit |
| 2 — Parity (unit) | `pytest tests/test_collector_parity.py` | <1 sec | every commit |
| 3 — 24h endurance | `python collector.py` then review | 24h | before declaring ready for ML |

Layer 2 verifies the Python port matches the JS reference algorithm at the
unit level. Layer 1 verifies the daemon writes well-formed records. Layer 3
verifies coverage stays ≥95% over a real day.

## Train/serve skew

The collector mirrors the browser's rain-timing path: it runs
`sample_edge_timing` (leading/trailing echo edge along the storm track ÷
closing speed) and feeds the edge result into `compute_precip_trend`, so a
confident "Rain starting ~3:45 PM" can fire — parity with
`_computePrecipTrend60m` in nowcast.js (v1.47.0). The slope timeline remains
the fallback when no motion vector is available.

**Critical rule:** any change to `src/services/nowcast.js` or
`src/services/radarSampler.js` must also be made in
`collector_lib/nowcast.py` or `collector_lib/radar_sampler.py`. Otherwise
the data the collector writes (which trains the ML model) will reflect a
different algorithm than what the browser displays (which uses the trained
model). The parity test catches this — failing parity is a release blocker.

See `weather_benchmark/CLAUDE.md` for the canonical statement of this rule.

## Troubleshooting

**No snapshots being written.** Check `data/logs/<city_slug>/`. If the dir
doesn't exist, the collector hasn't completed a single successful poll yet.
Look at the log output for `Rate limiter timeout` (IEM throttling) or
`Poll error` (exception during poll).

**All `model_unavailable` flags.** Open-Meteo is rate-limited or down.
Snapshots are still useful — the radar and METAR portions are intact. The
flag is informational, not an error.

**`radar.dbz` always null.** Probably an IEM tile fetch failure. Check
network connectivity to `mesonet.agron.iastate.edu`. The collector falls
back to neighboring tiles automatically when a tile is missing or near the
city's edge.

**Lightning state always 'none'.** If `lightning.connected` is also `false`
across every record, the shared GLM fetcher isn't reaching NOAA S3 — check
connectivity to `noaa-goes19.s3.amazonaws.com` and that `h5py` is installed
(`pip install -r requirements.txt`). If h5py is missing the collector logs a
warning once and falls back to METAR `TS` codes only. A `connected: true`
record with `state: 'none'` simply means GLM is working and there were no
flashes within 40 mi — the normal dry case. Set `glm_enabled: false` to
disable polling entirely.

## Optional: MRMS truth (backtest only)

MRMS (Multi-Radar Multi-Sensor) is NOAA's combined radar+gauge surface
QPE product. Using it as the truth label means each backtest snapshot is
graded against a co-located, time-matched ground reality (1 km × 1 km,
2-min cadence). The collector itself does not consume MRMS — this is
backtest-time only.

1. Get a `wgrib2` binary for your platform. The NOAA-EMC GitHub releases
   page (https://github.com/NOAA-EMC/wgrib2/releases) is source-only on
   Windows — for a pre-built Windows binary use Wesley Ebisuzaki's NCEP
   page at https://www.cpc.ncep.noaa.gov/products/wesley/wgrib2/ or a
   trusted mirror. v3.1.3 or later works.
2. Place the binary somewhere stable. The project auto-detects a copy at
   `<repo>/wgrib/wgrib2.exe` (which is where it is now).
3. (Optional) add the folder to PATH, OR set `mrms.wgrib2_path` in
   `weather_benchmark/config.yaml` to the absolute path.
4. Verify the binary works:
   ```
   "C:/path/to/wgrib2.exe" -version
   ```
5. Add `--mrms` to the backtest command:
   ```
   python backtest.py --start-date 2026-05-17 --end-date 2026-05-17 --mrms
   ```

The flag turns on MRMS preference in `lead_targets.py` for that run.
Resulting `weekly_*.json` reports include `truth_source` per snapshot so
metric shifts are auditable. If wgrib2 is missing, `--mrms` falls back
gracefully to mesonet/ASOS with a warning.

Each grid is downloaded once and every city is read from it in a single
wgrib2 call (`fetch_mrms_multi`). At the default 10-min cadence that is
~144 grids (~80 MB) per UTC day, about 75 s/day with 4 workers. Only
UTC-complete days with >=90% grid coverage are cached
(`data/obs_cache/mrms/<city>_<day>__v2_c10.csv`); later runs reuse them.

Note: MRMS PrecipRate is itself radar-derived. It is the right truth for
"was rain falling at this point at this minute", but it shares radar
artifacts (e.g. drizzle below the beam, some virga) with the nowcast's own
input, so keep the station (ASOS) truth alongside it.

## Optional: Synoptic mesonet truth (backtest only)

The collector itself does not query Synoptic — this is a backtest-time
enhancement that augments IEM ASOS truth labels with denser state mesonet
data. To enable it during scoring:

1. Register a free token at https://synopticdata.com/api (no credit card, ~2 min).
2. Export the token in the shell where you run the backtest:

   **PowerShell:** `$env:SYNOPTIC_TOKEN = "your-token-here"`
   **bash / Git Bash:** `export SYNOPTIC_TOKEN=your-token-here`

3. Add `--mesonet` to the backtest command:

   ```
   python backtest.py --start-date 2026-05-17 --end-date 2026-05-17 --mesonet
   ```

The flag turns on mesonet preference in `lead_targets.py` for that run.
Resulting `weekly_*.json` reports include `truth_source` per snapshot so
metric shifts are auditable. Token is never written to disk or committed.

If the token is missing, `--mesonet` falls back to ASOS-only with a warning.

## Architecture

```
collector.py (main)
├── threading.Event (stop signal)
├── TokenBucket (shared IEM rate limit)
├── GlmFetcher  (one shared thread — GOES GLM S3 poll → global flash buffer)
└── CityWorker × N  (one thread per city, never shares state)
    ├── RadarSampler  (per-city radar history + hysteresis)
    ├── fetch_iem_latest_metar
    ├── fetch_open_meteo (cached)
    ├── glm.summarize(lat, lon)  (read shared buffer → per-city lightning state)
    └── nowcast.derive_nowcast_state
        └── build_record → JSONL append
```

The GLM fetcher is independent of the IEM rate limiter — it hits NOAA's
anonymous S3 bucket (`noaa-goes19`), not the throttled IEM endpoints. One LCFA
file spans the whole satellite disk, so a single download per poll serves all
cities; each `CityWorker` reads the shared 20-minute flash buffer.

Each `CityWorker` owns its own `RadarSampler` instance. The browser's bug
where rotating between cities corrupted radar hysteresis (one global
`_rainState` for all cities) is structurally impossible here.
