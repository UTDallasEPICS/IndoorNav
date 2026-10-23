// Real BLE scanning on iOS/Android via @capacitor-community/bluetooth-le. Only this file touches the plugin.

import { BleClient, ScanMode } from '@capacitor-community/bluetooth-le'
import { EDDYSTONE_SERVICE_UUID, parseEddystoneUid } from './eddystone'
import type { BeaconAdvert, BleScanner } from './scanner'

export class CapacitorBleScanner implements BleScanner {
  private initialized = false

  async start(onAdvert: (advert: BeaconAdvert) => void) {
    if (!this.initialized) {
      // Asks for Bluetooth (and on Android < 12, location) permission. We do derive location from scans,
      // so androidNeverForLocation must stay false.
      await BleClient.initialize({ androidNeverForLocation: false })
      this.initialized = true
    }
    if (!(await BleClient.isEnabled())) throw new Error('Bluetooth is turned off')

    await BleClient.requestLEScan(
      {
        // iOS only delivers Eddystone frames if we filter on the service UUID
        services: [EDDYSTONE_SERVICE_UUID],
        // Needed for continuous RSSI updates; without it each beacon is reported once
        allowDuplicates: true,
        scanMode: ScanMode.SCAN_MODE_LOW_LATENCY
      },
      (result) => {
        const data = result.serviceData?.[EDDYSTONE_SERVICE_UUID]
        if (!data || result.rssi === undefined) return
        const uid = parseEddystoneUid(data)
        if (!uid) return
        onAdvert({ beaconId: uid.id, rssi: result.rssi, timestamp: Date.now() })
      }
    )
  }

  async stop() {
    if (this.initialized) await BleClient.stopLEScan()
  }
}
