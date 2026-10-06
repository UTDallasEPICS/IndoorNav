import os
import re
import gc
import math
import heapq
import time
from collections import deque

heappush, heappop = heapq.heappush, heapq.heappop

def load_grid(filename="SPN.txt"):
    # Resolve relative to this script so it works no matter where VS Code runs from
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), filename)
    # Each line is a row of space-separated integers, so split on whitespace
    # (this also handles trailing spaces and Windows \r\n line endings)
    with open(path) as f:
        return [[int(tok) for tok in line.split()] for line in f if line.strip()]

def load_coordinates(filename="coordinates.txt"):
    # Lines look like "(284, 367)"; returns [(x, y), ...] in file order
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), filename)
    with open(path) as f:
        return [(int(x), int(y)) for x, y in re.findall(r"\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)", f.read())]

grid = load_grid()

# The whole SPN grid is searched (the old 99x99 window is gone, since the
# coordinates reach well past it).
ROW = len(grid)
COL = len(grid[0])

# Cell values in SPN.txt: 0 = open space, 1 = wall
OPEN = 0
WALL = 1

# In SPN.txt, 0 = open space and 1 = wall.
OPEN = 0
WALL = 1

class Cell:
    def __init__(self):
      # Parent cell's row index
        self.parent_i = 0
    # Parent cell's column index
        self.parent_j = 0
 # Total cost of the cell (g + h)
        self.f = float('inf')
    # Cost from start to this cell
        self.g = float('inf')
    # Heuristic cost from this cell to destination
        self.h = 0

def is_valid(row, col):
    return (row >= 0) and (row < ROW) and (col >= 0) and (col < COL)

def is_unblocked(grid, row, col):
    return grid[row][col] == OPEN

def is_destination(row, col, dest):
    return row == dest[0] and col == dest[1]

def calculate_h_value(row, col, dest):
    return ((row - dest[0]) ** 2 + (col - dest[1]) ** 2) ** 0.5


# ---------------------------------------------------------------------------
# A* (original, kept as-is for reference)
# ---------------------------------------------------------------------------
def trace_path(cell_details, dest):
    # Returns the path without printing or writing into the shared grid.
    path = []
    row = dest[0]
    col = dest[1]

    # Trace the path from destination to source using parent cells
    while not (cell_details[row][col].parent_i == row and cell_details[row][col].parent_j == col):
        path.append((row, col))
        temp_row = cell_details[row][col].parent_i
        temp_col = cell_details[row][col].parent_j
        row = temp_row
        col = temp_col

    # Add the source cell to the path
    path.append((row, col))
    # Reverse the path to get the path from source to destination
    path.reverse()
    return path

def a_star_search(grid, src, dest):
    # Check if the source and destination are valid
    if not is_valid(src[0], src[1]) or not is_valid(dest[0], dest[1]):
        return None

    # Check if the source and destination are unblocked
    if not is_unblocked(grid, src[0], src[1]) or not is_unblocked(grid, dest[0], dest[1]):
        return None

    # Check if we are already at the destination
    if is_destination(src[0], src[1], dest):
        return [(src[0], src[1])]

    # Initialize the closed list (visited cells)
    closed_list = [[False for _ in range(COL)] for _ in range(ROW)]
    # Initialize the details of each cell
    cell_details = [[Cell() for _ in range(COL)] for _ in range(ROW)]

    # Initialize the start cell details
    i = src[0]
    j = src[1]
    cell_details[i][j].f = 0
    cell_details[i][j].g = 0
    cell_details[i][j].h = 0
    cell_details[i][j].parent_i = i
    cell_details[i][j].parent_j = j

    # Initialize the open list (cells to be visited) with the start cell
    open_list = []
    heapq.heappush(open_list, (0.0, i, j))

    # Main loop of A* search algorithm
    while len(open_list) > 0:
        # Pop the cell with the smallest f value from the open list
        p = heapq.heappop(open_list)

        # Mark the cell as visited
        i = p[1]
        j = p[2]
        closed_list[i][j] = True

        # For each direction, check the successor
        directions = [(0, 1), (0, -1), (1, 0), (-1, 0)]

        for dir in directions:
            new_i = i + dir[0]
            new_j = j + dir[1]

            # If the successor is valid, unblocked, and not visited
            if is_valid(new_i, new_j) and is_unblocked(grid, new_i, new_j) and not closed_list[new_i][new_j]:
                # If the successor is the destination
                if is_destination(new_i, new_j, dest):
                    # Set the parent of the destination cell
                    cell_details[new_i][new_j].parent_i = i
                    cell_details[new_i][new_j].parent_j = j
                    return trace_path(cell_details, dest)
                else:
                    # Calculate the new f, g, and h values
                    g_new = cell_details[i][j].g + 1.0
                    h_new = calculate_h_value(new_i, new_j, dest)
                    f_new = g_new + h_new

                    # If the cell is not in the open list or the new f value is smaller
                    if cell_details[new_i][new_j].f == float('inf') or cell_details[new_i][new_j].f > f_new:
                        # Add the cell to the open list
                        heapq.heappush(open_list, (f_new, new_i, new_j))
                        # Update the cell details
                        cell_details[new_i][new_j].f = f_new
                        cell_details[new_i][new_j].g = g_new
                        cell_details[new_i][new_j].h = h_new
                        cell_details[new_i][new_j].parent_i = i
                        cell_details[new_i][new_j].parent_j = j

    # If the destination is not found after visiting all cells
    return None


