// Turn-by-turn directions for a route: the steps (turns, then arriving) with how far along the route each one is,
// where the walker is on the route, and what to tell them right now. Used by pages/map.vue.
import type { Turn } from './turn-detection'
import { pointInPolygon } from './location/geo/polygon'

type MapPoint = { x: number, y: number } // fractions (0–1) of the floor plan, like the rooms' x/y

export type Step = {
  type: 'exit' | 'left' | 'right' | 'arrive', // exit: leave the room the route starts in
  angle: number, // degrees to turn (0 for arrive)
  atM: number // metres from the start of the route to this step
}

type Outline = [number, number][] // a room's outline, [x, y] fractions like the rooms JSON

export type Directions = {
  points: MapPoint[], // the route, start to destination
  startRoom: Outline | null, // the room the route starts in (enclosingRoom), or null when it starts in a hallway
  steps: Step[], // in walking order; always ends with an 'arrive' step
  alongM: number[], // metres from the start of the route to each route point
  totalM: number, // length of the whole route
  heightPerWidth: number, // the floor plan's height / width (y is a fraction of the height, x of the width)
  widthPerMeter: number // how much of the plan's width one metre covers
}

export type RoutePosition = {
  x: number, y: number, // the nearest spot on the route line, in map fractions
  progressM: number, // metres along the route to that spot
  offRouteM: number // how far the walker is from it
}

export type Instruction = {
  action: 'exit' | 'left' | 'right' | 'around' | 'arrive' | 'arrived' | 'to-route',
  side: 'left' | 'right' | 'straight' | null, // for 'to-route': which way the route is from where you face (null without a heading)
  distanceM: number, // to the turn / door / destination, or to the route when off it
  then: Step | null // the step after this one, for the "then" chip (with exit, left and right)
}

export const OFF_ROUTE_M = 5 // further than this from the line, you're off the route
export const NOW_M = 3 // closer than this to a step, it's happening now (BLE is only good to a few metres)
const PASSED_M = 1 // a step counts as done once you're this close to it
const SEARCH_BACK_M = 3 // where to look for you on the route, around where you were last time:
const SEARCH_AHEAD_M = 15 //   a little behind (BLE noise) and further ahead (walking), so you can't jump to another part of the line
const AROUND_DEG = 135 // facing further than this from the route's direction: turn around
const STRAIGHT_DEG = 30 // within this of a direction counts as straight ahead
const LOOK_M = 3 // the route's direction is measured over this many metres

// Spaces you walk through rather than rooms you leave: starting in one of these gets no "Exit the room"
const OPEN_AREA = /^(CORRIDOR|LOBBY|VESTIBULE|CIRC)\b/i

const inside = (point: MapPoint, outline: Outline) => pointInPolygon({ e: point.x, n: point.y }, outline.map(([x, y]) => ({ e: x, n: y })))

function area(outline: Outline) { // shoelace formula, in map fractions (only compared with each other)
  let sum = 0
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) sum += (outline[j]![0] + outline[i]![0]) * (outline[j]![1] - outline[i]![1])
  return Math.abs(sum / 2)
}

/** The room a point is in: the smallest named room whose outline holds it (rooms sit inside lobbies), skipping hallways. */
export function enclosingRoom<R extends { name: string, outline?: Outline }>(rooms: R[], point: MapPoint): R | null {
  const holding = rooms.filter(room => room.name && !OPEN_AREA.test(room.name) && room.outline && inside(point, room.outline))
  return holding.reduce<R | null>((best, room) => (!best || area(room.outline!) < area(best.outline!) ? room : best), null)
}

