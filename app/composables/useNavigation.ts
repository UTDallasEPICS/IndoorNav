// Core module: the one interface the UI uses for location and routing (System integration, R04).
// It runs the location module, keeps the latest position as reactive state, and routes between map positions.
// Everything stays on the phone (C02).

import { Capacitor } from '@capacitor/core'
import { readonly, ref } from 'vue'
import { listBeacons } from '~/db/beacons'
import { createDeviceLocationService, spnVenue, withStoredBeacons, type LocationService, type MapPosition, type ProviderStatus } from '~/utils/location/LocationService'
import { routeBetween } from '~/utils/route-between'

export type { MapPosition }

type MapPoint = { x: number, y: number, floor: number } // fractions (0–1) of that floor's map, like the rooms' x/y

/** Floors with a route grid (only public/data/SPN.txt, level 1, for now) */
const ROUTABLE_FLOORS = [1]

/** A position older than this is dropped, so the dot doesn't sit still after we stop hearing beacons */
const STALE_AFTER_MS = 10_000

// Shared by every component that calls useNavigation(), so there's only one BLE scan
const position = ref<MapPosition | null>(null)
const locationStatus = ref<ProviderStatus['state']>('idle')
const locationMessage = ref('')
let service: LocationService | null = null
let staleTimer: ReturnType<typeof setInterval> | null = null
let users = 0

export function useNavigation() {
  /** Starts BLE positioning (a no-op off-device). Failures show up in locationStatus, not as errors. */
  async function startLocation() {
    users++
    if (service) return
    if (!Capacitor.isNativePlatform()) { // desktop browsers have no BLE we're allowed to use (no Web Bluetooth, C01)
      locationStatus.value = 'unavailable'
      locationMessage.value = 'Live location only works in the iOS/Android app.'
      return
    }

    // GPS is off: it was removed from the map page and doesn't help inside SPN1
    const created = createDeviceLocationService({ gps: false })
    service = created
    created.onStatus(status => {
      locationStatus.value = status.state
      locationMessage.value = status.message ?? ''
    })
    created.subscribePosition(p => { position.value = p })
    staleTimer = setInterval(() => {
      if (position.value && Date.now() - position.value.timestamp > STALE_AFTER_MS) position.value = null
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
    startLocation,
    stopLocation,
    canRoute,
    routeTo
  }
}
