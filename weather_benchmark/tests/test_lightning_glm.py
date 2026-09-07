"""Parity + unit tests for the GOES GLM lightning port.

``summarize_lightning_buffer`` is train/serve-critical: it must classify a flash
buffer identically to ``summarizeLightningBuffer`` in src/services/lightning.js.
These tests pin the distance bands, the >=2-flash "approaching" rule, the trend
logic, and the buffer mechanics (dedup / prune) of the shared GlmFetcher.

Pure-function tests only — no network, no h5py required.
"""

import math

from collector_lib.lightning import (
    summarize_lightning_buffer, flash_miles, in_glm_coverage,
    extract_file_timestamp_ms, select_backfill_files, GlmFetcher,
    BACKFILL_MAX_FILES,
)

# Reference location (Denver-ish) and a fixed clock.
LAT, LON = 40.0, -105.0
NOW = 1_700_000_000_000.0   # epoch ms
MIN = 60_000.0


def _flash_north(miles_north, age_min):
    """A flash `miles_north` due north of (LAT,LON), `age_min` minutes old.
    Due north → distance == d_lat only (matches the equirectangular metric)."""
    return {
        'lat': LAT + miles_north / 69.0,
        'lon': LON,
        'timeMs': NOW - age_min * MIN,
        'energy': 1.0,
    }


# ── Distance helper ───────────────────────────────────────────────────────────

def test_flash_miles_due_north():
    f = _flash_north(20.0, 0)
    assert abs(flash_miles(LAT, LON, f['lat'], f['lon']) - 20.0) < 0.01


# ── State classification bands ────────────────────────────────────────────────

def test_active_within_10mi():
    buf = [_flash_north(6.9, 2)]
    s = summarize_lightning_buffer(buf, LAT, LON, NOW)
    assert s['state'] == 'active'
    assert s['confidence'] == 'high'
    assert s['source'] == 'lightning'
    assert s['flashCounts']['within10mi'] == 1
    assert s['nearestFlashMi'] == 7   # round(6.9)


def test_nearby_within_20mi():
    buf = [_flash_north(17.25, 5)]
    s = summarize_lightning_buffer(buf, LAT, LON, NOW)
    assert s['state'] == 'nearby'
    assert s['confidence'] == 'medium'
    assert s['flashCounts']['within10mi'] == 0
    assert s['flashCounts']['within20mi'] == 1
    assert s['nearestFlashMi'] == 17


def test_approaching_requires_two_flashes():
    # Two flashes in the 40mi/20min band, none closer → approaching.
    buf = [_flash_north(34.5, 8), _flash_north(34.5, 9)]
    s = summarize_lightning_buffer(buf, LAT, LON, NOW)
    assert s['state'] == 'approaching'
    assert s['flashCounts']['within40mi'] == 2


def test_single_distant_flash_does_not_promote():
    # A lone flash in the 40mi band must NOT latch "approaching".
    buf = [_flash_north(34.5, 8)]
    s = summarize_lightning_buffer(buf, LAT, LON, NOW)
    assert s['state'] == 'none'
    assert s['flashCounts']['within40mi'] == 1


def test_flash_beyond_45mi_ignored():
    buf = [_flash_north(48.0, 1)]
    s = summarize_lightning_buffer(buf, LAT, LON, NOW)
    assert s['state'] == 'none'
    assert s['flashCounts'] == {'within10mi': 0, 'within20mi': 0, 'within40mi': 0}
    assert s['nearestFlashMi'] is None


def test_band_time_windows_exclude_stale_flashes():
    # 12-min-old flash at 6.9 mi: outside the 10-min/10-mi window, but still
    # inside the 20-min/40-mi window → not 'active', counts toward within40mi.
    buf = [_flash_north(6.9, 12)]
    s = summarize_lightning_buffer(buf, LAT, LON, NOW)
    assert s['flashCounts']['within10mi'] == 0
    assert s['flashCounts']['within40mi'] == 1


