import { describe, expect, it } from 'vitest'
import { legendRows, resolveLegend, type LegendEntry, type Room } from './legend'

const square: [number, number][] = [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2], [0.1, 0.2]]
const rooms: Room[] = [
  { number: '1.1', name: 'LOBBY', x: 0.5, y: 0.5, floor: 1, outline: square },
  { number: '1.1', name: 'STAIRS', x: 0.3, y: 0.3, floor: 1 }, // same number, different room
  { number: '2.1V1', name: 'ELEV', x: 0.4, y: 0.6, floor: 2 } // no outline
]
const entry = (over: Partial<LegendEntry>): LegendEntry =>
  ({ number: '1.1', name: 'LOBBY', label: 'Lobby', color: '#f2b53a', type: 'area', legend: true, ...over })

describe('resolveLegend', () => {
  it('gives an area the room outline, matched by number and name', () => {
    const { areas, points } = resolveLegend([entry({})], rooms)
    expect(areas).toEqual([{ ...entry({}), floor: 1, outline: square }])
    expect(points).toEqual([])
  })

  it('gives a point the room position and floor', () => {
    const { points } = resolveLegend([entry({ number: '2.1V1', name: 'ELEV', type: 'point' })], rooms)
    expect(points[0]).toMatchObject({ x: 0.4, y: 0.6, floor: 2 })
  })

  it('draws an area as a point when the room has no outline', () => {
    const { areas, points } = resolveLegend([entry({ name: 'STAIRS' })], rooms)
    expect(areas).toEqual([])
    expect(points[0]).toMatchObject({ type: 'point', x: 0.3, y: 0.3 })
  })

  it('uses the entry outline when the room has none', () => {
    const own: [number, number][] = [[0.3, 0.3], [0.4, 0.3], [0.4, 0.4]]
    const { areas } = resolveLegend([entry({ name: 'STAIRS', outline: own })], rooms)
    expect(areas[0]).toMatchObject({ floor: 1, outline: own })
  })

  it('reports entries whose room is not found', () => {
    const typo = entry({ name: 'LOBY' })
    expect(resolveLegend([typo], rooms).missing).toEqual([typo])
  })
})

describe('legendRows', () => {
  it('keeps legend: true entries, one row per label, in order', () => {
    const rows = legendRows([
      entry({ label: 'Restrooms', color: '#4f8fd6' }),
      entry({ label: 'Hidden', legend: false }),
      entry({ label: 'Restrooms', color: '#000000' }),
      entry({ label: 'Exits', type: 'point' })
    ])
    expect(rows).toEqual([
      { label: 'Restrooms', color: '#4f8fd6', type: 'area' },
      { label: 'Exits', color: '#f2b53a', type: 'point' }
    ])
  })
})
