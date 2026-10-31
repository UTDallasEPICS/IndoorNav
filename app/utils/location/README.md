# Location module

Finds the user's position on-device from BLE beacons (indoors) and GPS (outdoors), steadied by step + compass
tracking (PDR), and emits one smoothed stream of `LocationFix`es for the map UI and routing. Nothing here talks to a server (C02).

The app reaches it through the core module, `app/composables/useNavigation.ts` (`position`, `startLocation`,
`routeTo`, ...). To use the service directly:

```ts
import { createDeviceLocationService, spnVenue } from '~/utils/location/LocationService'

const location = createDeviceLocationService({ gps: false })
const unsubscribe = location.subscribePosition((p) => { /* p.x, p.y (map fractions), p.floor, p.accuracyM */ })
location.subscribe((fix) => { /* raw fused fix: fix.enu, fix.floorId, fix.accuracyM, ... */ })
location.onEvent((event) => { /* floorChanged, buildingEntered, ... */ })
location.onStatus((status) => { /* e.g. { provider: 'ble', state: 'permission-denied' } */ })
await location.start(spnVenue)
// later: unsubscribe(); await location.stop()
```

`LocationService.ts` is the only file the app should import (it re-exports the types and `spnVenue`).
Everything else is internal.

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
  (see CLAUDE.md). A floor's optional `plan: { width, height }` is the SVG's size in plan units;
  `toMapPosition` (`mapPosition.ts`) divides by it to turn a fused fix into a `MapPosition`
  `{ x, y, floor, accuracyM, timestamp }`. Floors without `plan` produce no `MapPosition`.
- **SPN1** (`venues/spn.ts`): plan units are map widths (the plan is 1 × 0.457867). The level 1 transform
  is fitted (`geo/georef.ts`) from three satellite-surveyed corners: 0.76 m RMS, map ≈ 126 m wide,
  map "up" ≈ east. Level 2 (plan 1 × 0.399778, its own SVG frame) is fitted by image registration
  (`venues/spn.ts`, ~1 m); its floor height (4.27 m) is assumed, which doesn't affect 2D positions.
  The `beacons` list is empty in code: see **Beacon data** below.
- Every fix has `enu` + `floorId` (null outdoors) + `wgs84`. `accuracyM` is roughly a 1-sigma horizontal
  radius. Headings are degrees clockwise from **true** north.

## Beacon data

Beacon positions and path-loss fits live in the on-device SQLite database (`beacons` table, `app/db/schema.ts`),
stored as **WGS84 lat/lon**, never in a survey's local frame. They come from bSLAM survey exports bundled in
`public/data/surveys/` and imported on first launch by `app/db/seed.ts` → `importBeaconSurvey` (`app/db/beacons.ts`).

- `useNavigation` reads them with `listBeacons(db)` and passes them through `withStoredBeacons(spnVenue, rows)`
  (`beaconRegistry.ts`), which converts lat/lon to ENU and keeps only trusted beacons: `manual`, `good`, `fair`.
  `ambiguous`, `poor` and `insufficient` rows are stored but not used (`BeaconRegistryOptions.statuses`).
- **vBLE:** each Mist AP sends one Eddystone instance per beam of its vBLE array. Surveys exported with
  `group_virtual_beacons` store one row per AP, with the beam digit of the instance replaced by `*`
  (`41021*e40000`). `indexVenue(...).resolveBeaconId` maps every scanned beam onto that row, so an AP's beams feed
  one RSSI filter and count once in trilateration. Don't import an ungrouped export: each beam would be placed as
  its own beacon a few meters from the AP.
- Each beacon's `txPower` / `pathLossExponent` are the survey's fitted values. Its mounting height is
  `floorZ + phoneHeightM + height_offset_m`, the beacon-to-phone height the survey's fit assumed.
- **Adding a survey:** copy the export's `*_beacons_*.csv` and `*_floor_*.json` into `public/data/surveys/` as
  `<building>-level<N>-beacons-<stamp>.csv` / `-floor-<stamp>.json`, and append it to `surveys` in `seed.ts`
  (oldest first). Devices import it on next launch. A later survey overwrites a beacon's data, but a survey that
  couldn't place a beacon doesn't erase an earlier position. Each survey also hears APs on the floors above and
  below; an AP in surveys of different floors stays on the floor whose survey heard it strongest (max RSSI). To replace a survey, swap it out of `surveys`: on next launch
  the seed deletes surveys no longer listed and the beacons they last set (`removeStaleSurveys`).
- **Check the export's georeference** before adding it. The level 1 exports (2026-10-21 through 2026-10-30) have it wrong (image-right
  set to east; it's south), so `seed.ts` overrides it with `geo`, fitted from room labels matched between the
  survey's floorplan image and the map SVG. Level 2's export also has a ~4% scale error, corrected with
  `geo.scale`. `beacons.test.ts` fails if surveyed beacons fall off the map.

## Data flow

```
CapacitorBleScanner ─ BeaconAdvert ─► BleProvider
                                        RssiFilterBank (median → 1D Kalman, stale eviction)
                                        voteFloor (strongest beacons vote)
                                        rssiToDistance (log-distance path loss)
                                        estimator: weightedCentroid | leastSquares
                                        └─► LocationFix (source 'ble') ─┐
CapacitorGpsSource ─ GpsReading ─► GpsProvider ─► LocationFix ('gps') ─┤
CapacitorMotionSource ─ accel + compass ─► PdrProvider                  │
                                             StepDetector (|a| bumps, Weinberg step length)
                                             HeadingSmoother (+ magnetic declination → true north)
                                             └─► PdrStep + MotionState ─┤
                                                                       ▼
                                        FusionEngine
                                          IndoorOutdoorDetector (footprint + BLE heard + GPS quality,
                                                                 2-of-3 vote, 3 s hysteresis)
                                          indoors: BLE drives position (GPS only if no beacons heard)
                                          outdoors: GPS drives position
                                          motion sensors running: StepKalman (steps move, BLE corrects)
                                          otherwise:              ConstantVelocityKalman (accuracy-weighted)
                                          └─► LocationFix ('fused') + LocationEvents
                                                                       ▼
                                        LocationService ─► app (subscribe / currentFix / status)
```

