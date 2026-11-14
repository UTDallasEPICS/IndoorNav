// A* pathfinding on a floor's route grid (public/data/SPN*.txt), ported from scripts/navigation.py
// so routes are found on the phone. Cells are [row, col], 0-indexed from the top-left.
// Like navigation.py, routes are pulled toward the middle of hallways (steps next to a wall
// cost more) and then straightened into any-angle lines where they stay clear of walls.
// Keep the constants below in step with navigation.py.

export type Cell = [row: number, col: number]

export interface Grid {
  rows: number
  cols: number
  walls: Uint8Array // every cell, row after row: 1 = wall, 0 = open
}

/** Reads SPN-level1.txt-style text (rows of 0/1, spaced like "0 1 0" or packed like "010") into a Grid. */
export function parseGrid(text: string): Grid {
  const lines = text.split('\n')
    .map(line => line.replace(/[\s,]/g, '')) // "0 1 0" and "0,1,0" -> "010"
    .filter(line => line)                    // skip blank lines
  const rows = lines.length
  const cols = lines[0]?.length ?? 0
  if (!rows) throw new Error('The grid is empty.')

  const walls = new Uint8Array(rows * cols)
  lines.forEach((line, r) => {
    if (line.length !== cols) throw new Error(`Grid row ${r + 1} has a different length.`)
    for (let c = 0; c < cols; c++) {
      if (line[c] !== '0' && line[c] !== '1') throw new Error(`Grid row ${r + 1}: only 0 and 1 are allowed.`)
      walls[r * cols + c] = line[c] === '1' ? 1 : 0
    }
  })
  return { rows, cols, walls }
}

// Hallway centering
const CLEARANCE_RADIUS = 6 // cells; ~half of an 11-wide hallway
const WALL_WEIGHT = 2      // extra cost per step right next to a wall (0 disables centering)

// Heuristic inflation: 1 = shortest paths; higher searches faster for slightly longer routes
const H_WEIGHT = 1.5

// Straightening (any-angle shortcuts applied after A*)
const STRAIGHT_MIN_CLEARANCE = 3 // a shortcut must stay at least this far from walls
const STRAIGHT_SLACK = 2         // a shortcut may cost up to this × the stretch it replaces
const SMOOTH_FAIL_WINDOW = 25    // stop looking ahead after this many failed shortcuts

export interface PathOptions {
  center?: boolean  // pull the route toward the middle of hallways (default true)
  smooth?: boolean  // straighten the route after A* (default true)
  hWeight?: number  // heuristic inflation (default H_WEIGHT; 1 = shortest path for the chosen cost)
}

/**
 * Route from start to goal (both included), or null if the goal can't be reached.
 * With { center: false, smooth: false, hWeight: 1 } it's the plain shortest path.
 */
export function findPath(grid: Grid, start: Cell, goal: Cell, options: PathOptions = {}): Cell[] | null {
  const { center = true, smooth = true, hWeight = H_WEIGHT } = options
  const { rows, cols, walls } = grid
  checkCell(grid, start, 'Start')
  checkCell(grid, goal, 'Destination')

  const { dist, mult: centerMult } = clearanceOf(grid)
  const mult = center ? centerMult : null // per-cell step cost multiplier (null = every step costs 1)

  const startIndex = start[0] * cols + start[1] // cells are numbers (row * cols + col), so no arrays in the hot loop
  const goalIndex = goal[0] * cols + goal[1]
  const [goalRow, goalCol] = goal

  const gScore = new Float64Array(rows * cols).fill(Infinity) // cheapest known cost from start to each cell
  const parent = new Int32Array(rows * cols).fill(-1)         // the cell we came from, to rebuild the path
  const closed = new Uint8Array(rows * cols)                  // 1 once a cell's best cost is final

  const h = (index: number) => { // octile distance: straight steps cost 1, diagonals √2 (never more than the real cost, as every multiplier is ≥ 1)
    const dr = Math.abs(Math.floor(index / cols) - goalRow)
    const dc = Math.abs((index % cols) - goalCol)
    return (dr + dc + (Math.SQRT2 - 2) * Math.min(dr, dc)) * hWeight
  }

  const open = new MinHeap()
  gScore[startIndex] = 0
  open.push([h(startIndex), -0, startIndex])

  while (open.size) {
    const current = open.pop()
    if (closed[current]) continue // an older, more expensive copy of a cell we already finished
    closed[current] = 1
    if (current === goalIndex) {
      const path = tracePath(parent, current, cols)
      return smooth ? straighten(grid, path, dist, mult) : path
    }

    const row = Math.floor(current / cols)
    const col = current % cols
    const up = row > 0
    const down = row < rows - 1
    const left = col > 0
    const right = col < cols - 1
    const bothOpen = (a: number, b: number) => !walls[a] && !walls[b] // diagonals can't squeeze between two walls

    const neighbours: [index: number, cost: number][] = []
    if (up) neighbours.push([current - cols, 1])
    if (down) neighbours.push([current + cols, 1])
    if (left) neighbours.push([current - 1, 1])
    if (right) neighbours.push([current + 1, 1])
    if (up && left && bothOpen(current - cols, current - 1)) neighbours.push([current - cols - 1, Math.SQRT2])
    if (up && right && bothOpen(current - cols, current + 1)) neighbours.push([current - cols + 1, Math.SQRT2])
    if (down && left && bothOpen(current + cols, current - 1)) neighbours.push([current + cols - 1, Math.SQRT2])
    if (down && right && bothOpen(current + cols, current + 1)) neighbours.push([current + cols + 1, Math.SQRT2])

    for (const [next, cost] of neighbours) {
      if (walls[next] || closed[next]) continue
      const tentative = gScore[current]! + cost * (mult ? mult[next]! : 1)
      if (tentative < gScore[next]!) { // found a cheaper way to reach next
        gScore[next] = tentative
        parent[next] = current
        open.push([tentative + h(next), -tentative, next]) // -g: on equal f, prefer the cell closer to the goal
      }
    }
  }
  return null
}

