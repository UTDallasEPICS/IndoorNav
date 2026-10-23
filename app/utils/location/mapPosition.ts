// LocationFix (ENU meters) -> MapPosition (fractions of the floor's map SVG), the form the rest of the app uses.

import { enuToPlan } from './geo/floorTransform'
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
    timestamp: fix.timestamp
  }
}
