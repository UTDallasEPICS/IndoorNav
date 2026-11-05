// BLE location provider: beacon adverts -> smoothed RSSI -> floor vote -> distances -> position fix.

import { Emitter } from '../../emitter'
import { enuToWgs84 } from '../../geo/wgs84'
import { indexVenue, type VenueIndex } from '../../venue'
import type { LocationEvent, LocationFix, ProviderStatus, VenueConfig } from '../../types'
import type { LocationProvider } from '../LocationProvider'
import { estimators, type BeaconRange, type EstimatorName } from './estimators'
import { voteFloor } from './floorVote'
import { rssiToDistance } from './pathLoss'
import { DEFAULT_RSSI_FILTER, RssiFilterBank, type RssiFilterOptions } from './rssiFilter'
import type { BeaconAdvert, BleScanner } from './scanner'

export interface BleProviderOptions {
  estimator: EstimatorName
  /** Minimum time between fixes; adverts arriving in between only update the RSSI filters */
  updateIntervalMs: number
  /** Beacons not heard for this long are ignored */
  staleAfterMs: number
  /** How many of the strongest beacons vote on the floor */
  floorVoteTopN: number
  /** Assumed height of the phone above the floor, for turning 3D ranges into horizontal ones */
  phoneHeightM: number
  rssiFilter: RssiFilterOptions
}

export const DEFAULT_BLE_OPTIONS: BleProviderOptions = {
  estimator: 'leastSquares',
  updateIntervalMs: 1000,
  staleAfterMs: 4000,
  floorVoteTopN: 4,
  phoneHeightM: 1.2,
  rssiFilter: DEFAULT_RSSI_FILTER
}

export class BleProvider implements LocationProvider {
  readonly id = 'ble' as const
  private options: BleProviderOptions
  private fixes = new Emitter<LocationFix>()
  private statuses = new Emitter<ProviderStatus>()
  private events = new Emitter<LocationEvent>()
  private bank: RssiFilterBank
  private index: VenueIndex | null = null
  private lastFixTime = -Infinity

  constructor(private scanner: BleScanner, options: Partial<BleProviderOptions> = {}) {
    this.options = { ...DEFAULT_BLE_OPTIONS, ...options }
    this.bank = new RssiFilterBank(this.options.staleAfterMs, this.options.rssiFilter)
  }

  onFix(listener: (fix: LocationFix) => void) { return this.fixes.on(listener) }
  onStatus(listener: (status: ProviderStatus) => void) { return this.statuses.on(listener) }
  onEvent(listener: (event: LocationEvent) => void) { return this.events.on(listener) }

  async start(venue: VenueConfig) {
    this.index = indexVenue(venue)
    this.bank.clear()
    this.lastFixTime = -Infinity
    this.statuses.emit({ provider: this.id, state: 'starting' })
    try {
      await this.scanner.start((advert) => this.handleAdvert(advert))
      this.statuses.emit({ provider: this.id, state: 'running' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const state = /permission|denied|unauthori[sz]ed/i.test(message) ? 'permission-denied' : 'unavailable'
      this.statuses.emit({ provider: this.id, state, message })
    }
  }

  async stop() {
    await this.scanner.stop()
    this.statuses.emit({ provider: this.id, state: 'idle' })
  }

  /** Feeds one advert in. Emits a fix at most once per updateIntervalMs (timed by advert timestamps). */
  handleAdvert(advert: BeaconAdvert) {
    // Ignore beacons that aren't in our registry (phones, headphones, other buildings' APs).
    // An AP's vBLE beams share one registry entry, so they feed one RSSI filter.
    const beaconId = this.index?.resolveBeaconId(advert.beaconId)
    if (!beaconId) return
    this.bank.add(beaconId, advert.rssi, advert.timestamp)
    if (advert.timestamp - this.lastFixTime >= this.options.updateIntervalMs) {
      const fix = this.computeFix(advert.timestamp)
      if (fix) {
        this.lastFixTime = advert.timestamp
        this.fixes.emit(fix)
      }
    }
  }

  private computeFix(now: number): LocationFix | null {
    const index = this.index!
    const readings = this.bank.readings(now).map((r) => ({ ...r, beacon: index.beacons.get(r.beaconId)! }))
    const floorId = voteFloor(readings.map((r) => ({ floorId: r.beacon.floorId, rssi: r.rssi })), this.options.floorVoteTopN)
    const floorInfo = floorId ? index.floors.get(floorId) : undefined
    if (!floorId || !floorInfo) return null

    // Only beacons on the chosen floor are used for the 2D position
    const phoneU = floorInfo.floor.transform.floorZ + this.options.phoneHeightM
    const ranges: BeaconRange[] = readings
      .filter((r) => r.beacon.floorId === floorId)
      .map((r) => {
        const distance = rssiToDistance(r.rssi, r.beacon.txPower, r.beacon.pathLossExponent)
        const dz = r.beacon.enu.u - phoneU
        return { e: r.beacon.enu.e, n: r.beacon.enu.n, distanceM: Math.sqrt(Math.max(distance ** 2 - dz ** 2, 0)) }
      })

    const estimate = estimators[this.options.estimator](ranges)
    if (!estimate) return null
    const enu = { e: estimate.e, n: estimate.n, u: floorInfo.floor.transform.floorZ }
    return {
      enu,
      wgs84: enuToWgs84(enu, index.venue.origin),
      floorId,
      buildingId: floorInfo.building.id,
      accuracyM: estimate.accuracyM,
      timestamp: now,
      source: 'ble',
      isIndoor: true
    }
  }
}