// --------------------------------------------------------------------------------------------
// Clearance: distance from each cell to the nearest wall (the grid's edge counts as a wall)
// --------------------------------------------------------------------------------------------

interface Clearance {
  dist: Float64Array // Euclidean distance, in cells, from each cell to the nearest wall (0 on walls)
  mult: Float64Array // step cost multiplier: 1 from CLEARANCE_RADIUS out, up to 1 + WALL_WEIGHT next to a wall
}

const clearanceCache = new WeakMap<Grid, Clearance>() // worked out once per grid (~tens of ms), reused by every route

function clearanceOf(grid: Grid): Clearance {
  let found = clearanceCache.get(grid)
  if (!found) {
    const dist = distanceToWalls(grid)
    const mult = new Float64Array(dist.length)
    for (let i = 0; i < dist.length; i++) {
      const t = Math.min(Math.max((CLEARANCE_RADIUS - dist[i]!) / CLEARANCE_RADIUS, 0), 1)
      mult[i] = WALL_WEIGHT > 0 && CLEARANCE_RADIUS > 0 ? 1 + WALL_WEIGHT * t * t : 1
    }
    found = { dist, mult }
    clearanceCache.set(grid, found)
  }
  return found
}

/** Exact Euclidean distance transform (Felzenszwalb & Huttenlocher), like scipy's distance_transform_edt. */
function distanceToWalls({ rows, cols, walls }: Grid): Float64Array {
  // Work on the grid padded with a 1-cell wall border, as navigation.py does, so the edge counts as a wall
  const H = rows + 2
  const W = cols + 2
  const BIG = 1e20
  const sq = new Float64Array(H * W) // squared distance
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const inside = r > 0 && r <= rows && c > 0 && c <= cols
      sq[r * W + c] = inside && !walls[(r - 1) * cols + (c - 1)] ? BIG : 0
    }
  }
  const n = Math.max(H, W)
  const f = new Float64Array(n)
  const d = new Float64Array(n)
  const v = new Int32Array(n)
  const z = new Float64Array(n + 1)
  const pass = (length: number, get: (i: number) => number, set: (i: number, value: number) => void) => {
    for (let i = 0; i < length; i++) f[i] = get(i)
    let k = 0
    v[0] = 0; z[0] = -Infinity; z[1] = Infinity
    for (let q = 1; q < length; q++) { // lower envelope of the parabolas f[q] + (x - q)²
      let s = ((f[q]! + q * q) - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!)
      while (s <= z[k]!) {
        k--
        s = ((f[q]! + q * q) - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!)
      }
      k++
      v[k] = q; z[k] = s; z[k + 1] = Infinity
    }
    k = 0
    for (let q = 0; q < length; q++) {
      while (z[k + 1]! < q) k++
      d[q] = (q - v[k]!) * (q - v[k]!) + f[v[k]!]!
    }
    for (let i = 0; i < length; i++) set(i, d[i]!)
  }
  for (let c = 0; c < W; c++) pass(H, r => sq[r * W + c]!, (r, value) => { sq[r * W + c] = value }) // columns
  for (let r = 0; r < H; r++) pass(W, c => sq[r * W + c]!, (c, value) => { sq[r * W + c] = value }) // then rows

  const dist = new Float64Array(rows * cols)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) dist[r * cols + c] = Math.sqrt(sq[(r + 1) * W + (c + 1)]!)
  }
  return dist
}

// --------------------------------------------------------------------------------------------
// Straightening ("string pulling"), as in navigation.py's straighten()
// --------------------------------------------------------------------------------------------

/**
 * Replaces stretches of the 8-connected path with straight lines when the line stays at least
 * STRAIGHT_MIN_CLEARANCE from every wall (or as far as its own ends are), doesn't squeeze
 * diagonally between two walls, and costs at most STRAIGHT_SLACK × the stretch it replaces.
 * Returns the result as contiguous cells again.
 */
