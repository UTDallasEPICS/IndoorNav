import { describe, expect, it } from 'vitest'
import { sampleVenue } from '../../fixtures/sampleVenue'
import type { LocationFix, ProviderStatus, VenueConfig } from '../../types'
import { indexVenue } from '../../venue'
import { spnVenue } from '../../venues/spn'
import { BleProvider } from '../ble/BleProvider'
import type { FloorVote } from '../ble/floorVote'
import { distanceToRssi } from '../ble/pathLoss'
import { MockBleScanner } from '../ble/scanner'
import { BarometerProvider, type BarometerReading } from './BarometerProvider'
import { BarometerFloorTracker, pressureToAltitudeM } from './floorTracker'
import { MockPressureSource } from './pressureSource'

// SPN1: level 1 at 0 m, level 2 at 4.27 m
const L1 = 'spn1-l1'
const L2 = 'spn1-l2'
const vote = (floorId: string, share = 1): FloorVote => ({ floorId, share })

/** Pressure (hPa) at `heightM` above a ground floor where the pressure is 1000 hPa */
const GROUND_ALTITUDE = pressureToAltitudeM(1000)
const pressureAt = (heightM: number) => 1013.25 * Math.pow(1 - (GROUND_ALTITUDE + heightM) / 44330, 5.255)

/** Deterministic standard-normal noise */
function gaussian(seed: number) {
  let s = seed
  const uniform = () => ((s = (s * 1664525 + 1013904223) % 4294967296) + 1) / 4294967297
  return () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform())
}

interface Scenario {
  seconds: number
  /** User's height above the ground floor at time t (ms) */
  height: (t: number) => number
  /** The BLE vote at time t, asked once a second */
  vote: (t: number) => FloorVote | null
  /** Barometer samples per second: ~1 on iOS, ~5 on Android */
  rateHz?: number
  noiseHpa?: number
  /** Weather: pressure change per hour */
  driftHpaPerHour?: number
}

/** Runs a scenario; returns the floor chosen at each second and the tracker */
function run(scenario: Scenario, venue: VenueConfig = spnVenue) {
  const tracker = new BarometerFloorTracker()
  tracker.setVenue(indexVenue(venue))
  const noise = gaussian(7)
  const step = 1000 / (scenario.rateHz ?? 1)
  const floors: Array<string | null> = []
  for (let t = 0; t <= scenario.seconds * 1000; t += step) {
    const drift = (scenario.driftHpaPerHour ?? 0) * t / 3_600_000
    tracker.addPressure(pressureAt(scenario.height(t)) + drift + (scenario.noiseHpa ?? 0) * noise(), t)
    if (t % 1000 === 0) floors.push(tracker.chooseFloor(scenario.vote(t), t))
  }
  return { floors, tracker }
}

/** Linear ramp from `from` m at `start` ms to `to` m over `durationMs` */
const ramp = (t: number, start: number, durationMs: number, from: number, to: number) =>
  from + (to - from) * Math.min(Math.max((t - start) / durationMs, 0), 1)

describe('pressureToAltitudeM', () => {
  it('is 0 m at standard sea-level pressure, and ~8.4 m per hPa near the ground', () => {
    expect(pressureToAltitudeM(1013.25)).toBeCloseTo(0, 6)
    expect(pressureToAltitudeM(999.5) - pressureToAltitudeM(1000)).toBeCloseTo(4.2, 1)
  })
})

