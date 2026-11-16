import { eq } from 'drizzle-orm'
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy'
import type { StoredFloor } from '../utils/location/floorRegistry'
import * as schema from './schema'

const { buildings, floors } = schema

/** Every floor with its building and height, for `withStoredFloors` */
export async function listFloors(db: SqliteRemoteDatabase<typeof schema>): Promise<StoredFloor[]> {
  return db
    .select({ building: buildings.name, level: floors.level, elevationM: floors.elevation_m })
    .from(floors)
    .innerJoin(buildings, eq(floors.building_id, buildings.id))
}