# ---------------------------------------------------------------------------
# Shared helpers for the new algorithms
# ---------------------------------------------------------------------------
DIRS = ((-1, 0), (1, 0), (0, -1), (0, 1))  # up, down, left, right
INF = 1 << 30

def _usable(grid, src, dest):
    return (is_valid(src[0], src[1]) and is_valid(dest[0], dest[1])
            and grid[src[0]][src[1]] == OPEN and grid[dest[0]][dest[1]] == OPEN)

def _path_from_parents(parent, src, dest):
    path = [dest]
    cur = dest
    while cur != src:
        cur = parent[cur[0]][cur[1]]
        path.append(cur)
    path.reverse()
    return path


# ---------------------------------------------------------------------------
# Breadth-first search: explores cell by cell in rings; always shortest.
# ---------------------------------------------------------------------------
def bfs_search(grid, src, dest):
    src = (src[0], src[1]); dest = (dest[0], dest[1])
    if not _usable(grid, src, dest):
        return None
    if src == dest:
        return [src]
    parent = [[None] * COL for _ in range(ROW)]
    parent[src[0]][src[1]] = src
    queue = deque([src])
    while queue:
        r, c = queue.popleft()
        for dr, dc in DIRS:
            nr = r + dr; nc = c + dc
            if 0 <= nr < ROW and 0 <= nc < COL and grid[nr][nc] == OPEN and parent[nr][nc] is None:
                parent[nr][nc] = (r, c)
                if nr == dest[0] and nc == dest[1]:
                    return _path_from_parents(parent, src, dest)
                queue.append((nr, nc))
    return None


# ---------------------------------------------------------------------------
# Depth-first search: very little work per cell, but the path it finds is
# not necessarily the shortest when the grid has loops.
# ---------------------------------------------------------------------------
def dfs_search(grid, src, dest):
    src = (src[0], src[1]); dest = (dest[0], dest[1])
    if not _usable(grid, src, dest):
        return None
    if src == dest:
        return [src]
    parent = [[None] * COL for _ in range(ROW)]
    parent[src[0]][src[1]] = src
    stack = [src]
    while stack:
        r, c = stack.pop()
        for dr, dc in DIRS:
            nr = r + dr; nc = c + dc
            if 0 <= nr < ROW and 0 <= nc < COL and grid[nr][nc] == OPEN and parent[nr][nc] is None:
                parent[nr][nc] = (r, c)
                if nr == dest[0] and nc == dest[1]:
                    return _path_from_parents(parent, src, dest)
                stack.append((nr, nc))
    return None


