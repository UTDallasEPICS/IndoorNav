<template>
  <!-- Legend panel: slides up from the bottom over the sheet when `open` is true -->
  <Transition name="legend"> <!-- slide in/out using the .legend-* classes below -->
    <section v-if="open" class="legend-panel" aria-label="Map legend">
      <div class="panel-head">
        <h2>Legend</h2>
        <button class="close" type="button" aria-label="Close legend" @click="emit('close')">✕</button> <!-- tells map.vue to close it -->
      </div>

      <ul class="legend-list"> <!-- areas: one per row -->
        <li v-for="row in areaRows" :key="row.label" class="legend-row">
          <span class="swatch area" :style="{ '--c': row.color }" />
          {{ row.label }}
        </li>
      </ul>

      <ul
        v-if="pointRows.length"
        class="point-grid"
        :style="{ gridTemplateRows: `repeat(${Math.ceil(pointRows.length / 2)}, auto)` }"
      > <!-- points at the end, in two columns filled top to bottom: left column first, then right -->
        <li v-for="row in pointRows" :key="row.label" class="point-item">
          <span class="swatch point" :style="{ '--c': row.color }" />
          {{ row.label }}
        </li>
      </ul>
    </section>
  </Transition>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  open: { type: Boolean, default: false }, // map.vue decides when the panel shows
  rows: { type: Array, default: () => [] } // [{ label, color, type }] from legendRows() in utils/legend.ts
})
const emit = defineEmits(['close']) // the ✕ button asks map.vue to close the panel

const areaRows = computed(() => props.rows.filter(row => row.type === 'area')) // list at the top
const pointRows = computed(() => props.rows.filter(row => row.type === 'point')) // grid at the end
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
  margin-bottom: 8px;
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

.legend-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.legend-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 4px;
  border-bottom: 1px solid #f0f0f3;
  font-size: 16px;
}

.point-grid {
  display: grid;
  grid-auto-flow: column; /* fill down the left column, then the right (rows set inline from the count) */
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin: 16px 0 0;
  padding: 0 4px;
  list-style: none;
}

.point-item {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 16px;
}

.swatch {
  flex: none;
}

.swatch.area { /* same look as on the map: see-through plain fill with a full-colour edge, no gradient */
  width: 26px;
  height: 20px;
  border: 1.5px solid var(--c);
  border-radius: 6px;
  background: color-mix(in srgb, var(--c) 35%, transparent);
}

.swatch.point { /* same as on the map: small solid dot */
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--c);
}
</style>
