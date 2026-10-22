<template> <!-- the page's HTML. <script setup> below holds the logic, <style scoped> the CSS -->
  <!-- ROUTE PAGE (/route): type From and To, the server runs scripts/navigation.py (A*),
       and the route comes back as grid nodes that are drawn as a line over the map -->
  <div class="route-page">
    <!-- Just the two inputs: where you are and where you're going -->
    <form class="route-form" @submit.prevent="showRoute"> <!-- @submit runs showRoute(); .prevent stops the page reloading -->
      <h2>Find a Route</h2>

      <label class="field">
        <span>From</span>
        <input
          v-model="from"
          type="text"
          list="route-rooms"
          placeholder="Your location"
          enterkeyhint="next"
          autocomplete="off"
        > <!-- v-model: the input and `from` in the script stay in sync both ways -->
      </label>

      <label class="field">
        <span>To</span>
        <input
          v-model="to"
          type="text"
          list="route-rooms"
          placeholder="Destination"
          enterkeyhint="go"
          autocomplete="off"
        >
      </label>

      <!-- Suggestions for both inputs, from the rooms in the CAD drawing -->
      <datalist id="route-rooms">
        <option v-for="room in namedRooms" :key="room.label" :value="room.label" /> <!-- v-for: one <option> per room; ":" = value from the script -->
      </datalist>

      <p v-if="error" class="route-error">{{ error }}</p> <!-- v-if: only exists while there's an error; {{ }} prints it -->

      <button class="primary-button" type="submit" :disabled="loading || !from.trim() || !to.trim()">
        {{ loading ? 'Finding route…' : 'Show Route' }} <!-- button text changes while waiting for the server -->
      </button>
    </form>

    <!-- Map with the route layered on top. Everything in .map-layer shares one size and
         position, so the line and the dots always sit exactly on the floor plan. -->
    <main ref="mapBox" class="route-map"> <!-- ref: lets the script measure this box's size -->
      <div v-if="layer" class="map-layer" :style="layerStyle"> <!-- the layer: size and position come from the `layer` computed in the script -->
        <img
          ref="mapImage"
          src="/maps/spn-level1.svg"
          alt="SPN Level 1 floor plan"
          draggable="false"
          @load="onImageLoad"
        > <!-- fills the layer; the line and dots below sit on top of it -->

        <!-- viewBox 0–1 so the route's map fractions can be used as-is -->
        <svg v-if="route" class="route-line" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
          <polyline class="casing" :points="routePoints" /> <!-- dark, wider line underneath = outline -->
          <polyline class="line" :points="routePoints" /> <!-- lime line through every node, in order -->
        </svg>

        <!-- Ends of the route as HTML dots (circles in the stretched SVG would turn into ovals) -->
        <span v-if="route" class="route-end start" :style="placeAt(route.points[0])" /> <!-- first node -->
        <span v-if="route" class="route-end destination" :style="placeAt(route.points.at(-1))" /> <!-- last node -->
      </div>

      <!-- Hidden loader: reads the floor plan's shape before the map is laid out -->
      <img v-else ref="mapImage" class="probe" src="/maps/spn-level1.svg" alt="" @load="onImageLoad"> <!-- v-else: used until `layer` exists -->

      <p v-if="!route" class="map-hint">Enter where you are and where you're going.</p> <!-- only before the first route -->
    </main>
  </div>
</template>

<script setup> // "setup": everything declared here can be used in the template above
import { ref, computed, onMounted, onBeforeUnmount } from 'vue' // see the notes where each is used
import { cellToMap } from '#shared/grid-map' // shared/grid-map.js: grid node [row, col] -> map position { x, y }; #shared = the project's shared/ folder

const from = ref('') // ref(): a value the page reacts to; read/write it as .value. This one is the From input (v-model)
const to = ref('') // the To input
const error = ref('') // shown under the inputs when not empty
const loading = ref(false) // true while waiting for the server (disables the button)

