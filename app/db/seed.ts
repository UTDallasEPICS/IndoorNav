import { and, count, eq } from 'drizzle-orm'
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy'
import { importBeaconSurvey, isSurveyImported, removeStaleSurveys, type SurveyFloorMeta } from './beacons'
import * as schema from './schema'

const { buildings, floors, rooms } = schema

// Bundled map data for SPN1 level 1 (from scripts/cad-to-svg.py)
export const SPN1_LEVEL1 = {
  svg_path: '/maps/spn-level1.svg',
  grid_path: '/data/spn-level1-grid.json',
  rooms_path: '/maps/spn-level1-rooms.json',
  // bSLAM beacon surveys, oldest first: a later survey's data replaces an earlier one's.
  // `geo` overrides the export's georeference (where the survey's local frame sits on Earth).
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

async function fetchOk(path: string) {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`seed: couldn't load ${path} (${res.status})`)
  return res
}

// Fills an empty database with SPN1 level 1. Safe to run on every launch:
// each step skips what's already there, so an interrupted seed finishes next time.
// Connectors stay empty until their positions are known.
export async function seed(db: SqliteRemoteDatabase<typeof schema>) {
  await db.insert(buildings).values({ name: 'SPN1' }).onConflictDoNothing()
  const [building] = await db.select().from(buildings).where(eq(buildings.name, 'SPN1'))

  await db.insert(floors).values({
    building_id: building!.id,
    level: 1,
    svg_path: SPN1_LEVEL1.svg_path,
    grid_path: SPN1_LEVEL1.grid_path,
  }).onConflictDoNothing()
  const [floor] = await db.select().from(floors)
    .where(and(eq(floors.building_id, building!.id), eq(floors.level, 1)))

  const [existing] = await db.select({ n: count() }).from(rooms).where(eq(rooms.floor_id, floor!.id))
  if (!existing || existing.n === 0) {
    const data: { number: string, name: string, x: number, y: number }[] = await (await fetchOk(SPN1_LEVEL1.rooms_path)).json()
    await db.insert(rooms).values(data.map(r => ({
      floor_id: floor!.id,
      number: r.number,
      name: r.name || null, // some rooms have no name in the CAD export
      x: r.x,
      y: r.y,
    })))
  }

  // Surveys dropped from the list (e.g. replaced by a re-survey) are removed along with the beacons they set
  await removeStaleSurveys(db, floor!.id, SPN1_LEVEL1.surveys.map(s => s.name))
  for (const survey of SPN1_LEVEL1.surveys) {
    if (await isSurveyImported(db, survey.name)) continue
    const [csv, floorMeta] = await Promise.all([
      fetchOk(survey.csv_path).then(r => r.text()),
      fetchOk(survey.floor_path).then(r => r.json() as Promise<SurveyFloorMeta>),
    ])
    await importBeaconSurvey(db, { floorId: floor!.id, name: survey.name, csv, floor: { ...floorMeta, geo: survey.geo ?? floorMeta.geo } })
  }
}
