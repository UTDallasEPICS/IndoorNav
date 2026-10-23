// Per-beacon RSSI smoothing: a sliding median removes spikes, then a 1D Kalman filter smooths the rest.

export interface RssiFilterOptions {
  /** Number of recent samples in the median window */
  medianWindow: number
  /** How much the true RSSI may drift per second (dB^2/s). Higher = follows changes faster. */
  processNoise: number
  /** Variance of one (median-filtered) reading, in dB^2 */
  measurementNoise: number
}

export const DEFAULT_RSSI_FILTER: RssiFilterOptions = {
  medianWindow: 5,
  processNoise: 4,
  measurementNoise: 16
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** Smooths the RSSI stream of a single beacon. */
export class RssiFilter {
  private window: number[] = []
  private estimate: number | null = null
  private variance = 0
  private lastTimestamp = 0

  constructor(private options: RssiFilterOptions = DEFAULT_RSSI_FILTER) {}

  /** Adds a reading and returns the filtered RSSI. */
  add(rssi: number, timestamp: number): number {
    this.window.push(rssi)
    if (this.window.length > this.options.medianWindow) this.window.shift()
    const z = median(this.window)

    if (this.estimate === null) {
      this.estimate = z
      this.variance = this.options.measurementNoise
    } else {
      // Predict: uncertainty grows with time since the last reading
      const dt = Math.max(0, (timestamp - this.lastTimestamp) / 1000)
      this.variance += this.options.processNoise * dt
      // Update
      const gain = this.variance / (this.variance + this.options.measurementNoise)
      this.estimate += gain * (z - this.estimate)
      this.variance *= 1 - gain
    }
    this.lastTimestamp = timestamp
    return this.estimate
  }
}

export interface BeaconReading {
  beaconId: string
  /** Filtered RSSI in dBm */
  rssi: number
  lastSeen: number
}

/** One RssiFilter per beacon, dropping beacons that haven't been heard recently. */
export class RssiFilterBank {
  private beacons = new Map<string, { filter: RssiFilter, reading: BeaconReading }>()

  constructor(
    private staleAfterMs = 4000,
    private options: RssiFilterOptions = DEFAULT_RSSI_FILTER
  ) {}

  add(beaconId: string, rssi: number, timestamp: number) {
    let entry = this.beacons.get(beaconId)
    if (!entry) {
      entry = { filter: new RssiFilter(this.options), reading: { beaconId, rssi, lastSeen: timestamp } }
      this.beacons.set(beaconId, entry)
    }
    entry.reading.rssi = entry.filter.add(rssi, timestamp)
    entry.reading.lastSeen = timestamp
  }

  /** Current filtered readings, after evicting beacons not heard within `staleAfterMs` of `now`. */
  readings(now: number): BeaconReading[] {
    for (const [id, entry] of this.beacons) {
      if (now - entry.reading.lastSeen > this.staleAfterMs) this.beacons.delete(id)
    }
    return [...this.beacons.values()].map((entry) => ({ ...entry.reading }))
  }

  clear() {
    this.beacons.clear()
  }
}
