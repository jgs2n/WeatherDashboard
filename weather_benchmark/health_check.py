"""
Collection Health Check — "is the collector working right now?"

Reads the per-city layout the collector writes, data/logs/<city_slug>/
YYYY-MM-DD.jsonl (UTC days), plus data/heartbeat.json, and checks:

  - Recency      newest record per city (FAIL when older than
                 alerts.stale_after_min, default 15 min)
  - Duplicates   polls per city in the last 2 h / 24 h above what one
                 collector can produce (86400 / poll_interval_sec = 480/day at
                 180 s). Two collectors writing the same files double this.
  - Coverage     polls in the last 24 h vs expected
  - Gaps         longest gap between polls in the last 24 h
  - Heartbeat    data/heartbeat.json age + per-source fetch failures
  - Quality      last 2 h: radar fetch failures, model_unavailable,
                 stale_cache, schema version

Usage:
    python health_check.py            # human-readable report
    python health_check.py --json     # machine-readable (server.py /api/health-check)
    python health_check.py --alert    # also notify on Recency/Duplicates FAIL
    python health_check.py --test-alert   # send one test notification and exit

--alert is what the "WeatherHQ Health Alert" scheduled task runs every 15 min
(setup_collector_task.ps1). It notifies via a Windows toast (or msg.exe when
running without a desktop, as an S4U task does) and, when configured, an
ntfy.sh topic (collector_config.yaml alerts.ntfy_topic, or the
WEATHERHQ_NTFY_TOPIC environment variable). It re-alerts every
alerts.repeat_hours while the problem lasts and sends one "recovered" note.

Exit codes: 0 = all ok, 1 = any warn, 2 = any fail.
"""

import argparse
import ctypes
import json
import os
import re
import subprocess
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
LOG_DIR = HERE / 'data' / 'logs'
CITIES_FILE = HERE / 'data' / 'cities.json'
HEARTBEAT = HERE / 'data' / 'heartbeat.json'
ALERT_STATE = HERE / 'data' / 'health_alert_state.json'
CONFIG = HERE / 'collector_config.yaml'

DEFAULT_POLL_SEC = 180
STALE_AFTER_MIN = 15
RECENCY_WARN_MIN = 7          # > 2 poll intervals
GAP_WARN_S = 15 * 60
DUP_RATIO_2H = 1.5            # 2 collectors ~= 2.0x; one poll of jitter << 1.5x
DUP_RATIO_24H = 1.1
COVERAGE_WARN = 0.90
SOURCE_FAIL_WARN = 0.20
REPEAT_HOURS = 3

_TS_RE = re.compile(r'"timestamp":\s*"([^"]+)"')


# ── Config / inputs ─────────────────────────────────────────────────────────

def load_config(path=CONFIG):
    try:
        with open(path, encoding='utf-8') as f:
            return yaml.safe_load(f) or {}
    except (OSError, yaml.YAMLError):
        return {}


def city_slug(name):
    # Same as collector.city_slug (not imported: collector pulls in the world)
    return re.sub(r'[^a-z0-9]+', '_', name.lower()).strip('_')


def load_cities(cities_file, logs_dir, default_poll):
    """[(name, slug, poll_interval_sec)] for collected (non-holdout) cities.
    Falls back to the subdirectories of logs_dir when cities.json is absent."""
    try:
        with open(cities_file, encoding='utf-8') as f:
            cities = json.load(f)
        return [(c['name'], city_slug(c['name']),
                 c.get('poll_interval_sec') or default_poll)
                for c in cities if not c.get('holdout')]
    except (OSError, ValueError, KeyError):
        if not logs_dir.is_dir():
            return []
        return [(d.name, d.name, default_poll)
                for d in sorted(logs_dir.iterdir()) if d.is_dir()]


def _parse_ts(s):
    if not s:
        return None
    try:
        ts = datetime.fromisoformat(s.replace('Z', '+00:00'))
    except (ValueError, AttributeError):
        return None
    return ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)


