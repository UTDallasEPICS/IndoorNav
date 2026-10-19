// Simulator: generates noisy BLE adverts and GPS readings along a ground-truth path, runs them through the
// real providers + fusion (with mock platform code), and reports the error. Runs in Node and the browser.

import { enuToWgs84 } from '../geo/wgs84'
import { LocationService } from '../LocationService'
import { BleProvider, type BleProviderOptions } from '../providers/ble/BleProvider'
import { distanceToRssi } from '../providers/ble/pathLoss'
import { MockBleScanner, type BeaconAdvert } from '../providers/ble/scanner'
import { GpsProvider } from '../providers/gps/GpsProvider'
import { MockGpsSource, type GpsReading } from '../providers/gps/gpsSource'
import type { FusionOptions } from '../fusion/FusionEngine'
import { indexVenue } from '../venue'
import type { LocationEvent, LocationFix, VenueConfig } from '../types'

/** A ground-truth point. `t` is in seconds from the start; floorId is null outdoors. */
export interface PathWaypoint {
  t: number
  e: number
  n: number
  floorId: string | null
}

export interface SimOptions {
  /** Random seed, so a run is repeatable */
  seed: number
  /** Timestamp (ms) of t = 0 */
  startTime: number
  /** How often the phone reports each beacon (ms) */
  advertIntervalMs: number
  /** Standard deviation of RSSI noise (dB) */
  rssiNoiseDb: number
  /** Extra loss per floor between beacon and phone (dB) */
  floorLossDb: number
  /** Extra loss through the outer wall when the phone is outside (dB) */
  wallLossDb: number
  /** Real-world path loss exponent minus the configured one, so the model isn't perfect */
  exponentMismatch: number
  /** Adverts weaker than this aren't received (dBm) */
  minRssi: number
  gpsIntervalMs: number
  gps: {
    outdoor: { noiseM: number, accuracyM: number }
    indoor: { noiseM: number, accuracyM: number, dropRate: number }
  }
}

export const DEFAULT_SIM: SimOptions = {
  seed: 1,
  startTime: 1_700_000_000_000,
  advertIntervalMs: 300,
  rssiNoiseDb: 4,
  floorLossDb: 15,
  wallLossDb: 10,
  exponentMismatch: 0.2,
  minRssi: -95,
  gpsIntervalMs: 1000,
  gps: {
    outdoor: { noiseM: 3, accuracyM: 5 },
    indoor: { noiseM: 20, accuracyM: 30, dropRate: 0.4 }
  }
}

/** Seeded random numbers (mulberry32) with a Gaussian helper. */
export function createRng(seed: number) {
  let a = seed >>> 0
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const gaussian = () => Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform())
  return { uniform, gaussian }
}

/** Ground truth at time `t` (seconds), interpolating linearly between waypoints. */
export function truthAt(path: PathWaypoint[], t: number): { e: number, n: number, floorId: string | null } {
  const first = path[0]!
  if (t <= first.t) return first
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!
    const b = path[i]!
    if (t <= b.t) {
      const f = b.t === a.t ? 1 : (t - a.t) / (b.t - a.t)
      return { e: a.e + f * (b.e - a.e), n: a.n + f * (b.n - a.n), floorId: f >= 1 ? b.floorId : a.floorId }
    }
  }
  return path[path.length - 1]!
}

export function generateAdverts(path: PathWaypoint[], venue: VenueConfig, options: SimOptions = DEFAULT_SIM): BeaconAdvert[] {
  const index = indexVenue(venue)
  const rng = createRng(options.seed)
  const adverts: BeaconAdvert[] = []
  const endMs = path[path.length - 1]!.t * 1000
  for (let ms = 0; ms <= endMs; ms += options.advertIntervalMs) {
    const truth = truthAt(path, ms / 1000)
    const phoneFloor = truth.floorId ? index.floors.get(truth.floorId)!.floor : null
    const phoneU = (phoneFloor?.transform.floorZ ?? 0) + 1.2
    for (const beacon of venue.beacons) {
      const beaconLevel = index.floors.get(beacon.floorId)!.floor.level
      const distance = Math.hypot(beacon.enu.e - truth.e, beacon.enu.n - truth.n, beacon.enu.u - phoneU)
      const loss = phoneFloor
        ? options.floorLossDb * Math.abs(phoneFloor.level - beaconLevel)
        : options.wallLossDb + options.floorLossDb * Math.abs(beaconLevel - 1)
      const rssi = distanceToRssi(distance, beacon.txPower, beacon.pathLossExponent + options.exponentMismatch)
        - loss + rng.gaussian() * options.rssiNoiseDb
      if (rssi >= options.minRssi) {
        adverts.push({ beaconId: beacon.id, rssi: Math.round(rssi), timestamp: options.startTime + ms })
      }
    }
  }
  return adverts
}

