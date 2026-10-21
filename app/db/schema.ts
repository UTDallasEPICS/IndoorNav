import { sqliteTable, integer, text, real, unique, index } from 'drizzle-orm/sqlite-core'

// All x/y positions are fractions (0–1) of the floor SVG, from the top-left (see CLAUDE.md)

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

// BLE beacons (Mist AP43s broadcasting Eddystone-UID), for trilateration
export const beacons = sqliteTable('beacons', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  floor_id: integer('floor_id').references(() => floors.id).notNull(),
  namespace: text('namespace').notNull(), // 10-byte Eddystone namespace, hex
  instance: text('instance').notNull(),   // 6-byte Eddystone instance, hex
  x: real('x').notNull(),
  y: real('y').notNull(),
  label: text('label'), // e.g. the AP's name from OIT, to help find it on site
}, (t) => [
  // a scanned frame is matched to its beacon by namespace + instance
  unique().on(t.namespace, t.instance),
])