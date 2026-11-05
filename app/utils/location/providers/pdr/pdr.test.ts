import { describe, expect, it } from 'vitest'
import { sampleVenue } from '../../fixtures/sampleVenue'
import type { MotionState, PdrStep, ProviderStatus } from '../../types'
import { headingFromOrientation, HeadingSmoother } from './heading'
import { MockMotionSource, type AccelSample } from './motionSource'
import { PdrProvider } from './PdrProvider'
import { StepDetector } from './stepDetector'

/** 50 Hz accelerometer: `stepsPerSecond` bumps of `amplitude` on top of gravity, for `seconds` */
function walkSamples(seconds: number, stepsPerSecond: number, amplitude = 3, start = 0): AccelSample[] {
  const samples: AccelSample[] = []
  for (let ms = 0; ms <= seconds * 1000; ms += 20) {
    const bump = amplitude * Math.sin(2 * Math.PI * stepsPerSecond * ms / 1000)
    samples.push({ x: 0.2, y: -0.1, z: 9.81 + bump, timestamp: start + ms })
  }
  return samples
}

describe('StepDetector', () => {
  it('counts one step per acceleration bump', () => {
    const detector = new StepDetector()
    const steps = walkSamples(10, 1.8).map((s) => detector.add(s)).filter(Boolean)
    expect(steps.length).toBeGreaterThanOrEqual(16)
    expect(steps.length).toBeLessThanOrEqual(18)
  })

  it('estimates a walking step length', () => {
    const detector = new StepDetector()
    const steps = walkSamples(10, 1.8).map((s) => detector.add(s)).filter((s) => s !== null)
    for (const step of steps.slice(2)) {
      expect(step.lengthM).toBeGreaterThan(0.5)
      expect(step.lengthM).toBeLessThan(0.9)
    }
  })

  it('ignores a phone held still or jiggled gently', () => {
    const detector = new StepDetector()
    const steps = walkSamples(10, 3, 0.5).map((s) => detector.add(s)).filter(Boolean)
    expect(steps).toHaveLength(0)
  })
})

describe('heading', () => {
  it('points the top of a flat phone: alpha 0 is north, alpha 90 is west', () => {
    expect(headingFromOrientation(0, 0, 0)).toBeCloseTo(0)
    expect(headingFromOrientation(90, 0, 0)).toBeCloseTo(270)
  })

  it('keeps the same heading when the phone tilts up toward the user', () => {
    expect(headingFromOrientation(90, 45, 0)).toBeCloseTo(270)
    expect(headingFromOrientation(90, 90, 0)).toBeCloseTo(270) // upright, camera forward
  })

  it('averages across north without flipping to south', () => {
    const smoother = new HeadingSmoother(100)
    smoother.add(350, 0)
    smoother.add(10, 100)
    smoother.add(350, 200)
    smoother.add(10, 300)
    const h = smoother.headingDeg!
    expect(Math.min(h, 360 - h)).toBeLessThan(10)
  })
})

describe('PdrProvider', () => {
  async function setup() {
    const source = new MockMotionSource()
    const provider = new PdrProvider(source)
    const steps: PdrStep[] = []
    const states: MotionState[] = []
    provider.onStep((s) => steps.push(s))
    provider.onMotion((s) => states.push(s))
    await provider.start({ ...sampleVenue, magneticDeclinationDeg: 3 })
    return { source, steps, states }
  }

  it('emits steps with the compass heading corrected to true north', async () => {
    const { source, steps } = await setup()
    for (const sample of walkSamples(5, 2)) {
      if (sample.timestamp % 100 === 0) source.emitCompass({ headingDeg: 87, accuracyDeg: 10, timestamp: sample.timestamp })
      source.emitAccel(sample)
    }
    expect(steps.length).toBeGreaterThan(5)
    expect(steps.at(-1)!.headingDeg).toBeCloseTo(90)
    expect(steps.at(-1)!.headingAccuracyDeg).toBe(10)
  })

  it('reports moving while stepping and still after stopping', async () => {
    const { source, states } = await setup()
    for (const sample of walkSamples(5, 2)) source.emitAccel(sample)
    expect(states.at(-1)!.isMoving).toBe(true)
    for (const sample of walkSamples(3, 2, 0, 5020)) source.emitAccel(sample)
    expect(states.at(-1)!.isMoving).toBe(false)
  })

  it('gives steps without a heading when there is no compass', async () => {
    const { source, steps } = await setup()
    for (const sample of walkSamples(3, 2)) source.emitAccel(sample)
    expect(steps.length).toBeGreaterThan(0)
    expect(steps.every((s) => s.headingDeg === null)).toBe(true)
  })

  it('reports a denied permission as status instead of throwing', async () => {
    const source = new MockMotionSource()
    source.failWith = new Error('Motion permission denied')
    const provider = new PdrProvider(source)
    const statuses: ProviderStatus[] = []
    provider.onStatus((s) => statuses.push(s))
    await provider.start(sampleVenue)
    expect(statuses.at(-1)).toMatchObject({ provider: 'pdr', state: 'permission-denied' })
  })
})