# ---------------------------------------------------------------------------
# Greedy best-first: always expands the cell closest to the goal by
# Manhattan distance. Fast when the goal is "straight ahead", not optimal.
# ---------------------------------------------------------------------------
def greedy_best_first(grid, src, dest):
    src = (src[0], src[1]); dest = (dest[0], dest[1])
    if not _usable(grid, src, dest):
        return None
    if src == dest:
        return [src]
    tr, tc = dest
    parent = [[None] * COL for _ in range(ROW)]
    parent[src[0]][src[1]] = src
    heap = [(abs(src[0] - tr) + abs(src[1] - tc), src[0], src[1])]
    while heap:
        _, r, c = heappop(heap)
        for dr, dc in DIRS:
            nr = r + dr; nc = c + dc
            if 0 <= nr < ROW and 0 <= nc < COL and grid[nr][nc] == OPEN and parent[nr][nc] is None:
                parent[nr][nc] = (r, c)
                if nr == tr and nc == tc:
                    return _path_from_parents(parent, src, dest)
                heappush(heap, (abs(nr - tr) + abs(nc - tc), nr, nc))
    return None


# ---------------------------------------------------------------------------
# A* (optimized): Manhattan heuristic (exact for 4-direction moves), plain
# lists instead of Cell objects, and stops when the goal is *popped*, which
# is what guarantees the shortest path.
# ---------------------------------------------------------------------------
def a_star_optimized(grid, src, dest):
    src = (src[0], src[1]); dest = (dest[0], dest[1])
    if not _usable(grid, src, dest):
        return None
    if src == dest:
        return [src]
    tr, tc = dest
    g = [[INF] * COL for _ in range(ROW)]
    parent = [[None] * COL for _ in range(ROW)]
    g[src[0]][src[1]] = 0
    parent[src[0]][src[1]] = src
    h0 = abs(src[0] - tr) + abs(src[1] - tc)
    heap = [(h0, h0, src[0], src[1])]          # (f, h, row, col)
    while heap:
        f, h, r, c = heappop(heap)
        gr = g[r][c]
        if f - h > gr:                          # stale heap entry
            continue
        if r == tr and c == tc:
            return _path_from_parents(parent, src, dest)
        ng = gr + 1
        for dr, dc in DIRS:
            nr = r + dr; nc = c + dc
            if 0 <= nr < ROW and 0 <= nc < COL and grid[nr][nc] == OPEN and ng < g[nr][nc]:
                g[nr][nc] = ng
                parent[nr][nc] = (r, c)
                nh = abs(nr - tr) + abs(nc - tc)
                heappush(heap, (ng + nh, nh, nr, nc))
    return None


# ---------------------------------------------------------------------------
# Bidirectional BFS: grows rings from both ends (always expanding the smaller
# frontier) and stops when they touch. Shortest path, far fewer cells explored
# than one-sided BFS.
# ---------------------------------------------------------------------------
def _walk_back(dist, r, c):
    """Cells from (r, c) back to the search origin, following distance - 1."""
    out = [(r, c)]
    d = dist[r][c]
    while d > 0:
        for dr, dc in DIRS:
            nr = r + dr; nc = c + dc
            if 0 <= nr < ROW and 0 <= nc < COL and dist[nr][nc] == d - 1:
                r, c = nr, nc
                break
        out.append((r, c))
        d -= 1
    return out

def _join(df, db, u, v):
    """u was reached from src (df), v from dest (db), and u, v are adjacent."""
    first = _walk_back(df, u[0], u[1])
    first.reverse()
    return first + _walk_back(db, v[0], v[1])

def bidirectional_bfs(grid, src, dest):
    src = (src[0], src[1]); dest = (dest[0], dest[1])
    if not _usable(grid, src, dest):
        return None
    if src == dest:
        return [src]
    df = [[-1] * COL for _ in range(ROW)]
    db = [[-1] * COL for _ in range(ROW)]
    df[src[0]][src[1]] = 0
    db[dest[0]][dest[1]] = 0
    front_f = [src]
    front_b = [dest]
    while front_f and front_b:
        forward = len(front_f) <= len(front_b)
        if forward:
            mine, other, frontier = df, db, front_f
        else:
            mine, other, frontier = db, df, front_b
        nxt = []
        for r, c in frontier:
            d = mine[r][c] + 1
            for dr, dc in DIRS:
                nr = r + dr; nc = c + dc
                if 0 <= nr < ROW and 0 <= nc < COL and grid[nr][nc] == OPEN:
                    if other[nr][nc] != -1:     # the two searches have met
                        if forward:
                            return _join(df, db, (r, c), (nr, nc))
                        return _join(df, db, (nr, nc), (r, c))
                    if mine[nr][nc] == -1:
                        mine[nr][nc] = d
                        nxt.append((nr, nc))
        if forward:
            front_f = nxt
        else:
            front_b = nxt
    return None


