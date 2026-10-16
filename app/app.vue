<template>
  <!-- Phone-width column: fills a phone screen, and stays phone-sized on wider screens -->
  <div class="phone">
    <NuxtPage /> <!-- pages/index.vue (landing) or pages/map.vue (map) -->
  </div>
</template>

<style scoped>
.phone {
  position: relative;
  width: 100%;
  max-width: var(--app-max-width);
  height: 100vh;
  height: 100dvh; /* excludes the mobile browser's address bar */
  margin: 0 auto;
  overflow: hidden;
  background: var(--color-background);
}
</style>
