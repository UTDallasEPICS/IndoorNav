// Barometric floor tracking: air pressure -> height -> floor (System integration, floor change; C01).
//
// Air pressure drops ~0.12 hPa per meter up, so one floor (~4 m) is ~0.5 hPa: easy to see. But the weather and
// the building's air handling move the absolute pressure by that much within an hour or so, so the barometer is
// only trusted for *changes* in height. The BLE floor vote says which floor the user is on to begin with (the
// anchor), and keeps cancelling slow drift while the two agree. Between anchors, the barometer alone decides the
// floor, so beacons bleeding through from the floor above or below (e.g. on SPN1's stairs) can't flip it.
//
// The anchor itself is only BLE's guess, and the first confident vote can be wrong: in a room off SPN1's open
// atrium the phone hears the floor above through the opening. So while the floor is still just the anchor (the
// barometer hasn't seen a floor change since), a steady BLE majority for another floor over reanchorAfterMs is
// enough to move it, even when no single vote is confident. A floor the barometer climbed to needs confident votes.
//
// Pure: no timers or platform calls, so it runs in tests. BarometerProvider feeds it pressure samples, and the
// BLE provider asks it for the floor (passing its vote) before every fix.

import type { VenueIndex } from '../../venue'
import type { FloorVote } from '../ble/floorVote'

export interface BarometerFloorOptions {
  /** Smoothing time constant for the height (ms). Android's raw sensor is noisy; iOS already smooths. */
  smoothingMs: number
  /** Switch floors once the height is this fraction of the way to the next floor... */
  switchFraction: number
  /** ...and has stayed past it this long (ms), so a pause partway up the stairs doesn't flip the floor */
  dwellMs: number
  /** A BLE vote counts as confident when the winning floor has at least this share of the vote */
  minVoteShare: number
  /** BLE must confidently vote for the same floor this long (ms) before the barometer anchors to it */
  anchorAfterMs: number
  /** Only anchor or correct drift while the height changes slower than this (m/s): not on stairs or in a lift */
  maxSteadySpeedMps: number
  /** Window for measuring how fast the height changes (ms) */
  speedWindowMs: number
  /** While BLE agrees, how fast the height is pulled back onto the floor, cancelling weather drift (ms) */
  driftTimeConstantMs: number
  /**
   * Window (ms) of steady BLE votes for re-anchoring: the anchor was wrong, or drift too large. Re-anchors when
   * another floor's average share over the whole window reaches minVoteShare (or anchorOverrideShare, below).
   */
  reanchorAfterMs: number
  /** Average share that's enough to move a floor that is still only BLE's anchor (no barometer floor change since) */
  anchorOverrideShare: number
  /** Ignore the barometer once it has been silent this long (ms); BLE's vote picks the floor meanwhile */
  staleAfterMs: number
}

export const DEFAULT_BAROMETER_FLOOR: BarometerFloorOptions = {
  smoothingMs: 1000,
  switchFraction: 0.6,
  dwellMs: 1500,
  minVoteShare: 0.8,
  anchorAfterMs: 3000,
  maxSteadySpeedMps: 0.25,
  speedWindowMs: 3000,
  driftTimeConstantMs: 30_000,
  reanchorAfterMs: 20_000,
  anchorOverrideShare: 0.5,
  staleAfterMs: 5000
}

/** What the tracker currently believes, for debugging and the test readout */
export interface BarometerFloorState {
  /** Latest raw pressure (hPa), or null before the first sample */
  pressureHpa: number | null
  /** Height above the building's ground floor (m), smoothed; null until anchored */
  heightM: number | null
  /** How fast the height is changing (m/s, up is positive), or null until there's enough data */
  verticalSpeedMps: number | null
  /** The barometer's floor, or null until anchored (or while the barometer is silent) */
  floorId: string | null
  /** The last BLE vote it was given */
  vote: FloorVote | null
}

/** Height (m) of an air pressure (hPa) in the standard atmosphere. Only differences between heights are used. */
export function pressureToAltitudeM(pressureHpa: number): number {
  return 44330 * (1 - Math.pow(pressureHpa / 1013.25, 1 / 5.255))
}

