import { describe, expect, it } from 'vitest'
import { sampleVenue } from '../fixtures/sampleVenue'
import { sampleWalk } from '../fixtures/sampleWalk'
import { LocationService } from '../LocationService'
import { BleProvider } from '../providers/ble/BleProvider'
import { MockBleScanner } from '../providers/ble/scanner'
import { GpsProvider } from '../providers/gps/GpsProvider'
import { MockGpsSource } from '../providers/gps/gpsSource'
import { DEFAULT_SIM, errorReport, generateAdverts, runSimulation, truthAt } from './simulator'

describe('simulator building blocks', () => {
  it('interpolates the ground truth between waypoints', () => {
    expect(truthAt(sampleWalk, 15)).toEqual({ e: 130, n: 29.5, floorId: null })
    expect(truthAt(sampleWalk, 72).floorId).toBe('test-l1')
    expect(truthAt(sampleWalk, 76).floorId).toBe('test-l2')
  })

  it('is repeatable for the same seed', () => {
    expect(generateAdverts(sampleWalk, sampleVenue)).toEqual(generateAdverts(sampleWalk, sampleVenue))
  })

  it('computes mean, p50 and p90', () => {
    // All at t = 0, where the truth is (130, 10), with errors of 1..10 m
    const fixes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((err) => ({
      enu: { e: 130 + err, n: 10, u: 0 },
      wgs84: { lat: 0, lon: 0, h: 0 },
      floorId: null,
      buildingId: null,
      accuracyM: 1,
      timestamp: DEFAULT_SIM.startTime,
      source: 'fused' as const,
      isIndoor: false
    }))
    expect(errorReport(fixes, sampleWalk)).toMatchObject({ count: 10, meanM: 5.5, p50M: 5, p90M: 9, maxM: 10, indoorCorrectRate: 1 })
  })
})

describe('end-to-end simulated walk', () => {
  it.each(['weightedCentroid', 'leastSquares'] as const)('tracks the walk with the %s estimator', async (estimator) => {
    const result = await runSimulation({ venue: sampleVenue, path: sampleWalk, ble: { estimator } })
    // Thresholds for this synthetic data (4 dB RSSI noise, imperfect path loss model). Real-world
    // accuracy has to be measured in the building.
    expect(result.report.count).toBeGreaterThan(90)
    expect(result.report.meanM).toBeLessThan(6)
    expect(result.report.p90M).toBeLessThan(11)
    expect(result.report.floorCorrectRate).toBeGreaterThan(0.9)
    expect(result.report.indoorCorrectRate).toBeGreaterThan(0.9)
    expect(result.events.map((e) => e.type)).toEqual([
      'indoorOutdoorTransition',
      'buildingEntered',
      'floorChanged',
      'floorChanged'
    ])
    expect(result.events.at(-1)).toMatchObject({ from: 'test-l1', to: 'test-l2' })
  })

  it('fusion improves on raw BLE fixes', async () => {
    const result = await runSimulation({ venue: sampleVenue, path: sampleWalk })
    expect(result.report.meanM).toBeLessThan(result.bleReport.meanM)
  })

  it('keeps working on GPS alone when Bluetooth is denied', async () => {
    const scanner = new MockBleScanner()
    scanner.failWith = new Error('Bluetooth permission denied')
    const gps = new MockGpsSource()
    const service = new LocationService({ providers: [new BleProvider(scanner), new GpsProvider(gps)] })
    await service.start(sampleVenue)
    expect(service.status.ble?.state).toBe('permission-denied')
    expect(service.status.gps?.state).toBe('running')

    const fixes: unknown[] = []
    const unsubscribe = service.subscribe((fix) => fixes.push(fix))
    gps.emit({ lat: sampleVenue.origin.lat, lon: sampleVenue.origin.lon, altitude: null, accuracyM: 5, headingDeg: null, timestamp: 0 })
    expect(fixes).toHaveLength(1)
    expect(service.currentFix).toMatchObject({ source: 'fused', isIndoor: false })

    unsubscribe()
    gps.emit({ lat: sampleVenue.origin.lat, lon: sampleVenue.origin.lon, altitude: null, accuracyM: 5, headingDeg: null, timestamp: 1000 })
    expect(fixes).toHaveLength(1)
    await service.stop()
  })
})
