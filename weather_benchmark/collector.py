#!/usr/bin/env python3
"""Weather Benchmark Collector — continuous, multi-city data collection.

Replaces the browser-driven collection (removed in v1.45.0). Polls every
configured city on a fixed cadence, computes the nowcast state using a
Python port of the JS algorithm, and writes JSONL records to:

    data/logs/<city_slug>/YYYY-MM-DD.jsonl

Usage:
    python collector.py                    # uses collector_config.yaml
    python collector.py --config foo.yaml
    python collector.py --cities Boston Atlanta   # subset of cities
    python collector.py --once             # one poll cycle then exit (smoke test)

See COLLECTOR.md for the operator guide.
"""

import argparse
import json
import logging
import re
import signal
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

import yaml

from collector_lib.rate_limiter import TokenBucket
from collector_lib.radar_sampler import RadarSampler, RADAR_CFG, derive_rv_timing
from collector_lib.fetchers import (
    fetch_iem_latest_metar, fetch_open_meteo,
    extract_model_context, extract_hourly_context,
)
from collector_lib.lightning import empty_lightning_state, GlmFetcher
from collector_lib import nowcast as nc
from collector_lib.record_builder import build_record

logger = logging.getLogger('collector')

HERE = Path(__file__).resolve().parent
DEFAULT_CONFIG = HERE / 'collector_config.yaml'
DEFAULT_CITIES = HERE / 'data' / 'cities.json'


# ── Configuration ────────────────────────────────────────────────────────────

def load_config(path: Path) -> Dict:
    with open(path, 'r', encoding='utf-8') as f:
        return yaml.safe_load(f)


def load_cities(path: Path) -> List[Dict]:
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def city_slug(name: str) -> str:
    s = re.sub(r'[^a-z0-9]+', '_', name.lower())
    return s.strip('_')


# ── Per-city worker ──────────────────────────────────────────────────────────

