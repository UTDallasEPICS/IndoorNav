// Position filter that knows where the walls are. Used instead of StepKalman while the motion sensors run on a floor
// with a route grid.
//
// Several hundred guesses ("particles") of where the user is:
// - Each step moves every particle by the step's length along the compass heading, each with its own random heading
//   and length error (the same error model as StepKalman). A particle whose step goes through a wall is almost
//   certainly in the wrong place, so it keeps only a sliver of its weight and soon disappears.
// - A BLE fix reweights particles by how well they agree with it (its error ellipse). When a few particles carry
//   most of the weight, the cloud is redrawn from them (resampling), with the copies nudged apart a little.
// - So the cloud stays in hallways and rooms, on the side of a wall the user's steps could actually reach, and the dot
//   follows corridors instead of cutting through offices.
//
// Like StepKalman: fixes far from the cloud are dropped, and if several in a row are, the filter assumes it's lost
// (e.g. walled into the wrong room) and restarts around them. A wall missing a door on the map slows the dot down
// rather than stopping it: the particles that cross are only down-weighted.

import { NO_DEBUG_LOG, type DebugLog } from '../debug/debugLog'
import { createRng, type Rng } from '../random'
import type { StepFilter, StepFilterCovariance } from './stepKalman'
import type { WalkableMap } from './walkableMap'

export interface ParticleFilterOptions {
  particles: number
  /** Position random-walk noise between steps while walking (m^2/s per axis, as StepKalman): covers missed steps */
  movingNoise: number
  /** Position random-walk noise while standing still (m^2/s per axis) */
  stationaryNoise: number
  /** BLE variance multiplier while standing still (as StepKalman) */
  stationaryMeasurementScale: number
  /** 1-sigma step length error as a fraction of the step */
  stepLengthError: number
  /**
   * Weight kept by a particle whose step crosses a wall. Not zero: if the map is missing a door, the particles that
   * went through it carry on, and BLE decides.
   */
  wallCrossWeight: number
  /**
   * After resampling, copies of one particle are nudged apart by this much (1 sigma, m), staying on open floor.
   * Walls trim the cloud every step; without this it shrinks to a few copies and stops listening to BLE.
   */
  resampleJitterM: number
  /** Gate: drop BLE fixes whose squared Mahalanobis distance from the cloud exceeds this (2 dof: 13.8 ~ 99.9%) */
  gateChi2: number
  /** Restart around the average of this many dropped fixes in a row */
  relocalizeAfter: number
  /** Restart from the next fix after this long without any input (ms) */
  maxGapMs: number
  /** The cloud starts at least this spread out (1 sigma, m), however confident the first fix claims to be */
  minSeedAccuracyM: number
  /** Random seed, so runs are repeatable */
  seed: number
}

export const DEFAULT_PARTICLE_FILTER: ParticleFilterOptions = {
  particles: 800,
  movingNoise: 0.15,
  stationaryNoise: 0.01,
  stationaryMeasurementScale: 4,
  stepLengthError: 0.15,
  wallCrossWeight: 0.05,
  resampleJitterM: 0.3,
  gateChi2: 13.8,
  relocalizeAfter: 4,
  maxGapMs: 10000,
  minSeedAccuracyM: 4,
  seed: 1
}

const RAD = Math.PI / 180

export class ParticleFilter implements StepFilter {
  private options: ParticleFilterOptions
  private rng: Rng
  private n: number
  private pe: Float64Array
  private pn: Float64Array
  private weight: Float64Array
  private live = false
  private lastTimestamp: number | null = null
  private moving = false
  private floorId: string | null = null
  private rejected: Array<{ e: number, n: number, cov: StepFilterCovariance }> = []
  /** Effective sample size after the last reweighting (debug log) */
  private lastEss = 0
  /** Cloud mean of the last wall snap logged, so repeated state() calls log it once */
  private lastSnapKey = ''

