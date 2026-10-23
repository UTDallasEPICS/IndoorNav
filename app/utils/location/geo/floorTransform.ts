// Floor plan (pixels / grid cells, y down) <-> campus ENU (meters), via a FloorTransform.

import type { Enu, FloorTransform, PlanPoint } from '../types'

/**
 * Plan "right" (+x) and "down" (+y) as unit vectors in east/north. With rotationDeg = 0, right is east and
 * down is south. A positive rotation turns the plan clockwise as seen on a north-up map.
 */
function planAxes(rotationDeg: number) {
  const t = (rotationDeg * Math.PI) / 180
  const cos = Math.cos(t)
  const sin = Math.sin(t)
  return {
    right: { e: cos, n: -sin },
    down: { e: -sin, n: -cos }
  }
}

export function planToEnu(point: PlanPoint, transform: FloorTransform): Enu {
  const { right, down } = planAxes(transform.rotationDeg)
  const x = point.x * transform.scale
  const y = point.y * transform.scale
  return {
    e: transform.origin.e + x * right.e + y * down.e,
    n: transform.origin.n + x * right.n + y * down.n,
    u: transform.floorZ
  }
}

/** Projects an ENU point onto the floor plan (height is ignored). */
export function enuToPlan(point: { e: number, n: number }, transform: FloorTransform): PlanPoint {
  const { right, down } = planAxes(transform.rotationDeg)
  const de = point.e - transform.origin.e
  const dn = point.n - transform.origin.n
  // right and down are orthonormal, so projecting onto each axis inverts planToEnu
  return {
    x: (de * right.e + dn * right.n) / transform.scale,
    y: (de * down.e + dn * down.n) / transform.scale
  }
}
