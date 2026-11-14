import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { findPath, parseGrid, type Cell, type Grid } from './astar'

const PLAIN = { center: false, smooth: false, hWeight: 1 } // the plain shortest path

function length(path: Cell[]) {
  let total = 0
  for (let i = 1; i < path.length; i++) total += Math.hypot(path[i]![0] - path[i - 1]![0], path[i]![1] - path[i - 1]![1])
  return total
}

/** Every step moves to a touching open cell, and diagonals never squeeze between two walls. */
function expectWalkable({ cols, walls }: Grid, path: Cell[]) {
  for (let i = 1; i < path.length; i++) {
    const [r0, c0] = path[i - 1]!
    const [r1, c1] = path[i]!
    expect(walls[r1 * cols + c1], `step ${i} onto a wall`).toBe(0)
    expect(Math.max(Math.abs(r1 - r0), Math.abs(c1 - c0)), `step ${i} skips cells`).toBe(1)
    if (r0 !== r1 && c0 !== c1) expect(walls[r0 * cols + c1] || walls[r1 * cols + c0], `step ${i} cuts a corner`).toBe(0)
  }
}

/** A grid from rows of '#' (wall) and '.' (open). */
function grid(...rows: string[]) {
  return parseGrid(rows.map(row => row.replace(/#/g, '1').replace(/\./g, '0')).join('\n'))
}

describe('findPath', () => {
  it('finds the shortest path with centering and straightening off', () => {
    const g = grid(
      '.....',
      '.###.',
      '.....'
    )
    const path = findPath(g, [0, 0], [2, 4], PLAIN)!
    expect(path[0]).toEqual([0, 0])
    expect(path.at(-1)).toEqual([2, 4])
    expect(length(path)).toBeCloseTo(6, 5) // 4 across + 2 down: no diagonal can cut past the wall's corners
    expectWalkable(g, path)
  })

  it('returns null when the goal is walled off, and rejects walls and cells off the grid', () => {
    const g = grid(
      '..#..',
      '..#..'
    )
    expect(findPath(g, [0, 0], [0, 4])).toBeNull()
    expect(() => findPath(g, [0, 2], [0, 0])).toThrow('Start [0, 2] is a wall.')
    expect(() => findPath(g, [0, 0], [5, 0])).toThrow('outside the grid')
  })

  it('pulls the route toward the middle of a wide hallway', () => {
    const hallway = grid(
      '##############################',
      ...Array.from({ length: 13 }, () => '#............................#'),
      '##############################'
    )
    const start: Cell = [1, 1] // both ends hug the top wall
    const goal: Cell = [1, 28]
    const plain = findPath(hallway, start, goal, PLAIN)!
    const centered = findPath(hallway, start, goal, { smooth: false })!
    expect(Math.max(...plain.map(([r]) => r))).toBe(1) // the shortest path runs along the wall
    expect(Math.max(...centered.map(([r]) => r))).toBeGreaterThan(3) // the centered one moves away from it
    expectWalkable(hallway, centered)
    expectWalkable(hallway, findPath(hallway, start, goal)!) // straightened: still walkable
  })

  it('matches scripts/navigation.py on the real level 1 grid (re-run the script after changing either)', () => {
    const spn = parseGrid(readFileSync('public/data/SPN-level1.txt', 'utf8'))
    const toCells = (text: string) => text.trim().split('\n').map(line => line.split(',').map(Number) as Cell)
    const [start, goal] = toCells(readFileSync('scripts/nav_io/coords.txt', 'utf8'))
    const expected = toCells(readFileSync('scripts/nav_io/path.txt', 'utf8'))

    const path = findPath(spn, start!, goal!)!
    expect(path).toEqual(expected)
    expectWalkable(spn, path)
    expect(length(path) / length(findPath(spn, start!, goal!, PLAIN)!)).toBeLessThan(1.2) // within 20% of the shortest route
  })
})
