import { describe, expect, it } from 'vitest'
import { sampleVenue } from '../fixtures/sampleVenue'
import { enuToWgs84 } from '../geo/wgs84'
import type { LocationEvent, LocationFix } from '../types'
import { FusionEngine } from './FusionEngine'
import { IndoorOutdoorDetector } from './indoorOutdoor'
import { ConstantVelocityKalman } from './kalman'
import { StepKalman } from './stepKalman'

function makeFix(source: LocationFix['source'], e: number, n: number, timestamp: number, extra: Partial<LocationFix> = {}): LocationFix {
  const enu = { e, n, u: 0 }
  return {
    enu,
    wgs84: enuToWgs84(enu, sampleVenue.origin),
    floorId: null,
    buildingId: null,
    accuracyM: 3,
    timestamp,
    source,
    isIndoor: source !== 'gps',
    ...extra
  }
}

const bleFix = (e: number, n: number, t: number, floorId = 'test-l1') =>
  makeFix('ble', e, n, t, { floorId, buildingId: 'test-bldg', accuracyM: 2 })

describe('ConstantVelocityKalman', () => {
  it('starts at the first measurement', () => {
    const kf = new ConstantVelocityKalman()
    expect(kf.state()).toBeNull()
    kf.update(10, 20, 3, 0)
    expect(kf.state()).toMatchObject({ e: 10, n: 20, ve: 0, vn: 0 })
  })

  it('smooths noise around a fixed point', () => {
    const kf = new ConstantVelocityKalman()
    for (let i = 0; i < 60; i++) kf.update(i % 2 ? 3 : -3, i % 3 ? 2 : -4, 3, i * 1000)
    const s = kf.state()!
    expect(Math.hypot(s.e, s.n)).toBeLessThan(2)
  })

  it('learns velocity on a straight walk', () => {
    const kf = new ConstantVelocityKalman()
    for (let i = 0; i <= 30; i++) kf.update(1.3 * i, 0, 2, i * 1000)
    const s = kf.state()!
    expect(s.ve).toBeCloseTo(1.3, 1)
    expect(Math.abs(s.e - 39)).toBeLessThan(1)
  })

  it('trusts accurate measurements more than inaccurate ones', () => {
    const kf = new ConstantVelocityKalman()
    kf.update(0, 0, 2, 0)
    kf.update(10, 0, 30, 1000)
    expect(kf.state()!.e).toBeLessThan(1)
    kf.update(10, 0, 1, 2000)
    expect(kf.state()!.e).toBeGreaterThan(5)
  })

  it('restarts after a long gap', () => {
    const kf = new ConstantVelocityKalman()
    kf.update(0, 0, 2, 0)
    kf.update(100, 100, 5, 60_000)
    expect(kf.state()).toMatchObject({ e: 100, n: 100 })
  })
})

describe('IndoorOutdoorDetector', () => {
  const footprint = { buildingId: 'b', polygon: [{ e: 0, n: 0 }, { e: 50, n: 0 }, { e: 50, n: 30 }, { e: 0, n: 30 }] }
  const options = { switchAfterMs: 3000, bleVisibleForMs: 3000, gpsGoodAccuracyM: 10, gpsFreshForMs: 3000 }
  const outside = { e: 25, n: -20 }
  const inside = { e: 25, n: 15 }

  it('takes the first answer immediately', () => {
    const d = new IndoorOutdoorDetector([footprint], options)
    d.noteGps(0, 4)
    expect(d.update(outside, 0)).toEqual({ isIndoor: false, buildingId: null })
  })

  it('switches indoors only after the evidence holds for switchAfterMs', () => {
    const d = new IndoorOutdoorDetector([footprint], options)
    d.noteGps(0, 4)
    d.update(outside, 0)
    // Walk in: beacons appear, GPS degrades
    for (let t = 1000; t <= 3000; t += 1000) {
      d.noteBle(t, 'b')
      d.noteGps(t, 40)
      expect(d.update(inside, t).isIndoor).toBe(false)
    }
    d.noteBle(4000, 'b')
    expect(d.update(inside, 4000)).toEqual({ isIndoor: true, buildingId: 'b' })
  })

  it('does not flap when evidence flickers at a doorway', () => {
    const d = new IndoorOutdoorDetector([footprint], options)
    d.noteGps(0, 4)
    d.update(outside, 0)
    for (let t = 1000; t <= 20000; t += 1000) {
      // Alternate between "inside with beacons" and "outside with good GPS" every second
      if (t % 2000) {
        d.noteBle(t, 'b')
        expect(d.update(inside, t).isIndoor).toBe(false)
      } else {
        d.noteGps(t, 4)
        expect(d.update(outside, t).isIndoor).toBe(false)
      }
    }
  })

  it('calls a footprint with no GPS indoors even without beacons (BLE permission denied)', () => {
    const d = new IndoorOutdoorDetector([footprint], options)
    expect(d.update(inside, 0)).toEqual({ isIndoor: true, buildingId: 'b' })
  })

  it('switches back outdoors after leaving', () => {
    const d = new IndoorOutdoorDetector([footprint], options)
    d.noteBle(0, 'b')
    d.update(inside, 0)
    for (let t = 1000; t <= 8000; t += 1000) {
      d.noteGps(t, 4)
      d.update(outside, t)
    }
    expect(d.update(outside, 8000)).toEqual({ isIndoor: false, buildingId: null })
  })
})

