import { describe, expect, it } from 'vitest'
import { enuToPlan, planToEnu } from './floorTransform'
import { pointInPolygon } from './polygon'
import { ecefToEnu, ecefToWgs84, enuToWgs84, wgs84ToEcef, wgs84ToEnu } from './wgs84'
import type { FloorTransform } from '../types'

const CM = 0.01

describe('WGS84 <-> ECEF', () => {
  // Reference values: equator/poles follow from the ellipsoid axes; 45° N is the standard textbook example
  const references = [
    { wgs84: { lat: 0, lon: 0, h: 0 }, ecef: { x: 6378137, y: 0, z: 0 } },
    { wgs84: { lat: 0, lon: 90, h: 0 }, ecef: { x: 0, y: 6378137, z: 0 } },
    { wgs84: { lat: 0, lon: 0, h: 1000 }, ecef: { x: 6379137, y: 0, z: 0 } },
    { wgs84: { lat: 90, lon: 0, h: 0 }, ecef: { x: 0, y: 0, z: 6356752.314245 } },
    { wgs84: { lat: 45, lon: 0, h: 0 }, ecef: { x: 4517590.878849, y: 0, z: 4487348.408866 } }
  ]

  it.each(references)('converts $wgs84 to ECEF', ({ wgs84, ecef }) => {
    const out = wgs84ToEcef(wgs84)
    expect(out.x).toBeCloseTo(ecef.x, 3)
    expect(out.y).toBeCloseTo(ecef.y, 3)
    expect(out.z).toBeCloseTo(ecef.z, 3)
  })

  it.each(references.filter((r) => r.wgs84.lat !== 90))('converts ECEF back to $wgs84', ({ wgs84, ecef }) => {
    const out = ecefToWgs84(ecef)
    expect(out.lat).toBeCloseTo(wgs84.lat, 9)
    expect(out.lon).toBeCloseTo(wgs84.lon, 9)
    expect(out.h).toBeCloseTo(wgs84.h, 3)
  })

  it('round-trips points around the world to < 1 cm', () => {
    for (const p of [
      { lat: 32.9886, lon: -96.7493, h: 170 },
      { lat: -33.8688, lon: 151.2093, h: 58 },
      { lat: 64.1466, lon: -21.9426, h: -30 },
      { lat: 1.3521, lon: 103.8198, h: 9000 }
    ]) {
      const back = wgs84ToEcef(ecefToWgs84(wgs84ToEcef(p)))
      const ref = wgs84ToEcef(p)
      expect(Math.hypot(back.x - ref.x, back.y - ref.y, back.z - ref.z)).toBeLessThan(CM)
    }
  })
})

describe('ECEF <-> ENU', () => {
  it('uses east = +y, north = +z, up = +x at lat 0, lon 0', () => {
    const origin = { lat: 0, lon: 0, h: 0 }
    const enu = ecefToEnu({ x: 6378137 + 5, y: 50, z: 100 }, origin)
    expect(enu.e).toBeCloseTo(50, 9)
    expect(enu.n).toBeCloseTo(100, 9)
    expect(enu.u).toBeCloseTo(5, 9)
  })

  it('puts the origin at (0, 0, 0) and a higher point straight up', () => {
    const origin = { lat: 32.9886, lon: -96.7493, h: 170 }
    const at = wgs84ToEnu(origin, origin)
    expect(Math.hypot(at.e, at.n, at.u)).toBeLessThan(1e-6)
    const above = wgs84ToEnu({ ...origin, h: 180 }, origin)
    expect(above.u).toBeCloseTo(10, 6)
    expect(Math.hypot(above.e, above.n)).toBeLessThan(1e-6)
  })

  it('puts a point slightly north at positive n (about 111 km per degree)', () => {
    const origin = { lat: 32.9886, lon: -96.7493, h: 170 }
    const enu = wgs84ToEnu({ ...origin, lat: origin.lat + 0.001 }, origin)
    expect(enu.n).toBeGreaterThan(110)
    expect(enu.n).toBeLessThan(112)
    expect(Math.abs(enu.e)).toBeLessThan(1e-6)
  })

  it('round-trips campus-scale ENU points to < 1 cm', () => {
    const origin = { lat: 32.9886, lon: -96.7493, h: 170 }
    for (const p of [
      { e: 0, n: 0, u: 0 },
      { e: 120.5, n: -40.25, u: 4.5 },
      { e: -2500, n: 1800, u: -12 },
      { e: 5000, n: 5000, u: 30 }
    ]) {
      const back = wgs84ToEnu(enuToWgs84(p, origin), origin)
      expect(Math.hypot(back.e - p.e, back.n - p.n, back.u - p.u)).toBeLessThan(CM)
    }
  })
})

describe('floor plan <-> ENU', () => {
  const base: FloorTransform = { floorId: 'f', origin: { e: 100, n: 80 }, rotationDeg: 0, scale: 0.1, floorZ: 4.5 }

  it('maps plan right to east and plan down to south when not rotated', () => {
    expect(planToEnu({ x: 0, y: 0 }, base)).toEqual({ e: 100, n: 80, u: 4.5 })
    const p = planToEnu({ x: 100, y: 50 }, base)
    expect(p.e).toBeCloseTo(110)
    expect(p.n).toBeCloseTo(75)
  })

  it('rotates: with plan up pointing east, plan right points south', () => {
    const rotated = { ...base, rotationDeg: 90 }
    const right = planToEnu({ x: 10, y: 0 }, rotated)
    expect(right.e).toBeCloseTo(100)
    expect(right.n).toBeCloseTo(79)
    const up = planToEnu({ x: 0, y: -10 }, rotated)
    expect(up.e).toBeCloseTo(101)
    expect(up.n).toBeCloseTo(80)
  })

  it('round-trips plan points to < 1 cm for any rotation', () => {
    for (const rotationDeg of [0, 17.5, 90, 200, -45]) {
      const t = { ...base, rotationDeg, scale: 0.0732 }
      for (const point of [{ x: 0, y: 0 }, { x: 226, y: 478 }, { x: 13.7, y: 301.2 }]) {
        const back = enuToPlan(planToEnu(point, t), t)
        expect(Math.hypot(back.x - point.x, back.y - point.y) * t.scale).toBeLessThan(CM)
      }
    }
  })
})

describe('pointInPolygon', () => {
  const square = [{ e: 0, n: 0 }, { e: 10, n: 0 }, { e: 10, n: 10 }, { e: 0, n: 10 }]
  it('tells inside from outside', () => {
    expect(pointInPolygon({ e: 5, n: 5 }, square)).toBe(true)
    expect(pointInPolygon({ e: 15, n: 5 }, square)).toBe(false)
    expect(pointInPolygon({ e: 5, n: -1 }, square)).toBe(false)
  })
})
