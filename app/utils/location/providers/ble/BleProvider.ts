// BLE location provider: beacon adverts -> per-AP RSSI -> floor vote -> position fix.
// The floor comes from the vote, unless a floor selector (the barometer) picks it; see setFloorSelector.

import { NO_DEBUG_LOG, type DebugLog } from '../../debug/debugLog'
import { Emitter } from '../../emitter'
import { enuToWgs84 } from '../../geo/wgs84'
import { indexVenue, type VenueIndex } from '../../venue'
import type { LocationEvent, LocationFix, ProviderStatus, VenueConfig } from '../../types'
import type { LocationProvider } from '../LocationProvider'
import { ApRssiBank, DEFAULT_AP_RSSI, type ApRssiOptions } from './apRssi'
import { estimators, type BeaconObservation, type EstimatorName } from './estimators'
import { voteFloorWithShare, type FloorVote } from './floorVote'
import { rssiToDistance } from './pathLoss'
import type { BeaconAdvert, BleScanner } from './scanner'

export interface BleProviderOptions {
  estimator: EstimatorName
  /** Minimum time between fixes; adverts arriving in between only update the RSSI filters */
  updateIntervalMs: number
  /** How many of the strongest beacons vote on the floor */
  floorVoteTopN: number
  /** Assumed height of the phone above the floor, for turning 3D ranges into horizontal ones */
  phoneHeightM: number
  /** How packets become one RSSI per AP (must match how the survey measured: see apRssi.ts) */
  rssi: ApRssiOptions
  /** Scatter around a beacon's path-loss fit when the survey didn't record one, 1 sigma (dB) */
  defaultSigmaDb: number
  /** Extra scatter a phone sees on top of the survey's fit: other phones, hands, pockets, people (dB) */
  extraSigmaDb: number
  deviceOffset: DeviceOffsetOptions
}

/**
 * Phones don't agree on RSSI: another model, a case or a hand over the antenna shifts every beacon by the same few
 * dB, which the survey phone's fits then read as "everything is farther away". The fits' average miss (heard minus
 * predicted, over all beacons used) shows that shift, so it's tracked slowly and removed. Needs the rssiFit estimator.
 */
export interface DeviceOffsetOptions {
  enabled: boolean
  /** How quickly the offset follows the average miss (ms) */
  timeConstantMs: number
  /** Only fixes that used at least this many beacons count */
  minBeacons: number
  /** The offset is kept within +/- this (dB) */
  maxDb: number
}

export const DEFAULT_BLE_OPTIONS: BleProviderOptions = {
  estimator: 'rssiFit',
  updateIntervalMs: 1000,
  floorVoteTopN: 4,
  phoneHeightM: 1.2,
  rssi: DEFAULT_AP_RSSI,
  defaultSigmaDb: 4,
  extraSigmaDb: 3,
  deviceOffset: { enabled: true, timeConstantMs: 20000, minBeacons: 5, maxDb: 10 }
}

/**
 * Picks the floor to position on, given the BLE floor vote (null without readings). Returns null to use the vote.
 * The barometer uses this: it anchors to confident votes, then keeps the floor steady when beacons from the floor
 * above or below bleed through.
 */
export type FloorSelector = (vote: FloorVote | null, timestamp: number) => string | null

export class BleProvider implements LocationProvider {
  readonly id = 'ble' as const
  private options: BleProviderOptions
  private fixes = new Emitter<LocationFix>()
  private statuses = new Emitter<ProviderStatus>()
  private events = new Emitter<LocationEvent>()
  private bank: ApRssiBank
  /** What this phone hears above (+) or below (-) the survey phone, in dB */
  private deviceOffsetDb = 0
  private index: VenueIndex | null = null
  private lastFixTime = -Infinity
  private firstAdvertTime: number | null = null
  private floorSelector: FloorSelector | null = null

  constructor(private scanner: BleScanner, options: Partial<BleProviderOptions> = {}, private debug: DebugLog = NO_DEBUG_LOG) {
    this.options = { ...DEFAULT_BLE_OPTIONS, ...options, deviceOffset: { ...DEFAULT_BLE_OPTIONS.deviceOffset, ...options.deviceOffset } }
    this.bank = new ApRssiBank(this.options.rssi)
  }

  onFix(listener: (fix: LocationFix) => void) { return this.fixes.on(listener) }
  onStatus(listener: (status: ProviderStatus) => void) { return this.statuses.on(listener) }
  onEvent(listener: (event: LocationEvent) => void) { return this.events.on(listener) }

  /** Lets another sensor pick the floor (it still sees every vote). Null goes back to the vote alone. */
  setFloorSelector(selector: FloorSelector | null) {
    this.floorSelector = selector
  }

