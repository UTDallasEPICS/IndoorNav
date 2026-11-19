import { describe, expect, it } from 'vitest'
import { buildDirections, directionsAt, progressAlong } from './directions'
import type { Turn } from './turn-detection'

// A square plan where 0.01 of the width is 1 m: up 10 m, right 20 m, up 10 m
const WIDTH_PER_METER = 0.01
const points = [
  { x: 0.5, y: 0.9 }, { x: 0.5, y: 0.8 }, // 10 m up
  { x: 0.6, y: 0.8 }, { x: 0.7, y: 0.8 }, // 20 m right
  { x: 0.7, y: 0.7 } // 10 m up
]
const turns: Turn[] = [{ index: 1, direction: 'right', angle: 90 }, { index: 3, direction: 'left', angle: 90 }]
const directions = buildDirections(points, turns, 1, WIDTH_PER_METER)

describe('buildDirections', () => {
  it('places each turn and the arrival by distance along the route', () => {
    expect(directions.totalM).toBeCloseTo(40)
    expect(directions.steps.map(s => [s.type, Math.round(s.atM)])).toEqual([['right', 10], ['left', 30], ['arrive', 40]])
  })

  it('measures y in plan widths on a non-square plan', () => {
    const tall = buildDirections([{ x: 0, y: 0 }, { x: 0, y: 0.1 }], [], 2, WIDTH_PER_METER) // height is twice the width
    expect(tall.totalM).toBeCloseTo(20)
  })

  it('ends with just "arrive" when there are no turns', () => {
    expect(buildDirections(points, [], 1, WIDTH_PER_METER).steps).toEqual([{ type: 'arrive', angle: 0, atM: directions.totalM }])
  })
})

describe('directionsAt', () => {
  it('starts with the first turn and previews the one after', () => {
    const now = directionsAt(directions, 0)
    expect(now.next.type).toBe('right')
    expect(now.then?.type).toBe('left')
    expect(now.toNextM).toBeCloseTo(10)
    expect(now.thenAfterM).toBeCloseTo(20)
    expect(now.leftM).toBeCloseTo(40)
  })

  it('moves on once a turn is reached', () => {
    expect(directionsAt(directions, 9.5).next.type).toBe('left')
    expect(directionsAt(directions, 31).next.type).toBe('arrive')
    expect(directionsAt(directions, 31).then).toBeNull()
  })

  it('keeps "arrive" at the end instead of running out of steps', () => {
    const now = directionsAt(directions, 45)
    expect(now.next.type).toBe('arrive')
    expect(now.toNextM).toBe(0)
  })
})

describe('progressAlong', () => {
  it('adds the distance into the snapped segment', () => {
    const snap = { x: 0.65, y: 0.8, distance: 0, segment: 2 } // halfway along the second 10 m of the right-hand leg
    expect(progressAlong(directions, points, snap, 1, WIDTH_PER_METER)).toBeCloseTo(25)
  })
})
