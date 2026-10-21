import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const backend = `http://127.0.0.1:${process.env.AGENT_DESK_PORT ?? 47130}`

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/ws': { target: backend, ws: true, changeOrigin: true },
      '/attachments': { target: backend, changeOrigin: true },
      '/api/auth': { target: backend, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
  },
})
