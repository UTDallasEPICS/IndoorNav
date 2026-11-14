// Applies floor heights stored in the on-device database (floors.elevation_m) to the venue, so a new building's
// floors only need database rows. Pure: the query lives in app/db/floors.ts.

import type { VenueConfig } from './types'

/** One floor row as `listFloors` returns it */
export interface StoredFloor {
  /** Building name in the database, e.g. "SPN1" (matched to `Building.id` ignoring case) */
  building: string
  /** Floor level, matched to `Floor.level` */
  level: number
  /** Height of the floor's walking surface above the building's ground floor (m), or null if unknown */
  elevationM: number | null
}

/**
 * The venue with each floor's height (`transform.floorZ`) replaced by the stored one; floors without a stored
 * height keep the venue's. Apply it before `withStoredBeacons`, which places beacons relative to floor heights.
 */
export function withStoredFloors(venue: VenueConfig, rows: StoredFloor[]): VenueConfig {
  return {
    ...venue,
    buildings: venue.buildings.map((building) => ({
      ...building,
      floors: building.floors.map((floor) => {
        const row = rows.find((r) => r.building.toLowerCase() === building.id.toLowerCase() && r.level === floor.level)
        if (row?.elevationM == null) return floor
        return { ...floor, transform: { ...floor.transform, floorZ: row.elevationM } }
      })
    }))
  }
}