| Folder | Contents | Capacitor imports? |
| --- | --- | --- |
| `types.ts`, `emitter.ts`, `venue.ts` | Shared types, a tiny event emitter, venue lookup tables | no |
| `beaconRegistry.ts` | Stored (WGS84) beacons → `BeaconRegistryEntry` (ENU) | no |
| `geo/` | WGS84/ECEF/ENU, floor plan ↔ ENU, point-in-polygon | no |
| `providers/ble/` | Scanner interface + mock, Eddystone parsing, RSSI filter, path loss, estimators, floor vote, `BleProvider` | only `capacitorScanner.ts` |
| `providers/gps/` | GPS source interface + mock, `GpsProvider` | only `capacitorGpsSource.ts` |
| `providers/pdr/` | Motion source interface + mock, step detector, compass heading, `PdrProvider` | only `capacitorMotionSource.ts` |
| `fusion/` | Kalman filter, indoor/outdoor detector, `FusionEngine` | no |
| `sim/` | Synthetic RSSI/GPS generator, pipeline runner, error report | no |
| `fixtures/` | **Placeholder** sample venue (1 building, 2 floors, 12 beacons) and walk | no |

## Configuration you'll tune

- `BleProvider` options: `estimator`, `updateIntervalMs` (1 s), `staleAfterMs` (4 s), `floorVoteTopN`,
  `phoneHeightM`, and the RSSI filter (`medianWindow`, `processNoise`, `measurementNoise`).
- Per beacon: `txPower` (RSSI at 1 m) and `pathLossExponent` come from the survey fit (see **Beacon data**).
  Re-survey to recalibrate; beacons without a fit use `DEFAULT_BEACON_REGISTRY_OPTIONS`.
- `FusionEngine` options: Kalman `accelerationNoise`, indoor/outdoor `switchAfterMs`, `gpsGoodAccuracyM`.
- `StepKalman` (`fusion/stepKalman.ts`): `stationaryMeasurementScale` and `stationaryNoise` (how hard the dot holds
  still while you stand), `movingNoise`, `gateChi2` / `relocalizeAfter` (outlier rejection).
- `PdrProvider` options: step `thresholdMs2` / `weinbergK`, `headingSmoothingMs`, `defaultHeadingAccuracyDeg`.

## Smoothing with steps and compass (PDR)

While the accelerometer and compass run, `FusionEngine` switches from the constant-velocity filter to `StepKalman`:

- **Steps move the dot.** Each detected step moves the estimate by its length along the compass heading, so the dot
  advances step by step between BLE fixes instead of waiting for (and lagging behind) them.
- **BLE corrects, it doesn't drive.** Between steps the estimate barely drifts, so a noisy BLE fix only nudges it.
  Each step adds uncertainty mostly *across* the walking direction (heading error), so BLE fixes pull hardest
  sideways, where PDR is weakest.
- **Standing still averages.** With no steps, BLE fixes are down-weighted (`stationaryMeasurementScale`) and the
  random walk is tiny, so the estimate becomes a running average of every fix since you stopped. In the simulator
  this takes standing jitter from ~2.4 m to ~0.2 m per second.
- **Outliers are dropped.** A BLE fix far outside the filter's uncertainty is ignored. If `relocalizeAfter` fixes
  in a row disagree, the filter assumes it's lost (missed steps, bad compass) and restarts at their average.
- The heading arrow follows the compass (a few updates a second), not the velocity. Indoors the compass can be off
  by tens of degrees near steel; it's treated as a soft signal (`defaultHeadingAccuracyDeg`, 20°), and BLE pulls
  the track back when it drifts.
- If motion permission is denied or the sensors go quiet for 2 s, fusion falls back to the BLE-only filter.

PDR assumes the phone is held in front, roughly pointing the way you walk. A phone in a pocket still counts steps,
but its compass heading is wrong; the gate + relocalize logic limits the damage. iOS asks for motion permission,
which must happen during a tap: `useNavigation().startLocation()` calls `requestMotionPermission()` first thing.

## Adding a provider (e.g. the Mist SDK)

1. Put platform calls behind a small interface with a mock, like `BleScanner` / `MockBleScanner`.
   Only the Capacitor implementation file may import a plugin.
2. Write a class implementing `LocationProvider` (`providers/LocationProvider.ts`). It converts readings
   to `LocationFix`es in ENU with the right `source` and emits status (`starting`, `running`,
   `permission-denied`, ...) instead of throwing.
3. Add its id to `ProviderId` in `types.ts` and pass it to `new LocationService({ providers: [...] })`
   (or to `createDeviceLocationService`).
4. Decide how `FusionEngine.ingest` should use it. `'mist'` fixes are already treated like BLE.
   Relative inputs (like PDR) go through their own methods (`ingestStep`, `ingestMotion`). A particle filter can replace the Kalman filter by implementing
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
- **Heading** comes from the compass while the motion sensors run, otherwise from the GPS course or the fused
  velocity. Not yet checked on a device: compass accuracy inside SPN1, Android `deviceorientationabsolute` in the
  WebView, and step detection thresholds for different phones/gaits.
- **Walls:** nothing yet stops the dot from crossing a wall. A particle filter on the route grid
  (`EXTENSION POINT (particle filter)`) is the natural next step.
