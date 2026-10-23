# SPEC.md — Clipr

## 0. How to read this document

You are the coding agent for this project. This document is authoritative. Where it conflicts with your instincts, follow the document. Where it's silent, use judgment consistent with its philosophy. Where it says "do not build X," do not build X even if X seems obviously useful — each exclusion exists for a reason stated in §2 and §15.

Work proceeds in numbered phases (§16). Do not begin a phase until the previous phase's definition of done (§19) is met. Each phase must be independently shippable.

---

## 1. Project identity

**Name:** Clipr.

**What it is:** A browser-based social media clipping tool. A user drops a long video (podcast, stream, interview, webinar) into the page and receives short, vertical, caption-burned clips ready for TikTok, Shorts, Reels, and LinkedIn.

**What makes it different:** It runs entirely in the browser tab. There is no backend that processes video, no account system, no API keys, no usage metering, no free-tier ceiling, no per-minute billing. The application is a static site — a folder of HTML/JS/WASM files — deployed to a CDN. Every expensive operation (demux, decode, transcription, AI scoring, reframing, rendering, encoding) executes on the user's own hardware using browser APIs.

**The product promise:** Free forever, unlimited use, no signup, no quotas, no watermarks. This promise is kept not by subsidizing compute but by never owning compute. If a feature would require a server, it does not belong in this product.

---

## 2. Non-negotiable constraints

These are hard constraints. Any implementation that violates one is wrong regardless of how elegant it is.

