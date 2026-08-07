/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import svgr from 'vite-plugin-svgr'
import path from 'node:path'

export default defineConfig({
  plugins: [react(), svgr()],
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