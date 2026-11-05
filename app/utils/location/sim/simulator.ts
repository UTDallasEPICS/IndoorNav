// Simulator: generates noisy BLE adverts and GPS readings along a ground-truth path, runs them through the
// real providers + fusion (with mock platform code), and reports the error. Runs in Node and the browser.

import { enuToWgs84 } from '../geo/wgs84'
import { LocationService } from '../LocationService'
import { BleProvider, type BleProviderOptions } from '../providers/ble/BleProvider'
import { distanceToRssi } from '../providers/ble/pathLoss'
import { MockBleScanner, type BeaconAdvert } from '../providers/ble/scanner'
import { GpsProvider } from '../providers/gps/GpsProvider'
import { MockGpsSource, type GpsReading } from '../providers/gps/gpsSource'
import { MockMotionSource, type AccelSample, type CompassSample } from '../providers/pdr/motionSource'
import { PdrProvider, type PdrProviderOptions } from '../providers/pdr/PdrProvider'
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
  /** Simulated phone motion sensors (only used when runSimulation gets `pdr`) */
  motion: {
    accelIntervalMs: number
    compassIntervalMs: number
    /** True step length; the detector estimates its own, so they differ a little */
    stepLengthM: number
    /** Peak acceleration swing per step (m/s^2) */
    stepAmplitude: number
    accelNoise: number
    compassNoiseDeg: number
    /** Constant compass error, as from steel nearby (degrees) */
    compassBiasDeg: number
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
  },
  motion: {
    accelIntervalMs: 20,
    compassIntervalMs: 50,
    stepLengthM: 0.7,
    stepAmplitude: 3,
    accelNoise: 0.3,
    compassNoiseDeg: 8,
    compassBiasDeg: 5
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

/** Accelerometer + compass samples for walking along the path: one acceleration bump per step, compass along the path. */
export function generateMotion(path: PathWaypoint[], venue: VenueConfig, options: SimOptions = DEFAULT_SIM) {
  const rng = createRng(options.seed + 2)
  const m = options.motion
  const accel: AccelSample[] = []
  const compass: CompassSample[] = []
  const endMs = path[path.length - 1]!.t * 1000
  let phase = 0
  let headingDeg = 0
  for (let ms = 0; ms <= endMs; ms += m.accelIntervalMs) {
    const a = truthAt(path, ms / 1000)
    const b = truthAt(path, (ms + 200) / 1000)
    const speed = Math.hypot(b.e - a.e, b.n - a.n) / 0.2
    if (speed > 0.2) {
      headingDeg = (Math.atan2(b.e - a.e, b.n - a.n) * 180 / Math.PI + 360) % 360
      phase += 2 * Math.PI * (speed / m.stepLengthM) * m.accelIntervalMs / 1000
    }
    const bump = speed > 0.2 ? m.stepAmplitude * Math.sin(phase) : 0
    accel.push({ x: rng.gaussian() * m.accelNoise, y: rng.gaussian() * m.accelNoise, z: 9.81 + bump + rng.gaussian() * m.accelNoise, timestamp: options.startTime + ms })
    if (ms % m.compassIntervalMs < m.accelIntervalMs) {
      const magnetic = headingDeg - (venue.magneticDeclinationDeg ?? 0) + m.compassBiasDeg + rng.gaussian() * m.compassNoiseDeg
      compass.push({ headingDeg: (magnetic + 360) % 360, accuracyDeg: null, timestamp: options.startTime + ms })
    }
  }
  return { accel, compass }
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
  /** How much the dot jumps around: RMS of its move minus the true move, over (at least) 1 s steps (m) */
  jitterM: number
}

/** Horizontal error of each fix against the truth at the fix's timestamp. */
export function errorReport(fixes: LocationFix[], path: PathWaypoint[], startTime = DEFAULT_SIM.startTime): ErrorReport {
  const errors: number[] = []
  let indoorFixes = 0
  let floorCorrect = 0
  let indoorCorrect = 0
  let jitterSum = 0
  let jitterCount = 0
  let previous: { fix: LocationFix, truth: { e: number, n: number } } | null = null
  for (const fix of fixes) {
    const truth = truthAt(path, (fix.timestamp - startTime) / 1000)
    errors.push(Math.hypot(fix.enu.e - truth.e, fix.enu.n - truth.n))
    if (fix.isIndoor === (truth.floorId !== null)) indoorCorrect++
    if (truth.floorId !== null) {
      indoorFixes++
      if (fix.floorId === truth.floorId) floorCorrect++
    }
    if (!previous || fix.timestamp - previous.fix.timestamp >= 1000) {
      if (previous) {
        const de = (fix.enu.e - previous.fix.enu.e) - (truth.e - previous.truth.e)
        const dn = (fix.enu.n - previous.fix.enu.n) - (truth.n - previous.truth.n)
        jitterSum += de * de + dn * dn
        jitterCount++
      }
      previous = { fix, truth }
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
    indoorCorrectRate: fixes.length ? indoorCorrect / fixes.length : NaN,
    jitterM: jitterCount ? Math.sqrt(jitterSum / jitterCount) : NaN
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
  /** Simulate step + compass tracking too */
  pdr?: Partial<PdrProviderOptions> | boolean
  fusion?: Partial<FusionOptions>
}): Promise<SimulationResult> {
  const options = { ...DEFAULT_SIM, ...params.sim, motion: { ...DEFAULT_SIM.motion, ...params.sim?.motion } }
  const scanner = new MockBleScanner()
  const gpsSource = new MockGpsSource()
  const motionSource = new MockMotionSource()
  const bleProvider = new BleProvider(scanner, params.ble)
  const pdr = params.pdr ? new PdrProvider(motionSource, params.pdr === true ? {} : params.pdr) : undefined
  const service = new LocationService({
    providers: [bleProvider, new GpsProvider(gpsSource)],
    motion: pdr,
    fusion: params.fusion
  })

  const fused: LocationFix[] = []
  const ble: LocationFix[] = []
  const events: LocationEvent[] = []
  service.subscribe((fix) => fused.push(fix))
  service.onEvent((event) => events.push(event))
  bleProvider.onFix((fix) => ble.push(fix))
  await service.start(params.venue)

  // Replay every stream in time order
  const motion = pdr ? generateMotion(params.path, params.venue, options) : { accel: [], compass: [] }
  const timeline = [
    ...motion.accel.map((sample) => ({ t: sample.timestamp, run: () => motionSource.emitAccel(sample) })),
    ...motion.compass.map((sample) => ({ t: sample.timestamp, run: () => motionSource.emitCompass(sample) })),
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
