<template>
  <!-- Navigation arrow. Uses the theme colour from main.css by default;
       pass a `color` prop to override it in one place. -->
  <svg
    class="app-logo"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    :stroke="color"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <polygon points="12 2 19 21 12 17 5 21 12 2" />
  </svg>
</template>

<script setup>
defineProps({
  size: { type: [Number, String], default: 48 },
  color: { type: String, default: 'var(--color-primary)' }
})
</script>