describe('FusionEngine', () => {
  function setup() {
    const engine = new FusionEngine(sampleVenue)
    const fixes: LocationFix[] = []
    const events: LocationEvent[] = []
    engine.onFix((f) => fixes.push(f))
    engine.onEvent((e) => events.push(e))
    return { engine, fixes, events }
  }

  it('emits fused fixes with the BLE floor and building indoors', () => {
    const { engine, fixes, events } = setup()
    engine.ingest(bleFix(130, 65, 0))
    expect(fixes.at(-1)).toMatchObject({ source: 'fused', isIndoor: true, floorId: 'test-l1', buildingId: 'test-bldg' })
    expect(events.map((e) => e.type)).toEqual(['buildingEntered', 'floorChanged'])
  })

  it('ignores GPS indoors while beacons are heard', () => {
    const { engine, fixes } = setup()
    engine.ingest(bleFix(130, 65, 0))
    engine.ingest(makeFix('gps', 200, 0, 500, { accuracyM: 30 }))
    expect(fixes).toHaveLength(1)
  })

  it('ignores BLE outdoors and follows GPS', () => {
    const { engine, fixes } = setup()
    engine.ingest(makeFix('gps', 130, 10, 0, { accuracyM: 4 }))
    engine.ingest(makeFix('ble', 130, 52, 500, { floorId: 'test-l1', buildingId: 'test-bldg' }))
    expect(fixes).toHaveLength(1)
    expect(fixes[0]).toMatchObject({ isIndoor: false, floorId: null, buildingId: null })
  })

  it('reports a floor change and uses the new floor height', () => {
    const { engine, fixes, events } = setup()
    engine.ingest(bleFix(150, 65, 0))
    engine.ingest(bleFix(150, 66, 1000, 'test-l2'))
    expect(events.at(-1)).toEqual({ type: 'floorChanged', from: 'test-l1', to: 'test-l2', timestamp: 1000 })
    expect(fixes.at(-1)!.enu.u).toBe(4.5)
  })

  it('derives heading from velocity while walking', () => {
    const { engine, fixes } = setup()
    for (let i = 0; i < 10; i++) engine.ingest(bleFix(110 + 1.3 * i, 65, i * 1000))
    expect(fixes.at(-1)!.headingDeg).toBeCloseTo(90, -1) // walking east
  })

  it('ignores PDR fixes (steps arrive through ingestStep)', () => {
    const { engine, fixes } = setup()
    engine.ingest(makeFix('pdr', 130, 65, 0))
    expect(fixes).toHaveLength(0)
  })
})

describe('StepKalman', () => {
  it('moves by each step along its heading', () => {
    const kf = new StepKalman()
    kf.seed(0, 0, 2, 0)
    for (let i = 1; i <= 10; i++) kf.step(0.7, 90, 10, i * 500)
    expect(kf.state()!.e).toBeCloseTo(7)
    expect(kf.state()!.n).toBeCloseTo(0)
  })

  it('holds still against BLE noise while standing', () => {
    const kf = new StepKalman()
    kf.seed(0, 0, 3, 0)
    kf.setMoving(false)
    let maxMove = 0
    let last = { e: 0, n: 0 }
    for (let i = 1; i <= 60; i++) {
      kf.update(i % 2 ? 4 : -4, i % 3 ? 3 : -5, 3, i * 1000)
      const s = kf.state()!
      if (i > 10) maxMove = Math.max(maxMove, Math.hypot(s.e - last.e, s.n - last.n)) // after the first few fixes average in
      last = s
    }
    expect(maxMove).toBeLessThan(0.5)
    expect(Math.hypot(last.e, last.n)).toBeLessThan(1.5)
  })

  it('drops a single wild BLE fix', () => {
    const kf = new StepKalman()
    kf.seed(0, 0, 2, 0)
    kf.update(30, 0, 2, 1000)
    expect(kf.state()!.e).toBeCloseTo(0)
  })

  it('relocalizes when BLE keeps disagreeing', () => {
    const kf = new StepKalman()
    kf.seed(0, 0, 1, 0)
    for (let i = 1; i <= 4; i++) kf.update(30 + (i % 2), 0, 2, i * 1000)
    expect(kf.state()!.e).toBeCloseTo(30.5)
  })

  it('is less sure across a step than along it when the heading is poor', () => {
    const kf = new StepKalman()
    kf.seed(0, 0, 0.01, 0)
    for (let i = 1; i <= 10; i++) kf.step(0.7, 0, 30, i * 500) // walking north
    kf.update(1, 8, 1, 5000) // BLE says 1 m east, 1 m north of the estimate
    const s = kf.state()!
    expect(s.e).toBeGreaterThan(s.n - 7) // the cross-track (east) offset is believed more than the along-track one
  })
})

