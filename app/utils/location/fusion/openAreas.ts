// Open-plan areas (e.g. "OPEN OFFICE") on a route grid: the grid draws their desks and cubicles as walls, which the
// particle filter would treat like real walls, chopping the cloud up and making the dot jump. clearOpenAreas()
// clears the inside of each area and keeps its outline's own walls, so corridors and offices stay walled.
//
// Areas come from the rooms JSON (public/maps/<building>-level<N>-rooms.json): rooms whose name is listed, using the
// `outline` the CAD pipeline found for them (scripts/cad-to-svg.py, A-SQ FOOTAGE layer). Rooms without an outline
// are skipped (reported by openAreaOutlines so they can be fixed in the pipeline).

import type { FloorGrid } from '../types'

/** Polygon in map fractions (0–1 of the floor's map, from the top-left), like a room's `outline` */
export type MapPolygon = Array<[number, number]>

/** Room as in the rooms JSON */
export interface RoomRecord {
  number: string
  name: string
  x: number
  y: number
  outline?: MapPolygon | null
}

/** Room names treated as open-plan by default */
export const DEFAULT_OPEN_AREA_NAMES = ['OPEN OFFICE']

/** The outlines of the rooms named in `names`, and the numbers of named rooms that have no outline. */
export function openAreaOutlines(rooms: RoomRecord[], names: string[] = DEFAULT_OPEN_AREA_NAMES) {
  const wanted = new Set(names.map((n) => n.trim().toUpperCase()))
  const outlines: MapPolygon[] = []
  const missing: string[] = []
  for (const room of rooms) {
    if (!wanted.has((room.name ?? '').trim().toUpperCase())) continue
    if (room.outline && room.outline.length >= 3) outlines.push(room.outline)
    else missing.push(room.number)
  }
  return { outlines, missing }
}

/**
 * A copy of the grid with every wall cell inside one of `areas` cleared, except cells within `keepEdgeCells` of
 * the area's outline (its walls, which the outline runs along). Cells outside every area are unchanged.
 */
export function clearOpenAreas(
  grid: Pick<FloorGrid, 'rows' | 'cols' | 'walls'>,
  bounds: FloorGrid['bounds'],
  areas: MapPolygon[],
  keepEdgeCells = 3
): { rows: number, cols: number, walls: Uint8Array, cleared: number } {
  const walls = grid.walls.slice()
  let cleared = 0
  const { top, bottom, left, right } = bounds
  for (const area of areas) {
    // To cell coordinates: col = left + x (right - left), row = top + y (bottom - top)
    const poly = area.map(([x, y]) => [left + x * (right - left), top + y * (bottom - top)] as const)
    const cols = poly.map((p) => p[0])
    const rows = poly.map((p) => p[1])
    const r0 = Math.max(0, Math.floor(Math.min(...rows)))
    const r1 = Math.min(grid.rows - 1, Math.ceil(Math.max(...rows)))
    const c0 = Math.max(0, Math.floor(Math.min(...cols)))
    const c1 = Math.min(grid.cols - 1, Math.ceil(Math.max(...cols)))
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const i = r * grid.cols + c
        if (!walls[i]) continue
        const px = c + 0.5
        const py = r + 0.5
        if (inside(poly, px, py) && distanceToEdges(poly, px, py) > keepEdgeCells) {
          walls[i] = 0
          cleared++
        }
      }
    }
  }
  return { rows: grid.rows, cols: grid.cols, walls, cleared }
}

/** Even-odd point in polygon */
function inside(poly: ReadonlyArray<readonly [number, number]>, x: number, y: number) {
  let isIn = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!
    const [xj, yj] = poly[j]!
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) isIn = !isIn
  }
  return isIn
}

/** Shortest distance from (x, y) to the polygon's edges */
function distanceToEdges(poly: ReadonlyArray<readonly [number, number]>, x: number, y: number) {
  let best = Infinity
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j]!
    const [bx, by] = poly[i]!
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)))
  }
  return best
}
