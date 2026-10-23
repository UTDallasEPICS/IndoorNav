# CLAUDE.md — Indoor Navigation (UTDesign EPICS, Fall 2026)

Guidance for AI agents working in this repo. Derived from the team's Project Brief, Project Plan, and ADR.
Use the checklists below to track progress: check an item off (`- [x]`) only when its "done when" condition
has been verified, and add a short note (date, commit/PR, or test evidence) next to it.

## What we're building

A mobile app that finds a user's position inside **SPN1 (Synergy Park North, building 1)**, takes a destination
room, and gives live turn-by-turn directions there. MVP is due by the **first week of December** (EPICS Expo).

Team / owners: Andrew Mills (location, team lead) · Ash Tichenor (pathfinding) · Bao Pham (map generation) ·
Samuel Rodriguez (system integration, floor change) · Sneha Lal (UI/UX). Mentor: Amulya. Sponsor contact: Vlad.

## Architecture

### Platform and frameworks

| Layer | Choice | Why |
| --- | --- | --- |
| UI framework | **Nuxt 4 / Vue 3** (`<script setup>`), no component library | Team familiarity; small, fast UI. Styles are hand-written CSS using tokens in `app/assets/css/main.css`. |
| Rendering mode | **Client-only SPA** (`ssr: false` in `nuxt.config.ts`) | `nuxt generate` emits a static bundle the phone loads locally — there is no Node server in the app. Don't add SSR, server routes, or `server/api` endpoints the app depends on. |
| Native wrapper | **Capacitor 8** (`capacitor.config.ts`, app ID `edu.utdallas.epics.indoornav`) | A plain PWA can't scan BLE on iOS (Safari has no Web Bluetooth; Chrome's scan API is behind a flag) and has no reliable barometer. Capacitor gives native BLE and sensor access with one web codebase for iOS + Android (C01). |
| Native access | **Capacitor plugins only** | Install the plugin, run `pnpm cap:sync`, and add permissions to `ios/App/App/Info.plist` and `android/app/src/main/AndroidManifest.xml`. Don't hand-write Swift/Java unless no plugin exists. |
| Language | TypeScript for new logic modules; existing pages use plain JS `<script setup>` | Match the file you're editing. |
| Floor plan tooling | **Python + ezdxf** (`scripts/cad-to-svg.py`), `dwg2dxf` from LibreDWG | Offline, free, scriptable for future buildings. |
| Backend | **None at runtime** (`server/main.py` is a placeholder) | Location stays on the phone (C02) and there's no hosting budget. Any server is for offline tooling only. |
| Storage | Bundled JSON in `public/`; on-device SQLite planned (Project Plan) | Data stays local. No cloud database. |

### Map data pipeline (offline, run by developers)

```
cad-source/SPN-level-1.dwg   (private, gitignored — never commit)
  └─ dwg2dxf ─► .dxf
       └─ scripts/cad-to-svg.py ─► public/maps/spn-level1.svg        (only navigation layers: walls, doors, stairs, glass, room labels)
                                └► public/maps/spn-level1-rooms.json  ([{ number, name, x, y }])
public/data/SPN.txt                544 × 848 grid of 0/1 cells (0 = open, 1 = wall) that the app routes on (Map generation workstream)
public/data/spn-level1-grid.json   226 × 478 matrix, not used by the app (ask Bao before relying on or deleting it)
```

- **Coordinate convention:** map positions are **fractions (0–1) of the SVG's width and height, measured from the
  top-left** (CAD y points up, SVG y points down — the script flips it). Store every position (rooms, beacons, user
  location, route points) in this form, and convert to grid cells or screen pixels only at the edges.
- Room numbers aren't unique (e.g. several `1.1` corridors/lobbies); match rooms by number **and** name.
- To add a floor or building, extend the pipeline (one SVG + rooms JSON + grid per floor) rather than hand-editing
  output files. Name files `<building>-level<N>-*.{svg,json}`.
- `SPN.txt` doesn't share the SVG's frame: `GRID_BOUNDS` in `shared/grid-map.js` gives the grid rows/columns where
  the map's 0–1 edges fall. Re-fit it if `SPN.txt` or the SVG is regenerated. `scripts/navigation.py` (the Python
  reference A\*) reads the same file.

### Runtime pipeline (target design, per the ADR)

```
BLE scan (Eddystone-UID from Mist AP43s) ──► RSSI → distance ──► trilateration ──┐
Accelerometer (step detection) + compass (heading) ──► PDR (dead reckoning) ─────┤
                                                                                 ▼
                                    fusion + smoothing (reject impossible moves, e.g. through walls)
                                                                                 ▼
                                    snap to walkable grid cell ──► A* to destination cell
                                                                                 ▼
                                    simplify path → straight segments + turns ──► map UI (blue dot, route, directions)
```

- **Location (Andrew):** BLE is the absolute fix; PDR fills in between scans. Beacon positions live in a JSON keyed
  by Eddystone namespace + instance ID, in the shared fractional coordinates. Target: < 4 m error, updates within 2 s (R01).