# ── Trend logic ───────────────────────────────────────────────────────────────

def test_trend_rising():
    buf = [_flash_north(34.5, 2), _flash_north(34.5, 3), _flash_north(34.5, 4)]
    s = summarize_lightning_buffer(buf, LAT, LON, NOW)
    assert s['trend'] == 'rising'     # recent=3, prior=0


def test_trend_falling():
    buf = ([_flash_north(34.5, 12), _flash_north(34.5, 13),
            _flash_north(34.5, 14), _flash_north(34.5, 15)]   # prior=4
           + [_flash_north(34.5, 2)])                          # recent=1
    s = summarize_lightning_buffer(buf, LAT, LON, NOW)
    assert s['trend'] == 'falling'    # 1 < 4*0.5 and prior>=2


def test_trend_none_when_no_flashes_in_band():
    s = summarize_lightning_buffer([], LAT, LON, NOW)
    assert s['trend'] is None


# ── Source / coverage / connectivity flags ────────────────────────────────────

def test_empty_in_coverage_is_connected_none():
    s = summarize_lightning_buffer([], LAT, LON, NOW,
                                   in_coverage=True, last_poll_ok=True)
    assert s['state'] == 'none'
    assert s['source'] == 'none'       # in coverage, just no flashes
    assert s['connected'] is True
    assert s['provider'] == 'glm'


def test_empty_out_of_coverage_is_unavailable():
    s = summarize_lightning_buffer([], LAT, LON, NOW, in_coverage=False)
    assert s['source'] == 'unavailable'
    assert s['provider'] == 'none'


def test_buffer_age_from_last_flash():
    s = summarize_lightning_buffer([], LAT, LON, NOW,
                                   last_flash_at_ms=NOW - 5 * MIN)
    assert s['bufferAgeMs'] == 5 * MIN
    assert s['lastFlashAt'] is not None


def test_coverage_bounds():
    assert in_glm_coverage(40.0, -105.0) is True       # CONUS
    assert in_glm_coverage(51.5, -0.1) is False        # London — out
    assert in_glm_coverage(-60.0, -60.0) is False      # too far south


# ── Filename timestamp parsing ────────────────────────────────────────────────

def test_extract_file_timestamp():
    key = ('GLM-L2-LCFA/2026/179/16/'
           'OR_GLM-L2-LCFA_G19_s20261791604400_e20261791605000_c20261791605015.nc')
    ts = extract_file_timestamp_ms(key)
    # 2026, day-of-year 179, 16:04:40.0 UTC
    from datetime import datetime, timezone
    expected = datetime(2026, 1, 1, tzinfo=timezone.utc).timestamp() * 1000.0
    expected += (179 - 1) * 86400_000 + 16 * 3600_000 + 4 * 60_000 + 40_000
    assert abs(ts - expected) < 1.0


def test_extract_file_timestamp_bad_key():
    assert extract_file_timestamp_ms('not-a-glm-file.nc') is None


# ── GlmFetcher buffer mechanics (no network) ──────────────────────────────────

def test_fetcher_buffer_dedup():
    fx = GlmFetcher({})
    f = _flash_north(6.9, 1)
    fx._update_buffer([dict(f), dict(f)], NOW)   # same rounded key twice
    assert len(fx._buffer) == 1


def test_fetcher_buffer_prune_old():
    fx = GlmFetcher({})
    fx._update_buffer([_flash_north(6.9, 1), _flash_north(6.9, 35)], NOW)
    # 35-min-old flash is past the 30-min window (v0.9.5) → pruned on insert.
    assert len(fx._buffer) == 1
    assert all(f['timeMs'] >= NOW - 30 * MIN for f in fx._buffer)


def test_fetcher_rejects_future_flash():
    fx = GlmFetcher({})
    future = _flash_north(6.9, 0)
    future['timeMs'] = NOW + 5 * MIN
    fx._update_buffer([future], NOW)
    assert len(fx._buffer) == 0