function straighten({ cols, walls }: Grid, pts: Cell[], dist: Float64Array, mult: Float64Array | null): Cell[] {
  const n = pts.length
  if (n < 3) return pts
  const at = ([r, c]: Cell) => r * cols + c
  const cost = (index: number) => mult ? mult[index]! : 1 // step cost multiplier (1 without centering)

  const cum = new Float64Array(n) // cost along the A* path up to each point
  for (let i = 1; i < n; i++) {
    const diagonal = pts[i]![0] !== pts[i - 1]![0] && pts[i]![1] !== pts[i - 1]![1]
    cum[i] = cum[i - 1]! + (diagonal ? Math.SQRT2 : 1) * cost(at(pts[i]!))
  }

  const visible = (a: number, b: number) => {
    const line = lineCells(pts[a]!, pts[b]!)
    const threshold = Math.min(STRAIGHT_MIN_CLEARANCE, dist[at(line[0]!)]!, dist[at(line[line.length - 1]!)]!)
    for (const cell of line) if (dist[at(cell)]! < threshold) return false
    let chord = 0
    for (let i = 1; i < line.length; i++) {
      const [r0, c0] = line[i - 1]!
      const [r1, c1] = line[i]!
      const diagonal = r0 !== r1 && c0 !== c1
      if (diagonal && (walls[r0 * cols + c1] || walls[r1 * cols + c0])) return false
      chord += (diagonal ? Math.SQRT2 : 1) * cost(r1 * cols + c1)
    }
    return chord <= STRAIGHT_SLACK * (cum[b]! - cum[a]!)
  }

  const keep = [0]
  let anchor = 0
  while (anchor < n - 1) {
    let best = anchor + 1
    let fails = 0
    for (let j = anchor + 2; j < n && fails < SMOOTH_FAIL_WINDOW; j++) {
      if (visible(anchor, j)) { best = j; fails = 0 } else fails++
    }
    keep.push(best)
    anchor = best
  }

  const out: Cell[] = [pts[0]!]
  for (let i = 1; i < keep.length; i++) out.push(...lineCells(pts[keep[i - 1]!]!, pts[keep[i]!]!).slice(1))
  return out
}

/**
 * Cells on the straight line from a to b (both included), one step at a time. Rounded like numpy's
 * rint in navigation.py's padded coordinates (+1), so halfway points land on the same cells.
 */
function lineCells([r0, c0]: Cell, [r1, c1]: Cell): Cell[] {
  const steps = Math.max(Math.abs(r1 - r0), Math.abs(c1 - c0))
  const cells: Cell[] = []
  for (let i = 0; i <= steps; i++) {
    const t = steps ? i / steps : 0
    cells.push([roundHalfEven(r0 + 1 + (r1 - r0) * t) - 1, roundHalfEven(c0 + 1 + (c1 - c0) * t) - 1])
  }
  return cells
}

function roundHalfEven(x: number) { // 2.5 -> 2, 3.5 -> 4, like numpy (Math.round always rounds .5 up)
  const r = Math.round(x)
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r
}

function checkCell({ rows, cols, walls }: Grid, [row, col]: Cell, label: string) {
  if (row < 0 || row >= rows || col < 0 || col >= cols) {
    throw new Error(`${label} [${row}, ${col}] is outside the grid (rows 0–${rows - 1}, cols 0–${cols - 1}).`)
  }
  if (walls[row * cols + col]) throw new Error(`${label} [${row}, ${col}] is a wall.`)
}

function tracePath(parent: Int32Array, end: number, cols: number): Cell[] {
  const path: Cell[] = []
  for (let index = end; index !== -1; index = parent[index]!) { // walk back from the goal to the start
    path.push([Math.floor(index / cols), index % cols])
  }
  return path.reverse()
}

type HeapItem = [f: number, negG: number, index: number]

class MinHeap { // binary heap ordered like Python's heapq on (f, -g, index) tuples, so routes match navigation.py
  private items: HeapItem[] = []

  get size() {
    return this.items.length
  }

  push(item: HeapItem) {
    const items = this.items
    items.push(item)
    let i = items.length - 1
    while (i > 0) { // bubble the new item up while it's smaller than its parent
      const up = (i - 1) >> 1
      if (!less(items[i]!, items[up]!)) break
      ;[items[i], items[up]] = [items[up]!, items[i]!]
      i = up
    }
  }

  pop(): number { // removes the smallest item and returns its cell index
    const items = this.items
    const top = items[0]!
    const last = items.pop()!
    if (items.length) {
      items[0] = last
      let i = 0
      while (true) { // sink the moved item down to where it belongs
        const l = 2 * i + 1
        const r = l + 1
        let smallest = i
        if (l < items.length && less(items[l]!, items[smallest]!)) smallest = l
        if (r < items.length && less(items[r]!, items[smallest]!)) smallest = r
        if (smallest === i) break
        ;[items[i], items[smallest]] = [items[smallest]!, items[i]!]
        i = smallest
      }
    }
    return top[2]
  }
}

function less(a: HeapItem, b: HeapItem) { // compares f, then -g, then index, like tuple comparison
  return a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2]
}
