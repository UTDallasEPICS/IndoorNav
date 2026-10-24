import { describe, expect, it } from 'vitest'
import { planToEnu } from './geo/floorTransform'
import { fitFloorTransform } from './geo/georef'
import { enuToWgs84 } from './geo/wgs84'
import { LocationService } from './LocationService'
import { headingOnPlan, toMapPosition } from './mapPosition'
import { BleProvider } from './providers/ble/BleProvider'
import { distanceToRssi } from './providers/ble/pathLoss'
import { MockBleScanner } from './providers/ble/scanner'
import type { BeaconRegistryEntry, FloorTransform, MapPosition, VenueConfig } from './types'
import { indexVenue } from './venue'
import { SPN_LEVEL1_FIT, SPN_ORIGIN, spnVenue } from './venues/spn'

describe('fitFloorTransform', () => {
  it('recovers a known transform from its own control points', () => {
    const truth: FloorTransform = { floorId: 'f', origin: { e: 40, n: -25 }, rotationDeg: 33, scale: 0.12, floorZ: 0 }
    const points = [[0, 0], [500, 40], [120, 300], [480, 310]].map(([x, y]) => {
      const { lat, lon } = enuToWgs84(planToEnu({ x: x!, y: y! }, truth), SPN_ORIGIN)
      return { lat, lon, x: x!, y: y! }
    })
    const { transform, rmsErrorM } = fitFloorTransform({ floorId: 'f', floorZ: 0 }, points, SPN_ORIGIN)
    expect(rmsErrorM).toBeLessThan(0.01)
    expect(transform.rotationDeg).toBeCloseTo(33, 3)
    expect(transform.scale).toBeCloseTo(0.12, 5)
    expect(transform.origin.e).toBeCloseTo(40, 2)
    expect(transform.origin.n).toBeCloseTo(-25, 2)
  })

  it('fits the SPN1 level 1 corners consistently', () => {
    // The three corners should agree on one rotation + scale to within a few meters
    expect(SPN_LEVEL1_FIT.rmsErrorM).toBeLessThan(5)
    // The map page used ~0.00782 map widths per meter, i.e. a map about 128 m wide
    expect(SPN_LEVEL1_FIT.transform.scale).toBeGreaterThan(115)
    expect(SPN_LEVEL1_FIT.transform.scale).toBeLessThan(140)
  })
})

describe('toMapPosition', () => {
  const index = indexVenue(spnVenue)
  const floor = spnVenue.buildings[0]!.floors[0]!

  it('turns an ENU fix into map fractions, floor level and accuracy', () => {
    const enu = planToEnu({ x: 0.3, y: 0.6 * floor.plan!.height }, floor.transform)
    const position = toMapPosition({
      enu, wgs84: enuToWgs84(enu, SPN_ORIGIN), floorId: floor.id, buildingId: 'spn1',
      accuracyM: 3.5, timestamp: 42, source: 'fused', isIndoor: true
    }, index)
    expect(position!.x).toBeCloseTo(0.3, 6)
    expect(position!.y).toBeCloseTo(0.6, 6)
    expect(position).toMatchObject({ floor: 1, accuracyM: 3.5, timestamp: 42 })
  })

  it('gives null without a floor', () => {
    const enu = { e: 0, n: 0, u: 0 }
    expect(toMapPosition({
      enu, wgs84: SPN_ORIGIN, floorId: null, buildingId: null, accuracyM: 5, timestamp: 0, source: 'fused', isIndoor: false
    }, index)).toBeNull()
  })
})

describe('headingOnPlan', () => {
  it('is the compass bearing on a north-up plan', () => {
    expect(headingOnPlan(0, 0)).toBeCloseTo(0)
    expect(headingOnPlan(90, 0)).toBeCloseTo(90)
    expect(headingOnPlan(225, 0)).toBeCloseTo(225)
  })

  it('agrees with where planToEnu puts the plan\'s up and right on a rotated plan', () => {
    const transform: FloorTransform = { floorId: 'f', origin: { e: 0, n: 0 }, rotationDeg: 33, scale: 1, floorZ: 0 }
    const bearingOf = (x: number, y: number) => {
      const { e, n } = planToEnu({ x, y }, transform)
      return (Math.atan2(e, n) * 180 / Math.PI + 360) % 360
    }
    expect(headingOnPlan(bearingOf(0, -1), 33)).toBeCloseTo(0) // walking toward the map's top
    expect(headingOnPlan(bearingOf(1, 0), 33)).toBeCloseTo(90) // toward its right edge
  })
})

describe('LocationService map positions', () => {
  it('reports BLE-only positions on the SPN1 map', async () => {
    // Made-up beacons at map fractions, mounted 3 m up, so we can feed ideal RSSI for a known spot
    const floor = spnVenue.buildings[0]!.floors[0]!
    const H = floor.plan!.height
    const toEnu = (fx: number, fy: number) => planToEnu({ x: fx, y: fy * H }, floor.transform)
    const beacons: BeaconRegistryEntry[] = [[0.3, 0.3], [0.5, 0.3], [0.3, 0.7], [0.5, 0.7]].map(([fx, fy], i) => {
      const enu = toEnu(fx!, fy!)
      return { id: `test:${i}`, enu: { ...enu, u: 3 }, floorId: floor.id, txPower: -59, pathLossExponent: 2.2 }
    })
    const venue: VenueConfig = { ...spnVenue, beacons }

    const scanner = new MockBleScanner()
    const service = new LocationService({ providers: [new BleProvider(scanner)] })
    const positions: MapPosition[] = []
    service.subscribePosition((p) => positions.push(p))
    await service.start(venue)

    const truth = toEnu(0.42, 0.5)
    for (let t = 0; t < 5000; t += 250) {
      for (const b of beacons) {
        const distance = Math.hypot(b.enu.e - truth.e, b.enu.n - truth.n, b.enu.u - 1.2)
        scanner.emit({ beaconId: b.id, rssi: distanceToRssi(distance, b.txPower, b.pathLossExponent), timestamp: t })
      }
    }

    const last = service.currentPosition!
    expect(positions.length).toBeGreaterThan(0)
    expect(last.floor).toBe(1)
    // Within 1 m of the truth (one map width is ~128 m)
    expect(Math.hypot(last.x - 0.42, (last.y - 0.5) * H) * floor.transform.scale).toBeLessThan(1)
    expect(last.accuracyM).toBeGreaterThan(0)

    await service.stop()
    expect(service.currentPosition).toBeNull()
  })
})
