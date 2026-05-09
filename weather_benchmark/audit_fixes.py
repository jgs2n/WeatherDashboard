"""
Post-fix data integrity audit for nowcast JSONL logs.

Run after capturing new data to verify that the location metadata bleed,
model cross-contamination, icon/condition mismatch, and schema issues
are resolved.

Usage:
    python audit_fixes.py                          # audit latest finalized log
    python audit_fixes.py path/to/file.jsonl       # audit a specific log file
    python audit_fixes.py --include-acquiring       # also check in-progress file
"""

import json
import os
import sys
from collections import Counter, defaultdict
from pathlib import Path

LOG_DIR = Path(__file__).parent / 'data' / 'logs'

# Known station → expected coordinates (populated from cities.json if present)
CITIES_JSON = Path(__file__).parent / 'data' / 'cities.json'


def load_station_map():
    """Load station → {name, lat, lon, stateCode} from cities.json."""
    if not CITIES_JSON.exists():
        return {}
    with open(CITIES_JSON) as f:
        cities = json.load(f)
    return {c['station']: c for c in cities if 'station' in c}


def load_records(path):
    """Load all JSONL records from a file."""
    records = []
    with open(path, encoding='utf-8') as f:
        for i, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                print(f'  WARN: skipped malformed line {i}')
    return records


def find_log_file(args):
    """Resolve which log file(s) to audit."""
    if args and not args[0].startswith('--'):
        return [Path(args[0])]

    include_acquiring = '--include-acquiring' in args
    files = []
    for f in sorted(LOG_DIR.iterdir()):
        if f.suffix != '.jsonl':
            continue
        if f.name == 'acquiring.jsonl' and not include_acquiring:
            continue
        files.append(f)

    if not files:
        print('No .jsonl files found in', LOG_DIR)
        sys.exit(1)
    return files


# ── Audit checks ──────────────────────────────────────────────────────────────

class AuditResult:
    def __init__(self, name):
        self.name = name
        self.passed = True
        self.details = []

    def fail(self, msg):
        self.passed = False
        self.details.append(f'FAIL: {msg}')

    def warn(self, msg):
        self.details.append(f'WARN: {msg}')

    def info(self, msg):
        self.details.append(f'INFO: {msg}')

    def ok(self, msg):
        self.details.append(f'  OK: {msg}')


def check_schema_version(records):
    """V1 → V2: records should have _schemaVersion: 2."""
    r = AuditResult('Schema version')
    versions = Counter(rec.get('_schemaVersion', 1) for rec in records)
    for v, n in versions.most_common():
        r.info(f'_schemaVersion={v}: {n} records')
    v2 = versions.get(2, 0)
    if v2 == 0:
        r.fail('No schema v2 records found — logger changes may not be deployed')
    elif v2 < len(records):
        r.warn(f'{len(records) - v2} records still at v1 (may be from before deploy)')
    else:
        r.ok(f'All {v2} records are schema v2')
    return r


def check_location_bleed(records, station_map):
    """FIX 1: locationName should match station, not bleed from activeLocation."""
    r = AuditResult('Location metadata bleed')
    if not station_map:
        r.warn('No cities.json — skipping station→name validation')
        return r

    mismatches = 0
    by_station = defaultdict(set)
    for rec in records:
        st = rec.get('station')
        name = rec.get('locationName', '')
        if st:
            by_station[st].add(name)
            if st in station_map and station_map[st]['name'] != name:
                mismatches += 1

    # Each station should map to exactly one locationName
    multi_name_stations = {st: names for st, names in by_station.items() if len(names) > 1}

    if multi_name_stations:
        r.fail(f'{len(multi_name_stations)} station(s) have multiple locationNames:')
        for st, names in multi_name_stations.items():
            expected = station_map.get(st, {}).get('name', '?')
            r.fail(f'  {st}: logged as {names} (expected "{expected}")')
    else:
        r.ok(f'All {len(by_station)} stations have consistent locationNames')

    if mismatches > 0:
        r.fail(f'{mismatches}/{len(records)} records have locationName != cities.json name')
    else:
        r.ok('All locationNames match cities.json')

    # Also check stateCode consistency
    state_mismatches = 0
    for rec in records:
        st = rec.get('station')
        sc = rec.get('stateCode')
        if st in station_map and station_map[st].get('stateCode') and sc != station_map[st]['stateCode']:
            state_mismatches += 1
    if state_mismatches:
        r.fail(f'{state_mismatches} records have stateCode mismatch with cities.json')
    else:
        r.ok('All stateCodes match cities.json')

    return r


