#!/usr/bin/env python3
"""
A* pathfinding on a grid stored as a text file of 0s (open) and 1s (walls),
with a clearance penalty that pulls paths toward the middle of hallways.

Input file : rows of 0/1, either space-separated ("0 1 0") or contiguous ("010").
Coordinates: (row, col), 0-indexed, origin at the top-left.
Output file: one "row,col" pair per line, from start to destination.

Usage:
    pip install -r scripts/requirements.txt
    python scripts/navigation.py [--plot]

Reads public/data/SPN-level1.txt (the level 1 grid the app routes on) and
nav_io/coords.txt (next to this script) and writes the path to
nav_io/path.txt. --plot shows the path on the grid (needs matplotlib). coords.txt holds two lines: start as row,col, then
destination as row,col. Movement is 8-directional (diagonals allowed, no
cutting between two diagonally touching walls).
"""

import heapq
import math
import os
import sys

import numpy as np

try:
    from scipy.ndimage import distance_transform_edt
except ImportError:  # pure-Python fallback is used instead (slower)
    distance_transform_edt = None

SQRT2 = math.sqrt(2.0)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
INPUT_FILE = os.path.join(BASE_DIR, "..", "public", "data", "SPN-level1.txt")  # the same grid the app routes on
COORDS_FILE = os.path.join(BASE_DIR, "nav_io", "coords.txt")
OUTPUT_FILE = os.path.join(BASE_DIR, "nav_io", "path.txt")
DIAGONAL = True
CUT_CORNERS = False

# Hallway centering
CLEARANCE_RADIUS = 6     # cells; ~half of an 11-wide hallway
WALL_WEIGHT = 2.0        # penalty strength next to a wall (0 disables centering)

# Heuristic inflation. 1.0 = optimal paths. Values like 1.2-2.0 search much
# faster (fewer expansions) at the cost of slightly suboptimal paths.
H_WEIGHT = 1.5

# Straight-line smoothing (any-angle shortcuts applied after A*)
SMOOTH_PATH = True
STRAIGHT_MIN_CLEARANCE = 3.0   # a shortcut must stay at least this far from walls
STRAIGHT_SLACK = 2.0           # a shortcut may cost up to this x the penalised
                               # cost of the A* stretch it replaces (1.0 = only
                               # free straightening; higher = straighter lines)
SMOOTH_FAIL_WINDOW = 25        # stop looking ahead after this many failed shortcuts

SHOW_PLOT = "--plot" in sys.argv[1:]  # off by default so the script runs without matplotlib or a window


# --------------------------------------------------------------------------- #
# Loading
# --------------------------------------------------------------------------- #
def load_grid(path):
    """Read the file into a 2D list of ints (0 = open, 1 = wall)."""
    grid = []
    with open(path, "r") as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            if "," in line:
                tokens = line.replace(",", " ").split()
            elif " " in line:
                tokens = line.split()
            else:
                tokens = list(line)
            try:
                row = [int(t) for t in tokens]
            except ValueError:
                sys.exit(f"Line {line_no}: non-numeric value found.")
            if any(v not in (0, 1) for v in row):
                sys.exit(f"Line {line_no}: only 0 and 1 are allowed.")
            grid.append(row)

    if not grid:
        sys.exit("Input file is empty.")
    width = len(grid[0])
    if any(len(r) != width for r in grid):
        sys.exit("Rows have inconsistent lengths.")
    return grid


# --------------------------------------------------------------------------- #
# Clearance (distance to nearest wall)
# --------------------------------------------------------------------------- #
def _chamfer_clearance(wall, H, W):
    """Pure-Python 8-way chamfer distance on a padded flat grid (fallback)."""
    INF = 1e9
    d = [0.0 if w else INF for w in wall]
    for r in range(1, H - 1):
        base = r * W
        for i in range(base + 1, base + W - 1):
            if wall[i]:
                continue
            best = d[i]
            v = d[i - 1] + 1.0
            if v < best: best = v
            v = d[i - W] + 1.0
            if v < best: best = v
            v = d[i - W - 1] + SQRT2
            if v < best: best = v
            v = d[i - W + 1] + SQRT2
            if v < best: best = v
            d[i] = best
    for r in range(H - 2, 0, -1):
        base = r * W
        for i in range(base + W - 2, base, -1):
            if wall[i]:
                continue
            best = d[i]
            v = d[i + 1] + 1.0
            if v < best: best = v
            v = d[i + W] + 1.0
            if v < best: best = v
            v = d[i + W + 1] + SQRT2
            if v < best: best = v
            v = d[i + W - 1] + SQRT2
            if v < best: best = v
            d[i] = best
    return d


