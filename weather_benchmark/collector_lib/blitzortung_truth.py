"""Blitzortung ground-truth recorder — VALIDATION ONLY.

Records community-network lightning strikes to JSONL so lightning_eval.py can
verify GLM-based warnings with distance-resolved, independent ground truth
(~km location accuracy vs GLM's ~10 km). This is a measuring stick, not a
warning source — the user-facing product stays GLM + METAR.

Resurrected from the app's pre-v0.8.1 Blitzortung integration (git aaa8338):
plain-JSON WebSocket messages {lat, lon, time(ns)}, bbox subscription on open.
Some Blitzortung servers send LZW-compressed payloads; both are handled.

Off by default — enable with `blitzortung_truth_enabled: true` in
collector_config.yaml. Requires `websocket-client` (pip). Non-commercial use
per Blitzortung's terms; a single passive bbox subscription is well within
community norms.

Output: data/lightning_truth/YYYY-MM-DD.jsonl — {"t": iso_utc, "lat": .., "lon": ..}

Coverage: data/lightning_truth/coverage/YYYY-MM-DD.jsonl —
  {"t": iso_utc, "event": "connect"|"heartbeat"|"disconnect", "server": url}
A heartbeat is written at most every HEARTBEAT_S while the socket is up, so a
window with no connect/heartbeat line was NOT being recorded (the recorder
reconnects thousands of times; "no strikes" there means "no data", not "no
lightning"). lightning_truth_eval.py uses this to drop uncovered polls.
"""

import json
import logging
import os
import threading
import time
from datetime import datetime, timezone

logger = logging.getLogger('collector.bo_truth')

SERVERS = ['wss://ws1.blitzortung.org/', 'wss://ws7.blitzortung.org/',
           'wss://ws8.blitzortung.org/']
RECONNECT_BASE_S = 5
RECONNECT_MAX_S = 300
HEARTBEAT_S = 60
COVERAGE_SUBDIR = 'coverage'


def _lzw_decode(s: str) -> str:
    """Blitzortung's LZW variant (from their web client)."""
    if not s:
        return s
    dict_ = {}
    data = list(s)
    curr_char = data[0]
    old_phrase = curr_char
    out = [curr_char]
    code = 256
    for i in range(1, len(data)):
        curr_code = ord(data[i])
        if curr_code < 256:
            phrase = data[i]
        else:
            phrase = dict_.get(curr_code, old_phrase + curr_char)
        out.append(phrase)
        curr_char = phrase[0]
        dict_[code] = old_phrase + curr_char
        code += 1
        old_phrase = phrase
    return ''.join(out)


def _parse_strike(raw: str):
    """Return (lat, lon, time_ms) or None from a raw ws message."""
    for attempt in (raw, None):
        text = attempt if attempt is not None else _lzw_decode(raw)
        try:
            d = json.loads(text)
        except (ValueError, TypeError):
            continue
        lat, lon, t = d.get('lat'), d.get('lon'), d.get('time')
        if lat is None or lon is None or t is None:
            return None
        time_ms = t // 1_000_000 if isinstance(t, int) and t > 1e15 else t
        return float(lat), float(lon), float(time_ms)
    return None


class BlitzortungRecorder(threading.Thread):
    """Background recorder: one bbox subscription, JSONL append per strike."""

    def __init__(self, out_dir: str, bbox: dict, stop_event: threading.Event):
        super().__init__(name='blitzortung-truth', daemon=True)
        self.out_dir = out_dir
        self.bbox = bbox          # {'west','east','north','south'}
        self.stop_event = stop_event
        self.stats = {'strikes': 0, 'reconnects': 0, 'errors': 0}
        self._last_heartbeat = 0.0
        self._delay = RECONNECT_BASE_S
        self._server_i = 0

    @staticmethod
    def bbox_for_cities(cities, pad_deg: float = 1.5) -> dict:
        lats = [c['lat'] for c in cities]
        lons = [c['lon'] for c in cities]
        return {'west': round(min(lons) - pad_deg, 1), 'east': round(max(lons) + pad_deg, 1),
                'north': round(max(lats) + pad_deg, 1), 'south': round(min(lats) - pad_deg, 1)}

    def _record(self, lat, lon, time_ms):
        if not (self.bbox['south'] <= lat <= self.bbox['north']
                and self.bbox['west'] <= lon <= self.bbox['east']):
            return
        os.makedirs(self.out_dir, exist_ok=True)
        day = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        line = json.dumps({'t': datetime.fromtimestamp(time_ms / 1000, timezone.utc).isoformat(),
                           'lat': round(lat, 4), 'lon': round(lon, 4)})
        with open(os.path.join(self.out_dir, f'{day}.jsonl'), 'a', encoding='utf-8') as f:
            f.write(line + '\n')
        self.stats['strikes'] += 1

    def _coverage(self, event: str, server: str):
        """Append a coverage event; never let bookkeeping kill the recorder."""
        try:
            d = os.path.join(self.out_dir, COVERAGE_SUBDIR)
            os.makedirs(d, exist_ok=True)
            now = datetime.now(timezone.utc)
            line = json.dumps({'t': now.isoformat(), 'event': event, 'server': server})
            with open(os.path.join(d, f'{now:%Y-%m-%d}.jsonl'), 'a', encoding='utf-8') as f:
                f.write(line + '\n')
        except OSError as e:
            logger.debug('coverage write failed: %s', e)

    def _maybe_heartbeat(self, server: str):
        now = time.monotonic()
        if now - self._last_heartbeat >= HEARTBEAT_S:
            self._last_heartbeat = now
            self._coverage('heartbeat', server)

    def run(self):
        try:
            import websocket  # websocket-client
        except ImportError:
            logger.warning('blitzortung recorder disabled: pip install websocket-client')
            return
        while not self.stop_event.is_set():
            url = SERVERS[self._server_i % len(SERVERS)]
            try:
                ws = websocket.create_connection(url, timeout=30)
                # Modern protocol handshake (verified 2026-07): server streams
                # LZW-compressed strikes globally; bbox filtering is client-side.
                ws.send('{"a": 111}')
                logger.info('Blitzortung truth recorder connected (%s), bbox=%s', url, self.bbox)
                self._coverage('connect', url)
                self._last_heartbeat = time.monotonic()
                self._delay = RECONNECT_BASE_S
                ws.settimeout(60)
                while not self.stop_event.is_set():
                    try:
                        msg = ws.recv()
                    except Exception:
                        break  # timeout / closed → reconnect
                    strike = _parse_strike(msg)
                    if strike:
                        self._record(*strike)
                    self._maybe_heartbeat(url)
                self._coverage('disconnect', url)
                try:
                    ws.close()
                except Exception:
                    pass
            except Exception as e:
                self.stats['errors'] += 1
                logger.debug('Blitzortung connect failed (%s): %s', url, e)
            if self.stop_event.is_set():
                return
            self.stats['reconnects'] += 1
            self._server_i += 1
            self.stop_event.wait(self._delay)
            self._delay = min(self._delay * 2, RECONNECT_MAX_S)
