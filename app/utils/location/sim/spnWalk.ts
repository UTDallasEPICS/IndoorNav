// A realistic test walk for the simulator: SPN1 level 1 with its surveyed APs and route grid, walking an A* route
// between two rooms. Node only (reads files from public/), so it's for tests, not the dev page.

import { readFileSync } from 'node:fs'
import { cellToMap, GRID_BOUNDS } from '../../../../shared/grid-map.js'
import { parseBeaconSurvey, type SurveyFloorMeta } from '../../../db/beacons'
import { SPN1_LEVEL1 } from '../../../db/seed'
import { findPath, parseGrid, type Grid } from '../../astar'
import { nearestOpenCell } from '../../nearest-open-cell'
import { withStoredBeacons, type StoredBeacon } from '../beaconRegistry'
import { planToEnu } from '../geo/floorTransform'
import { withFloorGrids } from '../fusion/walkableMap'
import type { VenueConfig } from '../types'
import { spnVenue } from '../venues/spn'
import type { PathWaypoint } from './simulator'

const SURVEY = 'public/data/surveys/spn-level1'

let cached: { venue: VenueConfig, grid: Grid } | null = null

/** SPN1 with level 1's surveyed beacons and route grid */
export function spnLevel1(): { venue: VenueConfig, grid: Grid } {
  if (cached) return cached
  const exported: SurveyFloorMeta = JSON.parse(readFileSync(`${SURVEY}-floor-20261030-2055.json`, 'utf8'))
  const floor: SurveyFloorMeta = { ...exported, geo: SPN1_LEVEL1.surveys[0]!.geo }
  const csv = readFileSync(`${SURVEY}-beacons-20261030-2055.csv`, 'utf8')
  const rows: StoredBeacon[] = parseBeaconSurvey(csv, floor).beacons.map((b) => ({
    namespace: b.namespace,
    instance: b.instance,
    building: 'SPN1',
    level: 1,
    status: b.status,
    latitude: b.latitude ?? null,
    longitude: b.longitude ?? null,
    txPowerDbm: b.tx_power_dbm ?? null,
    pathLossExponent: b.path_loss_exponent ?? null,
    heightOffsetM: exported.path_loss?.height_offset_m ?? null,
    fitRmseDb: b.fit_rmse_db ?? null,
    sigmaMajorM: b.sigma_major_m ?? null
  }))
  const grid = parseGrid(readFileSync('public/data/SPN.txt', 'utf8'))
  const venue = withFloorGrids(withStoredBeacons(spnVenue, rows), { 1: { grid, bounds: GRID_BOUNDS[1] } })
  cached = { venue, grid }
  return cached
}

const rooms: Array<{ number: string, name: string, x: number, y: number }> =
  JSON.parse(readFileSync('public/maps/spn-level1-rooms.json', 'utf8'))

/**
 * Walking from one room to another at `speedMps` along the app's own route, after standing still at the start for
 * `standS` seconds. Rooms are matched by number (the first one with that number).
 */
export function spnRouteWalk(from: string, to: string, speedMps = 1.3, standS = 5): PathWaypoint[] {
  const { venue, grid } = spnLevel1()
  const floor = venue.buildings[0]!.floors[0]!
  const room = (number: string) => {
    const r = rooms.find((r) => r.number === number)
    if (!r) throw new Error(`No room ${number}`)
    const [row, col] = cellOf(r)
    const cell = nearestOpenCell(grid, [row, col])
    if (!cell) throw new Error(`No open floor near room ${number}`)
    return cell
  }
  const cellOf = ({ x, y }: { x: number, y: number }): [number, number] => {
    const b = GRID_BOUNDS[1]
    return [Math.round(b.top + y * (b.bottom - b.top)), Math.round(b.left + x * (b.right - b.left))]
  }
  const path = findPath(grid, room(from), room(to))
  if (!path) throw new Error(`No route from ${from} to ${to}`)
  const points = path.map((cell) => {
    const { x, y } = cellToMap(cell, 1)
    return planToEnu({ x: x * floor.plan!.width, y: y * floor.plan!.height }, floor.transform)
  })
  const walk: PathWaypoint[] = [{ t: 0, e: points[0]!.e, n: points[0]!.n, floorId: floor.id }]
  let t = standS
  walk.push({ t, e: points[0]!.e, n: points[0]!.n, floorId: floor.id })
  for (let i = 1; i < points.length; i++) {
    t += Math.hypot(points[i]!.e - points[i - 1]!.e, points[i]!.n - points[i - 1]!.n) / speedMps
    walk.push({ t, e: points[i]!.e, n: points[i]!.n, floorId: floor.id })
  }
  return walk
}