def clearance(padded):
    """Distance from every cell of a padded grid to the nearest wall (border = wall)."""
    H, W = padded.shape
    if distance_transform_edt is not None:
        return distance_transform_edt(padded == 0)
    flat = padded.ravel().tolist()
    return np.array(_chamfer_clearance(flat, H, W)).reshape(H, W)


def step_multipliers(dist):
    """
    Per-cell cost multiplier (>= 1.0) from the clearance map: 1.0 at/after
    CLEARANCE_RADIUS from any wall, rising quadratically to 1 + WALL_WEIGHT
    right next to a wall.
    """
    if WALL_WEIGHT <= 0 or CLEARANCE_RADIUS <= 0:
        return np.ones_like(dist)
    t = np.clip((CLEARANCE_RADIUS - dist) / CLEARANCE_RADIUS, 0.0, 1.0)
    return 1.0 + WALL_WEIGHT * t * t


def straighten(pts, dist, mult, wall, cut_corners):
    """
    Greedy any-angle shortcutting ("string pulling") of an 8-connected path.

    pts: (n, 2) int array of padded (row, col). A shortcut from a to b is taken
    when the straight (DDA) line between them
      * stays >= STRAIGHT_MIN_CLEARANCE from every wall (relaxed to the
        endpoints' own clearance if they are already closer),
      * does not squeeze diagonally between two walls, and
      * costs <= STRAIGHT_SLACK x the penalised cost of the stretch it replaces.
    Returns the straightened path rasterised back to contiguous cells.
    """
    n = len(pts)
    if n < 3:
        return pts

    # cumulative penalised cost along the A* path
    d = np.diff(pts, axis=0)
    lens = np.where((d[:, 0] != 0) & (d[:, 1] != 0), SQRT2, 1.0)
    cum = np.concatenate(([0.0], np.cumsum(lens * mult[pts[1:, 0], pts[1:, 1]])))

    def line(a, b):
        r0, c0 = pts[a]
        r1, c1 = pts[b]
        m = max(abs(r1 - r0), abs(c1 - c0))
        t = np.arange(m + 1) / m
        return (np.rint(r0 + (r1 - r0) * t).astype(np.intp),
                np.rint(c0 + (c1 - c0) * t).astype(np.intp))

    def visible(a, b):
        rs, cs = line(a, b)
        thr = min(STRAIGHT_MIN_CLEARANCE, dist[rs[0], cs[0]], dist[rs[-1], cs[-1]])
        if dist[rs, cs].min() < thr:
            return False
        dr = rs[1:] - rs[:-1]
        dc = cs[1:] - cs[:-1]
        diag = (dr != 0) & (dc != 0)
        if not cut_corners and diag.any():
            if wall[rs[:-1][diag], cs[1:][diag]].any() or wall[rs[1:][diag], cs[:-1][diag]].any():
                return False
        chord = (np.where(diag, SQRT2, 1.0) * mult[rs[1:], cs[1:]]).sum()
        return chord <= STRAIGHT_SLACK * (cum[b] - cum[a])

    keep = [0]
    anchor = 0
    while anchor < n - 1:
        best = anchor + 1
        fails = 0
        j = anchor + 2
        while j < n and fails < SMOOTH_FAIL_WINDOW:
            if visible(anchor, j):
                best, fails = j, 0
            else:
                fails += 1
            j += 1
        keep.append(best)
        anchor = best

    # rasterise the chords back into a contiguous cell path
    out_r, out_c = [pts[0, 0:1]], [pts[0, 1:2]]
    for a, b in zip(keep[:-1], keep[1:]):
        rs, cs = line(a, b)
        out_r.append(rs[1:])
        out_c.append(cs[1:])
    return np.stack((np.concatenate(out_r), np.concatenate(out_c)), axis=1)


