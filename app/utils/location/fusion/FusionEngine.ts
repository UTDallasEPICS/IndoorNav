// Combines fixes from all providers into one smoothed LocationFix stream, and emits building/floor events.
//
// Baseline policy:
//   - Indoors, BLE (or Mist) fixes drive the position. GPS is only used if no beacons are heard.
//   - Outdoors, GPS fixes drive the position.
//   - Every fix still feeds the indoor/outdoor detector.

import { Emitter } from '../emitter'
import { enuToWgs84 } from '../geo/wgs84'
import { indexVenue, type VenueIndex } from '../venue'
import type { LocationEvent, LocationFix, VenueConfig } from '../types'
import { DEFAULT_INDOOR_OUTDOOR, IndoorOutdoorDetector, type IndoorOutdoorOptions } from './indoorOutdoor'
import { ConstantVelocityKalman, DEFAULT_KALMAN, type KalmanOptions, type PositionFilter } from './kalman'

export interface FusionOptions {
  kalman: KalmanOptions
  indoorOutdoor: IndoorOutdoorOptions
  /** Below this speed (m/s) the heading is taken from the provider instead of the velocity */
  minSpeedForHeading: number
}

export const DEFAULT_FUSION: FusionOptions = {
  kalman: DEFAULT_KALMAN,
  indoorOutdoor: DEFAULT_INDOOR_OUTDOOR,
  minSpeedForHeading: 0.5
}

export class FusionEngine {
  private options: FusionOptions
  private index: VenueIndex
  private filter: PositionFilter
  private detector: IndoorOutdoorDetector
  private fixes = new Emitter<LocationFix>()
  private events = new Emitter<LocationEvent>()
  private isIndoor: boolean | null = null
  private buildingId: string | null = null
  private floorId: string | null = null

  constructor(venue: VenueConfig, options: Partial<FusionOptions> = {}) {
    this.options = { ...DEFAULT_FUSION, ...options }
    this.index = indexVenue(venue)
    this.filter = new ConstantVelocityKalman(this.options.kalman)
    this.detector = new IndoorOutdoorDetector(this.index.footprints, this.options.indoorOutdoor)
  }

  onFix(listener: (fix: LocationFix) => void) { return this.fixes.on(listener) }
  onEvent(listener: (event: LocationEvent) => void) { return this.events.on(listener) }

  ingest(fix: LocationFix) {
    switch (fix.source) {
      case 'ble':
      case 'mist': // A future Mist SDK provider gives absolute indoor fixes, like BLE
        this.detector.noteBle(fix.timestamp, fix.buildingId)
        break
      case 'gps':
        this.detector.noteGps(fix.timestamp, fix.accuracyM)
        break
      case 'pdr':
        // EXTENSION POINT (PDR): step length + heading give a relative move, not an absolute position.
        // Apply it as the filter's prediction step (add a `predict(de, dn, timestamp)` method to
        // PositionFilter) so BLE fixes correct the dead-reckoned track between scans.
        return
      case 'fused':
        return
    }

    const state = this.detector.update(fix.enu, fix.timestamp)
    const floorId = state.isIndoor ? (fix.floorId ?? this.floorId) : null
    this.updateState(state.isIndoor, state.buildingId, floorId, fix.timestamp)

    const useFix = fix.source === 'gps'
      ? !state.isIndoor || !this.detector.bleVisible(fix.timestamp)
      : state.isIndoor
    if (!useFix) return

    this.filter.update(fix.enu.e, fix.enu.n, fix.accuracyM, fix.timestamp)
    const filtered = this.filter.state()!
    const speed = Math.hypot(filtered.ve, filtered.vn)
    const headingDeg = speed >= this.options.minSpeedForHeading
      ? (Math.atan2(filtered.ve, filtered.vn) * 180 / Math.PI + 360) % 360
      : fix.headingDeg

    // Indoors the height is the floor's; outdoors height isn't tracked, so use the campus origin (u = 0)
    const u = this.floorId ? this.index.floors.get(this.floorId)?.floor.transform.floorZ ?? 0 : 0
    const enu = { e: filtered.e, n: filtered.n, u }
    this.fixes.emit({
      enu,
      wgs84: enuToWgs84(enu, this.index.venue.origin),
      floorId: this.floorId,
      buildingId: this.buildingId,
      accuracyM: filtered.accuracyM,
      ...(headingDeg !== undefined && { headingDeg }),
      timestamp: fix.timestamp,
      source: 'fused',
      isIndoor: state.isIndoor
    })
  }

  reset() {
    this.filter.reset()
    this.detector.reset()
    this.isIndoor = null
    this.buildingId = null
    this.floorId = null
  }

  /** Stores the new indoor/building/floor state and emits an event for each change. */
  private updateState(isIndoor: boolean, buildingId: string | null, floorId: string | null, timestamp: number) {
    if (this.isIndoor !== null && isIndoor !== this.isIndoor) {
      this.events.emit({ type: 'indoorOutdoorTransition', isIndoor, timestamp })
    }
    this.isIndoor = isIndoor

    if (buildingId !== this.buildingId) {
      if (this.buildingId) this.events.emit({ type: 'buildingExited', buildingId: this.buildingId, timestamp })
      if (buildingId) this.events.emit({ type: 'buildingEntered', buildingId, timestamp })
      this.buildingId = buildingId
    }

    if (floorId !== this.floorId) {
      this.events.emit({ type: 'floorChanged', from: this.floorId, to: floorId, timestamp })
      this.floorId = floorId
    }
  }
}
