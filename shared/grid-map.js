// Converts between a floor's route grid (public/data/SPN.txt for level 1, SPN-level2.txt
// for level 2; cells as [row, col]) and map positions ({ x, y } as fractions 0–1 of that
// floor plan, like the rooms' x/y). Used by app/utils/route-between.ts.

// Each grid was made from a picture of the floor with an empty border around it, so it
// doesn't line up with the map on its own. These are the grid rows/columns (fractions
// allowed) where each map's 0–1 edges fall, by floor. Fitted so the grid's walls land on
// the map's walls; re-fit a floor if its grid or map SVG is regenerated.
export const GRID_BOUNDS = {
  1: { top: 72.5, bottom: 445.75, left: 21.25, right: 844.25 }, // SPN.txt (86% of wall cells on a wall)
  2: { top: 87.25, bottom: 407.25, left: 31.25, right: 837 } // SPN-level2.txt (walls match; extra cells are furniture)
}

export function cellToMap([row, col], floor) {
  const { top, bottom, left, right } = GRID_BOUNDS[floor]
  return {
    x: (col - left) / (right - left),
    y: (row - top) / (bottom - top)
  }
}

export function mapToCell({ x, y }, floor) {
  const { top, bottom, left, right } = GRID_BOUNDS[floor]
  return [
    Math.round(top + y * (bottom - top)),
    Math.round(left + x * (right - left))
  ]
}
