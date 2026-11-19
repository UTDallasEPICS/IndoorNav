<template>
  <!-- Turn arrow for the directions banner (pages/map.vue). Drawn in currentColor, so set `color` in CSS. -->
  <svg
    class="direction-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2.4"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <template v-if="type === 'right'"> <!-- up, then bend to the right -->
      <path d="M7 21V12a4 4 0 0 1 4-4h8" />
      <path d="M15 4l4 4-4 4" />
    </template>
    <template v-else-if="type === 'left'"> <!-- mirror of right -->
      <path d="M17 21V12a4 4 0 0 0-4-4H5" />
      <path d="M9 4L5 8l4 4" />
    </template>
    <template v-else> <!-- arrive: a map pin -->
      <path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z" />
      <circle cx="12" cy="10" r="2" />
    </template>
  </svg>
</template>

<script setup>
defineProps({
  type: { type: String, required: true } // 'left' | 'right' | 'arrive' (a Step's type from utils/directions.ts)
})
</script>