def test_fetcher_summarize_out_of_coverage_short_circuits():
    fx = GlmFetcher({})
    s = fx.summarize(51.5, -0.1)   # London
    assert s['source'] == 'unavailable'


# ── Progressive backfill selection (v0.9.6) ──────────────────────────────────
# select_backfill_files mirrors the picked/bytes loop in _backfillOlderFiles()
# in src/services/lightning.js: newest-first within budget, oldest-first out.

def _key_at(minutes_ago, *, now_ms=NOW):
    """A GLM S3 key stamped `minutes_ago` minutes before NOW."""
    from datetime import datetime, timezone
    dt = datetime.fromtimestamp((now_ms - minutes_ago * MIN) / 1000.0,
                                tz=timezone.utc)
    doy = dt.timetuple().tm_yday
    stamp = f'{dt.year}{doy:03d}{dt.hour:02d}{dt.minute:02d}{dt.second:02d}0'
    return f'GLM-L2-LCFA/OR_GLM-L2-LCFA_G19_s{stamp}_e{stamp}_c{stamp}.nc'


def _entries(*minutes_ago, size=100_000):
    """(key, size) entries in chronological order (oldest first)."""
    return [(_key_at(m), size) for m in sorted(minutes_ago, reverse=True)]


def test_backfill_takes_only_files_older_than_current_coverage():
    entries = _entries(25, 20, 15, 8, 3)
    floor = NOW - 12 * MIN          # we already hold everything newer than 12 min
    picked = select_backfill_files(entries, floor)
    ages = [round((NOW - extract_file_timestamp_ms(k)) / MIN) for k, _ in picked]
    assert ages == [25, 20, 15]     # the 8- and 3-min files are already ours


def test_backfill_returns_chronological_order():
    picked = select_backfill_files(_entries(30, 25, 20), None)
    stamps = [extract_file_timestamp_ms(k) for k, _ in picked]
    assert stamps == sorted(stamps)


def test_backfill_respects_file_count_cap():
    entries = _entries(*range(1, BACKFILL_MAX_FILES + 20))
    picked = select_backfill_files(entries, None, budget_bytes=10 ** 12)
    assert len(picked) == BACKFILL_MAX_FILES
    # Keeps the NEWEST ones, so coverage stays contiguous with what we hold.
    newest = max(extract_file_timestamp_ms(k) for k, _ in entries)
    assert max(extract_file_timestamp_ms(k) for k, _ in picked) == newest


def test_backfill_respects_byte_budget():
    entries = _entries(30, 25, 20, 15, size=400_000)
    picked = select_backfill_files(entries, None, budget_bytes=1_000_000)
    assert len(picked) == 2                       # 3rd would exceed the budget
    assert sum(sz for _, sz in picked) <= 1_000_000
    # Budget truncation drops the OLDEST, never the newest.
    ages = [round((NOW - extract_file_timestamp_ms(k)) / MIN) for k, _ in picked]
    assert ages == [20, 15]


def test_backfill_empty_when_nothing_older():
    entries = _entries(5, 3)
    picked = select_backfill_files(entries, NOW - 10 * MIN)
    assert picked == []


def test_backfill_takes_everything_when_no_coverage_yet():
    entries = _entries(20, 10)
    assert len(select_backfill_files(entries, None)) == 2


def test_fetcher_tracks_oldest_ingest():
    fx = GlmFetcher({})
    assert fx._oldest_ingest_ms is None
    fx._note_ingest(_key_at(5))
    first = fx._oldest_ingest_ms
    fx._note_ingest(_key_at(2))       # newer file must not move the floor
    assert fx._oldest_ingest_ms == first
    fx._note_ingest(_key_at(20))      # older file does
    assert fx._oldest_ingest_ms < first


def test_fetcher_note_ingest_ignores_unparseable_key():
    fx = GlmFetcher({})
    fx._note_ingest('not-a-glm-file.nc')
    assert fx._oldest_ingest_ms is None
