// Puts a position onto the route line: the foot of the perpendicular from the position to the nearest
// part of the route. Used by pages/map.vue so the arrow rides along the line while navigating.

type MapPoint = { x: number, y: number } // fractions (0–1) of the floor plan, like the rooms' x/y

export type RouteSnap = {
  x: number, y: number, // the snapped point on the line, in map fractions
  distance: number, // how far the position was from the line, in plan widths (× metres-per-width = metres)
  segment: number // index of the route point the snapped segment starts at
}

export function snapToRoute(position: MapPoint, route: MapPoint[], heightPerWidth: number): RouteSnap | null {
  if (!route.length) return null
  // x is a fraction of the width and y of the height, so scale y by the plan's height/width to measure both in plan widths
  const px = position.x
  const py = position.y * heightPerWidth

  let best: RouteSnap = { x: route[0]!.x, y: route[0]!.y, distance: Math.hypot(route[0]!.x - px, route[0]!.y * heightPerWidth - py), segment: 0 } // one-point route: that point
  for (let i = 1; i < route.length; i++) {
    const ax = route[i - 1]!.x, ay = route[i - 1]!.y * heightPerWidth // segment start
    const dx = route[i]!.x - ax, dy = route[i]!.y * heightPerWidth - ay // segment direction
    const lengthSq = dx * dx + dy * dy
    const t = lengthSq ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / lengthSq)) : 0 // 0 = segment start, 1 = end; clamped so we stay on the segment
    const sx = ax + t * dx, sy = ay + t * dy // foot of the perpendicular
    const distance = Math.hypot(px - sx, py - sy)
    if (distance < best.distance) best = { x: sx, y: sy / heightPerWidth, distance, segment: i - 1 }
  }
  return best
}