class CityWorker(threading.Thread):
    """One thread per city — its own RadarSampler, its own poll cadence.

    Maintains independent radar history and motion estimate; never shares
    state with other workers (the root-cause fix for the JS module-global bug).
    """

    def __init__(self, city: Dict, config: Dict, limiter: TokenBucket,
                 log_dir: Path, stop_event: threading.Event,
                 startup_offset_sec: float, glm: Optional[GlmFetcher] = None,
                 rv_limiter: Optional[TokenBucket] = None):
        super().__init__(name=f"collector-{city_slug(city['name'])}", daemon=True)
        self.city = city
        self.config = config
        self.limiter = limiter
        self.log_dir = log_dir
        self.stop_event = stop_event
        self.startup_offset_sec = startup_offset_sec
        self.glm = glm
        self.poll_interval_sec = city.get('poll_interval_sec') or config['poll_interval_sec']
        self.sampler = RadarSampler(city['lat'], city['lon'], limiter)
        self.pred_memory = nc.PredictionMemory()   # per-city self-correction state
        self.rv_limiter = rv_limiter               # shared RainViewer rate limiter (None = RV off)
        self._om_cache_current = None      # (response, fetched_at)
        self._om_cache_hourly = None       # (response, fetched_at)
        self.stats = {'polls': 0, 'writes': 0, 'errors': 0}

    def run(self):
        # Initial stagger so cities don't all hit IEM simultaneously at startup.
        if self.startup_offset_sec > 0 and not self.stop_event.wait(self.startup_offset_sec):
            pass
        if self.stop_event.is_set():
            return

        next_poll = time.monotonic()
        while not self.stop_event.is_set():
            sleep_for = max(0.0, next_poll - time.monotonic())
            if self.stop_event.wait(sleep_for):
                return
            try:
                self.poll_once()
            except Exception:
                logger.exception('Poll error for %s', self.city['name'])
                self.stats['errors'] += 1
            next_poll += self.poll_interval_sec
            # If we fell behind by more than one interval, resync
            if time.monotonic() - next_poll > self.poll_interval_sec:
                next_poll = time.monotonic()

    def poll_once(self) -> Optional[Dict]:
        """Execute one full poll cycle for this city. Returns the written record."""
        self.stats['polls'] += 1

        # ── Inputs ────────────────────────────────────────────────────────
        radar_state = self.sampler.sample()
        motion = self.sampler.estimate_motion()
        obs = fetch_iem_latest_metar(self.city['station'], self.limiter)
        om_current = self._fetch_open_meteo_cached('current')
        om_hourly = self._fetch_open_meteo_cached('hourly')
        model_context = extract_model_context(om_current) if om_current else None
        model_hourly = extract_hourly_context(om_hourly) if om_hourly else None
        model_wmo = model_context.get('weatherCode') if model_context else None
        om_precip_in_hr = model_context.get('precipitation') if model_context else None

        # ── Derived state ────────────────────────────────────────────────
        country = 'United States'  # all current cities are US; collector_config could override
        sky_state = nc.compute_sky_state(obs, country)
        precip_state_now = nc.compute_precip_now(obs, radar_state, country)
        timeline = self.sampler.build_timeline(
            radar_state.get('dbz') if radar_state else None,
            radar_state.get('isRaining') if radar_state else False,
        )
        rain_timing = self.sampler.estimate_rain_timing(
            motion,
            radar_state.get('dbz') if radar_state else None,
            radar_state.get('isRaining') if radar_state else False,
        )

        is_raining = bool(radar_state and radar_state.get('isRaining'))
        # Edge-geometry timing (primary): leading/trailing echo edge along the
        # storm track ÷ closing speed. Slope timeline remains the fallback.
        edge = None
        edge_attempted = bool(motion and motion.get('speed_kmh', 0) >= 5)
        if edge_attempted:
            try:
                edge = self.sampler.sample_edge_timing(motion, is_raining)
            except Exception:
                logger.exception('Edge timing failed for %s', self.city['name'])
                edge_attempted = False
        fallback_minutes = (rain_timing.get('endInMin') if is_raining
                            else rain_timing.get('beginInMin'))
        # RainViewer nowcast cross-check (config flag rainviewer_enabled)
        rv_minutes = None
        if self.config.get('rainviewer_enabled', True):
            try:
                rv_samples = self.sampler.sample_rainviewer_nowcast(self.rv_limiter)
                rv_timing = derive_rv_timing(rv_samples, is_raining)
                rv_minutes = (rv_timing.get('endInMin') if is_raining
                              else rv_timing.get('beginInMin'))
            except Exception:
                logger.exception('RainViewer nowcast failed for %s', self.city['name'])
        precip_trend = nc.compute_precip_trend(
            timeline=timeline,
            is_raining=is_raining,
            edge=edge,
            edge_attempted=edge_attempted,
            motion=motion,
            fallback_minutes=fallback_minutes,
            pred_memory=self.pred_memory,
            rv_minutes=rv_minutes,
        )

        glm_state = (self.glm.summarize(self.city['lat'], self.city['lon'])
                     if self.glm else empty_lightning_state())
        lightning_state = nc.compute_lightning_state(obs, radar_state, motion, glm_state)
        nowcast_state = nc.derive_nowcast_state(
            radar_state, obs, model_wmo, lightning_state, precip_trend, country,
            om_precip_in_hr,
        )

        summary = {
            'skyState': sky_state,
            'precipStateNow': precip_state_now,
            'precipTrend60m': precip_trend,
            'lightningState': lightning_state,
            'nowcastState': nowcast_state,
        }

        record = build_record(
            lat=self.city['lat'],
            lon=self.city['lon'],
            country=country,
            location_name=self.city['name'],
            state_code=self.city.get('stateCode'),
            station=obs.get('stationId') if obs else self.city.get('station'),
            radar_state=radar_state,
            motion=motion,
            obs=obs,
            summary=summary,
            model_context=model_context,
            model_hourly=model_hourly,
        )

        self._write_record(record)
        self.stats['writes'] += 1
        return record

    def _fetch_open_meteo_cached(self, which: str) -> Optional[Dict]:
        cache_attr = '_om_cache_current' if which == 'current' else '_om_cache_hourly'
        cache_min = (self.config['openmeteo_current_cache_min'] if which == 'current'
                     else self.config['openmeteo_hourly_cache_min'])
        cached = getattr(self, cache_attr)
        now = time.monotonic()
        if cached and (now - cached[1]) < cache_min * 60:
            return cached[0]
        resp = fetch_open_meteo(self.city['lat'], self.city['lon'],
                                want_hourly=(which == 'hourly'))
        if resp:
            setattr(self, cache_attr, (resp, now))
        return resp

    def _write_record(self, record: Dict) -> None:
        slug = city_slug(self.city['name'])
        day = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        out_dir = self.log_dir / slug
        out_dir.mkdir(parents=True, exist_ok=True)
        path = out_dir / f'{day}.jsonl'
        with open(path, 'a', encoding='utf-8') as f:
            f.write(json.dumps(record, separators=(',', ':')) + '\n')


