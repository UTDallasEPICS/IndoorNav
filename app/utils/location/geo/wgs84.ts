// WGS84 <-> ECEF <-> local ENU conversions. Pure functions, no dependencies.

import type { Ecef, Enu, Wgs84 } from '../types'

// WGS84 ellipsoid constants
const A = 6378137 // semi-major axis (m)
const F = 1 / 298.257223563 // flattening
const E2 = F * (2 - F) // first eccentricity squared

const toRad = (deg: number) => (deg * Math.PI) / 180
const toDeg = (rad: number) => (rad * 180) / Math.PI

export function wgs84ToEcef({ lat, lon, h }: Wgs84): Ecef {
  const phi = toRad(lat)
  const lambda = toRad(lon)
  const sinPhi = Math.sin(phi)
  // Prime vertical radius of curvature
  const N = A / Math.sqrt(1 - E2 * sinPhi * sinPhi)
  return {
    x: (N + h) * Math.cos(phi) * Math.cos(lambda),
    y: (N + h) * Math.cos(phi) * Math.sin(lambda),
    z: (N * (1 - E2) + h) * sinPhi
  }
}

export function ecefToWgs84({ x, y, z }: Ecef): Wgs84 {
  const lon = Math.atan2(y, x)
  const p = Math.hypot(x, y)
  // Iterate latitude and height; converges to sub-millimeter in a few steps away from the poles
  let lat = Math.atan2(z, p * (1 - E2))
  let h = 0
  for (let i = 0; i < 10; i++) {
    const sinLat = Math.sin(lat)
    const N = A / Math.sqrt(1 - E2 * sinLat * sinLat)
    h = p / Math.cos(lat) - N
    const next = Math.atan2(z, p * (1 - (E2 * N) / (N + h)))
    if (Math.abs(next - lat) < 1e-12) {
      lat = next
      break
    }
    lat = next
  }
  return { lat: toDeg(lat), lon: toDeg(lon), h }
}

/** ECEF -> ENU relative to `origin`. */
export function ecefToEnu(point: Ecef, origin: Wgs84): Enu {
  const o = wgs84ToEcef(origin)
  const dx = point.x - o.x
  const dy = point.y - o.y
  const dz = point.z - o.z
  const phi = toRad(origin.lat)
  const lambda = toRad(origin.lon)
  const sinPhi = Math.sin(phi)
  const cosPhi = Math.cos(phi)
  const sinLam = Math.sin(lambda)
  const cosLam = Math.cos(lambda)
  return {
    e: -sinLam * dx + cosLam * dy,
    n: -sinPhi * cosLam * dx - sinPhi * sinLam * dy + cosPhi * dz,
    u: cosPhi * cosLam * dx + cosPhi * sinLam * dy + sinPhi * dz
  }
}

/** ENU relative to `origin` -> ECEF. */
export function enuToEcef({ e, n, u }: Enu, origin: Wgs84): Ecef {
  const o = wgs84ToEcef(origin)
  const phi = toRad(origin.lat)
  const lambda = toRad(origin.lon)
  const sinPhi = Math.sin(phi)
  const cosPhi = Math.cos(phi)
  const sinLam = Math.sin(lambda)
  const cosLam = Math.cos(lambda)
  return {
    x: o.x - sinLam * e - sinPhi * cosLam * n + cosPhi * cosLam * u,
    y: o.y + cosLam * e - sinPhi * sinLam * n + cosPhi * sinLam * u,
    z: o.z + cosPhi * n + sinPhi * u
  }
}

export function wgs84ToEnu(point: Wgs84, origin: Wgs84): Enu {
  return ecefToEnu(wgs84ToEcef(point), origin)
}

export function enuToWgs84(point: Enu, origin: Wgs84): Wgs84 {
  return ecefToWgs84(enuToEcef(point, origin))
}