describe('BarometerFloorTracker', () => {
  it('uses the BLE vote until BLE has confidently agreed on a floor for 3 s, then anchors to it', () => {
    const { floors, tracker } = run({ seconds: 6, height: () => 0, vote: () => vote(L1) })
    expect(floors.slice(0, 3)).toEqual([null, null, null])
    expect(floors.slice(3)).toEqual([L1, L1, L1, L1])
    expect(tracker.state.heightM).toBeCloseTo(0, 2)
  })

  it('does not anchor to unsure votes (beacons from both floors heard about equally)', () => {
    const { floors } = run({ seconds: 10, height: () => 0, vote: () => vote(L1, 0.6) })
    expect(floors.every((f) => f === null)).toBe(true)
  })

  it('walks up the stairs to level 2 while level 1 beacons still win the vote, and doesn\'t flip back', () => {
    // 5 s on level 1, 12 s climbing, then 15 s on level 2 still hearing level 1 strongest (the worst bleed)
    const { floors } = run({
      seconds: 32,
      height: (t) => ramp(t, 5000, 12_000, 0, 4.27),
      vote: () => vote(L1)
    })
    const firstL2 = floors.indexOf(L2)
    // 60% of the way up is 2.56 m, reached 7.2 s into the climb; then the 1.5 s dwell and smoothing lag
    expect(firstL2).toBeGreaterThanOrEqual(13)
    expect(firstL2).toBeLessThanOrEqual(16)
    expect(floors.slice(firstL2).every((f) => f === L2)).toBe(true)
  })

  it('walks back down to level 1', () => {
    const { floors } = run({
      seconds: 40,
      height: (t) => (t < 20_000 ? ramp(t, 5000, 10_000, 0, 4.27) : ramp(t, 25_000, 10_000, 4.27, 0)),
      vote: (t) => vote(t < 15_000 ? L1 : t < 30_000 ? L2 : L1)
    })
    expect(floors[22]).toBe(L2)
    expect(floors.at(-1)).toBe(L1)
  })

  it('stays on level 1 when the user stops partway up the stairs for 15 s, even with level 2 winning the vote', () => {
    const { floors } = run({
      seconds: 25,
      height: (t) => ramp(t, 5000, 5000, 0, 2.2), // just over halfway: below the 60% switch point
      vote: (t) => vote(t < 10_000 ? L1 : L2, 0.9)
    })
    expect(floors.slice(3).every((f) => f === L1)).toBe(true)
  })

  it('but after 20 s of level 2 confidently winning the vote there, believes BLE (reanchorAfterMs)', () => {
    const { floors } = run({
      seconds: 40,
      height: (t) => ramp(t, 5000, 5000, 0, 2.2),
      vote: (t) => vote(t < 10_000 ? L1 : L2, 0.9)
    })
    expect(floors.at(-1)).toBe(L2)
  })

  it('cancels weather drift while BLE agrees (1.5 hPa in an hour, ~12 m of fake climb)', () => {
    const { floors, tracker } = run({ seconds: 3600, height: () => 0, vote: () => vote(L1), driftHpaPerHour: -1.5 })
    expect(floors.slice(3).every((f) => f === L1)).toBe(true)
    expect(Math.abs(tracker.state.heightM!)).toBeLessThan(0.3)
  })

  it('would drift to the wrong floor without BLE to correct it (why it keeps listening to BLE)', () => {
    const { floors } = run({
      seconds: 3600,
      height: () => 0,
      vote: (t) => (t <= 5000 ? vote(L1) : null),
      driftHpaPerHour: -1.5
    })
    expect(floors[5]).toBe(L1)
    expect(floors.at(-1)).toBe(L2)
  })

  it('re-anchors after BLE confidently disagrees for 20 s (e.g. it first anchored to the wrong floor)', () => {
    const { floors } = run({ seconds: 40, height: () => 0, vote: (t) => vote(t < 5000 ? L2 : L1) })
    expect(floors[4]).toBe(L2)
    expect(floors[20]).toBe(L2) // a short disagreement doesn't move it
    expect(floors.at(-1)).toBe(L1)
  })

  it('tracks an elevator ride with no beacons heard, across several floors', () => {
    // Sample building with a third floor at 9 m; ride from level 1 to 3 at 1 m/s, beacons blocked in the car
    const building = sampleVenue.buildings[0]!
    const l3 = { ...building.floors[1]!, id: 'test-l3', name: 'Level 3', level: 3, transform: { ...building.floors[1]!.transform, floorId: 'test-l3', floorZ: 9 } }
    const venue = { ...sampleVenue, buildings: [{ ...building, floors: [...building.floors, l3] }] }
    const { floors } = run({
      seconds: 30,
      height: (t) => ramp(t, 5000, 9000, 0, 9),
      vote: (t) => (t < 5000 ? vote('test-l1') : null)
    }, venue)
    expect(floors[4]).toBe('test-l1')
    expect(floors.at(-1)).toBe('test-l3')
  })

  it('gives the floor back to BLE when the barometer goes silent', () => {
    const tracker = new BarometerFloorTracker()
    tracker.setVenue(indexVenue(spnVenue))
    for (let t = 0; t <= 4000; t += 1000) {
      tracker.addPressure(pressureAt(0), t)
      tracker.chooseFloor(vote(L1), t)
    }
    expect(tracker.chooseFloor(vote(L1), 5000)).toBe(L1)
    expect(tracker.chooseFloor(vote(L1), 10_000)).toBeNull() // no sample for 6 s
  })

  it('ignores the 0 hPa the plugin reports before its first reading', () => {
    const tracker = new BarometerFloorTracker()
    tracker.setVenue(indexVenue(spnVenue))
    tracker.addPressure(0, 0)
    expect(tracker.state.pressureHpa).toBeNull()
  })

  it('handles a noisy 5 Hz Android sensor: anchors, never flickers, still detects the climb', () => {
    const { floors } = run({
      seconds: 120,
      rateHz: 5,
      noiseHpa: 0.03, // ~0.25 m per sample
      height: (t) => ramp(t, 60_000, 12_000, 0, 4.27),
      vote: (t) => vote(t < 60_000 ? L1 : L2)
    })
    const anchoredAt = floors.indexOf(L1)
    expect(anchoredAt).toBeGreaterThanOrEqual(0)
    expect(anchoredAt).toBeLessThanOrEqual(6)
    const firstL2 = floors.indexOf(L2)
    expect(floors.slice(anchoredAt, firstL2).every((f) => f === L1)).toBe(true)
    expect(floors.slice(firstL2).every((f) => f === L2)).toBe(true)
  })
})

