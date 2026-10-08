<template>
  <div class="map-page">
    <!-- Map fills the whole screen; the controls and bottom sheet float on top -->
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
        :class="{ shown: viewReady }"
        draggable="false"
        :style="{
          width: `${imageWidth * scale}px`,
          height: `${imageHeight * scale}px`,
          transform: `translate(${offsetX}px, ${offsetY}px)`
        }"
        @load="onImageLoad"
        @error="onImageError"
      >

      <!-- "You are here" marker. Stays the same size on screen at any zoom. -->
      <div
        v-if="ready && currentLocation"
        class="location-marker"
        :class="{ shown: viewReady }"
        :style="{ transform: `translate(${toScreenX(currentLocation.x)}px, ${toScreenY(currentLocation.y)}px)` }"
      >
        <AppLogo :size="28" />
      </div>

      <!-- Destination pin: the tip of the pin sits on the searched room -->
      <!-- out-in: the old pin shrinks away first, then the new one bursts in -->
      <Transition name="pin" mode="out-in" :duration="{ enter: 550, leave: 200 }">
        <div
          v-if="ready && selectedRoom"
          :key="selectedRoom.label"
          class="destination-pin"
          :style="{ transform: `translate(${toScreenX(selectedRoom.x)}px, ${toScreenY(selectedRoom.y)}px)` }"
        >
          <svg viewBox="0 0 24 32" aria-hidden="true">
            <path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 20 12 20s12-11 12-20C24 5.4 18.6 0 12 0z" />
            <circle cx="12" cy="12" r="4.5" />
          </svg>
        </div>
      </Transition>

      <div v-if="!ready && !error" class="status">
        Loading map...
      </div>

      <div v-if="error" class="status error">
        {{ error }}
      </div>
    </main>

    <!-- Bottom sheet: destination search -->
    <section ref="sheet" class="sheet">
      <!-- Map controls ride on top of the sheet, on the right -->
      <div class="map-controls">
        <button class="control" aria-label="Zoom in" @click="zoomIn">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        </button>
        <button class="control" aria-label="Zoom out" @click="zoomOut">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" /></svg>
        </button>
        <button class="control" aria-label="Back to my location" @click="goToMyLocation">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <polygon points="15.5 8.5 13.5 13.5 8.5 15.5 10.5 10.5 15.5 8.5" />
          </svg>
        </button>
      </div>

      <div class="sheet-header">
        <h2>Enter Destination</h2>
        <span class="building-tag">in</span>
      </div>

      <form class="destination-form" @submit.prevent="findRoute">
        <input
          v-model="destination"
          class="destination-input"
          type="text"
          list="room-list"
          placeholder="Where to take you to?"
          enterkeyhint="go"
          autocomplete="off"
          aria-label="Destination"
        >
        <!-- Suggestions while typing, from the rooms in the CAD drawing -->
        <datalist id="room-list">
          <option v-for="room in namedRooms" :key="room.label" :value="room.label" />
        </datalist>

        <p v-if="destinationError" class="destination-error">{{ destinationError }}</p>

        <button class="primary-button" type="submit" :disabled="!destination.trim()">
          Find Route
        </button>
      </form>
    </section>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'

const mapContainer = ref(null)
const mapImage = ref(null)
const sheet = ref(null)

const error = ref('')

// Natural size of the SVG, read once it has loaded
const imageWidth = ref(0)
const imageHeight = ref(0)

// scale = rendered size / natural size
const scale = ref(1)
const minScale = ref(1)
const maxScale = ref(1)
const offsetX = ref(0)
const offsetY = ref(0)

// Starting zoom: how much of the floor's width is visible (0.12 = 12%)
const START_VIEW_WIDTH = 0.12

// Rooms from public/maps/spn-level1-rooms.json: { number, name, x, y },
// with x/y as fractions (0–1) of the floor plan's width/height
const rooms = ref([])

// No positioning yet, so the user is assumed to be in the main lobby
const currentLocation = computed(() =>
  rooms.value.find(room => room.number === '1.1' && room.name === 'LOBBY')
)

const ready = computed(() => imageWidth.value > 0 && rooms.value.length > 0)

// True once the map has been positioned; until then it's hidden so the
// unpositioned (full-size) image never flashes on screen
const viewReady = ref(false)

// ---- Loading ----

function onImageLoad() {
  imageWidth.value = mapImage.value.naturalWidth
  imageHeight.value = mapImage.value.naturalHeight
  if (ready.value) setupView()
}

function onImageError() {
  error.value = 'Failed to load the SPN Level 1 map.'
}

async function loadRooms() {
  try {
    rooms.value = await $fetch('/maps/spn-level1-rooms.json')
    if (ready.value) setupView()
  } catch (err) {
    console.error(err)
    error.value = 'Failed to load the room list.'
  }
}

