// Real GPS on iOS/Android via @capacitor/geolocation. Only this file touches the plugin.

import { Geolocation } from '@capacitor/geolocation'
import type { GpsReading, GpsSource } from './gpsSource'

export class CapacitorGpsSource implements GpsSource {
  private watchId: string | null = null

  async start(onReading: (reading: GpsReading) => void) {
    const permission = await Geolocation.requestPermissions()
    if (permission.location !== 'granted') throw new Error('Location permission denied')

    this.watchId = await Geolocation.watchPosition({ enableHighAccuracy: true }, (position) => {
      if (!position) return
      const { coords } = position
      onReading({
        lat: coords.latitude,
        lon: coords.longitude,
        altitude: coords.altitude,
        accuracyM: coords.accuracy,
        headingDeg: coords.heading,
        timestamp: position.timestamp
      })
    })
  }

  async stop() {
    if (this.watchId) await Geolocation.clearWatch({ id: this.watchId })
    this.watchId = null
  }
}
