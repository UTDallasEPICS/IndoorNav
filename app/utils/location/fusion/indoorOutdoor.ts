// Decides whether the user is indoors, and in which building, from three clues:
//   1. the position is inside a building footprint
//   2. registered BLE beacons are being heard (the BLE provider produced a fix recently)
//   3. GPS is weak or missing (good GPS usually means open sky)
// Two of three clues decide. The answer only flips after it has held for `switchAfterMs`,
// so walking past a doorway doesn't make the state flap.

import { pointInPolygon, type Point2 } from '../geo/polygon'

export interface IndoorOutdoorOptions {
  /** How long a new answer must hold before the state switches (ms) */
  switchAfterMs: number
  /** BLE counts as visible if it produced a fix within this window (ms) */
  bleVisibleForMs: number
  /** GPS counts as good if a reading within `gpsFreshForMs` had accuracy at or below this (m) */
  gpsGoodAccuracyM: number
  gpsFreshForMs: number
}

export const DEFAULT_INDOOR_OUTDOOR: IndoorOutdoorOptions = {
  switchAfterMs: 3000,
  bleVisibleForMs: 3000,
  gpsGoodAccuracyM: 10,
  gpsFreshForMs: 3000
}

export interface IndoorOutdoorState {
  isIndoor: boolean
  buildingId: string | null
}

export class IndoorOutdoorDetector {
  private lastBle: { timestamp: number, buildingId: string | null } | null = null
  private lastGps: { timestamp: number, accuracyM: number } | null = null
  private current: IndoorOutdoorState | null = null
  private pendingSince: number | null = null

  constructor(
    private footprints: Array<{ buildingId: string, polygon: Point2[] }>,
    private options: IndoorOutdoorOptions = DEFAULT_INDOOR_OUTDOOR
  ) {}

  noteBle(timestamp: number, buildingId: string | null) {
    this.lastBle = { timestamp, buildingId }
  }

  noteGps(timestamp: number, accuracyM: number) {
    this.lastGps = { timestamp, accuracyM }
  }

  bleVisible(now: number): boolean {
    return this.lastBle !== null && now - this.lastBle.timestamp <= this.options.bleVisibleForMs
  }

  /** Re-evaluates at time `now` using the latest position, and returns the (hysteresis-filtered) state. */
  update(position: Point2, now: number): IndoorOutdoorState {
    const footprintBuilding = this.footprints.find((f) => pointInPolygon(position, f.polygon))?.buildingId ?? null
    const bleVisible = this.bleVisible(now)
    const gpsGood = this.lastGps !== null
      && now - this.lastGps.timestamp <= this.options.gpsFreshForMs
      && this.lastGps.accuracyM <= this.options.gpsGoodAccuracyM

    const clues = (footprintBuilding ? 1 : 0) + (bleVisible ? 1 : 0) + (gpsGood ? 0 : 1)
    const isIndoor = clues >= 2
    const buildingId = isIndoor
      ? (bleVisible ? this.lastBle!.buildingId : null) ?? footprintBuilding ?? this.current?.buildingId ?? null
      : null

    if (this.current === null) {
      // First answer is taken immediately
      this.current = { isIndoor, buildingId }
    } else if (isIndoor !== this.current.isIndoor) {
      this.pendingSince ??= now
      if (now - this.pendingSince >= this.options.switchAfterMs) {
        this.current = { isIndoor, buildingId }
        this.pendingSince = null
      }
    } else {
      this.pendingSince = null
      // Same indoor/outdoor answer: still allow moving between connected buildings
      if (isIndoor && buildingId) this.current = { isIndoor, buildingId }
    }
    return { ...this.current }
  }

  reset() {
    this.lastBle = null
    this.lastGps = null
    this.current = null
    this.pendingSince = null
  }
}