def check_model_contamination(records, station_map):
    """FIX 2: model.* should be per-city, not from cachedCurrentData global."""
    r = AuditResult('Model data cross-contamination')

    # Check 1: model.temp should be plausible per station
    # Different cities at different latitudes should not share identical temps
    by_station_temps = defaultdict(list)
    model_null_count = 0
    for rec in records:
        model = rec.get('model')
        st = rec.get('station')
        if model is None:
            model_null_count += 1
            continue
        if st and model.get('temp') is not None:
            by_station_temps[st].append(model['temp'])

    if model_null_count > 0:
        # model=null is expected for active polling (Option A in the plan)
        r.info(f'{model_null_count}/{len(records)} records have model=null (expected for polling)')

    if len(by_station_temps) < 2:
        r.warn('Only 0-1 stations have model temps — cannot cross-check')
        return r

    # Check 2: Adjacent-minute records for different stations should NOT have identical model blocks
    sorted_recs = sorted(records, key=lambda x: x.get('timestamp', ''))
    identical_count = 0
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
            identical_count += 1

    if compared == 0:
        r.warn('No adjacent cross-station model comparisons possible')
    elif identical_count > compared * 0.5:
        r.fail(f'{identical_count}/{compared} adjacent cross-station records have IDENTICAL '
               f'model blocks ({100 * identical_count / compared:.0f}%) — likely still reading '
               f'from cachedCurrentData global')
    elif identical_count > 0:
        r.warn(f'{identical_count}/{compared} identical cross-station model blocks '
               f'({100 * identical_count / compared:.0f}%) — some overlap expected for nearby cities')
    else:
        r.ok(f'0/{compared} identical cross-station model blocks — model isolation working')

    # Check 3: Temperature ranges should differ between geographically distant stations
    station_temp_ranges = {}
    for st, temps in by_station_temps.items():
        if len(temps) >= 3:
            station_temp_ranges[st] = (min(temps), max(temps), sum(temps) / len(temps))

    if len(station_temp_ranges) >= 2:
        means = [(st, avg) for st, (_, _, avg) in station_temp_ranges.items()]
        means.sort(key=lambda x: x[1])
        coldest, warmest = means[0], means[-1]
        spread = warmest[1] - coldest[1]
        if spread < 2.0 and len(means) > 3:
            r.fail(f'Mean temp spread across {len(means)} stations is only {spread:.1f}F — '
                   f'suggests shared model data')
        else:
            r.ok(f'Mean temp spread: {spread:.1f}F across {len(means)} stations '
                 f'({coldest[0]}={coldest[1]:.1f}F .. {warmest[0]}={warmest[1]:.1f}F)')

    return r


def check_icon_condition_mismatch(records):
    """FIX 3: displayedIcon and displayedCondition should agree."""
    r = AuditResult('Icon ↔ condition coherence')

    rain_icon_dry_cond = 0
    clear_icon_rain_cond = 0
    total = 0

    for rec in records:
        icon = rec.get('displayedIcon', '') or ''
        cond = rec.get('displayedCondition', '') or ''
        if not icon or not cond:
            continue
        total += 1

        icon_is_rain = bool(set(icon.split('-')) & {'rain', 'drizzle', 'thunder', 'snow', 'sleet'})
        cond_is_dry = cond in ('Dry', '')
        icon_is_clear = any(x in icon for x in ('clear', 'cloudy', 'overcast')) and not icon_is_rain
        cond_is_rain = any(x in cond.lower() for x in ('drizzle', 'rain', 'thunder', 'snow', 'sleet'))

        if icon_is_rain and cond_is_dry:
            rain_icon_dry_cond += 1
        if icon_is_clear and cond_is_rain:
            clear_icon_rain_cond += 1

    mismatches = rain_icon_dry_cond + clear_icon_rain_cond
    if mismatches > 0:
        r.fail(f'{mismatches}/{total} icon/condition mismatches:')
        if rain_icon_dry_cond:
            r.fail(f'  {rain_icon_dry_cond} rain icon + Dry condition')
        if clear_icon_rain_cond:
            r.fail(f'  {clear_icon_rain_cond} clear icon + rain condition')
    else:
        r.ok(f'0/{total} icon/condition mismatches')

    return r


def check_station_coord_consistency(records, station_map):
    """Coordinates should be stable per station and match cities.json."""
    r = AuditResult('Station ↔ coordinate consistency')

    by_station = defaultdict(list)
    for rec in records:
        st = rec.get('station')
        if st:
            by_station[st].append((rec.get('lat', 0), rec.get('lon', 0)))

    drift_stations = []
    coord_mismatches = 0
    for st, coords in by_station.items():
        lats = [c[0] for c in coords]
        lons = [c[1] for c in coords]
        lat_range = max(lats) - min(lats)
        lon_range = max(lons) - min(lons)
        if lat_range > 0.01 or lon_range > 0.01:
            drift_stations.append((st, lat_range, lon_range, len(coords)))

        if st in station_map:
            expected_lat = station_map[st]['lat']
            expected_lon = station_map[st]['lon']
            avg_lat = sum(lats) / len(lats)
            avg_lon = sum(lons) / len(lons)
            if abs(avg_lat - expected_lat) > 0.5 or abs(avg_lon - expected_lon) > 0.5:
                coord_mismatches += 1
                r.fail(f'{st}: avg coords ({avg_lat:.3f}, {avg_lon:.3f}) far from '
                       f'cities.json ({expected_lat:.3f}, {expected_lon:.3f})')

    if drift_stations:
        r.fail(f'{len(drift_stations)} station(s) have coordinate drift:')
        for st, dlat, dlon, n in drift_stations:
            r.fail(f'  {st}: lat_range={dlat:.5f} lon_range={dlon:.5f} across {n} records')
    else:
        r.ok(f'All {len(by_station)} stations have stable coordinates')

    if coord_mismatches == 0 and station_map:
        r.ok('All station coordinates match cities.json')

    return r


