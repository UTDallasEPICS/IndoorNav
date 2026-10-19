import type { PathWaypoint } from '../sim/simulator'

/**
 * Ground-truth walk through the sample venue at ~1.3 m/s: start outside to the south, enter Level 1,
 * walk east, pause, take the stairs to Level 2, and walk west. Between waypoints the walker moves in a
 * straight line and stays on the floor of the earlier waypoint.
 */
export const sampleWalk: PathWaypoint[] = [
  { t: 0, e: 130, n: 10, floorId: null }, // outside, 40 m south of the building
  { t: 30, e: 130, n: 49, floorId: null }, // at the door
  { t: 32, e: 130, n: 51, floorId: 'test-l1' }, // inside
  { t: 43, e: 130, n: 65, floorId: 'test-l1' },
  { t: 58, e: 150, n: 65, floorId: 'test-l1' },
  { t: 63, e: 150, n: 65, floorId: 'test-l1' }, // pause
  { t: 68, e: 156, n: 65, floorId: 'test-l1' }, // stairs
  { t: 76, e: 156, n: 72, floorId: 'test-l2' }, // top of the stairs
  { t: 111, e: 110, n: 72, floorId: 'test-l2' },
  { t: 121, e: 110, n: 60, floorId: 'test-l2' }
]
