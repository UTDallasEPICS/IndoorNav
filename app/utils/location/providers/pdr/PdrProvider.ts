// Pedestrian dead reckoning: accelerometer -> steps, compass -> heading. Emits each step (length + true heading)
// and a few times a second the motion state (moving or not, smoothed heading). It never emits positions: the
// FusionEngine moves its estimate by each step and lets BLE fixes correct the drift.

import { Emitter } from '../../emitter'
import type { MotionState, PdrStep, ProviderStatus, VenueConfig } from '../../types'
import { HeadingSmoother, wrapDeg } from './heading'
import type { AccelSample, CompassSample, MotionSource } from './motionSource'
import { DEFAULT_STEP_DETECTOR, StepDetector, type StepDetectorOptions } from './stepDetector'

export interface PdrProviderOptions {
  stepDetector: StepDetectorOptions
  /** Compass smoothing time constant (ms). Longer is steadier but turns later. */
  headingSmoothingMs: number
  /** Heading error to assume when the OS gives none (degrees). Indoors, steel and wiring bend the field. */
  defaultHeadingAccuracyDeg: number
  /** Count as standing still once no step has been seen for this long (ms) */
  movingTimeoutMs: number
  /** How often to send the motion state (ms) */
  stateIntervalMs: number
  /** Ignore a compass that hasn't reported for this long (ms) */
  compassStaleMs: number
}

export const DEFAULT_PDR_OPTIONS: PdrProviderOptions = {
  stepDetector: DEFAULT_STEP_DETECTOR,
  headingSmoothingMs: 300,
  defaultHeadingAccuracyDeg: 20,
  movingTimeoutMs: 1500,
  stateIntervalMs: 250,
  compassStaleMs: 2000
}

export class PdrProvider {
  readonly id = 'pdr' as const
  private options: PdrProviderOptions
  private steps = new Emitter<PdrStep>()
  private states = new Emitter<MotionState>()
  private statuses = new Emitter<ProviderStatus>()
  private detector: StepDetector
  private heading: HeadingSmoother
  private headingAccuracyDeg: number
  private declinationDeg = 0
  private lastStepTime = -Infinity
  private lastStateTime = -Infinity
  private wasMoving = false

  constructor(private source: MotionSource, options: Partial<PdrProviderOptions> = {}) {
    this.options = { ...DEFAULT_PDR_OPTIONS, ...options }
    this.detector = new StepDetector(this.options.stepDetector)
    this.heading = new HeadingSmoother(this.options.headingSmoothingMs)
    this.headingAccuracyDeg = this.options.defaultHeadingAccuracyDeg
  }

  onStep(listener: (step: PdrStep) => void) { return this.steps.on(listener) }
  onMotion(listener: (state: MotionState) => void) { return this.states.on(listener) }
  onStatus(listener: (status: ProviderStatus) => void) { return this.statuses.on(listener) }

  async start(venue: VenueConfig) {
    this.declinationDeg = venue.magneticDeclinationDeg ?? 0
    this.detector.reset()
    this.heading.reset()
    this.lastStepTime = -Infinity
    this.lastStateTime = -Infinity
    this.wasMoving = false
    this.statuses.emit({ provider: this.id, state: 'starting' })
    try {
      await this.source.start((sample) => this.handleAccel(sample), (sample) => this.handleCompass(sample))
      this.statuses.emit({ provider: this.id, state: 'running' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const state = /permission|denied|unauthori[sz]ed/i.test(message) ? 'permission-denied' : 'unavailable'
      this.statuses.emit({ provider: this.id, state, message })
    }
  }

  async stop() {
    await this.source.stop()
    this.statuses.emit({ provider: this.id, state: 'idle' })
  }

  handleAccel(sample: AccelSample) {
    const step = this.detector.add(sample)
    if (step) {
      this.lastStepTime = step.timestamp
      this.steps.emit({ timestamp: sample.timestamp, lengthM: step.lengthM, ...this.currentHeading(sample.timestamp) })
    }
    this.maybeEmitState(sample.timestamp)
  }

  handleCompass(sample: CompassSample) {
    this.heading.add(wrapDeg(sample.headingDeg + this.declinationDeg), sample.timestamp)
    this.headingAccuracyDeg = sample.accuracyDeg ?? this.options.defaultHeadingAccuracyDeg
    this.maybeEmitState(sample.timestamp)
  }

  private currentHeading(now: number) {
    const fresh = this.heading.timestamp !== null && now - this.heading.timestamp <= this.options.compassStaleMs
    return { headingDeg: fresh ? this.heading.headingDeg : null, headingAccuracyDeg: this.headingAccuracyDeg }
  }

  /** Sends the motion state every stateIntervalMs, and at once when walking starts or stops. */
  private maybeEmitState(now: number) {
    const isMoving = now - this.lastStepTime <= this.options.movingTimeoutMs
    if (isMoving === this.wasMoving && now - this.lastStateTime < this.options.stateIntervalMs) return
    this.wasMoving = isMoving
    this.lastStateTime = now
    this.states.emit({ timestamp: now, isMoving, ...this.currentHeading(now) })
  }
}