def _scan_stamps(path):
    """Yield (timestamp, line) for every parseable line of a JSONL file. Only
    the timestamp is regex-pulled (records start with it), so a pass over
    ~10 cities x 2 days stays around a second."""
    try:
        with open(path, encoding='utf-8', errors='replace') as f:
            for line in f:
                m = _TS_RE.search(line, 0, 400)
                ts = _parse_ts(m.group(1)) if m else None
                if ts is not None:
                    yield ts, line
    except OSError:
        return


def read_city(city_dir, now, window_h=24, detail_h=2):
    """(sorted timestamps in the last window_h hours, full records in the
    last detail_h hours)."""
    since = now - timedelta(hours=window_h)
    detail_since = now - timedelta(hours=detail_h)
    stamps, recent = [], []
    for day in sorted({since.date(), now.date()}):
        for ts, line in _scan_stamps(city_dir / f'{day.isoformat()}.jsonl'):
            if ts < since or ts > now + timedelta(minutes=5):
                continue
            stamps.append(ts)
            if ts >= detail_since:
                try:
                    recent.append(json.loads(line))
                except json.JSONDecodeError:
                    pass   # trailing partial line mid-write
    stamps.sort()
    return stamps, recent


# ── Checks ──────────────────────────────────────────────────────────────────

class Check:
    __slots__ = ('name', 'status', 'message', 'alert')

    def __init__(self, name, status, message, alert=False):
        self.name = name
        self.status = status  # 'ok' | 'info' | 'warn' | 'fail'
        self.message = message
        self.alert = alert    # worth a notification under --alert

    def to_dict(self):
        return {'name': self.name, 'status': self.status,
                'message': self.message, 'alert': self.alert}


def _fmt_age(seconds):
    if seconds < 90:
        return f'{seconds:.0f}s'
    if seconds < 3600:
        return f'{seconds / 60:.1f} min'
    return f'{seconds / 3600:.1f} h'


def city_stats(name, slug, poll_sec, logs_dir, now):
    city_dir = logs_dir / slug
    stamps, recent = read_city(city_dir, now)
    newest = stamps[-1] if stamps else None
    if newest is None and city_dir.is_dir():
        # Nothing in 24 h: report how old the newest record on disk is
        files = sorted(city_dir.glob('*.jsonl'))
        if files:
            newest = max((ts for ts, _ in _scan_stamps(files[-1])), default=None)
    gaps = [(b - a).total_seconds() for a, b in zip(stamps, stamps[1:])]
    two_h = now - timedelta(hours=2)
    return {
        'name': name, 'slug': slug, 'pollSec': poll_sec,
        'newest': newest,
        'ageSec': (now - newest).total_seconds() if newest else None,
        'polls24h': len(stamps),
        'polls2h': sum(1 for t in stamps if t >= two_h),
        'expected24h': 86400 / poll_sec,
        'expected2h': 7200 / poll_sec,
        'maxGapSec': max(gaps) if gaps else None,
        'recent': recent,
    }


def check_recency(stats, stale_after_min):
    if not stats:
        return Check('Recency', 'fail', 'no cities configured / no log dirs', alert=True)
    stale_s = stale_after_min * 60
    dead = [s for s in stats if s['ageSec'] is None or s['ageSec'] > stale_s]
    if dead:
        parts = [f"{s['name']} " + ('never' if s['ageSec'] is None else _fmt_age(s['ageSec']))
                 for s in dead]
        lead = 'ALL cities stale, collector down? ' if len(dead) == len(stats) else 'stale: '
        return Check('Recency', 'fail', lead + ', '.join(parts), alert=True)
    oldest = max(stats, key=lambda s: s['ageSec'])
    status = 'warn' if oldest['ageSec'] > RECENCY_WARN_MIN * 60 else 'ok'
    return Check('Recency', status,
                 f"newest record per city <= {_fmt_age(oldest['ageSec'])} old "
                 f"(oldest: {oldest['name']})")


