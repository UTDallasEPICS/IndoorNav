import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { detectTurns } from './turn-detection'

type Cell = [number, number]

/** A path that walks `steps` cells at a time in each direction: 'down' = row + 1, 'right' = col + 1, etc. */
function walk(start: Cell, ...legs: [('up' | 'down' | 'left' | 'right'), number][]): Cell[] {
  const move = { up: [-1, 0], down: [1, 0], left: [0, -1], right: [0, 1] } as const
  const path: Cell[] = [start]
  for (const [dir, steps] of legs) {
    for (let i = 0; i < steps; i++) {
      const [r, c] = path[path.length - 1]!
      path.push([r + move[dir][0], c + move[dir][1]])
    }
  }
  return path
}

describe('detectTurns', () => {
  it('finds no turns on a straight path', () => {
    expect(detectTurns(walk([0, 0], ['down', 40]))).toEqual([])
  })

  it('finds no turns on a path too short to compare', () => {
    expect(detectTurns(walk([0, 0], ['down', 5], ['right', 5]))).toEqual([])
  })

  it('names turns as the walker sees them (row grows down the screen, col grows right)', () => {
    // Walking down the screen (south), then toward the screen's right (east): east is on your left
    const [turn] = detectTurns(walk([0, 0], ['down', 20], ['right', 20]))
    expect(turn).toMatchObject({ index: 20, direction: 'left' })
    expect(turn!.angle).toBeCloseTo(90)
    // Walking up the screen (north), then toward the screen's right (east): a right turn
    expect(detectTurns(walk([40, 0], ['up', 20], ['right', 20]))[0]).toMatchObject({ index: 20, direction: 'right' })
  })

  it('reports each corner once', () => {
    const turns = detectTurns(walk([40, 0], ['up', 20], ['right', 20], ['up', 20]))
    expect(turns.map(t => [t.index, t.direction])).toEqual([[20, 'right'], [40, 'left']])
  })

  it('matches scripts/turn_detection.py on its sample path (re-run the script after changing either)', () => {
    const toNumbers = (line: string) => line.match(/-?\d+(?:\.\d+)?/g)!.map(Number)
    const path = readFileSync('scripts/nav_io/path.txt', 'utf8').trim().split('\n').map(line => toNumbers(line).slice(0, 2) as Cell)
    const expected = readFileSync('scripts/nav_io/turns.txt', 'utf8').trim().split('\n').map(line => { // "360,283 RIGHT 54.2"
      const [row, col, angle] = toNumbers(line)
      return { cell: [row, col], direction: line.includes('LEFT') ? 'left' : 'right', angle }
    })
    const turns = detectTurns(path).map(t => ({ cell: path[t.index], direction: t.direction, angle: Math.round(t.angle * 10) / 10 }))
    expect(turns).toEqual(expected)
  })
})