# ---------------------------------------------------------------------------
# Incremental line search: grows straight lines one cell at a time; cells with
# an opening to the side become branch points that are expanded in FIFO order.
# Very little queue work, but in grids with loops the path it finds is valid
# without always being the shortest.
# ---------------------------------------------------------------------------
def line_search(grid, src, dest):
    src = (src[0], src[1]); dest = (dest[0], dest[1])
    if not _usable(grid, src, dest):
        return None
    if src == dest:
        return [src]
    parent = [[None] * COL for _ in range(ROW)]
    parent[src[0]][src[1]] = src
    queue = deque([src])          # branch points waiting to grow new lines
    while queue:
        r0, c0 = queue.popleft()
        for dr, dc in DIRS:
            r, c = r0, c0
            while True:           # extend this line one cell at a time
                nr = r + dr; nc = c + dc
                if not (0 <= nr < ROW and 0 <= nc < COL) or grid[nr][nc] != OPEN or parent[nr][nc] is not None:
                    break
                parent[nr][nc] = (r, c)
                r, c = nr, nc
                if r == dest[0] and c == dest[1]:
                    return _path_from_parents(parent, src, dest)
                if dr == 0:
                    side = (r > 0 and grid[r - 1][c] == OPEN) or (r < ROW - 1 and grid[r + 1][c] == OPEN)
                else:
                    side = (c > 0 and grid[r][c - 1] == OPEN) or (c < COL - 1 and grid[r][c + 1] == OPEN)
                if side:
                    queue.append((r, c))
    return None


# ---------------------------------------------------------------------------
# Distance-ordered line search: same line-growing idea, but branch points are
# taken from a priority queue ordered by distance (Dijkstra over the junctions
# of the maze). This makes it always find the shortest path.
# ---------------------------------------------------------------------------
def line_search_optimal(grid, src, dest):
    src = (src[0], src[1]); dest = (dest[0], dest[1])
    if not _usable(grid, src, dest):
        return None
    if src == dest:
        return [src]
    tr, tc = dest
    dist = [[INF] * COL for _ in range(ROW)]
    parent = [[None] * COL for _ in range(ROW)]
    dist[src[0]][src[1]] = 0
    parent[src[0]][src[1]] = src
    heap = [(0, src[0], src[1])]
    while heap:
        d, r0, c0 = heappop(heap)
        if d > dist[r0][c0]:                    # stale entry
            continue
        if d >= dist[tr][tc]:                   # nothing left can improve the goal
            break
        for dr, dc in DIRS:
            r, c = r0, c0
            nd = d
            while True:
                nr = r + dr; nc = c + dc
                if not (0 <= nr < ROW and 0 <= nc < COL) or grid[nr][nc] != OPEN:
                    break
                nd += 1
                if nd >= dist[nr][nc]:          # already reached at least as cheaply
                    break
                dist[nr][nc] = nd
                parent[nr][nc] = (r, c)
                r, c = nr, nc
                if dr == 0:
                    side = (r > 0 and grid[r - 1][c] == OPEN) or (r < ROW - 1 and grid[r + 1][c] == OPEN)
                else:
                    side = (c > 0 and grid[r][c - 1] == OPEN) or (c < COL - 1 and grid[r][c + 1] == OPEN)
                if side:
                    heappush(heap, (nd, r, c))
    if dist[tr][tc] == INF:
        return None
    return _path_from_parents(parent, src, dest)


