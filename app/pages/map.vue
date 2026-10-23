<template> <!-- the page's HTML. <script setup> below holds the logic, <style scoped> the CSS -->
  <!-- MAP PAGE: step 1 = drag the map under the 📍 and confirm your location,
       step 2 = search a room; the map glides there and drops a pin -->
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
    > <!-- ref="..." lets the script use this element; @event="fn" calls fn when it happens -->
      <!-- Floor plan exported from the CAD drawing (scripts/cad-to-svg.py) -->
      <img
        ref="mapImage"
        :src="floorMap"
        :alt="`SPN Level ${floor} floor plan`"
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
      > <!-- ":" before an attribute = its value comes from the script and updates by itself -->

      <!-- Destination room filled in. Same size and position as the floor plan, and its
           viewBox is 0–1 so the outline's fractions can be used as-is. -->
      <Transition name="room-fill"> <!-- fades the fill in/out using the .room-fill-* classes in the CSS -->
        <svg
          v-if="ready && selectedRoom?.outline && selectedRoom.floor === mapFloor"
          :key="selectedRoom.label"
          class="room-highlight"
          viewBox="0 0 1 1"
          preserveAspectRatio="none"
          aria-hidden="true"
          :style="{
            width: `${imageWidth * scale}px`,
            height: `${imageHeight * scale}px`,
            transform: `translate(${offsetX}px, ${offsetY}px)`
          }"
        >
          <polygon :points="selectedRoom.outline.map(point => point.join(',')).join(' ')" /> <!-- [[x, y], ...] -> "x,y x,y ..." -->
        </svg>
      </Transition>

      <!-- Route line from your location to the destination. Same size and position as the floor plan. -->
      <svg
        v-if="ready && route && mapFloor === 1"
        class="route-line"
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        aria-hidden="true"
        :style="{
          width: `${imageWidth * scale}px`,
          height: `${imageHeight * scale}px`,
          transform: `translate(${offsetX}px, ${offsetY}px)`
        }"
      >
        <polyline class="line" :points="routePoints" /> <!-- lime line through every node, in order -->
      </svg>

      <!-- Accuracy circle: you're probably somewhere inside it. Moves and zooms with the map. -->
      <div
        v-if="ready && locationFix?.floor === mapFloor"
        class="accuracy-circle"
        :style="{
          width: `${accuracyRadius * 2}px`,
          height: `${accuracyRadius * 2}px`,
          transform: `translate(${toScreenX(locationFix.x)}px, ${toScreenY(locationFix.y)}px) translate(-50%, -50%)`
        }"
      /> <!-- the second translate centres the circle on the point -->

      <!-- Step 1: marker fixed in the middle of the visible map; the map moves under it -->
      <div
        v-if="ready && step === 'pick'"
        class="map-pin start-pin"
        :class="{ shown: viewReady, lifted: isPanning }"
        :style="{ top: `calc((100% - ${sheetHeight}px) / 2)`, left: '50%' }"
      > <!-- v-if: this element only exists while the condition is true -->
        <!-- Push-pin like 📍: a ball on a needle; the needle's point is the picked spot -->
        <svg viewBox="0 0 24 36" aria-hidden="true">
          <line class="pin-needle" x1="12" y1="16" x2="12" y2="35" />
          <circle class="pin-head" cx="12" cy="10" r="9" />
          <circle class="pin-shine" cx="8.5" cy="6.5" r="2.5" />
        </svg>
      </div>

      <!-- Step 2: "You are here" marker pinned to the map. Same size on screen at any zoom. -->
      <div
        v-else-if="ready && currentLocation?.floor === mapFloor"
        class="location-marker"
        :class="{ shown: viewReady }"
        :style="{ transform: `translate(${toScreenX(currentLocation.x)}px, ${toScreenY(currentLocation.y)}px)` }"
      > <!-- v-else-if: shown when the v-if above is false; moves with the map via toScreenX/Y -->
        <AppLogo :size="28" /> <!-- components/AppLogo.vue (Nuxt imports components automatically) -->
      </div>

      <!-- Destination pin: the tip of the pin sits on the searched room -->
      <!-- out-in: the old pin shrinks away first, then the new one bursts in -->
      <Transition name="pin" mode="out-in" :duration="{ enter: 550, leave: 200 }">
        <div
          v-if="ready && selectedRoom?.floor === mapFloor"
          :key="selectedRoom.label"
          class="map-pin"
          :style="{ transform: `translate(${toScreenX(selectedRoom.x)}px, ${toScreenY(selectedRoom.y)}px)` }"
        > <!-- a new :key = a new element to Vue, so each room gets its own enter animation -->
          <svg viewBox="0 0 24 32" aria-hidden="true">
            <path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 20 12 20s12-11 12-20C24 5.4 18.6 0 12 0z" />
            <circle cx="12" cy="12" r="4.5" />
          </svg>
        </div>
      </Transition>

      <div v-if="!ready && !error" class="status"> <!-- until the map and rooms have loaded -->
        Loading map...
      </div>

      <div v-if="error" class="status error">
        {{ error }} <!-- {{ }} prints a value from the script -->
      </div>
    </main>

    <!-- Floor switcher, top right. Outside <main> so taps don't start a map drag. -->
    <div class="floor-toggle" role="group" aria-label="Floor">
      <button
        v-for="option in FLOORS"
        :key="option.level"
        type="button"
        :class="{ active: floor === option.level }"
        :aria-pressed="floor === option.level"
        :aria-label="`Level ${option.level}`"
        :disabled="!ready"
        @click="switchFloor(option.level)"
      > <!-- v-for: one button per entry in FLOORS; :key tells Vue which button is which -->
        {{ option.level }}
      </button>
    </div>

    <!-- Bottom sheet: step 1 sets your location, step 2 searches the destination -->
    <section ref="sheet" class="sheet">
      <!-- Map controls ride on top of the sheet, on the right -->
      <div class="map-controls">
        <button class="control" aria-label="Zoom in" @click="zoomIn"> <!-- @click runs zoomIn() from the script -->
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

      <template v-if="step === 'pick'"> <!-- <template> groups elements without adding an extra <div> -->
        <div class="sheet-header">
          <h2>Set Your Location</h2>
        </div>
        <p class="sheet-hint">Move the map so the marker is where you are.</p>

        <button class="primary-button" type="button" :disabled="!ready" @click="confirmLocation">
          Confirm Location
        </button>
      </template>

      <template v-else> <!-- step 2: destination search -->
        <div class="sheet-header">
          <h2>Enter Destination</h2>
          <span class="building-tag">in</span>
        </div>
        <p class="sheet-hint">
          Starting from your pinned location.
          <button class="link-button" type="button" @click="changeLocation">Change</button>
        </p>

        <form class="destination-form" @submit.prevent="findRoute"> <!-- .prevent stops the browser reloading the page on submit -->
          <input
            v-model="destination"
            class="destination-input"
            type="text"
            list="room-list"
            placeholder="Where to take you to?"
            enterkeyhint="go"
            autocomplete="off"
            aria-label="Destination"
          > <!-- v-model: the input and `destination` in the script stay in sync both ways -->
          <!-- Suggestions while typing, from the rooms in the CAD drawing -->
          <datalist id="room-list">
            <option v-for="room in namedRooms" :key="room.label" :value="room.label" />
          </datalist>

          <p v-if="destinationError" class="destination-error">{{ destinationError }}</p>

          <button class="primary-button" type="submit" :disabled="routeLoading || !destination.trim()">
            {{ routeLoading ? 'Finding route…' : 'Find Route' }} <!-- button text changes while the route is being found -->
          </button>
        </form>
      </template>
    </section>
  </div>
