/** One barometer reading */
export interface PressureSample {
  /** Air pressure in hectopascals (hPa) */
  pressureHpa: number
  /** Milliseconds since the Unix epoch */
  timestamp: number
}

/** The platform barometer, kept behind an interface so the provider can run with a mock in Node. */
export interface PressureSource {
  /** Starts listening. Rejects if the phone has no barometer or permission is denied. */
  start(onSample: (sample: PressureSample) => void): Promise<void>
  stop(): Promise<void>
}

/** Source for tests and the simulator: call `emit` to deliver readings. */
export class MockPressureSource implements PressureSource {
  private onSample: ((sample: PressureSample) => void) | null = null
  failWith: Error | null = null

  async start(onSample: (sample: PressureSample) => void) {
    if (this.failWith) throw this.failWith
    this.onSample = onSample
  }

  async stop() {
    this.onSample = null
  }

  emit(sample: PressureSample) {
    this.onSample?.(sample)
  }
}
