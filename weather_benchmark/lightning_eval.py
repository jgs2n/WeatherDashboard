"""Episode-based lightning warning evaluation.

Scores the safety-relevant questions per THUNDERSTORM EPISODE (not per poll):
  - Was a warning (active/nearby) up BEFORE the first station thunder report?
  - How much lead time did the first warning of any tier give?
  - After the storm, how long until warnings cleared (vs the NWS 30-min rule)?
  - How available was GLM ingest (the silent-outage failure mode)?

Ground truth: IEM ASOS routine+special METARs (report_type 3,4) TS/VCTS codes.
Station thunder ≈ within ~10 mi hearing radius; VCTS ≈ 5–10SM vicinity.

Usage (from weather_benchmark/):
    python lightning_eval.py                 # last 7 days
    python lightning_eval.py --days 3
    python lightning_eval.py --cities Atlanta Savannah
"""

import argparse
import json
import glob
import os
import statistics
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
IEM_ASOS_URL = 'https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py'
EPISODE_GAP_MIN = 60          # TS obs gaps > this start a new episode
PRE_WINDOW_MIN = 120          # look this far before first TS for advance warning
COVER_PAD_MIN = 15            # coverage window padding around the episode
ALL_CLEAR_SUSTAIN = 2         # consecutive 'none' polls to count as cleared
FRESH_INGEST_MS = 30 * 60 * 1000  # bufferAge below this = ingest healthy


def load_cities():
    with open(os.path.join(HERE, 'data', 'cities.json'), encoding='utf-8') as f:
        data = json.load(f)
    return data if isinstance(data, list) else data.get('cities', [])


def city_slug(name):
    return name.lower().replace(' ', '_').replace(',', '')


def fetch_ts_obs(station, start, end):
    """[(datetime, wxcodes)] thunder observations for a station."""
    params = {'station': station.lstrip('K'), 'data': 'wxcodes',
              'year1': start.year, 'month1': start.month, 'day1': start.day,
              'year2': end.year, 'month2': end.month, 'day2': end.day,
              'tz': 'UTC', 'format': 'onlycomma', 'latlon': 'no',
              'report_type': '3,4'}
    r = requests.get(IEM_ASOS_URL, params=params, timeout=30)
    r.raise_for_status()
    out = []
    for line in r.text.strip().split('\n')[1:]:
        row = line.split(',')
        if len(row) >= 3 and 'TS' in row[2]:
            t = datetime.strptime(row[1], '%Y-%m-%d %H:%M').replace(tzinfo=timezone.utc)
            out.append((t, row[2].strip()))
    return out


def load_records(slug, start):
    """[(datetime, lightning-dict)] collector records for one city."""
    out = []
    for fp in sorted(glob.glob(os.path.join(HERE, 'data', 'logs', slug, '*.jsonl'))):
        if os.path.basename(fp)[:10] < start.strftime('%Y-%m-%d'):
            continue
        with open(fp, encoding='utf-8') as f:
            for line in f:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                ts = datetime.fromisoformat(r['timestamp'])
                if ts >= start:
                    out.append((ts, r.get('lightning') or {}))
    return out


def group_episodes(ts_obs):
    """Group TS observations into episodes; classify vicinity-only ones."""
    if not ts_obs:
        return []
    episodes = []
    cur = [ts_obs[0]]
    for item in ts_obs[1:]:
        if (item[0] - cur[-1][0]).total_seconds() > EPISODE_GAP_MIN * 60:
            episodes.append(cur)
            cur = [item]
        else:
            cur.append(item)
    episodes.append(cur)
    out = []
    for ep in episodes:
        codes = [wx for _, wx in ep]
        vicinity_only = all('VC' in c for c in codes)
        out.append({'first': ep[0][0], 'last': ep[-1][0],
                    'n_obs': len(ep), 'vicinity_only': vicinity_only})
    return out


def eval_episode(ep, recs):
    """Score one episode against the recorded lightning states."""
    first, last = ep['first'], ep['last']
    pre = [(ts, lx) for ts, lx in recs
           if first - timedelta(minutes=PRE_WINDOW_MIN) <= ts <= first]
    during = [(ts, lx) for ts, lx in recs
              if first - timedelta(minutes=COVER_PAD_MIN) <= ts <= last + timedelta(minutes=COVER_PAD_MIN)]
    if not pre and not during:
        return None  # no collection during this episode

    def first_state_at(states, pool):
        for ts, lx in pool:
            if lx.get('state') in states:
                return ts
        return None

    warn_ts = first_state_at(('active', 'nearby'), pre)
    approach_ts = first_state_at(('approaching', 'active', 'nearby'), pre)
    covered = any(lx.get('state') in ('active', 'nearby') for _, lx in during)

    # All-clear: first sustained drop out of active/nearby after the last TS
    # obs. ('approaching' may legitimately persist — storms 20–40 mi out.)
    post = [(ts, lx) for ts, lx in recs if ts >= last]
    clear_min = None
    run = 0
    for ts, lx in post:
        if lx.get('state') not in ('active', 'nearby'):
            run += 1
            if run >= ALL_CLEAR_SUSTAIN:
                clear_min = (ts - last).total_seconds() / 60
                break
        else:
            run = 0

    return {
        'first_ts': first.isoformat(), 'n_obs': ep['n_obs'],
        'vicinity_only': ep['vicinity_only'],
        'warned_before': warn_ts is not None,
        'warn_lead_min': (first - warn_ts).total_seconds() / 60 if warn_ts else None,
        'any_tier_lead_min': (first - approach_ts).total_seconds() / 60 if approach_ts else None,
        'covered': covered,
        'all_clear_min': clear_min,
    }


