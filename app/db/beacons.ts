// Beacon survey import (bSLAM exports in public/data/surveys/) and the beacon query the location module uses.
// Survey positions arrive in the survey's local metric frame; everything is converted to WGS84 here and the local
// frame is not stored.

import { and, eq, getTableColumns, gt, sql } from 'drizzle-orm'
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy'
import { enuToWgs84 } from '../utils/location/geo/wgs84'
import type { StoredBeacon } from '../utils/location/beaconRegistry'
import * as schema from './schema'

const { beacon_surveys, beacons, buildings, floors } = schema

/** The parts of a bSLAM floor export (`*_floor_*.json`) the import needs */
export interface SurveyFloorMeta {
  project_id?: string
  exported_at?: string
  /** Local frame anchor: local (0, 0) sits at origin_latitude/longitude, local +x points at x_axis_bearing_deg */
  geo: { origin_latitude: number, origin_longitude: number, x_axis_bearing_deg: number }
  /** "counterclockwise_from_x (cartesian)" or clockwise (image-style, y down) */
  y_axis: string
  path_loss?: { height_offset_m?: number | null }
}

export type SurveyedBeacon = Omit<typeof beacons.$inferInsert, 'id' | 'floor_id' | 'survey_id'>

/** Minimal RFC 4180 CSV parser: quoted fields, doubled quotes, CRLF */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.some((f) => f !== ''))
}

/** Converts a point in the survey's local frame (meters) to WGS84 */
export function surveyLocalToWgs84(x: number, y: number, floor: SurveyFloorMeta) {
  const xBearing = (floor.geo.x_axis_bearing_deg * Math.PI) / 180
  // Cartesian y is 90° counterclockwise of x; image-style y is 90° clockwise
  const yBearing = xBearing + (isClockwise(floor) ? Math.PI / 2 : -Math.PI / 2)
  const e = x * Math.sin(xBearing) + y * Math.sin(yBearing)
  const n = x * Math.cos(xBearing) + y * Math.cos(yBearing)
  const { lat, lon } = enuToWgs84({ e, n, u: 0 }, { lat: floor.geo.origin_latitude, lon: floor.geo.origin_longitude, h: 0 })
  return { lat, lon }
}

const isClockwise = (floor: SurveyFloorMeta) => !/counterclockwise/i.test(floor.y_axis)

/** Parses a bSLAM beacon export (`*_beacons_*.csv`). Non-Eddystone-UID rows are skipped: the app only scans Eddystone-UID. */
export function parseBeaconSurvey(csv: string, floor: SurveyFloorMeta): { beacons: SurveyedBeacon[], skipped: number } {
  const [header, ...rows] = parseCsv(csv)
  if (!header) return { beacons: [], skipped: 0 }
  const col = new Map(header.map((name, i) => [name.trim(), i]))
  for (const required of ['type', 'uuid_or_namespace', 'instance', 'status', 'position_source', 'latitude', 'longitude']) {
    if (!col.has(required)) throw new Error(`Beacon survey is missing the ${required} column`)
  }

  const out: SurveyedBeacon[] = []
  let skipped = 0
  for (const row of rows) {
    const text = (name: string) => {
      const value = row[col.get(name) ?? -1]?.trim()
      return value ? value : null
    }
    const num = (name: string) => {
      const value = text(name)
      return value === null || !Number.isFinite(Number(value)) ? null : Number(value)
    }
    const localToWgs84 = (xName: string, yName: string) => {
      const x = num(xName)
      const y = num(yName)
      return x === null || y === null ? null : surveyLocalToWgs84(x, y, floor)
    }

    const namespace = text('uuid_or_namespace')?.toLowerCase()
    const instance = text('instance')?.toLowerCase()
    if (text('type') !== 'eddystone' || !namespace || !instance) {
      skipped++
      continue
    }

    const source = text('position_source')
    const ellipseAngle = num('ellipse_angle_deg')
    // Recomputed from the local position (it matches the export's own lat/lon to < 1 cm), so a corrected
    // `floor.geo` re-anchors the whole survey. Falls back to the exported lat/lon.
    const position = localToWgs84('local_x_m', 'local_y_m')
      ?? (num('latitude') === null || num('longitude') === null ? null : { lat: num('latitude')!, lon: num('longitude')! })
    const alternate = localToWgs84('alternate_x_m', 'alternate_y_m')
    const peak = localToWgs84('peak_x_m', 'peak_y_m')
    out.push({
      namespace,
      instance,
      label: text('label'),
      status: text('status') ?? 'insufficient',
      position_source: source === 'manual' || source === 'auto' ? source : 'none',
      latitude: position?.lat ?? null,
      longitude: position?.lon ?? null,
      sigma_major_m: num('sigma_major_m'),
      sigma_minor_m: num('sigma_minor_m'),
      // The export's angle is in the local frame; store it as a compass bearing of the major axis
      ellipse_bearing_deg: ellipseAngle === null
        ? null
        : (((floor.geo.x_axis_bearing_deg + (isClockwise(floor) ? ellipseAngle : -ellipseAngle)) % 180) + 180) % 180,
      radius_95_m: num('radius_95_m'),
      alternate_latitude: alternate?.lat ?? null,
      alternate_longitude: alternate?.lon ?? null,
      tx_power_dbm: num('tx_power_1m_dbm'),
      path_loss_exponent: num('path_loss_exponent'),
      fit_rmse_db: num('fit_rmse_db'),
      bins: num('bins'),
      samples: num('samples'),
      peak_latitude: peak?.lat ?? null,
      peak_longitude: peak?.lon ?? null,
      peak_rssi_dbm: num('peak_rssi_dbm'),
      max_rssi_dbm: num('max_rssi_dbm'),
      advertised_tx_power_dbm: num('advertised_tx_power_dbm'),
      first_seen: text('first_seen'),
      last_seen: text('last_seen'),
      updated_at: text('updated_at'),
      notes: text('notes')
    })
  }
  return { beacons: out, skipped }
}

