import { readFileSync } from 'node:fs'
import { drizzle } from 'drizzle-orm/sqlite-proxy'
import { describe, expect, it } from 'vitest'
import { toBeaconRegistry, type StoredBeacon } from '../utils/location/beaconRegistry'
import { enuToPlan } from '../utils/location/geo/floorTransform'
import { wgs84ToEnu } from '../utils/location/geo/wgs84'
import { spnVenue } from '../utils/location/venues/spn'
import { importBeaconSurvey, listBeacons, parseBeaconSurvey, parseCsv, removeStaleSurveys, surveyLocalToWgs84, type SurveyFloorMeta } from './beacons'
import * as schema from './schema'
import { SPN1_LEVEL1 } from './seed'

const SURVEY = 'public/data/surveys/spn-level1'
const csv = readFileSync(`${SURVEY}-beacons-20261030-2055.csv`, 'utf8')
const exported: SurveyFloorMeta = JSON.parse(readFileSync(`${SURVEY}-floor-20261030-2055.json`, 'utf8'))
// What the app imports: the export with its georeference corrected (see seed.ts)
const floor: SurveyFloorMeta = { ...exported, geo: SPN1_LEVEL1.surveys[0]!.geo }

describe('parseCsv', () => {
  it('handles quotes, doubled quotes and CRLF', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n,\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"']])
  })
})

describe('parseBeaconSurvey (SPN1 level 1, 2026-10-30, vBLE beams grouped)', () => {
  const { beacons, skipped } = parseBeaconSurvey(csv, floor)

  it('reads every Eddystone-UID row, with lowercase IDs and `*` for the beam digit of grouped APs', () => {
    expect(beacons).toHaveLength(71)
    expect(skipped).toBe(0)
    expect(beacons.every((b) => b.namespace === 'a023919cd30a4e79bbd9' && /^[0-9a-f]{5}[0-9a-f*][0-9a-f]{6}$/.test(b.instance))).toBe(true)
    expect(beacons.filter((b) => b.instance.includes('*'))).toHaveLength(65)
    expect(new Set(beacons.map((b) => b.instance)).size).toBe(71)
  })

  it('keeps the fit for placed beacons and leaves unplaced ones without a position', () => {
    const placed = beacons.filter((b) => b.position_source === 'auto')
    expect(placed.length).toBe(52)
    expect(placed.every((b) => b.latitude !== null && b.tx_power_dbm !== null && b.path_loss_exponent !== null)).toBe(true)
    expect(beacons.filter((b) => b.status === 'insufficient').every((b) => b.latitude === null)).toBe(true)

    const good = beacons.find((b) => b.instance === '41022*e40000')!
    expect(good).toMatchObject({ status: 'good', tx_power_dbm: -51.4, path_loss_exponent: 2.75, sigma_major_m: 1.22 })
  })

  it('with the export\'s own georeference, converts the local frame to the lat/lon it exported', () => {
    // Every placed row has both its local position and lat/lon, so they check our conversion
    const header = parseCsv(csv)[0]!
    const col = (name: string) => header.indexOf(name)
    for (const row of parseCsv(csv).slice(1).filter((r) => r[col('latitude')])) {
      const { lat, lon } = surveyLocalToWgs84(Number(row[col('local_x_m')]), Number(row[col('local_y_m')]), exported)
      const { e, n } = wgs84ToEnu({ lat, lon, h: 0 }, { lat: Number(row[col('latitude')]), lon: Number(row[col('longitude')]), h: 0 })
      expect(Math.hypot(e, n)).toBeLessThan(0.01)
    }
  })

  it('stores ambiguous beacons\' mirror-image solution as lat/lon', () => {
    const ambiguous = beacons.filter((b) => b.status === 'ambiguous')
    expect(ambiguous).toHaveLength(1)
    expect(ambiguous.every((b) => b.alternate_latitude !== null && b.alternate_longitude !== null)).toBe(true)
  })

  it('stores the error ellipse as a compass bearing', () => {
    expect(beacons.every((b) => b.ellipse_bearing_deg == null || (b.ellipse_bearing_deg >= 0 && b.ellipse_bearing_deg < 180))).toBe(true)
  })
})

