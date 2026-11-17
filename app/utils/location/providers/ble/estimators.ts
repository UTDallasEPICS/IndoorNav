// Position estimators: turn beacon positions + estimated distances into a 2D position.

/** A beacon's horizontal position and the estimated horizontal distance to it. */
export interface BeaconRange {
  e: number
  n: number
  distanceM: number
}

/** Everything known about one heard beacon. The range-based estimators only use the BeaconRange part. */
export interface BeaconObservation extends BeaconRange {
  /** Smoothed RSSI in dBm */
  rssi: number
  /** The beacon's fitted RSSI at 1 m and path loss exponent */
  txPower: number
  pathLossExponent: number
  /** Beacon height above the phone (m) */
  dzM: number
  /** How far readings scatter around the beacon's path-loss fit, 1 sigma (dB) */
  sigmaDb: number
  /** How well the beacon's own position is known, 1 sigma (m) */
  positionSigmaM: number
}

/** Error covariance of a position in the east/north plane (m^2) */
export interface Covariance2 {
  ee: number
  en: number
  nn: number
}

export interface PositionEstimate {
  e: number
  n: number
  accuracyM: number
  /** The error ellipse, when the estimator knows more than a radius (e.g. beacons in a line: unsure across it) */
  covariance?: Covariance2
  /** Mean of (heard - predicted) RSSI over the beacons used (dB): a phone that hears everything weak reads negative */
  meanResidualDb?: number
  /** How many beacons the estimate used */
  used?: number
}

/** Every estimator has this shape, so the BLE provider can switch between them by name. */
export type PositionEstimator = (observations: BeaconObservation[]) => PositionEstimate | null

/** Accuracy is never reported below this, since range errors of a meter or two are normal for BLE */
const MIN_ACCURACY_M = 1.5

/** RMS of (distance from estimate to beacon - measured range), weighted by 1/d^2. */
function rangeResidual(e: number, n: number, ranges: BeaconRange[]): number {
  let sum = 0
  let weightSum = 0
  for (const r of ranges) {
    const w = 1 / Math.max(r.distanceM, 0.5) ** 2
    const residual = Math.hypot(e - r.e, n - r.n) - r.distanceM
    sum += w * residual * residual
    weightSum += w
  }
  return Math.sqrt(sum / weightSum)
}

/**
 * Weighted centroid: average of beacon positions, weighting near beacons more (1/d^2).
 * Robust and always inside the beacons' hull, but pulled toward beacon positions.
 */
export const weightedCentroid = (ranges: BeaconRange[]): PositionEstimate | null => {
  if (ranges.length === 0) return null
  let e = 0
  let n = 0
  let weightSum = 0
  for (const r of ranges) {
    const w = 1 / Math.max(r.distanceM, 0.5) ** 2
    e += w * r.e
    n += w * r.n
    weightSum += w
  }
  e /= weightSum
  n /= weightSum
  // With one beacon the best guess is "somewhere within d of it"
  const accuracyM = ranges.length === 1 ? ranges[0]!.distanceM : rangeResidual(e, n, ranges)
  return { e, n, accuracyM: Math.max(MIN_ACCURACY_M, accuracyM) }
}

/**
 * Least-squares trilateration: finds the point whose distances to the beacons best match the measured
 * ranges (Gauss-Newton, weighted by 1/d^2, starting from the weighted centroid). Needs 3+ beacons;
 * with fewer it falls back to the weighted centroid.
 */
export const leastSquares = (ranges: BeaconRange[]): PositionEstimate | null => {
  const start = weightedCentroid(ranges)
  if (!start || ranges.length < 3) return start

  let { e, n } = start
  for (let iter = 0; iter < 20; iter++) {
    // Normal equations (J^T W J) delta = J^T W r for the 2 unknowns
    let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0
    for (const r of ranges) {
      const de = e - r.e
      const dn = n - r.n
      const dist = Math.max(Math.hypot(de, dn), 1e-6)
      const w = 1 / Math.max(r.distanceM, 0.5) ** 2
      const je = de / dist // d(dist)/de
      const jn = dn / dist // d(dist)/dn
      const residual = r.distanceM - dist
      a11 += w * je * je
      a12 += w * je * jn
      a22 += w * jn * jn
      b1 += w * je * residual
      b2 += w * jn * residual
    }
    const det = a11 * a22 - a12 * a12
    // Beacons in a line (or on top of each other) can't fix a 2D position
    if (Math.abs(det) < 1e-9) return start
    const stepE = (a22 * b1 - a12 * b2) / det
    const stepN = (a11 * b2 - a12 * b1) / det
    e += stepE
    n += stepN
    if (Math.hypot(stepE, stepN) < 1e-3) break
  }
  if (!Number.isFinite(e) || !Number.isFinite(n)) return start
  return { e, n, accuracyM: Math.max(MIN_ACCURACY_M, rangeResidual(e, n, ranges)) }
}

export interface RssiFitOptions {
  /** Only the strongest beacons are used: far ones add more noise than information */
  maxBeacons: number
  /** Residuals beyond this many sigma stop counting, so one blocked or reflected beacon can't drag the fix */
  outlierSigma: number
  /** Search this far outside the box around the beacons used (m) */
  marginM: number
  /** Coarse search step (m); the best cell is then refined to ~0.1 m */
  stepM: number
}

