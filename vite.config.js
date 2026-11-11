import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true,
    // Vite does not run Vercel Functions. Reuse the deployed gateway so local
    // requests retain the same authentication, approval and IP policy checks.
    proxy: {
      '/api/gateway': {
        target: 'https://partnerdesk-phi.vercel.app',
        changeOrigin: true,
      },
    },
  },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  plugins: [
    react(),
  ]
});
