// Core module: the one interface the UI uses for location and routing (System integration, R04).
// It runs the location module, keeps the latest position as reactive state, and routes between map positions.
// Everything stays on the phone (C02).

import { Capacitor } from '@capacitor/core'
import { readonly, ref } from 'vue'
import { listBeacons } from '~/db/beacons'
import { listFloors } from '~/db/floors'
import { GRID_BOUNDS } from '#shared/grid-map'
import { createFileDebugLog, type FileDebugLog } from '~/utils/location/debug/capacitorFileLog'
import { clearOpenAreas, openAreaOutlines, type RoomRecord } from '~/utils/location/fusion/openAreas'
import { createDeviceLocationService, requestMotionPermission, spnVenue, withFloorGrids, withStoredBeacons, withStoredFloors, type BarometerReading, type LocationService, type MapPosition, type ProviderStatus } from '~/utils/location/LocationService'
import { loadRouteGrid, routeBetween } from '~/utils/route-between'

export type { MapPosition }

type MapPoint = { x: number, y: number, floor: number } // fractions (0–1) of that floor's map, like the rooms' x/y

/** Floors with a route grid (public/data/SPN.txt and SPN-level2.txt) */
const ROUTABLE_FLOORS = [1, 2]

/** Floors whose route grid also keeps the location dot out of walls (particle filter) */
const WALL_CONSTRAINED_FLOORS = [1, 2]

/**
 * Rooms whose desks and cubicles the grid draws as walls, cleared for the location dot (not for routing) so it
 * moves freely inside them; their own walls stay. Without this, a recorded level 2 walk (2026-11-17) through the
 * open offices jumped over 1 m 51 times vs 31 with them cleared. Only rooms with a CAD outline can be cleared.
 */
const OPEN_AREA_NAMES = ['OPEN OFFICE']

/** A position older than this is dropped, so the dot doesn't sit still after we stop hearing beacons */
const STALE_AFTER_MS = 10_000

/** Scanning this long without a position (beacons gone, or never found) counts as lost: the map asks the user to set it */
const LOST_AFTER_MS = 60_000

// Shared by every component that calls useNavigation(), so there's only one BLE scan
const position = ref<MapPosition | null>(null)
const locationStatus = ref<ProviderStatus['state']>('idle')
const locationMessage = ref('')
const locationLost = ref(false)
// Barometer floor tracking, for the map's test readout. Null reading = no samples yet
const barometerStatus = ref<ProviderStatus['state']>('idle')
const barometerMessage = ref('')
const barometerReading = ref<BarometerReading | null>(null)
// Location debug log (NUXT_PUBLIC_LOCATION_DEBUG_LOG): the file this run writes to, or null when off
const debugLogFile = ref<string | null>(null)
let debugLog: FileDebugLog | null = null
let lastHeardAt = 0 // when we last had a position, or when scanning started
let service: LocationService | null = null
let staleTimer: ReturnType<typeof setInterval> | null = null
let users = 0

