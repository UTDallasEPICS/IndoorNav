import { describe, expect, it } from 'vitest'
import { clearOpenAreas, openAreaOutlines, type RoomRecord } from './openAreas'

// 40 x 40 grid whose map 0–1 edges are the grid edges. A room from map (0.25, 0.25) to (0.75, 0.75) = cells 10..30,
// walled on its outline, with desks inside; a desk outside the room too.
function grid() {
  const rows = 40
  const cols = 40
  const walls = new Uint8Array(rows * cols)
  const set = (r: number, c: number) => { walls[r * cols + c] = 1 }
  for (let i = 10; i <= 30; i++) { set(10, i); set(30, i); set(i, 10); set(i, 30) }
  for (let r = 18; r <= 22; r++) for (let c = 15; c <= 25; c++) set(r, c) // desks in the room
  for (let r = 2; r <= 4; r++) for (let c = 2; c <= 4; c++) set(r, c) // desk outside it
  return { rows, cols, walls }
}
const bounds = { top: 0, bottom: 40, left: 0, right: 40 }
const room: [number, number][] = [[0.25, 0.25], [0.75, 0.25], [0.75, 0.75], [0.25, 0.75]]
const at = (g: { cols: number, walls: Uint8Array }, r: number, c: number) => g.walls[r * g.cols + c]

describe('clearOpenAreas', () => {
  it('clears desks inside the area, keeps its walls and everything outside', () => {
    const before = grid()
    const after = clearOpenAreas(before, bounds, [room], 2)
    expect(at(after, 20, 20)).toBe(0) // desk inside: cleared
    expect(at(after, 10, 20)).toBe(1) // the room's wall
    expect(at(after, 20, 30)).toBe(1)
    expect(at(after, 3, 3)).toBe(1) // desk outside: kept
    expect(after.cleared).toBe(5 * 11)
    expect(at(before, 20, 20)).toBe(1) // the input (shared with routing) is untouched
  })

  it('keeps desks within keepEdgeCells of the outline', () => {
    const g = grid()
    g.walls[11 * g.cols + 20] = 1 // a desk against the wall, 1 cell in
    expect(at(clearOpenAreas(g, bounds, [room], 2), 11, 20)).toBe(1)
    expect(at(clearOpenAreas(g, bounds, [room], 0), 11, 20)).toBe(0)
  })
})

describe('openAreaOutlines', () => {
  it('picks the listed rooms by name and reports the ones without an outline', () => {
    const rooms: RoomRecord[] = [
      { number: '2.223', name: 'OPEN OFFICE', x: 0.5, y: 0.5, outline: room },
      { number: '2.120', name: 'Open Office ', x: 0.2, y: 0.2 },
      { number: '2.101', name: 'OFFICE', x: 0.1, y: 0.1, outline: room }
    ]
    expect(openAreaOutlines(rooms)).toEqual({ outlines: [room], missing: ['2.120'] })
    expect(openAreaOutlines(rooms, ['office']).outlines).toEqual([room])
  })
})
