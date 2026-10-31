// Combines fixes from all providers into one smoothed LocationFix stream, and emits building/floor events.
//
// Baseline policy:
//   - Indoors, BLE (or Mist) fixes drive the position. GPS is only used if no beacons are heard.
//   - Outdoors, GPS fixes drive the position.
//   - Every fix still feeds the indoor/outdoor detector.
//   - While the motion sensors run (PDR), steps move the estimate and BLE/GPS only correct it (StepKalman):
//     standing still, the dot stays put and BLE noise averages out. Without them, a constant-velocity Kalman
//     filter smooths the fixes on its own.

import { Emitter } from '../emitter'
import { enuToWgs84 } from '../geo/wgs84'
import { indexVenue, type VenueIndex } from '../venue'
import type { LocationEvent, LocationFix, MotionState, PdrStep, VenueConfig } from '../types'
import { DEFAULT_INDOOR_OUTDOOR, IndoorOutdoorDetector, type IndoorOutdoorOptions } from './indoorOutdoor'
import { ConstantVelocityKalman, DEFAULT_KALMAN, type KalmanOptions } from './kalman'
import { DEFAULT_STEP_KALMAN, StepKalman, type StepKalmanOptions } from './stepKalman'

export interface FusionOptions {
  kalman: KalmanOptions
  /** The filter used while motion sensors run */
  stepKalman: StepKalmanOptions
  indoorOutdoor: IndoorOutdoorOptions
  /** Below this speed (m/s) the heading is taken from the provider instead of the velocity */
  minSpeedForHeading: number
  /** Fall back to the constant-velocity filter once motion sensors have been silent this long (ms) */
  motionTimeoutMs: number
  /** Stop moving the dot on steps alone once no absolute fix has been used for this long (ms), so it can go stale */
  maxDeadReckoningMs: number
}

export const DEFAULT_FUSION: FusionOptions = {
  kalman: DEFAULT_KALMAN,
  stepKalman: DEFAULT_STEP_KALMAN,
  indoorOutdoor: DEFAULT_INDOOR_OUTDOOR,
  minSpeedForHeading: 0.5,
  motionTimeoutMs: 2000,
  maxDeadReckoningMs: 5000
}

export class FusionEngine {
  private options: FusionOptions
  private index: VenueIndex
  private filter: ConstantVelocityKalman
  private stepFilter: StepKalman
  private motion: MotionState | null = null
  /** Time of the last BLE/GPS fix the filters used */
  private lastAbsoluteFixTime: number | null = null
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
    this.stepFilter = new StepKalman(this.options.stepKalman)
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
      case 'pdr': // PDR is relative: it arrives through ingestStep / ingestMotion, not as fixes
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
    this.lastAbsoluteFixTime = fix.timestamp
    if (this.motionLive(fix.timestamp)) {
      const cv = this.filter.state()!
      if (!this.stepFilter.state()) {
        this.stepFilter.seed(cv.e, cv.n, cv.accuracyM, fix.timestamp)
      } else {
        this.stepFilter.setMoving(this.motion!.isMoving)
        this.stepFilter.update(fix.enu.e, fix.enu.n, fix.accuracyM, fix.timestamp)
      }
    } else {
      this.stepFilter.reset()
    }
    this.emitFix(fix.timestamp, fix.headingDeg)
  }

  /** One PDR step: moves the estimate along the step's heading. Ignored until an absolute fix has placed us. */
  ingestStep(step: PdrStep) {
    this.motion = { timestamp: step.timestamp, isMoving: true, headingDeg: step.headingDeg ?? this.motion?.headingDeg ?? null, headingAccuracyDeg: step.headingAccuracyDeg }
    if (!this.deadReckoning(step.timestamp)) return
    this.stepFilter.step(step.lengthM, step.headingDeg, step.headingAccuracyDeg, step.timestamp)
    this.emitFix(step.timestamp)
  }

  /** The motion sensors' state. Re-emits the position so the heading arrow follows the compass between fixes. */
  ingestMotion(state: MotionState) {
    this.motion = state
    this.stepFilter.setMoving(state.isMoving)
    if (!this.deadReckoning(state.timestamp)) return
    this.stepFilter.predict(state.timestamp) // the reported accuracy grows while only motion data arrives
    this.emitFix(state.timestamp)
  }

  private motionLive(timestamp: number) {
    return this.motion !== null && timestamp - this.motion.timestamp <= this.options.motionTimeoutMs
  }

  /**
   * Whether steps and compass may still move the dot: the step filter has been placed and an absolute fix was
   * used recently. Otherwise drop the step filter, so nothing is emitted until BLE places us again.
   */
  private deadReckoning(timestamp: number) {
    if (!this.stepFilter.state()) return false
    if (this.lastAbsoluteFixTime !== null && timestamp - this.lastAbsoluteFixTime <= this.options.maxDeadReckoningMs) return true
    this.stepFilter.reset()
    return false
  }

  private emitFix(timestamp: number, providerHeadingDeg?: number) {
    if (this.isIndoor === null) return
    const live = this.motionLive(timestamp)
    const filtered = (live && this.stepFilter.state()) || this.filter.state()
    if (!filtered) return
    const speed = Math.hypot(filtered.ve, filtered.vn)
    const headingDeg = live && this.motion!.headingDeg !== null
      ? this.motion!.headingDeg
      : speed >= this.options.minSpeedForHeading
        ? (Math.atan2(filtered.ve, filtered.vn) * 180 / Math.PI + 360) % 360
        : providerHeadingDeg

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
      timestamp,
      source: 'fused',
      isIndoor: this.isIndoor
    })
  }

  reset() {
    this.filter.reset()
    this.stepFilter.reset()
    this.motion = null
    this.lastAbsoluteFixTime = null
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
