// GPS location provider: OS location readings -> ENU fixes. Indoor/outdoor is decided by the FusionEngine.

import { Emitter } from '../../emitter'
import { wgs84ToEnu } from '../../geo/wgs84'
import type { LocationEvent, LocationFix, ProviderStatus, VenueConfig } from '../../types'
import type { LocationProvider } from '../LocationProvider'
import type { GpsReading, GpsSource } from './gpsSource'

export class GpsProvider implements LocationProvider {
  readonly id = 'gps' as const
  private fixes = new Emitter<LocationFix>()
  private statuses = new Emitter<ProviderStatus>()
  private events = new Emitter<LocationEvent>()
  private venue: VenueConfig | null = null

  constructor(private source: GpsSource) {}

  onFix(listener: (fix: LocationFix) => void) { return this.fixes.on(listener) }
  onStatus(listener: (status: ProviderStatus) => void) { return this.statuses.on(listener) }
  onEvent(listener: (event: LocationEvent) => void) { return this.events.on(listener) }

  async start(venue: VenueConfig) {
    this.venue = venue
    this.statuses.emit({ provider: this.id, state: 'starting' })
    try {
      await this.source.start((reading) => this.handleReading(reading))
      this.statuses.emit({ provider: this.id, state: 'running' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const state = /permission|denied/i.test(message) ? 'permission-denied' : 'unavailable'
      this.statuses.emit({ provider: this.id, state, message })
    }
  }

  async stop() {
    await this.source.stop()
    this.statuses.emit({ provider: this.id, state: 'idle' })
  }

  handleReading(reading: GpsReading) {
    if (!this.venue) return
    // Without an altitude, assume the phone is at the campus origin's height
    const wgs84 = { lat: reading.lat, lon: reading.lon, h: reading.altitude ?? this.venue.origin.h }
    this.fixes.emit({
      enu: wgs84ToEnu(wgs84, this.venue.origin),
      wgs84,
      floorId: null,
      buildingId: null,
      accuracyM: reading.accuracyM,
      ...(reading.headingDeg !== null && { headingDeg: reading.headingDeg }),
      timestamp: reading.timestamp,
      source: 'gps',
      isIndoor: false
    })
  }
}
