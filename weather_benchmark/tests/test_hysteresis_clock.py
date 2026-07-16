"""Parity tests for the radar hysteresis time base.

The state machine must age its hold/decay timers off WALL-CLOCK time, matching
the browser's _processFrame (Date.now()) — NOT the radar frame timestamp. Key
consequences pinned here:
  - history replay (frames processed back-to-back at ~one clock value) must NOT
    expire state, exactly like the app;
  - real elapsed time DOES expire ON -> HOLDING -> OFF;
  - the logged lastValidDbzTime is wall-clock ms (matches the app field).

_process_frame takes an injectable now_ms so these are deterministic.
"""

from collector_lib.radar_sampler import RadarSampler, RADAR_CFG

ON = RADAR_CFG['ON_THRESHOLD']          # 22
NULL_DECAY = RADAR_CFG['NULL_DECAY_MS']  # 300_000
OFF_HOLD = RADAR_CFG['OFF_HOLD_MS']      # 480_000


def _sampler():
    return RadarSampler(40.0, -105.0, limiter=None)


def test_replay_at_constant_clock_does_not_age():
    """Back-to-back frames at one clock value (history replay) keep state —
    the JS quirk we must replicate, since Date.now() barely moves in the loop."""
    s = _sampler()
    T = 1_000_000.0
    s._process_frame(0, ON + 10, now_ms=T)   # OFF -> PENDING_ON
    s._process_frame(0, ON + 10, now_ms=T)   # PENDING_ON -> ON
    assert s._rain_state == 'ON'
    for _ in range(6):                       # a run of null frames, no time passing
        s._process_frame(0, None, now_ms=T)
    assert s._rain_state == 'ON'             # timers never fire → stays ON


def test_wallclock_elapsed_time_expires_state():
    """With real elapsed time, ON -> HOLDING (null decay) -> OFF (hold)."""
    s = _sampler()
    s._process_frame(0, ON + 10, now_ms=0)
    s._process_frame(0, ON + 10, now_ms=0)   # ON, last_on=0, last_valid=0
    assert s._rain_state == 'ON'
    s._process_frame(0, None, now_ms=NULL_DECAY + 1)   # null decay → HOLDING
    assert s._rain_state == 'HOLDING'
    s._process_frame(0, None, now_ms=OFF_HOLD + 1)     # hold expired → OFF
    assert s._rain_state == 'OFF'


def test_frame_timestamp_does_not_drive_aging():
    """Passing widely-spaced frame timestamps must NOT age state when the
    wall-clock (now_ms) is held constant — proves ts_unix is not the clock."""
    s = _sampler()
    T = 5_000_000.0
    s._process_frame(1000, ON + 10, now_ms=T)
    s._process_frame(2000, ON + 10, now_ms=T)        # ON
    # ts_unix jumps 100000s (~27h) but wall-clock is unchanged → no expiry
    s._process_frame(102000, None, now_ms=T)
    assert s._rain_state == 'ON'


def test_last_valid_dbz_time_stored_as_wallclock_ms():
    s = _sampler()
    s._process_frame(0, ON + 10, now_ms=1_234_567.0)
    assert s._last_valid_dbz_time == 1_234_567.0
