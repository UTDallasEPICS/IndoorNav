// Snaps a point onto walkable floor before routing, since room labels often sit on a
// wall line or on leftover text in the grid. Moved from server/api/route.post.js.
import type { Cell, Grid } from './astar'

const SNAP_RADIUS = 15 // how far to look, in grid cells (about 15 cm each)

/** The closest open cell to [row, col], searching outwards ring by ring, or null if none is in range. */
export function nearestOpenCell({ rows, cols, walls }: Grid, [row, col]: Cell): Cell | null {
  const isOpen = (r: number, c: number) => r >= 0 && r < rows && c >= 0 && c < cols && !walls[r * cols + c]

  for (let d = 0; d <= SNAP_RADIUS; d++) { // d = ring distance from the starting cell
    for (let r = row - d; r <= row + d; r++) {
      for (let c = col - d; c <= col + d; c++) {
        const onRing = Math.abs(r - row) === d || Math.abs(c - col) === d // skip the inside, already checked
        if (onRing && isOpen(r, c)) return [r, c]
      }
    }
  }
  return null
}
