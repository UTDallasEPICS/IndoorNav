<template>
  <!-- Legend panel: slides up from the bottom over the sheet when `open` is true -->
  <Transition name="legend"> <!-- slide in/out using the .legend-* classes below -->
    <section v-if="open" class="legend-panel" aria-label="Map legend">
      <div class="panel-head">
        <h2>Legend</h2>
        <button class="close" type="button" aria-label="Close legend" @click="emit('close')">✕</button> <!-- tells map.vue to close it -->
      </div>

      <div class="group-title">PLACES</div>
      <ul class="place-list">
        <li v-for="place in PLACES" :key="place.room" class="place-row">
          <span class="swatch" :style="{ '--c': place.color }" />
          <span class="text">
            {{ place.label }}
            <span class="room">Level {{ place.floor }} · {{ place.room }}</span>
          </span>
        </li>
      </ul>

      <div class="group-title">AMENITIES</div>
      <div class="key">
        <div v-for="item in AMENITIES" :key="item.label">
          <span class="swatch" :class="{ exit: item.exit }" :style="{ '--c': item.color }" />
          {{ item.label }}
        </div>
      </div>
    </section>
  </Transition>
</template>

<script setup>
defineProps({
  open: { type: Boolean, default: false } // map.vue decides when the panel shows
})
const emit = defineEmits(['close']) // the ✕ button asks map.vue to close the panel

const PLACES = [ // popular SPN places; room = number + name in spn-level1-rooms.json (numbers aren't unique)
  { label: 'Lobby', room: '1.1 LOBBY', floor: 1, color: 'var(--color-legend-lobby)' }, // colours live in main.css
  { label: 'Reception', room: '1.101 RECEPTION', floor: 1, color: 'var(--color-legend-reception)' },
  { label: 'UTD Design Studio', room: '1.2 UT DESIGN', floor: 1, color: 'var(--color-legend-studio)' },
  { label: 'UTD Design', room: '1.103 UT DESIGN', floor: 1, color: 'var(--color-legend-design)' }
]

const AMENITIES = [ // the key: each swatch shows how that area will look on the map
  { label: 'Restrooms', color: 'var(--color-legend-restroom)' },
  { label: 'Elevator', color: 'var(--color-legend-elevator)' },
  { label: 'Stairs', color: 'var(--color-legend-stairs)' },
  { label: 'Exits', color: 'var(--color-legend-exit)', exit: true }
]
</script>

<style scoped>
.legend-panel {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  max-height: 72%; /* the map stays visible above it */
  overflow-y: auto;
  padding: 16px 20px max(24px, env(safe-area-inset-bottom));
  border-radius: 20px 20px 0 0;
  background: var(--color-surface);
  box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.18);
}

.legend-enter-active,
.legend-leave-active {
  transition: transform 0.3s ease;
}

.legend-enter-from,
.legend-leave-to {
  transform: translateY(105%); /* just below the screen */
}

@media (prefers-reduced-motion: reduce) {
  .legend-enter-active,
  .legend-leave-active {
    transition: none; /* just appear/disappear */
  }
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}

.panel-head h2 {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
}

.close {
  width: 32px;
  height: 32px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: #f2f2f7;
  color: var(--color-text);
  font-size: 16px;
  cursor: pointer;
}

.group-title {
  margin: 14px 0 6px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
}

.place-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.place-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 4px;
  border-bottom: 1px solid #f0f0f3;
}

.place-row .text {
  flex: 1;
}

.place-row .room {
  display: block;
  font-size: 12px;
  color: var(--color-text-muted);
}

.key {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 12px;
  font-size: 14px;
}

.key div {
  display: flex;
  align-items: center;
  gap: 8px;
}

.swatch { /* small sample of the colour the area will get on the map: see-through plain fill, no gradient */
  width: 26px;
  height: 20px;
  flex: none;
  border: 1.5px solid var(--c); /* full colour edge, like the room outline on the map */
  border-radius: 6px;
  background: color-mix(in srgb, var(--c) 35%, transparent); /* 35% colour, the rest see-through */
}

.swatch.exit { /* exits are a red line on the door, not an area */
  position: relative;
  border: none;
  background: none;
}

.swatch.exit::after {
  content: '';
  position: absolute;
  left: 2px;
  right: 2px;
  top: 8px;
  height: 4px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--c) 60%, transparent); /* a bit stronger than areas so a thin line still shows */
}
</style>
