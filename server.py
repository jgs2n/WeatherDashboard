"""
Weather HQ Dev Server
Serves static files + handles API endpoints for training data collection
and benchmark city management.
Usage: python server.py [port]  (default: 3000)
"""

import os
import re
import sys
import json
import subprocess
import threading
import traceback
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from socketserver import ThreadingMixIn


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    """Handle each request in a separate thread."""
    daemon_threads = True

LOG_DIR = Path(__file__).parent / 'weather_benchmark' / 'data' / 'logs'
CITIES_FILE = Path(__file__).parent / 'weather_benchmark' / 'data' / 'cities.json'
BENCHMARK_DIR = Path(__file__).parent / 'weather_benchmark'
REPORTS_DIR = BENCHMARK_DIR / 'reports'

# Backtest process state
_backtest_lock = threading.Lock()
_backtest_proc = None
_backtest_status = {'running': False, 'last_report': None, 'error': None}


def _city_slug(name):
    """'Charleston, WV' -> 'charleston_wv'"""
    s = name.lower()
    s = re.sub(r'[^a-z0-9]+', '_', s)
    return s.strip('_')


def _latest_report():
    """Return the filename of the newest weekly_*.json in reports/."""
    reports = sorted(REPORTS_DIR.glob('weekly_*.json'))
    return reports[-1].name if reports else None


def _run_backtest_thread(days, log_file=None):
    global _backtest_proc, _backtest_status
    try:
        if log_file:
            if '--' in log_file:
                sep = log_file.index('--')
                start_date = log_file[:10]
                end_date = log_file[sep + 2:sep + 12]
            else:
                start_date = end_date = log_file[:10]
            cmd = [sys.executable, 'backtest.py', '--start-date', start_date, '--end-date', end_date]
        else:
            cmd = [sys.executable, 'backtest.py', '--days', str(days)]
        proc = subprocess.Popen(
            cmd, cwd=str(BENCHMARK_DIR),
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT
        )
        with _backtest_lock:
            _backtest_proc = proc
        out_bytes, _ = proc.communicate()
        out = out_bytes.decode(errors='replace') if out_bytes else ''
        with _backtest_lock:
            _backtest_proc = None
            if proc.returncode == 0:
                _backtest_status = {'running': False, 'last_report': _latest_report(), 'error': None}
            else:
                _backtest_status = {'running': False, 'last_report': None, 'error': out[-300:] or 'Non-zero exit'}
    except Exception as e:
        with _backtest_lock:
            _backtest_proc = None
            _backtest_status = {'running': False, 'last_report': None, 'error': str(e)}


