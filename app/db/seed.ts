import { and, count, eq } from 'drizzle-orm'
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy'
import { importBeaconSurvey, isSurveyImported, removeStaleSurveys, type SurveyFloorMeta } from './beacons'
import * as schema from './schema'

const { buildings, floors, rooms } = schema

// Bundled map data per floor of SPN1 (from scripts/cad-to-svg.py)
// `surveys`: bSLAM beacon surveys, oldest first: a later survey's data replaces an earlier one's.
// `geo` overrides the export's georeference (where the survey's local frame sits on Earth).
export const SPN1_LEVEL1 = {
  level: 1,
  svg_path: '/maps/spn-level1.svg',
  grid_path: '/data/spn-level1-grid.json',
  rooms_path: '/maps/spn-level1-rooms.json',
  surveys: [
    {
      // vBLE beams grouped per AP (group_virtual_beacons)
      name: 'spn-level1-20261030-2055',
      csv_path: '/data/surveys/spn-level1-beacons-20261030-2055.csv',
      floor_path: '/data/surveys/spn-level1-floor-20261030-2055.json',
      // The export's georeference is wrong (unchanged since the 2026-10-21 export, same floorplan image and frame): it gives the image's bottom-left corner (blank paper) the lat/lon of
      // the UT Design 1.2 corner, with image-right pointing east. Image-right is actually south, as on our map.
      // Re-anchored by matching 58 room labels between the survey's floorplan image and spn-level1.svg, through
      // the level 1 satellite fit (venues/spn.ts): 0.22 m RMS keeping the survey's own scale. Remove this once
      // the survey's geo-referencing is fixed in bSLAM and it's re-exported.
      geo: { origin_latitude: 32.99454196, origin_longitude: -96.75271754, x_axis_bearing_deg: 180.08 },
    },
  ],
}

export const SPN1_LEVEL2 = {
  level: 2,
  svg_path: '/maps/spn-level2.svg',
  grid_path: '', // no routing grid for level 2 yet (Map generation workstream)
  rooms_path: '/maps/spn-level2-rooms.json',
  surveys: [
    {
      name: 'spn-level2-20261030-2057',
      csv_path: '/data/surveys/spn-level2-beacons-20261030-2057.csv',
      floor_path: '/data/surveys/spn-level2-floor-20261030-2057.json',
      // Same wrong georeference as level 1, and the export's scale (28.47 px/m) is ~4% off. Fitted by registering
      // the level 2 floorplan image onto level 1's (walls, columns, cores: scale 1.0138, 0.3 px after rotation) and
      // reusing level 1's override above; `scale` turns the export's meters into real ones.
      geo: { origin_latitude: 32.99455647, origin_longitude: -96.75273094, x_axis_bearing_deg: 180.08, scale: 0.9598 },
    },
  ],
}

export const SPN1_FLOORS = [SPN1_LEVEL1, SPN1_LEVEL2]

async function fetchOk(path: string) {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`seed: couldn't load ${path} (${res.status})`)
  return res
}

// Fills an empty database with SPN1's floors. Safe to run on every launch:
// each step skips what's already there, so an interrupted seed finishes next time.
// Connectors stay empty until their positions are known.
export async function seed(db: SqliteRemoteDatabase<typeof schema>) {
  await db.insert(buildings).values({ name: 'SPN1' }).onConflictDoNothing()
  const [building] = await db.select().from(buildings).where(eq(buildings.name, 'SPN1'))
  for (const data of SPN1_FLOORS) await seedFloor(db, building!.id, data)
}

async function seedFloor(db: SqliteRemoteDatabase<typeof schema>, buildingId: number, data: typeof SPN1_FLOORS[number]) {
  await db.insert(floors).values({
    building_id: buildingId,
    level: data.level,
    svg_path: data.svg_path,
    grid_path: data.grid_path,
  }).onConflictDoNothing()
  const [floor] = await db.select().from(floors)
    .where(and(eq(floors.building_id, buildingId), eq(floors.level, data.level)))

  const [existing] = await db.select({ n: count() }).from(rooms).where(eq(rooms.floor_id, floor!.id))
  if (!existing || existing.n === 0) {
    const list: { number: string, name: string, x: number, y: number }[] = await (await fetchOk(data.rooms_path)).json()
    await db.insert(rooms).values(list.map(r => ({
      floor_id: floor!.id,
      number: r.number,
      name: r.name || null, // some rooms have no name in the CAD export
      x: r.x,
      y: r.y,
    })))
  }

  // Surveys dropped from the list (e.g. replaced by a re-survey) are removed along with the beacons they set
  await removeStaleSurveys(db, floor!.id, data.surveys.map(s => s.name))
  for (const survey of data.surveys) {
    if (await isSurveyImported(db, survey.name)) continue
    const [csv, floorMeta] = await Promise.all([
      fetchOk(survey.csv_path).then(r => r.text()),
      fetchOk(survey.floor_path).then(r => r.json() as Promise<SurveyFloorMeta>),
    ])
    await importBeaconSurvey(db, { floorId: floor!.id, name: survey.name, csv, floor: { ...floorMeta, geo: survey.geo ?? floorMeta.geo } })
  }
}
