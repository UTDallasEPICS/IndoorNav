import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'edu.utdallas.epics.indoornav',
  appName: 'Indoor Navigation',
  // Output of `nuxt generate` (copied into ios/ and android/ by `cap sync`)
  webDir: '.output/public',
  // Live reload: set CAP_SERVER_URL to the dev server on your LAN, e.g.
  // CAP_SERVER_URL=http://192.168.1.20:3000 npx cap run ios
  ...(process.env.CAP_SERVER_URL && {
    server: { url: process.env.CAP_SERVER_URL, cleartext: true }
  })
}

export default config