export class BarometerFloorTracker {
  private options: BarometerFloorOptions
  private index: VenueIndex | null = null
  private pressureHpa: number | null = null
  /** Smoothed standard-atmosphere altitude (m) */
  private altitude: number | null = null
  private lastPressureTime = -Infinity
  private history: Array<{ timestamp: number, altitude: number }> = []
  /** Height above the building's ground floor = altitude + offset. Null until anchored. */
  private offset: number | null = null
  private buildingId: string | null = null
  private buildingFloors: Array<{ id: string, elevationM: number }> = []
  private floorId: string | null = null
  /** A floor the height has moved to, waiting out dwellMs */
  private candidate: { floorId: string, since: number } | null = null
  private vote: FloorVote | null = null
  /** The floor BLE has confidently voted for without a break, and since when */
  private run: { floorId: string, since: number } | null = null
  /** True once the barometer has moved the floor since the last anchor: then only confident votes can override it */
  private floorFromBarometer = false
  /** Steady BLE votes since the last anchor or floor change, trimmed to reanchorAfterMs; and when collecting began */
  private evidence: Array<{ timestamp: number, vote: FloorVote }> = []
  private evidenceSince: number | null = null
  private lastCorrectionTime: number | null = null

  constructor(options: Partial<BarometerFloorOptions> = {}) {
    this.options = { ...DEFAULT_BAROMETER_FLOOR, ...options }
  }

  /** The venue whose floors (and floor heights) to use. Forgets everything else. */
  setVenue(index: VenueIndex | null) {
    this.index = index
    this.pressureHpa = null
    this.altitude = null
    this.lastPressureTime = -Infinity
    this.history = []
    this.vote = null
    this.run = null
    this.unanchor()
  }

  /** One barometer reading */
  addPressure(pressureHpa: number, timestamp: number) {
    if (!Number.isFinite(pressureHpa) || pressureHpa <= 0) return // the plugin reports 0 before its first reading
    const altitude = pressureToAltitudeM(pressureHpa)
    if (this.altitude === null || timestamp - this.lastPressureTime > this.options.staleAfterMs) {
      // First sample, or after a gap (e.g. the app was in the background): start smoothing afresh. The anchor
      // stays, so a floor changed during the gap still shows up.
      this.altitude = altitude
      this.history = []
    } else {
      const dt = Math.max(0, timestamp - this.lastPressureTime)
      this.altitude += (1 - Math.exp(-dt / this.options.smoothingMs)) * (altitude - this.altitude)
    }
    this.pressureHpa = pressureHpa
    this.lastPressureTime = timestamp
    this.history.push({ timestamp, altitude: this.altitude })
    while (this.history.length > 2 && this.history[0]!.timestamp < timestamp - this.options.speedWindowMs) this.history.shift()
    if (this.offset !== null) this.updateFloor(timestamp)
  }

  /**
   * The floor for a BLE fix: the barometer's, or null to use the BLE vote (not anchored yet, barometer silent,
   * or the vote is for another building). Also takes the vote in, to anchor and correct the barometer.
   */
  chooseFloor(vote: FloorVote | null, timestamp: number): string | null {
    this.vote = vote
    const confident = vote !== null && vote.share >= this.options.minVoteShare
    if (!confident) this.run = null
    else if (this.run?.floorId !== vote.floorId) this.run = { floorId: vote.floorId, since: timestamp }

    if (!this.index || timestamp - this.lastPressureTime > this.options.staleAfterMs) return null
    const steady = this.isSteady()
    const settled = this.run !== null && timestamp - this.run.since >= this.options.anchorAfterMs

    const voteBuildingId = vote ? this.index.floors.get(vote.floorId)?.building.id : undefined
    if (this.offset === null || (voteBuildingId !== undefined && voteBuildingId !== this.buildingId)) {
      if (settled && steady) {
        this.anchor(this.run!.floorId, timestamp)
        return this.floorId
      }
      return null
    }

    if (vote !== null && steady && this.candidate === null) {
      if (confident && vote.floorId === this.floorId) this.correctDrift(timestamp)
      else this.lastCorrectionTime = null
      const target = this.reanchorTarget(vote, timestamp)
      if (target) this.anchor(target, timestamp)
    } else {
      this.clearEvidence()
      this.lastCorrectionTime = null
    }
    return this.floorId
  }

  get state(): BarometerFloorState {
    return {
      pressureHpa: this.pressureHpa,
      heightM: this.altitude !== null && this.offset !== null ? this.altitude + this.offset : null,
      verticalSpeedMps: this.verticalSpeed(),
      floorId: this.floorId,
      vote: this.vote
    }
  }