/** startRoom: the outline of the room the route starts in (enclosingRoom), if any: the first step is then leaving it. */
export function buildDirections(points: MapPoint[], turns: Turn[], heightPerWidth: number, widthPerMeter: number, startRoom: Outline | null = null): Directions {
  const alongM = [0]
  for (let i = 1; i < points.length; i++) {
    const dx = points[i]!.x - points[i - 1]!.x
    const dy = (points[i]!.y - points[i - 1]!.y) * heightPerWidth // into plan widths, like x
    alongM.push(alongM[i - 1]! + Math.hypot(dx, dy) / widthPerMeter)
  }
  const totalM = alongM[alongM.length - 1] ?? 0
  let steps: Step[] = turns.map(turn => ({ type: turn.direction, angle: turn.angle, atM: alongM[turn.index] ?? 0 }))
  if (startRoom) { // the door: where the route first leaves the room. Turns before it are inside the room, so they're dropped.
    const out = points.findIndex(point => !inside(point, startRoom))
    let doorM = out === -1 ? totalM : alongM[out]!
    if (out > 0) { // the wall is somewhere between the last point inside and the first outside: halve the gap until it's found
      const a = points[out - 1]!, b = points[out]!
      let lo = 0, hi = 1 // fractions of that segment: lo is inside, hi is outside
      for (let i = 0; i < 20; i++) {
        const t = (lo + hi) / 2
        if (inside({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) }, startRoom)) lo = t
        else hi = t
      }
      doorM = alongM[out - 1]! + hi * (alongM[out]! - alongM[out - 1]!)
    }
    steps = [{ type: 'exit', angle: 0, atM: doorM }, ...steps.filter(step => step.atM > doorM)]
  }
  steps.push({ type: 'arrive', angle: 0, atM: totalM })
  return { points, startRoom, steps, alongM, totalM, heightPerWidth, widthPerMeter }
}

/** Nearest spot on segments first..last (inclusive) of the route. */
function nearestOn(d: Directions, here: MapPoint, first: number, last: number): RoutePosition {
  const { points, alongM, heightPerWidth: k, widthPerMeter } = d
  const px = here.x, py = here.y * k // y in plan widths, like x
  let best: RoutePosition = { x: points[0]!.x, y: points[0]!.y, progressM: 0, offRouteM: Infinity }
  if (points.length === 1) best.offRouteM = Math.hypot(points[0]!.x - px, points[0]!.y * k - py) / widthPerMeter
  for (let i = first; i <= last; i++) {
    const a = points[i]!, b = points[i + 1]!
    const ax = a.x, ay = a.y * k, dx = b.x - ax, dy = b.y * k - ay
    const lengthSq = dx * dx + dy * dy
    const t = lengthSq ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / lengthSq)) : 0 // foot of the perpendicular, kept on the segment
    const sx = ax + t * dx, sy = ay + t * dy
    const offRouteM = Math.hypot(px - sx, py - sy) / widthPerMeter
    if (offRouteM < best.offRouteM) best = { x: sx, y: sy / k, progressM: alongM[i]! + t * (alongM[i + 1]! - alongM[i]!), offRouteM }
  }
  return best
}

/**
 * Where the walker is on the route. With `previous` (their last position on this route), only a stretch around it
 * is searched, so where the line passes close to itself you stay on the part you're walking. If you're off that
 * stretch but on the route somewhere else (e.g. BLE jumped), the whole route is searched instead.
 */
export function locateOnRoute(d: Directions, here: MapPoint, previous: RoutePosition | null): RoutePosition {
  const lastSegment = d.points.length - 2
  const whole = () => nearestOn(d, here, 0, lastSegment)
  if (!previous) return whole()
  const from = previous.progressM - SEARCH_BACK_M, to = previous.progressM + SEARCH_AHEAD_M
  let first = 0
  while (first < lastSegment && d.alongM[first + 1]! < from) first++ // first segment that reaches `from`
  let last = first
  while (last < lastSegment && d.alongM[last + 1]! < to) last++ // last segment that starts before `to`
  const near = nearestOn(d, here, first, last)
  if (near.offRouteM <= OFF_ROUTE_M) return near
  const anywhere = whole()
  return anywhere.offRouteM <= OFF_ROUTE_M ? anywhere : near
}

