// Core module: the one interface the UI uses for location and routing (System integration, R04).
// It runs the location module, keeps the latest position as reactive state, and routes between map positions.
// Everything stays on the phone (C02).

import { Capacitor } from '@capacitor/core'
import { readonly, ref } from 'vue'
import { listBeacons } from '~/db/beacons'
import { createDeviceLocationService, requestMotionPermission, spnVenue, withStoredBeacons, type LocationService, type MapPosition, type ProviderStatus } from '~/utils/location/LocationService'
import { routeBetween } from '~/utils/route-between'

export type { MapPosition }

type MapPoint = { x: number, y: number, floor: number } // fractions (0–1) of that floor's map, like the rooms' x/y

/** Floors with a route grid (only public/data/SPN.txt, level 1, for now) */
const ROUTABLE_FLOORS = [1]

/** A position older than this is dropped, so the dot doesn't sit still after we stop hearing beacons */
const STALE_AFTER_MS = 10_000

/** Scanning this long without a position (beacons gone, or never found) counts as lost: the map asks the user to set it */
const LOST_AFTER_MS = 60_000

// Shared by every component that calls useNavigation(), so there's only one BLE scan
const position = ref<MapPosition | null>(null)
const locationStatus = ref<ProviderStatus['state']>('idle')
const locationMessage = ref('')
const locationLost = ref(false)
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

    // GPS is off: it was removed from the map page and doesn't help inside SPN1
    const created = createDeviceLocationService({ gps: false })
    service = created
    created.onStatus(status => {
      // Only BLE decides whether there's a live location; without motion sensors it still works, just less smoothly
      if (status.provider !== 'ble') return
      if (status.state === 'running' && locationStatus.value !== 'running') lastHeardAt = Date.now()
      locationStatus.value = status.state
      locationMessage.value = status.message ?? ''
    })
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

    // Beacon positions and path-loss fits come from the on-device database (the bSLAM survey import)
    let venue
    try {
      venue = withStoredBeacons(spnVenue, await listBeacons(await useDb()))
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
    await stopping.stop()
  }

  function canRoute(start: MapPoint, destination: MapPoint) {
    return start.floor === destination.floor && ROUTABLE_FLOORS.includes(start.floor)
  }

  /** Route as map positions, start to destination. Throws an Error with a message to show the user. */
  async function routeTo(start: MapPoint, destination: MapPoint) {
    if (!canRoute(start, destination)) throw new Error('Routes are only available on level 1 for now.')
    return routeBetween(start, destination)
  }

  return {
    position: readonly(position), // live MapPosition { x, y, floor, accuracyM, timestamp }, or null
    locationStatus: readonly(locationStatus),
    locationMessage: readonly(locationMessage),
    locationLost: readonly(locationLost), // true after LOST_AFTER_MS of scanning with no position
    startLocation,
    stopLocation,
    canRoute,
    routeTo
  }
}