# --------------------------------------------------------------------------- #
# A*
# --------------------------------------------------------------------------- #
def astar(grid, start, goal, diagonal=DIAGONAL, cut_corners=CUT_CORNERS,
          smooth=SMOOTH_PATH):
    """
    Return the list of (row, col) from start to goal, or None if unreachable.

    Performance notes:
      * The grid is padded with a 1-cell wall border and flattened, so every
        neighbour is just `cur + offset` with no bounds checks.
      * Walls are pre-marked in the `closed` bytearray, so a single lookup
        rejects both walls and already-expanded cells.
      * Heuristic values and wall-clearance multipliers are computed once with
        vectorised numpy (SciPy EDT when available) and stored in flat lists.
      * Open set is a binary heap with lazy deletion; ties on f favour larger g.
      * After the search, straighten() replaces curved stretches with straight
        any-angle segments when they stay clear of walls (see constants).
      * The heuristic (octile / Manhattan) never overestimates because every
        step multiplier is >= 1, so with H_WEIGHT = 1 paths remain optimal for
        the penalised cost.
    """
    arr = np.asarray(grid, dtype=np.uint8)
    rows, cols = arr.shape
    padded = np.pad(arr, 1, constant_values=1)
    H, W = padded.shape

    wall = bytearray(padded.ravel().tobytes())      # 1 = wall (never modified)
    closed = bytearray(wall)                        # walls start as "closed"
    dist = clearance(padded)
    mult_arr = step_multipliers(dist)
    mult = mult_arr.ravel().tolist()

    s = (start[0] + 1) * W + start[1] + 1
    goal_idx = (goal[0] + 1) * W + goal[1] + 1

    # Vectorised heuristic over the whole padded grid
    rr, cc = np.indices((H, W))
    dr = np.abs(rr - (goal[0] + 1))
    dc = np.abs(cc - (goal[1] + 1))
    if diagonal:
        hv = (dr + dc) + (SQRT2 - 2.0) * np.minimum(dr, dc)
    else:
        hv = dr + dc
    h = (hv * H_WEIGHT).ravel().tolist()

    INF = float("inf")
    g_score = [INF] * (H * W)
    parent = [-1] * (H * W)
    g_score[s] = 0.0

    orth = (-W, W, -1, 1)
    diag = ((-W - 1, -W, -1), (-W + 1, -W, 1), (W - 1, W, -1), (W + 1, W, 1))

    heappush = heapq.heappush
    heappop = heapq.heappop
    heap = [(h[s], 0.0, s)]

    while heap:
        cur = heappop(heap)[2]
        if closed[cur]:
            continue
        closed[cur] = 1

        if cur == goal_idx:
            idx = []
            while cur != -1:
                idx.append(cur)
                cur = parent[cur]
            idx.reverse()
            pts = np.array([divmod(i, W) for i in idx], dtype=np.intp)
            if smooth and diagonal:
                pts = straighten(pts, dist, mult_arr, padded, cut_corners)
            return [(int(r) - 1, int(c) - 1) for r, c in pts]

        g_cur = g_score[cur]

        for off in orth:
            nxt = cur + off
            if closed[nxt]:
                continue
            t = g_cur + mult[nxt]
            if t < g_score[nxt]:
                g_score[nxt] = t
                parent[nxt] = cur
                heappush(heap, (t + h[nxt], -t, nxt))

        if diagonal:
            for off, a, b in diag:
                nxt = cur + off
                if closed[nxt]:
                    continue
                if not cut_corners and (wall[cur + a] or wall[cur + b]):
                    continue
                t = g_cur + SQRT2 * mult[nxt]
                if t < g_score[nxt]:
                    g_score[nxt] = t
                    parent[nxt] = cur
                    heappush(heap, (t + h[nxt], -t, nxt))

    return None


# --------------------------------------------------------------------------- #
# Input helpers
# --------------------------------------------------------------------------- #
def parse_coord(text):
    parts = text.replace(",", " ").split()
    if len(parts) != 2:
        raise ValueError("Enter two integers, e.g. 10,25")
    return int(parts[0]), int(parts[1])


def validate(grid, coord, label):
    r, c = coord
    rows, cols = len(grid), len(grid[0])
    if not (0 <= r < rows and 0 <= c < cols):
        raise ValueError(f"{label} {coord} is outside the grid "
                         f"(rows 0-{rows - 1}, cols 0-{cols - 1}).")
    if grid[r][c] == 1:
        raise ValueError(f"{label} {coord} is a wall.")


def load_coords(path, grid):
    """Read start (line 1) and destination (line 2) from a file of 'row,col' lines."""
    try:
        with open(path, "r") as f:
            lines = [ln.strip() for ln in f if ln.strip()]
    except FileNotFoundError:
        sys.exit(f"Coordinates file not found: {path}")
    if len(lines) < 2:
        sys.exit("Coordinates file needs two lines: start (row,col) then destination (row,col).")
    try:
        start = parse_coord(lines[0])
        goal = parse_coord(lines[1])
        validate(grid, start, "start")
        validate(grid, goal, "destination")
    except ValueError as e:
        sys.exit(f"Coordinates file error: {e}")
    return start, goal


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def main():
    grid = load_grid(INPUT_FILE)
    print(f"Loaded grid: {len(grid)} rows x {len(grid[0])} cols")

    start, goal = load_coords(COORDS_FILE, grid)
    print(f"Start: {start}  Destination: {goal}")

    path = astar(grid, start, goal)
    if path is None:
        sys.exit("No path exists between the start and destination.")

    with open(OUTPUT_FILE, "w") as f:
        f.write("".join(f"{r},{c}\n" for r, c in path))
    print(f"Path found: {len(path)} cells. Written to {OUTPUT_FILE}")

    if SHOW_PLOT:
        import matplotlib.pyplot as plt  # lazy import: slow, only needed here
        for r, c in path:
            grid[r][c] = 2
        plt.matshow(grid)
        plt.show()


if __name__ == "__main__":
    main()