import { defineConfig } from 'drizzle-kit'

// Dev-only: `npm run db:generate` turns schema changes into SQL migrations,
// which ship in the app and run on the device (see app/db/migrate.ts)
export default defineConfig({
  dialect: 'sqlite',
  schema: './app/db/schema.ts',
  out: './app/db/migrations',
})