describe('FusionEngine with motion sensors', () => {
  function setup() {
    const engine = new FusionEngine(sampleVenue)
    const fixes: LocationFix[] = []
    engine.onFix((f) => fixes.push(f))
    return { engine, fixes }
  }

  it('moves the dot with steps between BLE fixes', () => {
    const { engine, fixes } = setup()
    engine.ingestMotion({ timestamp: 0, isMoving: false, headingDeg: 90, headingAccuracyDeg: 10 })
    engine.ingest(bleFix(130, 65, 0))
    engine.ingestStep({ timestamp: 500, lengthM: 0.7, headingDeg: 90, headingAccuracyDeg: 10 })
    engine.ingestStep({ timestamp: 1000, lengthM: 0.7, headingDeg: 90, headingAccuracyDeg: 10 })
    expect(fixes.at(-1)!.enu.e).toBeCloseTo(131.4)
    expect(fixes.at(-1)!.headingDeg).toBe(90)
  })

  it('takes the heading from the compass while standing', () => {
    const { engine, fixes } = setup()
    engine.ingestMotion({ timestamp: 0, isMoving: false, headingDeg: 200, headingAccuracyDeg: 10 })
    engine.ingest(bleFix(130, 65, 0))
    engine.ingestMotion({ timestamp: 250, isMoving: false, headingDeg: 210, headingAccuracyDeg: 10 })
    expect(fixes.at(-1)).toMatchObject({ headingDeg: 210, timestamp: 250 })
  })

  it('falls back to the BLE-only filter when the motion sensors go quiet', () => {
    const { engine, fixes } = setup()
    engine.ingestMotion({ timestamp: 0, isMoving: false, headingDeg: 90, headingAccuracyDeg: 10 })
    engine.ingest(bleFix(130, 65, 0))
    engine.ingest(bleFix(130, 65, 1000))
    engine.ingest(bleFix(136, 65, 10_000)) // 10 s without motion data: no "you're standing still" damping
    expect(fixes.at(-1)!.enu.e).toBeGreaterThan(134)
  })
})

describe('FusionEngine dead reckoning without BLE', () => {
  function setup() {
    const engine = new FusionEngine(sampleVenue)
    const fixes: LocationFix[] = []
    engine.onFix((f) => fixes.push(f))
    engine.ingestMotion({ timestamp: 0, isMoving: false, headingDeg: 90, headingAccuracyDeg: 10 })
    engine.ingest(bleFix(130, 65, 0))
    return { engine, fixes }
  }

  it('stops emitting compass-only positions once BLE goes quiet, so the dot can go stale', () => {
    const { engine, fixes } = setup()
    for (let t = 250; t <= 60_000; t += 250) engine.ingestMotion({ timestamp: t, isMoving: false, headingDeg: 90, headingAccuracyDeg: 10 })
    expect(fixes.at(-1)!.timestamp).toBeLessThanOrEqual(5000)
  })

  it('stops moving the dot on steps alone once BLE goes quiet', () => {
    const { engine, fixes } = setup()
    for (let t = 500; t <= 30_000; t += 500) engine.ingestStep({ timestamp: t, lengthM: 0.7, headingDeg: 90, headingAccuracyDeg: 10 })
    expect(fixes.at(-1)!.timestamp).toBeLessThanOrEqual(5000)
  })

  it('grows the reported accuracy while only motion data arrives', () => {
    const { engine, fixes } = setup()
    const first = fixes.at(-1)!.accuracyM
    for (let t = 250; t <= 4000; t += 250) engine.ingestMotion({ timestamp: t, isMoving: true, headingDeg: 90, headingAccuracyDeg: 10 })
    expect(fixes.at(-1)!.accuracyM).toBeGreaterThan(first)
  })

  it('picks up again with the next BLE fix', () => {
    const { engine, fixes } = setup()
    for (let t = 250; t <= 20_000; t += 250) engine.ingestMotion({ timestamp: t, isMoving: false, headingDeg: 90, headingAccuracyDeg: 10 })
    engine.ingest(bleFix(140, 65, 20_100))
    engine.ingestStep({ timestamp: 20_500, lengthM: 0.7, headingDeg: 90, headingAccuracyDeg: 10 })
    expect(fixes.at(-1)!.timestamp).toBe(20_500)
  })
})
