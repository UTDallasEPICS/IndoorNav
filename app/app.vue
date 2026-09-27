<template>
  <div v-if="!showMap" class="home"> <!-- title screen, shown until the button is clicked -->
    <h1>Indoor Navigation</h1>
    <button @click="showMap = true">Open Map</button>
  </div>

  <NuxtPage v-else /> <!-- renders pages/index.vue (the map) -->
</template>

<script setup>
const showMap = ref(false) // no import needed, Nuxt auto-imports ref
</script>

<style scoped>
.home {
  height: 100vh; /* fill the full screen height so there's room to center vertically */
  display: flex;
  flex-direction: column; /* stack the title and button vertically */
  align-items: center; /* horizontal centering (flips because of column) */
  justify-content: center; /* vertical centering (flips because of column) */
  gap: 16px; /* space between title and button */
}

.home button {
  padding: 10px 20px;
  border-radius: 6px;
  cursor: pointer;
}
</style>
