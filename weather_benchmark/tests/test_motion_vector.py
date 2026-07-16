"""Unit tests for the v1.46.0 motion vector upgrade.

Pure-function tests (no network) for _best_shift and _refine_subcell —
the 9×9 / ±4-cell correlation that replaced the 5×5 / ±2 search which
saturated at ~53 km/h.
"""

from collector_lib.radar_sampler import _best_shift, _refine_subcell, RADAR_CFG

GRID = RADAR_CFG['MOTION_GRID']        # 9
MAX_SHIFT = RADAR_CFG['MOTION_MAX_SHIFT']  # 4


def _mask(cells, grid_size=GRID):
    m = [0] * (grid_size * grid_size)
    for x, y in cells:
        m[y * grid_size + x] = 1
    return m


def _translate(cells, tx, ty, grid_size=GRID):
    """Translate cells by (tx, ty), dropping any that leave the grid."""
    return [(x + tx, y + ty) for x, y in cells
            if 0 <= x + tx < grid_size and 0 <= y + ty < grid_size]


# A 5-cell plus-shaped blob near the west edge (room to move east by 4)
BLOB = [(1, 4), (2, 3), (2, 4), (2, 5), (3, 4)]


def test_recovers_small_shift():
    prev = _mask(BLOB)
    curr = _mask(_translate(BLOB, 1, 0))
    s = _best_shift(prev, curr, GRID, MAX_SHIFT)
    # Match condition prev[g+shift] == curr[g] ⇒ shift = -translation
    assert (s['dx'], s['dy']) == (-1, 0)
    assert s['score'] == len(BLOB)


def test_recovers_large_shift_beyond_old_limit():
    """Shifts of 3–4 cells were unreachable with the old ±2 search."""
    prev = _mask(BLOB)
    curr = _mask(_translate(BLOB, 4, 0))
    s = _best_shift(prev, curr, GRID, MAX_SHIFT)
    assert (s['dx'], s['dy']) == (-4, 0)
    assert s['score'] == len(BLOB)


def test_recovers_diagonal_shift():
    prev = _mask(BLOB)
    curr = _mask(_translate(BLOB, 3, 2))
    s = _best_shift(prev, curr, GRID, MAX_SHIFT)
    assert (s['dx'], s['dy']) == (-3, -2)


def test_no_overlap_scores_zero():
    prev = _mask([(0, 0)])
    curr = _mask([(8, 8)])
    s = _best_shift(prev, curr, GRID, MAX_SHIFT)
    assert s['score'] <= 1  # nothing meaningful to correlate


def test_refine_subcell_symmetric_peak_no_offset():
    """Symmetric neighbors around the peak → no fractional adjustment."""
    dim = 2 * MAX_SHIFT + 1
    scores = [0] * (dim * dim)
    cx = cy = MAX_SHIFT  # peak at shift (0, 0)
    scores[cy * dim + cx] = 10
    scores[cy * dim + cx - 1] = 6
    scores[cy * dim + cx + 1] = 6
    shift = {'dx': 0, 'dy': 0, 'score': 10, 'scores': scores, 'dim': dim}
    dx, dy = _refine_subcell(shift, MAX_SHIFT)
    assert dx == 0.0 and dy == 0.0


def test_refine_subcell_asymmetric_peak_leans_toward_higher_neighbor():
    dim = 2 * MAX_SHIFT + 1
    scores = [0] * (dim * dim)
    cx = cy = MAX_SHIFT
    scores[cy * dim + cx] = 10
    scores[cy * dim + cx - 1] = 8   # higher on the left
    scores[cy * dim + cx + 1] = 4
    shift = {'dx': 0, 'dy': 0, 'score': 10, 'scores': scores, 'dim': dim}
    dx, dy = _refine_subcell(shift, MAX_SHIFT)
    # fx = 0.5*(8-4)/(8-20+4) = -0.25 → leans left (toward the higher neighbor)
    assert abs(dx - (-0.25)) < 1e-9
    assert dy == 0.0


def test_refine_subcell_clamped_to_half_cell():
    dim = 2 * MAX_SHIFT + 1
    scores = [0] * (dim * dim)
    cx = cy = MAX_SHIFT
    scores[cy * dim + cx] = 10
    scores[cy * dim + cx - 1] = 10  # flat shoulder → big raw offset, must clamp
    scores[cy * dim + cx + 1] = 0
    shift = {'dx': 0, 'dy': 0, 'score': 10, 'scores': scores, 'dim': dim}
    dx, dy = _refine_subcell(shift, MAX_SHIFT)
    assert -0.5 <= dx <= 0.5
    assert -0.5 <= dy <= 0.5
