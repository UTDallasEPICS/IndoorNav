# Location module

Finds the user's position on-device from BLE beacons (indoors) and GPS (outdoors), and emits one
smoothed stream of `LocationFix`es for the map UI and routing. Nothing here talks to a server (C02).

```ts
import { createDeviceLocationService } from '~/utils/location/LocationService'

const location = createDeviceLocationService({ ble: { estimator: 'leastSquares' } })
const unsubscribe = location.subscribe((fix) => { /* fix.enu, fix.floorId, fix.accuracyM, ... */ })
location.onEvent((event) => { /* floorChanged, buildingEntered, ... */ })
location.onStatus((status) => { /* e.g. { provider: 'ble', state: 'permission-denied' } */ })
await location.start(venue)
// later: unsubscribe(); await location.stop()
```

`LocationService.ts` is the only file the app should import. Everything else is internal.

> Nuxt auto-imports only top-level files in `app/utils/`, so nothing in this folder is auto-imported.
> Import it explicitly as above. Don't add an `index.ts` here.

## Coordinate model

| Frame | Units | Used for |
| --- | --- | --- |
| **WGS84** `{ lat, lon, h }` | degrees, meters above the *ellipsoid* | Canonical. Venue origin, building footprints, GPS. |
| **ECEF** `{ x, y, z }` | meters | Only as a step between WGS84 and ENU. |
| **ENU** `{ e, n, u }` | meters east / north / up of the venue origin | The working frame. Beacons, fusion, every emitted fix. |
| **Plan** `{ x, y }` | pixels or grid cells, x right, y **down** | Floor plan images and the pathfinding grid. |

- `VenueConfig.origin` anchors ENU. Pick one point per campus and never move it, or every stored ENU
  coordinate shifts.
- Each floor has a `FloorTransform`: plan point (0, 0) sits at ENU `origin`, plan units are scaled by
  `scale` meters, and the plan is rotated so its "up" points at compass bearing `rotationDeg`
  (0 = north-up). `floorZ` is the floor's ENU height. Use `planToEnu` and `enuToPlan` in `geo/floorTransform.ts`.
- The rest of the repo stores map positions as **fractions (0–1)** of the SVG's width and height
  (see CLAUDE.md). To go between that and plan units, multiply or divide by the plan's size in pixels
  or cells, e.g. `{ x: fx * 226, y: fy * 478 }` for the SPN1 grid. *This assumes the grid and SVG cover
  the same frame. Confirm with Bao.*
- Every fix has `enu` + `floorId` (null outdoors) + `wgs84`. `accuracyM` is roughly a 1-sigma horizontal
  radius. Headings are degrees clockwise from **true** north.

## Data flow

```
CapacitorBleScanner ─ BeaconAdvert ─► BleProvider
                                        RssiFilterBank (median → 1D Kalman, stale eviction)
                                        voteFloor (strongest beacons vote)
                                        rssiToDistance (log-distance path loss)
                                        estimator: weightedCentroid | leastSquares
                                        └─► LocationFix (source 'ble') ─┐
CapacitorGpsSource ─ GpsReading ─► GpsProvider ─► LocationFix ('gps') ─┤
                                                                       ▼
                                        FusionEngine
                                          IndoorOutdoorDetector (footprint + BLE heard + GPS quality,
                                                                 2-of-3 vote, 3 s hysteresis)
                                          indoors: BLE drives position (GPS only if no beacons heard)
                                          outdoors: GPS drives position
                                          ConstantVelocityKalman (accuracy-weighted)
                                          └─► LocationFix ('fused') + LocationEvents
                                                                       ▼
                                        LocationService ─► app (subscribe / currentFix / status)
```

