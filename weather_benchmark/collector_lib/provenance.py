"""Code-provenance stamps for collector records and backtest reports.

``algo_version()`` is the web app's release (sw.js CACHE_NAME, which CLAUDE.md
requires bumping on every algorithm change — the collector is a port of that
release). ``git_describe()`` pins the exact tree, ``-dirty`` included.

Both are read once per process: the collector imports its code at startup,
so the startup values describe the code that is actually running even if the
files are edited later.
"""

import functools
import re
import subprocess
from pathlib import Path
from typing import Optional

REPO_ROOT = Path(__file__).resolve().parents[2]
_CACHE_NAME_RE = re.compile(r"CACHE_NAME\s*=\s*['\"]weather-hq-v([0-9][\w.\-]*)['\"]")


@functools.lru_cache(maxsize=None)
def algo_version() -> Optional[str]:
    try:
        text = (REPO_ROOT / 'sw.js').read_text(encoding='utf-8', errors='replace')
    except OSError:
        return None
    m = _CACHE_NAME_RE.search(text)
    return m.group(1) if m else None


@functools.lru_cache(maxsize=None)
def git_describe() -> Optional[str]:
    try:
        r = subprocess.run(['git', 'describe', '--always', '--dirty', '--tags'],
                           cwd=str(REPO_ROOT), capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    out = r.stdout.strip()
    return out if r.returncode == 0 and out else None
