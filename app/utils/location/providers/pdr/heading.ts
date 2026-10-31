// Compass heading helpers: tilt-compensated heading from W3C device orientation angles, and a smoother that
// averages angles on the circle (so 359° and 1° average to 0°, not 180°).

const RAD = Math.PI / 180

/** Wraps an angle into [0, 360). */
export const wrapDeg = (deg: number) => ((deg % 360) + 360) % 360

/**
 * Heading (degrees clockwise from north) of where the phone points, from absolute DeviceOrientation angles
 * (alpha about z, beta about x, gamma about y, earth frame east/north/up). Uses the sum of the phone's top (+y)
 * and back (-z) directions, so it works whether the phone is held flat, tilted, or upright like a camera.
 * Null when the phone faces straight up or down and has no horizontal direction.
 */
export function headingFromOrientation(alphaDeg: number, betaDeg: number, gammaDeg: number): number | null {
  const sZ = Math.sin(alphaDeg * RAD), cZ = Math.cos(alphaDeg * RAD)
  const sX = Math.sin(betaDeg * RAD), cX = Math.cos(betaDeg * RAD)
  const sY = Math.sin(gammaDeg * RAD), cY = Math.cos(gammaDeg * RAD)
  // Columns of R = Rz(alpha) Rx(beta) Ry(gamma): device y axis, plus minus the device z axis
  const e = -cX * sZ - (cY * sZ * sX + cZ * sY)
  const n = cZ * cX - (sZ * sY - cZ * cY * sX)
  if (Math.hypot(e, n) < 1e-3) return null
  return wrapDeg(Math.atan2(e, n) / RAD)
}

/** Exponential smoothing of a heading on the circle. */
export class HeadingSmoother {
  private e = 0
  private n = 0
  private lastTimestamp: number | null = null

  constructor(private timeConstantMs: number) {}

  add(headingDeg: number, timestamp: number) {
    const e = Math.sin(headingDeg * RAD)
    const n = Math.cos(headingDeg * RAD)
    if (this.lastTimestamp === null) {
      this.e = e
      this.n = n
    } else {
      const k = 1 - Math.exp(-Math.max(timestamp - this.lastTimestamp, 0) / this.timeConstantMs)
      this.e += k * (e - this.e)
      this.n += k * (n - this.n)
    }
    this.lastTimestamp = timestamp
  }

  /** Smoothed heading, or null before the first reading */
  get headingDeg(): number | null {
    if (this.lastTimestamp === null || Math.hypot(this.e, this.n) < 1e-6) return null
    return wrapDeg(Math.atan2(this.e, this.n) / RAD)
  }

  get timestamp() {
    return this.lastTimestamp
  }

  reset() {
    this.lastTimestamp = null
  }
}
