import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Frontend dev server on 4000; the API runs under `wrangler dev` on 8787 (local
// Worker + local D1 + local DO). The client always talks to `/api/app/*`, proxied
// here in dev and same-origin in prod.
// Ports are env-overridable so the kit can run alongside a sibling kit-derived app
// without port clashes. Defaults match prod-parity local dev.
// KIT_WORKER_PORT is passed to `wrangler dev --port` by the dev script: vite's proxy
// target and the Worker's actual port MUST come from the same value, or a busy default
// silently moves the Worker and every /api call proxies to whatever else holds 8787.
const VITE_PORT = Number(process.env.KIT_VITE_PORT) || 4000
const WORKER_PORT = Number(process.env.KIT_WORKER_PORT) || 8787

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: VITE_PORT,
    proxy: {
      '/api/app': `http://127.0.0.1:${WORKER_PORT}`,
    },
  },
  build: {
    outDir: 'build',
  },
})
