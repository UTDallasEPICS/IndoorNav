
<template>
  <div class="app">
    <!-- Header -->
    <header class="header">
      <div>
        <h1>Indoor Navigation</h1>
        <p>SPN — Synergy Park North · Level 1</p>
      </div>

      <div class="controls">
        <button @click="zoomOut">−</button>
        <span>{{ Math.round(zoom * 100) }}%</span>
        <button @click="zoomIn">+</button>
        <button @click="resetView">Home</button>
      </div>
    </header>

    <!-- Map -->
    <main
      ref="mapContainer"
      class="map-container"
      @wheel.prevent="handleWheel"
      @mousedown="startPan"
      @mousemove="pan"
      @mouseup="stopPan"
      @mouseleave="stopPan"
    >
      <canvas
        ref="canvas"
        :style="{
          transform: `translate(${offsetX}px, ${offsetY}px) scale(${zoom})`
        }"
      />

      <div v-if="loading" class="loading">
        Loading SPN map...
      </div>

      <div v-if="error" class="error">
        {{ error }}
      </div>
    </main>

    <!-- Legend -->
    <footer class="legend">
      <div>
        <span class="legend-box walkable"></span>
        Walkable
      </div>

      <div>
        <span class="legend-box wall"></span>
        Wall / Outside
      </div>
    </footer>
  </div>
</template>

<script setup>
import { ref, onMounted, nextTick } from 'vue'

const canvas = ref(null)
const mapContainer = ref(null)

const loading = ref(true)
const error = ref('')

const grid = ref([])

const zoom = ref(1)
const offsetX = ref(0)
const offsetY = ref(0)

const isPanning = ref(false)
const lastMouseX = ref(0)
const lastMouseY = ref(0)

// Smaller cell size because the real map is 478 × 226
const CELL_SIZE = 4

async function loadMap() {
  try {
    loading.value = true

    const response = await fetch('/data/spn-level1-grid.json')

    if (!response.ok) {
      throw new Error('Could not load SPN map')
    }

    grid.value = await response.json()

    await nextTick()

    drawMap()
    fitMap()

  } catch (err) {
    console.error(err)
    error.value = 'Failed to load the SPN Level 1 map.'
  } finally {
    loading.value = false
  }
}

function drawMap() {
  if (!canvas.value || !grid.value.length) return

  const ctx = canvas.value.getContext('2d')

  const rows = grid.value.length
  const cols = grid.value[0].length

  canvas.value.width = cols * CELL_SIZE
  canvas.value.height = rows * CELL_SIZE

  ctx.clearRect(
    0,
    0,
    canvas.value.width,
    canvas.value.height
  )

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {

      const cell = grid.value[row][col]

      if (cell === 1) {
        // Traversable space
        ctx.fillStyle = '#f5f5f5'
      } else {
        // Wall / outside
        ctx.fillStyle = '#202020'
      }

      ctx.fillRect(
        col * CELL_SIZE,
        row * CELL_SIZE,
        CELL_SIZE,
        CELL_SIZE
      )
    }
  }
}

function fitMap() {
  if (!mapContainer.value || !canvas.value) return

  const containerWidth = mapContainer.value.clientWidth
  const containerHeight = mapContainer.value.clientHeight

  const mapWidth = canvas.value.width
  const mapHeight = canvas.value.height

  const scaleX = containerWidth / mapWidth
  const scaleY = containerHeight / mapHeight

  // Leave a little padding around the map
  zoom.value = Math.min(scaleX, scaleY) * 0.9

  offsetX.value =
    (containerWidth - mapWidth * zoom.value) / 2

  offsetY.value =
    (containerHeight - mapHeight * zoom.value) / 2
}

function zoomIn() {
  zoom.value *= 1.2
}

function zoomOut() {
  zoom.value /= 1.2
}

function resetView() {
  fitMap()
}

function handleWheel(event) {
  const direction = event.deltaY < 0 ? 1.1 : 0.9

  zoom.value *= direction
}

function startPan(event) {
  isPanning.value = true

  lastMouseX.value = event.clientX
  lastMouseY.value = event.clientY
}

function pan(event) {
  if (!isPanning.value) return

  const dx = event.clientX - lastMouseX.value
  const dy = event.clientY - lastMouseY.value

  offsetX.value += dx
  offsetY.value += dy

  lastMouseX.value = event.clientX
  lastMouseY.value = event.clientY
}

function stopPan() {
  isPanning.value = false
}

onMounted(() => {
  loadMap()

  window.addEventListener('resize', fitMap)
})
</script>

<style scoped>
* {
  box-sizing: border-box;
}

.app {
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background: #111;
  color: white;
  display: flex;
  flex-direction: column;
}

/* ---------------- HEADER ---------------- */

.header {
  height: 80px;
  padding: 0 24px;

  display: flex;
  align-items: center;
  justify-content: space-between;

  background: #181818;
  border-bottom: 1px solid #333;

  z-index: 10;
}

.header h1 {
  margin: 0;
  font-size: 22px;
}

.header p {
  margin: 4px 0 0;
  color: #aaa;
  font-size: 14px;
}

/* ---------------- CONTROLS ---------------- */

.controls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.controls button {
  background: #292929;
  border: 1px solid #444;
  color: white;

  padding: 8px 12px;
  border-radius: 6px;

  cursor: pointer;
}

.controls button:hover {
  background: #3a3a3a;
}

.controls span {
  min-width: 55px;
  text-align: center;
  color: #ccc;
}

/* ---------------- MAP ---------------- */

.map-container {
  position: relative;

  flex: 1;

  overflow: hidden;

  background: #0b0b0b;

  cursor: grab;
}

.map-container:active {
  cursor: grabbing;
}

canvas {
  position: absolute;

  top: 0;
  left: 0;

  transform-origin: 0 0;

  image-rendering: pixelated;

  user-select: none;
}

/* ---------------- LOADING ---------------- */

.loading,
.error {
  position: absolute;

  top: 50%;
  left: 50%;

  transform: translate(-50%, -50%);

  padding: 16px 24px;

  background: rgba(0, 0, 0, 0.8);

  border-radius: 8px;

  color: white;
}

.error {
  color: #ff6b6b;
}

/* ---------------- LEGEND ---------------- */

.legend {
  height: 50px;

  display: flex;
  align-items: center;
  gap: 24px;

  padding: 0 24px;

  background: #181818;

  border-top: 1px solid #333;

  font-size: 13px;
}

.legend div {
  display: flex;
  align-items: center;
  gap: 8px;
}

.legend-box {
  width: 16px;
  height: 16px;

  display: inline-block;

  border: 1px solid #555;
}

.walkable {
  background: #f5f5f5;
}

.wall {
  background: #202020;
}
</style>