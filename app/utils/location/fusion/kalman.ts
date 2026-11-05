// 2D constant-velocity Kalman filter in ENU. East and north are filtered independently (they don't
// interact in a constant-velocity model with round accuracy circles), which keeps the math to 2x2.

/**
 * Anything that turns noisy absolute positions into a smooth track.
 * EXTENSION POINT (particle filter): a ParticleFilter implementing this interface can replace the Kalman
 * filter in FusionEngine; it could also use the floor grid to reject positions inside walls.
 */
export interface PositionFilter {
  /** Adds a position measurement with a 1-sigma horizontal accuracy (meters) */
  update(e: number, n: number, accuracyM: number, timestamp: number): void
  /** Current estimate, or null before the first measurement */
  state(): { e: number, n: number, ve: number, vn: number, accuracyM: number } | null
  reset(): void
}

export interface KalmanOptions {
  /** Acceleration noise (m^2/s^3). Higher follows turns faster but smooths less. ~1 suits walking. */
  accelerationNoise: number
  /** Initial velocity variance (m^2/s^2) */
  initialVelocityVariance: number
  /** Restart from the next measurement after a gap this long (ms) */
  maxGapMs: number
}

export const DEFAULT_KALMAN: KalmanOptions = {
  accelerationNoise: 1,
  initialVelocityVariance: 1,
  maxGapMs: 10000
}

/** Position + velocity along one axis, with its 2x2 covariance. */
class Axis {
  p = 0
  v = 0
  pp = 0
  pv = 0
  vv = 0

  init(z: number, r: number, vv: number) {
    this.p = z
    this.v = 0
    this.pp = r
    this.pv = 0
    this.vv = vv
  }

  predict(dt: number, q: number) {
    this.p += this.v * dt
    this.pp += 2 * dt * this.pv + dt * dt * this.vv + (q * dt ** 3) / 3
    this.pv += dt * this.vv + (q * dt ** 2) / 2
    this.vv += q * dt
  }

  update(z: number, r: number) {
    const s = this.pp + r
    const kp = this.pp / s
    const kv = this.pv / s
    const innovation = z - this.p
    this.p += kp * innovation
    this.v += kv * innovation
    this.vv -= kv * this.pv
    this.pv *= 1 - kp
    this.pp *= 1 - kp
  }
}

export class ConstantVelocityKalman implements PositionFilter {
  private east = new Axis()
  private north = new Axis()
  private lastTimestamp: number | null = null

  constructor(private options: KalmanOptions = DEFAULT_KALMAN) {}

  update(e: number, n: number, accuracyM: number, timestamp: number) {
    // accuracyM is a horizontal radius; split its variance between the two axes
    const r = (accuracyM * accuracyM) / 2
    const dt = this.lastTimestamp === null ? Infinity : (timestamp - this.lastTimestamp) / 1000
    if (dt * 1000 > this.options.maxGapMs) {
      this.east.init(e, r, this.options.initialVelocityVariance)
      this.north.init(n, r, this.options.initialVelocityVariance)
    } else {
      if (dt > 0) {
        this.east.predict(dt, this.options.accelerationNoise)
        this.north.predict(dt, this.options.accelerationNoise)
      }
      this.east.update(e, r)
      this.north.update(n, r)
    }
    this.lastTimestamp = Math.max(timestamp, this.lastTimestamp ?? timestamp)
  }

  state() {
    if (this.lastTimestamp === null) return null
    return {
      e: this.east.p,
      n: this.north.p,
      ve: this.east.v,
      vn: this.north.v,
      accuracyM: Math.sqrt(this.east.pp + this.north.pp)
    }
  }

  reset() {
    this.lastTimestamp = null
  }
}