/** The point `m` metres along the route. */
function pointAt(d: Directions, m: number): MapPoint {
  const { points, alongM } = d
  if (m <= 0) return points[0]!
  for (let i = 1; i < points.length; i++) {
    if (alongM[i]! >= m) {
      const t = (m - alongM[i - 1]!) / ((alongM[i]! - alongM[i - 1]!) || 1)
      return { x: points[i - 1]!.x + t * (points[i]!.x - points[i - 1]!.x), y: points[i - 1]!.y + t * (points[i]!.y - points[i - 1]!.y) }
    }
  }
  return points[points.length - 1]!
}

/** Direction from a to b, in degrees clockwise from the map's up (same as a MapPosition's headingDeg). */
function bearing(d: Directions, a: MapPoint, b: MapPoint): number {
  return (Math.atan2(b.x - a.x, -(b.y - a.y) * d.heightPerWidth) * 180 / Math.PI + 360) % 360
}

/** How far to turn from `heading` to face `target`, in degrees: positive = right, negative = left. */
function turnBetween(heading: number, target: number): number {
  return ((target - heading) % 360 + 540) % 360 - 180
}

/**
 * What to tell the walker now. `where` is their position, `onRoute` its place on the route (locateOnRoute). `headingDeg` is the way they're facing (clockwise from the map's up), or null when
 * unknown (no compass, standing still, desktop): then the words come from the route's shape alone.
 */
export function instructionAt(d: Directions, where: MapPoint, onRoute: RoutePosition, headingDeg: number | null): Instruction {
  const exit = d.steps[0]!.type === 'exit' ? d.steps[0]! : null
  if (exit && inside(where, d.startRoom!)) { // still in the starting room: leaving it comes first, whatever else is going on
    const doorM = exit.atM > onRoute.progressM ? exit.atM - onRoute.progressM : onRoute.offRouteM // route starts outside the room: the way to its start
    return { action: 'exit', side: null, distanceM: doorM, then: d.steps[1] ?? null }
  }
  if (onRoute.offRouteM > OFF_ROUTE_M) { // off the route: point them back to the nearest spot on it
    let side: Instruction['side'] = null
    if (headingDeg != null) {
      const turn = turnBetween(headingDeg, bearing(d, where, onRoute))
      side = Math.abs(turn) <= STRAIGHT_DEG ? 'straight' : turn > 0 ? 'right' : 'left'
    }
    return { action: 'to-route', side, distanceM: onRoute.offRouteM, then: null }
  }

  const progress = onRoute.progressM
  const index = d.steps.findIndex(step => step.type !== 'exit' && (step.type === 'arrive' || step.atM - progress > PASSED_M)) // out of the room: exit is done; arrive is never skipped
  const next = d.steps[index]!
  const then = d.steps[index + 1] ?? null
  const distanceM = Math.max(0, next.atM - progress)

  if (next.type === 'arrive') return { action: distanceM < NOW_M ? 'arrived' : 'arrive', side: null, distanceM, then: null }

  if (headingDeg != null) {
    if (distanceM >= NOW_M) { // walking toward the turn: are they going the right way?
      const ahead = bearing(d, pointAt(d, progress), pointAt(d, progress + LOOK_M))
      if (Math.abs(turnBetween(headingDeg, ahead)) > AROUND_DEG) return { action: 'around', side: null, distanceM, then: null }
    } else { // at the turn: name it from where they face, toward the route after the turn
      const after = turnBetween(headingDeg, bearing(d, pointAt(d, next.atM), pointAt(d, next.atM + LOOK_M)))
      if (Math.abs(after) > AROUND_DEG) return { action: 'around', side: null, distanceM, then }
      if (Math.abs(after) > STRAIGHT_DEG) return { action: after > 0 ? 'right' : 'left', side: null, distanceM, then }
    }
  }
  return { action: next.type, side: null, distanceM, then }
}