describe('BarometerProvider', () => {
  it('reports a phone without a barometer as unavailable, and permission problems as denied', async () => {
    for (const [message, state] of [['This phone has no barometer', 'unavailable'], ['Motion & Fitness permission denied', 'permission-denied']]) {
      const source = new MockPressureSource()
      source.failWith = new Error(message)
      const provider = new BarometerProvider(source)
      const statuses: ProviderStatus[] = []
      provider.onStatus((s) => statuses.push(s))
      await provider.start(spnVenue)
      expect(statuses.at(-1)).toMatchObject({ provider: 'barometer', state, message })
    }
  })

  it('emits readings with floors as levels', async () => {
    const source = new MockPressureSource()
    const provider = new BarometerProvider(source)
    const readings: BarometerReading[] = []
    provider.onReading((r) => readings.push(r))
    await provider.start(spnVenue)
    for (let t = 0; t <= 4000; t += 1000) {
      source.emit({ pressureHpa: pressureAt(0), timestamp: t })
      provider.chooseFloor(vote(L1, 0.95), t)
    }
    expect(readings.at(-1)).toMatchObject({ floorLevel: 1, voteLevel: 1, voteShare: 0.95 })
    expect(readings.at(-1)!.heightM).toBeCloseTo(0, 2)
  })
})

describe('BleProvider with a floor selector', () => {
  it('positions on the selector\'s floor, using only that floor\'s beacons, and passes it the vote', async () => {
    const scanner = new MockBleScanner()
    const provider = new BleProvider(scanner, { updateIntervalMs: 1000 })
    const votes: Array<FloorVote | null> = []
    provider.setFloorSelector((v) => {
      votes.push(v)
      return 'test-l2'
    })
    const fixes: LocationFix[] = []
    provider.onFix((fix) => fixes.push(fix))
    await provider.start(sampleVenue)

    // On level 2 at (300, 150), but level 1's beacons come through 6 dB stronger (bleed)
    const stand = { e: 130, n: 65, u: 4.5 + 1.2 }
    for (const b of sampleVenue.beacons) {
      const d = Math.hypot(b.enu.e - stand.e, b.enu.n - stand.n, b.enu.u - stand.u)
      const rssi = distanceToRssi(d, b.txPower, b.pathLossExponent) + (b.floorId === 'test-l1' ? 6 : 0)
      scanner.emit({ beaconId: b.id, rssi, timestamp: 0 })
    }
    scanner.emit({ beaconId: sampleVenue.beacons[0]!.id, rssi: -60, timestamp: 1000 })

    expect(votes.at(-1)?.floorId).toBe('test-l1')
    expect(fixes.at(-1)?.floorId).toBe('test-l2')
    expect(fixes.at(-1)?.enu.u).toBe(4.5)
  })

  it('uses the vote when the selector returns null', async () => {
    const scanner = new MockBleScanner()
    const provider = new BleProvider(scanner, { updateIntervalMs: 1000 })
    provider.setFloorSelector(() => null)
    const fixes: LocationFix[] = []
    provider.onFix((fix) => fixes.push(fix))
    await provider.start(sampleVenue)
    for (const b of sampleVenue.beacons.filter((b) => b.floorId === 'test-l1')) {
      scanner.emit({ beaconId: b.id, rssi: -60, timestamp: 0 })
    }
    expect(fixes.at(-1)?.floorId).toBe('test-l1')
  })
})
