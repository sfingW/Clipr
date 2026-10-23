# Clipr

Free, unlimited, browser-local clipping: drop a long video, get short,
caption-burned vertical clips — no backend, no accounts, no watermarks.

**Status:** Phase 0 scaffold (see [SPEC.md](./SPEC.md)). Not yet deployed.

## Local development

```bash
npm install
npm run dev        # dev server (COOP/COEP headers applied)
npm run build      # == vite build → dist/
npm run preview    # serve dist/ with COOP/COEP headers
npm run typecheck  # tsc --noEmit
```

## COOP/COEP verification (SPEC §14)

Open `/crossorigin-check.html` on the dev server, the preview server, and the
deployed URL. It must show **PASS** (`window.crossOriginIsolated === true`).
If it shows FAIL, nothing downstream (FFmpeg.wasm, some workers) will work —
fix the headers before continuing.

## Deploy — Cloudflare Pages

| Setting | Value |
|---|---|
| Build command | `vite build` |
| Output directory | `dist` |
| Environment variables / secrets | none |

`public/_headers` is served automatically by the CDN and applies
COOP `same-origin` + COEP `require-corp` to every response.

After the first deploy, open `https://<your-domain>/crossorigin-check.html`
and confirm PASS (SPEC §14).