export const DEFAULT_RSSI_FIT: RssiFitOptions = {
  maxBeacons: 8,
  outlierSigma: 3,
  marginM: 8,
  stepM: 1.5
}

const DB_PER_LOG = 10 / Math.LN10

/**
 * Fits the position to the RSSI readings themselves instead of to ranges, the way bSLAM's validation locates a
 * phone. RSSI scatters evenly in dB around a beacon's path-loss fit; turned into meters, the same scatter is
 * lopsided and grows with range (5 dB is 1 m at 2 m, 8 m at 15 m), which is what makes range trilateration jumpy.
 *
 * - Each beacon is weighted by how well it's known: its fit's scatter, plus its own position error seen as dB.
 * - Residuals are capped (`outlierSigma`), and only the strongest `maxBeacons` are used.
 * - A grid search finds the best spot, so it can't settle in a wrong local minimum.
 * - The error ellipse comes from the geometry: tight where beacons surround you, long across a line of beacons.
 */
export function createRssiFit(options: Partial<RssiFitOptions> = {}): PositionEstimator {
  const o = { ...DEFAULT_RSSI_FIT, ...options }
  return (observations) => {
    const use = [...observations].sort((a, b) => b.rssi - a.rssi).slice(0, o.maxBeacons)
    if (use.length < 3) return weightedCentroid(use)

    // A beacon's position error shifts its predicted RSSI by (10 n / ln 10) * error / distance
    const variances = use.map((b) => {
      const d = Math.max(Math.hypot(b.distanceM, b.dzM), 1)
      return b.sigmaDb ** 2 + (DB_PER_LOG * b.pathLossExponent * b.positionSigmaM / d) ** 2
    })
    const cap = o.outlierSigma ** 2
    const residual = (b: BeaconObservation, e: number, n: number) => {
      const d = Math.max(Math.hypot(e - b.e, n - b.n, b.dzM), 0.1)
      return b.rssi - (b.txPower - 10 * b.pathLossExponent * Math.log10(d))
    }
    const cost = (e: number, n: number) => {
      let sum = 0
      for (let i = 0; i < use.length; i++) sum += Math.min(residual(use[i]!, e, n) ** 2 / variances[i]!, cap)
      return sum
    }

    let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity
    for (const b of use) {
      minE = Math.min(minE, b.e); maxE = Math.max(maxE, b.e)
      minN = Math.min(minN, b.n); maxN = Math.max(maxN, b.n)
    }
    let best = { e: 0, n: 0 }
    let bestCost = Infinity
    for (let e = minE - o.marginM; e <= maxE + o.marginM; e += o.stepM) {
      for (let n = minN - o.marginM; n <= maxN + o.marginM; n += o.stepM) {
        const c = cost(e, n)
        if (c < bestCost) { bestCost = c; best = { e, n } }
      }
    }
    for (let fine = o.stepM / 3; fine >= 0.05; fine /= 3) {
      const center = best
      for (let i = -3; i <= 3; i++) {
        for (let j = -3; j <= 3; j++) {
          const e = center.e + i * fine
          const n = center.n + j * fine
          const c = cost(e, n)
          if (c < bestCost) { bestCost = c; best = { e, n } }
        }
      }
    }

    // Information matrix from the beacons that fit (J^T W J), and their mean residual
    let hee = 0, hen = 0, hnn = 0, chi2 = 0, inliers = 0, residualSum = 0, weightSum = 0
    for (let i = 0; i < use.length; i++) {
      const b = use[i]!
      const r = residual(b, best.e, best.n)
      if (r * r / variances[i]! >= cap) continue
      const d2 = Math.max((best.e - b.e) ** 2 + (best.n - b.n) ** 2 + b.dzM ** 2, 0.01)
      const ge = DB_PER_LOG * b.pathLossExponent * (best.e - b.e) / d2
      const gn = DB_PER_LOG * b.pathLossExponent * (best.n - b.n) / d2
      const w = 1 / variances[i]!
      hee += w * ge * ge
      hen += w * ge * gn
      hnn += w * gn * gn
      chi2 += w * r * r
      residualSum += w * r
      weightSum += w
      inliers++
    }
    // A weak prior (30 m) keeps the ellipse finite when the beacons can't pin one direction down
    hee += 1 / 900
    hnn += 1 / 900
    const det = hee * hnn - hen * hen
    // Readings scattering more than the fits promise (walls, a body in the way) widen the ellipse to match
    const scale = Math.max(1, inliers > 2 ? chi2 / (inliers - 2) : 1)
    const covariance = { ee: scale * hnn / det, en: -scale * hen / det, nn: scale * hee / det }
    return {
      ...best,
      accuracyM: Math.max(MIN_ACCURACY_M, Math.sqrt(covariance.ee + covariance.nn)),
      covariance,
      meanResidualDb: weightSum > 0 ? residualSum / weightSum : 0,
      used: inliers
    }
  }
}

export const rssiFit = createRssiFit()

export const estimators: Record<'weightedCentroid' | 'leastSquares' | 'rssiFit', PositionEstimator> = { weightedCentroid, leastSquares, rssiFit }
export type EstimatorName = keyof typeof estimators
