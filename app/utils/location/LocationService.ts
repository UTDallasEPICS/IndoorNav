// The one entry point the app uses for location. Wires providers into the FusionEngine and exposes the
// fused fix stream, events, and provider status.
//
//   const location = createDeviceLocationService()
//   const unsubscribe = location.subscribe((fix) => { ... })
//   await location.start(venue)

import { Emitter } from './emitter'
import { FusionEngine, type FusionOptions } from './fusion/FusionEngine'
import { BleProvider, type BleProviderOptions } from './providers/ble/BleProvider'
import { CapacitorBleScanner } from './providers/ble/capacitorScanner'
import { CapacitorGpsSource } from './providers/gps/capacitorGpsSource'
import { GpsProvider } from './providers/gps/GpsProvider'
import type { LocationProvider } from './providers/LocationProvider'
import type { LocationEvent, LocationFix, ProviderId, ProviderStatus, VenueConfig } from './types'

export interface LocationServiceOptions {
  providers: LocationProvider[]
  fusion?: Partial<FusionOptions>
}

export class LocationService {
  private providers: LocationProvider[]
  private fusionOptions: Partial<FusionOptions>
  private fusion: FusionEngine | null = null
  private fixes = new Emitter<LocationFix>()
  private events = new Emitter<LocationEvent>()
  private statuses = new Emitter<ProviderStatus>()
  private cleanup: Array<() => void> = []
  private latestFix: LocationFix | null = null
  private latestStatus: Partial<Record<ProviderId, ProviderStatus>> = {}

  constructor(options: LocationServiceOptions) {
    this.providers = options.providers
    this.fusionOptions = options.fusion ?? {}
  }

  /** Latest fused fix, or null before the first one */
  get currentFix(): LocationFix | null {
    return this.latestFix
  }

  /** Latest status of each provider */
  get status(): Partial<Record<ProviderId, ProviderStatus>> {
    return { ...this.latestStatus }
  }

  /** Listens for fused fixes. Returns a function that unsubscribes. */
  subscribe(listener: (fix: LocationFix) => void): () => void {
    return this.fixes.on(listener)
  }

  unsubscribe(listener: (fix: LocationFix) => void) {
    this.fixes.off(listener)
  }

  onEvent(listener: (event: LocationEvent) => void): () => void {
    return this.events.on(listener)
  }

  onStatus(listener: (status: ProviderStatus) => void): () => void {
    return this.statuses.on(listener)
  }

  /** Starts every provider. A provider that fails (e.g. permission denied) reports it via status; the rest keep running. */
  async start(venue: VenueConfig) {
    await this.stop()
    const fusion = new FusionEngine(venue, this.fusionOptions)
    this.fusion = fusion
    this.cleanup.push(
      fusion.onFix((fix) => {
        this.latestFix = fix
        this.fixes.emit(fix)
      }),
      fusion.onEvent((event) => this.events.emit(event))
    )
    for (const provider of this.providers) {
      this.cleanup.push(
        provider.onFix((fix) => fusion.ingest(fix)),
        provider.onEvent((event) => this.events.emit(event)),
        provider.onStatus((status) => {
          this.latestStatus[status.provider] = status
          this.statuses.emit(status)
        })
      )
    }
    await Promise.all(this.providers.map((provider) => provider.start(venue)))
  }

  async stop() {
    if (!this.fusion) return
    await Promise.all(this.providers.map((provider) => provider.stop()))
    for (const off of this.cleanup) off()
    this.cleanup = []
    this.fusion = null
    this.latestFix = null
  }
}

/** The service as the app runs it on a phone: BLE beacons + GPS via Capacitor plugins. */
export function createDeviceLocationService(options: { ble?: Partial<BleProviderOptions>, fusion?: Partial<FusionOptions> } = {}) {
  return new LocationService({
    providers: [
      new BleProvider(new CapacitorBleScanner(), options.ble),
      new GpsProvider(new CapacitorGpsSource())
    ],
    fusion: options.fusion
  })
}