function setupView() {
  stopAnimation()
  const { clientWidth, clientHeight } = mapContainer.value

  // Zoom out limit: the whole floor fits on screen. Zoom in limit: 8× the start.
  minScale.value =
    Math.min(clientWidth / imageWidth.value, clientHeight / imageHeight.value) * 0.9
  maxScale.value = startScale() * 8

  resetView()
  viewReady.value = true
}

function startScale() {
  return mapContainer.value.clientWidth / (imageWidth.value * START_VIEW_WIDTH)
}

// ---- Positioning ----

// Map fractions (0–1) of the floor plan to screen pixels inside the container
function toScreenX(fx) {
  return offsetX.value + fx * imageWidth.value * scale.value
}

function toScreenY(fy) {
  return offsetY.value + fy * imageHeight.value * scale.value
}

// Centre a point of the floor plan in the part of the screen above the sheet
function centerOn(fx, fy, newScale = scale.value) {
  const { clientWidth, clientHeight } = mapContainer.value
  const visibleHeight = clientHeight - sheet.value.offsetHeight

  scale.value = newScale
  offsetX.value = clientWidth / 2 - fx * imageWidth.value * newScale
  offsetY.value = visibleHeight / 2 - fy * imageHeight.value * newScale
}

function resetView() {
  if (!ready.value) return
  const { x, y } = currentLocation.value ?? { x: 0.5, y: 0.5 }
  centerOn(x, y, startScale())
}

// Compass button: glide back to the user's location
function goToMyLocation() {
  if (!ready.value) return
  const { x, y } = currentLocation.value ?? { x: 0.5, y: 0.5 }
  flyTo(x, y, startScale())
}

// ---- Smooth movement ----

const FLY_DURATION = 700 // ms
let animationFrame = null
let onArrive = null // runs when the current flyTo ends, or is cut short

function stopAnimation() {
  cancelAnimationFrame(animationFrame)
  animationFrame = null
  finishFlight()
}

function finishFlight() {
  const done = onArrive
  onArrive = null // clear first so it can only ever run once
  done?.()
}

// Slow start, fast middle, slow end
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
}

// Like centerOn, but glides there over FLY_DURATION instead of jumping
function flyTo(fx, fy, targetScale = scale.value, whenArrived = null) {
  stopAnimation()
  onArrive = whenArrived

  // Respect the phone's "reduce motion" setting
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    centerOn(fx, fy, targetScale)
    finishFlight() // no glide, so we've arrived straight away
    return
  }

  // The floor-plan point currently in the middle of the visible map
  const { clientWidth, clientHeight } = mapContainer.value
  const visibleHeight = clientHeight - sheet.value.offsetHeight
  const fromX = (clientWidth / 2 - offsetX.value) / (imageWidth.value * scale.value)
  const fromY = (visibleHeight / 2 - offsetY.value) / (imageHeight.value * scale.value)
  const fromScale = scale.value
  const startTime = performance.now()

  function step(now) {
    const t = Math.min(1, (now - startTime) / FLY_DURATION)
    const e = easeInOutCubic(t)

    // Move the centre point in a straight line; change zoom by a constant
    // ratio per frame (feels even, unlike adding a constant amount)
    centerOn(
      fromX + (fx - fromX) * e,
      fromY + (fy - fromY) * e,
      fromScale * (targetScale / fromScale) ** e
    )

    if (t < 1) {
      animationFrame = requestAnimationFrame(step)
    } else {
      animationFrame = null
      finishFlight()
    }
  }

  animationFrame = requestAnimationFrame(step)
}

// ---- Zoom ----

// Zoom by `factor`, keeping the point (x, y) of the container fixed on screen
function zoomAt(factor, x, y) {
  const newScale = Math.min(maxScale.value, Math.max(minScale.value, scale.value * factor))
  const applied = newScale / scale.value

  offsetX.value = x - (x - offsetX.value) * applied
  offsetY.value = y - (y - offsetY.value) * applied
  scale.value = newScale
}

function zoomAboveSheet(factor) {
  stopAnimation()
  const { clientWidth, clientHeight } = mapContainer.value
  zoomAt(factor, clientWidth / 2, (clientHeight - sheet.value.offsetHeight) / 2)
}

function zoomIn() {
  zoomAboveSheet(1.5)
}

function zoomOut() {
  zoomAboveSheet(1 / 1.5)
}

// Converts a pointer/wheel event to coordinates inside the map container
function toLocal(event) {
  const rect = mapContainer.value.getBoundingClientRect()
  return { x: event.clientX - rect.left, y: event.clientY - rect.top }
}

function handleWheel(event) {
  stopAnimation()
  const { x, y } = toLocal(event)
  // exp() gives smooth zooming for both mouse wheels and trackpads
  zoomAt(Math.exp(-event.deltaY * 0.0015), x, y)
}