</template>

<script setup> // "setup": everything declared here can be used in the template above
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { routeBetween, loadRouteGrid } from '~/utils/route-between' // A* on the device: two map positions -> route points

const mapContainer = ref(null) // ref(): a value the page reacts to; read/write it as .value. Here Vue fills it with the <main ref="mapContainer"> element
const mapImage = ref(null) // the <img> floor plan
const sheet = ref(null) // the bottom sheet <section>

const error = ref('') // shown on screen whenever it isn't empty

// Natural size of the SVG, read once it has loaded
const imageWidth = ref(0)
const imageHeight = ref(0)

// scale = rendered size / natural size
const scale = ref(1)
const minScale = ref(1)
const maxScale = ref(1)
const offsetX = ref(0) // where the map's top-left corner sits on screen, in px
const offsetY = ref(0)

// Starting zoom: how much of the floor's width is visible (0.12 = 12%)
const START_VIEW_WIDTH = 0.12

// Each floor's map and room list (made by scripts/cad-to-svg.py)
const FLOORS = [
  { level: 1, map: '/maps/spn-level1.svg', rooms: '/maps/spn-level1-rooms.json' },
  { level: 2, map: '/maps/spn-level2.svg', rooms: '/maps/spn-level2-rooms.json' }
]

const floor = ref(1) // the floor the user picked (level 1 by default)
const mapFloor = ref(null) // the floor whose map has finished loading and is on screen
const floorMap = computed(() => FLOORS.find(option => option.level === floor.value).map) // computed(): a value worked out from other refs, updated automatically when they change

