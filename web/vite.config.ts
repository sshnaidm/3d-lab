import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Relative base: the built viewer works from any path (fleet service at /, a static share in a subdirectory).
// In dev, /api and /topology go to a local fleet service when one runs (VIEWER_URL, default :8080);
// without it the viewer falls back to the static files in public/topology.
declare const process: { env: Record<string, string | undefined> } // no @types/node needed
const service = process.env.VIEWER_URL ?? 'http://127.0.0.1:8080'

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  // The 3D host view (three.js) is one lazily loaded ~1.3 MB chunk; the fleet page does not wait for it.
  build: { chunkSizeWarningLimit: 1500 },
  server: {
    proxy: process.env.VIEWER_PROXY === '0' ? undefined : { '/api': { target: service } },
  },
})
