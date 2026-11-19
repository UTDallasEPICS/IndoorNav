<template>
  <div class="landing" @click="openMap">
    <!-- Landing / splash screen. Moves on to the map by itself, or on tap.
         (Comment kept inside the root div: page transitions need a single root.) -->
    <AppLogo :size="56" />
    <h1>Indoor Navigation</h1>
  </div>
</template>

<script setup>
import { onMounted, onBeforeUnmount } from 'vue'

const SPLASH_DURATION = 2000 // ms

let timer = null

function openMap() {
  clearTimeout(timer)
  // replace: the back gesture shouldn't return to the splash screen
  navigateTo('/map', { replace: true })
}

onMounted(() => {
  // Start downloading the floor plan during the splash, so the map page
  // can show it straight away
  new Image().src = '/maps/spn-level1.svg'

  timer = setTimeout(openMap, SPLASH_DURATION)
})

onBeforeUnmount(() => {
  clearTimeout(timer)
})
</script>

<style scoped>
.landing {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: env(safe-area-inset-top) 24px env(safe-area-inset-bottom);
  background: var(--color-background);
  animation: fade-in 0.6s ease-out;
}

h1 {
  margin: 0;
  font-family: var(--font-brand);
  font-weight: 400; /* Iceberg only comes in one weight */
  font-size: 28px;
  color: var(--color-primary);
}

@keyframes fade-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
}
</style>
