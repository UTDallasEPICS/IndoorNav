// Where people can walk, in ENU: answers "is this spot open floor?" and "can you walk straight from here to
// there without going through a wall?" from each floor's route grid. Floors without a grid are all open.

import { enuToPlan } from '../geo/floorTransform'
import type { Floor, FloorGrid, VenueConfig } from '../types'

export interface WalkableMap {
  /** Whether (e, n) is open floor. True off the grid and on floors without one. */
  isOpen(floorId: string | null, e: number, n: number): boolean
  /** Whether a straight walk from a to b stays on open floor */
  canWalk(floorId: string | null, a: { e: number, n: number }, b: { e: number, n: number }): boolean
  /** Whether this floor has a grid at all */
  hasFloor(floorId: string | null): boolean
}

interface FloorCells {
  grid: FloorGrid
  /** ENU (e, n) -> fractional [row, col] */
  toCell: (e: number, n: number) => { row: number, col: number }
  /** Grid cells per meter, for picking the sampling step along a walk */
  cellsPerM: number
}

function floorCells(floor: Floor): FloorCells | null {
  const grid = floor.walkGrid
  if (!grid || !floor.plan) return null
  const { top, bottom, left, right } = grid.bounds
  const { width, height } = floor.plan
  const t = floor.transform
  return {
    grid,
    toCell: (e, n) => {
      const p = enuToPlan({ e, n }, t)
      return { row: top + (p.y / height) * (bottom - top), col: left + (p.x / width) * (right - left) }
    },
    cellsPerM: ((right - left) / width) / t.scale
  }
}

export function createWalkableMap(venue: VenueConfig): WalkableMap {
  const floors = new Map<string, FloorCells>()
  for (const building of venue.buildings) {
    for (const floor of building.floors) {
      const cells = floorCells(floor)
      if (cells) floors.set(floor.id, cells)
    }
  }

  const wallAt = (f: FloorCells, row: number, col: number) => {
    const r = Math.floor(row)
    const c = Math.floor(col)
    if (r < 0 || c < 0 || r >= f.grid.rows || c >= f.grid.cols) return false
    return f.grid.walls[r * f.grid.cols + c] === 1
  }

  return {
    hasFloor: (floorId) => floorId !== null && floors.has(floorId),
    isOpen(floorId, e, n) {
      const f = floorId === null ? undefined : floors.get(floorId)
      if (!f) return true
      const { row, col } = f.toCell(e, n)
      return !wallAt(f, row, col)
    },
    canWalk(floorId, a, b) {
      const f = floorId === null ? undefined : floors.get(floorId)
      if (!f) return true
      const p = f.toCell(a.e, a.n)
      const q = f.toCell(b.e, b.n)
      // Sample every half cell, so a one-cell wall can't be stepped over
      const samples = Math.max(1, Math.ceil(2 * Math.max(Math.abs(q.row - p.row), Math.abs(q.col - p.col))))
      for (let i = 1; i <= samples; i++) {
        const s = i / samples
        if (wallAt(f, p.row + s * (q.row - p.row), p.col + s * (q.col - p.col))) return false
      }
      return true
    }
  }
}

/** The venue with route grids attached to its floors, by level (e.g. { 1: { grid, bounds } }). Floors not listed are unchanged. */
export function withFloorGrids(
  venue: VenueConfig,
  grids: Record<number, { grid: { rows: number, cols: number, walls: Uint8Array }, bounds: FloorGrid['bounds'] }>
): VenueConfig {
  return {
    ...venue,
    buildings: venue.buildings.map((building) => ({
      ...building,
      floors: building.floors.map((floor) => {
        const g = grids[floor.level]
        return g ? { ...floor, walkGrid: { ...g.grid, bounds: g.bounds } } : floor
      })
    }))
  }
}