// Rooms of every floor: { number, name, x, y, outline?, floor }, with x/y as
// fractions (0–1) of that floor plan's width/height
const rooms = ref([])

// Where the map opens: the main lobby (or the middle of level 1 if it's missing)
const startPoint = computed(() =>
  rooms.value.find(room => room.number === '1.1' && room.name === 'LOBBY') ?? { x: 0.5, y: 0.5, floor: 1 }
)

// 'pick' = user is placing their location, 'destination' = searching where to go
const step = ref('pick')
const currentLocation = ref(null) // { x, y, floor } the user confirmed, null until then
const isPanning = ref(false) // finger/mouse is down on the map (lifts the marker)
const sheetHeight = ref(0) // kept in sync with the sheet so the marker stays centred above it
const locationFix = ref(null) // { x, y, floor, accuracy } from the location subsystem, accuracy in metres; null = no circle

// How much of the plan's width one metre covers (from the building's surveyed corners)
const WIDTH_PER_METER = 0.00782

const accuracyRadius = computed(() => // circle radius in screen px (metres -> plan widths -> px)
  locationFix.value ? locationFix.value.accuracy * WIDTH_PER_METER * imageWidth.value * scale.value : 0
)

const ready = computed(() => imageWidth.value > 0 && rooms.value.length > 0) // map image and rooms both loaded

// True once the map has been positioned; until then it's hidden so the
// unpositioned (full-size) image never flashes on screen
const viewReady = ref(false)

// ---- Loading ----

function onImageLoad() { // the <img> finished loading (first load, or after a floor switch)
  imageWidth.value = mapImage.value.naturalWidth
  imageHeight.value = mapImage.value.naturalHeight
  mapFloor.value = floor.value

  if (floorSwitch) {
    finishFloorSwitch()
  } else if (ready.value) {
    setupView()
  }
}

function onImageError() {
  error.value = `Failed to load the SPN Level ${floor.value} map.`
}

async function loadRooms() { // async: can `await` things like network requests
  try {
    const lists = await Promise.all(FLOORS.map(option => $fetch(option.rooms))) // $fetch: Nuxt's fetch; loads both floors' JSON at once
    rooms.value = lists.flatMap((list, i) => list.map(room => ({ ...room, floor: FLOORS[i].level })))
    if (ready.value) setupView()
  } catch (err) {
    console.error(err)
    error.value = 'Failed to load the room list.'
  }
}

function setupView() { // first fit of the map
  stopAnimation()
  setZoomLimits()
  resetView()
  containerSize = { width: mapContainer.value.clientWidth, height: mapContainer.value.clientHeight }
  viewReady.value = true
}

