import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: Vite serves the app on :5173 and proxies /api to a local
// `wrangler dev` (the Worker in ../worker) on :8787, mirroring how
// production serves the built app and the API from one origin.
// Build output (dist/) is what wrangler.toml's [assets] points at.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
});