def check_duplicates(stats):
    dup = []
    for s in stats:
        if (s['polls2h'] > DUP_RATIO_2H * s['expected2h']
                or s['polls24h'] > DUP_RATIO_24H * s['expected24h']):
            dup.append(f"{s['name']} {s['polls2h']}/2h {s['polls24h']}/24h "
                       f"(expected {s['expected2h']:.0f}/{s['expected24h']:.0f})")
    if dup:
        return Check('Duplicates', 'fail',
                     'more polls than one collector makes, duplicate collectors? '
                     + '; '.join(dup), alert=True)
    worst = max((s['polls24h'] for s in stats), default=0)
    return Check('Duplicates', 'ok', f'max {worst} polls/24h per city (single collector)')


def check_coverage(stats):
    tot = sum(s['polls24h'] for s in stats)
    exp = sum(s['expected24h'] for s in stats) or 1
    msg = f'{tot}/{exp:.0f} polls in 24 h ({100 * tot / exp:.0f}%)'
    low = [s for s in stats if s['polls24h'] < COVERAGE_WARN * s['expected24h']]
    if low:
        msg += '; low: ' + ', '.join(
            f"{s['name']} {100 * s['polls24h'] / s['expected24h']:.0f}%" for s in low)
        return Check('Coverage 24h', 'warn', msg)
    return Check('Coverage 24h', 'ok', msg)


def check_gaps(stats):
    with_gaps = [s for s in stats if s['maxGapSec'] is not None]
    if not with_gaps:
        return Check('Longest gap', 'info', 'not enough records in 24 h')
    worst = max(with_gaps, key=lambda s: s['maxGapSec'])
    status = 'warn' if worst['maxGapSec'] > GAP_WARN_S else 'ok'
    return Check('Longest gap', status,
                 f"{_fmt_age(worst['maxGapSec'])} ({worst['name']}, last 24 h)")


def check_heartbeat(path, now, stale_after_min):
    try:
        hb = json.loads(Path(path).read_text(encoding='utf-8'))
    except FileNotFoundError:
        return Check('Heartbeat', 'info', 'no heartbeat.json (collector predates it?)')
    except (OSError, ValueError) as e:
        return Check('Heartbeat', 'warn', f'unreadable heartbeat.json: {e}')
    upd = _parse_ts(hb.get('updatedUtc'))
    age = (now - upd).total_seconds() if upd else None
    msg = (f"pid {hb.get('pid')} started {hb.get('startedUtc')}, updated "
           + (_fmt_age(age) + ' ago' if age is not None else '?'))
    status = 'ok' if age is not None and age <= stale_after_min * 60 else 'warn'
    bad = []
    for src, st in sorted((hb.get('sources') or {}).items()):
        failed = st.get('fail', 0) + st.get('stale', 0)
        total = st.get('ok', 0) + failed
        if total and failed / total > SOURCE_FAIL_WARN:
            bad.append(f'{src} {failed}/{total} failed')
    if bad:
        status = 'warn'
        msg += '; ' + ', '.join(bad)
    return Check('Heartbeat', status, msg)


def check_quality(stats):
    recs = [r for s in stats for r in s['recent']]
    if not recs:
        return Check('Recent quality', 'info', 'no records in last 2 h')
    flags = Counter(f for r in recs for f in (r.get('_validationFlags') or []))
    schemas = sorted({str(r.get('_schemaVersion')) for r in recs})
    n = len(recs)
    parts = [f"schema {'/'.join(schemas)}"]
    status = 'ok'
    for flag in ('radar_fetch_failed', 'model_unavailable', 'stale_cache'):
        pct = 100 * flags.get(flag, 0) / n
        if pct:
            parts.append(f'{flag} {pct:.0f}%')
        if pct > 20:
            status = 'warn'
    return Check('Recent quality', status, f'{n} records in 2 h: ' + ', '.join(parts))


def compute(logs_dir=LOG_DIR, cities_file=CITIES_FILE, heartbeat=HEARTBEAT,
            config=None, now=None):
    config = config if config is not None else load_config()
    now = now or datetime.now(timezone.utc)
    stale_after = (config.get('alerts') or {}).get('stale_after_min', STALE_AFTER_MIN)
    logs_dir = Path(logs_dir)
    cities = load_cities(Path(cities_file), logs_dir,
                         config.get('poll_interval_sec', DEFAULT_POLL_SEC))
    stats = [city_stats(n, slug, p, logs_dir, now) for n, slug, p in cities]
    checks = [
        check_recency(stats, stale_after),
        check_duplicates(stats),
        check_coverage(stats),
        check_gaps(stats),
        check_heartbeat(heartbeat, now, stale_after),
        check_quality(stats),
    ]
    return stats, checks


