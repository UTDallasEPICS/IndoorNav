import { defineConfig } from 'vitest/config'

// Unit tests for pure logic (e.g. app/utils/location). They run in Node, without Nuxt or a device.
export default defineConfig({
  test: {
    include: ['app/**/*.test.ts'],
    environment: 'node'
  }
})
