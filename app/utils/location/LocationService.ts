// The one entry point the app uses for location. Wires providers into the FusionEngine and exposes the
// fused fix stream, events, and provider status.
//
//   const location = createDeviceLocationService()
//   const unsubscribe = location.subscribePosition((position) => { ... }) // or subscribe() for raw ENU fixes
//   await location.start(spnVenue)

import { Emitter } from './emitter'
import { FusionEngine, type FusionOptions } from './fusion/FusionEngine'
import { toMapPosition } from './mapPosition'
import { BleProvider, type BleProviderOptions } from './providers/ble/BleProvider'
import { CapacitorBleScanner } from './providers/ble/capacitorScanner'
import { CapacitorGpsSource } from './providers/gps/capacitorGpsSource'
import { GpsProvider } from './providers/gps/GpsProvider'
import type { LocationProvider } from './providers/LocationProvider'
import { CapacitorMotionSource } from './providers/pdr/capacitorMotionSource'
import { PdrProvider, type PdrProviderOptions } from './providers/pdr/PdrProvider'
import type { LocationEvent, LocationFix, MapPosition, ProviderId, ProviderStatus, VenueConfig } from './types'
import { indexVenue } from './venue'

export type { LocationEvent, LocationFix, MapPosition, ProviderStatus, VenueConfig } from './types'
export { spnVenue } from './venues/spn'
export { withStoredBeacons, type StoredBeacon } from './beaconRegistry'
export { requestMotionPermission } from './providers/pdr/capacitorMotionSource'

export interface LocationServiceOptions {
  providers: LocationProvider[]
  /** Step + compass tracking. Optional: without it the fused track is smoothed from BLE/GPS alone. */
  motion?: PdrProvider
  fusion?: Partial<FusionOptions>
}

export class LocationService {
  private providers: LocationProvider[]
  private motion: PdrProvider | null
  private fusionOptions: Partial<FusionOptions>
  private fusion: FusionEngine | null = null
  private fixes = new Emitter<LocationFix>()
  private positions = new Emitter<MapPosition>()
  private events = new Emitter<LocationEvent>()
  private statuses = new Emitter<ProviderStatus>()
  private cleanup: Array<() => void> = []
  private latestFix: LocationFix | null = null
  private latestPosition: MapPosition | null = null
  private latestStatus: Partial<Record<ProviderId, ProviderStatus>> = {}

  constructor(options: LocationServiceOptions) {
    this.providers = options.providers
    this.motion = options.motion ?? null
    this.fusionOptions = options.fusion ?? {}
  }

  /** Latest fused fix, or null before the first one */
  get currentFix(): LocationFix | null {
    return this.latestFix
  }

  /** Latest fix that lies on a mapped floor, as map fractions + floor + margin of error. Null before the first one. */
  get currentPosition(): MapPosition | null {
    return this.latestPosition
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

  /** Listens for fused fixes on a mapped floor, converted to map positions. Returns a function that unsubscribes. */
  subscribePosition(listener: (position: MapPosition) => void): () => void {
    return this.positions.on(listener)
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
    const index = indexVenue(venue)
    this.fusion = fusion
    this.cleanup.push(
      fusion.onFix((fix) => {
        this.latestFix = fix
        this.fixes.emit(fix)
        const position = toMapPosition(fix, index)
        if (position) {
          this.latestPosition = position
          this.positions.emit(position)
        }
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
    if (this.motion) {
      this.cleanup.push(
        this.motion.onStep((step) => fusion.ingestStep(step)),
        this.motion.onMotion((state) => fusion.ingestMotion(state)),
        this.motion.onStatus((status) => {
          this.latestStatus[status.provider] = status
          this.statuses.emit(status)
        })
      )
    }
    await Promise.all([...this.providers, ...(this.motion ? [this.motion] : [])].map((provider) => provider.start(venue)))
  }

  async stop() {
    if (!this.fusion) return
    await Promise.all([...this.providers, ...(this.motion ? [this.motion] : [])].map((provider) => provider.stop()))
    for (const off of this.cleanup) off()
    this.cleanup = []
    this.fusion = null
    this.latestFix = null
    this.latestPosition = null
  }
}

/**
 * The service as the app runs it on a phone, via Capacitor: BLE beacons, step + compass tracking (unless
 * `pdr: false`), and GPS (unless `gps: false`).
 */
export function createDeviceLocationService(options: {
  ble?: Partial<BleProviderOptions>
  pdr?: Partial<PdrProviderOptions> | false
  fusion?: Partial<FusionOptions>
  gps?: boolean
} = {}) {
  const providers: LocationProvider[] = [new BleProvider(new CapacitorBleScanner(), options.ble)]
  if (options.gps ?? true) providers.push(new GpsProvider(new CapacitorGpsSource()))
  const motion = options.pdr === false ? undefined : new PdrProvider(new CapacitorMotionSource(), options.pdr)
  return new LocationService({ providers, motion, fusion: options.fusion })
}
