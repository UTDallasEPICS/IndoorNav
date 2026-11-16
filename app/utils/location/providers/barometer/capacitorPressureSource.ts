// Real barometer on iOS/Android via @capgo/capacitor-barometer. Only this file touches the platform.
//
// iOS: CMAltimeter, ~1 reading/s, already smoothed. Needs NSMotionUsageDescription in Info.plist; the Motion &
// Fitness prompt appears on the first start. If the user declines, readings just never arrive (the plugin doesn't
// report it), and the floor falls back to the BLE vote once the tracker sees the barometer is silent.
// Android: the raw TYPE_PRESSURE sensor, ~5 readings/s, no permission needed. Phones without one are reported
// unavailable, and the BLE vote picks the floor as before.

import type { PluginListenerHandle } from '@capacitor/core'
import { CapacitorBarometer } from '@capgo/capacitor-barometer'
import type { PressureSample, PressureSource } from './pressureSource'

export class CapacitorPressureSource implements PressureSource {
  private listener: PluginListenerHandle | null = null

  async start(onSample: (sample: PressureSample) => void) {
    const { isAvailable } = await CapacitorBarometer.isAvailable()
    if (!isAvailable) throw new Error('This phone has no barometer')
    const { barometer } = await CapacitorBarometer.checkPermissions()
    if (barometer === 'denied') throw new Error('Motion & Fitness permission denied')

    // Timestamped here, like the motion sensors, so all providers share one clock (Date.now())
    this.listener = await CapacitorBarometer.addListener('measurement', (m) => onSample({ pressureHpa: m.pressure, timestamp: Date.now() }))
    try {
      await CapacitorBarometer.startMeasurementUpdates()
    } catch (err) {
      await this.stop()
      throw err
    }
  }

  async stop() {
    await CapacitorBarometer.stopMeasurementUpdates().catch(() => {})
    await this.listener?.remove()
    this.listener = null
  }
}
