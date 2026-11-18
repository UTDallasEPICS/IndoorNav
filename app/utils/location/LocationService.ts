// The one entry point the app uses for location. Wires providers into the FusionEngine and exposes the
// fused fix stream, events, and provider status.
//
//   const location = createDeviceLocationService()
//   const unsubscribe = location.subscribePosition((position) => { ... }) // or subscribe() for raw ENU fixes
//   await location.start(spnVenue)

import { NO_DEBUG_LOG, type DebugLog } from './debug/debugLog'
import { Emitter } from './emitter'
import { FusionEngine, type FusionOptions } from './fusion/FusionEngine'
import { toMapPosition } from './mapPosition'
import { BarometerProvider, type BarometerReading } from './providers/barometer/BarometerProvider'
import { CapacitorPressureSource } from './providers/barometer/capacitorPressureSource'
import type { BarometerFloorOptions } from './providers/barometer/floorTracker'
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
export { withStoredFloors, type StoredFloor } from './floorRegistry'
export { withFloorGrids } from './fusion/walkableMap'
export type { BarometerReading } from './providers/barometer/BarometerProvider'
export { requestMotionPermission } from './providers/pdr/capacitorMotionSource'
export { NO_DEBUG_LOG, type DebugLog } from './debug/debugLog'

export interface LocationServiceOptions {
  providers: LocationProvider[]
  /** Step + compass tracking. Optional: without it the fused track is smoothed from BLE/GPS alone. */
  motion?: PdrProvider
  /**
   * Barometer. Optional: started and stopped with the rest. Connect it to the BLE provider with
   * `ble.setFloorSelector` so it picks the floor (createDeviceLocationService does).
   */
  barometer?: BarometerProvider
  fusion?: Partial<FusionOptions>
  /** Records sensor inputs and filter decisions (debug/debugLog.ts). Off unless given. */
  debugLog?: DebugLog
}

export class LocationService {
  private providers: LocationProvider[]
  private motion: PdrProvider | null
  private barometer: BarometerProvider | null
  private fusionOptions: Partial<FusionOptions>
  private debug: DebugLog
  private fusion: FusionEngine | null = null
  private venue: VenueConfig | null = null
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
    this.barometer = options.barometer ?? null
    this.fusionOptions = options.fusion ?? {}
    this.debug = options.debugLog ?? NO_DEBUG_LOG
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

  /** Listens for the barometer's readings and floor (for testing floor changes). A no-op without a barometer. */
  subscribeBarometer(listener: (reading: BarometerReading) => void): () => void {
    return this.barometer ? this.barometer.onReading(listener) : () => {}
  }

  /** Starts every provider. A provider that fails (e.g. permission denied) reports it via status; the rest keep running. */
  async start(venue: VenueConfig) {
    await this.stop()
    const debug = this.debug
    debug.log('start', {
      venueId: venue.id,
      beacons: venue.beacons.length,
      providers: this.providers.map((p) => p.id),
      motion: this.motion !== null,
      barometer: this.barometer !== null
    })
    const fusion = new FusionEngine(venue, this.fusionOptions, debug)
    this.venue = venue
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
      fusion.onEvent((event) => {
        debug.log('event', event)
        this.events.emit(event)
      })
    )
    for (const provider of this.providers) {
      this.cleanup.push(
        provider.onFix((fix) => {
          debug.log('fix', {
            timestamp: fix.timestamp,
            source: fix.source,
            e: fix.enu.e,
            n: fix.enu.n,
            floorId: fix.floorId,
            accuracyM: fix.accuracyM,
            covariance: fix.covariance ?? null,
            isIndoor: fix.isIndoor
          })
          fusion.ingest(fix)
        }),
        provider.onEvent((event) => {
          debug.log('event', event)
          this.events.emit(event)
        }),
        provider.onStatus((status) => {
          debug.log('status', status)
          this.latestStatus[status.provider] = status
          this.statuses.emit(status)
        })
      )
    }
    if (this.motion) {
      this.cleanup.push(
        this.motion.onStep((step) => {
          debug.log('step', step)
          fusion.ingestStep(step)
        }),
        this.motion.onMotion((state) => {
          debug.log('motion', state)
          fusion.ingestMotion(state)
        }),
        this.motion.onStatus((status) => {
          debug.log('status', status)
          this.latestStatus[status.provider] = status
          this.statuses.emit(status)
        })
      )
    }
    if (this.barometer) {
      if (debug.enabled) this.cleanup.push(this.barometer.onReading((reading) => debug.log('baro', { ...reading })))
      this.cleanup.push(this.barometer.onStatus((status) => {
        debug.log('status', status)
        this.latestStatus[status.provider] = status
        this.statuses.emit(status)
      }))
    }
    await Promise.all(this.allProviders().map((provider) => provider.start(venue)))
  }

  async stop() {
    if (!this.fusion) return
    await Promise.all(this.allProviders().map((provider) => provider.stop()))
    this.debug.log('stop')
    for (const off of this.cleanup) off()
    this.cleanup = []
    this.fusion = null
    this.venue = null
    this.latestFix = null
    this.latestPosition = null
  }

  /**
   * Starts the step + compass tracking again, e.g. after the user allowed motion access they had denied. Call
   * `requestMotionPermission()` inside the tap first, so iOS can show its prompt. A no-op while stopped.
   */
  async restartMotion() {
    if (!this.motion || !this.venue) return
    await this.motion.stop()
    await this.motion.start(this.venue)
  }

  private allProviders(): Array<{ start(venue: VenueConfig): Promise<void>, stop(): Promise<void> }> {
    return [...this.providers, ...(this.motion ? [this.motion] : []), ...(this.barometer ? [this.barometer] : [])]
  }
}

/**
 * The service as the app runs it on a phone, via Capacitor: BLE beacons, step + compass tracking (unless
 * `pdr: false`), the barometer picking the floor (unless `barometer: false`), and GPS (unless `gps: false`).
 */
export function createDeviceLocationService(options: {
  ble?: Partial<BleProviderOptions>
  pdr?: Partial<PdrProviderOptions> | false
  barometer?: Partial<BarometerFloorOptions> | false
  fusion?: Partial<FusionOptions>
  gps?: boolean
  /** Records sensor inputs and filter decisions; see debug/debugLog.ts */
  debugLog?: DebugLog
} = {}) {
  const ble = new BleProvider(new CapacitorBleScanner(), options.ble, options.debugLog)
  const providers: LocationProvider[] = [ble]
  if (options.gps ?? true) providers.push(new GpsProvider(new CapacitorGpsSource()))
  const motion = options.pdr === false ? undefined : new PdrProvider(new CapacitorMotionSource(), options.pdr)
  const barometer = options.barometer === false ? undefined : new BarometerProvider(new CapacitorPressureSource(), options.barometer)
  if (barometer) ble.setFloorSelector((vote, timestamp) => barometer.chooseFloor(vote, timestamp))
  return new LocationService({ providers, motion, barometer, fusion: options.fusion, debugLog: options.debugLog })
}
