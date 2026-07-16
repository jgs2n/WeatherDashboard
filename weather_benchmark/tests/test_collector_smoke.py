"""Smoke tests for the collector — Layer 1 of the validation plan.

Runs the collector in --once mode against 1-2 cities and asserts:
  * snapshots get written
  * every snapshot has the required schema fields
  * coherence checks pass (icon ↔ condition, radar state vs dBZ)
  * no Python exceptions

These tests hit live IEM + Open-Meteo endpoints. They will be flaky if those
services are down. To skip in offline environments, set NO_NETWORK=1.

Usage:
    pytest weather_benchmark/tests/test_collector_smoke.py -v
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import pytest

BENCHMARK_DIR = Path(__file__).resolve().parent.parent
COLLECTOR = BENCHMARK_DIR / 'collector.py'
CONFIG = BENCHMARK_DIR / 'collector_config.yaml'


pytestmark = pytest.mark.skipif(
    os.environ.get('NO_NETWORK') == '1',
    reason='NO_NETWORK=1 set; smoke tests need live IEM + Open-Meteo'
)


REQUIRED_KEYS = {
    '_schemaVersion', 'timestamp', 'lat', 'lon', 'country', 'locationName',
    'displayedCondition', 'precip', 'sky', 'trend', 'radar', 'model',
}


@pytest.fixture(scope='module')
def smoke_run(tmp_path_factory):
    """Run collector once against 2 cities; yield the log dir for inspection."""
    log_dir = tmp_path_factory.mktemp('smoke_logs')
    # Override log_dir via a temp config file copy. Use POSIX path so the
    # Windows backslashes don't get interpreted as regex/yaml escapes.
    log_dir_str = log_dir.as_posix()
    cfg_text = CONFIG.read_text()
    cfg_text = re.sub(r'log_dir:.*', lambda m: f'log_dir: {log_dir_str}', cfg_text)
    cfg_path = log_dir.parent / 'smoke_config.yaml'
    cfg_path.write_text(cfg_text)

    cmd = [
        sys.executable, str(COLLECTOR),
        '--config', str(cfg_path),
        '--cities', 'Boston', 'Bozeman',
        '--once',
    ]
    result = subprocess.run(cmd, cwd=str(BENCHMARK_DIR), capture_output=True,
                            text=True, timeout=120)
    return {
        'log_dir': log_dir,
        'stdout': result.stdout,
        'stderr': result.stderr,
        'returncode': result.returncode,
    }


def test_collector_exits_zero(smoke_run):
    assert smoke_run['returncode'] == 0, (
        f"collector exited {smoke_run['returncode']}\n"
        f"STDERR:\n{smoke_run['stderr']}"
    )


def test_collector_no_tracebacks(smoke_run):
    combined = smoke_run['stdout'] + smoke_run['stderr']
    assert 'Traceback' not in combined, (
        f"Python traceback in collector output:\n{combined}"
    )


def test_at_least_one_snapshot_per_city(smoke_run):
    log_dir = Path(smoke_run['log_dir'])
    for slug in ('boston', 'bozeman'):
        files = list((log_dir / slug).glob('*.jsonl'))
        assert files, f'No JSONL written for {slug}'
        records = []
        for f in files:
            with open(f) as fh:
                records.extend(json.loads(ln) for ln in fh if ln.strip())
        assert records, f'JSONL for {slug} is empty'


def test_schema_required_keys(smoke_run):
    log_dir = Path(smoke_run['log_dir'])
    for jsonl in log_dir.rglob('*.jsonl'):
        with open(jsonl) as f:
            for line_no, line in enumerate(f, 1):
                if not line.strip():
                    continue
                rec = json.loads(line)
                missing = REQUIRED_KEYS - set(rec.keys())
                assert not missing, f'{jsonl}:{line_no} missing keys: {missing}'
                assert rec['_schemaVersion'] == 2


def test_record_validation_flags(smoke_run):
    """No icon/condition mismatch and no radar-state-no-dbz errors."""
    log_dir = Path(smoke_run['log_dir'])
    for jsonl in log_dir.rglob('*.jsonl'):
        with open(jsonl) as f:
            for line_no, line in enumerate(f, 1):
                if not line.strip():
                    continue
                rec = json.loads(line)
                flags = rec.get('_validationFlags') or []
                # 'model_unavailable' is OK in smoke if Open-Meteo flaked;
                # the other two flags are real coherence bugs.
                bad = [f for f in flags if f != 'model_unavailable']
                assert not bad, f'{jsonl}:{line_no} validation flags: {bad}'


def test_timestamps_recent(smoke_run):
    """Snapshot timestamps should be within the last 10 minutes."""
    import datetime as dt
    log_dir = Path(smoke_run['log_dir'])
    now = dt.datetime.now(dt.timezone.utc)
    for jsonl in log_dir.rglob('*.jsonl'):
        with open(jsonl) as f:
            for line_no, line in enumerate(f, 1):
                if not line.strip():
                    continue
                rec = json.loads(line)
                ts = dt.datetime.fromisoformat(rec['timestamp'].replace('Z', '+00:00'))
                delta = (now - ts).total_seconds()
                assert 0 <= delta < 600, (
                    f'{jsonl}:{line_no} timestamp {ts} is {delta:.0f}s '
                    f'old (expect <600s)'
                )
