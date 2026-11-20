import { describe, expect, it } from 'vitest'
import { buildDirections, enclosingRoom, instructionAt, locateOnRoute } from './directions'
import type { Turn } from './turn-detection'

// A square plan where 0.01 of the width is 1 m: up 10 m, right 20 m, up 10 m
const WIDTH_PER_METER = 0.01
const points = [
  { x: 0.5, y: 0.9 }, { x: 0.5, y: 0.8 }, // 10 m up (north on the map)
  { x: 0.6, y: 0.8 }, { x: 0.7, y: 0.8 }, // 20 m right (east)
  { x: 0.7, y: 0.7 } // 10 m up
]
const turns: Turn[] = [{ index: 1, direction: 'right', angle: 90 }, { index: 3, direction: 'left', angle: 90 }]
const d = buildDirections(points, turns, 1, WIDTH_PER_METER)
const UP = 0, RIGHT = 90, DOWN = 180, LEFT = 270 // headings, clockwise from the map's up

/** Instruction for someone standing at `where`, found on the route from scratch */
const tell = (where: { x: number, y: number }, heading: number | null = null) => instructionAt(d, where, locateOnRoute(d, where, null), heading)

describe('buildDirections', () => {
  it('places each turn and the arrival by distance along the route', () => {
    expect(d.totalM).toBeCloseTo(40)
    expect(d.steps.map(s => [s.type, Math.round(s.atM)])).toEqual([['right', 10], ['left', 30], ['arrive', 40]])
  })

  it('measures y in plan widths on a non-square plan', () => {
    const tall = buildDirections([{ x: 0, y: 0 }, { x: 0, y: 0.1 }], [], 2, WIDTH_PER_METER) // height is twice the width
    expect(tall.totalM).toBeCloseTo(20)
  })
})

describe('locateOnRoute', () => {
  it('finds how far along the route you are, and how far off it', () => {
    const at = locateOnRoute(d, { x: 0.65, y: 0.82 }, null) // 2 m below the middle of the right-hand leg
    expect(at.progressM).toBeCloseTo(25)
    expect(at.offRouteM).toBeCloseTo(2)
  })

  it('stays on the part you are walking where the line passes close to itself', () => {
    // A U: up 30 m, right 3 m, down 30 m. All along the first leg, the way back is only 3 m away.
    const u = buildDirections([{ x: 0.5, y: 0.8 }, { x: 0.5, y: 0.5 }, { x: 0.53, y: 0.5 }, { x: 0.53, y: 0.8 }], [], 1, WIDTH_PER_METER)
    const before = locateOnRoute(u, { x: 0.5, y: 0.7 }, null) // 10 m up the first leg
    const drifted = { x: 0.522, y: 0.69 } // next fix: BLE puts you nearer the way back
    expect(locateOnRoute(u, drifted, null).progressM).toBeCloseTo(52) // from scratch: wrongly on the way back
    expect(locateOnRoute(u, drifted, before).progressM).toBeCloseTo(11) // tracked: still on the first leg
  })
})

describe('instructionAt', () => {
  it('names the next turn and the one after it, by distance', () => {
    const now = tell({ x: 0.5, y: 0.9 })
    expect(now).toMatchObject({ action: 'right', then: { type: 'left' } })
    expect(now.distanceM).toBeCloseTo(10)
  })

  it('moves on to the next step once a turn is passed', () => {
    expect(tell({ x: 0.55, y: 0.8 }).action).toBe('left') // 5 m along the right-hand leg
    expect(tell({ x: 0.7, y: 0.75 })).toMatchObject({ action: 'arrive', then: null })
    expect(tell({ x: 0.7, y: 0.71 }).action).toBe('arrived')
  })

  it('says turn around when facing away from the route', () => {
    expect(tell({ x: 0.5, y: 0.88 }, UP).action).toBe('right') // facing the right way
    expect(tell({ x: 0.5, y: 0.88 }, DOWN).action).toBe('around')
  })

  it('names the turn from where you face when you reach it', () => {
    const corner = { x: 0.5, y: 0.815 } // 1.5 m before the first turn
    expect(tell(corner, UP).action).toBe('right') // walked up to the corner as planned
    expect(tell(corner, LEFT).action).toBe('around') // facing west at the corner: the route goes east, behind you
    expect(tell(corner, RIGHT).action).toBe('right') // already facing east: keep the turn's own word rather than say nothing
    expect(tell(corner, null).action).toBe('right') // no heading: from the route's shape
  })

  it('points back to the route when you are off it', () => {
    const off = { x: 0.4, y: 0.85 } // 10 m left of the first leg
    expect(tell(off)).toMatchObject({ action: 'to-route', side: null })
    expect(tell(off).distanceM).toBeCloseTo(10)
    expect(tell(off, UP).side).toBe('right') // facing up, the route is to your right
    expect(tell(off, RIGHT).side).toBe('straight')
  })
})