# ── Main ────────────────────────────────────────────────────────────────────

def setup_logging(level: str):
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format='%(asctime)s %(name)s %(levelname)s: %(message)s',
        datefmt='%H:%M:%S',
    )


def main():
    parser = argparse.ArgumentParser(description='Weather Benchmark Collector')
    parser.add_argument('--config', default=str(DEFAULT_CONFIG),
                        help='Path to collector_config.yaml')
    parser.add_argument('--cities-file', default=str(DEFAULT_CITIES),
                        help='Path to cities.json')
    parser.add_argument('--cities', nargs='*',
                        help='Subset of city names to collect (default: all non-holdout)')
    parser.add_argument('--once', action='store_true',
                        help='Single poll cycle per city, then exit (smoke test mode)')
    parser.add_argument('--include-holdout', action='store_true',
                        help='Include cities marked holdout=true (default: skip)')
    args = parser.parse_args()

    config = load_config(Path(args.config))
    setup_logging(config.get('log_level', 'INFO'))

    all_cities = load_cities(Path(args.cities_file))
    if args.cities:
        wanted = {c.lower() for c in args.cities}
        all_cities = [c for c in all_cities if c['name'].lower() in wanted]
    if not args.include_holdout:
        all_cities = [c for c in all_cities if not c.get('holdout')]

    if not all_cities:
        logger.error('No cities to collect — check --cities filter or cities.json')
        sys.exit(2)

    log_dir = HERE / config.get('log_dir', 'data/logs')
    log_dir.mkdir(parents=True, exist_ok=True)

    limiter = TokenBucket(
        rps=config['iem_rate_limit_rps'],
        burst=config['iem_burst_tokens'],
    )

    stop_event = threading.Event()

    def handle_signal(signum, frame):
        logger.info('Signal %s received — shutting down', signum)
        stop_event.set()
    signal.signal(signal.SIGINT, handle_signal)
    if hasattr(signal, 'SIGTERM'):
        signal.signal(signal.SIGTERM, handle_signal)

    glm = GlmFetcher(config) if config.get('glm_enabled', True) else None
    # RainViewer nowcast cross-check — own limiter (separate host from IEM)
    rv_limiter = (TokenBucket(rps=2, burst=4)
                  if config.get('rainviewer_enabled', True) else None)

    logger.info('Collector starting: %d cities, poll_interval=%ds, glm=%s, log_dir=%s',
                len(all_cities), config['poll_interval_sec'],
                'on' if glm else 'off', log_dir)

    if args.once:
        # Smoke-test mode: one GLM poll, then a serial single poll per city.
        if glm:
            try:
                n = glm.poll_once()
                logger.info('once: GLM ingested %d flash(es)', n)
            except Exception:
                logger.exception('once: GLM poll failed')
        for city in all_cities:
            worker = CityWorker(city, config, limiter, log_dir, stop_event, 0.0, glm, rv_limiter)
            try:
                worker.poll_once()
                logger.info('once: wrote %s', city['name'])
            except Exception:
                logger.exception('once: poll failed for %s', city['name'])
        logger.info('Done (--once mode)')
        return

    if glm:
        glm.start()

    workers = []
    for i, city in enumerate(all_cities):
        offset = i * config['city_stagger_sec']
        w = CityWorker(city, config, limiter, log_dir, stop_event, offset, glm, rv_limiter)
        w.start()
        workers.append(w)

    last_metrics = time.monotonic()
    metrics_interval = config.get('metrics_interval_sec', 300)
    try:
        while not stop_event.is_set():
            stop_event.wait(min(metrics_interval, 5.0))
            now = time.monotonic()
            if now - last_metrics >= metrics_interval:
                _log_metrics(workers)
                last_metrics = now
    finally:
        stop_event.set()
        if glm:
            glm.stop()
        deadline = time.monotonic() + config.get('graceful_shutdown_sec', 30)
        for w in workers:
            remaining = max(0.1, deadline - time.monotonic())
            w.join(timeout=remaining)
        _log_metrics(workers)
        logger.info('Collector stopped')


def _log_metrics(workers):
    for w in workers:
        s = w.stats
        logger.info('city=%s polls=%d writes=%d errors=%d',
                    w.city['name'], s['polls'], s['writes'], s['errors'])


if __name__ == '__main__':
    main()