# ── Output ──────────────────────────────────────────────────────────────────

# ASCII: the scheduled task's console is cp1252, which has no check marks
STATUS_ICON = {'ok': 'ok  ', 'info': 'info', 'warn': 'WARN', 'fail': 'FAIL'}
STATUS_RANK = {'ok': 0, 'info': 0, 'warn': 1, 'fail': 2}


def summarize(checks):
    warns = sum(1 for c in checks if c.status == 'warn')
    fails = sum(1 for c in checks if c.status == 'fail')
    if fails:
        return f'{fails} failure(s), {warns} warning(s)', 'fail'
    if warns:
        return f'{warns} warning(s)', 'warn'
    return 'all checks passed', 'ok'


def payload(logs_dir, stats, checks, now):
    """Shape consumed by server.py /api/health-check and main.js's modal."""
    summary, worst = summarize(checks)
    return {
        'path': str(logs_dir),
        'checkedUtc': now.isoformat(timespec='seconds'),
        'records': sum(s['polls24h'] for s in stats),
        'summary': summary,
        'worst_status': worst,
        'checks': [c.to_dict() for c in checks],
        'cities': {s['name']: {
            'newestUtc': s['newest'].isoformat() if s['newest'] else None,
            'polls2h': s['polls2h'], 'polls24h': s['polls24h'],
            'expected24h': round(s['expected24h']),
            'maxGapSec': s['maxGapSec'],
        } for s in stats},
    }


def print_text(data):
    print(f"Collection health: {data['path']}  ({data['checkedUtc']})")
    print(f"{data['records']} records in last 24 h: {data['summary']}")
    print()
    for c in data['checks']:
        print(f"  {STATUS_ICON.get(c['status'], '.')} {c['name']:<15} {c['message']}")


def exit_code(checks):
    return max((STATUS_RANK.get(c.status, 0) for c in checks), default=0)


# ── Alerting ────────────────────────────────────────────────────────────────

def _session_id():
    """Windows session of this process; 0 = no desktop (service / S4U task)."""
    try:
        sid = ctypes.c_ulong()
        if ctypes.windll.kernel32.ProcessIdToSessionId(os.getpid(), ctypes.byref(sid)):
            return sid.value
    except (AttributeError, OSError):
        pass
    return None


_TOAST_PS = r'''
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$x = $t.GetElementsByTagName('text')
$x.Item(0).AppendChild($t.CreateTextNode($env:WHQ_TITLE)) > $null
$x.Item(1).AppendChild($t.CreateTextNode($env:WHQ_BODY)) > $null
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($t))
'''


def notify_desktop(title, body):
    """Toast when this process has a desktop; msg.exe to the user's sessions
    when it runs in session 0 (an S4U task), where a toast would go nowhere."""
    if sys.platform != 'win32':
        return False
    try:
        if _session_id() == 0:
            user = os.environ.get('USERNAME') or '*'
            r = subprocess.run(['msg', user, f'{title}\n\n{body}'[:700]],
                               capture_output=True, timeout=30)
        else:
            env = {**os.environ, 'WHQ_TITLE': title, 'WHQ_BODY': body[:700]}
            r = subprocess.run(['powershell', '-NoProfile', '-NonInteractive',
                                '-Command', _TOAST_PS],
                               capture_output=True, timeout=60, env=env)
        return r.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def notify_ntfy(title, body, alerts_cfg, priority='high'):
    topic = os.environ.get('WEATHERHQ_NTFY_TOPIC') or alerts_cfg.get('ntfy_topic')
    if not topic:
        return False
    server = (alerts_cfg.get('ntfy_server') or 'https://ntfy.sh').rstrip('/')
    try:
        import requests
        r = requests.post(f'{server}/{topic}', data=body.encode('utf-8'),
                          headers={'Title': title, 'Priority': priority,
                                   'Tags': 'warning' if priority == 'high' else 'white_check_mark'},
                          timeout=15)
        return r.ok
    except Exception:
        return False