// Zoom out limit: the whole floor fits on screen. Zoom in limit: 8× the start.
function setZoomLimits() {
  const { clientWidth, clientHeight } = mapContainer.value
  minScale.value =
    Math.min(clientWidth / imageWidth.value, clientHeight / imageHeight.value) * 0.9
  maxScale.value = startScale() * 8
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

// The floor-plan point currently in the middle of the visible map (under the picking marker)
function visibleCenter() {
  const { clientWidth, clientHeight } = mapContainer.value
  const visibleHeight = clientHeight - sheet.value.offsetHeight
  return {
    x: (clientWidth / 2 - offsetX.value) / (imageWidth.value * scale.value),
    y: (visibleHeight / 2 - offsetY.value) / (imageHeight.value * scale.value)
  }
}

function resetView() {
  if (!ready.value) return
  const point = currentLocation.value ?? startPoint.value
  const { x, y } = point.floor === mapFloor.value ? point : { x: 0.5, y: 0.5 }
  centerOn(x, y, startScale())
}

// Compass button: glide back to the user's location (or the lobby while picking)
function goToMyLocation() {
  if (!ready.value) return
  showPoint(currentLocation.value ?? startPoint.value, startScale())
}

// ---- Floors ----

let floorSwitch = null // { x, y, renderedWidth, done } while the other floor's map loads

// Changing `floor` swaps the <img> src; onImageLoad then calls finishFloorSwitch.
// Returns a promise that resolves once the new floor is on screen.
function switchFloor(level) {
  if (level === floor.value || !ready.value) return Promise.resolve()
  stopAnimation()
  floorSwitch?.done() // a quicker second tap replaces the first switch

  return new Promise(resolve => {
    // Remember the view so the new floor opens at about the same spot and zoom.
    // The two CAD drawings don't line up exactly, so this is approximate.
    floorSwitch = { ...visibleCenter(), renderedWidth: imageWidth.value * scale.value, done: resolve }
    floor.value = level
  })
}

function finishFloorSwitch() {
  const { x, y, renderedWidth, done } = floorSwitch
  floorSwitch = null

  setZoomLimits()
  const newScale = renderedWidth / imageWidth.value // same width on screen as before
  centerOn(x, y, Math.min(maxScale.value, Math.max(minScale.value, newScale)))
  done()
}

// Glide to a point on any floor, switching floors first if it's on another one
async function showPoint(point, targetScale = scale.value, whenArrived = null) {
  await switchFloor(point.floor)
  flyTo(point.x, point.y, targetScale, whenArrived)
}

// ---- Setting your location ----

async function confirmLocation() { // "Confirm Location" button
  stopAnimation()
  const point = { ...visibleCenter(), floor: mapFloor.value } // read before the sheet changes height
  currentLocation.value = point
  step.value = 'destination'

  await nextTick() // wait for the taller destination sheet to render (Vue updates the page in batches)
  flyTo(point.x, point.y) // glide so the marker sits in the middle of the new visible area
}

async function changeLocation() { // "Change" link in step 2
  stopAnimation()
  selectedRoom.value = null // the destination no longer applies
  route.value = null // nor does the route
  destinationError.value = ''
  step.value = 'pick'

  await nextTick() // wait for the shorter pick sheet to render
  showPoint(currentLocation.value ?? startPoint.value) // bring the saved point under the centred marker
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

  const { x: fromX, y: fromY } = visibleCenter()
  const fromScale = scale.value
  const startTime = performance.now()

  function step(now) { // runs once per screen frame (about 60 times a second) until the glide ends
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

function onPointerDown(event) { // finger or mouse pressed on the map
  stopAnimation()
  // Close the keyboard when the user goes back to the map
  document.activeElement?.blur()

  mapContainer.value.setPointerCapture(event.pointerId)

  const point = toLocal(event)
  pointers.set(event.pointerId, point)

  isPanning.value = true
  tapStart = pointers.size === 1 ? { ...point, time: event.timeStamp } : null
  if (pointers.size === 2) lastPinch = pinchInfo()
}

function onPointerMove(event) { // finger or mouse moved: pan, or pinch-zoom with two fingers
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

function onPointerUp(event) { // finger or mouse lifted: also detects double-taps
  pointers.delete(event.pointerId)
  lastPinch = pointers.size === 2 ? pinchInfo() : null
  isPanning.value = pointers.size > 0 // drop the marker once every finger is up

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

const destination = ref('') // the search box text (v-model in the template)
const destinationError = ref('')
const selectedRoom = ref(null) // the room the pin is shown on (null = no pin)
const route = ref(null) // { points: [{ x, y }, ...] } in map fractions, start to destination; null = no line
const routeLoading = ref(false) // true while the route is being found (disables the button)
const ROUTE_PADDING = 40 // px kept around the route when zooming to fit it

const routePoints = computed(() => // "x1,y1 x2,y2 ..." for the <polyline>
  route.value.points.map(({ x, y }) => `${x},${y}`).join(' ')
)

// Rooms (on every floor) that have a name, labelled "LOBBY (1.1)" for the suggestions list
const namedRooms = computed(() =>
  rooms.value
    .filter(room => room.name)
    .map(room => ({ ...room, label: `${room.name} (${room.number})` }))
)

async function findRoute() { // "Find Route" button: find the room, work out the route, glide to it, then drop the pin
  const query = destination.value.trim().toLowerCase()
  // A full label like "LOBBY (1.1)" is one room. Numbers and names alone can be shared
  // (several rooms are 1.1 or STAIRS), so those only count when exactly one room has them.
  const byLabel = namedRooms.value.find(r => r.label.toLowerCase() === query)
  const matches = byLabel
    ? [byLabel]
    : namedRooms.value.filter(r => [r.number, r.name].some(text => text.toLowerCase() === query))
  const room = matches.length === 1 ? matches[0] : null

  if (!room) {
    destinationError.value = matches.length
      ? `${matches.length} rooms match "${destination.value.trim()}". Pick one from the list.`
      : `Couldn't find "${destination.value.trim()}". Try a room name or number.`
    selectedRoom.value = null // no single match, so remove the old pin
    return
  }

  destinationError.value = ''
  document.activeElement?.blur()

  stopAnimation() // if a previous search is still gliding, place its pin now
  selectedRoom.value = null // old pin shrinks away while the map glides
  route.value = null // old route goes away while the new one is found

  const start = currentLocation.value
  if (start.floor !== 1 || room.floor !== 1) { // the route grid (SPN.txt) only covers level 1
    destinationError.value = 'Routes are only available on level 1 for now.'
    return showPoint(room, startScale(), () => { selectedRoom.value = room })
  }

  routeLoading.value = true
  try {
    const points = await routeBetween(start, room) // A* runs right here on the phone
    if (step.value !== 'destination') return // "Change" was tapped while waiting
    route.value = { points } // setting this draws the line
  } catch (err) {
    console.error(err)
    destinationError.value = err.message || 'Something went wrong finding the route.'
  } finally { // runs whether it worked or failed
    routeLoading.value = false
  }

  await switchFloor(1) // first, so the zoom-to-fit below uses level 1's map size
  const view = route.value ? routeView(route.value.points) : { x: room.x, y: room.y, scale: startScale() } // no route: just show the room
  flyTo(view.x, view.y, view.scale, () => {
    selectedRoom.value = room // arrived: the new pin bursts in on screen
  })
}

function routeView(points) { // centre and zoom that fit the whole route above the sheet
  const xs = points.map(p => p.x)
  const ys = points.map(p => p.y)
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const { clientWidth, clientHeight } = mapContainer.value
  const visibleHeight = clientHeight - sheet.value.offsetHeight

  const fitScale = Math.min(
    (clientWidth - 2 * ROUTE_PADDING) / (Math.max(maxX - minX, 1e-6) * imageWidth.value), // 1e-6 avoids dividing by 0 for a straight line
    (visibleHeight - 2 * ROUTE_PADDING) / (Math.max(maxY - minY, 1e-6) * imageHeight.value)
  )
  return {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    scale: Math.min(maxScale.value, Math.max(minScale.value, fitScale)) // stay inside the zoom limits
  }
}

// ---- Lifecycle ----

let containerSize = null // { width, height } of the map container the view was last laid out for

// Keep the same spot in the middle instead of resetting the view, since the Android
// keyboard resizes the window every time the destination box is focused
function onResize() {
  if (!ready.value) return
  if (!containerSize) return setupView()
  const { clientWidth, clientHeight } = mapContainer.value
  offsetX.value += (clientWidth - containerSize.width) / 2
  offsetY.value += (clientHeight - containerSize.height) / 2
  containerSize = { width: clientWidth, height: clientHeight }
  setZoomLimits()
  zoomAboveSheet(1) // pulls the zoom back inside the new limits if needed
}

// The sheet changes height between steps; the picking marker needs to know
const sheetObserver = import.meta.client // only in the browser: Nuxt also renders this page on the server, which has no ResizeObserver
  ? new ResizeObserver(() => { sheetHeight.value = sheet.value?.offsetHeight ?? 0 })
  : null

onMounted(() => { // runs once the page is on screen in the browser
  // The server-rendered <img> may finish loading before Vue attaches @load
  if (mapImage.value?.complete && mapImage.value.naturalWidth) onImageLoad()

  loadRooms()
  loadRouteGrid().catch(() => {}) // start loading the grid now so Find Route is quick; errors show when it's pressed
  window.addEventListener('resize', onResize)
  sheetObserver.observe(sheet.value)
})

onBeforeUnmount(() => { // runs when leaving the page: stop animations and listeners so nothing keeps running
  stopAnimation()
  window.removeEventListener('resize', onResize)
  sheetObserver.disconnect()
})
</script>

<style scoped> /* scoped: these styles only apply to this page */
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
.location-marker,
.start-pin {
  opacity: 0;
  transition: opacity 0.4s ease;
}

.floor-plan.shown,
.location-marker.shown,
.start-pin.shown {
  opacity: 1;
}

.room-highlight {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
}

.room-highlight polygon {
  fill: var(--color-primary-soft); /* theme colour, see-through */
  stroke: var(--color-primary);
  stroke-width: 2;
  vector-effect: non-scaling-stroke; /* 2px on screen at any zoom (the viewBox is only 1 unit wide) */
}

.route-line {
  position: absolute;
  top: 0;
  left: 0;
  overflow: visible;
  pointer-events: none; /* drags go to the map */
}

.route-line polyline {
  fill: none;
  stroke-linecap: round;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke; /* widths in screen pixels at any zoom (the viewBox is only 1 unit wide) */
}

.route-line .line {
  stroke: var(--color-primary);
  stroke-width: 3;
}

.room-fill-enter-active,
.room-fill-leave-active {
  transition: opacity 0.3s ease;
}

.room-fill-enter-from,
.room-fill-leave-to {
  opacity: 0;
}

/* Confirmed location: just the arrow, centred on the point */
.location-marker {
  --marker-size: 28px; /* same as the AppLogo size */

  position: absolute;
  top: 0;
  left: 0;
  width: var(--marker-size);
  height: var(--marker-size);
  margin-left: calc(var(--marker-size) / -2); /* the transform moves the top-left corner to the point */
  margin-top: calc(var(--marker-size) / -2);
  display: grid;
  pointer-events: none;
}

/* Green push-pin while picking (two classes so they beat the shared .map-pin rules below) */
.map-pin.start-pin {
  --pin-width: 28px; /* 24:36 like its viewBox */
  --pin-height: 42px;
}

.start-pin .pin-head {
  fill: var(--color-start-pin);
}

.start-pin .pin-shine {
  fill: #fff;
  opacity: 0.6; /* soft highlight, like the emoji */
}

.start-pin .pin-needle {
  stroke: var(--color-text-muted);
  stroke-width: 2;
  stroke-linecap: round;
}

/* The pin floats up as you drag and settles when you let go (like Uber) */
.start-pin svg {
  transition: transform 0.2s ease-out;
}

.start-pin.lifted svg {
  transform: translateY(-10px);
}

/* Pin shape shared by the start pin and the destination pin */
.map-pin {
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

.map-pin svg {
  width: 100%;
  height: 100%;
  overflow: visible;
  filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.3));
  transform-origin: bottom center; /* grow and shrink from the tip */
}

.map-pin path {
  fill: var(--color-primary);
}

.map-pin circle {
  fill: #fff; /* the white dot in the middle */
}

/* Ring that bursts out from the tip when the pin lands (hidden otherwise) */
.map-pin::after {
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

.floor-toggle {
  position: absolute;
  top: max(16px, env(safe-area-inset-top));
  right: 16px;
  display: flex;
  padding: 4px;
  gap: 4px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: var(--color-surface);
  box-shadow: var(--shadow-floating);
}

.floor-toggle button {
  width: 36px;
  height: 36px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--color-text);
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s ease, color 0.2s ease;
}

.floor-toggle button.active {
  background: var(--color-primary);
  color: var(--color-on-primary);
}

.floor-toggle button:disabled {
  cursor: default;
}

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

.accuracy-circle {
  position: absolute;
  top: 0;
  left: 0;
  border: 2px solid var(--color-primary);
  border-radius: 50%;
  background: var(--color-primary-soft); /* see-through, so the rooms show under it */
  pointer-events: none; /* drags go to the map */
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

.sheet-hint {
  margin: 6px 0 16px;
  color: var(--color-text-muted);
  font-size: 14px;
}

.link-button {
  padding: 0;
  border: none;
  background: none;
  color: var(--color-primary);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
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
