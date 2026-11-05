// Turns beacons stored in the on-device database (WGS84, from the bSLAM survey) into the BLE provider's
// BeaconRegistryEntry list (ENU meters relative to the venue origin). Pure: the query lives in app/db/beacons.ts.

import { wgs84ToEnu } from './geo/wgs84'
import type { BeaconRegistryEntry, VenueConfig } from './types'

/** One beacon row as `listBeacons` returns it */
export interface StoredBeacon {
  /** Eddystone namespace and instance, lowercase hex (`*` in the instance: any vBLE beam of one AP) */
  namespace: string
  instance: string
  /** Building name in the database, e.g. "SPN1" (matched to `Building.id` ignoring case) */
  building: string
  /** Floor level, matched to `Floor.level` */
  level: number
  status: string
  latitude: number | null
  longitude: number | null
  /** Fitted RSSI at 1 m, dBm */
  txPowerDbm: number | null
  pathLossExponent: number | null
  /** Vertical beacon-to-phone distance the survey's path-loss fit assumed */
  heightOffsetM: number | null
}

export interface BeaconRegistryOptions {
  /**
   * Statuses trusted for positioning. `ambiguous` (could be the mirror-image spot), `poor` (error ellipses up to
   * tens of meters) and `insufficient` (no position) are left out by default.
   */
  statuses: string[]
  /** Must match `BleProviderOptions.phoneHeightM`, so the provider's beacon-to-phone height equals the survey's */
  phoneHeightM: number
  /** Used when the survey didn't record one */
  defaultHeightOffsetM: number
  /** Used for beacons without a path-loss fit (e.g. placed by hand) */
  defaultTxPower: number
  defaultPathLossExponent: number
}

export const DEFAULT_BEACON_REGISTRY_OPTIONS: BeaconRegistryOptions = {
  statuses: ['manual', 'good', 'fair'],
  phoneHeightM: 1.2,
  defaultHeightOffsetM: 2,
  defaultTxPower: -59,
  defaultPathLossExponent: 2.5
}

export function toBeaconRegistry(
  rows: StoredBeacon[],
  venue: VenueConfig,
  options: Partial<BeaconRegistryOptions> = {}
): BeaconRegistryEntry[] {
  const o = { ...DEFAULT_BEACON_REGISTRY_OPTIONS, ...options }
  const out: BeaconRegistryEntry[] = []
  for (const row of rows) {
    if (!o.statuses.includes(row.status) || row.latitude === null || row.longitude === null) continue
    const building = venue.buildings.find((b) => b.id.toLowerCase() === row.building.toLowerCase())
    const floor = building?.floors.find((f) => f.level === row.level)
    if (!floor) continue

    const { e, n } = wgs84ToEnu({ lat: row.latitude, lon: row.longitude, h: venue.origin.h }, venue.origin)
    out.push({
      id: `${row.namespace}:${row.instance}`,
      enu: { e, n, u: floor.transform.floorZ + o.phoneHeightM + (row.heightOffsetM ?? o.defaultHeightOffsetM) },
      floorId: floor.id,
      txPower: row.txPowerDbm ?? o.defaultTxPower,
      pathLossExponent: row.pathLossExponent ?? o.defaultPathLossExponent
    })
  }
  return out
}

/** The venue with its beacon list replaced by the stored beacons */
export function withStoredBeacons(venue: VenueConfig, rows: StoredBeacon[], options?: Partial<BeaconRegistryOptions>): VenueConfig {
  return { ...venue, beacons: toBeaconRegistry(rows, venue, options) }
}
