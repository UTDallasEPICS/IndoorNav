// Converts GPS positions ({ lat, lng }) into map positions ({ x, y } as fractions 0–1 of
// the floor plan, like the rooms' x/y), using 3 building corners from public/maps/spn-georef.json.

const METERS_PER_DEGREE = 111320 // one degree of latitude, in metres

function toMeters({ lat, lng }, origin) { // metres east/north of origin (the Earth is flat enough at building size)
  return {
    east: (lng - origin.lng) * METERS_PER_DEGREE * Math.cos(origin.lat * Math.PI / 180), // degrees of longitude get shorter away from the equator
    north: (lat - origin.lat) * METERS_PER_DEGREE
  }
}

/** Builds a converter from the 3 reference points ({ lat, lng, x, y } each) */
export function makeGpsToMap(points) {
  const origin = points[0]
  const [p0, p1, p2] = points.map(point => toMeters(point, origin))
  const det = p0.east * (p1.north - p2.north) + p1.east * (p2.north - p0.north) + p2.east * (p0.north - p1.north)

  function fit([v0, v1, v2]) { // finds a, b, c so value = a*east + b*north + c at all 3 corners (Cramer's rule)
    const a = (v0 * (p1.north - p2.north) + v1 * (p2.north - p0.north) + v2 * (p0.north - p1.north)) / det
    const b = (v0 * (p2.east - p1.east) + v1 * (p0.east - p2.east) + v2 * (p1.east - p0.east)) / det
    return { a, b, c: v0 - a * p0.east - b * p0.north }
  }

  const fx = fit(points.map(point => point.x)) // handles the plan's rotation and scale
  const fy = fit(points.map(point => point.y))

  return {
    toMap(position) {
      const { east, north } = toMeters(position, origin)
      return { x: fx.a * east + fx.b * north + fx.c, y: fy.a * east + fy.b * north + fy.c }
    },
    widthPerMeter: Math.hypot(fx.a, fx.b) // how much of the plan's width one metre covers (for the accuracy circle)
  }
}

export function isOnMap({ x, y }) { // inside the floor plan's edges
  return x >= 0 && x <= 1 && y >= 0 && y <= 1
}