| Folder | Contents | Capacitor imports? |
| --- | --- | --- |
| `types.ts`, `emitter.ts`, `venue.ts` | Shared types, a tiny event emitter, venue lookup tables | no |
| `geo/` | WGS84/ECEF/ENU, floor plan ↔ ENU, point-in-polygon | no |
| `providers/ble/` | Scanner interface + mock, Eddystone parsing, RSSI filter, path loss, estimators, floor vote, `BleProvider` | only `capacitorScanner.ts` |
| `providers/gps/` | GPS source interface + mock, `GpsProvider` | only `capacitorGpsSource.ts` |
| `fusion/` | Kalman filter, indoor/outdoor detector, `FusionEngine` | no |
| `sim/` | Synthetic RSSI/GPS generator, pipeline runner, error report | no |
| `fixtures/` | **Placeholder** sample venue (1 building, 2 floors, 12 beacons) and walk | no |

## Configuration you'll tune

- `BleProvider` options: `estimator`, `updateIntervalMs` (1 s), `staleAfterMs` (4 s), `floorVoteTopN`,
  `phoneHeightM`, and the RSSI filter (`medianWindow`, `processNoise`, `measurementNoise`).
- Per beacon: `txPower` (RSSI at 1 m) and `pathLossExponent`. Calibrate these in the building: stand 1 m
  from an AP for `txPower`, then fit the exponent from readings at known distances.
- `FusionEngine` options: Kalman `accelerationNoise`, indoor/outdoor `switchAfterMs`, `gpsGoodAccuracyM`.

## Adding a provider (e.g. the Mist SDK, or PDR)

1. Put platform calls behind a small interface with a mock, like `BleScanner` / `MockBleScanner`.
   Only the Capacitor implementation file may import a plugin.
2. Write a class implementing `LocationProvider` (`providers/LocationProvider.ts`). It converts readings
   to `LocationFix`es in ENU with the right `source` and emits status (`starting`, `running`,
   `permission-denied`, ...) instead of throwing.
3. Add its id to `ProviderId` in `types.ts` and pass it to `new LocationService({ providers: [...] })`
   (or to `createDeviceLocationService`).
4. Decide how `FusionEngine.ingest` should use it. `'mist'` fixes are already treated like BLE.
   PDR is a relative move, not a position. See the `EXTENSION POINT (PDR)` comment in
   `fusion/FusionEngine.ts`. A particle filter can replace the Kalman filter by implementing
   `PositionFilter` (`EXTENSION POINT (particle filter)` in `fusion/kalman.ts`).
5. Add tests using the mock and, if relevant, extend `sim/` to generate its readings.

## Running the simulator

- **Tests (Node):** `pnpm test` runs every `*.test.ts` under `app/`, including an end-to-end walk
  (outside → Level 1 → stairs → Level 2) for both estimators. `ppnpm test:watch` re-runs on save.
- **Browser:** `pnpm dev`, then open <http://localhost:3000/dev/location-sim>. It plots the truth,
  raw BLE fixes and fused fixes, and shows the mean / p50 / p90 error table. You can change the estimator,
  RSSI noise and seed.
- **In code:**
  ```ts
  const { report, bleReport, events } = await runSimulation({ venue, path, sim: { rssiNoiseDb: 6 }, ble: { estimator: 'weightedCentroid' } })
  ```

The simulator uses the same path-loss model as the estimator (plus a small exponent mismatch, floor and
wall losses, and Gaussian noise), so it's **optimistic**. Real walls, bodies and multipath make things worse.
Use it to catch regressions and compare settings, not to predict real accuracy. That needs walking tests
in SPN1 (see the CSV/checkpoint success criterion in CLAUDE.md).

## Known limits / things to verify

- **iOS BLE:** scanning only works in the foreground with the Eddystone service UUID filter. iOS hides
  iBeacon frames from CoreBluetooth, so we rely on the APs' **Eddystone-UID** frames. In the background,
  iOS coalesces duplicate adverts, so updates become slow. Not tested on a device yet.
- **Beacon IDs:** we key beacons by Eddystone namespace + instance. We need OIT/Mist to confirm these IDs
  are stable per AP (not rotated or re-provisioned), and to give us each AP's position.
- **GPS altitude:** iOS reports height above sea level, Android above the ellipsoid. That's a ~25 m
  difference here, so fused fixes ignore GPS height (u = floorZ indoors, 0 outdoors).
- **Heading** comes from the GPS course or the fused velocity only. Compass/magnetometer heading is the
  Direction workstream's job.
