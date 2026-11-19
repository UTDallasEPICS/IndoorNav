// Position estimators: turn beacon positions + estimated distances into a 2D position.

/** A beacon's horizontal position and the estimated horizontal distance to it. */
export interface BeaconRange {
  e: number
  n: number
  distanceM: number
}

export interface PositionEstimate {
  e: number
  n: number
  accuracyM: number
}

/** Every estimator has this shape, so the BLE provider can switch between them by name. */
export type PositionEstimator = (ranges: BeaconRange[]) => PositionEstimate | null

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
export const weightedCentroid: PositionEstimator = (ranges) => {
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
export const leastSquares: PositionEstimator = (ranges) => {
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

export const estimators = { weightedCentroid, leastSquares }
export type EstimatorName = keyof typeof estimators
