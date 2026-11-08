import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The iOS app's reading view (ios/web), built from the desktop renderer's own components; the
// aliases match the renderer's in electron.vite.config.ts.
export default defineConfig({
  root: resolve('ios/web'),
  base: './',
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared')
    }
  },
  plugins: [react()],
  build: {
    outDir: resolve('ios/build/web'),
    emptyOutDir: true,
    // Loaded from inside the app, not over the network, so a big chunk costs nothing to fetch.
    chunkSizeWarningLimit: 2048
  }
})
