#!/usr/bin/env python3
"""
A* pathfinding on a grid stored as a text file of 0s (open) and 1s (walls).

Input file : rows of 0/1, either space-separated ("0 1 0") or contiguous ("010").
Coordinates: (row, col), 0-indexed, origin at the top-left.
Output file: one "row,col" pair per line, from start to destination.

Usage:
    python astar_grid.py

Reads SPN.txt and coords.txt (next to this script) and writes the path to
path.txt. coords.txt holds two lines: start as row,col, then destination as
row,col. Movement is 8-directional (diagonals allowed,
no cutting between two diagonally touching walls).
"""

import heapq
import math
import os
import sys

SQRT2 = math.sqrt(2.0)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
INPUT_FILE = os.path.join(BASE_DIR, "nav_io", "SPN.txt")
COORDS_FILE = os.path.join(BASE_DIR, "nav_io", "coords.txt")
OUTPUT_FILE = os.path.join(BASE_DIR, "nav_io", "path.txt")
DIAGONAL = True
CUT_CORNERS = False


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
            tokens = line.split() if (" " in line or "," in line) else list(line)
            if "," in line:
                tokens = line.replace(",", " ").split()
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
# A*
# --------------------------------------------------------------------------- #
def astar(grid, start, goal, diagonal=DIAGONAL, cut_corners=CUT_CORNERS):
    """
    Return the list of (row, col) from start to goal, or None if unreachable.

    Efficiency notes:
      * The grid is flattened to a single list, and cells are addressed by an
        integer index, so there is no tuple hashing in the hot loop.
      * Open set is a binary heap; closed set and g-scores are flat arrays.
      * Stale heap entries are skipped (lazy deletion) instead of using
        decrease-key.
      * Heuristic is consistent (Manhattan for 4-way, octile for 8-way), so
        the first time a node is popped its path is optimal.
      * Ties on f are broken in favour of larger g (closer to goal), which
        greatly reduces expansions on open grids.
      * By default a diagonal move needs both adjacent orthogonal cells open.
        With cut_corners=True it only needs the diagonal target cell open.
    """
    rows, cols = len(grid), len(grid[0])
    flat = [cell for row in grid for cell in row]  # 0 open, 1 wall
    size = rows * cols

    s = start[0] * cols + start[1]
    g_idx = goal[0] * cols + goal[1]
    gr, gc = goal

    INF = float("inf")
    g_score = [INF] * size
    parent = [-1] * size
    closed = bytearray(size)

    def h(idx):
        dr = abs(idx // cols - gr)
        dc = abs(idx % cols - gc)
        if diagonal:
            return (dr + dc) + (SQRT2 - 2.0) * min(dr, dc)
        return dr + dc

    g_score[s] = 0.0
    # heap entries: (f, -g, index)
    heap = [(h(s), 0.0, s)]

    while heap:
        _, neg_g, cur = heapq.heappop(heap)
        if closed[cur]:
            continue
        closed[cur] = 1

        if cur == g_idx:
            path = []
            while cur != -1:
                path.append((cur // cols, cur % cols))
                cur = parent[cur]
            path.reverse()
            return path

        g_cur = g_score[cur]
        r, c = divmod(cur, cols)

        # 4-connected neighbours
        up = r > 0
        down = r < rows - 1
        left = c > 0
        right = c < cols - 1

        neighbours = []
        if up:
            neighbours.append((cur - cols, 1.0))
        if down:
            neighbours.append((cur + cols, 1.0))
        if left:
            neighbours.append((cur - 1, 1.0))
        if right:
            neighbours.append((cur + 1, 1.0))

        if diagonal:
            # diagonal moves; by default both orthogonal neighbours must be open
            def ok(a, b):
                return (not flat[a] and not flat[b]) if not cut_corners else True
            if up and left and ok(cur - cols, cur - 1):
                neighbours.append((cur - cols - 1, SQRT2))
            if up and right and ok(cur - cols, cur + 1):
                neighbours.append((cur - cols + 1, SQRT2))
            if down and left and ok(cur + cols, cur - 1):
                neighbours.append((cur + cols - 1, SQRT2))
            if down and right and ok(cur + cols, cur + 1):
                neighbours.append((cur + cols + 1, SQRT2))

        for nxt, cost in neighbours:
            if flat[nxt] or closed[nxt]:
                continue
            tentative = g_cur + cost
            if tentative < g_score[nxt]:
                g_score[nxt] = tentative
                parent[nxt] = cur
                heapq.heappush(heap, (tentative + h(nxt), -tentative, nxt))

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

    path = astar(grid, start, goal, diagonal=DIAGONAL, cut_corners=CUT_CORNERS)
    if path is None:
        sys.exit("No path exists between the start and destination.")

    with open(OUTPUT_FILE, "w") as f:
        for r, c in path:
            f.write(f"{r},{c}\n")
            grid[r][c] = 2

    print(f"Path found: {len(path)} cells. Written to {OUTPUT_FILE}")

    if "--no-plot" not in sys.argv:  # the app's /api/route passes --no-plot (no window to show on a server)
        import matplotlib.pyplot as plt  # only needed for this preview
        plt.matshow(grid)
        plt.show()

if __name__ == "__main__":
    main()