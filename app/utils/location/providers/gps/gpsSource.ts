/** One position from the phone's GNSS/OS location service. */
export interface GpsReading {
  lat: number
  lon: number
  /** Altitude in meters, or null if unknown. See README: iOS reports it above sea level, not the ellipsoid. */
  altitude: number | null
  /** Horizontal accuracy radius in meters, as reported by the OS */
  accuracyM: number
  headingDeg: number | null
  timestamp: number
}

/** Platform location updates, kept behind an interface so the provider can run with a mock in Node. */
export interface GpsSource {
  /** Starts watching. Rejects if permission is denied or location services are off. */
  start(onReading: (reading: GpsReading) => void): Promise<void>
  stop(): Promise<void>
}

/** Source for tests and the simulator: call `emit` to deliver readings. */
export class MockGpsSource implements GpsSource {
  private listener: ((reading: GpsReading) => void) | null = null
  failWith: Error | null = null

  async start(onReading: (reading: GpsReading) => void) {
    if (this.failWith) throw this.failWith
    this.listener = onReading
  }

  async stop() {
    this.listener = null
  }

  emit(reading: GpsReading) {
    this.listener?.(reading)
  }
}
