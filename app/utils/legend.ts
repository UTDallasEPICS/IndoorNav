// Map legend: turns the entries in public/maps/spn-legend.json into shapes to draw on the map.
// Each entry names a room by number + name (numbers alone aren't unique, e.g. several rooms are 1.1);
// the room's outline or position comes from the rooms JSON made by scripts/cad-to-svg.py.

export type LegendEntry = {
  number: string // room number, e.g. "1.101"
  name: string // room name as in the rooms JSON, e.g. "RECEPTION"
  label: string // what it is, shown in the legend panel, e.g. "Reception"
  color: string // any CSS colour, e.g. "#e0609a"
  type: 'area' | 'point' // area = fill the room's outline, point = a dot on the room
  legend: boolean // true = listed in the legend panel; false = only drawn on the map
  outline?: [number, number][] // optional, for rooms the CAD export has no outline for; same 0–1 fractions as the rooms JSON
}

export type Room = { number: string; name: string; x: number; y: number; floor: number; outline?: [number, number][] }

export type LegendArea = LegendEntry & { type: 'area'; floor: number; outline: [number, number][] }
export type LegendPoint = LegendEntry & { type: 'point'; floor: number; x: number; y: number }

// Finds each entry's room and gives back what to draw: areas get the room's outline, points its position.
// An area whose room has no outline is drawn as a point instead; entries with no matching room are skipped.
export function resolveLegend(entries: LegendEntry[], rooms: Room[]) {
  const areas: LegendArea[] = []
  const points: LegendPoint[] = []
  const missing: LegendEntry[] = [] // no room with that number + name (typo, or the CAD export changed)

  for (const entry of entries) {
    const room = rooms.find(r => r.number === entry.number && r.name === entry.name)
    const outline = entry.outline ?? room?.outline // the JSON's own outline wins over the CAD one
    if (!room) {
      missing.push(entry)
    } else if (entry.type === 'area' && outline) {
      areas.push({ ...entry, type: 'area', floor: room.floor, outline })
    } else {
      points.push({ ...entry, type: 'point', floor: room.floor, x: room.x, y: room.y }) // also areas without an outline
    }
  }
  return { areas, points, missing }
}

// Rows for the legend panel: entries with legend: true, one row per label (all six restrooms are one "Restrooms" row).
// The first entry with a label sets that row's colour and type.
export function legendRows(entries: LegendEntry[]) {
  const rows = new Map<string, Pick<LegendEntry, 'label' | 'color' | 'type'>>()
  for (const { label, color, type, legend } of entries) {
    if (legend && !rows.has(label)) rows.set(label, { label, color, type })
  }
  return [...rows.values()] // same order as the JSON
}
