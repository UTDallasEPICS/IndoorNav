import { readFileSync } from 'node:fs'
import { drizzle } from 'drizzle-orm/sqlite-proxy'
import { describe, expect, it } from 'vitest'
import { toBeaconRegistry, type StoredBeacon } from '../utils/location/beaconRegistry'
import { withStoredFloors } from '../utils/location/floorRegistry'
import { spnVenue } from '../utils/location/venues/spn'
import { listFloors } from './floors'
import * as schema from './schema'
import { SPN1_LEVEL1, SPN1_LEVEL2 } from './seed'

// Node's built-in SQLite stands in for the Capacitor plugin, running the same migrations
async function openDb() {
  const { DatabaseSync } = await import('node:sqlite')
  const conn = new DatabaseSync(':memory:')
  const journal = JSON.parse(readFileSync('app/db/migrations/meta/_journal.json', 'utf8'))
  for (const { tag } of journal.entries) conn.exec(readFileSync(`app/db/migrations/${tag}.sql`, 'utf8').replaceAll('--> statement-breakpoint', ''))
  return drizzle(async (query, params, method) => {
    const stmt = conn.prepare(query)
    if (method === 'run') { stmt.run(...(params as never[])); return { rows: [] } }
    const rows = stmt.all(...(params as never[])).map((row) => Object.values(row as object))
    return { rows: (method === 'get' ? rows[0] : rows) as any[] }
  }, { schema })
}

describe('floor heights (floors.elevation_m)', () => {
  it('are stored per floor and listed with their building', async () => {
    const db = await openDb()
    await db.insert(schema.buildings).values({ name: 'SPN1' })
    await db.insert(schema.floors).values([
      { building_id: 1, level: 1, svg_path: '', grid_path: '', elevation_m: SPN1_LEVEL1.elevation_m },
      { building_id: 1, level: 2, svg_path: '', grid_path: '', elevation_m: SPN1_LEVEL2.elevation_m },
      { building_id: 1, level: 3, svg_path: '', grid_path: '' }
    ])
    expect(await listFloors(db)).toEqual([
      { building: 'SPN1', level: 1, elevationM: 0 },
      { building: 'SPN1', level: 2, elevationM: 4.27 },
      { building: 'SPN1', level: 3, elevationM: null }
    ])
  })

  it('replace the venue\'s floor heights; floors without one keep theirs', () => {
    const venue = withStoredFloors(spnVenue, [{ building: 'SPN1', level: 2, elevationM: 4.6 }, { building: 'SPN1', level: 1, elevationM: null }])
    const [level1, level2] = venue.buildings[0]!.floors
    expect(level1!.transform.floorZ).toBe(0)
    expect(level2!.transform.floorZ).toBe(4.6)
    expect(level2!.transform.origin).toEqual(spnVenue.buildings[0]!.floors[1]!.transform.origin) // only the height changes
    expect(spnVenue.buildings[0]!.floors[1]!.transform.floorZ).toBe(4.27) // the original isn't modified
  })

  it('move the beacons with them, when applied before withStoredBeacons', () => {
    const beacon: StoredBeacon = {
      namespace: 'ns', instance: 'i', building: 'SPN1', level: 2, status: 'good',
      latitude: 32.994, longitude: -96.7522, txPowerDbm: -55, pathLossExponent: 2.2, heightOffsetM: 1.5
    }
    const venue = withStoredFloors(spnVenue, [{ building: 'SPN1', level: 2, elevationM: 4.6 }])
    expect(toBeaconRegistry([beacon], venue)[0]!.enu.u).toBeCloseTo(4.6 + 1.2 + 1.5)
  })
})
