import { describe, expect, it } from 'vitest'
import { snapToRoute } from './snap-to-route'

const L_ROUTE = [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.9 }] // across, then down

describe('snapToRoute', () => {
  it('drops a perpendicular onto the nearest segment', () => {
    const snap = snapToRoute({ x: 0.3, y: 0.15 }, L_ROUTE, 1)!
    expect(snap.x).toBeCloseTo(0.3)
    expect(snap.y).toBeCloseTo(0.1)
    expect(snap.distance).toBeCloseTo(0.05)
    expect(snap.segment).toBe(0)
  })

  it('picks the closer of two segments', () => {
    const snap = snapToRoute({ x: 0.55, y: 0.6 }, L_ROUTE, 1)!
    expect(snap.x).toBeCloseTo(0.5)
    expect(snap.y).toBeCloseTo(0.6)
    expect(snap.segment).toBe(1)
  })

  it('stops at the ends of the route instead of running past them', () => {
    const snap = snapToRoute({ x: 0, y: 0 }, L_ROUTE, 1)!
    expect(snap.x).toBeCloseTo(0.1)
    expect(snap.y).toBeCloseTo(0.1)
  })

  it('measures y in plan widths on a wide plan', () => {
    // SPN level 1 is about 2.18 times wider than tall, so 0.1 of the height is only ~0.046 of the width
    const snap = snapToRoute({ x: 0.3, y: 0.2 }, L_ROUTE, 0.458)!
    expect(snap.distance).toBeCloseTo(0.0458)
  })

  it('handles one-point and empty routes', () => {
    expect(snapToRoute({ x: 0.2, y: 0.2 }, [{ x: 0.1, y: 0.2 }], 1)).toMatchObject({ x: 0.1, y: 0.2, segment: 0 })
    expect(snapToRoute({ x: 0.2, y: 0.2 }, [], 1)).toBeNull()
  })
})