export function useNavigation() {
  /** Starts BLE positioning, aided by steps + compass (a no-op off-device). Call it from a user tap. Failures show up in locationStatus, not as errors. */
  async function startLocation() {
    users++
    if (service) return
    if (!Capacitor.isNativePlatform()) { // desktop browsers have no BLE we're allowed to use (no Web Bluetooth, C01)
      locationStatus.value = 'unavailable'
      locationMessage.value = 'Live location only works in the iOS/Android app.'
      return
    }
    // Step + compass tracking smooths the dot. iOS only asks for motion permission during the user's tap,
    // so ask now, before the awaits below; the PDR provider reads the answer when it starts.
    void requestMotionPermission()

    // Debug builds can record every sensor input and filter decision to a file on the phone (stays on it, C02)
    if (isDebugLogOn()) {
      debugLog = createFileDebugLog()
      debugLogFile.value = debugLog.path
    }

    // GPS is off: it was removed from the map page and doesn't help inside SPN1
    const created = createDeviceLocationService({ gps: false, ...(debugLog && { debugLog: debugLog.log }) })
    service = created
    created.onStatus(status => {
      if (status.provider === 'barometer') {
        barometerStatus.value = status.state
        barometerMessage.value = status.message ?? ''
        return
      }
      // Only BLE decides whether there's a live location; without motion sensors it still works, just less smoothly
      if (status.provider !== 'ble') return
      if (status.state === 'running' && locationStatus.value !== 'running') lastHeardAt = Date.now()
      locationStatus.value = status.state
      locationMessage.value = status.message ?? ''
    })
    created.subscribeBarometer(reading => { barometerReading.value = reading })
    created.subscribePosition(p => {
      position.value = p
      lastHeardAt = Date.now()
      locationLost.value = false
    })
    staleTimer = setInterval(() => {
      if (position.value && Date.now() - position.value.timestamp > STALE_AFTER_MS) position.value = null
      // Only while BLE is scanning: if it's unavailable or denied, the sheet already says so
      locationLost.value = locationStatus.value === 'running' && Date.now() - lastHeardAt > LOST_AFTER_MS
    }, 1000)

    // Floor heights (for the barometer), beacon positions and path-loss fits come from the on-device database.
    // Floors first: beacon heights are worked out from them.
    let venue
    try {
      const db = await useDb()
      venue = withStoredBeacons(withStoredFloors(spnVenue, await listFloors(db)), await listBeacons(db))
      // The route grids of WALL_CONSTRAINED_FLOORS also keep the dot out of walls. A floor whose grid fails to load
      // just isn't constrained.
      const grids = await Promise.all(WALL_CONSTRAINED_FLOORS.map(floor => loadWallGrid(floor).catch(() => null)))
      venue = withFloorGrids(venue, Object.fromEntries(grids.filter(g => g !== null)))
    } catch (err) {
      if (service === created) {
        locationStatus.value = 'error'
        locationMessage.value = `Couldn't load beacon positions: ${err instanceof Error ? err.message : String(err)}`
      }
      return
    }
    if (service !== created) return // stopped while the database was loading
    if (!venue.beacons.length) {
      locationStatus.value = 'unavailable'
      locationMessage.value = 'No surveyed beacons for this building yet.'
      return
    }
    await created.start(venue)
  }

  /** Stops positioning once the last component that started it stops it. */
  async function stopLocation() {
    users = Math.max(0, users - 1)
    if (users || !service) return
    const stopping = service
    service = null
    if (staleTimer) clearInterval(staleTimer)
    staleTimer = null
    position.value = null
    locationLost.value = false
    locationStatus.value = 'idle'
    barometerStatus.value = 'idle'
    barometerMessage.value = ''
    barometerReading.value = null
    await stopping.stop()
    if (debugLog) {
      const closing = debugLog
      debugLog = null
      debugLogFile.value = null
      await closing.log.close()
    }
  }

  function canRoute(start: MapPoint, destination: MapPoint) {
    return start.floor === destination.floor && ROUTABLE_FLOORS.includes(start.floor)
  }

  /** Route as map positions, start to destination. Throws an Error with a message to show the user. */
  async function routeTo(start: MapPoint, destination: MapPoint) {
    if (!canRoute(start, destination)) throw new Error("Routes between floors aren't available yet.")
    return routeBetween(start, destination, start.floor)
  }

  return {
    position: readonly(position), // live MapPosition { x, y, floor, accuracyM, timestamp }, or null
    locationStatus: readonly(locationStatus),
    locationMessage: readonly(locationMessage),
    locationLost: readonly(locationLost), // true after LOST_AFTER_MS of scanning with no position
    barometerStatus: readonly(barometerStatus),
    barometerMessage: readonly(barometerMessage),
    barometerReading: readonly(barometerReading), // pressure, height, barometer floor vs BLE vote; null before the first sample
    debugLogFile: readonly(debugLogFile), // file the location debug log is writing to, or null when it's off
    startLocation,
    stopLocation,
    canRoute,
    routeTo
  }
}

/** A floor's route grid for the location dot: the routing grid with open-plan rooms (OPEN_AREA_NAMES) cleared. */
async function loadWallGrid(floor: number) {
  const bounds = GRID_BOUNDS[floor as keyof typeof GRID_BOUNDS]
  const grid = await loadRouteGrid(floor)
  let rooms: RoomRecord[] = []
  try {
    rooms = await $fetch<RoomRecord[]>(`/maps/spn-level${floor}-rooms.json`)
  } catch (err) {
    console.warn(`Level ${floor} rooms didn't load, so its open offices keep their furniture as walls:`, err)
  }
  const { outlines, missing } = openAreaOutlines(rooms, OPEN_AREA_NAMES)
  if (missing.length) console.warn(`Level ${floor} open areas without an outline (furniture kept as walls): ${missing.join(', ')}`)
  return [floor, { grid: outlines.length ? clearOpenAreas(grid, bounds, outlines) : grid, bounds }] as const
}

/** Whether this build records the location debug log (nuxt.config.ts: runtimeConfig.public.locationDebugLog) */
function isDebugLogOn() {
  const value: unknown = useRuntimeConfig().public.locationDebugLog
  return value === true || value === 'true' || value === '1'
}
