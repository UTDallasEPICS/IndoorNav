// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  // Theme colours, fonts and base styles (edit colours there)
  css: ['~/assets/css/main.css'],
  app: {
    // Fade between pages; the animation itself is in main.css (.page-*)
    pageTransition: { name: 'page', mode: 'out-in' },
    head: {
      title: 'Indoor Navigation',
      meta: [
        // viewport-fit=cover lets the app draw under the notch; the
        // env(safe-area-inset-*) paddings in the CSS keep content clear of it
        { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
        { name: 'theme-color', content: '#ffffff' },
        { name: 'apple-mobile-web-app-capable', content: 'yes' },
        { name: 'mobile-web-app-capable', content: 'yes' },
        { name: 'apple-mobile-web-app-status-bar-style', content: 'default' }
      ],
      link: [
        // Iceberg font for the app name (used via --font-brand)
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
        { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Iceberg&display=swap' }
      ]
    }
  }
})
