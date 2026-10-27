"""Collector resilience: fetch retries + stale fallback, heartbeat, logging,
and health_check.py's per-city checks and alerting. All offline (a local
HTTP server stands in for Open-Meteo / IEM)."""

import json
import logging
import logging.handlers
import threading
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest
import requests

import collector
import health_check as hc
from collector_lib import fetchers
from collector_lib.rate_limiter import TokenBucket
from collector_lib.record_builder import build_record

UTC = timezone.utc


@pytest.fixture(autouse=True)
def _clean_fetcher_state():
    fetchers._last_good.clear()
    fetchers.SOURCE_STATS.clear()
    yield
    fetchers._last_good.clear()
    fetchers.SOURCE_STATS.clear()


# ── Fetch retries + stale fallback ──────────────────────────────────────────

class _Flaky(BaseHTTPRequestHandler):
    """Fails the first ``fails`` GETs with ``code``, then answers 200."""
    fails = 0
    code = 503
    hits = 0
    body = b'{"current": {"weather_code": 3}}'

    def do_GET(self):
        type(self).hits += 1
        if type(self).hits <= type(self).fails:
            self.send_response(type(self).code)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(type(self).body)

    def log_message(self, *a):
        pass


@pytest.fixture
def flaky_server(monkeypatch):
    _Flaky.hits = 0
    srv = HTTPServer(('127.0.0.1', 0), _Flaky)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    monkeypatch.setattr(fetchers, 'OM_FORECAST', f'http://127.0.0.1:{srv.server_port}/v1/forecast')
    yield _Flaky
    srv.shutdown()


def test_session_retries_5xx_then_succeeds(flaky_server):
    flaky_server.fails, flaky_server.code = 2, 503
    data = fetchers.fetch_open_meteo(1.0, 2.0)
    assert data == {'current': {'weather_code': 3}}
    assert flaky_server.hits == 3                       # 2 failures retried
    assert fetchers.SOURCE_STATS['open_meteo']['ok'] == 1


def test_retry_config():
    r = fetchers._RETRY
    assert r.total == 3 and r.backoff_factor == 1
    assert set(r.status_forcelist) == {429, 500, 502, 503, 504}
    adapter = fetchers._SESSION.get_adapter('https://api.open-meteo.com')
    assert adapter.max_retries is fetchers._RETRY


def test_open_meteo_stale_fallback_marks_and_does_not_mutate(monkeypatch):
    good = {'current': {'weather_code': 61, 'precipitation': 0.02}}
    calls = {'n': 0}

    class R:
        def raise_for_status(self):
            pass

        def json(self):
            return good

    def fake_get(url, **kw):
        calls['n'] += 1
        if calls['n'] == 1:
            return R()
        raise requests.ConnectionError('down')

    monkeypatch.setattr(fetchers._SESSION, 'get', fake_get)
    assert fetchers.fetch_open_meteo(1.0, 2.0) is good
    stale = fetchers.fetch_open_meteo(1.0, 2.0)
    assert stale['current'] == good['current']
    assert stale['_stale']['ageMin'] >= 0
    assert '_stale' not in good                         # cached copy untouched
    # Other points / the hourly variant have no cache of their own
    assert fetchers.fetch_open_meteo(1.0, 2.0, want_hourly=True) is None
    st = fetchers.SOURCE_STATS['open_meteo']
    assert (st['ok'], st['stale'], st['fail']) == (1, 1, 1)


def test_stale_fallback_expires_after_60_min(monkeypatch):
    key = ('iem_asos', 'KBOS')
    fetchers._last_good[key] = ({'stationId': 'KBOS', 'obs': {}},
                                fetchers.time.time() - 61 * 60)
    monkeypatch.setattr(fetchers._SESSION, 'get',
                        lambda *a, **k: (_ for _ in ()).throw(requests.Timeout('slow')))
    assert fetchers.fetch_iem_latest_metar('KBOS', TokenBucket(rps=100, burst=10)) is None
    fetchers._last_good[key] = ({'stationId': 'KBOS', 'obs': {}},
                                fetchers.time.time() - 30 * 60)
    got = fetchers.fetch_iem_latest_metar('KBOS', TokenBucket(rps=100, burst=10))
    assert got['stationId'] == 'KBOS' and 29 <= got['_stale']['ageMin'] <= 31


def test_asos_success_is_remembered(monkeypatch):
    csv = ('station,valid,tmpf,dwpf,relh,drct,sknt,gust,p01i,vsby,wxcodes,metar,skyc1,skyc2,skyc3,skyc4\n'
           'BOS,2026-10-26 12:54,50,45,80,90,10,M,0.00,10,-RA,KBOS 261254Z,OVC,M,M,M\n')

    class R:
        status_code = 200
        text = csv

        def raise_for_status(self):
            pass

    monkeypatch.setattr(fetchers._SESSION, 'get', lambda *a, **k: R())
    got = fetchers.fetch_iem_latest_metar('KBOS', TokenBucket(rps=100, burst=10))
    assert got['obs']['presentWeather'] == '-RA' and '_stale' not in got
    assert ('iem_asos', 'KBOS') in fetchers._last_good


