"""Token-bucket rate limiter for IEM endpoints.

IEM throttles ~1 sustained req/sec across both ASOS data and tile endpoints
(observed via 429 responses in production). Bucket holds N burst tokens that
refill at a fixed rate. Calls that find an empty bucket block until refill.

Thread-safe — collector polls multiple cities concurrently.
"""

import time
import threading


class TokenBucket:
    """A leaky-token-bucket rate limiter.

    Args:
        rps:     sustained refill rate (tokens per second)
        burst:   maximum tokens the bucket can hold (i.e., burst budget)
    """

    def __init__(self, rps: float, burst: int):
        self._rps = float(rps)
        self._burst = int(burst)
        self._tokens = float(burst)
        self._last_refill = time.monotonic()
        self._lock = threading.Lock()

    def acquire(self, tokens: int = 1, timeout: float = 30.0) -> bool:
        """Block until ``tokens`` are available, or ``timeout`` seconds elapse.

        Returns True if acquired, False on timeout.
        """
        deadline = time.monotonic() + timeout
        while True:
            with self._lock:
                self._refill()
                if self._tokens >= tokens:
                    self._tokens -= tokens
                    return True
                deficit = tokens - self._tokens
                wait = deficit / self._rps
            now = time.monotonic()
            if now + wait > deadline:
                return False
            # Sleep a touch longer than strict minimum to avoid tight retry loops
            time.sleep(min(wait + 0.01, max(0.0, deadline - now)))

    def _refill(self) -> None:
        now = time.monotonic()
        elapsed = now - self._last_refill
        if elapsed <= 0:
            return
        self._tokens = min(self._burst, self._tokens + elapsed * self._rps)
        self._last_refill = now

    @property
    def available(self) -> float:
        """Current token count (for diagnostics / metrics)."""
        with self._lock:
            self._refill()
            return self._tokens