  async start(venue: VenueConfig) {
    this.index = indexVenue(venue)
    this.bank.clear()
    this.lastFixTime = -Infinity
    this.firstAdvertTime = null
    this.deviceOffsetDb = 0
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

  /** Feeds one advert in. Emits a fix at most once per updateIntervalMs (timed by advert timestamps), after the first second. */
  handleAdvert(advert: BeaconAdvert) {
    // Ignore beacons that aren't in our registry (phones, headphones, other buildings' APs).
    // An AP's vBLE beams share one registry entry; the bank keeps them apart to pick the strongest.
    const beaconId = this.index?.resolveBeaconId(advert.beaconId)
    if (!beaconId) return
    this.bank.add(beaconId, advert.beaconId, advert.rssi, advert.timestamp)
    // The first fix waits for one full slice of packets: the very first advert is one beacon, heard once
    this.firstAdvertTime ??= advert.timestamp
    if (advert.timestamp - this.firstAdvertTime < this.options.rssi.sliceMs) return
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
    const vote = voteFloorWithShare(readings.map((r) => ({ floorId: r.beacon.floorId, rssi: r.rssi })), this.options.floorVoteTopN)
    const floorId = this.floorSelector?.(vote, now) ?? vote?.floorId ?? null
    const floorInfo = floorId ? index.floors.get(floorId) : undefined
    if (this.debug.enabled) {
      // What this fix is computed from: one RSSI per AP (strongest beam, as the survey measured), before the
      // device offset is removed
      this.debug.log('ble.readings', {
        timestamp: now,
        vote,
        floorId,
        deviceOffsetDb: this.deviceOffsetDb,
        readings: readings.map((r) => [r.beaconId, r.rssi, r.beacon.floorId])
      })
    }
    if (!floorId || !floorInfo) return null

    // Only beacons on the chosen floor are used for the 2D position
    const phoneU = floorInfo.floor.transform.floorZ + this.options.phoneHeightM
    const observations: BeaconObservation[] = readings
      .filter((r) => r.beacon.floorId === floorId)
      .map((r) => {
        const rssi = r.rssi - this.deviceOffsetDb
        const distance = rssiToDistance(rssi, r.beacon.txPower, r.beacon.pathLossExponent)
        const dz = r.beacon.enu.u - phoneU
        return {
          e: r.beacon.enu.e,
          n: r.beacon.enu.n,
          distanceM: Math.sqrt(Math.max(distance ** 2 - dz ** 2, 0)),
          rssi,
          txPower: r.beacon.txPower,
          pathLossExponent: r.beacon.pathLossExponent,
          dzM: dz,
          sigmaDb: Math.hypot(r.beacon.rssiSigmaDb ?? this.options.defaultSigmaDb, this.options.extraSigmaDb),
          positionSigmaM: r.beacon.positionSigmaM ?? 0
        }
      })

    const estimate = estimators[this.options.estimator](observations)
    if (!estimate) {
      this.debug.log('ble.noFix', { timestamp: now, floorId, beacons: observations.length })
      return null
    }
    this.trackDeviceOffset(estimate, now)

    // Fixes a second apart share most of the RSSI window, so they aren't independent looks at the position.
    // Widening each one by the overlap keeps the fusion filter from counting the same packets several times.
    const overlap = Math.max(1, this.options.rssi.windowMs / this.options.updateIntervalMs)
    const covariance = estimate.covariance && {
      ee: estimate.covariance.ee * overlap,
      en: estimate.covariance.en * overlap,
      nn: estimate.covariance.nn * overlap
    }
    const accuracyM = covariance ? Math.max(estimate.accuracyM, Math.sqrt(covariance.ee + covariance.nn)) : estimate.accuracyM
    const enu = { e: estimate.e, n: estimate.n, u: floorInfo.floor.transform.floorZ }
    return {
      enu,
      wgs84: enuToWgs84(enu, index.venue.origin),
      floorId,
      buildingId: floorInfo.building.id,
      accuracyM,
      ...(covariance && { covariance }),
      timestamp: now,
      source: 'ble',
      isIndoor: true
    }
  }

  /** Moves the device offset toward the fix's average miss. Each fix was computed with the offset already removed. */
  private trackDeviceOffset(estimate: { meanResidualDb?: number, used?: number }, now: number) {
    const o = this.options.deviceOffset
    if (!o.enabled || estimate.meanResidualDb === undefined || (estimate.used ?? 0) < o.minBeacons) return
    const dt = Number.isFinite(this.lastFixTime) ? now - this.lastFixTime : this.options.updateIntervalMs
    const gain = 1 - Math.exp(-Math.max(dt, 0) / o.timeConstantMs)
    this.deviceOffsetDb = Math.max(-o.maxDb, Math.min(o.maxDb, this.deviceOffsetDb + gain * estimate.meanResidualDb))
  }

  /** What this phone currently hears above (+) or below (-) the survey phone, in dB (for the debug readout and tests) */
  get deviceOffset() {
    return this.deviceOffsetDb
  }
}