def test_record_marks_stale_sources():
    summary = {'nowcastState': {'precip': {'active': False}, 'sky': {'icon': 'clear-day'}},
               'skyState': None, 'precipStateNow': None, 'precipTrend60m': {},
               'lightningState': None}
    kw = dict(lat=1, lon=2, country='United States', location_name='X', state_code=None,
              station=None, radar_state=None, motion=None, obs=None, summary=summary,
              model_context={}, model_hourly=None)
    fresh = build_record(**kw)
    assert '_staleSources' not in fresh and 'stale_cache' not in (fresh.get('_validationFlags') or [])
    rec = build_record(**kw, stale_sources={'obs': 12.5})
    assert rec['_staleSources'] == {'obs': 12.5}
    assert 'stale_cache' in rec['_validationFlags']


def test_stale_sources_helper():
    assert collector._stale_sources(obs=None, model={'a': 1},
                                    modelHourly={'_stale': {'ageMin': 40.0}}) == {'modelHourly': 40.0}


def test_worker_cache_not_refreshed_by_stale(monkeypatch):
    w = collector.CityWorker({'name': 'X', 'lat': 1.0, 'lon': 2.0, 'station': 'KXXX'},
                             {'poll_interval_sec': 180, 'openmeteo_current_cache_min': 5,
                              'openmeteo_hourly_cache_min': 30},
                             TokenBucket(rps=100, burst=10), Path('.'), threading.Event(), 0.0)
    monkeypatch.setattr(collector, 'fetch_open_meteo',
                        lambda *a, **k: {'current': {}, '_stale': {'ageMin': 20.0}})
    assert w._fetch_open_meteo_cached('current')['_stale']
    assert w._om_cache_current is None


# ── Heartbeat + logging ─────────────────────────────────────────────────────

def test_heartbeat_written_atomically(tmp_path):
    class W:
        city = {'name': 'Boston'}
        stats = {'polls': 5, 'writes': 4, 'errors': 1}
        last_write_utc = '2026-10-26T12:00:00+00:00'

    fetchers._count('iem_asos', 'ok')
    fetchers._count('iem_asos', 'fail')
    path = tmp_path / 'heartbeat.json'
    collector.write_heartbeat([W()], '2026-10-26T11:00:00+00:00', path)
    hb = json.loads(path.read_text())
    assert hb['cities']['Boston'] == {'lastWriteUtc': '2026-10-26T12:00:00+00:00',
                                      'polls': 5, 'writes': 4, 'errors': 1}
    assert hb['sources']['iem_asos']['ok'] == 1 and hb['sources']['iem_asos']['fail'] == 1
    assert hb['startedUtc'] == '2026-10-26T11:00:00+00:00' and hb['pid'] > 0
    assert not (tmp_path / 'heartbeat.json.tmp').exists()


def test_logging_iso_utc_and_rotating(tmp_path):
    root = logging.getLogger()
    saved = root.handlers[:], root.level
    try:
        log_file = tmp_path / 'collector.log'
        collector.setup_logging('INFO', str(log_file), max_mb=0.001, backups=2)
        (h,) = root.handlers
        assert isinstance(h, logging.handlers.RotatingFileHandler)
        for i in range(50):
            logging.getLogger('collector').info('line %d %s', i, 'x' * 40)
        h.flush()
        first = log_file.read_text(encoding='utf-8').splitlines()[0]
        stamp = first.split(' ')[0]
        assert stamp.endswith('Z') and 'T' in stamp
        datetime.strptime(stamp, '%Y-%m-%dT%H:%M:%SZ')
        assert (tmp_path / 'collector.log.1').exists()
        assert not (tmp_path / 'collector.log.3').exists()   # backups=2
        h.close()
    finally:
        root.handlers[:], root.level = saved[0], saved[1]


# ── health_check.py ─────────────────────────────────────────────────────────

NOW = datetime(2026, 10, 26, 12, 0, tzinfo=UTC)


def _write_city(logs, slug, stamps):
    d = logs / slug
    d.mkdir(parents=True, exist_ok=True)
    by_day = {}
    for ts in stamps:
        rec = {'_schemaVersion': 3, 'timestamp': ts.isoformat(), 'locationName': slug}
        by_day.setdefault(ts.date(), []).append(json.dumps(rec, separators=(',', ':')))
    for day, lines in by_day.items():
        (d / f'{day.isoformat()}.jsonl').write_text('\n'.join(lines) + '\n', encoding='utf-8')


def _setup(tmp_path, latest_age_min=1, interval_s=180, collectors=1):
    tmp_path.mkdir(parents=True, exist_ok=True)
    logs = tmp_path / 'logs'
    cities = tmp_path / 'cities.json'
    cities.write_text(json.dumps([{'name': 'Boston'}, {'name': 'Fort Collins'},
                                  {'name': 'Sarasota', 'holdout': True}]))
    for slug in ('boston', 'fort_collins'):
        stamps = []
        for c in range(collectors):
            t = NOW - timedelta(minutes=latest_age_min, seconds=7 * c)
            while t > NOW - timedelta(hours=26):
                stamps.append(t)
                t -= timedelta(seconds=interval_s)
        _write_city(logs, slug, sorted(stamps))
    return logs, cities