  /** Moves to the nearest floor once the height is far enough past the current one, for long enough */
  private updateFloor(timestamp: number) {
    const height = this.altitude! + this.offset!
    let nearest = this.buildingFloors[0]!
    for (const floor of this.buildingFloors) {
      if (Math.abs(height - floor.elevationM) < Math.abs(height - nearest.elevationM)) nearest = floor
    }
    const current = this.elevation(this.floorId!)
    const farEnough = Math.abs(height - current) >= this.options.switchFraction * Math.abs(nearest.elevationM - current)
    if (nearest.id === this.floorId || !farEnough) {
      this.candidate = null
      return
    }
    if (this.candidate?.floorId !== nearest.id) {
      this.candidate = { floorId: nearest.id, since: timestamp }
      return
    }
    if (timestamp - this.candidate.since >= this.options.dwellMs) {
      this.floorId = nearest.id
      this.floorFromBarometer = true
      this.candidate = null
      this.clearEvidence()
    }
  }

  /**
   * Adds a steady vote to the evidence; returns the floor to re-anchor to, if any. Each vote gives its share to
   * the winner and, when the winner isn't the current floor, the rest to the current floor (an upper bound, so
   * mixed votes favour staying put). Moves only after a full window, to a floor whose average beats the current one.
   */
  private reanchorTarget(vote: FloorVote, timestamp: number): string | null {
    this.evidenceSince ??= timestamp
    this.evidence.push({ timestamp, vote })
    const cutoff = timestamp - this.options.reanchorAfterMs
    while (this.evidence[0]!.timestamp < cutoff) this.evidence.shift()
    if (timestamp - this.evidenceSince < this.options.reanchorAfterMs) return null

    const current = this.floorId!
    const support = new Map<string, number>()
    const add = (floorId: string, share: number) => support.set(floorId, (support.get(floorId) ?? 0) + share)
    for (const { vote } of this.evidence) {
      add(vote.floorId, vote.share)
      if (vote.floorId !== current) add(current, 1 - vote.share)
    }
    const needed = this.floorFromBarometer ? this.options.minVoteShare : this.options.anchorOverrideShare
    const n = this.evidence.length
    const currentShare = (support.get(current) ?? 0) / n
    let best: string | null = null
    let bestShare = 0
    for (const [floorId, total] of support) {
      if (floorId !== current && total / n > bestShare) {
        best = floorId
        bestShare = total / n
      }
    }
    return best !== null && bestShare >= needed && bestShare > currentShare ? best : null
  }

  private clearEvidence() {
    this.evidence = []
    this.evidenceSince = null
  }

  /** Sets the height so the user stands on `floorId` now */
  private anchor(floorId: string, timestamp: number) {
    const info = this.index!.floors.get(floorId)
    if (!info || this.altitude === null) return
    this.buildingId = info.building.id
    this.buildingFloors = info.building.floors.map((floor) => ({ id: floor.id, elevationM: floor.transform.floorZ }))
    this.offset = info.floor.transform.floorZ - this.altitude
    this.floorId = floorId
    this.floorFromBarometer = false
    this.candidate = null
    this.clearEvidence()
    this.lastCorrectionTime = timestamp
  }

  private unanchor() {
    this.offset = null
    this.buildingId = null
    this.buildingFloors = []
    this.floorId = null
    this.floorFromBarometer = false
    this.candidate = null
    this.clearEvidence()
    this.lastCorrectionTime = null
  }

  /** Pulls the height a little toward the floor BLE agrees we're on; weather drift is slow, so this cancels it */
  private correctDrift(timestamp: number) {
    const dt = this.lastCorrectionTime === null ? 0 : Math.min(timestamp - this.lastCorrectionTime, 5000)
    this.lastCorrectionTime = timestamp
    const error = this.elevation(this.floorId!) - (this.altitude! + this.offset!)
    this.offset! += error * (1 - Math.exp(-Math.max(dt, 0) / this.options.driftTimeConstantMs))
  }

  private elevation(floorId: string) {
    return this.buildingFloors.find((floor) => floor.id === floorId)?.elevationM ?? 0
  }

  private verticalSpeed(): number | null {
    const first = this.history[0]
    const last = this.history[this.history.length - 1]
    if (!first || !last || last.timestamp - first.timestamp < 1000) return null
    return (last.altitude - first.altitude) / ((last.timestamp - first.timestamp) / 1000)
  }

  private isSteady() {
    const speed = this.verticalSpeed()
    return speed !== null && Math.abs(speed) <= this.options.maxSteadySpeedMps
  }
}
