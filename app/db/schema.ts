import { sqliteTable, integer, text, real, unique, index } from 'drizzle-orm/sqlite-core'

// All x/y positions are fractions (0–1) of the floor SVG, from the top-left (see CLAUDE.md).
// Beacons are the exception: they are stored in WGS84 lat/lon.

export const buildings = sqliteTable('buildings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
})

// One SVG + grid per floor; routing runs A* on the grid
export const floors = sqliteTable('floors', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  building_id: integer('building_id').references(() => buildings.id).notNull(),
  level: integer('level').notNull(),
  svg_path: text('svg_path').notNull(),   // e.g. /maps/spn-level1.svg
  grid_path: text('grid_path').notNull(), // e.g. /data/spn-level1-grid.json
  meters_per_cell: real('meters_per_cell'), // unknown until the grid scale is confirmed
}, (t) => [
  // can't have two of the same level!
  unique().on(t.building_id, t.level),
])

// Room number + name isn't unique (several unnamed 1.1 corridors), so no unique constraint
export const rooms = sqliteTable('rooms', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  floor_id: integer('floor_id').references(() => floors.id).notNull(),
  number: text('number').notNull(),
  name: text('name'),
  x: real('x').notNull(), // label position
  y: real('y').notNull(),
  // walkable point at the door, if known; otherwise route to the nearest walkable cell to x/y
  entrance_x: real('entrance_x'),
  entrance_y: real('entrance_y'),
}, (t) => [
  index('rooms_floor_number_idx').on(t.floor_id, t.number),
])

// Stairs/elevators linking floors; rows sharing a group_id are the same stairwell or shaft
export const connectors = sqliteTable('connectors', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  floor_id: integer('floor_id').references(() => floors.id).notNull(),
  group_id: text('group_id').notNull(),
  type: text('type', { enum: ['stairs', 'elevator'] }).notNull(),
  x: real('x').notNull(),
  y: real('y').notNull(),
}, (t) => [
  index('connectors_group_idx').on(t.group_id),
])

// One imported bSLAM beacon survey export (public/data/surveys/), so a survey is only imported once
export const beacon_surveys = sqliteTable('beacon_surveys', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  floor_id: integer('floor_id').references(() => floors.id).notNull(),
  name: text('name').notNull().unique(),     // e.g. spn-level1-20261021-1103
  project_id: text('project_id'),            // bSLAM project UUID
  exported_at: text('exported_at'),          // ISO-8601
  // Vertical beacon-to-phone distance the survey's path-loss fit assumed
  height_offset_m: real('height_offset_m'),
  imported_at: integer('imported_at').notNull(), // ms since the Unix epoch
})

// BLE beacons (Mist AP43s broadcasting Eddystone-UID), for trilateration.
// Unlike the rest of this file, positions are WGS84 (lat/lon degrees), not map fractions: the location
// module works in real-world coordinates, and the survey's local frame isn't kept.
export const beacons = sqliteTable('beacons', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  floor_id: integer('floor_id').references(() => floors.id).notNull(),
  survey_id: integer('survey_id').references(() => beacon_surveys.id), // survey that last set this row
  namespace: text('namespace').notNull(), // 10-byte Eddystone namespace, lowercase hex
  instance: text('instance').notNull(),   // 6-byte Eddystone instance, lowercase hex; `*` stands for a vBLE beam digit (one row per AP)
  label: text('label'), // e.g. the AP's name from OIT, to help find it on site

  // manual (placed by hand) or the fit quality: good, fair, ambiguous, poor, insufficient
  status: text('status').notNull(),
  position_source: text('position_source', { enum: ['manual', 'auto', 'none'] }).notNull(),
  latitude: real('latitude'), // null when the survey couldn't place it
  longitude: real('longitude'),

  // Position uncertainty: 1-sigma error ellipse, its major axis as a compass bearing (0–180°), and a 95% radius
  sigma_major_m: real('sigma_major_m'),
  sigma_minor_m: real('sigma_minor_m'),
  ellipse_bearing_deg: real('ellipse_bearing_deg'),
  radius_95_m: real('radius_95_m'),
  // The mirror-image solution when status is ambiguous
  alternate_latitude: real('alternate_latitude'),
  alternate_longitude: real('alternate_longitude'),

  // Fitted log-distance path loss model: rssi = tx_power_dbm - 10 * n * log10(distance)
  tx_power_dbm: real('tx_power_dbm'), // RSSI at 1 m
  path_loss_exponent: real('path_loss_exponent'),
  fit_rmse_db: real('fit_rmse_db'),
  bins: integer('bins'),
  samples: integer('samples'),

  // Raw signal: the strongest spot heard (a rough fallback location) and the strongest reading
  peak_latitude: real('peak_latitude'),
  peak_longitude: real('peak_longitude'),
  peak_rssi_dbm: real('peak_rssi_dbm'),
  max_rssi_dbm: real('max_rssi_dbm'),
  advertised_tx_power_dbm: real('advertised_tx_power_dbm'), // from the Eddystone frame, measured at 0 m

  first_seen: text('first_seen'), // ISO-8601
  last_seen: text('last_seen'),
  updated_at: text('updated_at'), // when the survey last changed this beacon
  notes: text('notes'),
}, (t) => [
  // a scanned frame is matched to its beacon by namespace + instance (with `*` matching any digit)
  unique().on(t.namespace, t.instance),
])