describe('starting in a room', () => {
  // A room around the start of the route: its door is where the route leaves it, 4 m up the first leg
  const room: [number, number][] = [[0.45, 0.95], [0.55, 0.95], [0.55, 0.86], [0.45, 0.86]]
  const withRoom = buildDirections(points, turns, 1, WIDTH_PER_METER, room)
  const tellIn = (where: { x: number, y: number }, heading: number | null = null) =>
    instructionAt(withRoom, where, locateOnRoute(withRoom, where, null), heading)

  it('starts with leaving the room, at the door', () => {
    expect(withRoom.steps.map(s => [s.type, Math.round(s.atM)])).toEqual([['exit', 4], ['right', 10], ['left', 30], ['arrive', 40]])
  })

  it('says exit the room while you are in it, with the first turn after it', () => {
    const now = tellIn({ x: 0.5, y: 0.9 })
    expect(now).toMatchObject({ action: 'exit', then: { type: 'right' } })
    expect(now.distanceM).toBeCloseTo(4) // to the door
    expect(tellIn({ x: 0.5, y: 0.9 }, DOWN).action).toBe('exit') // even facing away: leaving the room comes first
  })

  it('gives the normal directions once you are out', () => {
    expect(tellIn({ x: 0.5, y: 0.85 }).action).toBe('right')
  })

  it('drops turns that are inside the room', () => {
    const big: [number, number][] = [[0.4, 0.95], [0.65, 0.95], [0.65, 0.75], [0.4, 0.75]] // holds the first turn too
    expect(buildDirections(points, turns, 1, WIDTH_PER_METER, big).steps.map(s => s.type)).toEqual(['exit', 'left', 'arrive'])
  })

  it('still says exit when the route starts outside the room', () => {
    const away = buildDirections(points, turns, 1, WIDTH_PER_METER, [[0.3, 0.95], [0.4, 0.95], [0.4, 0.85], [0.3, 0.85]]) // a room 10 m left of the start
    const where = { x: 0.37, y: 0.9 }
    const now = instructionAt(away, where, locateOnRoute(away, where, null), null)
    expect(now.action).toBe('exit')
    expect(now.distanceM).toBeCloseTo(13) // to the start of the route
  })
})

describe('enclosingRoom', () => {
  const square = (x0: number, y0: number, size: number): [number, number][] => [[x0, y0], [x0 + size, y0], [x0 + size, y0 + size], [x0, y0 + size]]
  const rooms = [
    { name: 'LOBBY', outline: square(0, 0, 1) },
    { name: 'UT DESIGN', outline: square(0.2, 0.2, 0.3) }, // a room inside the lobby
    { name: 'OFFICE', outline: square(0.25, 0.25, 0.1) }, // and one inside that
    { name: '', outline: square(0.6, 0.6, 0.2) }, // unnamed: unknown, so not a room to leave
    { name: 'STORAGE' } // no outline
  ]

  it('picks the smallest room that holds the point', () => {
    expect(enclosingRoom(rooms, { x: 0.3, y: 0.3 })?.name).toBe('OFFICE')
    expect(enclosingRoom(rooms, { x: 0.45, y: 0.45 })?.name).toBe('UT DESIGN')
  })

  it('skips hallways and unnamed spaces', () => {
    expect(enclosingRoom(rooms, { x: 0.1, y: 0.9 })).toBeNull() // only in the lobby
    expect(enclosingRoom(rooms, { x: 0.7, y: 0.7 })).toBeNull()
  })
})