  constructor(private map: WalkableMap, options: Partial<ParticleFilterOptions> = {}, private debug: DebugLog = NO_DEBUG_LOG) {
    this.options = { ...DEFAULT_PARTICLE_FILTER, ...options }
    this.rng = createRng(this.options.seed)
    this.n = this.options.particles
    this.pe = new Float64Array(this.n)
    this.pn = new Float64Array(this.n)
    this.weight = new Float64Array(this.n)
  }

  /** Which floor's walls apply. A change scatters the cloud onto open floor of the new floor. */
  setFloor(floorId: string | null) {
    if (floorId === this.floorId) return
    this.floorId = floorId
    const s = this.state()
    if (!s || this.lastTimestamp === null) return
    const v = s.accuracyM ** 2 / 2 + 1
    this.debug.log('pf.floor', { floorId, e: s.e, n: s.n, sigmaM: Math.sqrt(v) })
    this.scatter(s.e, s.n, { ee: v, en: 0, nn: v }, this.lastTimestamp)
  }

  seed(e: number, n: number, accuracyM: number, timestamp: number) {
    const a = Math.max(accuracyM, this.options.minSeedAccuracyM)
    this.scatter(e, n, { ee: a * a / 2, en: 0, nn: a * a / 2 }, timestamp)
  }

  setMoving(moving: boolean) {
    this.moving = moving
  }

  step(lengthM: number, headingDeg: number | null, headingAccuracyDeg: number, timestamp: number) {
    if (!this.live) return
    this.moving = true
    this.predictTo(timestamp)
    const o = this.options
    // A step off by angle x only goes cos(x) of the way forward, and E[cos x] = exp(-sigma^2 / 2): lengthen every step
    // to make up for it, or the cloud's average step comes out short and the dot lags behind the walker.
    const headingSigma = Math.min(headingAccuracyDeg, 90) * RAD
    const stretch = headingDeg === null ? 1 : Math.exp(headingSigma * headingSigma / 2)
    let crossings = 0
    const crossed = new Uint8Array(this.n)
    for (let i = 0; i < this.n; i++) {
      const length = stretch * lengthM * (1 + this.rng.gaussian() * o.stepLengthError)
      // Without a compass the step went somewhere within a circle
      const heading = headingDeg === null ? this.rng.uniform() * 360 : headingDeg + this.rng.gaussian() * headingAccuracyDeg
      const from = { e: this.pe[i]!, n: this.pn[i]! }
      this.pe[i] = from.e + length * Math.sin(heading * RAD)
      this.pn[i] = from.n + length * Math.cos(heading * RAD)
      if (!this.map.canWalk(this.floorId, from, { e: this.pe[i]!, n: this.pn[i]! })) {
        crossed[i] = 1
        crossings++
      }
    }
    // If nearly every particle walked through a wall, the map is probably missing an opening: let it go this step
    const allCrossed = crossings > 0.99 * this.n
    let resampled = false
    if (crossings > 0 && !allCrossed) {
      for (let i = 0; i < this.n; i++) if (crossed[i]) this.weight[i]! *= o.wallCrossWeight
      resampled = this.normalizeAndResample()
    }
    if (this.debug.enabled) {
      const s = this.moments()
      this.debug.log('pf.step', {
        timestamp, lengthM, headingDeg, headingAccuracyDeg, stretch,
        crossings, allCrossed, resampled,
        // Effective particles left after the wall penalty (before any resampling)
        ess: crossings > 0 && !allCrossed ? this.lastEss : null,
        e: s.e, n: s.n, spreadM: Math.sqrt(s.ee + s.nn)
      })
    }
  }

