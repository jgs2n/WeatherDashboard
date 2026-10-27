"""Distance-resolved lightning verification against Blitzortung ground truth.

Companion to lightning_eval.py (which scores EPISODES against airport METAR
thunder). This one scores EVERY POLL against the Blitzortung strike archive
recorded by collector_lib/blitzortung_truth.py, so it answers:

  - When lightning really was within 10/20/40 mi, did the app say so?  (POD)
  - When the app cried wolf, was anything really there?                (FAR)
  - How far off is the reported "nearest flash" distance?
  - What does a COLD-START app open see (only the backfilled window)?

Truth bands are computed with the exact thresholds the detector uses
(BAND_10MI/20MI/40MI windows in collector_lib/lightning.py), so a
truth-vs-shown disagreement is a real detector miss, not a definitional one.

Usage (from weather_benchmark/):
    python lightning_truth_eval.py                  # last 7 days
    python lightning_truth_eval.py --days 3
    python lightning_truth_eval.py --cities Atlanta Savannah
    python lightning_truth_eval.py --json reports/truth_eval.json
    python lightning_truth_eval.py --include-uncovered   # pre-coverage behaviour
    python lightning_truth_eval.py --start 2026-09-01 --end 2026-10-15

Coverage: polls whose 30-min truth window was not fully recorded by the
Blitzortung recorder (see data/lightning_truth/coverage/, written by
collector_lib/blitzortung_truth.py) are excluded — "no strikes" there means
"recorder was down", not "no lightning". Polls older than the first coverage
event are 'unknown' and kept (no way to tell), but counted separately.
"""

import argparse
import bisect
import json
import glob
import math
import os
import statistics
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

from collector_lib.lightning import (
    BAND_10MI_WINDOW, BAND_20MI_WINDOW, BAND_40MI_WINDOW, flash_miles,
)

HERE = os.path.dirname(os.path.abspath(__file__))
RANK = {'none': 0, 'approaching': 1, 'nearby': 2, 'active': 3}
# Blitzortung is a volunteer TOA network: good CONUS detection efficiency for
# cloud-to-ground, weaker on intracloud (which GLM sees well). A GLM warning
# with no truth strike nearby is therefore only *probably* a false alarm.
COLD_START_BACKFILL_MIN = 10   # v0.9.5 cold-start budget (COLD_START_MAX_FILES)
# Recorder liveness: an interval runs connect → disconnect; without a
# disconnect (crash/kill) it ends one heartbeat-grace after the last heartbeat.
HEARTBEAT_GRACE_MS = 90 * 1000
# Gaps shorter than this between intervals (a quick reconnect) still count as
# covered — strikes in a few seconds of reconnect are negligible.
COVERAGE_GAP_TOL_MS = 120 * 1000


def load_cities():
    with open(os.path.join(HERE, 'data', 'cities.json'), encoding='utf-8') as f:
        data = json.load(f)
    cities = data if isinstance(data, list) else data.get('cities', [])
    return [c for c in cities if not c.get('holdout')]


def city_slug(name):
    return name.lower().replace(' ', '_').replace(',', '')


def iso_ms(s):
    return datetime.fromisoformat(s).timestamp() * 1000.0


def load_truth(cities, start, end):
    """{city_name: [(time_ms, dist_mi), ...]} for strikes within 45 mi."""
    out = {c['name']: [] for c in cities}
    # Cheap bbox prefilter before the (expensive) timestamp parse.
    boxes = [(c['name'], c['lat'], c['lon'],
              45.0 / 69.0,
              45.0 / (69.0 * max(math.cos(math.radians(c['lat'])), 0.2)))
             for c in cities]
    files = sorted(glob.glob(os.path.join(HERE, 'data', 'lightning_truth', '*.jsonl')))
    scanned = kept = 0
    for path in files:
        day = os.path.basename(path)[:10]
        # File names are UTC days; keep one day of slack on each side.
        if day < (start - timedelta(days=1)).strftime('%Y-%m-%d'):
            continue
        if day > end.strftime('%Y-%m-%d'):
            continue
        with open(path, encoding='utf-8') as f:
            for line in f:
                scanned += 1
                try:
                    s = json.loads(line)
                    lat, lon = s['lat'], s['lon']
                except (ValueError, KeyError):
                    continue
                hits = [(name, clat, clon) for name, clat, clon, dlat, dlon in boxes
                        if abs(lat - clat) <= dlat and abs(lon - clon) <= dlon]
                if not hits:
                    continue
                try:
                    t = iso_ms(s['t'])
                except (ValueError, KeyError):
                    continue
                for name, clat, clon in hits:
                    d = flash_miles(clat, clon, lat, lon)
                    if d <= 45:
                        out[name].append((t, d))
                        kept += 1
    for name in out:
        out[name].sort()
    return out, scanned, kept


