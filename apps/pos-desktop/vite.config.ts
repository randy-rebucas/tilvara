import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Browser mode (ADR-0006): the POS talks to the API through this origin, so no CORS and no
 * tokens in cookies of another origin. API_URL overrides the default local API.
 */
const api = process.env.API_URL ?? 'http://127.0.0.1:4320';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy: { '/v1': api } },
  preview: { proxy: { '/v1': api } },
  build: { sourcemap: true },
});
