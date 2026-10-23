import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * COOP/COEP isolation headers (SPEC §14).
 * Production headers live in `public/_headers`; the same values are applied
 * here so `vite dev` and `vite preview` behave like the deployed CDN.
 */
const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
} as const;

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
  },
  // Host allowlisting applies only to vite's dev/preview servers (the static
  // `dist` output is served by the CDN without vite); relaxed so preview
  // proxies can reach the server.
  server: {
    headers: ISOLATION_HEADERS,
    allowedHosts: true,
  },
  preview: {
    headers: ISOLATION_HEADERS,
    allowedHosts: true,
  },
});
