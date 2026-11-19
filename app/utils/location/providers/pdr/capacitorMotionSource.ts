// Real accelerometer + compass on iOS/Android. Only this file touches the platform.
//
// Acceleration comes from @capacitor/motion. Its 'orientation' event isn't referenced to north, so the compass
// reads the WebView's absolute orientation events directly: iOS gives `webkitCompassHeading` (tilt-compensated,
// magnetic north); Android gives `deviceorientationabsolute`, which we turn into a heading ourselves.

import type { PluginListenerHandle } from '@capacitor/core'
import { Motion } from '@capacitor/motion'
import { headingFromOrientation } from './heading'
import type { AccelSample, CompassSample, MotionSource } from './motionSource'

type IosOrientationEvent = DeviceOrientationEvent & { webkitCompassHeading?: number, webkitCompassAccuracy?: number }
type PermissionRequester = { requestPermission?: () => Promise<'granted' | 'denied'> }

let permission: Promise<boolean> | null = null

/**
 * Asks for motion + orientation permission (iOS 13+; elsewhere it's always granted). iOS only shows the prompt
 * when this runs inside a user tap, so call it before the first `await` of the tap's handler. Asks once per launch.
 */
export function requestMotionPermission(): Promise<boolean> {
  if (permission) return permission
  // Both requests start synchronously, so both are still inside the tap
  const requests = ([globalThis.DeviceMotionEvent, globalThis.DeviceOrientationEvent] as PermissionRequester[])
    .map((api) => (typeof api?.requestPermission === 'function' ? api.requestPermission() : 'granted'))
  permission = Promise.all(requests).then((answers) => answers.every((answer) => answer === 'granted')).catch(() => {
    permission = null // e.g. not called from a tap: try again next time
    return false
  })
  return permission
}

export class CapacitorMotionSource implements MotionSource {
  private accel: PluginListenerHandle | null = null
  private removeCompass: (() => void) | null = null

  async start(onAccel: (sample: AccelSample) => void, onCompass: (sample: CompassSample) => void) {
    if (!(await requestMotionPermission())) throw new Error('Motion permission denied')

    this.accel = await Motion.addListener('accel', (event) => {
      const a = event.accelerationIncludingGravity
      if (a?.x == null || a.y == null || a.z == null) return
      onAccel({ x: a.x, y: a.y, z: a.z, timestamp: Date.now() })
    })

    const onOrientation = (event: IosOrientationEvent) => {
      const timestamp = Date.now()
      if (typeof event.webkitCompassHeading === 'number' && event.webkitCompassHeading >= 0) {
        const accuracy = event.webkitCompassAccuracy
        onCompass({ headingDeg: event.webkitCompassHeading, accuracyDeg: accuracy != null && accuracy >= 0 ? accuracy : null, timestamp })
        return
      }
      if (!event.absolute || event.alpha == null || event.beta == null || event.gamma == null) return
      const headingDeg = headingFromOrientation(event.alpha, event.beta, event.gamma)
      if (headingDeg !== null) onCompass({ headingDeg, accuracyDeg: null, timestamp })
    }
    const type = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation'
    window.addEventListener(type, onOrientation as EventListener)
    this.removeCompass = () => window.removeEventListener(type, onOrientation as EventListener)
  }

  async stop() {
    await this.accel?.remove()
    this.accel = null
    this.removeCompass?.()
    this.removeCompass = null
  }
}