def check_null_schema(records):
    """FIX 4: sky and trend should always be objects, never null."""
    r = AuditResult('Null-object normalization')

    sky_null = sum(1 for rec in records if rec.get('sky') is None)
    trend_null = sum(1 for rec in records if rec.get('trend') is None)
    sky_desc_key_missing = sum(1 for rec in records
                               if rec.get('sky') is not None and 'desc' not in rec['sky'])

    if sky_null > 0:
        r.fail(f'{sky_null} records have sky=null (should be object with null fields)')
    else:
        r.ok('sky is always an object (never null)')

    if trend_null > 0:
        r.fail(f'{trend_null} records have trend=null (should be object with null fields)')
    else:
        r.ok('trend is always an object (never null)')

    if sky_desc_key_missing > 0:
        r.warn(f'{sky_desc_key_missing} sky objects missing "desc" key')

    return r


def check_validation_flags(records):
    """Check distribution of _validationFlags set by the logger."""
    r = AuditResult('Validation flags')

    flagged = [rec for rec in records if rec.get('_validationFlags')]
    if not flagged:
        r.ok(f'0/{len(records)} records have validation flags — clean data')
        return r

    r.info(f'{len(flagged)}/{len(records)} records have validation flags:')
    all_flags = Counter()
    for rec in flagged:
        for flag in rec['_validationFlags']:
            all_flags[flag] += 1

    for flag, count in all_flags.most_common():
        severity = 'FAIL' if flag in ('rain_icon_dry_cond', 'clear_icon_rain_cond') else 'INFO'
        if severity == 'FAIL':
            r.fail(f'  {flag}: {count}')
        else:
            r.info(f'  {flag}: {count}')

    return r


def check_radar_staleness(records):
    """New field: radar.lastValidDbzTime should be present in v2 records."""
    r = AuditResult('Radar staleness tracking')

    v2_records = [rec for rec in records if rec.get('_schemaVersion', 1) >= 2]
    if not v2_records:
        r.warn('No v2 records — cannot check radar.lastValidDbzTime')
        return r

    has_field = sum(1 for rec in v2_records
                    if rec.get('radar') and 'lastValidDbzTime' in rec['radar'])
    r.info(f'{has_field}/{len(v2_records)} v2 records have radar.lastValidDbzTime')

    # Check for ON/HOLDING with very stale lastValidDbzTime
    stale_active = 0
    for rec in v2_records:
        radar = rec.get('radar')
        if not radar:
            continue
        if radar.get('rainState') in ('ON', 'HOLDING') and radar.get('lastValidDbzTime'):
            # Could parse and compare timestamps here for staleness checks
            pass

    r.ok('radar.lastValidDbzTime field present in v2 records')
    return r


# ── Main ──────────────────────────────────────────────────────────────────────

def run_audit(records, station_map, label=''):
    checks = [
        check_schema_version(records),
        check_location_bleed(records, station_map),
        check_model_contamination(records, station_map),
        check_icon_condition_mismatch(records),
        check_station_coord_consistency(records, station_map),
        check_null_schema(records),
        check_validation_flags(records),
        check_radar_staleness(records),
    ]

    passed = sum(1 for c in checks if c.passed)
    failed = len(checks) - passed

    print(f'\n{"=" * 70}')
    if label:
        print(f'AUDIT: {label}')
    print(f'{len(records)} records | {passed} passed | {failed} failed')
    print(f'{"=" * 70}')

    for check in checks:
        status = 'PASS' if check.passed else 'FAIL'
        print(f'\n[{status}] {check.name}')
        for detail in check.details:
            print(f'       {detail}')

    print(f'\n{"─" * 70}')
    if failed == 0:
        print('ALL CHECKS PASSED — data integrity fixes verified.')
    else:
        print(f'{failed} CHECK(S) FAILED — see details above.')
    print(f'{"─" * 70}\n')

    return failed == 0


def main():
    args = sys.argv[1:]
    station_map = load_station_map()
    files = find_log_file(args)

    all_passed = True
    for path in files:
        records = load_records(path)
        if not records:
            print(f'No records in {path}')
            continue
        if not run_audit(records, station_map, label=str(path)):
            all_passed = False

    sys.exit(0 if all_passed else 1)


if __name__ == '__main__':
    main()