# ---------------------------------------------------------------------------
# Reference: one BFS from the start cell over the whole window. This is the
# ground truth for reachability and shortest length, and also the "precomputed
# tree" contender (build once, then each query just follows parent pointers).
# ---------------------------------------------------------------------------
def bfs_tree(grid, src):
    parent = [[None] * COL for _ in range(ROW)]
    dist = [[-1] * COL for _ in range(ROW)]
    parent[src[0]][src[1]] = src
    dist[src[0]][src[1]] = 0
    queue = deque([src])
    while queue:
        r, c = queue.popleft()
        for dr, dc in DIRS:
            nr = r + dr; nc = c + dc
            if 0 <= nr < ROW and 0 <= nc < COL and grid[nr][nc] == OPEN and dist[nr][nc] == -1:
                dist[nr][nc] = dist[r][c] + 1
                parent[nr][nc] = (r, c)
                queue.append((nr, nc))
    return parent, dist

def make_tree_lookup(parent):
    def lookup(grid, src, dest):
        if parent[dest[0]][dest[1]] is None:
            return None
        return _path_from_parents(parent, src, dest)
    return lookup


# ---------------------------------------------------------------------------
# Turning coordinates.txt into start/end cells
# ---------------------------------------------------------------------------
# Each (x, y) is read as x = column, y = row (the x values reach 607, which
# only fits the grid's width). The points sit a few cells off the open corridors
# (0s), so each one is snapped to the nearest open cell by Manhattan distance;
# a tie goes to the cell in the larger connected region.
def label_components(grid):
    comp = [[-1] * COL for _ in range(ROW)]
    size = []
    for r in range(ROW):
        for c in range(COL):
            if grid[r][c] == OPEN and comp[r][c] == -1:
                cid = len(size)
                comp[r][c] = cid
                stack = [(r, c)]
                n = 0
                while stack:
                    a, b = stack.pop()
                    n += 1
                    for dr, dc in DIRS:
                        na = a + dr; nb = b + dc
                        if 0 <= na < ROW and 0 <= nb < COL and grid[na][nb] == OPEN and comp[na][nb] == -1:
                            comp[na][nb] = cid
                            stack.append((na, nb))
                size.append(n)
    return comp, size

def snap_to_open(grid, x, y, comp, size, max_radius=50):
    r0, c0 = y, x
    for d in range(max_radius + 1):
        best = None
        for dr in range(-d, d + 1):
            dc = d - abs(dr)
            for c in {c0 - dc, c0 + dc}:
                r = r0 + dr
                if 0 <= r < ROW and 0 <= c < COL and grid[r][c] == OPEN:
                    key = (-size[comp[r][c]], r, c)
                    if best is None or key < best:
                        best = key
        if best is not None:
            return (best[1], best[2]), d
    raise ValueError(f"No open cell within {max_radius} cells of ({x}, {y})")


# ---------------------------------------------------------------------------
# Benchmark harness
# ---------------------------------------------------------------------------
ALGORITHMS = [
    ("BFS", bfs_search),
    ("DFS", dfs_search),
    ("Greedy best-first", greedy_best_first),
    ("A* (optimized)", a_star_optimized),
    ("Bidirectional BFS", bidirectional_bfs),
    ("Line search", line_search),
    ("Line search (optimal)", line_search_optimal),
]
TREE_NAME = "BFS tree lookup*"

def is_valid_path(g, path, src, dest):
    if path[0] != src or path[-1] != dest:
        return False
    for (r1, c1), (r2, c2) in zip(path, path[1:]):
        if abs(r1 - r2) + abs(c1 - c2) != 1 or g[r2][c2] != OPEN:
            return False
    return True

def new_stats():
    return {"time": 0.0, "runs": 0, "missed": 0, "invalid": 0, "suboptimal": 0}