- **Heading / smoothing (Samuel, Andrew):** accelerometer + magnetometer; no gyroscope dependency. Expect magnetic
  interference indoors — treat heading as a soft signal, not ground truth.
- **Routing (Ash):** A\* on the grid with an admissible heuristic (Euclidean/octile). Must stay < 2 s on a phone and
  return an optimal path. Path → directions conversion is a separate step.
- **Floor change (Samuel):** barometer via a native plugin where available; fall back gracefully on phones without one.
- **Manual fallback:** the "Set Your Location" step in `app/pages/map.vue` (drag the map under a fixed marker) must
  keep working when BLE is unavailable or permission is denied.

### Code organization

- `app/pages/index.vue` — landing page. `app/pages/map.vue` — map viewer (pan/pinch/zoom, location pick, destination
  search, destination pin). `app/components/` — shared components. `app/app.vue` — phone-width shell.
- Keep sensor, positioning, and pathfinding logic **out of page components**: put pure logic in `app/utils/`
  (e.g. `astar.ts`, `trilateration.ts`, `pdr.ts`) and stateful/native wiring in `app/composables/`
  (e.g. `useBeacons.ts`, `useHeading.ts`, `usePosition.ts`). Pure modules should be testable without a device.
- `android/`, `ios/` — Capacitor native projects. Edit only for permissions, signing, or plugin config;
  `ios/App/App/public` and `android/app/src/main/assets/public` are generated by `cap sync`.

### Commands

```bash
pnpm dev                 # web dev server at localhost:3000 (map UI works; no BLE/sensors in a desktop browser)
pnpm generate            # static build to .output/public
pnpm cap:sync            # build + copy web bundle and plugins into ios/ and android/
pnpm cap:ios             # build, sync, open Xcode
pnpm cap:android         # build, sync, open Android Studio
pnpm cap:run:ios         # build and run on a simulator/device (also cap:run:android)

# Live reload on a phone: serve on LAN, then point the app at it
pnpm dev --host
CAP_SERVER_URL=http://<LAN-IP>:3000 pnpm exec cap run ios   # run plain cap:sync before any release build
```

BLE and motion sensors must be tested on **physical iOS and Android devices** — simulators and desktop browsers
don't provide them.

## Rules for agents

1. **Trace work to requirement IDs** (C01, C02, R01–R04 below). Mention the ID in commit messages/PR descriptions.
2. **Don't reopen settled decisions.** The ADR decisions below are final until a new ADR supersedes them. If you think
   one is wrong, say so and propose a new ADR — don't silently implement an eliminated option.
3. **Everything must work on both iOS and Android (C01).** Don't use Web Bluetooth, iOS-only (LIDAR), or
   Android-only (client-side Wi-Fi scanning) APIs. Use Capacitor plugins for native sensors and BLE.
4. **Location data stays on the device (C02).** No sending positions to remote servers, analytics, or logs that leave
   the phone. The plan specifies local storage (SQLite) only.
5. **Never commit raw CAD/DWG floor plan source files** — they're confidential. Derived maps in `public/` are OK.
6. **No recurring-cost services or new hardware** — the sponsor has no budget.
7. Requirements live in [requirements.md](requirements.md). Update that file (and its change log) instead of creating
   a separate requirements list.
8. Ask before guessing on anything listed under **Open questions**.

## Requirements baseline (from Project Brief)

- [ ] **C01 Compatibility** — All features work on both iOS and Android.
- [ ] **C02 Safety** — User location data can't be accessed by unauthorized parties.
- [ ] **R01 Functional** — While navigating, the displayed room matches the user's real room within 2 s of a change.
- [ ] **R02 Functional** — App runs from any SPN1 room and displays a full route to any other SPN1 room.
- [ ] **R03 Usability** — Testers pick the correct room on the first try ≥ 90% of the time on the smallest phone screen.
- [ ] **R04 Schedule** — MVP delivered by the first week of December.

## Engineering decisions (ADR, status: Proposed — mentor review: needs additional analysis)

| Area | Decision | Eliminated (and why) |
| --- | --- | --- |
| a. Location | **BLE beacons** — read Eddystone-UID frames from UTD's Mist AP43 access points; trilaterate, fused with PDR | Wi-Fi triangulation client-side (no iOS), router-side (no OIT access); LIDAR (Pro iPhones only); vSLAM (failed testing: hallways look alike) |
| b. Routing | **A\*** on the SPN1 grid (optimal paths, ~30–40 ms, ~10% faster than bidirectional BFS) | Greedy best-first (paths ~40% too long); Ant Colony (~400 ms, ~18–19% longer); Bidirectional BFS (slower) |
| c. Direction / smoothing | **Accelerometer + compass/magnetometer** | Gyroscope (not on every phone); vSLAM, BLE (depend on external factors) |

