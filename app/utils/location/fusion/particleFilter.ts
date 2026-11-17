// Position filter that knows where the walls are. Used instead of StepKalman while the motion sensors run and the
// floor has a route grid.
//
// A few hundred guesses ("particles") of where the user is:
// - Each step moves every particle by the step's length along the compass heading, each with its own small
//   heading and step-length error (and a slowly varying compass bias, as near steel). A particle whose step goes
//   through a wall is almost certainly wrong, so it nearly loses its weight and soon disappears.
// - A BLE fix reweights particles by how well they agree with it (its error ellipse), and the unlikely ones are
//   replaced by copies of the likely ones (resampling).
// - So the cloud ends up in hallways and rooms, on the side of a wall the user's steps could actually reach, and the
//   dot (the cloud's mean) follows corridors instead of cutting through offices.
//
// Like StepKalman: fixes far from the cloud are dropped, and if several in a row are, the filter assumes it's lost
// and restarts around them. If every particle hits a wall (the grid is missing a door), the walls are ignored for
// that step, so a map error can't freeze the dot.

import { createRng, type Rng } from '../random'
import type { StepFilter, StepFilterCovariance } from './stepKalman'
import type { WalkableMap } from './walkableMap'

export interface ParticleFilterOptions {
  particles: number
  /** Position random-walk noise between steps while walking (m^2/s): covers missed steps */
  movingNoise: number
  /** Position random-walk noise while standing still (m^2/s) */
  stationaryNoise: number
  /** BLE variance multiplier while standing still (as StepKalman) */
  stationaryMeasurementScale: number
  /** 1-sigma step length error as a fraction of the step, per step */
  stepLengthError: number
  /** 1-sigma error of a particle's step length scale (this user's stride vs the estimate) */
  stepScaleSigma: number
  /** 1-sigma per-particle compass bias, and how much it wanders per step (degrees) */
  headingBiasSigmaDeg: number
  headingBiasWalkDeg: number
  /** Weight kept by a particle whose step crosses a wall */
  wallCrossWeight: number
  /** Gate: drop BLE fixes whose squared Mahalanobis distance from the cloud exceeds this (2 dof) */
  gateChi2: number
  /** Restart around the average of this many dropped fixes in a row */
  relocalizeAfter: number
  /** Restart from the next fix after this long without any input (ms) */
  maxGapMs: number
  /**
   * Share of particles redrawn around each BLE fix. Lets the cloud get out of a room it was wrongly walled into
   * (a bad first fix, missed steps), since steps alone can never cross the wall.
   */
  injectFraction: number
  /** ...but only for fixes this far from the cloud (squared Mahalanobis distance): agreeing fixes would just add noise */
  injectAboveChi2: number
  /** Per-step heading noise as a fraction of the step's heading accuracy (the rest is the slowly varying bias) */
  headingStepNoise: number
  /** The cloud starts at least this spread out (1 sigma, m), however confident the first fix claims to be */
  minSeedAccuracyM: number
  /** Random seed, so runs are repeatable */
  seed: number
}