  update(e: number, n: number, accuracyM: number, timestamp: number, covariance?: StepFilterCovariance) {
    const scale = this.moving ? 1 : this.options.stationaryMeasurementScale
    const r = accuracyM * accuracyM / 2
    const base = covariance ?? { ee: r, en: 0, nn: r }
    const cov = { ee: base.ee * scale, en: base.en * scale, nn: base.nn * scale }
    if (!this.live || this.lastTimestamp === null || timestamp - this.lastTimestamp > this.options.maxGapMs) {
      this.debug.log('pf.reseed', { timestamp, reason: this.live ? 'gap' : 'not live', e, n, accuracyM: Math.sqrt(base.ee + base.nn) })
      this.seed(e, n, Math.sqrt(base.ee + base.nn), timestamp)
      return
    }
    this.predictTo(timestamp)

    // Gate against the whole cloud, as StepKalman gates against its estimate
    const s = this.moments()
    const see = s.ee + cov.ee
    const sen = s.en + cov.en
    const snn = s.nn + cov.nn
    const det = see * snn - sen * sen
    const de = e - s.e
    const dn = n - s.n
    const d2 = (snn * de * de - 2 * sen * de * dn + see * dn * dn) / det
    if (d2 > this.options.gateChi2) {
      this.rejected.push({ e, n, cov })
      this.debug.log('pf.update', { timestamp, e, n, moving: this.moving, d2, gated: true, rejectedInRow: this.rejected.length, cloudE: s.e, cloudN: s.n, spreadM: Math.sqrt(s.ee + s.nn) })
      if (this.rejected.length >= this.options.relocalizeAfter) this.relocalize(timestamp)
      return
    }
    this.rejected = []

    const rdet = cov.ee * cov.nn - cov.en * cov.en
    const iee = cov.nn / rdet
    const ien = -cov.en / rdet
    const inn = cov.ee / rdet
    for (let i = 0; i < this.n; i++) {
      const pe = this.pe[i]! - e
      const pn = this.pn[i]! - n
      const m2 = iee * pe * pe + 2 * ien * pe * pn + inn * pn * pn
      this.weight[i]! *= Math.exp(-0.5 * Math.min(m2, 50))
    }
    const resampled = this.normalizeAndResample()
    if (this.debug.enabled) {
      const after = this.moments()
      this.debug.log('pf.update', {
        timestamp, e, n, moving: this.moving, d2, gated: false, ess: this.lastEss, resampled,
        cloudE: after.e, cloudN: after.n, spreadM: Math.sqrt(after.ee + after.nn)
      })
    }
  }

  predict(timestamp: number) {
    if (!this.live) return
    this.predictTo(timestamp)
  }

  state() {
    if (!this.live) return null
    const s = this.moments()
    let e = s.e
    let n = s.n
    // The mean of a cloud split by a wall can land in the wall: show the open-floor particle nearest to it instead
    if (!this.map.isOpen(this.floorId, e, n)) {
      let best = Infinity
      for (let i = 0; i < this.n; i++) {
        const d = (this.pe[i]! - s.e) ** 2 + (this.pn[i]! - s.n) ** 2
        if (d < best && this.map.isOpen(this.floorId, this.pe[i]!, this.pn[i]!)) {
          best = d
          e = this.pe[i]!
          n = this.pn[i]!
        }
      }
      const key = `${s.e},${s.n}`
      if (this.debug.enabled && key !== this.lastSnapKey) {
        this.lastSnapKey = key
        this.debug.log('pf.snap', { meanE: s.e, meanN: s.n, e, n, distM: Math.hypot(e - s.e, n - s.n), spreadM: Math.sqrt(s.ee + s.nn) })
      }
    }
    return { e, n, ve: 0, vn: 0, accuracyM: Math.sqrt(s.ee + s.nn) }
  }

  reset() {
    this.live = false
    this.lastTimestamp = null
    this.rejected = []
  }

  /** Copies of the particles (for tests and debug drawing) */
  particles() {
    return Array.from({ length: this.live ? this.n : 0 }, (_, i) => ({ e: this.pe[i]!, n: this.pn[i]!, weight: this.weight[i]! }))
  }

  /** Spreads the particles over a Gaussian around (e, n), on open floor where possible. */
  private scatter(e: number, n: number, cov: StepFilterCovariance, timestamp: number) {
    // Cholesky of the 2x2 covariance
    const a = Math.sqrt(Math.max(cov.ee, 1e-6))
    const b = cov.en / a
    const c = Math.sqrt(Math.max(cov.nn - b * b, 1e-6))
    for (let i = 0; i < this.n; i++) {
      let pe = e
      let pn = n
      for (let tries = 0; tries < 20; tries++) {
        const z1 = this.rng.gaussian()
        const z2 = this.rng.gaussian()
        pe = e + a * z1
        pn = n + b * z1 + c * z2
        if (this.map.isOpen(this.floorId, pe, pn)) break
      }
      this.pe[i] = pe
      this.pn[i] = pn
      this.weight[i] = 1 / this.n
    }
    this.live = true
    this.lastTimestamp = timestamp
    this.rejected = []
  }