def availability(recs):
    """GLM ingest health from bufferAgeMs: %, and the longest starved streak."""
    ages = [(ts, lx.get('bufferAgeMs')) for ts, lx in recs]
    if not ages:
        return None
    healthy = sum(1 for _, a in ages if a is not None and a <= FRESH_INGEST_MS)
    longest, cur_start = timedelta(0), None
    for ts, a in ages:
        starved = a is None or a > FRESH_INGEST_MS
        if starved and cur_start is None:
            cur_start = ts
        elif not starved and cur_start is not None:
            longest = max(longest, ts - cur_start)
            cur_start = None
    if cur_start is not None:
        longest = max(longest, ages[-1][0] - cur_start)
    return {'healthy_pct': 100 * healthy / len(ages),
            'longest_starved_h': longest.total_seconds() / 3600}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--days', type=int, default=7)
    ap.add_argument('--cities', nargs='*')
    args = ap.parse_args()

    now = datetime.now(timezone.utc)
    start = now - timedelta(days=args.days)
    cities = load_cities()
    if args.cities:
        wanted = {c.lower() for c in args.cities}
        cities = [c for c in cities if c['name'].lower() in wanted]

    all_results = []
    avail_by_city = {}
    for c in cities:
        slug = city_slug(c['name'])
        recs = load_records(slug, start)
        if recs:
            avail_by_city[c['name']] = availability(recs)
        try:
            ts_obs = fetch_ts_obs(c['station'], start, now)
        except Exception as e:
            print(f"  ! ASOS fetch failed for {c['station']}: {e}", file=sys.stderr)
            continue
        for ep in group_episodes(ts_obs):
            res = eval_episode(ep, recs)
            if res:
                res['city'] = c['name']
                all_results.append(res)

    # ── Report ──────────────────────────────────────────────────────────────
    full = [r for r in all_results if not r['vicinity_only']]
    vic = [r for r in all_results if r['vicinity_only']]
    print(f"\nLIGHTNING EPISODE EVALUATION — last {args.days} days, {len(cities)} cities")
    print(f"Episodes: {len(full)} station-thunder, {len(vic)} vicinity-only\n")

    def block(label, rows):
        if not rows:
            print(f"{label}: no episodes")
            return
        warned = [r for r in rows if r['warned_before']]
        covered = sum(1 for r in rows if r['covered'])
        leads = [r['warn_lead_min'] for r in warned if r['warn_lead_min'] is not None]
        any_leads = [r['any_tier_lead_min'] for r in rows if r['any_tier_lead_min'] is not None]
        clears = [r['all_clear_min'] for r in rows if r['all_clear_min'] is not None]
        print(f"{label} ({len(rows)} episodes):")
        print(f"  warned (active/nearby) BEFORE first thunder: {len(warned)}/{len(rows)} = {100*len(warned)/len(rows):.0f}%")
        if leads:
            print(f"    lead time: median {statistics.median(leads):.0f} min (range {min(leads):.0f}–{max(leads):.0f})")
        if any_leads:
            print(f"  any-tier (incl. approaching) advance signal: {len(any_leads)}/{len(rows)} = {100*len(any_leads)/len(rows):.0f}%, median lead {statistics.median(any_leads):.0f} min")
        print(f"  warning up at some point during episode: {covered}/{len(rows)} = {100*covered/len(rows):.0f}%")
        if clears:
            print(f"  all-clear after last thunder: median {statistics.median(clears):.0f} min (NWS guidance: 30 min)")
        print()

    block("STATION THUNDER (TS at airport, ≈ within hearing)", full)
    block("VICINITY THUNDER (VCTS, ≈ 5–10 mi out)", vic)

    print("GLM INGEST AVAILABILITY (bufferAge ≤ 30 min = healthy):")
    for city, av in sorted(avail_by_city.items()):
        if av:
            print(f"  {city:<12} {av['healthy_pct']:>5.1f}% healthy | longest starved streak {av['longest_starved_h']:.1f} h")

    out_path = os.path.join(HERE, 'reports',
                            f"lightning_eval_{now.strftime('%Y-%m-%d')}.json")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump({'generated': now.isoformat(), 'days': args.days,
                   'episodes': all_results, 'availability': avail_by_city}, f, indent=1)
    print(f"\nDetail written to {out_path}")


if __name__ == '__main__':
    main()
