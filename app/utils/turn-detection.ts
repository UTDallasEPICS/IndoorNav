// Finds the turns along an A* path: same method and settings as scripts/turn_detection.py (keep the two in step).
// At each point, the average heading of the WINDOW steps before it is compared with the WINDOW steps after it;
// a change of at least THRESHOLD degrees is a turn. Used by route-between.ts to give the walker directions.

type Cell = readonly [number, number] // [row, col] on the route grid, like findPath's output

export type Turn = {
  index: number, // which path point the turn is at (the same index works on the route's map points)
  direction: 'left' | 'right', // as seen by someone walking the path
  angle: number // how far to turn, in degrees (always positive)
}

export const TURN_WINDOW = 10 // steps averaged on each side of a point (WINDOW_SIZE in the Python)
export const TURN_THRESHOLD = 45 // smallest heading change, in degrees, that counts as a turn (ANGLE_THRESHOLD)

/** Heading of each step from cells[i] to cells[i + 1], in radians (row as x, col as y, like the Python). */
function stepAngles(cells: readonly Cell[]): number[] {
  const angles: number[] = []
  for (let i = 1; i < cells.length; i++) {
    angles.push(Math.atan2(cells[i]![1] - cells[i - 1]![1], cells[i]![0] - cells[i - 1]![0]))
  }
  return angles
}

/** Circular mean, so 359° and 1° average to 0°, not 180°. */
function averageAngle(angles: number[]): number {
  let sin = 0, cos = 0
  for (const a of angles) { sin += Math.sin(a); cos += Math.cos(a) }
  return Math.atan2(sin, cos)
}

/** Signed smallest change from a to b, in degrees, in (-180, 180]. Positive = left. */
function angleChange(a: number, b: number): number {
  let d = (b - a) * 180 / Math.PI
  while (d > 180) d -= 360
  while (d <= -180) d += 360
  return d
}

export function detectTurns(cells: readonly Cell[], window = TURN_WINDOW, threshold = TURN_THRESHOLD): Turn[] {
  const angles = stepAngles(cells)
  const n = angles.length

  const candidates: { index: number, change: number }[] = [] // every point whose before/after headings differ enough
  for (let i = window; i <= n - window; i++) { // short paths (< 2 × window + 1 points) have no room to compare: no turns
    const change = angleChange(averageAngle(angles.slice(i - window, i)), averageAngle(angles.slice(i, i + window)))
    if (Math.abs(change) >= threshold) candidates.push({ index: i, change })
  }

  // The points around one corner all pass the threshold; keep the sharpest point of each run of neighbours
  const turns: Turn[] = []
  let group: typeof candidates = []
  const closeGroup = () => {
    if (!group.length) return
    const sharpest = group.reduce((best, c) => (Math.abs(c.change) > Math.abs(best.change) ? c : best)) // first one wins a tie, like Python's max()
    turns.push({ index: sharpest.index, direction: sharpest.change > 0 ? 'left' : 'right', angle: Math.abs(sharpest.change) })
    group = []
  }
  for (const c of candidates) {
    if (group.length && c.index - group[group.length - 1]!.index > 1) closeGroup() // a gap: the previous corner is finished
    group.push(c)
  }
  closeGroup()
  return turns
}
