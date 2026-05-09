"""
Collection Health Check — live integrity probe for acquiring.jsonl.

Unlike verify_fixes.py / audit_fixes.py, which regression-test the
2026-04-04 contamination fixes on *finalized* logs, this script targets
the currently-being-written acquiring.jsonl by default and answers a
different question: "is collection working right now?"

Checks: recency, record count, per-city balance, median/longest gap,
per-city dwell cadence, radar/lightning null rate, schema version,
validation flags, and file/sibling state.

Usage:
    python health_check.py                    # inspect acquiring.jsonl (default)
    python health_check.py --finalized        # inspect newest finalized YYYY-*.jsonl
    python health_check.py path/to/file.jsonl # inspect a specific file
    python health_check.py --json             # machine-readable output (for server.py)

Exit codes: 0 = all ok, 1 = any warn, 2 = any fail.
"""

import argparse
import json
import statistics
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

LOG_DIR = Path(__file__).parent / 'data' / 'logs'
ACQUIRING = LOG_DIR / 'acquiring.jsonl'

# Thresholds
RECENCY_WARN_S = 5 * 60
RECENCY_FAIL_S = 15 * 60
GAP_WARN_S     = 15 * 60
BALANCE_WARN   = 3.0   # max/min ratio across cities
RADAR_NULL_WARN_PCT = 80.0
EXPECTED_DWELL_S = 10 * 60  # per Phase 1 sequential rotation


# ── JSONL loader (tolerant of trailing partial line on the live file) ────────

