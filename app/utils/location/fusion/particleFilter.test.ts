import { describe, expect, it } from 'vitest'
import { sampleVenue } from '../fixtures/sampleVenue'
import type { VenueConfig } from '../types'
import { ParticleFilter } from './particleFilter'
import { createWalkableMap, withFloorGrids } from './walkableMap'

// The sample building's level 1 (60 x 30 m, plan up = north, top-left at ENU (100, 80)) on a 0.1 m grid, with a
// wall along n = 65 m, so the floor is split into a north half (n > 65) and a south half. `doorAt` opens it at
// e = doorAt .. doorAt + 1.5 m.
function venueWithWall(doorAt: number | null = null): VenueConfig {
  const rows = 300
  const cols = 600
  const walls = new Uint8Array(rows * cols)
  for (let c = 0; c < cols; c++) {
    const e = 100 + c * 0.1
    if (doorAt !== null && e >= doorAt && e < doorAt + 1.5) continue
    walls[150 * cols + c] = 1
    walls[151 * cols + c] = 1
  }
  const withPlan: VenueConfig = {
    ...sampleVenue,
    buildings: sampleVenue.buildings.map((b) => ({ ...b, floors: b.floors.map((f) => ({ ...f, plan: { width: 600, height: 300 } })) }))
  }
  return withFloorGrids(withPlan, { 1: { grid: { rows, cols, walls }, bounds: { top: 0, bottom: 300, left: 0, right: 600 } } })
}

describe('walkable map', () => {
  const map = createWalkableMap(venueWithWall(150))

  it('knows where the wall is', () => {
    expect(map.hasFloor('test-l1')).toBe(true)
    expect(map.hasFloor('test-l2')).toBe(false)
    expect(map.isOpen('test-l1', 120, 70)).toBe(true)
    expect(map.isOpen('test-l1', 120, 64.95)).toBe(false)
    expect(map.isOpen('test-l2', 120, 64.95)).toBe(true)
    expect(map.isOpen(null, 120, 64.95)).toBe(true)
  })

  it('stops a straight walk through the wall, but not through the door', () => {
    expect(map.canWalk('test-l1', { e: 120, n: 66 }, { e: 120, n: 64 })).toBe(false)
    expect(map.canWalk('test-l1', { e: 150.7, n: 66 }, { e: 150.7, n: 64 })).toBe(true)
    expect(map.canWalk('test-l1', { e: 120, n: 70 }, { e: 140, n: 75 })).toBe(true)
  })
})

describe('ParticleFilter', () => {
  it('keeps a walk along a wall on its side, when the compass pulls toward it', () => {
    const filter = new ParticleFilter(createWalkableMap(venueWithWall()), { minSeedAccuracyM: 0.5 })
    filter.setFloor('test-l1')
    let t = 0
    filter.seed(105, 66.5, 0.5, t)
    // Walking east along the wall, but the compass reads 10 degrees toward it; BLE sits on the wall line (uninformative)
    for (let i = 0; i < 30; i++) {
      t += 500
      filter.step(0.7, 100, 15, t)
      if (i % 2) filter.update(105 + 0.7 * i, 65, 3, t)
    }
    expect(filter.state()!.n).toBeGreaterThan(65)
    expect(filter.particles().filter((p) => p.n < 65).length / 800).toBeLessThan(0.2)
  })

  it('walks through a door', () => {
    const filter = new ParticleFilter(createWalkableMap(venueWithWall(150)))
    filter.setFloor('test-l1')
    let t = 0
    filter.seed(150.75, 69, 0.3, t)
    for (let i = 0; i < 12; i++) {
      t += 500
      filter.step(0.7, 180, 5, t)
    }
    expect(filter.state()!.n).toBeLessThan(63)
  })

  it('still walks through a wall the map is missing a door in', () => {
    const filter = new ParticleFilter(createWalkableMap(venueWithWall()), { minSeedAccuracyM: 0.2 })
    filter.setFloor('test-l1')
    let t = 0
    filter.seed(120, 65.6, 0.1, t)
    for (let i = 0; i < 8; i++) {
      t += 500
      filter.step(0.7, 180, 2, t)
    }
    expect(filter.state()!.n).toBeLessThan(63)
  })

  it('gets out of the wrong side of a wall when BLE keeps disagreeing', () => {
    const filter = new ParticleFilter(createWalkableMap(venueWithWall()))
    filter.setFloor('test-l1')
    let t = 0
    filter.seed(120, 70, 1, t) // wrongly placed north of the wall
    filter.setMoving(true)
    for (let i = 0; i < 8; i++) {
      t += 1000
      filter.update(120, 58, 2, t) // the user is 12 m south of it
    }
    expect(Math.hypot(filter.state()!.e - 120, filter.state()!.n - 58)).toBeLessThan(2)
  })

  it('keeps the dot out of walls even when the cloud straddles one', () => {
    const map = createWalkableMap(venueWithWall())
    const filter = new ParticleFilter(map)
    filter.setFloor('test-l1')
    filter.seed(120, 65, 3, 0)
    const s = filter.state()!
    expect(map.isOpen('test-l1', s.e, s.n)).toBe(true)
  })
})
