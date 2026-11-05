// Fits a FloorTransform from surveyed control points: spots whose lat/lon and floor plan position are both known
// (e.g. building corners read off a satellite image and the floor plan).

import type { FloorTransform, Wgs84 } from '../types'
import { wgs84ToEnu } from './wgs84'

export interface ControlPoint {
  lat: number
  lon: number
  /** Position on the floor plan, in plan units (x right, y down) */
  x: number
  y: number
}

/**
 * Least-squares similarity fit (rotation + uniform scale + offset, no shear) from plan to ENU.
 * `rmsErrorM` is how far, on average, the fitted transform puts the control points from where they were surveyed.
 */
export function fitFloorTransform(
  floor: { floorId: string, floorZ: number },
  points: ControlPoint[],
  origin: Wgs84
): { transform: FloorTransform, rmsErrorM: number } {
  if (points.length < 2) throw new Error('fitFloorTransform needs at least 2 control points')

  // Plan points with y flipped to point up, so both frames are right-handed
  const src = points.map((p) => ({ x: p.x, y: -p.y }))
  const dst = points.map((p) => {
    const { e, n } = wgs84ToEnu({ lat: p.lat, lon: p.lon, h: origin.h }, origin)
    return { x: e, y: n }
  })
  const mean = (pts: Array<{ x: number, y: number }>) => ({
    x: pts.reduce((sum, p) => sum + p.x, 0) / pts.length,
    y: pts.reduce((sum, p) => sum + p.y, 0) / pts.length
  })
  const srcMean = mean(src)
  const dstMean = mean(dst)

  let a = 0 // sum of dot products of the centered points
  let b = 0 // sum of cross products
  let srcVar = 0
  src.forEach((s, i) => {
    const sx = s.x - srcMean.x
    const sy = s.y - srcMean.y
    const dx = dst[i]!.x - dstMean.x
    const dy = dst[i]!.y - dstMean.y
    a += sx * dx + sy * dy
    b += sx * dy - sy * dx
    srcVar += sx * sx + sy * sy
  })
  const angle = Math.atan2(b, a) // counterclockwise rotation from plan (y up) to ENU
  const scale = Math.hypot(a, b) / srcVar
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const apply = (p: { x: number, y: number }) => ({ x: scale * (cos * p.x - sin * p.y), y: scale * (sin * p.x + cos * p.y) })

  const offset = apply(srcMean)
  const transform: FloorTransform = {
    floorId: floor.floorId,
    origin: { e: dstMean.x - offset.x, n: dstMean.y - offset.y },
    // FloorTransform rotates clockwise (a compass bearing), the fit counterclockwise
    rotationDeg: ((-angle * 180) / Math.PI + 360) % 360,
    scale,
    floorZ: floor.floorZ
  }

  const squaredErrors = src.map((s, i) => {
    const fitted = apply(s)
    return (transform.origin.e + fitted.x - dst[i]!.x) ** 2 + (transform.origin.n + fitted.y - dst[i]!.y) ** 2
  })
  const rmsErrorM = Math.sqrt(squaredErrors.reduce((sum, e) => sum + e, 0) / points.length)
  return { transform, rmsErrorM }
}