def load_coverage(start, end):
    """Merged recorder-alive intervals [(start_ms, end_ms)], plus the time of
    the first coverage event (None if no coverage data exists at all)."""
    files = sorted(glob.glob(os.path.join(HERE, 'data', 'lightning_truth', 'coverage', '*.jsonl')))
    events = []
    for path in files:
        day = os.path.basename(path)[:10]
        if day < (start - timedelta(days=2)).strftime('%Y-%m-%d') or day > end.strftime('%Y-%m-%d'):
            continue
        with open(path, encoding='utf-8') as f:
            for line in f:
                try:
                    e = json.loads(line)
                    events.append((iso_ms(e['t']), e['event']))
                except (ValueError, KeyError):
                    continue
    return merge_coverage(events)


def merge_coverage(events):
    """[(time_ms, event)] -> (merged alive intervals, first event time or None)."""
    events = sorted(events)
    intervals = []
    cur_start = cur_end = None
    for t, ev in events:
        if ev == 'connect':
            if cur_start is not None:   # no disconnect seen: recorder died
                intervals.append((cur_start, cur_end + HEARTBEAT_GRACE_MS))
            cur_start = cur_end = t
        elif cur_start is None:
            continue                    # heartbeat/disconnect before any connect in range
        elif ev == 'heartbeat':
            cur_end = t
        elif ev == 'disconnect':
            intervals.append((cur_start, t))
            cur_start = cur_end = None
    if cur_start is not None:
        intervals.append((cur_start, cur_end + HEARTBEAT_GRACE_MS))

    merged = []
    for a, b in sorted(intervals):
        if merged and a - merged[-1][1] <= COVERAGE_GAP_TOL_MS:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b))
        else:
            merged.append((a, b))
    first = events[0][0] if events else None
    return merged, first


def window_coverage(merged, first_event_ms, lo_ms, hi_ms):
    """'covered' | 'uncovered' | 'unknown' for the truth window [lo, hi]."""
    if first_event_ms is None or lo_ms < first_event_ms:
        return 'unknown'
    i = bisect.bisect_right(merged, (lo_ms, float('inf'))) - 1
    if i >= 0 and merged[i][0] <= lo_ms and merged[i][1] >= hi_ms:
        return 'covered'
    return 'uncovered'


def load_records(slug, start, end):
    recs = []
    pattern = os.path.join(HERE, 'data', 'logs', slug, '*.jsonl')
    for path in sorted(glob.glob(pattern)):
        day = os.path.basename(path)[:10]
        if day < (start - timedelta(days=1)).strftime('%Y-%m-%d'):
            continue
        with open(path, encoding='utf-8') as f:
            for line in f:
                try:
                    r = json.loads(line)
                    t = iso_ms(r['timestamp'])
                except (ValueError, KeyError):
                    continue
                if start.timestamp() * 1000 <= t <= end.timestamp() * 1000:
                    recs.append((t, r))
    recs.sort(key=lambda x: x[0])
    return recs


def truth_state(strikes, lo, hi, now_ms, *, floor_ms=None):
    """Detector's own band logic applied to ground-truth strikes.

    ``floor_ms`` simulates a cold start: strikes older than the floor are
    invisible because they were never ingested.
    """
    c10 = now_ms - BAND_10MI_WINDOW
    c15 = now_ms - BAND_20MI_WINDOW
    c30 = now_ms - BAND_40MI_WINDOW
    if floor_ms is not None:
        c10, c15, c30 = max(c10, floor_ms), max(c15, floor_ms), max(c30, floor_ms)
    w10 = w20 = w40 = 0
    nearest = None
    for i in range(lo, hi):
        t, d = strikes[i]
        if t >= c30 and (nearest is None or d < nearest):
            nearest = d
        if d <= 10 and t >= c10:
            w10 += 1
        if d <= 20 and t >= c15:
            w20 += 1
        if d <= 40 and t >= c30:
            w40 += 1
    if w10 > 0:
        return 'active', nearest, (w10, w20, w40)
    if w20 > 0:
        return 'nearby', nearest, (w10, w20, w40)
    if w40 >= 2:
        return 'approaching', nearest, (w10, w20, w40)
    return 'none', nearest, (w10, w20, w40)


