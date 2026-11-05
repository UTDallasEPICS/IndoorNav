// Walking route between two spots on level 1, found on the device (no server): loads the
// grid once, snaps both ends onto open floor, runs A*. Used by pages/map.vue.
import { cellToMap, mapToCell } from '#shared/grid-map'
import { parseGrid, findPath, type Grid } from './astar'
import { nearestOpenCell } from './nearest-open-cell'

type MapPoint = { x: number, y: number } // fractions (0–1) of the floor plan, like the rooms' x/y

let gridLoad: Promise<Grid> | null = null // the route grid, shared by every page so it's only loaded once

/** Starts loading public/data/SPN.txt the first time, then hands back the same grid. */
export function loadRouteGrid(): Promise<Grid> {
  gridLoad ??= $fetch<string>('/data/SPN.txt', { responseType: 'text' }) // responseType 'text': it's plain text, not JSON
    .then(parseGrid) // text -> { rows, cols, walls }
    .catch(err => { gridLoad = null; throw err }) // forget a failed load so the next try loads it again
  return gridLoad
}

/** Route from start to destination as map positions. Throws an Error with a message to show the user. */
export async function routeBetween(start: MapPoint, destination: MapPoint): Promise<MapPoint[]> {
  const grid = await loadRouteGrid().catch(() => { throw new Error('Failed to load the route grid.') })
  const startCell = nearestOpenCell(grid, mapToCell(start) as [number, number]) // map position -> grid cell, nudged onto open floor
  const goalCell = nearestOpenCell(grid, mapToCell(destination) as [number, number])
  if (!startCell || !goalCell) throw new Error(`No open floor near the ${startCell ? 'destination' : 'start'}.`)

  const path = findPath(grid, startCell, goalCell) // [[row, col], ...] from start to destination, or null
  if (!path) throw new Error('No path exists between the start and destination.')
  return path.map(cellToMap) // each cell -> { x, y } on the map
}
