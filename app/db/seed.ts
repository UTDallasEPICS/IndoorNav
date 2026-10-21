import { and, count, eq } from 'drizzle-orm'
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy'
import * as schema from './schema'

const { buildings, floors, rooms } = schema

// Bundled map data for SPN1 level 1 (from scripts/cad-to-svg.py)
const SPN1_LEVEL1 = {
  svg_path: '/maps/spn-level1.svg',
  grid_path: '/data/spn-level1-grid.json',
  rooms_path: '/maps/spn-level1-rooms.json',
}

// Fills an empty database with SPN1 level 1. Safe to run on every launch:
// each step skips what's already there, so an interrupted seed finishes next time.
// Beacons and connectors stay empty until their positions are known.
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
  if (existing && existing.n > 0) return

  const res = await fetch(SPN1_LEVEL1.rooms_path)
  if (!res.ok) throw new Error(`seed: couldn't load ${SPN1_LEVEL1.rooms_path} (${res.status})`)
  const data: { number: string, name: string, x: number, y: number }[] = await res.json()

  await db.insert(rooms).values(data.map(r => ({
    floor_id: floor!.id,
    number: r.number,
    name: r.name || null, // some rooms have no name in the CAD export
    x: r.x,
    y: r.y,
  })))
}
