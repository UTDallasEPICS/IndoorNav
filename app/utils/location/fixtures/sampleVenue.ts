// Sample venue for tests, the simulator, and the dev page.
//
// !!! PLACEHOLDER DATA !!!
// The origin is roughly at UT Dallas, but the building, floors, and beacons are made up. Do NOT use these
// numbers for SPN1: replace them with surveyed beacon positions and a georeferenced floor transform.

import { planToEnu } from '../geo/floorTransform'
import { enuToWgs84 } from '../geo/wgs84'
import type { BeaconRegistryEntry, Floor, FloorTransform, VenueConfig } from '../types'

/** PLACEHOLDER campus origin near UT Dallas. h is ellipsoidal height (approx. ground level). */
export const SAMPLE_ORIGIN = { lat: 32.9886, lon: -96.7493, h: 170 }

/** PLACEHOLDER namespace; real Mist APs broadcast whatever namespace OIT configured */
const NAMESPACE = 'aaaaaaaaaaaaaaaaaaaa'

// A 60 m x 30 m rectangular test building. Its floor plan is 600 x 300 px at 0.1 m/px, top-left corner
// at ENU (100, 80), plan up = north.
const transform = (floorId: string, floorZ: number): FloorTransform => ({
  floorId,
  origin: { e: 100, n: 80 },
  rotationDeg: 0,
  scale: 0.1,
  floorZ
})

const floors: Floor[] = [
  { id: 'test-l1', name: 'Level 1', level: 1, transform: transform('test-l1', 0) },
  { id: 'test-l2', name: 'Level 2', level: 2, transform: transform('test-l2', 4.5) }
]

/** Beacon positions in plan pixels, 6 per floor, mounted 3 m above the floor */
const beaconPlan: Array<{ floor: Floor, instance: string, x: number, y: number }> = [
  { floor: floors[0]!, instance: '000000000101', x: 100, y: 75 },
  { floor: floors[0]!, instance: '000000000102', x: 300, y: 75 },
  { floor: floors[0]!, instance: '000000000103', x: 500, y: 75 },
  { floor: floors[0]!, instance: '000000000104', x: 100, y: 225 },
  { floor: floors[0]!, instance: '000000000105', x: 300, y: 225 },
  { floor: floors[0]!, instance: '000000000106', x: 500, y: 225 },
  { floor: floors[1]!, instance: '000000000201', x: 50, y: 100 },
  { floor: floors[1]!, instance: '000000000202', x: 300, y: 100 },
  { floor: floors[1]!, instance: '000000000203', x: 550, y: 100 },
  { floor: floors[1]!, instance: '000000000204', x: 50, y: 200 },
  { floor: floors[1]!, instance: '000000000205', x: 300, y: 200 },
  { floor: floors[1]!, instance: '000000000206', x: 550, y: 200 }
]

const beacons: BeaconRegistryEntry[] = beaconPlan.map(({ floor, instance, x, y }) => {
  const position = planToEnu({ x, y }, floor.transform)
  return {
    id: `${NAMESPACE}:${instance}`,
    enu: { ...position, u: position.u + 3 },
    floorId: floor.id,
    txPower: -59, // PLACEHOLDER: calibrate per AP model by measuring RSSI at 1 m
    pathLossExponent: 2.2 // PLACEHOLDER: fit from measurements in the real building
  }
})

/** Building outline (ENU corners converted to lat/lon, as a GIS export would provide it) */
const footprint = [
  { e: 100, n: 50 },
  { e: 160, n: 50 },
  { e: 160, n: 80 },
  { e: 100, n: 80 }
].map((p) => {
  const { lat, lon } = enuToWgs84({ ...p, u: 0 }, SAMPLE_ORIGIN)
  return { lat, lon }
})

export const sampleVenue: VenueConfig = {
  id: 'sample-campus',
  name: 'Sample campus (PLACEHOLDER)',
  origin: SAMPLE_ORIGIN,
  buildings: [{ id: 'test-bldg', name: 'Test Building (PLACEHOLDER)', footprint, floors }],
  beacons
}