def load_records(path):
    records = []
    if not path.is_file():
        return records
    try:
        with open(path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError:
                    # Trailing partial line during live write — safe to skip.
                    continue
    except OSError:
        pass
    return records


def resolve_target_file(args):
    if args.path:
        return Path(args.path)
    if args.finalized:
        if not LOG_DIR.is_dir():
            return ACQUIRING
        finals = sorted(
            (f for f in LOG_DIR.iterdir()
             if f.suffix == '.jsonl' and f.name != 'acquiring.jsonl'),
            key=lambda f: f.stat().st_mtime,
        )
        return finals[-1] if finals else ACQUIRING
    return ACQUIRING


# ── Checks ──────────────────────────────────────────────────────────────────

class Check:
    __slots__ = ('name', 'status', 'message')

    def __init__(self, name, status, message):
        self.name = name
        self.status = status  # 'ok' | 'info' | 'warn' | 'fail'
        self.message = message

    def to_dict(self):
        return {'name': self.name, 'status': self.status, 'message': self.message}


def _fmt_age(seconds):
    if seconds < 90:
        return f'{seconds:.0f}s'
    if seconds < 3600:
        return f'{seconds / 60:.1f} min'
    return f'{seconds / 3600:.2f} h'


def _parse_ts(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace('Z', '+00:00'))
    except (ValueError, AttributeError):
        return None


def check_file_status(path, records):
    if not path.is_file():
        return Check('File status', 'fail', f'{path.name} does not exist')
    size = path.stat().st_size
    # Look for stale sibling acquiring.jsonl* files (none should exist — they
    # would indicate a crash mid-finalize).
    stale = []
    for f in LOG_DIR.iterdir() if LOG_DIR.is_dir() else []:
        if f.name.startswith('acquiring.jsonl') and f.name != 'acquiring.jsonl':
            stale.append(f.name)
    if stale:
        return Check('File status',
                     'warn',
                     f'{path.name} ({size} B, {len(records)} rec) + stale siblings: {stale}')
    return Check('File status', 'ok',
                 f'{path.name} ({size} B, {len(records)} rec)')


def check_recency(records, now_utc):
    if not records:
        return Check('Recency', 'fail', 'no records')
    timestamps = [_parse_ts(r.get('timestamp')) for r in records]
    timestamps = [t for t in timestamps if t is not None]
    if not timestamps:
        return Check('Recency', 'fail', 'no parseable timestamps')
    newest = max(timestamps)
    age = (now_utc - newest).total_seconds()
    msg = f'newest record {_fmt_age(age)} ago'
    if age > RECENCY_FAIL_S:
        return Check('Recency', 'fail', msg)
    if age > RECENCY_WARN_S:
        return Check('Recency', 'warn', msg)
    return Check('Recency', 'ok', msg)


def check_record_count(records):
    per_station = Counter(r.get('station', '?') for r in records)
    if not records:
        return Check('Record count', 'fail', '0 records')

    top = ', '.join(f'{st}={n}' for st, n in per_station.most_common(10))
    total = sum(per_station.values())
    return Check('Record count', 'ok', f'{total} total across {len(per_station)} stations; {top}')


def check_balance(records):
    per_station = Counter(r.get('station', '?') for r in records)
    eligible = {s: n for s, n in per_station.items() if n >= 3 and s and s != '?'}
    if len(eligible) < 2:
        return Check('Per-city balance', 'info', f'only {len(eligible)} station(s) with ≥3 records')
    mx_station, mx = max(eligible.items(), key=lambda kv: kv[1])
    mn_station, mn = min(eligible.items(), key=lambda kv: kv[1])
    ratio = mx / mn if mn else float('inf')
    msg = f'{mx_station}={mx}, {mn_station}={mn} ({ratio:.1f}x)'
    if ratio > BALANCE_WARN:
        return Check('Per-city balance', 'warn', msg)
    return Check('Per-city balance', 'ok', msg)


def _sorted_stamps(records, station=None):
    out = []
    for r in records:
        if station is not None and r.get('station') != station:
            continue
        t = _parse_ts(r.get('timestamp'))
        if t is not None:
            out.append(t)
    out.sort()
    return out


def check_gaps(records):
    stamps = _sorted_stamps(records)
    if len(stamps) < 2:
        return Check('Record gaps', 'info', 'need ≥2 records')
    deltas = [(stamps[i] - stamps[i - 1]).total_seconds() for i in range(1, len(stamps))]
    med = statistics.median(deltas)
    mx = max(deltas)
    mx_idx = deltas.index(mx)
    when = stamps[mx_idx + 1].isoformat().replace('+00:00', 'Z')
    msg = f'median {_fmt_age(med)}, longest {_fmt_age(mx)} at {when}'
    if mx > GAP_WARN_S:
        return Check('Record gaps', 'warn', msg)
    return Check('Record gaps', 'ok', msg)


def check_dwell_cadence(records):
    """Check that each station is receiving records at a healthy cadence.

    The nowcast logger writes every ~60s during the dwell window (10 min per
    city).  So within a single visit, per-station gaps are ~60s.  Between
    visits the gap is ~(dwell × (N-1)) — much larger.  The median is
    dominated by the within-dwell 60s gaps.

    What we actually care about:
    1. Is every station getting visited regularly? → check that no station
       has a gap longer than 2× the full rotation period.
    2. Is the logger firing within each dwell? → median per-station gap
       should be in the ballpark of 60s, certainly under 5 min.
    """
    # With Phase 1's stopTabRefresh() fix, the background 5-min re-fetch is
    # disabled during collection.  The logger only fires on switchLocation
    # and any manual refreshes, so each city typically gets 1-2 records per
    # 10-min dwell.  The per-station median gap is dominated by a mix of
    # within-visit gaps (~5 min) and inter-visit gaps (~50 min for 6 cities),
    # landing around 15-20 min in practice.  Warn only if the median is so
    # high that the logger appears stalled or the rotation has broken.
    MEDIAN_WARN_S     = 45 * 60  # warn if median gap > 45 min

    per_station_stamps = defaultdict(list)
    for r in records:
        st = r.get('station')
        t = _parse_ts(r.get('timestamp'))
        if st and t is not None:
            per_station_stamps[st].append(t)

    station_medians = []
    station_maxes = []
    for st, stamps in per_station_stamps.items():
        stamps.sort()
        if len(stamps) < 3:
            continue
        deltas = [(stamps[i] - stamps[i - 1]).total_seconds() for i in range(1, len(stamps))]
        station_medians.append((st, statistics.median(deltas)))
        station_maxes.append((st, max(deltas)))

    if not station_medians:
        return Check('Dwell cadence', 'info', 'need ≥3 records per station')

    n_cities = max(1, len(per_station_stamps))
    rotation_s = EXPECTED_DWELL_S * n_cities  # full rotation period
    overall_median = statistics.median(m for _, m in station_medians)
    worst_station, worst_max = max(station_maxes, key=lambda x: x[1])

    msg = (f'median gap {_fmt_age(overall_median)}, '
           f'longest single-station gap {_fmt_age(worst_max)} ({worst_station}), '
           f'{n_cities} cities')

    # Warn if median gap is way above the logger interval (logger stalling)
    if overall_median > MEDIAN_WARN_S:
        return Check('Dwell cadence', 'warn', msg)
    # Warn if any station has a gap > 2× full rotation (missed a full cycle)
    if worst_max > rotation_s * 2:
        return Check('Dwell cadence', 'warn', msg)
    return Check('Dwell cadence', 'ok', msg)


def check_radar_nulls(records):
    """Check radar data presence.  Note: dbz is legitimately null on dry days
    (no precipitation in range).  Only the radar *object* being entirely null
    indicates a sampling failure — that means the canvas pipeline didn't run."""
    if not records:
        return Check('Radar sampling', 'info', 'no records')
    null_radar = sum(1 for r in records if not r.get('radar'))
    null_dbz = sum(1 for r in records
                   if r.get('radar') and r['radar'].get('dbz') is None)
    total = len(records)
    pct_null_radar = 100 * null_radar / total
    msg = f'{null_radar} radar-null, {null_dbz} dbz-null ({null_radar + null_dbz}/{total})'
    # Only warn if the radar OBJECT is missing (sampling broken), not dbz-null
    # (which just means no precipitation — totally normal on dry days).
    if pct_null_radar > RADAR_NULL_WARN_PCT:
        return Check('Radar sampling', 'warn', msg)
    return Check('Radar sampling', 'ok', msg)


def check_lightning_nulls(records):
    if not records:
        return Check('Lightning feed', 'info', 'no records')
    null_l = sum(1 for r in records if r.get('lightning') is None)
    pct = 100 * null_l / len(records)
    return Check('Lightning feed', 'info',
                 f'{null_l}/{len(records)} null ({pct:.0f}%)')


def check_schema(records):
    if not records:
        return Check('Schema v2', 'info', 'no records')
    v1 = sum(1 for r in records if r.get('_schemaVersion', 1) < 2)
    if v1:
        return Check('Schema v2', 'fail',
                     f'{v1}/{len(records)} records still at v1 (logger regression)')
    return Check('Schema v2', 'ok', f'all {len(records)} records at v2')


def check_validation_flags(records):
    flags = Counter()
    flagged = 0
    for r in records:
        fl = r.get('_validationFlags')
        if fl:
            flagged += 1
            for f in fl:
                flags[f] += 1
    if not flagged:
        return Check('Validation flags', 'ok', f'0/{len(records)} flagged')
    top = ', '.join(f'{f}={n}' for f, n in flags.most_common(3))
    return Check('Validation flags', 'info',
                 f'{flagged}/{len(records)} flagged; top: {top}')


def compute_checks(records, path, now_utc):
    return [
        check_file_status(path, records),
        check_recency(records, now_utc),
        check_record_count(records),
        check_balance(records),
        check_gaps(records),
        check_dwell_cadence(records),
        check_radar_nulls(records),
        check_lightning_nulls(records),
        check_schema(records),
        check_validation_flags(records),
    ]


# ── Output ──────────────────────────────────────────────────────────────────

STATUS_ICON = {'ok': '✓', 'info': 'i', 'warn': '⚠', 'fail': '✗'}
STATUS_RANK = {'ok': 0, 'info': 0, 'warn': 1, 'fail': 2}


def summarize(checks):
    warns = sum(1 for c in checks if c.status == 'warn')
    fails = sum(1 for c in checks if c.status == 'fail')
    if fails:
        summary = f'{fails} failure(s), {warns} warning(s)'
        worst = 'fail'
    elif warns:
        summary = f'{warns} warning(s)'
        worst = 'warn'
    else:
        summary = 'all checks passed'
        worst = 'ok'
    return summary, worst


def print_text(path, records, checks):
    summary, _ = summarize(checks)
    print(f'\n{"=" * 70}')
    print(f'HEALTH CHECK: {path}')
    print(f'{len(records)} records · {summary}')
    print(f'{"=" * 70}\n')
    for c in checks:
        icon = STATUS_ICON.get(c.status, '?')
        print(f'  {icon}  {c.name:<22} {c.message}')
    print()


def print_json(path, records, checks):
    summary, worst = summarize(checks)
    payload = {
        'ok': worst == 'ok',
        'path': str(path),
        'records': len(records),
        'summary': summary,
        'worst_status': worst,
        'checks': [c.to_dict() for c in checks],
    }
    print(json.dumps(payload))


def exit_code(checks):
    worst_rank = max((STATUS_RANK.get(c.status, 0) for c in checks), default=0)
    return worst_rank  # 0 ok, 1 warn, 2 fail


# ── Main ────────────────────────────────────────────────────────────────────

def main():
    # Force UTF-8 on stdout so the ✓/⚠/✗ glyphs don't trip cp1252 on Windows.
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

    parser = argparse.ArgumentParser(description='Collection health check')
    parser.add_argument('path', nargs='?', default=None,
                        help='Explicit JSONL path (default: acquiring.jsonl)')
    parser.add_argument('--finalized', action='store_true',
                        help='Inspect newest finalized log instead of acquiring.jsonl')
    parser.add_argument('--json', action='store_true',
                        help='Emit JSON on stdout (for API consumption)')
    args = parser.parse_args()

    target = resolve_target_file(args)
    records = load_records(target)
    now_utc = datetime.now(timezone.utc)
    checks = compute_checks(records, target, now_utc)

    if args.json:
        print_json(target, records, checks)
    else:
        print_text(target, records, checks)

    sys.exit(exit_code(checks))


if __name__ == '__main__':
    main()
