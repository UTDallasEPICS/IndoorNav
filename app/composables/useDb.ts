import { Capacitor } from '@capacitor/core'
import { CapacitorSQLite, SQLiteConnection, type SQLiteDBConnection } from '@capacitor-community/sqlite'
import { drizzle, type SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy'
import * as schema from '~/db/schema'
import { runMigrations } from '~/db/migrate'
import { seed } from '~/db/seed'

const DB_NAME = 'indoor-nav'

let dbPromise: Promise<SqliteRemoteDatabase<typeof schema>> | null = null

async function openConnection(): Promise<SQLiteDBConnection> {
  const sqlite = new SQLiteConnection(CapacitorSQLite)

  // Reuse the native connection if the web view reloaded (e.g. live reload)
  const consistent = (await sqlite.checkConnectionsConsistency()).result
  const exists = (await sqlite.isConnection(DB_NAME, false)).result
  const conn = consistent && exists
    ? await sqlite.retrieveConnection(DB_NAME, false)
    : await sqlite.createConnection(DB_NAME, false, 'no-encryption', 1, false)

  await conn.open()
  return conn
}

async function init() {
  // The app ships as a native Capacitor app (no PWA), so there's no web fallback
  if (!Capacitor.isNativePlatform()) {
    throw new Error('useDb: SQLite only runs in the iOS/Android app')
  }

  const conn = await openConnection()
  await runMigrations(conn)

  const db = drizzle(async (sql, params, method) => {
    if (method === 'run') {
      // transaction=false so Drizzle's own transactions aren't nested in the plugin's
      await conn.run(sql, params, false)
      return { rows: [] }
    }

    // The plugin returns rows as objects; Drizzle maps columns by position
    const rows = ((await conn.query(sql, params)).values ?? []).map(row => Object.values(row))
    // 'get' wants the single row itself, or undefined when nothing matched
    return { rows: (method === 'get' ? rows[0] : rows) as any[] }
  }, { schema })

  await seed(db)
  return db
}

// Opens the on-device database once (migrated and seeded) and shares it across the app
export function useDb() {
  dbPromise ??= init().catch((err) => {
    dbPromise = null
    throw err
  })
  return dbPromise
}