Decision drivers to respect:
- Location: accurate, updates frequently, no manual updates by the user, no hardware or recurring cost, iOS + Android.
- Routing: any-room-to-any-room in SPN1, route generation **< 2 s**, path length within **20%** of optimal.
- Direction: updates **at least once per second**, true heading within a **30° cone** of the prediction, and actually
  reduces location noise (e.g. reject "facing and walking into a wall" positions).
- Known tradeoffs: compass drift near ferrous building material; accelerometer drift over time; beacons may be replaced
  in 2–3 years (most replacement APs also have BLE, so ask OIT to keep it enabled).

## Workstream checklists

### Location detection — Andrew (C02, R01)
- [ ] Map each AP's Eddystone instance ID to a floor plan coordinate (from OIT, or by walking the building). *Due Oct 9*
- [ ] Get written non-objection from OIT for passive BLE reception. *Due Oct 16*
- [ ] Confirm a Capacitor BLE plugin reads advertisements on current iOS **and** Android devices.
- [ ] BLE trilateration prototype that outputs coordinates.
- [ ] Blue-dot tracking in the app with horizontal error **< 4 m** consistently. *Milestone: Oct 16*
- [ ] Noise reduction / position smoothing so the dot doesn't jump around.
- [ ] Monitor beacon namespace/instance IDs for changes on OIT's side.
- [ ] (Future-proofing) vSLAM locating reaches ≥ 60% of BLE precision in ideal conditions (no people around).

### Map generation — Bao (R02)
- [x] SPN1 level 1 grid matrix exists (`public/data/spn-level1-grid.json`) with floor SVG and room data.
- [ ] Get Vlad's floor-plan-to-matrix app source and confirm its output matches our schema. *Due Oct 1*
- [ ] Confirm floor plan revision and permission to show derived maps in a published app (with Ash). *Due Oct 8*
- [ ] SPN1 mapping complete: georeferenced to scale, rooms identified, no topology errors. *Milestone: Oct 8*
- [ ] Bulk script to convert a floor plan PDF into a navigable grid matrix (for future buildings).
- [ ] Cross-check map against SPN CAD files for accuracy.

### Pathfinding — Ash (R02)
- [ ] Standalone A\* script deployed for testing on mobile; runtime stays low on phones. *Due Oct 22*
- [ ] Route generation < 2 s and within 20% of minimum path length for any SPN1 room pair.
- [ ] Convert grid-cell paths into simple directions (straight segments and turns). *Due Nov 12*
- [ ] Step-by-step directions to the desired room work in the app. *Milestone: Oct 30*

### Direction / heading — Samuel, Andrew
- [ ] App shows the direction the user faces while walking correctly for ≥ 95% of trial time.
- [ ] Combined with location, the user's path is correct for > 90% of trials in open areas, > 95% in hallways.
- [ ] Turns and turnarounds are reflected within 1.5 s for > 90% of trials.

### System integration — Samuel (R04)
- [ ] Map, location, and pathfinding modules wired together behind one interface for the UI.
  - 2026-10-23: `app/composables/useNavigation.ts` wired into `map.vue` (live `MapPosition` + `routeTo`). Not yet
    verified on a device: needs SPN1 beacon entries in `app/utils/location/venues/spn.ts`.
- [ ] Floor change detection switches to the matching floor plan (barometer where available). *Milestone: Nov 13*
- [ ] Test plan running alongside development: multi-path routes, elevator/stairs, location updates while walking.

### Mobile interface — Sneha (C01, R03)
- [x] Nuxt SPA wrapped in Capacitor for iOS and Android.
- [ ] Map UI shows SPN1, user position, and the route (start/destination picking exists in `app/pages/map.vue`).
- [ ] "Create event" feature.
- [ ] Apple Developer / Google Play accounts and UTD authorization letter sorted for TestFlight / Play testing. *Due Nov 13*
- [ ] People outside the team can use the app to reach a room easily. *Milestone: Nov 27*

## Semester success criteria (Expo)

- [ ] Horizontal location error < 4 m for ≥ 90% of updates (CSV logging + checkpoint tests).
- [ ] Correct floor shown in > 90% of random trials when switching floors.
- [ ] Destination room correctly represented in 9 of 10 random trials.
- [ ] 9 of 10 Expo visitors are successfully navigated to their destination.

## Open questions (don't assume answers — ask the team)

- Can a Capacitor app reliably read BLE advertisements on users' phones (iOS background/foreground limits)?
- Will OIT share an AP/beacon inventory with locations, and keep beacons broadcasting?
- What accuracy does the sponsor need: correct room, correct hallway segment, or metric position?
- Is vertical routing in scope, and how do we detect floor changes on phones without barometers?
- How should routing handle card-access, locked, or after-hours spaces?
- Is accessible routing (elevators, ramps) required, and do we have the data?
- Custom map vs. licensed GIS (ArcGIS / Concept3D) from the UTD GIS office — decision was due Oct 1.
- Can device heading be made reliable enough for turn-by-turn cues?
- What's the fallback if OIT turns off the beacons?

Resolve an open question → move the answer into the relevant section above (or a new ADR) and delete it here.