class WeatherDevHandler(SimpleHTTPRequestHandler):

    def do_GET(self):
        if self.path == '/api/cities':
            self._handle_get_cities()
        elif self.path == '/api/backtest-status':
            self._handle_backtest_status()
        elif self.path == '/api/logs':
            self._handle_get_logs()
        else:
            super().do_GET()

    def do_POST(self):
        if self.path == '/api/backtest':
            self._handle_backtest()
        elif self.path == '/api/health-check':
            self._handle_health_check()
        else:
            self.send_error(404)

    def do_PUT(self):
        if self.path == '/api/cities':
            self._handle_put_cities()
        else:
            self.send_error(404)

    def _send_json(self, status, data):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def _send_error(self, status, message):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps({'error': message}).encode())

    def _handle_backtest(self):
        global _backtest_status
        with _backtest_lock:
            if _backtest_status.get('running'):
                self._send_json(409, {'error': 'Backtest already running'})
                return
            body = {}
            try:
                length = int(self.headers.get('Content-Length', 0))
                if length:
                    body = json.loads(self.rfile.read(length))
            except Exception:
                pass
            days = int(body.get('days', 7)) if isinstance(body, dict) else 7
            log_file = body.get('log_file') if isinstance(body, dict) else None
            _backtest_status = {'running': True, 'last_report': None, 'error': None}
        t = threading.Thread(target=_run_backtest_thread, args=(days, log_file), daemon=True)
        t.start()
        self._send_json(200, {'ok': True, 'running': True})

    def _handle_backtest_status(self):
        with _backtest_lock:
            self._send_json(200, dict(_backtest_status))

    def _handle_health_check(self):
        """Run weather_benchmark/health_check.py --json and return its output.
        Synchronous — the script reads one JSONL file and returns in under a
        second. 15s timeout is a safety net for pathological file sizes."""
        try:
            cmd = [sys.executable, 'health_check.py', '--json']
            proc = subprocess.run(
                cmd, cwd=str(BENCHMARK_DIR),
                capture_output=True, text=True, timeout=15,
            )
            # health_check.py emits JSON on stdout regardless of exit code;
            # exit code signals severity (0=ok, 1=warn, 2=fail) for CLI use.
            try:
                payload = json.loads(proc.stdout)
            except json.JSONDecodeError:
                self._send_json(500, {
                    'error': 'health_check.py produced invalid JSON',
                    'stderr': proc.stderr[-500:] if proc.stderr else '',
                    'stdout': proc.stdout[-500:] if proc.stdout else '',
                })
                return
            self._send_json(200, payload)
        except subprocess.TimeoutExpired:
            self._send_error(504, 'health_check.py timed out')
        except Exception:
            print(traceback.format_exc(), file=sys.stderr)
            self._send_error(500, 'Health check failed to run')

    def _handle_get_logs(self):
        try:
            if LOG_DIR.is_dir():
                files = sorted(
                    f.name for f in LOG_DIR.iterdir()
                    if f.suffix == '.jsonl'
                )
            else:
                files = []
            self._send_json(200, files)
        except Exception:
            self._send_json(200, [])

    def _handle_get_cities(self):
        """Return the cities list as JSON."""
        try:
            cities = _load_cities()
            self._send_json(200, cities)
        except FileNotFoundError:
            self._send_json(200, [])
        except json.JSONDecodeError:
            self._send_error(500, 'Cities file corrupt')
        except Exception:
            print(traceback.format_exc(), file=sys.stderr)
            self._send_error(500, 'Internal server error')

    def _handle_put_cities(self):
        """Save the cities list from JSON body."""
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length)
            cities = json.loads(body)

            if not isinstance(cities, list):
                raise ValueError('Expected a JSON array of cities')

            for c in cities:
                if not all(k in c for k in ('name', 'lat', 'lon', 'station')):
                    raise ValueError('City missing required fields')
                c['lat'] = float(c['lat'])
                c['lon'] = float(c['lon'])
                c['station'] = c['station'].strip().upper()

            CITIES_FILE.parent.mkdir(parents=True, exist_ok=True)
            with open(CITIES_FILE, 'w', encoding='utf-8') as f:
                json.dump(cities, f, indent=2)

            self._send_json(200, {'ok': True, 'count': len(cities)})
        except json.JSONDecodeError:
            self._send_error(400, 'Invalid JSON')
        except ValueError as e:
            self._send_error(400, str(e))
        except OSError:
            self._send_error(500, 'Save failed')
        except Exception:
            print(traceback.format_exc(), file=sys.stderr)
            self._send_error(500, 'Internal server error')

    def do_OPTIONS(self):
        # CORS preflight
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, PUT, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def end_headers(self):
        # Add CORS to all responses
        if 'Access-Control-Allow-Origin' not in {h for h, _ in self._headers_buffer_str()}:
            self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()

    def _headers_buffer_str(self):
        """Parse already-buffered headers for dedup check."""
        results = []
        for item in self._headers_buffer:
            if isinstance(item, bytes):
                line = item.decode('latin-1', errors='replace')
                if ':' in line:
                    name = line.split(':')[0].strip()
                    results.append((name, ''))
        return results

    def log_message(self, format, *args):
        # Quieter logging — skip 200s for static files
        if len(args) >= 2 and '200' in str(args[1]):
            return
        super().log_message(format, *args)


def _load_cities():
    """Load cities from cities.json, falling back to config.yaml."""
    if CITIES_FILE.is_file():
        with open(CITIES_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    # Fallback: read from config.yaml
    config_path = Path(__file__).parent / 'weather_benchmark' / 'config.yaml'
    if config_path.is_file():
        try:
            import yaml
            with open(config_path, 'r') as f:
                cfg = yaml.safe_load(f)
            return cfg.get('locations', [])
        except ImportError:
            pass
    return []


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 3000

    server = ThreadedHTTPServer(('', port), WeatherDevHandler)
    print(f'Weather HQ dev server on http://localhost:{port}')
    print(f'Logs read from -> {LOG_DIR}/  (write via collector.py)')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nShutting down.')
        server.server_close()


if __name__ == '__main__':
    main()
