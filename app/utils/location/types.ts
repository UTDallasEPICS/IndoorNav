// Shared types for the location module. See README.md in this folder for the coordinate model.

/** Geodetic position on the WGS84 ellipsoid. Degrees, and meters above the ellipsoid (not sea level). */
export interface Wgs84 {
  lat: number
  lon: number
  h: number
}

/** Earth-centered, Earth-fixed position in meters. */
export interface Ecef {
  x: number
  y: number
  z: number
}

/** Local East-North-Up position in meters, relative to the venue's campus origin. */
export interface Enu {
  e: number
  n: number
  u: number
}

/** A point on a floor plan image or grid: x to the right, y down, in pixels or grid cells. */
export interface PlanPoint {
  x: number
  y: number
}

export type FixSource = 'ble' | 'pdr' | 'gps' | 'fused' | 'mist'

/** One position estimate. Every fix the module emits uses this shape. */
export interface LocationFix {
  enu: Enu
  wgs84: Wgs84
  /** null when outdoors or when the floor is unknown */
  floorId: string | null
  buildingId: string | null
  /** Roughly a 1-sigma horizontal error radius, in meters */
  accuracyM: number
  /** Compass bearing in degrees clockwise from true north, if known */
  headingDeg?: number
  /** Milliseconds since the Unix epoch */
  timestamp: number
  source: FixSource
  isIndoor: boolean
}

/** A fix as the app uses it: where on which floor's map, and how sure. See `toMapPosition`. */
export interface MapPosition {
  /** Fractions (0–1) of the floor's map SVG width and height, from the top-left */
  x: number
  y: number
  /** Ordinal floor level (`Floor.level`), e.g. 1 for SPN1 level 1 */
  floor: number
  /** Margin of error: roughly a 1-sigma horizontal radius, in meters */
  accuracyM: number
  /** Milliseconds since the Unix epoch */
  timestamp: number
}

export type ProviderId = 'ble' | 'gps'

export interface ProviderStatus {
  provider: ProviderId
  state: 'idle' | 'starting' | 'running' | 'unavailable' | 'permission-denied' | 'error'
  /** Human-readable detail, e.g. the error message */
  message?: string
}

export type LocationEvent =
  | { type: 'floorChanged', from: string | null, to: string | null, timestamp: number }
  | { type: 'buildingEntered', buildingId: string, timestamp: number }
  | { type: 'buildingExited', buildingId: string, timestamp: number }
  | { type: 'indoorOutdoorTransition', isIndoor: boolean, timestamp: number }

/**
 * Maps floor plan coordinates to ENU. The plan's (0, 0) corner sits at `origin`, the plan is scaled by
 * `scale` meters per plan unit, and rotated so that the plan's "up" direction points at compass bearing
 * `rotationDeg` (0 = plan up is north, 90 = plan up is east).
 */
export interface FloorTransform {
  floorId: string
  /** ENU position (meters) of plan point (0, 0), the top-left corner of the image/grid */
  origin: { e: number, n: number }
  rotationDeg: number
  /** Meters per plan unit (pixel or grid cell) */
  scale: number
  /** ENU height (u) of this floor's walking surface, in meters */
  floorZ: number
}

export interface Floor {
  id: string
  name: string
  /** Ordinal level, e.g. 1 for the ground floor */
  level: number
  transform: FloorTransform
  /**
   * Size of this floor's map SVG in plan units. Needed to report positions as fractions (0–1) of the map,
   * the app's coordinate convention (see CLAUDE.md). Floors without it get no MapPosition.
   */
  plan?: { width: number, height: number }
}

export interface Building {
  id: string
  name: string
  /** Outline of the building as a closed polygon (first point not repeated) */
  footprint: Array<{ lat: number, lon: number }>
  floors: Floor[]
}

/** A fixed BLE beacon (here: the Eddystone-UID beacon in a Wi-Fi AP). */
export interface BeaconRegistryEntry {
  /** Eddystone-UID as "<namespace hex>:<instance hex>", lowercase */
  id: string
  /** Beacon position in ENU meters. `u` is the mounting height (e.g. ceiling). */
  enu: Enu
  floorId: string
  /** Expected RSSI in dBm at 1 m from the beacon */
  txPower: number
  /** Log-distance path loss exponent: ~2 in open space, 2.5-4 with walls and people */
  pathLossExponent: number
}

export interface VenueConfig {
  id: string
  name: string
  /** WGS84 anchor of the campus ENU frame. All ENU coordinates in this config are relative to it. */
  origin: Wgs84
  buildings: Building[]
  beacons: BeaconRegistryEntry[]
}