def window_bounds(strikes, now_ms, span_ms):
    """[lo, hi) index range of strikes in (now-span, now]."""
    lo = bisect.bisect_left(strikes, (now_ms - span_ms, -1))
    hi = bisect.bisect_right(strikes, (now_ms, 1e9))
    return lo, hi


def pct(n, d):
    return f'{100.0 * n / d:.0f}%' if d else 'n/a'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--days', type=int, default=7)
    ap.add_argument('--cities', nargs='*')
    ap.add_argument('--json', help='write the full result as JSON here')
    ap.add_argument('--start', help='window start YYYY-MM-DD (UTC); overrides --days')
    ap.add_argument('--end', help='window end YYYY-MM-DD (UTC, exclusive); default now')
    ap.add_argument('--include-uncovered', action='store_true',
                    help='score polls even when the recorder was down for their window')
    args = ap.parse_args()

    end = (datetime.fromisoformat(args.end).replace(tzinfo=timezone.utc) if args.end
           else datetime.now(timezone.utc))
    start = (datetime.fromisoformat(args.start).replace(tzinfo=timezone.utc) if args.start
             else end - timedelta(days=args.days))
    cities = load_cities()
    if args.cities:
        want = {c.lower() for c in args.cities}
        cities = [c for c in cities if c['name'].lower() in want]

    print(f'LIGHTNING TRUTH JOIN — {start:%Y-%m-%d %H:%M}Z to {end:%Y-%m-%d %H:%M}Z, '
          f'{len(cities)} cities')
    truth, scanned, kept = load_truth(cities, start, end)
    print(f'Blitzortung: {scanned:,} strikes scanned, {kept:,} within 45 mi of a city')
    cov_intervals, cov_first = load_coverage(start, end)
    print(f'Recorder coverage: {len(cov_intervals):,} alive interval(s)'
          + (f' since {datetime.fromtimestamp(cov_first / 1000, timezone.utc):%Y-%m-%d %H:%MZ}'
             if cov_first else ' - no coverage log yet (all polls "unknown")') + '\n')
    coverage = Counter()

    confusion = Counter()          # (truth_state, shown_state)
    dist_err = []                  # shown nearest - truth nearest (mi)
    cold_gap = Counter()           # cold-start simulation: (full_state, cold_state)
    per_city = defaultdict(Counter)
    polls = 0
    disconnected = 0
    stale_buffer = 0

    for c in cities:
        strikes = truth[c['name']]
        recs = load_records(city_slug(c['name']), start, end)
        for now_ms, r in recs:
            cov = window_coverage(cov_intervals, cov_first, now_ms - BAND_40MI_WINDOW, now_ms)
            coverage[cov] += 1
            if cov == 'uncovered' and not args.include_uncovered:
                continue
            lt = r.get('lightning') or {}
            shown = lt.get('state') or 'none'
            polls += 1
            if lt.get('connected') is False:
                disconnected += 1
            age = lt.get('bufferAgeMs')
            if age is not None and age > BAND_40MI_WINDOW and shown != 'none':
                stale_buffer += 1
            lo, hi = window_bounds(strikes, now_ms, BAND_40MI_WINDOW)
            tstate, tnear, _ = truth_state(strikes, lo, hi, now_ms)
            confusion[(tstate, shown)] += 1
            per_city[c['name']][(tstate, shown)] += 1
            if tnear is not None and lt.get('nearestFlashMi') is not None:
                dist_err.append(lt['nearestFlashMi'] - tnear)
            if tstate != 'none':
                cstate, _, _ = truth_state(
                    strikes, lo, hi, now_ms,
                    floor_ms=now_ms - COLD_START_BACKFILL_MIN * 60 * 1000)
                cold_gap[(tstate, cstate)] += 1

    def truth_row(tstate):
        rows = {shown: n for (t, shown), n in confusion.items() if t == tstate}
        return rows, sum(rows.values())

    print(f'Polls scored: {polls:,}  (GLM disconnected in {disconnected}, '
          f'warning shown on a >30-min-stale buffer {stale_buffer})')
    print(f'Truth-window coverage: covered {coverage["covered"]:,}, '
          f'unknown (pre-coverage-log) {coverage["unknown"]:,}, '
          f'uncovered {coverage["uncovered"]:,} '
          f'({"included" if args.include_uncovered else "excluded"})\n')

    print('TRUTH → SHOWN  (rows = Blitzortung reality, cols = what the app showed)')
    print(f"{'truth':<13}{'n':>7}  {'none':>7}{'apprch':>8}{'nearby':>8}{'active':>8}")
    for tstate in ('active', 'nearby', 'approaching', 'none'):
        rows, n = truth_row(tstate)
        print(f'{tstate:<13}{n:>7}  '
              f"{rows.get('none', 0):>7}{rows.get('approaching', 0):>8}"
              f"{rows.get('nearby', 0):>8}{rows.get('active', 0):>8}")
    print()

    # Safety-relevant scores.
    for label, tset, ok_shown in (
        ('CLOSE lightning (<=10 mi / 10 min)', {'active'}, {'active'}),
        ('NEAR lightning (<=20 mi)', {'active', 'nearby'}, {'active', 'nearby'}),
        ('ANY lightning (<=40 mi)', {'active', 'nearby', 'approaching'},
         {'active', 'nearby', 'approaching'}),
    ):
        hits = sum(n for (t, s), n in confusion.items() if t in tset and s in ok_shown)
        total = sum(n for (t, s), n in confusion.items() if t in tset)
        under = sum(n for (t, s), n in confusion.items()
                    if t in tset and RANK[s] < min(RANK[x] for x in ok_shown))
        shown_n = sum(n for (t, s), n in confusion.items() if s in ok_shown)
        false_n = sum(n for (t, s), n in confusion.items()
                      if s in ok_shown and t == 'none')
        print(f'{label}:')
        print(f'  detection (POD)      {pct(hits, total)}   ({hits}/{total} truth polls '
              f'warned at the right tier or higher; {under} under-warned)')
        print(f'  no-truth rate (FAR)  {pct(false_n, shown_n)}   ({false_n}/{shown_n} '
              f'shown polls had zero Blitzortung strikes within 40 mi/30 min)')
    print()

    if dist_err:
        dist_err.sort()
        med = statistics.median(dist_err)
        q1 = dist_err[len(dist_err) // 4]
        q3 = dist_err[3 * len(dist_err) // 4]
        print(f'Nearest-flash distance error (shown - truth), {len(dist_err)} paired polls:')
        print(f'  median {med:+.1f} mi   IQR {q1:+.1f}..{q3:+.1f} mi   '
              f'|err|<=5 mi on {pct(sum(1 for e in dist_err if abs(e) <= 5), len(dist_err))}\n')

    cold_total = sum(cold_gap.values())
    if cold_total:
        degraded = sum(n for (full, cold), n in cold_gap.items() if RANK[cold] < RANK[full])
        blind = sum(n for (full, cold), n in cold_gap.items() if cold == 'none')
        print(f'COLD-START SIM (fresh app open, {COLD_START_BACKFILL_MIN}-min backfill only), '
              f'{cold_total} truth-lightning polls:')
        print(f'  under-tiered vs a warm buffer  {pct(degraded, cold_total)}')
        print(f'  shows nothing at all           {pct(blind, cold_total)}\n')

    print('PER-CITY (truth-lightning polls / of those, warned at some tier)')
    for name in sorted(per_city):
        rows = per_city[name]
        tl = sum(n for (t, s), n in rows.items() if t != 'none')
        warned = sum(n for (t, s), n in rows.items() if t != 'none' and s != 'none')
        fa = sum(n for (t, s), n in rows.items() if t == 'none' and s != 'none')
        if tl or fa:
            print(f'  {name:<12} truth {tl:>5}  warned {pct(warned, tl):>5}  '
                  f'shown-without-truth {fa:>5}')

    if args.json:
        payload = {
            'window': {'start': start.isoformat(), 'end': end.isoformat(),
                       'days': round((end - start).total_seconds() / 86400, 2)},
            'polls': polls,
            'coverage': dict(coverage),
            'uncovered_excluded': not args.include_uncovered,
            'confusion': {f'{t}->{s}': n for (t, s), n in confusion.items()},
            'dist_err_median': statistics.median(dist_err) if dist_err else None,
            'cold_start': {f'{f}->{c}': n for (f, c), n in cold_gap.items()},
            'per_city': {name: {f'{t}->{s}': n for (t, s), n in rows.items()}
                         for name, rows in per_city.items()},
        }
        with open(args.json, 'w', encoding='utf-8') as f:
            json.dump(payload, f, indent=1)
        print(f'\nWrote {args.json}')


if __name__ == '__main__':
    main()
