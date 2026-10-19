import { describe, expect, it } from 'vitest'
import { sampleVenue } from '../../fixtures/sampleVenue'
import type { LocationFix, ProviderStatus } from '../../types'
import { BleProvider } from './BleProvider'
import { parseEddystoneUid } from './eddystone'
import { leastSquares, weightedCentroid, type BeaconRange } from './estimators'
import { voteFloor } from './floorVote'
import { distanceToRssi, rssiToDistance } from './pathLoss'
import { RssiFilter, RssiFilterBank } from './rssiFilter'
import { MockBleScanner } from './scanner'

describe('RssiFilter', () => {
  it('ignores a single spike thanks to the median', () => {
    const filter = new RssiFilter()
    let out = 0
    const readings = [-70, -70, -70, -70, -40, -70, -70]
    readings.forEach((rssi, i) => { out = filter.add(rssi, i * 200) })
    expect(out).toBeCloseTo(-70, 1)
  })

  it('reduces noise around a constant level', () => {
    const filter = new RssiFilter()
    const outputs: number[] = []
    for (let i = 0; i < 100; i++) outputs.push(filter.add(-70 + (i % 2 ? 6 : -6), i * 200))
    for (const out of outputs.slice(20)) expect(Math.abs(out + 70)).toBeLessThan(2)
  })

  it('follows a real step change within a few seconds', () => {
    const filter = new RssiFilter()
    let out = 0
    for (let i = 0; i < 10; i++) out = filter.add(-80, i * 200)
    for (let i = 10; i < 30; i++) out = filter.add(-65, i * 200)
    expect(out).toBeGreaterThan(-67)
  })
})

describe('RssiFilterBank', () => {
  it('keeps one filter per beacon and evicts stale beacons', () => {
    const bank = new RssiFilterBank(4000)
    bank.add('a', -60, 0)
    bank.add('b', -70, 0)
    bank.add('a', -60, 3000)
    expect(bank.readings(3000).map((r) => r.beaconId).sort()).toEqual(['a', 'b'])
    // b was last heard at 0 ms, so at 4500 ms it is stale
    expect(bank.readings(4500).map((r) => r.beaconId)).toEqual(['a'])
  })
})

describe('path loss', () => {
  it('returns 1 m at txPower and is inverted by distanceToRssi', () => {
    expect(rssiToDistance(-59, -59, 2)).toBeCloseTo(1)
    expect(rssiToDistance(-79, -59, 2)).toBeCloseTo(10)
    expect(rssiToDistance(distanceToRssi(7.3, -59, 2.4), -59, 2.4)).toBeCloseTo(7.3)
  })
})

describe('position estimators', () => {
  const beacons = [{ e: 0, n: 0 }, { e: 20, n: 0 }, { e: 0, n: 20 }, { e: 20, n: 20 }]
  const rangesTo = (e: number, n: number, error = 0): BeaconRange[] =>
    beacons.map((b, i) => ({ ...b, distanceM: Math.hypot(b.e - e, b.n - n) + (i % 2 ? error : -error) }))

  it('both return null with no beacons', () => {
    expect(weightedCentroid([])).toBeNull()
    expect(leastSquares([])).toBeNull()
  })

  it('weighted centroid returns the center for a symmetric layout', () => {
    const est = weightedCentroid(rangesTo(10, 10))!
    expect(est.e).toBeCloseTo(10)
    expect(est.n).toBeCloseTo(10)
  })

  it('weighted centroid is pulled toward the nearest beacon', () => {
    const est = weightedCentroid(rangesTo(4, 6))!
    expect(est.e).toBeLessThan(10)
    expect(est.n).toBeLessThan(10)
  })

  it('least squares recovers an off-center position exactly from perfect ranges', () => {
    const est = leastSquares(rangesTo(4, 6))!
    expect(est.e).toBeCloseTo(4, 3)
    expect(est.n).toBeCloseTo(6, 3)
    expect(est.accuracyM).toBe(1.5) // floor value; residual is ~0
  })

  it('least squares stays close with noisy ranges and reports the misfit', () => {
    const est = leastSquares(rangesTo(4, 6, 1.5))!
    expect(Math.hypot(est.e - 4, est.n - 6)).toBeLessThan(3)
    expect(est.accuracyM).toBeGreaterThan(0)
  })

  it('least squares falls back to the centroid with fewer than 3 beacons', () => {
    const two = rangesTo(4, 6).slice(0, 2)
    expect(leastSquares(two)).toEqual(weightedCentroid(two))
  })
})