def benchmark_routes(grid, points):
    """Time every algorithm on every ordered pair of points (a -> b, a != b)."""
    contender_names = [n for n, _ in ALGORITHMS] + [TREE_NAME]
    stats = {name: new_stats() for name in contender_names}
    build_total = 0.0
    reachable = unreachable = same_cell = 0
    k = 0

    for src in points:
        # One BFS from this start point: ground truth for every destination,
        # and the tree the "BFS tree lookup" contender follows.
        t0 = time.perf_counter()
        parent, dist = bfs_tree(grid, src)
        build_total += time.perf_counter() - t0
        contenders = list(ALGORITHMS) + [(TREE_NAME, make_tree_lookup(parent))]

        for dest in points:
            if dest == src:
                same_cell += 1
                continue
            ref = dist[dest[0]][dest[1]]      # true shortest length in steps (-1 = unreachable)
            if ref == -1:
                unreachable += 1              # no route exists, so there is nothing to time
                continue
            reachable += 1

            # Rotate the run order each time so no algorithm always goes first
            shift = k % len(contenders)
            k += 1
            order = contenders[shift:] + contenders[:shift]

            for name, fn in order:
                start = time.perf_counter()
                path = fn(grid, src, dest)
                elapsed = time.perf_counter() - start

                s = stats[name]
                if path is None:
                    s["missed"] += 1
                    continue
                if not is_valid_path(grid, path, src, dest):
                    s["invalid"] += 1
                    continue
                if len(path) - 1 > ref:
                    s["suboptimal"] += 1
                s["time"] += elapsed
                s["runs"] += 1

    print()
    print("=" * 78)
    print("SPEED TEST: routes between the points in coordinates.txt")
    print("=" * 78)
    print(f"Routes timed: {reachable} (ordered pairs with a route); "
          f"{unreachable} pairs skipped because the points are in disconnected regions")
    print(f"{'Algorithm':<24}{'avg ms':>10}{'vs fastest':>12}{'suboptimal':>12}{'errors':>9}")
    print("-" * 67)

    avgs = {n: (s["time"] / s["runs"] * 1000 if s["runs"] else float("inf")) for n, s in stats.items()}
    timed = [a for a in avgs.values() if 0 < a < float("inf")]
    fastest = min(timed) if timed else 1.0
    for name in sorted(contender_names, key=lambda n: avgs[n]):
        s = stats[name]
        errors = s["missed"] + s["invalid"]
        rel = avgs[name] / fastest
        print(f"{name:<24}{avgs[name]:>10.3f}{rel:>11.1f}x{s['suboptimal']:>12}{errors:>9}")
    amortized = build_total / reachable * 1000 if reachable else 0.0
    print(f"* needs a BFS from each start point ({len(points)} builds, {build_total * 1000:.1f} ms total, "
          f"~{amortized:.3f} ms per route if counted); only pays off when many queries share a start.")
    return stats, avgs


def main():
    print("starting run")
    print(f"Grid: {ROW} rows x {COL} columns")
    comp, size = label_components(grid)

    coords = load_coordinates()
    points = []
    print()
    print(f"{'(x, y) in file':<16}{'-> (row, col)':<16}{'snapped by':>11}{'region size':>13}")
    print("-" * 56)
    for x, y in coords:
        cell, moved = snap_to_open(grid, x, y, comp, size)
        print(f"{str((x, y)):<16}{str(cell):<16}{moved:>11}{size[comp[cell[0]][cell[1]]]:>13}")
        if cell not in points:               # two coordinates can snap to the same cell
            points.append(cell)
    if len(points) < len(coords):
        print(f"({len(coords) - len(points)} duplicate cell(s) after snapping were merged)")

    gc.disable()          # keep garbage collection pauses out of the timings
    try:
        stats, avgs = benchmark_routes(grid, points)
    finally:
        gc.enable()

    # An algorithm is eligible only if it never missed a path, never returned
    # an invalid path, and was never longer than the shortest path.
    # Among the eligible, fastest wins.
    rows = []
    for name, _ in ALGORITHMS:
        s = stats[name]
        rows.append((name, avgs[name], s["missed"] + s["invalid"] + s["suboptimal"]))
    eligible = sorted([r for r in rows if r[2] == 0], key=lambda r: r[1])
    rejected = [r for r in rows if r[2] != 0]

    print()
    print("Always-correct, always-shortest algorithms (ranked by average time):")
    for i, (name, avg, _) in enumerate(eligible, 1):
        print(f"  {i}. {name:<24}{avg:>8.3f} ms")
    if rejected:
        print("Not eligible (found a longer-than-shortest path, or errors):")
        for name, avg, problems in sorted(rejected, key=lambda r: r[1]):
            print(f"     {name:<24}{avg:>8.3f} ms   ({problems} problem paths)")

    if eligible:
        best = eligible[0]
        print()
        print(f"BEST ALGORITHM: {best[0]}  (average {best[1]:.3f} ms per route)")
    else:
        print("No algorithm was correct on every route.")


if __name__ == "__main__":
    main()