  private predictTo(timestamp: number) {
    const dt = (timestamp - this.lastTimestamp!) / 1000
    if (dt <= 0) return
    const sigma = Math.sqrt((this.moving ? this.options.movingNoise : this.options.stationaryNoise) * dt)
    for (let i = 0; i < this.n; i++) {
      const pe = this.pe[i]! + this.rng.gaussian() * sigma
      const pn = this.pn[i]! + this.rng.gaussian() * sigma
      // Drifting into or through a wall isn't a move anyone made: stay put instead
      if (this.map.canWalk(this.floorId, { e: this.pe[i]!, n: this.pn[i]! }, { e: pe, n: pn })) {
        this.pe[i] = pe
        this.pn[i] = pn
      }
    }
    this.lastTimestamp = timestamp
  }

  /** Weighted mean and covariance of the cloud */
  private moments() {
    let e = 0, n = 0
    for (let i = 0; i < this.n; i++) {
      e += this.weight[i]! * this.pe[i]!
      n += this.weight[i]! * this.pn[i]!
    }
    let ee = 0, en = 0, nn = 0
    for (let i = 0; i < this.n; i++) {
      const de = this.pe[i]! - e
      const dn = this.pn[i]! - n
      ee += this.weight[i]! * de * de
      en += this.weight[i]! * de * dn
      nn += this.weight[i]! * dn * dn
    }
    return { e, n, ee, en, nn }
  }

  /**
   * Normalizes the weights and, once too few particles carry most of the weight, resamples (systematic).
   * Returns whether it resampled.
   */
  private normalizeAndResample(): boolean {
    let sum = 0
    for (let i = 0; i < this.n; i++) sum += this.weight[i]!
    if (!(sum > 0)) {
      this.weight.fill(1 / this.n)
      this.lastEss = 0
      return false
    }
    let sumSq = 0
    for (let i = 0; i < this.n; i++) {
      this.weight[i]! /= sum
      sumSq += this.weight[i]! ** 2
    }
    this.lastEss = 1 / sumSq
    if (this.lastEss >= this.n / 2) return false

    const pe = new Float64Array(this.n)
    const pn = new Float64Array(this.n)
    const jitter = this.options.resampleJitterM
    const u0 = this.rng.uniform() / this.n
    let cumulative = this.weight[0]!
    let j = 0
    for (let i = 0; i < this.n; i++) {
      const u = u0 + i / this.n
      while (u > cumulative && j < this.n - 1) cumulative += this.weight[++j]!
      pe[i] = this.pe[j]!
      pn[i] = this.pn[j]!
      if (jitter > 0) {
        const to = { e: pe[i]! + this.rng.gaussian() * jitter, n: pn[i]! + this.rng.gaussian() * jitter }
        if (this.map.canWalk(this.floorId, { e: pe[i]!, n: pn[i]! }, to)) {
          pe[i] = to.e
          pn[i] = to.n
        }
      }
    }
    this.pe = pe
    this.pn = pn
    this.weight.fill(1 / this.n)
    return true
  }

  /** Several fixes in a row disagree with the cloud: restart around their precision-weighted average. */
  private relocalize(timestamp: number) {
    let we = 0, wn = 0, e = 0, n = 0
    for (const fix of this.rejected) {
      e += fix.e / fix.cov.ee
      we += 1 / fix.cov.ee
      n += fix.n / fix.cov.nn
      wn += 1 / fix.cov.nn
    }
    const k = this.rejected.length
    this.debug.log('pf.relocalize', { timestamp, e: e / we, n: n / wn, fixes: k, sigmaM: Math.sqrt(k / we + k / wn) })
    this.scatter(e / we, n / wn, { ee: k / we, en: 0, nn: k / wn }, timestamp)
  }
}