describe('voteFloor', () => {
  it('picks the floor of the strongest beacons', () => {
    expect(voteFloor([
      { floorId: 'l1', rssi: -60 },
      { floorId: 'l2', rssi: -75 },
      { floorId: 'l2', rssi: -78 },
      { floorId: 'l1', rssi: -70 }
    ])).toBe('l1')
  })

  it('returns null with no readings', () => {
    expect(voteFloor([])).toBeNull()
  })
})

describe('parseEddystoneUid', () => {
  it('reads namespace, instance and Tx power from a UID frame', () => {
    const bytes = new Uint8Array(20)
    bytes[0] = 0x00
    bytes[1] = 0xee // -18 dBm at 0 m
    for (let i = 0; i < 10; i++) bytes[2 + i] = 0xa0 + i
    for (let i = 0; i < 6; i++) bytes[12 + i] = i
    const uid = parseEddystoneUid(new DataView(bytes.buffer))
    expect(uid).toEqual({ id: 'a0a1a2a3a4a5a6a7a8a9:000102030405', txPowerAt0m: -18 })
  })

  it('ignores other frame types', () => {
    const bytes = new Uint8Array(20)
    bytes[0] = 0x10 // URL frame
    expect(parseEddystoneUid(new DataView(bytes.buffer))).toBeNull()
  })
})

describe('BleProvider', () => {
  const l1 = sampleVenue.beacons.filter((b) => b.floorId === 'test-l1')

  it('emits fixes on the voted floor, at most once per update interval', async () => {
    const scanner = new MockBleScanner()
    const provider = new BleProvider(scanner, { updateIntervalMs: 1000 })
    const fixes: LocationFix[] = []
    provider.onFix((fix) => fixes.push(fix))
    await provider.start(sampleVenue)

    // Stand still at (125, 60) on L1 and hear every L1 beacon at its noise-free RSSI (phone 1.2 m up)
    const stand = { e: 125, n: 60, u: 1.2 }
    for (let t = 0; t <= 3000; t += 250) {
      for (const b of l1) {
        const d = Math.hypot(b.enu.e - stand.e, b.enu.n - stand.n, b.enu.u - stand.u)
        scanner.emit({ beaconId: b.id, rssi: distanceToRssi(d, b.txPower, b.pathLossExponent), timestamp: t })
      }
    }
    scanner.emit({ beaconId: 'unknown:beacon', rssi: -40, timestamp: 3100 })

    expect(fixes.map((f) => f.timestamp)).toEqual([0, 1000, 2000, 3000])
    const last = fixes.at(-1)!
    expect(last.floorId).toBe('test-l1')
    expect(last.buildingId).toBe('test-bldg')
    expect(last.source).toBe('ble')
    expect(last.enu.u).toBe(0)
    expect(Math.hypot(last.enu.e - stand.e, last.enu.n - stand.n)).toBeLessThan(0.1)
  })

  it('reports permission errors through status instead of throwing', async () => {
    const scanner = new MockBleScanner()
    scanner.failWith = new Error('Bluetooth permission denied')
    const provider = new BleProvider(scanner)
    const statuses: ProviderStatus[] = []
    provider.onStatus((s) => statuses.push(s))
    await provider.start(sampleVenue)
    expect(statuses.at(-1)).toMatchObject({ provider: 'ble', state: 'permission-denied' })
  })
})
