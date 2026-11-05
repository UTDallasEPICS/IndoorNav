// SPN1 (Synergy Park North, building 1) as the location module sees it: levels 1 and 2.
//
// Plan units: 1 = the full width of public/maps/spn-level1.svg, so a plan point is { x: fx, y: fy * PLAN_HEIGHT }
// for map fractions fx, fy. The transform is fitted from the corners the map page used for GPS before it was
// removed (they were in public/maps/spn-georef.json). Re-survey them if the map SVG is regenerated.

import { fitFloorTransform, type ControlPoint } from '../geo/georef'
import { planToEnu } from '../geo/floorTransform'
import { enuToWgs84 } from '../geo/wgs84'
import type { BeaconRegistryEntry, Floor, VenueConfig } from '../types'

/**
 * Campus ENU anchor, near SPN1's northeast corner. Never move it: every stored ENU coordinate is relative to it.
 * h is an approximate ellipsoidal height (ground ~190 m above sea level, geoid ~-26 m here); it barely affects
 * horizontal positions.
 */
export const SPN_ORIGIN = { lat: 32.9934, lon: -96.752, h: 165 }

/** Map SVG height / width (from the viewBox: 1000000 x 457867) */
const PLAN_HEIGHT = 457867 / 1000000

/** Level 1 corners: lat/lon from satellite imagery, x/y as map fractions */
const LEVEL1_CORNERS = [
  { corner: 'top right of UT Design 1.2', lat: 32.993398, lon: -96.751974, x: 0.985, y: 0.044 },
  { corner: 'bottom right of the lower wing, below 1.111', lat: 32.993921, lon: -96.752506, x: 0.515, y: 0.912 },
  { corner: 'far left tip of Wellness Center 1.700', lat: 32.99451913965978, lon: -96.75223137913123, x: 0.002, y: 0.474 }
]

const toControlPoint = ({ lat, lon, x, y }: typeof LEVEL1_CORNERS[number]): ControlPoint => ({ lat, lon, x, y: y * PLAN_HEIGHT })

export const SPN_LEVEL1_FIT = fitFloorTransform({ floorId: 'spn1-l1', floorZ: 0 }, LEVEL1_CORNERS.map(toControlPoint), SPN_ORIGIN)

const level1: Floor = {
  id: 'spn1-l1',
  name: 'Level 1',
  level: 1,
  transform: SPN_LEVEL1_FIT.transform,
  plan: { width: 1, height: PLAN_HEIGHT }
}

/** Level 2 map SVG height / width (viewBox 1000000 x 399778); plan units are level 2 map widths */
const LEVEL2_PLAN_HEIGHT = 399778 / 1000000

/**
 * Level 2 map corners as lat/lon. spn-level2.svg was registered onto the level 2 survey's floorplan image
 * (0.4 px mean line distance), that image onto level 1's (walls, columns, stair and elevator cores line up), and
 * level 1's image is georeferenced through the level 1 survey override (app/db/seed.ts). The same chain puts
 * level 1's satellite corners within 0.2–1.1 m of where they are surveyed.
 */
const LEVEL2_CORNERS = [
  { lat: 32.99451163820989, lon: -96.75197168552215, x: 0, y: 0 },
  { lat: 32.993390061542684, lon: -96.75197355062053, x: 1, y: 0 },
  { lat: 32.994512266547424, lon: -96.75250376375689, x: 0, y: 1 },
  { lat: 32.99339068988021, lon: -96.75250562885526, x: 1, y: 1 }
]

/** Floor-to-floor height. Not measured: a typical 14 ft. Only affects reported heights, not 2D positions */
const LEVEL2_FLOOR_Z = 4.27

export const SPN_LEVEL2_FIT = fitFloorTransform(
  { floorId: 'spn1-l2', floorZ: LEVEL2_FLOOR_Z },
  LEVEL2_CORNERS.map(({ lat, lon, x, y }) => ({ lat, lon, x, y: y * LEVEL2_PLAN_HEIGHT })),
  SPN_ORIGIN
)

const level2: Floor = {
  id: 'spn1-l2',
  name: 'Level 2',
  level: 2,
  transform: SPN_LEVEL2_FIT.transform,
  plan: { width: 1, height: LEVEL2_PLAN_HEIGHT }
}

/** The map's bounding rectangle, standing in for the building outline until we have a real footprint */
const footprint = [[0, 0], [1, 0], [1, PLAN_HEIGHT], [0, PLAN_HEIGHT]].map(([x, y]) => {
  const { lat, lon } = enuToWgs84(planToEnu({ x: x!, y: y! }, level1.transform), SPN_ORIGIN)
  return { lat, lon }
})

/**
 * Empty on purpose: beacon positions and path-loss fits live in the on-device database (imported from the bSLAM
 * survey, see app/db/beacons.ts). useNavigation fills them in with `withStoredBeacons` before starting.
 */
const beacons: BeaconRegistryEntry[] = []

export const spnVenue: VenueConfig = {
  id: 'utd',
  name: 'UT Dallas',
  origin: SPN_ORIGIN,
  // Richardson, TX (NOAA World Magnetic Model, 2026): ~2.3° east and shrinking ~0.1°/year. Recheck every few years.
  magneticDeclinationDeg: 2.3,
  buildings: [{ id: 'spn1', name: 'Synergy Park North 1', footprint, floors: [level1, level2] }],
  beacons
}
