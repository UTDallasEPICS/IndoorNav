// Turn-by-turn directions for a route: the steps (turns, then arriving) with how far along the route each one is,
// and, for where the walker is now, which step comes next and how far away it is. Used by pages/map.vue.
import type { Turn } from './turn-detection'
import type { RouteSnap } from './snap-to-route'

type MapPoint = { x: number, y: number } // fractions (0–1) of the floor plan, like the rooms' x/y

export type Step = {
  type: 'left' | 'right' | 'arrive',
  angle: number, // degrees to turn (0 for arrive)
  atM: number // metres from the start of the route to this step
}

export type Directions = {
  steps: Step[], // in walking order; always ends with an 'arrive' step
  alongM: number[], // metres from the start of the route to each route point
  totalM: number // length of the whole route
}

export type DirectionsNow = {
  next: Step, // what to do next
  then: Step | null, // the step after it (null when next is 'arrive')
  toNextM: number, // metres until next
  thenAfterM: number | null, // metres from next to then
  leftM: number // metres to the destination
}

const PASSED_M = 1 // a step counts as done once you're this close to it (BLE noise is bigger than this, so don't go lower)

/**
 * heightPerWidth: the floor plan's height / width (y is a fraction of the height, x of the width).
 * widthPerMeter: how much of the plan's width one metre covers.
 */
export function buildDirections(points: MapPoint[], turns: Turn[], heightPerWidth: number, widthPerMeter: number): Directions {
  const alongM = [0]
  for (let i = 1; i < points.length; i++) {
    const dx = points[i]!.x - points[i - 1]!.x
    const dy = (points[i]!.y - points[i - 1]!.y) * heightPerWidth // into plan widths, like x
    alongM.push(alongM[i - 1]! + Math.hypot(dx, dy) / widthPerMeter)
  }
  const totalM = alongM[alongM.length - 1] ?? 0
  const steps: Step[] = turns.map(turn => ({ type: turn.direction, angle: turn.angle, atM: alongM[turn.index] ?? 0 }))
  steps.push({ type: 'arrive', angle: 0, atM: totalM })
  return { steps, alongM, totalM }
}

/** How far along the route a snapped position is, in metres (snap from snapToRoute with the same heightPerWidth). */
export function progressAlong(directions: Directions, points: MapPoint[], snap: RouteSnap, heightPerWidth: number, widthPerMeter: number): number {
  const start = points[snap.segment]
  if (!start) return 0
  const intoSegment = Math.hypot(snap.x - start.x, (snap.y - start.y) * heightPerWidth) / widthPerMeter
  return (directions.alongM[snap.segment] ?? 0) + intoSegment
}

/** The next step and the one after it, for someone `progressM` metres along the route. */
export function directionsAt(directions: Directions, progressM: number): DirectionsNow {
  const { steps, totalM } = directions
  const nextIndex = steps.findIndex(step => step.type === 'arrive' || step.atM - progressM > PASSED_M) // arrive is never skipped
  const next = steps[nextIndex]!
  const then = steps[nextIndex + 1] ?? null
  return {
    next,
    then,
    toNextM: Math.max(0, next.atM - progressM),
    thenAfterM: then ? then.atM - next.atM : null,
    leftM: Math.max(0, totalM - progressM)
  }
}
