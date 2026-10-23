// SPN1 (Synergy Park North, building 1) as the location module sees it. Only level 1 has map data for now.
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

/** The map's bounding rectangle, standing in for the building outline until we have a real footprint */
const footprint = [[0, 0], [1, 0], [1, PLAN_HEIGHT], [0, PLAN_HEIGHT]].map(([x, y]) => {
  const { lat, lon } = enuToWgs84(planToEnu({ x: x!, y: y! }, level1.transform), SPN_ORIGIN)
  return { lat, lon }
})

/**
 * TODO(Andrew): AP Eddystone IDs and positions (from OIT or a walk of the building). Until this has entries the
 * BLE provider ignores every advert, so no position is produced and the app falls back to manual location.
 */
const beacons: BeaconRegistryEntry[] = []

export const spnVenue: VenueConfig = {
  id: 'utd',
  name: 'UT Dallas',
  origin: SPN_ORIGIN,
  buildings: [{ id: 'spn1', name: 'Synergy Park North 1', footprint, floors: [level1] }],
  beacons
}
