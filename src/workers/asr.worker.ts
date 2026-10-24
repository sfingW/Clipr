/**
 * ASR worker (SPEC §8.4): Transformers.js Whisper → `Transcript` with
 * word-level timestamps. All inference runs in this worker, in the browser.
 *
 * Input is the 16 kHz mono float32 WAV written by the extraction step (the
 * only ASR input). It is read window by window with `File.slice`, so the
 * whole file is never held in memory. Whisper takes 30 s inputs; we plan
 * overlapping 30 s windows (`planWindows`), which also drives progress.
 */
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import { getFileHandle } from '../core/opfs';
import { serveRpc, type AsrWorker as AsrMethods, type RpcServerContext } from '../core/rpc';
import { WAV_HEADER_BYTES, parseWavFloat32Header, ASR_SAMPLE_RATE } from '../pipeline/audioExtract';
import {
  normalizeTranscript,
  planWindows,
  stitchWindows,
  type RawWord,
} from '../pipeline/transcript';

/** SPEC §11 tiers → Hugging Face model ids. Basic is the shipped default. */
export const ASR_MODELS = {
  basic: 'Xenova/whisper-tiny.en',
  full: 'Xenova/whisper-base.en',
} as const;

// Self-host the ONNX Runtime WASM (scripts/copy-ort.mjs → public/ort/). The
// library default is a jsDelivr CDN URL, which COEP must not depend on.
env.allowLocalModels = false;
env.useBrowserCache = true;
const onnxWasm = env.backends.onnx?.wasm;
if (onnxWasm) {
  onnxWasm.wasmPaths = `${self.location.origin}/ort/`;
  // Threads need SharedArrayBuffer, which needs cross-origin isolation (SPEC §14).
  onnxWasm.numThreads = self.crossOriginIsolated
    ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1))
    : 1;
}

type Tier = keyof typeof ASR_MODELS;
type AsrPipeline = AutomaticSpeechRecognitionPipeline;

/** One load at a time per tier; a failed load is cleared so a retry can run. */
const loaded: Partial<Record<Tier, Promise<AsrPipeline>>> = {};

interface ProgressEvent {
  status?: string;
  file?: string;
  loaded?: number;
  total?: number;
  progress?: number;
}

function loadPipeline(tier: Tier, ctx: RpcServerContext): Promise<AsrPipeline> {
  const existing = loaded[tier];
  if (existing) return existing;

  // Aggregate byte progress across all model files.
  const files = new Map<string, { loaded: number; total: number }>();
  const report = (): void => {
    let done = 0;
    let total = 0;
    for (const f of files.values()) {
      done += f.loaded;
      total += f.total;
    }
    const pct = total > 0 ? Math.min(99, Math.round((done / total) * 100)) : 0;
    ctx.progress(pct, { stage: 'asr_loading', note: 'downloading model', done, total });
  };

  const p = (async () => {
    ctx.progress(0, { stage: 'asr_loading', note: 'loading model' });
    return (await pipeline('automatic-speech-recognition', ASR_MODELS[tier], {
      device: 'wasm',
      dtype: 'q8',
      progress_callback: (ev: ProgressEvent) => {
        if (ev.status === 'progress' && ev.file && typeof ev.loaded === 'number' && typeof ev.total === 'number') {
          files.set(ev.file, { loaded: ev.loaded, total: ev.total });
          report();
        }
      },
    })) as unknown as AsrPipeline;
  })();

  loaded[tier] = p;
  p.catch(() => {
    if (loaded[tier] === p) delete loaded[tier];
  });
  return p;
}

async function transcribe(
  payload: AsrMethods['asr.run']['payload'],
  ctx: RpcServerContext,
): Promise<AsrMethods['asr.run']['result']> {
  const handle = await getFileHandle(payload.audioPath);
  const file = await handle.getFile();
  const info = parseWavFloat32Header(new Uint8Array(await file.slice(0, WAV_HEADER_BYTES).arrayBuffer()));
  if (info.sampleRate !== ASR_SAMPLE_RATE || info.channels !== 1) {
    throw new Error(`asr-input: expected ${ASR_SAMPLE_RATE} Hz mono, got ${info.sampleRate} Hz × ${info.channels}`);
  }
  const durationSec = info.sampleCount / info.sampleRate;
  const plans = planWindows(durationSec);

  const asr = await loadPipeline(payload.tier, ctx);

  const windows: { offsetSec: number; words: RawWord[] }[] = [];
  ctx.progress(0, { stage: 'asr_running', note: 'transcribing', done: 0, total: plans.length });
  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i];
    const s0 = Math.round(plan.offsetSec * info.sampleRate);
    const s1 = Math.min(info.sampleCount, s0 + Math.round(plan.lengthSec * info.sampleRate));
    const bytes = await file.slice(info.dataOffset + s0 * 4, info.dataOffset + s1 * 4).arrayBuffer();
    const samples = new Float32Array(bytes);
    const out = (await asr(samples, { return_timestamps: 'word' })) as unknown as { chunks?: RawWord[] };
    windows.push({ offsetSec: plan.offsetSec, words: Array.isArray(out?.chunks) ? out.chunks : [] });
    ctx.progress(Math.round(((i + 1) / plans.length) * 100), {
      stage: 'asr_running',
      note: 'transcribing',
      done: i + 1,
      total: plans.length,
    });
  }

  return normalizeTranscript(stitchWindows(windows), { durationSec, language: 'en' });
}

serveRpc<AsrMethods>(
  self as unknown as {
    addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
    postMessage(message: unknown, transfer?: Transferable[]): void;
  },
  {
    'asr.run': (payload, ctx) => transcribe(payload, ctx),
  },
);