export function generateGpsReadings(path: PathWaypoint[], venue: VenueConfig, options: SimOptions = DEFAULT_SIM): GpsReading[] {
  const rng = createRng(options.seed + 1)
  const readings: GpsReading[] = []
  const endMs = path[path.length - 1]!.t * 1000
  for (let ms = 0; ms <= endMs; ms += options.gpsIntervalMs) {
    const truth = truthAt(path, ms / 1000)
    const indoor = truth.floorId !== null
    if (indoor && rng.uniform() < options.gps.indoor.dropRate) continue
    const { noiseM, accuracyM } = indoor ? options.gps.indoor : options.gps.outdoor
    const enu = { e: truth.e + rng.gaussian() * noiseM, n: truth.n + rng.gaussian() * noiseM, u: 0 }
    const { lat, lon, h } = enuToWgs84(enu, venue.origin)
    readings.push({ lat, lon, altitude: h, accuracyM, headingDeg: null, timestamp: options.startTime + ms })
  }
  return readings
}

export interface ErrorReport {
  count: number
  meanM: number
  p50M: number
  p90M: number
  maxM: number
  /** Share of indoor fixes whose floor matches the truth */
  floorCorrectRate: number
  /** Share of fixes whose isIndoor matches the truth */
  indoorCorrectRate: number
}

/** Horizontal error of each fix against the truth at the fix's timestamp. */
export function errorReport(fixes: LocationFix[], path: PathWaypoint[], startTime = DEFAULT_SIM.startTime): ErrorReport {
  const errors: number[] = []
  let indoorFixes = 0
  let floorCorrect = 0
  let indoorCorrect = 0
  for (const fix of fixes) {
    const truth = truthAt(path, (fix.timestamp - startTime) / 1000)
    errors.push(Math.hypot(fix.enu.e - truth.e, fix.enu.n - truth.n))
    if (fix.isIndoor === (truth.floorId !== null)) indoorCorrect++
    if (truth.floorId !== null) {
      indoorFixes++
      if (fix.floorId === truth.floorId) floorCorrect++
    }
  }
  const sorted = [...errors].sort((a, b) => a - b)
  // Nearest-rank percentile
  const percentile = (p: number) => sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]! : NaN
  return {
    count: errors.length,
    meanM: errors.reduce((sum, x) => sum + x, 0) / errors.length,
    p50M: percentile(0.5),
    p90M: percentile(0.9),
    maxM: sorted[sorted.length - 1] ?? NaN,
    floorCorrectRate: indoorFixes ? floorCorrect / indoorFixes : NaN,
    indoorCorrectRate: fixes.length ? indoorCorrect / fixes.length : NaN
  }
}

export interface SimulationResult {
  fused: LocationFix[]
  /** Raw BLE provider fixes, before fusion (useful for comparing estimators) */
  ble: LocationFix[]
  events: LocationEvent[]
  report: ErrorReport
  bleReport: ErrorReport
}

/** Runs the full pipeline (providers -> fusion -> LocationService) on simulated data. */
export async function runSimulation(params: {
  venue: VenueConfig
  path: PathWaypoint[]
  sim?: Partial<SimOptions>
  ble?: Partial<BleProviderOptions>
  fusion?: Partial<FusionOptions>
}): Promise<SimulationResult> {
  const options = { ...DEFAULT_SIM, ...params.sim }
  const scanner = new MockBleScanner()
  const gpsSource = new MockGpsSource()
  const bleProvider = new BleProvider(scanner, params.ble)
  const service = new LocationService({
    providers: [bleProvider, new GpsProvider(gpsSource)],
    fusion: params.fusion
  })

  const fused: LocationFix[] = []
  const ble: LocationFix[] = []
  const events: LocationEvent[] = []
  service.subscribe((fix) => fused.push(fix))
  service.onEvent((event) => events.push(event))
  bleProvider.onFix((fix) => ble.push(fix))
  await service.start(params.venue)

  // Replay both streams in time order
  const timeline = [
    ...generateAdverts(params.path, params.venue, options).map((advert) => ({ t: advert.timestamp, run: () => scanner.emit(advert) })),
    ...generateGpsReadings(params.path, params.venue, options).map((reading) => ({ t: reading.timestamp, run: () => gpsSource.emit(reading) }))
  ].sort((a, b) => a.t - b.t)
  for (const item of timeline) item.run()

  await service.stop()
  return {
    fused,
    ble,
    events,
    report: errorReport(fused, params.path, options.startTime),
    bleReport: errorReport(ble, params.path, options.startTime)
  }
}
