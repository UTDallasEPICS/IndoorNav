import { describe, expect, it } from 'vitest'
import { sampleVenue } from '../../fixtures/sampleVenue'
import type { LocationFix, ProviderStatus } from '../../types'
import { BleProvider } from './BleProvider'
import { parseEddystoneUid } from './eddystone'
import { ApRssiBank } from './apRssi'
import { leastSquares, rssiFit, weightedCentroid, type BeaconObservation, type BeaconRange } from './estimators'
import { voteFloor } from './floorVote'
import { distanceToRssi, rssiToDistance } from './pathLoss'
import { MockBleScanner } from './scanner'

describe('ApRssiBank', () => {
  it('averages a beacon over the window and evicts beacons not heard within it', () => {
    const bank = new ApRssiBank({ sliceMs: 1000, windowMs: 3000 })
    bank.add('a', 'a', -60, 0)
    bank.add('a', 'a', -64, 100)
    bank.add('b', 'b', -70, 0)
    bank.add('a', 'a', -70, 2500)
    const readings = new Map(bank.readings(2600).map((r) => [r.beaconId, r]))
    // a: one slice at -70, one at (-60 + -64) / 2
    expect(readings.get('a')).toMatchObject({ rssi: -66, lastSeen: 2500 })
    expect(readings.get('b')!.rssi).toBe(-70)
    // b was last heard at 0 ms, so at 3500 ms it is gone
    expect(bank.readings(3500).map((r) => r.beaconId)).toEqual(['a'])
  })

  it('reads an AP as its strongest beam each second, like the survey', () => {
    const bank = new ApRssiBank({ sliceMs: 1000, windowMs: 3000 })
    for (let t = 0; t < 3000; t += 250) {
      // Beam 2 points at the phone; the others are 6 and 12 dB down
      bank.add('ap', 'ap-beam0', -72, t)
      bank.add('ap', 'ap-beam1', -66, t + 10)
      bank.add('ap', 'ap-beam2', -60 + (t % 500 ? 1 : -1), t + 20)
    }
    expect(bank.readings(2999)[0]!.rssi).toBeCloseTo(-60, 5)
  })

  it('follows the handover when another beam becomes the strongest', () => {
    const bank = new ApRssiBank({ sliceMs: 1000, windowMs: 2000 })
    bank.add('ap', 'beam0', -60, 100)
    bank.add('ap', 'beam1', -70, 100)
    bank.add('ap', 'beam0', -72, 1100)
    bank.add('ap', 'beam1', -62, 1100)
    expect(bank.readings(1999)[0]!.rssi).toBe(-61)
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

describe('rssiFit', () => {
  const beacons = [{ e: 0, n: 0 }, { e: 20, n: 0 }, { e: 0, n: 20 }, { e: 20, n: 20 }, { e: 10, n: 30 }]
  /** What a phone at (e, n) hears, with `errorDb[i]` added to beacon i */
  const hear = (e: number, n: number, errorDb: number[] = [], layout = beacons): BeaconObservation[] => layout.map((b, i) => {
    const rssi = distanceToRssi(Math.hypot(b.e - e, b.n - n, 1.8), -55, 2.6) + (errorDb[i] ?? 0)
    const distance = rssiToDistance(rssi, -55, 2.6)
    return { ...b, distanceM: Math.sqrt(Math.max(distance ** 2 - 1.8 ** 2, 0)), rssi, txPower: -55, pathLossExponent: 2.6, dzM: 1.8, sigmaDb: 4, positionSigmaM: 1 }
  })

  it('recovers the position from perfect readings', () => {
    const est = rssiFit(hear(4, 6))!
    expect(Math.hypot(est.e - 4, est.n - 6)).toBeLessThan(0.1)
    expect(est.meanResidualDb).toBeCloseTo(0, 1)
    expect(est.used).toBe(5)
  })

  it('shrugs off one badly blocked beacon, which drags the range fit away', () => {
    const grid = [0, 15, 30].flatMap((e) => [0, 15, 30].map((n) => ({ e, n }))).slice(0, 8)
    // Standing at (12, 11): the beacon at (15, 15) is the nearest, and someone is standing in front of it
    const blocked = hear(12, 11, [0, 0, 0, 0, -20], grid)
    const fit = rssiFit(blocked)!
    const ranges = leastSquares(blocked)!
    expect(Math.hypot(fit.e - 12, fit.n - 11)).toBeLessThan(0.5)
    expect(fit.used).toBe(7)
    expect(Math.hypot(ranges.e - 12, ranges.n - 11)).toBeGreaterThan(2)
  })

  it('is less sure across a line of beacons than along it', () => {
    const hallway = [0, 10, 20, 30, 40].map((e) => ({ e, n: 0 }))
    const est = rssiFit(hear(17, 1, [], hallway))!
    expect(est.covariance!.nn).toBeGreaterThan(est.covariance!.ee * 4)
    expect(est.accuracyM).toBeCloseTo(Math.sqrt(est.covariance!.ee + est.covariance!.nn))
  })

  it('reports a phone that hears everything weak as a negative mean residual', () => {
    expect(rssiFit(hear(8, 12, [-6, -6, -6, -6, -6]))!.meanResidualDb).toBeLessThan(-1)
  })

  it('uses only the strongest beacons', () => {
    const far = Array.from({ length: 10 }, (_, i) => ({ e: 100 + 10 * i, n: 80 }))
    expect(rssiFit(hear(4, 6, [], [...beacons, ...far]))!.used).toBe(8)
  })

  it('falls back to the centroid with fewer than 3 beacons', () => {
    const two = hear(4, 6).slice(0, 2)
    expect(rssiFit(two)).toEqual(weightedCentroid(two))
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

  it('emits fixes on the voted floor, at most once per update interval, after the first second', async () => {
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

    expect(fixes.map((f) => f.timestamp)).toEqual([1000, 2000, 3000])
    const last = fixes.at(-1)!
    expect(last.floorId).toBe('test-l1')
    expect(last.buildingId).toBe('test-bldg')
    expect(last.source).toBe('ble')
    expect(last.enu.u).toBe(0)
    expect(Math.hypot(last.enu.e - stand.e, last.enu.n - stand.n)).toBeLessThan(0.1)
  })

  it('matches every vBLE beam of an AP to its grouped (`*`) registry entry', async () => {
    // Give each L1 beacon a grouped ID, then hear it through a different beam digit each time, plus a beam 10 dB
    // weaker that must not pull the AP's reading down
    const grouped = l1.map((b, i) => ({ ...b, id: `a023919cd30a4e79bbd9:4102${i}*e40000` }))
    const scanner = new MockBleScanner()
    const provider = new BleProvider(scanner, { updateIntervalMs: 1000 })
    const fixes: LocationFix[] = []
    provider.onFix((fix) => fixes.push(fix))
    await provider.start({ ...sampleVenue, beacons: [...grouped, ...sampleVenue.beacons.filter((b) => b.floorId !== 'test-l1')] })

    const stand = { e: 125, n: 60, u: 1.2 }
    for (let t = 0; t <= 2000; t += 250) {
      for (const b of grouped) {
        const d = Math.hypot(b.enu.e - stand.e, b.enu.n - stand.n, b.enu.u - stand.u)
        const rssi = distanceToRssi(d, b.txPower, b.pathLossExponent)
        scanner.emit({ beaconId: b.id.replace('*', String((t / 250) % 8)), rssi, timestamp: t })
        scanner.emit({ beaconId: b.id.replace('*', '8'), rssi: rssi - 10, timestamp: t })
      }
    }
    // Same AP digits but another instance suffix: not ours
    scanner.emit({ beaconId: 'a023919cd30a4e79bbd9:410203d80000', rssi: -40, timestamp: 2100 })

    const last = fixes.at(-1)!
    expect(last.floorId).toBe('test-l1')
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
