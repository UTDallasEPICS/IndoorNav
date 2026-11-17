import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sampleVenue } from '../fixtures/sampleVenue'
import { FusionEngine } from '../fusion/FusionEngine'
import { enuToWgs84 } from '../geo/wgs84'
import type { LocationFix } from '../types'
import { JsonlDebugLog, MemoryDebugLog, NO_DEBUG_LOG } from './debugLog'

const bleFix = (e: number, n: number, timestamp: number): LocationFix => {
  const enu = { e, n, u: 0 }
  return { enu, wgs84: enuToWgs84(enu, sampleVenue.origin), floorId: 'test-l1', buildingId: 'test-bldg', accuracyM: 2, timestamp, source: 'ble', isIndoor: true }
}

describe('JsonlDebugLog', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('writes buffered records as JSON lines, on a timer, with numbers rounded', async () => {
    const written: string[] = []
    const log = new JsonlDebugLog(async (text) => { written.push(text) }, { flushMs: 1000, decimals: 2 }, () => 42)
    log.log('step', { lengthM: 0.712345, headingDeg: 90, timestamp: 1700000000123 })
    log.log('out', { e: 1.005 })
    expect(written).toEqual([])
    await vi.advanceTimersByTimeAsync(1000)
    expect(written).toHaveLength(1)
    const lines = written[0]!.trimEnd().split('\n').map((l) => JSON.parse(l))
    expect(lines).toEqual([
      { at: 42, kind: 'step', lengthM: 0.71, headingDeg: 90, timestamp: 1700000000123 },
      { at: 42, kind: 'out', e: 1 }
    ])
    await log.close()
  })

  it('flushes early once the buffer is full, keeps writes in order, and writes the rest on close', async () => {
    const written: string[] = []
    let release!: () => void
    const firstWrite = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    const log = new JsonlDebugLog(async (text) => {
      if (calls++ === 0) await firstWrite // a slow first write must not let the second overtake it
      written.push(text)
    }, { flushMs: 60_000, maxBufferedLines: 2 })
    log.log('a')
    log.log('b') // full: starts the (slow) first write
    log.log('c')
    const closing = log.close()
    release()
    await closing
    expect(written.join('').trimEnd().split('\n').map((l) => JSON.parse(l).kind)).toEqual(['a', 'b', 'c'])
    log.log('after close')
    await log.flush()
    expect(written.join('')).not.toContain('after close')
  })

  it('counts lines lost to failed writes instead of throwing', async () => {
    const log = new JsonlDebugLog(async () => { throw new Error('disk full') }, { flushMs: 60_000 })
    log.log('a')
    log.log('b')
    await expect(log.close()).resolves.toBeUndefined()
    expect(log.failedLines).toBe(2)
  })
})

describe('location debug log', () => {
  it('is off unless given', () => {
    expect(NO_DEBUG_LOG.enabled).toBe(false)
    expect(() => NO_DEBUG_LOG.log('anything', { x: 1 })).not.toThrow()
  })

  it('records the fusion engine’s filter choice, inputs it acted on, its decisions and what it showed', () => {
    const log = new MemoryDebugLog()
    const engine = new FusionEngine(sampleVenue, {}, log) // no route grid: StepKalman
    engine.ingestMotion({ timestamp: 0, isMoving: false, headingDeg: 90, headingAccuracyDeg: 10 })
    engine.ingest(bleFix(130, 65, 0)) // motion sensors live: seeds the step filter
    engine.ingest(bleFix(130.2, 65, 400))
    engine.ingestStep({ timestamp: 500, lengthM: 0.7, headingDeg: 90, headingAccuracyDeg: 10 })
    engine.ingest(bleFix(130.9, 65, 1000))
    engine.ingest(bleFix(160, 65, 1500)) // 30 m off: gated

    expect(log.of('fusion.filter')[0]).toMatchObject({ stepFilter: 'kalman', gridFloors: [] })
    expect(log.of('fusion.seed')).toHaveLength(1)
    const updates = log.of('kf.update')
    expect(updates.map((u) => u.gated)).toEqual([false, false, true])
    expect(updates.at(-1)).toMatchObject({ rejectedInRow: 1 })
    const out = log.of('out')
    expect(out.length).toBeGreaterThan(0)
    expect(out.at(-1)).toMatchObject({ filter: 'kalman', floorId: 'test-l1' })
  })
})
