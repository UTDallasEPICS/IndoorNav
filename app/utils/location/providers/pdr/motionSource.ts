/** One accelerometer reading, gravity included, in the phone's own axes (m/s^2). */
export interface AccelSample {
  x: number
  y: number
  z: number
  /** Milliseconds since the Unix epoch */
  timestamp: number
}

/** One compass reading: where the top of the phone points. */
export interface CompassSample {
  /** Degrees clockwise from **magnetic** north. The provider adds the venue's declination. */
  headingDeg: number
  /** The OS's own accuracy estimate in degrees, if it gives one (iOS does) */
  accuracyDeg: number | null
  timestamp: number
}

/** Platform motion sensors, kept behind an interface so the provider can run with a mock in Node. */
export interface MotionSource {
  /** Starts listening. Rejects if permission is denied or the sensors are missing. */
  start(onAccel: (sample: AccelSample) => void, onCompass: (sample: CompassSample) => void): Promise<void>
  stop(): Promise<void>
}

/** Source for tests and the simulator: call `emitAccel` / `emitCompass` to deliver readings. */
export class MockMotionSource implements MotionSource {
  private onAccel: ((sample: AccelSample) => void) | null = null
  private onCompass: ((sample: CompassSample) => void) | null = null
  failWith: Error | null = null

  async start(onAccel: (sample: AccelSample) => void, onCompass: (sample: CompassSample) => void) {
    if (this.failWith) throw this.failWith
    this.onAccel = onAccel
    this.onCompass = onCompass
  }

  async stop() {
    this.onAccel = null
    this.onCompass = null
  }

  emitAccel(sample: AccelSample) {
    this.onAccel?.(sample)
  }

  emitCompass(sample: CompassSample) {
    this.onCompass?.(sample)
  }
}
