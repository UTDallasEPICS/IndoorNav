import { wgs84ToEnu } from './geo/wgs84'
import type { Point2 } from './geo/polygon'
import type { BeaconRegistryEntry, Building, Floor, VenueConfig } from './types'

/** Lookup tables built once from a VenueConfig, so per-scan code doesn't search arrays. */
export interface VenueIndex {
  venue: VenueConfig
  beacons: Map<string, BeaconRegistryEntry>
  floors: Map<string, { floor: Floor, building: Building }>
  /** Building footprints converted to ENU */
  footprints: Array<{ buildingId: string, polygon: Point2[] }>
}

export function indexVenue(venue: VenueConfig): VenueIndex {
  const floors = new Map<string, { floor: Floor, building: Building }>()
  for (const building of venue.buildings) {
    for (const floor of building.floors) floors.set(floor.id, { floor, building })
  }
  return {
    venue,
    beacons: new Map(venue.beacons.map((b) => [b.id, b])),
    floors,
    footprints: venue.buildings.map((building) => ({
      buildingId: building.id,
      polygon: building.footprint.map((p) => wgs84ToEnu({ lat: p.lat, lon: p.lon, h: venue.origin.h }, venue.origin))
    }))
  }
}
