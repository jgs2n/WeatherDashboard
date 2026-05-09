"""
Post-fix verification for nowcast JSONL logs.

Runs targeted checks for the three contamination vectors identified in the
2026-04-04 audit, plus schema normalization. Designed to give a clear
pass/fail verdict on whether the fixes are working.

Usage:
    python verify_fixes.py                        # check latest finalized log
    python verify_fixes.py path/to/file.jsonl     # check a specific file
    python verify_fixes.py --acquiring             # check in-progress file
"""

import json
import sys
from collections import defaultdict
from pathlib import Path

LOG_DIR = Path(__file__).parent / 'data' / 'logs'
CITIES_JSON = Path(__file__).parent / 'data' / 'cities.json'

# ── Load helpers ──────────────────────────────────────────────────────────────

STATION_META = {}
if CITIES_JSON.exists():
    for c in json.loads(CITIES_JSON.read_text()):
        if 'station' in c:
            STATION_META[c['station']] = c


def load_records(path):
    records = []
    with open(path, encoding='utf-8') as f:
        for i, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                print(f'  WARN: malformed line {i}')
    return records


def resolve_file(args):
    if args and not args[0].startswith('--'):
        return Path(args[0])
    if '--acquiring' in args:
        return LOG_DIR / 'acquiring.jsonl'
    candidates = sorted(
        (f for f in LOG_DIR.iterdir() if f.suffix == '.jsonl' and f.name != 'acquiring.jsonl'),
        key=lambda f: f.stat().st_mtime
    )
    if not candidates:
        print('No .jsonl files found in', LOG_DIR)
        sys.exit(1)
    return candidates[-1]


# ── Checks ────────────────────────────────────────────────────────────────────

def check_location_bleed(records):
    """Vector 1: locationName should match station, not bleed from active city."""
    issues = []
    by_station = defaultdict(set)

    for rec in records:
        st = rec.get('station')
        name = rec.get('locationName', '')
        if st:
            by_station[st].add(name)
            if st in STATION_META and STATION_META[st]['name'] != name:
                issues.append(f'{st} logged as "{name}" (expected "{STATION_META[st]["name"]}")')

    # Also flag stations that map to multiple names
    for st, names in by_station.items():
        if len(names) > 1:
            expected = STATION_META.get(st, {}).get('name', '?')
            issues.append(f'{st} has {len(names)} different locationNames: {names} (expected "{expected}")')

    return issues


def check_model_contamination(records):
    """Vector 2: model data should be per-city, not shared from active city globals."""
    issues = []

    # Collect model temps per station
    by_station_temps = defaultdict(list)
    model_present = 0
    model_null = 0

    for rec in records:
        model = rec.get('model')
        st = rec.get('station')
        if model is None:
            model_null += 1
            continue
        model_present += 1
        if st and model.get('temp') is not None:
            by_station_temps[st].append(model['temp'])

    # Test A: Adjacent cross-station records should NOT have identical model blocks
    sorted_recs = sorted(records, key=lambda x: x.get('timestamp', ''))
    identical = 0
    compared = 0
    for i in range(1, len(sorted_recs)):
        prev, curr = sorted_recs[i - 1], sorted_recs[i]
        if prev.get('station') == curr.get('station'):
            continue
        pm, cm = prev.get('model'), curr.get('model')
        if pm is None or cm is None:
            continue
        compared += 1
        if pm == cm:
            identical += 1

    if compared > 0:
        pct = 100 * identical / compared
        if pct > 50:
            issues.append(
                f'CRITICAL: {identical}/{compared} ({pct:.0f}%) adjacent cross-station records '
                f'have identical model blocks — model data is still from a shared global'
            )
        elif pct > 10:
            issues.append(
                f'WARNING: {identical}/{compared} ({pct:.0f}%) identical cross-station model blocks '
                f'— some overlap may be expected for nearby cities but this is high'
            )

    # Test B: Geographically distant stations should have different mean temps
    station_means = {}
    for st, temps in by_station_temps.items():
        if len(temps) >= 3:
            station_means[st] = sum(temps) / len(temps)

    if len(station_means) >= 2:
        sorted_means = sorted(station_means.items(), key=lambda x: x[1])
        spread = sorted_means[-1][1] - sorted_means[0][1]
        if spread < 2.0 and len(sorted_means) > 3:
            issues.append(
                f'Mean model temp spread across {len(sorted_means)} stations is only {spread:.1f}F '
                f'— suggests model data is shared, not per-city'
            )

    # Test C: Florida stations should not have temps below ~50F in April
    for st, temps in by_station_temps.items():
        meta = STATION_META.get(st, {})
        if meta.get('stateCode') == 'FL' and any(t < 45 for t in temps):
            cold = min(temps)
            issues.append(
                f'{st} ({meta.get("name", "?")}, FL) has model.temp={cold:.1f}F — '
                f'implausible for Florida, likely cross-contaminated from a northern city'
            )

    # Info: model=null count (expected for background polls under Option A)
    if model_null > 0 and model_present == 0:
        issues.append(
            f'INFO: All {model_null} records have model=null — model context not being passed at all'
        )

    return issues