const rooms = ref([]) // every room from spn-level1-rooms.json
const route = ref(null) // { points: [{ x, y }, ...] } in map fractions, start to destination

const mapBox = ref(null) // Vue fills these with the elements that have ref="mapBox" / ref="mapImage"
const mapImage = ref(null)
const box = ref({ width: 0, height: 0 }) // size of the map area on screen
const aspect = ref(0) // floor plan height / width

// Space kept around the route, and the closest zoom (route fills at most 8% of the floor's width)
const PADDING = 40
const MAX_ZOOM_VIEW_WIDTH = 0.08

// Rooms that have a name, labelled "LOBBY (1.1)" like on the map page
const namedRooms = computed(() => // computed(): worked out from other refs, updated automatically when they change
  rooms.value
    .filter(room => room.name)
    .map(room => ({ ...room, label: `${room.name} (${room.number})` }))
)

function findRoom(text) { // typed text -> room (matches "LOBBY (1.1)", "1.1" or "LOBBY")
  const query = text.trim().toLowerCase()
  return namedRooms.value.find(r =>
    [r.label, r.number, r.name].some(value => value.toLowerCase() === query)
  )
}

async function showRoute() { // "Show Route" button. async: can `await` the server
  const start = findRoom(from.value)
  const destination = findRoom(to.value)
  if (!start || !destination) {
    error.value = `Couldn't find "${(start ? to : from).value.trim()}". Try a room name or number.`
    return
  }

  error.value = ''
  loading.value = true
  document.activeElement?.blur() // close the keyboard so the map is visible

  try {
    // The server writes coords.txt, runs navigation.py and sends back path.txt as [row, col] cells
    const { path } = await $fetch('/api/route', { // $fetch: Nuxt's fetch; calls server/api/route.post.js
      method: 'POST',
      body: { start: { x: start.x, y: start.y }, destination: { x: destination.x, y: destination.y } }
    })
    route.value = { points: path.map(cellToMap) } // each node [row, col] -> { x, y } on the map; setting this draws the route
  } catch (err) {
    route.value = null
    error.value = err.data?.message ?? 'Something went wrong finding the route.'
  } finally { // runs whether it worked or failed
    loading.value = false
  }
}

// ---- Laying out the map ----

// "x1,y1 x2,y2 ..." for the <polyline>
const routePoints = computed(() =>
  route.value.points.map(({ x, y }) => `${x},${y}`).join(' ')
)

// Size and position of the map layer: the whole floor at first, then zoomed so the
// route fits the map area with some padding around it
const layer = computed(() => { // recalculates whenever the route, the box size or the map shape changes
  const { width, height } = box.value
  if (!width || !aspect.value) return null

  if (!route.value) {
    return { width, height: width * aspect.value, x: 0, y: (height - width * aspect.value) / 2 }
  }

  const xs = route.value.points.map(p => p.x)
  const ys = route.value.points.map(p => p.y)
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]

  // Widest map that still fits the route's box inside the padding
  const fitWidth = Math.min(
    (width - 2 * PADDING) / Math.max(maxX - minX, 1e-6),
    (height - 2 * PADDING) / (Math.max(maxY - minY, 1e-6) * aspect.value)
  )
  // Never smaller than the whole floor, never closer than MAX_ZOOM_VIEW_WIDTH
  const mapWidth = Math.min(Math.max(fitWidth, width), width / MAX_ZOOM_VIEW_WIDTH)
  const mapHeight = mapWidth * aspect.value

  return {
    width: mapWidth,
    height: mapHeight,
    x: width / 2 - ((minX + maxX) / 2) * mapWidth, // route's centre in the middle of the map area
    y: height / 2 - ((minY + maxY) / 2) * mapHeight
  }
})

const layerStyle = computed(() => ({ // `layer` as CSS for :style
  width: `${layer.value.width}px`,
  height: `${layer.value.height}px`,
  transform: `translate(${layer.value.x}px, ${layer.value.y}px)`
}))

