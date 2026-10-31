// Step detection from the accelerometer (no gyroscope, per the ADR). Each step is a bump in the acceleration
// magnitude: we low-pass it, subtract a slow running mean (gravity), and count a step each time the signal rises
// above a threshold and falls back through the mean. Step length comes from the bump's size (Weinberg).

import type { AccelSample } from './motionSource'

export interface StepDetectorOptions {
  /** How far the smoothed magnitude must rise above its running mean to count as a step (m/s^2) */
  thresholdMs2: number
  /** Ignore peaks closer together than this (ms); fast walking is ~2.5 steps/s */
  minStepIntervalMs: number
  /** Low-pass time constant for the magnitude (ms), removes hand shake */
  smoothingMs: number
  /** Time constant of the running mean that stands in for gravity (ms) */
  gravityMs: number
  /** Weinberg constant: step length = K * (max - min)^(1/4), with max/min in m/s^2 */
  weinbergK: number
  minStepLengthM: number
  maxStepLengthM: number
}

export const DEFAULT_STEP_DETECTOR: StepDetectorOptions = {
  thresholdMs2: 1.2,
  minStepIntervalMs: 280,
  smoothingMs: 60,
  gravityMs: 1500,
  weinbergK: 0.45,
  minStepLengthM: 0.35,
  maxStepLengthM: 1.0
}

export interface DetectedStep {
  /** Time of the step's peak */
  timestamp: number
  lengthM: number
}

export class StepDetector {
  private options: StepDetectorOptions
  private smoothed: number | null = null
  private gravity = 0
  private lastTimestamp = 0
  private armed = false
  private peak = 0
  private peakTime = 0
  private trough = Infinity
  private lastStepTime = -Infinity

  constructor(options: Partial<StepDetectorOptions> = {}) {
    this.options = { ...DEFAULT_STEP_DETECTOR, ...options }
  }

  /** Feeds one sample in. Returns the step it completes, if any. */
  add(sample: AccelSample): DetectedStep | null {
    const magnitude = Math.hypot(sample.x, sample.y, sample.z)
    if (this.smoothed === null) {
      this.smoothed = magnitude
      this.gravity = magnitude
      this.lastTimestamp = sample.timestamp
      return null
    }
    const dt = Math.max(sample.timestamp - this.lastTimestamp, 0)
    this.lastTimestamp = sample.timestamp
    this.smoothed += (1 - Math.exp(-dt / this.options.smoothingMs)) * (magnitude - this.smoothed)
    this.gravity += (1 - Math.exp(-dt / this.options.gravityMs)) * (this.smoothed - this.gravity)
    const signal = this.smoothed - this.gravity

    if (!this.armed) {
      this.trough = Math.min(this.trough, this.smoothed)
      if (signal > this.options.thresholdMs2) {
        this.armed = true
        this.peak = this.smoothed
        this.peakTime = sample.timestamp
      }
      return null
    }

    if (this.smoothed > this.peak) {
      this.peak = this.smoothed
      this.peakTime = sample.timestamp
    }
    if (signal > 0) return null

    // Fell back through the mean: the bump is over
    this.armed = false
    const trough = Number.isFinite(this.trough) ? this.trough : this.gravity
    this.trough = this.smoothed
    if (this.peakTime - this.lastStepTime < this.options.minStepIntervalMs) return null
    this.lastStepTime = this.peakTime
    const { weinbergK, minStepLengthM, maxStepLengthM } = this.options
    const lengthM = Math.min(Math.max(weinbergK * Math.max(this.peak - trough, 0) ** 0.25, minStepLengthM), maxStepLengthM)
    return { timestamp: this.peakTime, lengthM }
  }

  reset() {
    this.smoothed = null
    this.armed = false
    this.trough = Infinity
    this.lastStepTime = -Infinity
  }
}
