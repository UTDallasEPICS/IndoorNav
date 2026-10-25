// LocationFix (ENU meters) -> MapPosition (fractions of the floor's map SVG), the form the rest of the app uses.

import { enuToPlan, planAxes } from './geo/floorTransform'
import type { LocationFix, MapPosition } from './types'
import type { VenueIndex } from './venue'

/** The fix on its floor's map, or null when it has no floor (outdoors/unknown) or the floor has no `plan` size. */
export function toMapPosition(fix: LocationFix, index: VenueIndex): MapPosition | null {
  if (!fix.floorId) return null
  const floor = index.floors.get(fix.floorId)?.floor
  if (!floor?.plan) return null
  const point = enuToPlan(fix.enu, floor.transform)
  return {
    x: point.x / floor.plan.width,
    y: point.y / floor.plan.height,
    floor: floor.level,
    accuracyM: fix.accuracyM,
    ...(fix.headingDeg !== undefined && { headingDeg: headingOnPlan(fix.headingDeg, floor.transform.rotationDeg) }),
    timestamp: fix.timestamp
  }
}

/** Compass bearing (clockwise from true north) -> degrees clockwise from the map's up, for a plan rotated by rotationDeg. */
export function headingOnPlan(headingDeg: number, rotationDeg: number): number {
  const t = (headingDeg * Math.PI) / 180
  const e = Math.sin(t)
  const n = Math.cos(t)
  const { right, down } = planAxes(rotationDeg)
  const x = e * right.e + n * right.n
  const y = e * down.e + n * down.n
  return (Math.atan2(x, -y) * 180 / Math.PI + 360) % 360 // y points down, so "up" is -y
}