/** True once a survey has been fully imported (an interrupted import is retried) */
export async function isSurveyImported(db: SqliteRemoteDatabase<typeof schema>, name: string) {
  const [row] = await db.select().from(beacon_surveys).where(and(eq(beacon_surveys.name, name), gt(beacon_surveys.imported_at, 0)))
  return !!row
}

// 28 columns per row; keeps each INSERT under SQLite's default 999 bound parameters
const INSERT_CHUNK = 25

/**
 * Imports one survey onto a floor, unless a survey with this name was already imported. Beacons are matched by
 * namespace + instance; a later survey replaces a beacon's data, except that a survey which couldn't place a
 * beacon doesn't wipe a position an earlier survey found. Safe to re-run after an interruption.
 */
export async function importBeaconSurvey(
  db: SqliteRemoteDatabase<typeof schema>,
  survey: { floorId: number, name: string, csv: string, floor: SurveyFloorMeta }
) {
  if (await isSurveyImported(db, survey.name)) return { imported: 0, skipped: 0 }

  const { beacons: rows, skipped } = parseBeaconSurvey(survey.csv, survey.floor)

  // The survey row is written first so beacons can point at it, but marked imported (imported_at) only at the end
  await db.insert(beacon_surveys).values({
    floor_id: survey.floorId,
    name: survey.name,
    project_id: survey.floor.project_id ?? null,
    exported_at: survey.floor.exported_at ?? null,
    height_offset_m: survey.floor.path_loss?.height_offset_m ?? null,
    imported_at: 0
  }).onConflictDoNothing()
  const [surveyRow] = await db.select().from(beacon_surveys).where(eq(beacon_surveys.name, survey.name))

  const { id: _id, namespace: _ns, instance: _inst, ...updatable } = getTableColumns(beacons)
  const set = Object.fromEntries(Object.entries(updatable).map(([key, column]) => [key, sql.raw(`excluded.${column.name}`)]))
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await db.insert(beacons)
      .values(rows.slice(i, i + INSERT_CHUNK).map((b) => ({ ...b, floor_id: survey.floorId, survey_id: surveyRow!.id })))
      .onConflictDoUpdate({
        target: [beacons.namespace, beacons.instance],
        set,
        setWhere: sql`excluded.latitude IS NOT NULL OR ${beacons.latitude} IS NULL`
      })
  }

  await db.update(beacon_surveys).set({ imported_at: Date.now() }).where(eq(beacon_surveys.id, surveyRow!.id))
  return { imported: rows.length, skipped }
}

/** Every beacon with its building, floor level, and the survey's height offset, for `toBeaconRegistry` */
export async function listBeacons(db: SqliteRemoteDatabase<typeof schema>): Promise<StoredBeacon[]> {
  const rows = await db
    .select({
      namespace: beacons.namespace,
      instance: beacons.instance,
      building: buildings.name,
      level: floors.level,
      status: beacons.status,
      latitude: beacons.latitude,
      longitude: beacons.longitude,
      txPowerDbm: beacons.tx_power_dbm,
      pathLossExponent: beacons.path_loss_exponent,
      heightOffsetM: beacon_surveys.height_offset_m
    })
    .from(beacons)
    .innerJoin(floors, eq(beacons.floor_id, floors.id))
    .innerJoin(buildings, eq(floors.building_id, buildings.id))
    .leftJoin(beacon_surveys, eq(beacons.survey_id, beacon_surveys.id))
  return rows
}
