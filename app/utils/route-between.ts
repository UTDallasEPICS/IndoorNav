// Walking route between two spots on the same floor, found on the device (no server): loads
// that floor's grid once, snaps both ends onto open floor, runs A*. Used by pages/map.vue.
import { cellToMap, mapToCell } from '#shared/grid-map'
import { parseGrid, findPath, type Grid } from './astar'
import { nearestOpenCell } from './nearest-open-cell'

type MapPoint = { x: number, y: number } // fractions (0–1) of the floor plan, like the rooms' x/y

/** Each floor's route grid file (0/1 cells, 0 = open, 1 = wall) */
const GRID_FILES: Record<number, string> = { 1: '/data/SPN.txt', 2: '/data/SPN-level2.txt' }

const gridLoads = new Map<number, Promise<Grid>>() // the route grid per floor, shared by every page so each is only loaded once

/** Starts loading a floor's grid file the first time, then hands back the same grid. */
export function loadRouteGrid(floor: number): Promise<Grid> {
  let load = gridLoads.get(floor)
  if (!load) {
    const file = GRID_FILES[floor]
    if (!file) return Promise.reject(new Error(`No route grid for level ${floor}.`))
    load = $fetch<string>(file, { responseType: 'text' }) // responseType 'text': it's plain text, not JSON
      .then(parseGrid) // text -> { rows, cols, walls }
      .catch(err => { gridLoads.delete(floor); throw err }) // forget a failed load so the next try loads it again
    gridLoads.set(floor, load)
  }
  return load
}

/** Route from start to destination (both on `floor`) as map positions. Throws an Error with a message to show the user. */
export async function routeBetween(start: MapPoint, destination: MapPoint, floor: number): Promise<MapPoint[]> {
  const grid = await loadRouteGrid(floor).catch(() => { throw new Error('Failed to load the route grid.') })
  const startCell = nearestOpenCell(grid, mapToCell(start, floor) as [number, number]) // map position -> grid cell, nudged onto open floor
  const goalCell = nearestOpenCell(grid, mapToCell(destination, floor) as [number, number])
  if (!startCell || !goalCell) throw new Error(`No open floor near the ${startCell ? 'destination' : 'start'}.`)

  const path = findPath(grid, startCell, goalCell) // [[row, col], ...] from start to destination, or null
  if (!path) throw new Error('No path exists between the start and destination.')
  return path.map(cell => cellToMap(cell, floor)) // each cell -> { x, y } on that floor's map
}
