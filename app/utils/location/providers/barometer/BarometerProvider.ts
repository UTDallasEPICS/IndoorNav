// Barometer: pressure samples -> BarometerFloorTracker. It never emits fixes: the BLE provider asks it which floor
// to position on (see `chooseFloor` and BleProvider.setFloorSelector), and phones without a barometer keep using
// the BLE floor vote alone.

import { Emitter } from '../../emitter'
import { indexVenue, type VenueIndex } from '../../venue'
import type { ProviderStatus, VenueConfig } from '../../types'
import type { FloorVote } from '../ble/floorVote'
import { BarometerFloorTracker, type BarometerFloorOptions } from './floorTracker'
import type { PressureSample, PressureSource } from './pressureSource'

/** The tracker's state with floors as levels, for the map's test readout */
export interface BarometerReading {
  timestamp: number
  pressureHpa: number | null
  /** Height above the building's ground floor (m); null until BLE has anchored the barometer */
  heightM: number | null
  verticalSpeedMps: number | null
  /** The barometer's floor level (`Floor.level`), or null until anchored */
  floorLevel: number | null
  /** The BLE vote's floor level and its share of the vote (0–1) */
  voteLevel: number | null
  voteShare: number | null
}

export class BarometerProvider {
  readonly id = 'barometer' as const
  private tracker: BarometerFloorTracker
  private index: VenueIndex | null = null
  private statuses = new Emitter<ProviderStatus>()
  private readings = new Emitter<BarometerReading>()

  constructor(private source: PressureSource, options: Partial<BarometerFloorOptions> = {}) {
    this.tracker = new BarometerFloorTracker(options)
  }

  onStatus(listener: (status: ProviderStatus) => void) { return this.statuses.on(listener) }
  onReading(listener: (reading: BarometerReading) => void) { return this.readings.on(listener) }

  async start(venue: VenueConfig) {
    this.index = indexVenue(venue)
    this.tracker.setVenue(this.index)
    this.statuses.emit({ provider: this.id, state: 'starting' })
    try {
      await this.source.start((sample) => this.handlePressure(sample))
      this.statuses.emit({ provider: this.id, state: 'running' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const state = /permission|denied|unauthori[sz]ed/i.test(message) ? 'permission-denied' : 'unavailable'
      this.statuses.emit({ provider: this.id, state, message })
    }
  }

  async stop() {
    await this.source.stop()
    this.statuses.emit({ provider: this.id, state: 'idle' })
  }

  handlePressure(sample: PressureSample) {
    this.tracker.addPressure(sample.pressureHpa, sample.timestamp)
    this.emitReading(sample.timestamp)
  }

  /** The floor a BLE fix should use, given the BLE vote: the barometer's, or null to use the vote */
  chooseFloor(vote: FloorVote | null, timestamp: number): string | null {
    const floorId = this.tracker.chooseFloor(vote, timestamp)
    this.emitReading(timestamp)
    return floorId
  }

  private emitReading(timestamp: number) {
    const state = this.tracker.state
    const level = (floorId: string | null | undefined) => (floorId ? this.index?.floors.get(floorId)?.floor.level ?? null : null)
    this.readings.emit({
      timestamp,
      pressureHpa: state.pressureHpa,
      heightM: state.heightM,
      verticalSpeedMps: state.verticalSpeedMps,
      floorLevel: level(state.floorId),
      voteLevel: level(state.vote?.floorId),
      voteShare: state.vote?.share ?? null
    })
  }
}