export const DEFAULT_PARTICLE_FILTER: ParticleFilterOptions = {
  particles: 400,
  movingNoise: 0.1,
  stationaryNoise: 0.01,
  stationaryMeasurementScale: 4,
  stepLengthError: 0.1,
  stepScaleSigma: 0.1,
  headingBiasSigmaDeg: 5,
  headingBiasWalkDeg: 1,
  wallCrossWeight: 0.01,
  gateChi2: 13.8,
  relocalizeAfter: 4,
  maxGapMs: 10000,
  injectFraction: 0,
  injectAboveChi2: 6,
  headingStepNoise: 0.5,
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
  private headingBias: Float64Array
  private stepScale: Float64Array
  private live = false
  private lastTimestamp: number | null = null
  private moving = false
  private floorId: string | null = null
  private rejected: Array<{ e: number, n: number, cov: StepFilterCovariance }> = []

  constructor(private map: WalkableMap, options: Partial<ParticleFilterOptions> = {}) {
    this.options = { ...DEFAULT_PARTICLE_FILTER, ...options }
    this.rng = createRng(this.options.seed)
    this.n = this.options.particles
    this.pe = new Float64Array(this.n)
    this.pn = new Float64Array(this.n)
    this.weight = new Float64Array(this.n)
    this.headingBias = new Float64Array(this.n)
    this.stepScale = new Float64Array(this.n)
  }

  /** Which floor's walls apply. A change scatters the cloud onto open floor of the new floor. */
  setFloor(floorId: string | null) {
    if (floorId === this.floorId) return
    this.floorId = floorId
    const s = this.state()
    if (!s || this.lastTimestamp === null) return
    this.scatter(s.e, s.n, { ee: s.accuracyM ** 2 / 2 + 1, en: 0, nn: s.accuracyM ** 2 / 2 + 1 }, this.lastTimestamp)
  }

  seed(e: number, n: number, accuracyM: number, timestamp: number) {
    const a = Math.max(accuracyM, this.options.minSeedAccuracyM)
    const v = a * a / 2
    this.scatter(e, n, { ee: v, en: 0, nn: v }, timestamp)
  }

  setMoving(moving: boolean) {
    this.moving = moving
  }

  step(lengthM: number, headingDeg: number | null, headingAccuracyDeg: number, timestamp: number) {
    if (!this.live) return
    this.moving = true
    this.predictTo(timestamp)
    const o = this.options
    const fromE = new Float64Array(this.pe)
    const fromN = new Float64Array(this.pn)
    let keptWeight = 0
    let totalWeight = 0
    const crossed = new Uint8Array(this.n)
    for (let i = 0; i < this.n; i++) {
      this.headingBias[i]! += this.rng.gaussian() * o.headingBiasWalkDeg
      const length = lengthM * this.stepScale[i]! * (1 + this.rng.gaussian() * o.stepLengthError)
      // Without a compass the step went somewhere within a circle
      const heading = headingDeg === null
        ? this.rng.uniform() * 360
        : headingDeg + this.headingBias[i]! + this.rng.gaussian() * headingAccuracyDeg * o.headingStepNoise
      this.pe[i] = fromE[i]! + length * Math.sin(heading * RAD)
      this.pn[i] = fromN[i]! + length * Math.cos(heading * RAD)
      totalWeight += this.weight[i]!
      if (this.map.canWalk(this.floorId, { e: fromE[i]!, n: fromN[i]! }, { e: this.pe[i]!, n: this.pn[i]! })) {
        keptWeight += this.weight[i]!
      } else {
        crossed[i] = 1
      }
    }
    // If (nearly) every particle hit a wall, the map is probably missing an opening: ignore it this step
    if (keptWeight < 0.01 * totalWeight) return
    for (let i = 0; i < this.n; i++) if (crossed[i]) this.weight[i]! *= o.wallCrossWeight
    this.normalizeAndResample()
  }

  update(e: number, n: number, accuracyM: number, timestamp: number, covariance?: StepFilterCovariance) {
    const scale = this.moving ? 1 : this.options.stationaryMeasurementScale
    const r = accuracyM * accuracyM / 2
    const cov = covariance
      ? { ee: covariance.ee * scale, en: covariance.en * scale, nn: covariance.nn * scale }
      : { ee: r * scale, en: 0, nn: r * scale }
    if (!this.live || this.lastTimestamp === null || timestamp - this.lastTimestamp > this.options.maxGapMs) {
      this.seed(e, n, Math.max(accuracyM, Math.sqrt(covariance ? covariance.ee + covariance.nn : 2 * r)), timestamp)
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
      if (this.rejected.length >= this.options.relocalizeAfter) this.relocalize(timestamp)
      return
    }
    this.rejected = []
    if (d2 > this.options.injectAboveChi2) this.inject(e, n, covariance ?? { ee: r, en: 0, nn: r })

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
    this.normalizeAndResample()
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
    // The mean of a cloud split by a wall can land in the wall: show the particle nearest to it instead
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

  /** Spreads the particles over a Gaussian around (e, n), keeping to open floor where possible. */
  private scatter(e: number, n: number, cov: StepFilterCovariance, timestamp: number) {
    for (let i = 0; i < this.n; i++) this.draw(i, e, n, cov, 1 / this.n)
    this.live = true
    this.lastTimestamp = timestamp
    this.rejected = []
  }

  /** Redraws `injectFraction` of the particles (at random) around the fix, at the average weight */
  private inject(e: number, n: number, cov: StepFilterCovariance) {
    const count = Math.round(this.options.injectFraction * this.n)
    for (let k = 0; k < count; k++) this.draw(Math.floor(this.rng.uniform() * this.n), e, n, cov, 1 / this.n)
  }

  /** Puts particle i at a random spot of the Gaussian (e, n, cov), on open floor where possible, with fresh errors */
  private draw(i: number, e: number, n: number, cov: StepFilterCovariance, weight: number) {
    // Cholesky of the 2x2 covariance
    const a = Math.sqrt(Math.max(cov.ee, 1e-6))
    const b = cov.en / a
    const c = Math.sqrt(Math.max(cov.nn - b * b, 1e-6))
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
    this.weight[i] = weight
    this.headingBias[i] = this.rng.gaussian() * this.options.headingBiasSigmaDeg
    this.stepScale[i] = 1 + this.rng.gaussian() * this.options.stepScaleSigma
  }

  private predictTo(timestamp: number) {
    const dt = (timestamp - this.lastTimestamp!) / 1000
    if (dt <= 0) return
    const sigma = Math.sqrt((this.moving ? this.options.movingNoise : this.options.stationaryNoise) * dt / 2)
    for (let i = 0; i < this.n; i++) {
      const pe = this.pe[i]! + this.rng.gaussian() * sigma
      const pn = this.pn[i]! + this.rng.gaussian() * sigma
      // Drifting into a wall isn't a move anyone made: stay put instead
      if (this.map.isOpen(this.floorId, pe, pn)) {
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

  /** Normalizes the weights and, once too few particles carry most of the weight, resamples (systematic). */
  private normalizeAndResample() {
    let sum = 0
    for (let i = 0; i < this.n; i++) sum += this.weight[i]!
    if (!(sum > 0)) {
      this.weight.fill(1 / this.n)
      return
    }
    let sumSq = 0
    for (let i = 0; i < this.n; i++) {
      this.weight[i]! /= sum
      sumSq += this.weight[i]! ** 2
    }
    if (1 / sumSq >= this.n / 2) return

    const pe = new Float64Array(this.n)
    const pn = new Float64Array(this.n)
    const bias = new Float64Array(this.n)
    const scale = new Float64Array(this.n)
    const u0 = this.rng.uniform() / this.n
    let cumulative = this.weight[0]!
    let j = 0
    for (let i = 0; i < this.n; i++) {
      const u = u0 + i / this.n
      while (u > cumulative && j < this.n - 1) cumulative += this.weight[++j]!
      pe[i] = this.pe[j]!
      pn[i] = this.pn[j]!
      bias[i] = this.headingBias[j]!
      scale[i] = this.stepScale[j]!
    }
    this.pe = pe
    this.pn = pn
    this.headingBias = bias
    this.stepScale = scale
    this.weight.fill(1 / this.n)
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
    this.scatter(e / we, n / wn, { ee: k / we, en: 0, nn: k / wn }, timestamp)
  }
}
