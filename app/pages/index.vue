<template>
  <div class="app">
    <!-- Header -->
    <header class="header">
      <div>
        <h1>Indoor Navigation</h1>
        <p>SPN — Synergy Park North · Level 1</p>
      </div>

      <div class="controls">
        <button @click="zoomOut" aria-label="Zoom out">−</button>
        <span>{{ Math.round(zoomPercent) }}%</span>
        <button @click="zoomIn" aria-label="Zoom in">+</button>
        <button @click="resetView">Home</button>
      </div>
    </header>

    <!-- Map -->
    <main
      ref="mapContainer"
      class="map-container"
      @wheel.prevent="handleWheel"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    >
      <!-- Floor plan exported from the CAD drawing (scripts/cad-to-svg.py) -->
      <img
        ref="mapImage"
        src="/maps/spn-level1.svg"
        alt="SPN Level 1 floor plan"
        class="floor-plan"
        draggable="false"
        :style="{
          width: `${imageWidth * scale}px`,
          height: `${imageHeight * scale}px`,
          transform: `translate(${offsetX}px, ${offsetY}px)`
        }"
        @load="onImageLoad"
        @error="onImageError"
      >

      <div v-if="loading" class="loading">
        Loading SPN map...
      </div>

      <div v-if="error" class="error">
        {{ error }}
      </div>
    </main>

    <!-- Hint -->
    <footer class="legend">
      Pinch or scroll to zoom · Drag to move
    </footer>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'

const mapContainer = ref(null)
const mapImage = ref(null)

const loading = ref(true)
const error = ref('')

// Natural size of the SVG, read once it has loaded
const imageWidth = ref(0)
const imageHeight = ref(0)

// scale = rendered size / natural size. fitScale is the scale that fits
// the whole floor into the screen, and counts as "100%".
const scale = ref(1)
const fitScale = ref(1)
const offsetX = ref(0)
const offsetY = ref(0)

const MIN_ZOOM = 0.5 // relative to fitScale
const MAX_ZOOM = 40

const zoomPercent = computed(() => (scale.value / fitScale.value) * 100)

function onImageLoad() {
  imageWidth.value = mapImage.value.naturalWidth
  imageHeight.value = mapImage.value.naturalHeight
  loading.value = false
  fitMap()
}

function onImageError() {
  loading.value = false
  error.value = 'Failed to load the SPN Level 1 map.'
}

function fitMap() {
  if (!mapContainer.value || !imageWidth.value) return

  const { clientWidth, clientHeight } = mapContainer.value

  // Leave a little padding around the map
  fitScale.value =
    Math.min(clientWidth / imageWidth.value, clientHeight / imageHeight.value) * 0.95
  scale.value = fitScale.value

  offsetX.value = (clientWidth - imageWidth.value * scale.value) / 2
  offsetY.value = (clientHeight - imageHeight.value * scale.value) / 2
}

// Zoom by `factor`, keeping the point (x, y) of the container fixed on screen
function zoomAt(factor, x, y) {
  const min = fitScale.value * MIN_ZOOM
  const max = fitScale.value * MAX_ZOOM
  const newScale = Math.min(max, Math.max(min, scale.value * factor))
  const applied = newScale / scale.value

  offsetX.value = x - (x - offsetX.value) * applied
  offsetY.value = y - (y - offsetY.value) * applied
  scale.value = newScale
}

function zoomAtCenter(factor) {
  const { clientWidth, clientHeight } = mapContainer.value
  zoomAt(factor, clientWidth / 2, clientHeight / 2)
}

function zoomIn() {
  zoomAtCenter(1.25)
}

function zoomOut() {
  zoomAtCenter(1 / 1.25)
}

function resetView() {
  fitMap()
}

// Converts a pointer/wheel event to coordinates inside the map container
function toLocal(event) {
  const rect = mapContainer.value.getBoundingClientRect()
  return { x: event.clientX - rect.left, y: event.clientY - rect.top }
}

function handleWheel(event) {
  const { x, y } = toLocal(event)
  // exp() gives smooth zooming for both mouse wheels and trackpads
  zoomAt(Math.exp(-event.deltaY * 0.0015), x, y)
}

// ---- Drag to pan (1 finger / mouse) and pinch to zoom (2 fingers) ----

const pointers = new Map() // pointerId -> { x, y }
let lastPinch = null // { distance, midX, midY }

function pinchInfo() {
  const [a, b] = [...pointers.values()]
  return {
    distance: Math.hypot(b.x - a.x, b.y - a.y),
    midX: (a.x + b.x) / 2,
    midY: (a.y + b.y) / 2
  }
}

function onPointerDown(event) {
  mapContainer.value.setPointerCapture(event.pointerId)
  pointers.set(event.pointerId, toLocal(event))
  if (pointers.size === 2) lastPinch = pinchInfo()
}

function onPointerMove(event) {
  const previous = pointers.get(event.pointerId)
  if (!previous) return

  const current = toLocal(event)
  pointers.set(event.pointerId, current)

  if (pointers.size === 1) {
    offsetX.value += current.x - previous.x
    offsetY.value += current.y - previous.y
  } else if (pointers.size === 2 && lastPinch) {
    const pinch = pinchInfo()
    // Move with the fingers, then zoom around their midpoint
    offsetX.value += pinch.midX - lastPinch.midX
    offsetY.value += pinch.midY - lastPinch.midY
    zoomAt(pinch.distance / lastPinch.distance, pinch.midX, pinch.midY)
    lastPinch = pinch
  }
}

function onPointerUp(event) {
  pointers.delete(event.pointerId)
  lastPinch = pointers.size === 2 ? pinchInfo() : null
}

onMounted(() => {
  // The server-rendered <img> may finish loading before Vue attaches @load
  if (mapImage.value?.complete && mapImage.value.naturalWidth) onImageLoad()

  window.addEventListener('resize', fitMap)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', fitMap)
})
</script>

<style scoped>
* {
  box-sizing: border-box;
}

.app {
  width: 100vw;
  height: 100vh;
  height: 100dvh; /* excludes the mobile browser's address bar */
  overflow: hidden;
  background: #111;
  color: white;
  display: flex;
  flex-direction: column;
}

/* ---------------- HEADER ---------------- */

.header {
  padding: 12px 16px;
  padding-top: max(12px, env(safe-area-inset-top));

  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;

  background: #181818;
  border-bottom: 1px solid #333;

  z-index: 10;
}

.header h1 {
  margin: 0;
  font-size: 20px;
}

.header p {
  margin: 4px 0 0;
  color: #aaa;
  font-size: 13px;
}

/* ---------------- CONTROLS ---------------- */

.controls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.controls button {
  min-width: 44px; /* comfortable tap target on phones */
  height: 44px;

  background: #292929;
  border: 1px solid #444;
  color: white;
  font-size: 16px;

  padding: 0 12px;
  border-radius: 8px;

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

  background: #e9e9e9;

  cursor: grab;

  touch-action: none; /* we handle pan/pinch ourselves, not the browser */
}

.map-container:active {
  cursor: grabbing;
}

.floor-plan {
  position: absolute;

  top: 0;
  left: 0;

  max-width: none;
  background: white;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.25);

  user-select: none;
  pointer-events: none;
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
  padding: 12px 16px;
  padding-bottom: max(12px, env(safe-area-inset-bottom));

  background: #181818;
  border-top: 1px solid #333;

  color: #aaa;
  font-size: 13px;
  text-align: center;
}
</style>