def _run(tmp_path, logs, cities, now=NOW):
    return hc.compute(logs, cities, tmp_path / 'no_heartbeat.json', {}, now)


def _check(checks, name):
    return next(c for c in checks if c.name == name)


def test_health_ok_on_healthy_collector(tmp_path):
    logs, cities = _setup(tmp_path)
    stats, checks = _run(tmp_path, logs, cities)
    assert [s['name'] for s in stats] == ['Boston', 'Fort Collins']   # holdout skipped
    assert all(s['polls24h'] == 480 for s in stats)
    assert not any(c.alert for c in checks)
    assert hc.exit_code(checks) == 0


def test_health_stale_fails_and_alert_fires(tmp_path):
    logs, cities = _setup(tmp_path, latest_age_min=20)
    stats, checks = _run(tmp_path, logs, cities)
    rec = _check(checks, 'Recency')
    assert rec.status == 'fail' and rec.alert and 'ALL cities stale' in rec.message

    sent = []
    sender = lambda title, body, cfg, prio='high': sent.append((title, body, prio)) or {'x': True}
    state = tmp_path / 'state.json'
    out = hc.process_alerts(checks, NOW, {}, state, sender)
    assert out and sent[0][0] == 'WeatherHQ collector: Recency'
    # Same problem 15 min later: no repeat until repeat_hours
    assert hc.process_alerts(checks, NOW + timedelta(minutes=15), {}, state, sender) is None
    assert len(sent) == 1
    hc.process_alerts(checks, NOW + timedelta(hours=3), {}, state, sender)
    assert len(sent) == 2
    # Recovery: exactly one "recovered" message
    logs2, _ = _setup(tmp_path / 'b')
    _, ok_checks = _run(tmp_path, logs2, cities)
    hc.process_alerts(ok_checks, NOW + timedelta(hours=4), {}, state, sender)
    hc.process_alerts(ok_checks, NOW + timedelta(hours=4, minutes=15), {}, state, sender)
    assert len(sent) == 3 and sent[2][0] == 'WeatherHQ collector recovered'
    assert sent[2][2] == 'default'


def test_health_one_city_stale(tmp_path):
    logs, cities = _setup(tmp_path)
    _write_city(logs, 'fort_collins', [NOW - timedelta(hours=1)])
    for f in (logs / 'fort_collins').glob('*.jsonl'):
        if f.name != f'{NOW.date().isoformat()}.jsonl':
            f.unlink()
    _, checks = _run(tmp_path, logs, cities)
    rec = _check(checks, 'Recency')
    assert rec.alert and rec.message.startswith('stale: Fort Collins')


def test_health_detects_duplicate_collectors(tmp_path):
    logs, cities = _setup(tmp_path, collectors=2)
    _, checks = _run(tmp_path, logs, cities)
    dup = _check(checks, 'Duplicates')
    assert dup.status == 'fail' and dup.alert and '960/24h' in dup.message


def test_health_never_written_city(tmp_path):
    logs, cities = _setup(tmp_path)
    cities.write_text(json.dumps([{'name': 'Boston'}, {'name': 'Nowhere'}]))
    _, checks = _run(tmp_path, logs, cities)
    assert 'Nowhere never' in _check(checks, 'Recency').message


def test_health_cli_json_and_alert(tmp_path, monkeypatch, capsys):
    logs, cities = _setup(tmp_path, latest_age_min=30)
    sent = []
    monkeypatch.setattr(hc, 'send_alert',
                        lambda t, b, cfg, p='high': sent.append(t) or {'desktop': True})
    code = hc.main(['--json', '--alert', '--logs-dir', str(logs), '--cities-file', str(cities),
                    '--heartbeat', str(tmp_path / 'hb.json'), '--state-file', str(tmp_path / 's.json'),
                    '--config', str(tmp_path / 'none.yaml'), '--now', NOW.isoformat()])
    data = json.loads(capsys.readouterr().out)
    assert code == 2 and data['worst_status'] == 'fail'
    assert {'path', 'records', 'summary', 'checks'} <= data.keys()   # server.py / main.js shape
    assert data['alertSent']['title'] == 'WeatherHQ collector: Recency' and sent


def test_heartbeat_check_flags_failing_source(tmp_path):
    hb = tmp_path / 'hb.json'
    hb.write_text(json.dumps({'updatedUtc': (NOW - timedelta(minutes=2)).isoformat(),
                              'pid': 1, 'startedUtc': 'x',
                              'sources': {'open_meteo': {'ok': 10, 'fail': 5, 'stale': 5},
                                          'iem_asos': {'ok': 100, 'fail': 1, 'stale': 0}}}))
    c = hc.check_heartbeat(hb, NOW, 15)
    assert c.status == 'warn' and 'open_meteo 10/20 failed' in c.message and 'iem_asos' not in c.message