1. **Zero server-side video processing.** No uploads of user media to any server. No cloud transcoding. No server-side ASR, LLM, or rendering.
2. **Zero accounts.** No login, no email capture, no user records, no database.
3. **Zero API keys.** No BYOK, no proxy to paid or free LLM/ASR APIs, no metered third-party inference. All AI runs locally in the browser via WebGPU/WASM.
4. **Zero rate limits imposed by us.** No usage caps, no daily limits, no clip counts, no duration caps enforced by the product. (Physical limits of the user's device are acceptable and handled via the tier system in §11.)
5. **Zero watermarks.**
6. **Works offline after first visit.** Once models and shell are cached, the app must function with the network disconnected.
7. **Static deployment.** The build output must be servable by a plain CDN (Cloudflare Pages target). No runtime server, no edge functions, no serverless handlers.
8. **No analytics, no telemetry, no tracking** by default. If analytics are added later, they must be opt-in and must never transmit media or transcript content.

Any proposal that requires relaxing one of these must be escalated to the human, not decided unilaterally.

---

## 3. What the user experiences

### The happy path

1. User visits the static site. Shell renders in under a second. A drop zone fills the screen.
2. User drags in a 45-minute podcast MP4. The file is written to OPFS immediately — no upload, no spinner.
3. Within seconds, the app displays video metadata (duration, resolution) and begins downloading the Whisper-tiny model in the background.
4. Within ~10 seconds, the user can already scrub and manually mark clip in/out points. **The cutter works before any AI is ready.**
5. Transcription runs. A transcript pane populates with word-level timings, clickable to seek.
6. The LLM model finishes downloading. A ranked candidate list appears: 5–8 suggested clips with a score and a one-line reason each.
7. User clicks a candidate. A live preview shows the clip as a vertical 9:16 frame with the active speaker tracked and animated captions overlaid.
8. User tweaks: adjusts start/end, picks a caption style, nudges the crop if needed.
9. User clicks Export. The render worker produces an MP4 in the tab and triggers a download.
10. Repeat for as many clips as the user wants. No limit.

### The degraded paths

- **No WebGPU:** transcription still runs (slower, WASM). No AI candidate list. Manual cutting, captions, reframing via center crop all still work.
- **Weak device:** tiny ASR model only, or no ASR. Manual cutter still fully functional.
- **Safari with codec gaps:** export falls back to FFmpeg.wasm path. Slower but correct.
- **Large file:** chunked processing keeps memory bounded; a warning appears if resolution exceeds the in-browser safe ceiling.

**The floor — manual cutter with vertical crop, captions, and export — must work on every device that supports the base tech.** AI is an enhancement tier, never a prerequisite.

---

## 4. Architecture overview

The application is a single-page static site with a main UI thread and five isolated Web Workers. Workers communicate with the main thread via a typed postMessage RPC layer. All persistence is browser-local (OPFS for media, Cache API for models). There is no network activity after the initial shell and model downloads.

```
Static site (CDN)
   │
   ├── Main thread: React UI + orchestrator + job state machine
   │
   ├── demux.worker    → mp4box.js container parse + WebCodecs VideoDecoder
   ├── asr.worker      → Transformers.js Whisper → Transcript
   ├── llm.worker      → WebLLM (SmolLM2) → Candidate scores
   ├── vision.worker   → MediaPipe FaceDetector → crop keyframes
   └── render.worker   → WebCodecs encode + canvas composite → MP4 Blob
   │
   └── Storage: OPFS (media + artifacts) · Cache API (model weights)
```

Each worker is independently crashable. The orchestrator must survive the failure of any single worker by degrading to the appropriate tier (§11), never by taking down the app.

---

## 5. Data contracts

These types live in `src/core/types.ts`. They are the interfaces between subsystems and must be defined before any pipeline code is written. Changing them requires updating every consumer.

```ts
/** Set once at ingest. */
export interface SourceMeta {
  id: string;                  // uuid v4
  opfsPath: string;            // OPFS file handle path
  fileName: string;
  durationSec: number;
  width: number;
  height: number;
  videoCodec: string;          // e.g. "avc1.640028"
  audioCodec: string;          // e.g. "mp4a.40.2"
  frameRate: number;
  sizeBytes: number;
}

/** Extracted audio, 16kHz mono, for ASR. */
export interface AudioTrack {
  opfsPath: string;            // WAV or raw PCM
  durationSec: number;
  sampleRate: 16000;
}

/** Word-level timings. The IR. Everything downstream reads this. */
export interface Transcript {
  language: string;
  words: Word[];
  segments: Segment[];
}

export interface Word {
  text: string;
  start: number;               // seconds
  end: number;
}

export interface Segment {
  text: string;
  start: number;
  end: number;
  speaker?: number;            // diarization label, optional in v1
}

/** Pure-code candidate windows. Produced before any AI runs. */
export interface Candidate {
  id: string;
  startSec: number;
  endSec: number;
  text: string;
  score?: number;              // 1-10, filled by LLM
  reason?: string;             // ≤12 words, from LLM
  source: 'manual' | 'chunked' | 'scored';
}

/** Everything needed to render one clip. */
export interface ClipSpec {
  id: string;
  candidateId?: string;
  sourceStartSec: number;
  sourceEndSec: number;
  crop: CropKeyframe[];        // empty → center crop
  captionStyleId: string;
  captions: CaptionLine[];
  format: 'vertical' | 'original';
  exportPreset: '1080p' | '720p';
}

export interface CropKeyframe {
  t: number;                   // seconds relative to clip start
  x: number;                   // crop-left in source pixels
  width: number;               // crop width in source pixels
}

export interface CaptionLine {
  text: string;
  start: number;               // seconds relative to clip start
  end: number;
  words?: Word[];              // for word-sync highlighting
}
```

**Rationale:** `Transcript` is the single source of truth for timing. Every clip boundary, caption timing, and candidate window resolves through it. Nothing downstream of transcription should ever inspect raw pixels or audio except the render and vision workers.

---

## 6. Tech stack

Pin these. Do not substitute without escalation.

| Concern | Package / API | Notes |
|---|---|---|
| Build | `vite` + `typescript` | Output must be static |
| UI | `react@18` + `react-dom` | No SSR, no Next.js |
| State | `zustand` | Store shape: job state + UI state |
| Container demux/mux | `mp4box` | WebCodecs does not parse containers. Mandatory. |
| Decode/encode | `WebCodecs` (browser API) | `VideoDecoder`, `VideoEncoder`, `AudioDecoder` |
| Fallback transcode/mux | `@ffmpeg/ffmpeg` + `@ffmpeg/core` | Requires COOP/COEP (§14) |
| ASR | `@huggingface/transformers` (Transformers.js) | Models: `Xenova/whisper-tiny.en`, `Xenova/whisper-base.en` |
| LLM | `@mlc-ai/web-llm` | Model: `SmolLM2-360M-Instruct-q4f16_1-MLC` |
| Vision | `@mediapipe/tasks-vision` | `FaceDetector`, short-range |
| Storage | OPFS + Cache API | Browser APIs, no wrappers unless thin |
| Captions (preview) | Canvas 2D | Editable live overlay |
| Captions (export) | Canvas 2D → WebCodecs frames | Same draw code as preview |
| Testing | `vitest` | Pure-function tests mandatory (§17) |

**Version policy:** pin exact versions in `package.json` (`"mp4box": "0.5.2"`, not `"^0.5.2"`). This project's dependency surface is small enough to pin everything.

---

## 7. Repository structure

```
clipr/
├── public/
│   ├── _headers
│   └── fonts/                      # caption fonts, self-hosted
├── src/
│   ├── main.tsx
│   ├── app/
│   │   ├── App.tsx
│   │   ├── tiers.ts                # capability detection
│   │   └── store.ts                # zustand
│   ├── core/
│   │   ├── types.ts                # §5, single source of truth
│   │   ├── jobMachine.ts           # state machine
│   │   ├── opfs.ts                 # file IO
│   │   ├── modelCache.ts           # Cache API wrapper
│   │   └── rpc.ts                  # typed worker RPC
│   ├── workers/
│   │   ├── demux.worker.ts
│   │   ├── asr.worker.ts
│   │   ├── llm.worker.ts
│   │   ├── vision.worker.ts
│   │   └── render.worker.ts
│   ├── pipeline/
│   │   ├── ingest.ts
│   │   ├── audioExtract.ts
│   │   ├── chunking.ts             # pure
│   │   ├── scoring.ts
│   │   ├── snap.ts                 # pure
│   │   ├── reframe.ts              # pure given boxes
│   │   ├── caption.ts              # pure given words
│   │   └── render.ts               # orchestrates render.worker
│   ├── components/
│   │   ├── DropZone.tsx
│   │   ├── TranscriptPane.tsx
│   │   ├── CandidateList.tsx
│   │   ├── ClipPreview.tsx
│   │   ├── ExportPanel.tsx
│   │   └── ModelStatus.tsx
│   └── styles/
├── tests/
│   ├── chunking.test.ts
│   ├── snap.test.ts
│   ├── reframe.test.ts
│   └── caption.test.ts
├── SPEC.md                         # this file
├── vite.config.ts
└── package.json
```

**Rule:** `src/core` and `src/pipeline` contain no React imports and no DOM access except in `opfs.ts`. This keeps the pure logic testable in Node via vitest.

---

## 8. Subsystem specifications

### 8.1 Ingest (`pipeline/ingest.ts`)

Input: `File` from drop or picker. Output: `SourceMeta` with the file written to OPFS.

- Stream the file into OPFS via `navigator.storage.getDirectory()` and a `FileSystemWritableFileStream`. Do not load the full file into a JS `ArrayBuffer`.
- Parse metadata with `mp4box.js` by reading only the first and last few MB (moov atom may be at either end).
- Extract `durationSec`, `width`, `height`, `frameRate`, `videoCodec`, `audioCodec`.
- If the container is not ISO-BMFF, mark for FFmpeg.wasm path and skip WebCodecs.

**Failure handling:** quota exceeded → clear error, suggest a shorter file. Unsupported container → attempt FFmpeg path, else fail cleanly.

### 8.2 Demux + decode (`workers/demux.worker.ts`)

- Use `mp4box.js` to extract track samples.
- Feed encoded video samples to `VideoDecoder`, encoded audio samples to `AudioDecoder`.
- Downsample video frames to a max width of 320 px for the vision worker (real frames are only decoded again at render time).
- For the render path, decode at target resolution and pass `VideoFrame` objects to the render worker via `postMessage` with `transfer` of the underlying buffers where possible.

**Critical:** do not buffer all frames. Streaming, window-based decode only.

### 8.3 Audio extraction (`pipeline/audioExtract.ts`)

- Decode audio track to 16 kHz mono PCM Float32.
- Encode to WAV and write to OPFS.
- This file is the sole input to the ASR worker.

### 8.4 Transcription (`workers/asr.worker.ts`)

- Load `@huggingface/transformers` pipeline `automatic-speech-recognition` with model selected by tier (§11).
- Enable `return_timestamps: 'word'` to get word-level output.
- Normalize into the `Transcript` shape.
- Emit progress events: `{ stage: 'asr', pct }`.

**Failure handling:** if the model fails to load or the worker crashes, escalate to the orchestrator which must set AI tier to `basic` and allow manual operation.

### 8.5 Chunking (`pipeline/chunking.ts`) — pure, testable

```
function chunkTranscript(t: Transcript): Candidate[]
```

- Sliding windows of 40s with 15s stride over `segments`.
- Snap each window boundary to the nearest segment start/end within 3s.
- Discard windows shorter than 3s or with fewer than 8 words.
- Merge windows that overlap more than 80% (dedupe).
- Target: produce roughly 3× more candidates than the final list will show.

This function must have unit tests. It is where most quality is decided.

### 8.6 Scoring (`pipeline/scoring.ts` + `workers/llm.worker.ts`)

The LLM **scores candidates**; it does not generate clips.

Prompt template (final, do not soften):

```
Rate how well the following transcript window would work as a
standalone vertical short (1–10).

Criteria:
- strong opening hook in the first 3 seconds
- self-contained: makes sense without prior context
- has an emotional, insight, or humor payoff
- does not start mid-sentence or leave setup unresolved

Return strict JSON only: {"score": <1-10>, "reason": "<12 words max>"}

WINDOW:
"{text}"
```

- Run in `llm.worker` via WebLLM with `temperature: 0.2`, `max_tokens: 60`.
- Parse JSON leniently (find first `{` ... last `}`); on parse failure, retry once with `temperature: 0`.
- After all candidates are scored, sort descending and keep the top 8 by default.
- Emit progress: `{ stage: 'scoring', done, total }`.

**Failure handling:** worker crash or WebGPU unavailable → tier drops to `basic`, candidate list shows raw chunked candidates without scores.

### 8.7 Timestamp snapping (`pipeline/snap.ts`) — pure, testable

```
function snapToWords(c: Candidate, t: Transcript): { start: number; end: number }
```

- Fuzzy-match the candidate's first words against transcript words within ±2s of the raw start; use same for end.
- Expand to segment boundaries if the snap is within 800 ms.
- Never start mid-word; never truncate the hook word if it's within the window.

This is the fix for the most common failure mode in this category — clips that start a beat too late and lose the hook.

### 8.8 Reframing (`pipeline/reframe.ts` + `workers/vision.worker.ts`)

`vision.worker`:
- Sample every 3rd frame at max 320 px wide between `sourceStartSec` and `sourceEndSec`.
- Run MediaPipe `FaceDetector` (short-range).
- Emit `{ t: seconds, boxes: {x,y,w,h,score}[] }[]`.

`reframe.ts` (pure, given boxes):
- Choose the largest/most-central face per frame.
- Apply hysteresis: only switch locked speaker if a new face is meaningfully larger for ≥3 consecutive samples.
- Build a raw x-path (crop-left) from face centers.
- Apply a median filter over a 5-sample window, then quantize to 3–5 discrete positions per clip.
  - **Quantization is mandatory.** A smoothly-panning crop looks amateur; jump-cuts between confident static framings look professional.
- Crop width fixed at `sourceHeight * 9/16` (or matching preset), clamped to source bounds.

**No faces detected:** return empty crop array → consumer falls back to center crop.

### 8.9 Caption rendering (`pipeline/caption.ts`)

Pure function producing draw instructions:

```
function buildCaptionLines(spec: ClipSpec, styles: CaptionStyle): CaptionLine[]
```

- Group words into lines of ≤4 words or ≤22 characters.
- Each line inherits word-level timings for word-sync highlighting.
- Two styles ship in v1: `bold-center` (large all-caps centered, white with black outline) and `karaoke` (word-by-word highlight in accent color).

The same draw function is used in `ClipPreview` (canvas, live) and in the render worker (canvas → frame). **One implementation, two callers.** This is non-negotiable; divergence between preview and export is a common bug source.

### 8.10 Render (`workers/render.worker.ts`)

Input: `ClipSpec` + OPFS handle to source. Output: `Blob` (MP4).

- Prefer WebCodecs path: `VideoEncoder` configured for `avc1.640028` (H.264 High) at target resolution, `AudioEncoder` for AAC. Mux with `mp4box.js`.
- Composite each frame: draw source frame at the current crop to a 1080×1920 (or 720×1280) OffscreenCanvas, then draw the caption layer per `caption.ts`.
- Audio: re-encode from the source, offset to `sourceStartSec`, transcode AAC if needed.
- If WebCodecs `VideoEncoder` fails for the target codec (common on Safari), fall back to `@ffmpeg/ffmpeg` with the same composited frames or with an intermediate lossless stream.

**Progress:** emit `{ stage: 'rendering', pct, etaSec }`.

**Failure handling:** if both paths fail, keep the intermediate frame sequence and audio in OPFS and offer a "download raw" fallback. Never lose the user's work silently.

---

## 9. Worker protocol

All workers expose a request/response protocol over `postMessage`. Define in `src/core/rpc.ts`:

```ts
type Request<T, P> = { id: string; type: T; payload: P };
type Response<T, R> = { id: string; type: T; ok: true; result: R }
                   | { id: string; type: T; ok: false; error: string };
type Progress = { id: string; pct: number; note?: string };

interface AsrWorker {
  'asr.run': { audioPath: string; tier: 'full' | 'basic' } → Transcript
}

interface LlmWorker {
  'llm.load': { tier: 'full' | 'basic' } → void
  'llm.score': { candidates: Candidate[] } → Candidate[]   // with score+reason
}

interface VisionWorker {
  'vision.track': { sourcePath: string; start: number; end: number } → FaceSample[]
}

interface RenderWorker {
  'render.clip': { spec: ClipSpec; sourcePath: string } → { mp4: Uint8Array }
}
```

Timeouts: each request has a configurable timeout (default 10 min for render, 5 min for ASR). Timeout → reject → orchestrator degrades tier.

---

## 10. Job state machine

Defined in `core/jobMachine.ts`. One state machine per ingested file.

```
idle → ingesting → ingesting_done
                 → asr_loading → asr_running → transcript_ready
                                              → llm_loading → scoring → candidates_ready
                                                                   → ready           (user can edit & export)
                                                                   → rendering → exporting → done
```

Rules:
- `transcript_ready` implies the cutter is usable (phase 3 milestone).
- `candidates_ready` implies AI list is available.
- `ready` is entered as soon as *either* transcript is available OR candidates are, whichever comes first.
- Failure of `asr_*` or `llm_*` does not fail the job; it just skips to the corresponding degraded state.
- `rendering` failures return to `ready` with an error surfaced in the UI, never to a dead state.

---

## 11. Tier system

Computed once at startup in `app/tiers.ts`:

```ts
type Tier = 'full' | 'basic' | 'minimal';

async function detectTier(): Promise<Tier> {
  if (!('gpu' in navigator)) return 'basic';
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return 'basic';
  // Check for sufficient adapter limits; if in doubt, 'basic'
  return 'full';
}
```

| Tier | ASR model | LLM | Vision | Notes |
|---|---|---|---|---|
| full | whisper-base.en | SmolLM2-360M | MediaPipe | Default target |
| basic | whisper-tiny.en | none | center crop | No WebGPU |
| minimal | none | none | center crop | Manual cutter only |

The tier is displayed in `ModelStatus` and the user can manually force a lower tier (e.g., "use less memory").

---

## 12. Progressive loading UX

The main thread schedules work in this order, never blocking the UI:

```
t=0ms      Render shell. DropZone active. No spinner.
t=~1s      File dropped → OPFS write begins.
t=~3s      Whisper-tiny download begins (progress in corner).
t=~8s      Whisper ready → transcription starts.
t=~10s     LLM download begins in background.
t=~25s     Transcript pane populated. Cutting works NOW.
t=~60s     LLM ready → scoring begins → candidates appear.
```

Hard rules:
- Never block the drop zone on any model.
- Never block the cutter on the AI.
- Never block the UI thread for more than 16 ms.
- Every long-running operation shows progress within 500 ms of starting.

---

## 13. Performance budgets

Enforce these or reduce scope; do not extend them.

| Metric | Budget |
|---|---|
| Initial JS shell (gzip) | < 150 KB |
| Whisper-tiny model | ~40 MB |
| Whisper-base model | ~150 MB |
| SmolLM2 q4 model | ~250 MB |
| Total first-visit download (full tier) | < 450 MB |
| Time to first interactable cutter | < 10 s |
| Transcript for a 20-min video | < 3 min on M1-class |
| 60 s clip render (1080p) | < 30 s |
| Main-thread long task | < 50 ms |

---

## 14. Deployment

Target: Cloudflare Pages (or any static CDN).

Required headers, in `public/_headers`:

```
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
```

Verification step for phase 0: `window.crossOriginIsolated === true` on the deployed URL. If false, FFmpeg.wasm and some workers will fail. This is the most common deployment bug; check it explicitly.

Build command: `vite build`. Output dir: `dist`. No environment variables. No secrets. No CI secrets to configure.

---

## 15. What NOT to build

Do not add these features, now or later, without explicit instruction:

- URL ingest from YouTube/TikTok/etc. Requires a fetch server. Out of scope.
- User accounts, cloud saves, projects.
- Auto-posting to social platforms.
- Cloud rendering or cloud AI inference.
- BYOK / API key input.
- Analytics, telemetry, error reporting that transmits content.
- Multi-track timeline editor.
- Music library, B-roll library, stock asset integration.
- Payments, subscriptions, licensing checks.
- Electron/Tauri desktop wrapper (out of scope for this phase; the browser is the target).
- A settings page beyond caption style and tier override.
- Any feature whose implementation requires a network request after the initial load.

If you believe a feature outside this list is essential to v1, stop and escalate rather than build it.

---

## 16. Build order

Each phase is independently shippable. Do not merge phases.

### Phase 0 — Scaffold (2–3 days)
Vite + TS + React. Zustand store skeleton. Cloudflare Pages deployment. `_headers` verified via `crossOriginIsolated`. Tier detection stub with hardcoded `'basic'`. Empty DropZone.

**Ship:** a deployed blank page with COOP/COEP confirmed.

### Phase 1 — The cutter (1–2 weeks)
File drop → OPFS write → mp4box metadata → WebCodecs decode → in/out scrub UI → export via WebCodecs + mp4box mux. No AI, no transcript, no captions, no reframe.

**Ship:** a working frame-accurate MP4 cutter.

### Phase 2 — Transcription (1–1.5 weeks)
Audio extract → ASR worker → transcript pane with word-level timings and click-to-seek. Works at basic tier.

**Ship:** cutter + transcript.

### Phase 3 — Captions (1 week)
Caption style definitions. Shared draw function used by preview canvas and render worker. Export produces burned-in captions.

**Ship:** cutter + transcript + captions. **This is the recommended public launch point.**

### Phase 4 — AI scoring (1–2 weeks)
Chunking, snapping, LLM worker, candidate list UI. Full tier only. Degrades cleanly to phase 3 behavior.

**Ship:** adds ranked suggestions.

### Phase 5 — Reframing (1–2 weeks)
Vision worker + reframe pipeline + vertical export. Center crop fallback.

**Ship:** vertical clips with speaker tracking.

### Phase 6 — UX hardening (1 week)
Progressive loading, model caching, tier fallbacks, error states, empty states, quota handling.

**Ship:** production-ready.

### Phase 7 — Polish (1 week)
Multi-clip queue, download-all, ZIP export, caption style presets, keyboard shortcuts.

**Ship:** v1.0.

---

## 17. Testing

Mandatory unit tests (`vitest`) for the pure pipeline functions:

- `chunking.test.ts` — windowing, dedupe, minimum length.
- `snap.test.ts` — fuzzy matching, boundary expansion, hook preservation.
- `reframe.test.ts` — median filter, quantization, hysteresis, no-face fallback.
- `caption.test.ts` — line grouping, character limits, style application.

Integration tests are optional in v1 but valuable for:
- OPFS write/read roundtrip.
- WebCodecs encode of a known 1s color-bar clip produces a valid MP4.

Do not write UI tests in v1. Manual QA covers them faster at this stage.

---

## 18. Coding conventions

- TypeScript strict mode on. No `any` outside isolated FFI-style shims.
- No default exports except React components.
- No `console.log` in committed code; use a small `log()` helper that is tree-shaken in production.
- Errors: return discriminated unions or throw; never return `null` for "it failed."
- All pipeline functions in `src/pipeline` and `src/core` must be pure and deterministic except `opfs.ts` and worker entry points.
- No barrel `index.ts` files — import directly, keeps bundles small.
- Commit messages: `feat(phase-N): …`, `fix(worker/asr): …`, `test(pipeline/snap): …`.

---

## 19. Definition of done per phase

A phase is done only when:

1. All features listed for that phase work end-to-end in Chrome, Edge, and Safari (latest).
2. Full tier and basic tier both pass (Safari may only pass at basic if WebGPU unavailable — note it).
3. No regression in earlier phases' features.
4. Performance budgets (§13) still met or exceeded only in the sense of better, not worse.
5. `crossOriginIsolated === true` in production.
6. Deployed and manually verified at the public URL.

---

## 20. Failure modes to explicitly handle

Every one of these must have a UI state, not a crash:

- File too large for OPFS quota.
- Unsupported container.
- Unsupported codec for WebCodecs (fall back to FFmpeg).
- ASR worker crash or model load failure (degrade to basic).
- LLM worker crash or WebGPU device loss (degrade to basic).
- Vision worker crash during tracking (center crop).
- Render failure on both WebCodecs and FFmpeg paths (preserve intermediates, offer raw).
- Tab backgrounded mid-render (worker must continue; on mobile some browsers will pause — surface a warning).
- Model download interrupted (resume via Cache API partial writes; retry once on network restore).
- User reloads mid-job (OPFS persists; detect and offer to resume).

If any of these manifest as a blank screen or unhandled rejection, the phase is not done.

---

## 21. Open question for the human

The plan assumes **public launch at Phase 3** (cutter + transcript + captions), with AI arriving at Phases 4–5. This de-risks the two hardest technical pieces (mp4box muxing, caption burn-in) before depending on them, and it guarantees the app is usable on every device.

If the human wants AI in the initial public launch, Phases 1–5 must complete before any launch. Confirm before starting Phase 1.

---

*End of SPEC.md.*