// ---- Drag to pan (1 finger), pinch to zoom (2 fingers), double-tap to zoom ----

const pointers = new Map() // pointerId -> { x, y }
let lastPinch = null // { distance, midX, midY }
let tapStart = null // { x, y, time } of the current single-finger press
let lastTap = null // { x, y, time } of the previous completed tap

function pinchInfo() {
  const [a, b] = [...pointers.values()]
  return {
    distance: Math.hypot(b.x - a.x, b.y - a.y),
    midX: (a.x + b.x) / 2,
    midY: (a.y + b.y) / 2
  }
}

function onPointerDown(event) {
  stopAnimation()
  // Close the keyboard when the user goes back to the map
  document.activeElement?.blur()

  mapContainer.value.setPointerCapture(event.pointerId)

  const point = toLocal(event)
  pointers.set(event.pointerId, point)

  tapStart = pointers.size === 1 ? { ...point, time: event.timeStamp } : null
  if (pointers.size === 2) lastPinch = pinchInfo()
}

function onPointerMove(event) {
  const previous = pointers.get(event.pointerId)
  if (!previous) return

  const current = toLocal(event)
  pointers.set(event.pointerId, current)

  // Moving more than a few pixels means it's a drag, not a tap
  if (tapStart && Math.hypot(current.x - tapStart.x, current.y - tapStart.y) > 10) {
    tapStart = null
  }

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

  if (tapStart && event.type === 'pointerup' && event.timeStamp - tapStart.time < 250) {
    const isDoubleTap =
      lastTap &&
      tapStart.time - lastTap.time < 300 &&
      Math.hypot(tapStart.x - lastTap.x, tapStart.y - lastTap.y) < 30

    if (isDoubleTap) {
      zoomAt(2, tapStart.x, tapStart.y)
      lastTap = null
    } else {
      lastTap = tapStart
    }
  }
  tapStart = null
}

// ---- Destination ----

const destination = ref('')
const destinationError = ref('')
const selectedRoom = ref(null) // the room the pin is shown on (null = no pin)

// Rooms that have a name, labelled "LOBBY (1.1)" for the suggestions list
const namedRooms = computed(() =>
  rooms.value
    .filter(room => room.name)
    .map(room => ({ ...room, label: `${room.name} (${room.number})` }))
)

function findRoute() {
  const query = destination.value.trim().toLowerCase()
  const room = namedRooms.value.find(r =>
    [r.label, r.number, r.name].some(text => text.toLowerCase() === query)
  )

  if (!room) {
    destinationError.value = `Couldn't find "${destination.value.trim()}". Try a room name or number.`
    selectedRoom.value = null // no match, so remove the old pin
    return
  }

  destinationError.value = ''
  document.activeElement?.blur()

  stopAnimation() // if a previous search is still gliding, place its pin now
  selectedRoom.value = null // old pin shrinks away while the map glides

  // TODO: route calculation + directions screen. For now, show the destination.
  flyTo(room.x, room.y, startScale(), () => {
    selectedRoom.value = room // arrived: the new pin bursts in on screen
  })
}

// ---- Lifecycle ----

function onResize() {
  if (ready.value) setupView()
}

onMounted(() => {
  // The server-rendered <img> may finish loading before Vue attaches @load
  if (mapImage.value?.complete && mapImage.value.naturalWidth) onImageLoad()

  loadRooms()
  window.addEventListener('resize', onResize)
})

onBeforeUnmount(() => {
  stopAnimation()
  window.removeEventListener('resize', onResize)
})
</script>

<style scoped>
.map-page {
  position: relative;
  height: 100%;
  overflow: hidden;
  background: var(--color-background);
}

/* ---------------- MAP ---------------- */

.map-container {
  position: absolute;
  inset: 0;
  overflow: hidden;
  touch-action: none; /* we handle pan/pinch ourselves, not the browser */
}

.floor-plan {
  position: absolute;
  top: 0;
  left: 0;
  max-width: none;
  user-select: none;
  pointer-events: none;
}

/* Map and marker fade in once positioned */
.floor-plan,
.location-marker {
  opacity: 0;
  transition: opacity 0.4s ease;
}

.floor-plan.shown,
.location-marker.shown {
  opacity: 1;
}

/* The halo circle, with the arrow centred inside it */
.location-marker {
  --marker-size: 128px;
  /* The marker's map point is the room number ("1.1"); lift the circle so the arrow
     sits just above the label while the circle still wraps around it */
  --marker-lift: 44px;

  position: absolute;
  top: 0;
  left: 0;
  width: var(--marker-size);
  height: var(--marker-size);
  /* Centre the circle on the map point (the transform moves the top-left corner there) */
  margin-left: calc(var(--marker-size) / -2);
  margin-top: calc(var(--marker-size) / -2 - var(--marker-lift));

  display: grid;
  place-items: center; /* arrow in the middle of the circle */

  border-radius: 50%;
  background: var(--color-primary-soft);
  border: 1px solid var(--color-primary);
  pointer-events: none;
}

