/**
 * Log-distance path loss model: rssi = txPower - 10 * n * log10(d), where txPower is the RSSI at 1 m
 * and n is the path loss exponent. Returns the distance in meters for a given RSSI.
 */
export function rssiToDistance(rssi: number, txPower: number, pathLossExponent: number): number {
  return Math.pow(10, (txPower - rssi) / (10 * pathLossExponent))
}

/** Inverse of rssiToDistance (used by the simulator). */
export function distanceToRssi(distanceM: number, txPower: number, pathLossExponent: number): number {
  return txPower - 10 * pathLossExponent * Math.log10(Math.max(distanceM, 0.1))
}
