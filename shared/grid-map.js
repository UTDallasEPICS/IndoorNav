// Converts between the route grid (scripts/nav_io/SPN.txt, cells as [row, col])
// and map positions ({ x, y } as fractions 0–1 of the floor plan, like the rooms' x/y).
// Used by the server (rooms -> grid cells for coords.txt) and the page (path -> line).

// SPN.txt was made from a picture of level 1 with an empty border around it, so it
// doesn't line up with the map on its own. These are the grid rows/columns (fractions
// allowed) where the map's 0–1 edges fall. Fitted so the grid's walls land on the map's
// walls (86% overlap); re-fit if SPN.txt or the map SVG is regenerated.
export const GRID_BOUNDS = { top: 72.5, bottom: 445.75, left: 21.25, right: 844.25 }

export function cellToMap([row, col]) {
  const { top, bottom, left, right } = GRID_BOUNDS
  return {
    x: (col - left) / (right - left),
    y: (row - top) / (bottom - top)
  }
}

export function mapToCell({ x, y }) {
  const { top, bottom, left, right } = GRID_BOUNDS
  return [
    Math.round(top + y * (bottom - top)),
    Math.round(left + x * (right - left))
  ]
}
