// Eddystone-UID frame parsing. Spec: https://github.com/google/eddystone/tree/master/eddystone-uid

/** 16-bit Eddystone service UUID (0xFEAA) in the 128-bit form BLE plugins use */
export const EDDYSTONE_SERVICE_UUID = '0000feaa-0000-1000-8000-00805f9b34fb'

export interface EddystoneUid {
  /** "<namespace hex>:<instance hex>", lowercase */
  id: string
  /** Calibrated Tx power at 0 m, in dBm (RSSI at 1 m is roughly this minus 41 dB) */
  txPowerAt0m: number
}

/**
 * Parses the service data of an Eddystone frame. Returns null for other frame types (URL, TLM, EID).
 * Layout: [0] frame type 0x00, [1] Tx power (int8), [2..11] namespace, [12..17] instance.
 */
export function parseEddystoneUid(data: DataView): EddystoneUid | null {
  if (data.byteLength < 18 || data.getUint8(0) !== 0x00) return null
  const hex = (start: number, end: number) => {
    let out = ''
    for (let i = start; i < end; i++) out += data.getUint8(i).toString(16).padStart(2, '0')
    return out
  }
  return {
    id: `${hex(2, 12)}:${hex(12, 18)}`,
    txPowerAt0m: data.getInt8(1)
  }
}
