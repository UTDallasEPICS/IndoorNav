import { wgs84ToEnu } from './geo/wgs84'
import type { Point2 } from './geo/polygon'
import type { BeaconRegistryEntry, Building, Floor, VenueConfig } from './types'

/** Lookup tables built once from a VenueConfig, so per-scan code doesn't search arrays. */
export interface VenueIndex {
  venue: VenueConfig
  beacons: Map<string, BeaconRegistryEntry>
  /**
   * The registry ID a scanned beacon ID belongs to, or null if none. Registry IDs may have `*` wildcards: a Mist AP's
   * vBLE array sends one Eddystone instance per beam, and the survey groups an AP's beams under one ID with the beam
   * digit replaced by `*` (e.g. `41021*e40000`).
   */
  resolveBeaconId: (id: string) => string | null
  floors: Map<string, { floor: Floor, building: Building }>
  /** Building footprints converted to ENU */
  footprints: Array<{ buildingId: string, polygon: Point2[] }>
}

export function indexVenue(venue: VenueConfig): VenueIndex {
  const floors = new Map<string, { floor: Floor, building: Building }>()
  for (const building of venue.buildings) {
    for (const floor of building.floors) floors.set(floor.id, { floor, building })
  }
  const beacons = new Map(venue.beacons.map((b) => [b.id, b]))
  // Each distinct set of wildcard positions, so a scanned ID is masked and looked up once per set
  const masks = [...new Set(venue.beacons.filter((b) => b.id.includes('*')).map((b) => wildcardPositions(b.id).join(',')))]
    .map((key) => key.split(',').map(Number))
  const resolveBeaconId = (id: string) => {
    if (beacons.has(id)) return id
    for (const positions of masks) {
      const masked = [...id]
      for (const i of positions) masked[i] = '*'
      const key = masked.join('')
      if (beacons.has(key)) return key
    }
    return null
  }
  return {
    venue,
    beacons,
    resolveBeaconId,
    floors,
    footprints: venue.buildings.map((building) => ({
      buildingId: building.id,
      polygon: building.footprint.map((p) => wgs84ToEnu({ lat: p.lat, lon: p.lon, h: venue.origin.h }, venue.origin))
    }))
  }
}

const wildcardPositions = (id: string) => [...id].flatMap((c, i) => (c === '*' ? [i] : []))
