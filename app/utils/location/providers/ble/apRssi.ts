// Per-AP RSSI, measured the way the bSLAM survey measured it, so the survey's path-loss fits apply.
//
// A Mist AP sends one Eddystone instance per beam of its vBLE array, and the beams differ by many dB in any one
// direction. The survey averaged each beam's packets over a second, kept the strongest beam of that second as the
// AP's reading, and fitted txPower / pathLossExponent to those readings. Mixing every beam's packets into one
// filter instead reads several dB low (so every range comes out too long) and jumps as different beams arrive.

export interface ApRssiOptions {
  /** Packets of one beam are averaged over slices this long (ms). The survey used 1 s. */
  sliceMs: number
  /** The AP's RSSI is the mean of its strongest-beam readings over this long (ms). Also how long a silent AP is kept. */
  windowMs: number
}

export const DEFAULT_AP_RSSI: ApRssiOptions = {
  sliceMs: 1000,
  windowMs: 3000
}

export interface BeaconReading {
  beaconId: string
  /** Smoothed RSSI in dBm */
  rssi: number
  lastSeen: number
}

interface Packet {
  beam: string
  rssi: number
  timestamp: number
}

/** Collects packets per AP (registry ID) and beam (scanned ID), and reports one smoothed RSSI per AP. */
export class ApRssiBank {
  private aps = new Map<string, Packet[]>()

  constructor(private options: ApRssiOptions = DEFAULT_AP_RSSI) {}

  /** `beaconId` is the registry entry; `beam` the ID actually heard (the same thing for a plain beacon). */
  add(beaconId: string, beam: string, rssi: number, timestamp: number) {
    let packets = this.aps.get(beaconId)
    if (!packets) this.aps.set(beaconId, packets = [])
    packets.push({ beam, rssi, timestamp })
  }

  /** One reading per AP heard within the window ending at `now`. Older packets are dropped. */
  readings(now: number): BeaconReading[] {
    const { sliceMs, windowMs } = this.options
    const out: BeaconReading[] = []
    for (const [beaconId, packets] of this.aps) {
      const kept = packets.filter((p) => now - p.timestamp < windowMs && p.timestamp <= now)
      if (kept.length === 0) {
        this.aps.delete(beaconId)
        continue
      }
      this.aps.set(beaconId, kept)

      // Slices count back from `now`, so each one is a full sliceMs of packets
      const slices = new Map<number, Map<string, { sum: number, n: number }>>()
      let lastSeen = -Infinity
      for (const p of kept) {
        const slice = Math.floor((now - p.timestamp) / sliceMs)
        let beams = slices.get(slice)
        if (!beams) slices.set(slice, beams = new Map())
        const acc = beams.get(p.beam) ?? { sum: 0, n: 0 }
        acc.sum += p.rssi
        acc.n++
        beams.set(p.beam, acc)
        lastSeen = Math.max(lastSeen, p.timestamp)
      }
      let sum = 0
      for (const beams of slices.values()) {
        let strongest = -Infinity
        for (const acc of beams.values()) strongest = Math.max(strongest, acc.sum / acc.n)
        sum += strongest
      }
      out.push({ beaconId, rssi: sum / slices.size, lastSeen })
    }
    return out
  }

  clear() {
    this.aps.clear()
  }
}