.destination-pin {
  --pin-width: 36px;
  --pin-height: 48px;

  position: absolute;
  top: 0;
  left: 0;
  width: var(--pin-width);
  height: var(--pin-height);
  margin-left: calc(var(--pin-width) / -2); /* centre horizontally on the point */
  margin-top: calc(var(--pin-height) * -1); /* bottom tip on the point, not the top-left corner */
  pointer-events: none;
}

.destination-pin svg {
  width: 100%;
  height: 100%;
  overflow: visible;
  filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.3));
  transform-origin: bottom center; /* grow and shrink from the tip */
}

.destination-pin path {
  fill: var(--color-primary);
}

.destination-pin circle {
  fill: #fff; /* the white dot in the middle */
}

/* Ring that bursts out from the tip when the pin lands (hidden otherwise) */
.destination-pin::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: 0;
  width: 40px;
  height: 40px;
  margin: 0 0 -20px -20px; /* centre the ring on the tip */
  border: 2px solid var(--color-primary);
  border-radius: 50%;
  opacity: 0;
}

/* Animations go on the svg/ring, because the root's transform is its position on the map.
   That's also why <Transition> needs :duration: it can't see animations on children. */
.pin-enter-active svg {
  animation: pin-burst 0.55s cubic-bezier(0.34, 1.56, 0.64, 1); /* overshoots a little, then settles */
}

.pin-enter-active::after {
  animation: pin-ring 0.55s ease-out;
}

.pin-leave-active svg {
  animation: pin-shrink 0.2s ease-in forwards; /* forwards: stay hidden until removed */
}

@keyframes pin-burst {
  from {
    opacity: 0;
    transform: scale(0);
  }
  40% {
    opacity: 1;
  }
}

@keyframes pin-ring {
  from {
    opacity: 0.8;
    transform: scale(0.1);
  }
  to {
    opacity: 0;
    transform: scale(1.6);
  }
}

@keyframes pin-shrink {
  to {
    opacity: 0;
    transform: scale(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .pin-enter-active svg,
  .pin-enter-active::after,
  .pin-leave-active svg {
    animation: none; /* just appear/disappear */
  }
}

.status {
  position: absolute;
  top: 40%;
  left: 50%;
  transform: translate(-50%, -50%);
  padding: 12px 20px;
  border-radius: 12px;
  background: rgba(28, 28, 30, 0.85);
  color: white;
  font-size: 14px;
  /* Only shows up if loading takes a while, so it doesn't flicker past */
  animation: status-appear 0.3s ease 0.6s both;
}

@keyframes status-appear {
  from {
    opacity: 0;
  }
}

.status.error {
  color: #ff8a8a;
}

/* ---------------- CONTROLS ---------------- */

.map-controls {
  position: absolute;
  right: 16px;
  bottom: calc(100% + 16px); /* just above the sheet */
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.control {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 1px solid var(--color-border);
  border-radius: 50%;
  background: var(--color-surface);
  box-shadow: var(--shadow-floating);
  cursor: pointer;
}

.control:active {
  background: var(--color-primary-soft);
}

.control svg {
  width: 20px;
  height: 20px;
  fill: none;
  stroke: var(--color-text);
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* ---------------- BOTTOM SHEET ---------------- */

.sheet {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 20px 20px max(20px, env(safe-area-inset-bottom));
  background: var(--color-surface);
  border-radius: 20px 20px 0 0;
  box-shadow: 0 -2px 16px rgba(0, 0, 0, 0.08);
}

.sheet-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.sheet-header h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
}

.building-tag {
  font-size: 20px;
  font-weight: 700;
  color: var(--color-primary);
}

.destination-form {
  display: flex;
  flex-direction: column;
}

.destination-input {
  width: 100%;
  margin: 6px 0 16px;
  padding: 8px 0;
  border: none;
  border-bottom: 1px solid var(--color-border);
  background: transparent;
  font-size: 16px; /* 16px+ stops iOS from zooming in when the field is focused */
  outline: none;
}

.destination-input:focus {
  border-bottom-color: var(--color-primary);
}

.destination-input::placeholder {
  color: var(--color-text-muted);
}

.destination-error {
  margin: -8px 0 12px;
  color: var(--color-error);
  font-size: 13px;
}

.primary-button {
  width: 100%;
  height: 50px;
  border: none;
  border-radius: 12px;
  background: var(--color-primary);
  color: var(--color-on-primary);
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
}

.primary-button:active {
  filter: brightness(0.92);
}

.primary-button:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
