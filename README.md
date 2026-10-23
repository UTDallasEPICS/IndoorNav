# Nuxt Minimal Starter

Look at the [Nuxt documentation](https://nuxt.com/docs/getting-started/introduction) to learn more.

## Setup

Install dependencies with [pnpm](https://pnpm.io) (`corepack enable` picks up the version pinned in `package.json`):

```bash
pnpm install
```

## Development Server

Start the development server on `http://localhost:3000`:

```bash
pnpm dev
```

## Production

Build the application for production:

```bash
pnpm build
```

Locally preview production build:

```bash
pnpm preview
```

Check out the [deployment documentation](https://nuxt.com/docs/getting-started/deployment) for more information.
# IndoorNav
UTDesign EPICS: Indoor Navigator

## Native apps (Capacitor)

The web app is wrapped as native iOS and Android apps with [Capacitor](https://capacitorjs.com/docs). Nuxt runs as a client-only SPA (`ssr: false` in `nuxt.config.ts`), `nuxt generate` writes a static bundle to `.output/public`, and Capacitor copies that bundle into the native projects in `ios/` and `android/`.

| File | Purpose |
| :--- | :--- |
| `capacitor.config.ts` | App ID (`edu.utdallas.epics.indoornav`), display name, web asset directory |
| `ios/` | Xcode project (Swift Package Manager, no CocoaPods needed) |
| `android/` | Android Studio / Gradle project |

### Prerequisites

- **iOS:** macOS with Xcode (iOS 15+ deployment target).
- **Android:** Android Studio with an Android SDK, and JDK 21 (Android Studio's bundled JDK works).

### Scripts

| Command | What it does |
| :--- | :--- |
| `pnpm cap:sync` | Build the web app and copy it + plugins into both native projects |
| `pnpm cap:ios` | Build, sync, and open the project in Xcode |
| `pnpm cap:android` | Build, sync, and open the project in Android Studio |
| `pnpm cap:run:ios` | Build and run on a chosen iOS simulator/device |
| `pnpm cap:run:android` | Build and run on a chosen Android emulator/device |

Run `pnpm cap:sync` after any web change you want to see in the native apps — the copied web assets in `ios/App/App/public` and `android/app/src/main/assets/public` are gitignored and regenerated each sync. Running an app on a physical iOS device requires selecting a signing team in Xcode (App target → Signing & Capabilities).

### Live reload

To have the native app load the Nuxt dev server instead of the bundled files:

```bash
pnpm dev --host                 # serve on your LAN
CAP_SERVER_URL=http://<your-LAN-IP>:3000 pnpm exec cap run ios   # or android
```

Run a normal `pnpm cap:sync` (without `CAP_SERVER_URL`) before building a release, otherwise the app will point at your dev machine.

### Adding native features

Install a Capacitor plugin (e.g. `pnpm add @capacitor/geolocation`), then `pnpm cap:sync`. Plugins that need permissions also require entries in `ios/App/App/Info.plist` and `android/app/src/main/AndroidManifest.xml` — see each plugin's docs.
