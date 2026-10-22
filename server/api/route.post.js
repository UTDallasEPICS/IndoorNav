// POST /api/route  { start: { x, y }, destination: { x, y } }  ->  { path: [[row, col], ...] }
// Writes the two points to scripts/nav_io/coords.txt, runs scripts/navigation.py (A*),
// and returns what it wrote to path.txt. x/y are map fractions (0–1), like the rooms' x/y.
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { mapToCell } from '#shared/grid-map'

const run = promisify(execFile)

// Relative to the project root, where `nuxt dev` runs (scripts/ isn't part of a build)
const SCRIPT = resolve(process.cwd(), 'scripts/navigation.py')
const NAV_IO = resolve(process.cwd(), 'scripts/nav_io')

// How far (in grid cells, about 15 cm each) to look for open floor around a room's
// label, since labels often sit on a wall line or on leftover text in the grid
const SNAP_RADIUS = 15

export default defineEventHandler(async event => {
  const { start, destination } = await readBody(event)
  if (!isPoint(start) || !isPoint(destination)) {
    throw createError({ statusCode: 400, message: 'start and destination need x and y between 0 and 1.' })
  }

  const grid = await loadGrid()
  const startCell = nearestOpenCell(grid, mapToCell(start))
  const goalCell = nearestOpenCell(grid, mapToCell(destination))
  if (!startCell || !goalCell) {
    throw createError({ statusCode: 422, message: `No open floor near the ${startCell ? 'destination' : 'start'}.` })
  }

  await writeFile(resolve(NAV_IO, 'coords.txt'), `${startCell.join(',')}\n${goalCell.join(',')}\n`)

  try {
    await run(process.env.PYTHON ?? 'python3', [SCRIPT, '--no-plot'], { timeout: 30_000 })
  } catch (err) {
    // navigation.py exits with a message on stderr, e.g. "No path exists ..."
    throw createError({ statusCode: 422, message: err.stderr?.trim() || 'The route finder failed.' })
  }

  const text = await readFile(resolve(NAV_IO, 'path.txt'), 'utf8')
  const path = text.trim().split('\n').map(line => line.split(',').map(Number))
  return { path }
})

function isPoint(point) {
  return [point?.x, point?.y].every(n => typeof n === 'number' && n >= 0 && n <= 1)
}

// SPN.txt as an array of strings, one per row, '0' = open and '1' = wall
async function loadGrid() {
  const text = await readFile(resolve(NAV_IO, 'SPN.txt'), 'utf8')
  return text.split('\n').filter(line => line.trim()).map(line => line.replace(/[\s,]/g, ''))
}

// The closest open cell to [row, col], searching outwards ring by ring
function nearestOpenCell(grid, [row, col]) {
  const isOpen = (r, c) => grid[r]?.[c] === '0'

  for (let d = 0; d <= SNAP_RADIUS; d++) {
    for (let r = row - d; r <= row + d; r++) {
      for (let c = col - d; c <= col + d; c++) {
        const onRing = Math.abs(r - row) === d || Math.abs(c - col) === d
        if (onRing && isOpen(r, c)) return [r, c]
      }
    }
  }
  return null
}