def check_icon_condition_mismatch(records):
    """Vector 3: displayedIcon and displayedCondition should agree."""
    issues = []
    rain_icon_dry = 0
    clear_icon_rain = 0
    total = 0

    for rec in records:
        icon = rec.get('displayedIcon', '') or ''
        cond = rec.get('displayedCondition', '') or ''
        if not icon or not cond:
            continue
        total += 1

        icon_is_rain = bool(set(icon.split('-')) & {'rain', 'drizzle', 'thunder', 'snow', 'sleet'})
        cond_is_dry = cond == 'Dry'
        icon_is_clear = any(x in icon for x in ('clear', 'cloudy', 'overcast')) and not icon_is_rain
        cond_is_rain = any(x in cond.lower() for x in ('drizzle', 'rain', 'thunder', 'snow', 'sleet'))

        if icon_is_rain and cond_is_dry:
            rain_icon_dry += 1
        if icon_is_clear and cond_is_rain:
            clear_icon_rain += 1

    mismatches = rain_icon_dry + clear_icon_rain
    if mismatches > 0:
        issues.append(
            f'{mismatches}/{total} icon/condition mismatches '
            f'({rain_icon_dry} rain-icon+Dry, {clear_icon_rain} clear-icon+rain-cond)'
        )
    return issues


def check_schema(records):
    """Schema normalization: sky/trend should be objects, schema version = 2."""
    issues = []

    v1_count = sum(1 for r in records if r.get('_schemaVersion', 1) < 2)
    if v1_count == len(records):
        issues.append(f'All {len(records)} records are schema v1 — logger changes not deployed')
    elif v1_count > 0:
        issues.append(f'{v1_count}/{len(records)} records still at schema v1')

    sky_null = sum(1 for r in records if r.get('sky') is None)
    if sky_null > 0:
        issues.append(f'{sky_null} records have sky=null (should be object with null fields)')

    trend_null = sum(1 for r in records if r.get('trend') is None)
    if trend_null > 0:
        issues.append(f'{trend_null} records have trend=null (should be object with null fields)')

    return issues


def check_coord_consistency(records):
    """Coordinates should be stable per station and match cities.json."""
    issues = []
    by_station = defaultdict(list)

    for rec in records:
        st = rec.get('station')
        if st:
            by_station[st].append((rec.get('lat', 0), rec.get('lon', 0)))

    for st, coords in by_station.items():
        if st not in STATION_META:
            continue
        expected_lat = STATION_META[st]['lat']
        expected_lon = STATION_META[st]['lon']
        for lat, lon in coords:
            if abs(lat - expected_lat) > 0.5 or abs(lon - expected_lon) > 0.5:
                issues.append(
                    f'{st} record at ({lat:.3f}, {lon:.3f}) is far from expected '
                    f'({expected_lat:.3f}, {expected_lon:.3f}) — coordinate/station race condition'
                )
                break  # one example is enough

    return issues


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    path = resolve_file(sys.argv[1:])
    records = load_records(path)

    if not records:
        print(f'No records in {path}')
        sys.exit(1)

    print(f'\n{"=" * 70}')
    print(f'VERIFICATION: {path.name}')
    print(f'{len(records)} records')
    print(f'{"=" * 70}')

    # Station summary
    stations = defaultdict(int)
    for r in records:
        stations[r.get('station', '?')] += 1
    print(f'\nStations: {dict(stations)}')

    checks = [
        ('Vector 1: Location metadata bleed', check_location_bleed(records)),
        ('Vector 2: Model cross-contamination', check_model_contamination(records)),
        ('Vector 3: Icon/condition mismatch', check_icon_condition_mismatch(records)),
        ('Schema normalization', check_schema(records)),
        ('Coordinate consistency', check_coord_consistency(records)),
    ]

    all_pass = True
    for name, issues in checks:
        if issues:
            # Distinguish INFO-only from real failures
            real_issues = [i for i in issues if not i.startswith('INFO:')]
            if real_issues:
                all_pass = False
                print(f'\n[FAIL] {name}')
            else:
                print(f'\n[INFO] {name}')
            for issue in issues:
                print(f'       {issue}')
        else:
            print(f'\n[PASS] {name}')

    print(f'\n{"─" * 70}')
    if all_pass:
        print('ALL CHECKS PASSED — contamination vectors resolved.')
    else:
        print('ISSUES FOUND — see details above.')
    print(f'{"─" * 70}\n')

    sys.exit(0 if all_pass else 1)


if __name__ == '__main__':
    main()
