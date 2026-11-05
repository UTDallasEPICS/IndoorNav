export interface Point2 {
  e: number
  n: number
}

/** Ray-casting point-in-polygon test. The polygon is closed implicitly (last point connects to the first). */
export function pointInPolygon(point: Point2, polygon: Point2[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!
    const b = polygon[j]!
    const crosses = (a.n > point.n) !== (b.n > point.n)
      && point.e < ((b.e - a.e) * (point.n - a.n)) / (b.n - a.n) + a.e
    if (crosses) inside = !inside
  }
  return inside
}
