import { readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
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

/**
 * Cloudflare Pages rejects any single asset larger than 25 MiB while
 * validating the output directory (the GitHub check then reports
 * "Build failed"). `@ffmpeg/core`'s wasm is ~31 MiB, so after the bundle is
 * written we split it into same-origin parts plus a manifest; the FFmpeg
 * fallback (src/pipeline/ffmpegFallback.ts) fetches the parts and reassembles
 * them into a `blob:` URL before `ffmpeg.load()`. `vite dev` never runs this
 * plugin, and the loader falls back to the whole-file URL when no manifest
 * exists. Any other oversized `.wasm` asset is split the same way.
 */
const CF_ASSET_LIMIT_BYTES = 25 * 1024 * 1024; // 25 MiB — Cloudflare Pages cap
const WASM_PART_BYTES = 16 * 1024 * 1024; // 16 MiB parts (2 × <16.5 MiB for the core)

function splitOversizedWasmAssets(): Plugin {
  let outDir = 'dist';
  return {
    name: 'clipr:split-oversized-wasm',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const assetsDir = join(outDir, 'assets');
      let names: string[];
      try {
        names = readdirSync(assetsDir);
      } catch {
        return; // no assets dir — nothing to do
      }
      for (const name of names) {
        if (!name.endsWith('.wasm') || name.includes('.part')) continue;
        const file = join(assetsDir, name);
        const { size } = statSync(file);
        if (size <= CF_ASSET_LIMIT_BYTES) continue;
        const buf = readFileSync(file);
        const partNames: string[] = [];
        const count = Math.ceil(size / WASM_PART_BYTES);
        for (let i = 0; i < count; i++) {
          const partName = `${name}.part${i}`;
          writeFileSync(join(assetsDir, partName), buf.subarray(i * WASM_PART_BYTES, (i + 1) * WASM_PART_BYTES));
          partNames.push(partName);
        }
        writeFileSync(
          join(assetsDir, `${name}.parts.json`),
          `${JSON.stringify({ parts: partNames, totalSize: size })}\n`,
        );
        unlinkSync(file);
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), splitOversizedWasmAssets()],
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: new URL('./index.html', import.meta.url).pathname,
        'spike-mux': new URL('./spike-mux.html', import.meta.url).pathname,
      },
    },
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
