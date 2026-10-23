// A* pathfinding on the route grid (public/data/SPN.txt), ported from scripts/navigation.py
// so routes are found on the phone. Cells are [row, col], 0-indexed from the top-left.

export type Cell = [row: number, col: number]

export interface Grid {
  rows: number
  cols: number
  walls: Uint8Array // every cell, row after row: 1 = wall, 0 = open
}

/** Reads SPN.txt-style text (rows of 0/1, spaced like "0 1 0" or packed like "010") into a Grid. */
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

/** Shortest path from start to goal (both included), or null if the goal can't be reached. */
export function findPath(grid: Grid, start: Cell, goal: Cell): Cell[] | null {
  const { rows, cols, walls } = grid
  checkCell(grid, start, 'Start')
  checkCell(grid, goal, 'Destination')

  const startIndex = start[0] * cols + start[1] // cells are numbers (row * cols + col), so no arrays in the hot loop
  const goalIndex = goal[0] * cols + goal[1]
  const [goalRow, goalCol] = goal

  const gScore = new Float64Array(rows * cols).fill(Infinity) // cheapest known cost from start to each cell
  const parent = new Int32Array(rows * cols).fill(-1)         // the cell we came from, to rebuild the path
  const closed = new Uint8Array(rows * cols)                  // 1 once a cell's best cost is final

  const h = (index: number) => { // octile distance: straight steps cost 1, diagonals √2
    const dr = Math.abs(Math.floor(index / cols) - goalRow)
    const dc = Math.abs((index % cols) - goalCol)
    return dr + dc + (Math.SQRT2 - 2) * Math.min(dr, dc)
  }

  const open = new MinHeap()
  gScore[startIndex] = 0
  open.push([h(startIndex), -0, startIndex])

  while (open.size) {
    const current = open.pop()
    if (closed[current]) continue // an older, more expensive copy of a cell we already finished
    closed[current] = 1
    if (current === goalIndex) return tracePath(parent, current, cols)

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
      const tentative = gScore[current]! + cost
      if (tentative < gScore[next]!) { // found a cheaper way to reach next
        gScore[next] = tentative
        parent[next] = current
        open.push([tentative + h(next), -tentative, next]) // -g: on equal f, prefer the cell closer to the goal
      }
    }
  }
  return null
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
