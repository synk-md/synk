/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import svgr from 'vite-plugin-svgr'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'node:path'

export default defineConfig({
  plugins: [
    react(),
    svgr(),
    VitePWA({
      // 'prompt' rather than 'autoUpdate': an autoUpdate reloads the tab as
      // soon as a new build is found, which would yank the page out from under
      // someone mid-edit. Here the new service worker installs and waits for
      // the user to accept the in-app update toast (see main.tsx).
      registerType: 'prompt',
      includeAssets: ['logo.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Synk',
        short_name: 'Synk',
        description:
          'Local-first, real-time collaborative note editor. Your documents live on your device, not on someone else\'s server.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#121213',
        theme_color: '#121213',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        // Gives Chrome's richer install dialog something to show on desktop.
        screenshots: [
          { src: '/screenshot.png', sizes: '2560x1440', type: 'image/png', form_factor: 'wide' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff,woff2,ttf}'],
        // Marketing assets - fetched on demand, no reason to spend install
        // bandwidth precaching them for offline use.
        globIgnores: ['screenshot.png', 'vite.svg'],
        // GitHub Pages serves 404.html for unknown paths; the service worker
        // takes over that job for cached navigations.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/404\.html$/],
        // The vendored tiptap editor bundle is well over the 2 MiB default.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      react: path.resolve(__dirname, 'node_modules/react'),
      'react-dom': path.resolve(__dirname, 'node_modules/react-dom'),
      yjs: path.resolve(__dirname, "node_modules/yjs"),
    },
    dedupe: ['react', 'react-dom'],
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // vendor/tiptap is a vendored dependency with its own Cypress specs
    // (*.spec.js using `context`/`cy` globals, not vitest) - without this,
    // vitest's default include glob picks them up too and they all error.
    exclude: ['**/node_modules/**', 'vendor/**'],
  },
})