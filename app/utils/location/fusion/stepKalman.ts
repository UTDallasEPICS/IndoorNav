// Position filter driven by PDR steps, corrected by BLE fixes. Used instead of ConstantVelocityKalman while the
// motion sensors are running.
//
// - Each step moves the estimate by its length along the compass heading, and adds that step's uncertainty
//   (length error along the step, heading error across it).
// - Between steps the position barely drifts, so BLE noise can't drag the dot around. Standing still, BLE fixes
//   are down-weighted further and the estimate becomes a running average of every fix since you stopped.
// - A BLE fix far outside the filter's uncertainty (multipath, a body in the way) is dropped. If several in a row
//   are dropped, the filter assumes it's the one that's lost and restarts at their average.

import type { PositionFilter } from './kalman'

export interface StepKalmanOptions {
  /** Position random-walk noise between steps while walking (m^2/s): covers missed steps */
  movingNoise: number
  /** Position random-walk noise while standing still (m^2/s). Small, so BLE averages out instead of moving the dot. */
  stationaryNoise: number
  /** BLE variance multiplier while standing still. Higher trusts PDR's "you haven't moved" more. */
  stationaryMeasurementScale: number
  /** 1-sigma step length error as a fraction of the step */
  stepLengthError: number
  /** Gate: drop BLE fixes whose squared Mahalanobis distance exceeds this (2 dof: 13.8 ~ 99.9%) */
  gateChi2: number
  /** Restart at the average of this many dropped fixes in a row */
  relocalizeAfter: number
  /** Restart from the next fix after this long without any input (ms) */
  maxGapMs: number
}

export const DEFAULT_STEP_KALMAN: StepKalmanOptions = {
  movingNoise: 0.15,
  stationaryNoise: 0.01,
  stationaryMeasurementScale: 4,
  stepLengthError: 0.15,
  gateChi2: 13.8,
  relocalizeAfter: 4,
  maxGapMs: 10000
}

const RAD = Math.PI / 180

export class StepKalman implements PositionFilter {
  private e = 0
  private n = 0
  /** Covariance [[pee, pen], [pen, pnn]] */
  private pee = 0
  private pen = 0
  private pnn = 0
  private lastTimestamp: number | null = null
  private moving = false
  private rejected: Array<{ e: number, n: number, r: number }> = []

  constructor(private options: StepKalmanOptions = DEFAULT_STEP_KALMAN) {}

  /** Starts at a known position with a 1-sigma horizontal accuracy */
  seed(e: number, n: number, accuracyM: number, timestamp: number) {
    this.e = e
    this.n = n
    this.pee = this.pnn = (accuracyM * accuracyM) / 2
    this.pen = 0
    this.lastTimestamp = timestamp
    this.rejected = []
  }

  /** Whether the user is walking, from the motion sensors. Changes how much BLE fixes and time move the estimate. */
  setMoving(moving: boolean) {
    this.moving = moving
  }

  /** Moves the estimate by one step. headingDeg is clockwise from true north; null adds uncertainty only. */
  step(lengthM: number, headingDeg: number | null, headingAccuracyDeg: number, timestamp: number) {
    if (this.lastTimestamp === null) return
    this.moving = true
    this.predictTo(timestamp)
    if (headingDeg === null) {
      // No direction: the step happened somewhere within a circle of its length
      this.pee += lengthM * lengthM / 2
      this.pnn += lengthM * lengthM / 2
      return
    }
    const ue = Math.sin(headingDeg * RAD)
    const un = Math.cos(headingDeg * RAD)
    this.e += lengthM * ue
    this.n += lengthM * un
    const along = (this.options.stepLengthError * lengthM) ** 2
    const across = (lengthM * Math.sin(Math.min(headingAccuracyDeg, 90) * RAD)) ** 2
    // along * u u^T + across * u_perp u_perp^T, with u_perp = (un, -ue)
    this.pee += along * ue * ue + across * un * un
    this.pen += (along - across) * ue * un
    this.pnn += along * un * un + across * ue * ue
  }

  update(e: number, n: number, accuracyM: number, timestamp: number) {
    const r = (accuracyM * accuracyM) / 2 * (this.moving ? 1 : this.options.stationaryMeasurementScale)
    if (this.lastTimestamp === null || timestamp - this.lastTimestamp > this.options.maxGapMs) {
      this.seed(e, n, accuracyM, timestamp)
      return
    }
    this.predictTo(timestamp)

    const de = e - this.e
    const dn = n - this.n
    const see = this.pee + r
    const snn = this.pnn + r
    const sen = this.pen
    const det = see * snn - sen * sen
    const d2 = (snn * de * de - 2 * sen * de * dn + see * dn * dn) / det
    if (d2 > this.options.gateChi2) {
      this.rejected.push({ e, n, r })
      if (this.rejected.length >= this.options.relocalizeAfter) this.relocalize()
      return
    }
    this.rejected = []

    // K = P S^-1
    const ie = snn / det, ien = -sen / det, inn = see / det
    const kee = this.pee * ie + this.pen * ien
    const ken = this.pee * ien + this.pen * inn
    const kne = this.pen * ie + this.pnn * ien
    const knn = this.pen * ien + this.pnn * inn
    this.e += kee * de + ken * dn
    this.n += kne * de + knn * dn
    // P = (I - K) P
    const pee = (1 - kee) * this.pee - ken * this.pen
    const pen = (1 - kee) * this.pen - ken * this.pnn
    const pnn = -kne * this.pen + (1 - knn) * this.pnn
    this.pee = pee
    this.pen = pen
    this.pnn = pnn
  }

  /** Advances to `timestamp` without a step or fix, so the uncertainty keeps growing between them. */
  predict(timestamp: number) {
    if (this.lastTimestamp === null) return
    this.predictTo(timestamp)
  }

  state() {
    if (this.lastTimestamp === null) return null
    return { e: this.e, n: this.n, ve: 0, vn: 0, accuracyM: Math.sqrt(this.pee + this.pnn) }
  }

  reset() {
    this.lastTimestamp = null
    this.rejected = []
  }

  private predictTo(timestamp: number) {
    const dt = (timestamp - this.lastTimestamp!) / 1000
    if (dt <= 0) return
    const q = (this.moving ? this.options.movingNoise : this.options.stationaryNoise) * dt
    this.pee += q
    this.pnn += q
    this.lastTimestamp = timestamp
  }

  /** Several fixes in a row disagree with us, so we're probably the one that's lost: restart at their weighted average. */
  private relocalize() {
    let w = 0, e = 0, n = 0
    for (const fix of this.rejected) {
      w += 1 / fix.r
      e += fix.e / fix.r
      n += fix.n / fix.r
    }
    this.e = e / w
    this.n = n / w
    this.pee = this.pnn = this.rejected.length / w
    this.pen = 0
    this.rejected = []
  }
}