function placeAt({ x, y }) { // CSS to put a dot at a map position (percent of the layer)
  return { left: `${x * 100}%`, top: `${y * 100}%` }
}

function onImageLoad() { // the floor plan loaded: now we know its shape
  aspect.value = mapImage.value.naturalHeight / mapImage.value.naturalWidth
}

// ---- Lifecycle ----

const boxObserver = import.meta.client // only in the browser: Nuxt also renders this page on the server, which has no ResizeObserver
  ? new ResizeObserver(([entry]) => {
      box.value = { width: entry.contentRect.width, height: entry.contentRect.height }
    })
  : null

onMounted(async () => { // runs once the page is on screen in the browser
  boxObserver.observe(mapBox.value)
  // The server-rendered <img> may finish loading before Vue attaches @load
  if (mapImage.value?.complete && mapImage.value.naturalWidth) onImageLoad()

  try {
    rooms.value = await $fetch('/maps/spn-level1-rooms.json')
  } catch (err) {
    console.error(err)
    error.value = 'Failed to load the room list.'
  }
})

onBeforeUnmount(() => { // runs when leaving the page: stop watching the box size
  boxObserver.disconnect()
})
</script>

<style scoped> /* scoped: these styles only apply to this page */
.route-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--color-background);
}

/* ---------------- FORM ---------------- */

.route-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: max(20px, env(safe-area-inset-top)) 20px 20px;
  background: var(--color-surface);
  box-shadow: 0 2px 16px rgba(0, 0, 0, 0.08);
  z-index: 1; /* shadow falls over the map */
}

.route-form h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
}

.field {
  display: flex;
  align-items: center;
  gap: 12px;
  border-bottom: 1px solid var(--color-border);
}

.field:focus-within {
  border-bottom-color: var(--color-primary);
}

.field span {
  width: 40px;
  color: var(--color-text-muted);
  font-size: 14px;
}

.field input {
  flex: 1;
  min-width: 0;
  padding: 8px 0;
  border: none;
  background: transparent;
  font-size: 16px; /* 16px+ stops iOS from zooming in when the field is focused */
  outline: none;
}

.field input::placeholder {
  color: var(--color-text-muted);
}

.route-error {
  margin: 0;
  color: var(--color-error);
  font-size: 13px;
}

.primary-button {
  width: 100%;
  height: 50px;
  margin-top: 4px;
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

/* ---------------- MAP + ROUTE ---------------- */

.route-map {
  position: relative;
  flex: 1;
  overflow: hidden;
}

.map-layer {
  position: absolute;
  top: 0;
  left: 0;
  /* glide to the new route's zoom and position */
  transition: transform 0.5s ease, width 0.5s ease, height 0.5s ease;
}

.map-layer img {
  display: block;
  width: 100%;
  height: 100%;
  user-select: none;
}

.probe {
  position: absolute;
  visibility: hidden;
}

.route-line {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
}

.route-line polyline {
  fill: none;
  stroke-linecap: round;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke; /* widths in screen pixels (the viewBox is only 1 unit wide) */
}

.route-line .casing {
  stroke: var(--color-on-primary); /* dark edge so the lime line stands out on the white plan */
  stroke-width: 8;
}

.route-line .line {
  stroke: var(--color-primary);
  stroke-width: 5;
}

.route-end {
  position: absolute;
  width: 16px;
  height: 16px;
  border: 3px solid var(--color-on-primary);
  border-radius: 50%;
  transform: translate(-50%, -50%); /* centre the dot on its point */
}

.route-end.start {
  background: #fff;
}

.route-end.destination {
  background: var(--color-primary);
}

.map-hint {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 24px;
  margin: 0;
  text-align: center;
  color: var(--color-text-muted);
  font-size: 14px;
}

@media (prefers-reduced-motion: reduce) {
  .map-layer {
    transition: none;
  }
}
</style>