describe('toBeaconRegistry', () => {
  const stored: StoredBeacon[] = parseBeaconSurvey(csv, floor).beacons.map((b) => ({
    namespace: b.namespace,
    instance: b.instance,
    building: 'SPN1',
    level: 1,
    status: b.status,
    latitude: b.latitude ?? null,
    longitude: b.longitude ?? null,
    txPowerDbm: b.tx_power_dbm ?? null,
    pathLossExponent: b.path_loss_exponent ?? null,
    heightOffsetM: exported.path_loss?.height_offset_m ?? null
  }))
  const registry = toBeaconRegistry(stored, spnVenue)

  it('keeps only trusted, placed beacons, keyed like scanned Eddystone frames', () => {
    expect(registry).toHaveLength(37) // 21 good + 16 fair APs
    expect(registry[0]!.id).toMatch(/^a023919cd30a4e79bbd9:[0-9a-f*]{12}$/)
    expect(registry.every((b) => b.floorId === 'spn1-l1')).toBe(true)
  })

  it('mounts beacons at the survey\'s height above the phone', () => {
    expect(registry.every((b) => Math.abs(b.enu.u - (1.2 + 1.5)) < 1e-9)).toBe(true)
  })

  it('places the beacons on the SPN1 level 1 map', () => {
    const level1 = spnVenue.buildings[0]!.floors[0]!
    const onMap = registry.filter((b) => {
      const { x, y } = enuToPlan(b.enu, level1.transform)
      return x >= 0 && x <= level1.plan!.width && y >= 0 && y <= level1.plan!.height
    })
    // APs hang inside the building, so (nearly) all of them should land within the map's bounds
    expect(onMap.length / registry.length).toBeGreaterThan(0.95)
  })

  it('skips beacons on floors the venue doesn\'t have', () => {
    expect(toBeaconRegistry(stored.map((b) => ({ ...b, level: 9 })), spnVenue)).toHaveLength(0)
  })
})

describe('importBeaconSurvey (in SQLite)', () => {
  // Node's built-in SQLite stands in for the Capacitor plugin, running the same migrations
  async function openDb() {
    const { DatabaseSync } = await import('node:sqlite')
    const conn = new DatabaseSync(':memory:')
    const journal = JSON.parse(readFileSync('app/db/migrations/meta/_journal.json', 'utf8'))
    for (const { tag } of journal.entries) conn.exec(readFileSync(`app/db/migrations/${tag}.sql`, 'utf8').replaceAll('--> statement-breakpoint', ''))
    const db = drizzle(async (query, params, method) => {
      const stmt = conn.prepare(query)
      if (method === 'run') { stmt.run(...(params as never[])); return { rows: [] } }
      const rows = stmt.all(...(params as never[])).map((row) => Object.values(row as object))
      return { rows: (method === 'get' ? rows[0] : rows) as any[] }
    }, { schema })
    await db.insert(schema.buildings).values({ name: 'SPN1' })
    await db.insert(schema.floors).values({ building_id: 1, level: 1, svg_path: '', grid_path: '' })
    return db
  }

  it('imports once, and lists beacons for the location module', async () => {
    const db = await openDb()
    expect(await importBeaconSurvey(db, { floorId: 1, name: 's1', csv, floor })).toEqual({ imported: 71, skipped: 0 })
    expect(await importBeaconSurvey(db, { floorId: 1, name: 's1', csv, floor })).toEqual({ imported: 0, skipped: 0 })

    const stored = await listBeacons(db)
    expect(stored).toHaveLength(71)
    const good = stored.find((b) => b.instance === '41022*e40000')!
    expect(good).toMatchObject({ building: 'SPN1', level: 1, status: 'good', txPowerDbm: -51.4 })
    expect(good.heightOffsetM).toBeCloseTo(1.5)
    expect(toBeaconRegistry(stored, spnVenue)).toHaveLength(37)
  })

  it('lets a later survey update beacons without erasing positions it couldn\'t find', async () => {
    const db = await openDb()
    await importBeaconSurvey(db, { floorId: 1, name: 's1', csv, floor })
    const header = csv.slice(0, csv.indexOf('\n') + 1)
    const row = (instance: string) => csv.split('\n').find((line) => line.includes(`:${instance},`))!
    expect(row('410208ED0000')).toContain('insufficient')
    // A placed beacon now reported as insufficient (status, quality, position_source, position cleared), and an
    // insufficient one now placed (borrowing a placed row's fit)
    const later = header
      + row('41022*E40000').split(',').map((f, i) => (i === 11 || i === 12 ? 'insufficient' : i === 13 ? 'none' : i >= 14 && i <= 21 ? '' : f)).join(',') + '\n'
      + row('41028*EC0000').replaceAll('41028*EC0000', '410208ED0000') + '\n'
    await importBeaconSurvey(db, { floorId: 1, name: 's2', csv: later, floor })

    const byInstance = new Map((await listBeacons(db)).map((b) => [b.instance, b]))
    expect(byInstance.get('41022*e40000')).toMatchObject({ status: 'good' })
    expect(byInstance.get('410208ed0000')).toMatchObject({ status: 'good', txPowerDbm: -51.3 })
  })

  it('removes surveys no longer listed, with the beacons they last set', async () => {
    const db = await openDb()
    await importBeaconSurvey(db, { floorId: 1, name: 'old', csv, floor })
    const header = csv.slice(0, csv.indexOf('\n') + 1)
    const row = (instance: string) => csv.split('\n').find((line) => line.includes(`:${instance},`))!
    await importBeaconSurvey(db, { floorId: 1, name: 'new', csv: header + row('41022*E40000') + '\n', floor })

    expect(await removeStaleSurveys(db, 1, ['new'])).toBe(1)
    expect(await removeStaleSurveys(db, 1, ['new'])).toBe(0)
    expect((await listBeacons(db)).map((b) => b.instance)).toEqual(['41022*e40000'])
    expect(await db.select().from(schema.beacon_surveys)).toHaveLength(1)
  })
})
