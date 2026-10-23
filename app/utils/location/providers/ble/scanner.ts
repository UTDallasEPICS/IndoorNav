/** One received beacon advertisement. */
export interface BeaconAdvert {
  /** Eddystone-UID as "<namespace hex>:<instance hex>", matching BeaconRegistryEntry.id */
  beaconId: string
  rssi: number
  /** Milliseconds since the Unix epoch */
  timestamp: number
}

/** Platform BLE scanning, kept behind an interface so the provider can run with a mock in Node. */
export interface BleScanner {
  /** Starts scanning. Rejects if Bluetooth is off or permission is denied. */
  start(onAdvert: (advert: BeaconAdvert) => void): Promise<void>
  stop(): Promise<void>
}

/** Scanner for tests and the simulator: call `emit` to deliver adverts. */
export class MockBleScanner implements BleScanner {
  private listener: ((advert: BeaconAdvert) => void) | null = null
  /** Set to make start() reject, e.g. to test permission errors */
  failWith: Error | null = null

  async start(onAdvert: (advert: BeaconAdvert) => void) {
    if (this.failWith) throw this.failWith
    this.listener = onAdvert
  }

  async stop() {
    this.listener = null
  }

  emit(advert: BeaconAdvert) {
    this.listener?.(advert)
  }
}