def send_alert(title, body, alerts_cfg, priority='high'):
    """{channel: delivered?}. Every channel is tried independently."""
    return {'desktop': notify_desktop(title, body),
            'ntfy': notify_ntfy(title, body, alerts_cfg, priority)}


def _load_state(path):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}


def _save_state(path, state):
    try:
        Path(path).write_text(json.dumps(state, indent=1), encoding='utf-8')
    except OSError:
        pass


def process_alerts(checks, now, alerts_cfg, state_path=ALERT_STATE, sender=None):
    """Notify on a new or changed problem, again every repeat_hours while it
    lasts, and once on recovery. Returns what was sent (None if nothing)."""
    sender = sender or send_alert
    state = _load_state(state_path)
    firing = [c for c in checks if c.alert]
    repeat = timedelta(hours=alerts_cfg.get('repeat_hours', REPEAT_HOURS))
    sent = None
    if firing:
        key = sorted(c.name for c in firing)
        last = _parse_ts(state.get('lastSentUtc'))
        if (not state.get('active') or state.get('key') != key
                or last is None or now - last >= repeat):
            title = 'WeatherHQ collector: ' + ' + '.join(key)
            body = '\n'.join(f'{c.name}: {c.message}' for c in firing)
            sent = {'title': title, 'body': body,
                    'channels': sender(title, body, alerts_cfg)}
            state.update(lastSentUtc=now.isoformat(timespec='seconds'), key=key)
        if not state.get('active'):
            state['sinceUtc'] = now.isoformat(timespec='seconds')
        state['active'] = True
    elif state.get('active'):
        title = 'WeatherHQ collector recovered'
        body = (f"Problem since {state.get('sinceUtc')} cleared at "
                f"{now.isoformat(timespec='minutes')}.")
        sent = {'title': title, 'body': body,
                'channels': sender(title, body, alerts_cfg, 'default')}
        state = {'active': False, 'lastRecoveredUtc': now.isoformat(timespec='seconds')}
    _save_state(state_path, state)
    return sent


# ── Main ────────────────────────────────────────────────────────────────────

def main(argv=None):
    ap = argparse.ArgumentParser(description='Collector health check')
    ap.add_argument('--json', action='store_true', help='machine-readable output')
    ap.add_argument('--alert', action='store_true',
                    help='notify (toast/msg + ntfy) on Recency/Duplicates failures')
    ap.add_argument('--test-alert', action='store_true',
                    help='send one test notification on every channel and exit')
    ap.add_argument('--logs-dir', default=str(LOG_DIR))
    ap.add_argument('--cities-file', default=str(CITIES_FILE))
    ap.add_argument('--heartbeat', default=str(HEARTBEAT))
    ap.add_argument('--state-file', default=str(ALERT_STATE))
    ap.add_argument('--config', default=str(CONFIG))
    ap.add_argument('--now', help='pretend it is this ISO UTC time (testing)')
    args = ap.parse_args(argv)

    config = load_config(args.config)
    alerts_cfg = config.get('alerts') or {}

    if args.test_alert:
        res = send_alert('WeatherHQ test alert',
                         'If you can read this, collector alerts reach you.', alerts_cfg)
        print(json.dumps(res))
        return 0 if any(res.values()) else 2

    now = _parse_ts(args.now) if args.now else datetime.now(timezone.utc)
    stats, checks = compute(args.logs_dir, args.cities_file, args.heartbeat, config, now)
    data = payload(args.logs_dir, stats, checks, now)
    if args.alert:
        data['alertSent'] = process_alerts(checks, now, alerts_cfg, args.state_file)
    if args.json:
        print(json.dumps(data))
    else:
        print_text(data)
        if data.get('alertSent'):
            print(f"\nALERT SENT: {data['alertSent']['title']} -> "
                  f"{data['alertSent']['channels']}")
    return exit_code(checks)


if __name__ == '__main__':
    sys.exit(main())
