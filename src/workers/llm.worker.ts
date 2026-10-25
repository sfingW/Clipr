/**
 * LLM worker (SPEC §8.6): scores candidate windows; it never generates clips.
 * Runs entirely in the browser: no server, no API key.
 *
 * Two engines, chosen by the `engine` flag on `llm.load`:
 *   'webllm'       WebLLM on WebGPU (SmolLM2-360M q4f16). Per-window timeout 10 s.
 *   'transformers' Transformers.js on WASM/CPU (SmolLM2-360M ONNX). 60 s per window.
 *
 * The prompt, lenient JSON parsing and retry rules live in pipeline/scoring.ts
 * (pure, and unit tested). The scoring loop is identical for both engines. Only
 * the generate call differs.
 *
 * Generation is serialized inside this worker. Transformers.js cannot interrupt
 * a generate call, so a timed-out CPU window keeps running. Serialization stops
 * the next window from overlapping it.
 */
import { serveRpc, type LlmWorker as LlmMethods, type RpcServerContext } from '../core/rpc';
import {
  scoreWithRetry,
  extractGeneratedText,
  LLM_CONTEXT_WINDOW,
  MAX_TOKENS,
  WINDOW_TIMEOUT_MS,
  CPU_WINDOW_TIMEOUT_MS,
} from '../pipeline/scoring';
import type { Candidate } from '../core/types';
import { CPU_LOADING_NOTE } from '../pipeline/llmFallback';

/** SPEC §8.6 / §11: the WebGPU scoring model. */
export const LLM_MODEL_ID = 'SmolLM2-360M-Instruct-q4f16_1-MLC';
/** CPU scoring model (Transformers.js/ONNX). Unverified in the sandbox; see PR. */
export const CPU_MODEL_ID = 'onnx-community/SmolLM2-360M-Instruct-ONNX';
const CPU_DTYPE = 'q8';

type EngineKind = 'webllm' | 'transformers';

interface ScoreEngine {
  /** Forget chat history before a window. No-op on CPU (no history is kept). */
  reset(): Promise<void>;
  /** One reply for one prompt. Calls are serialized by `serial`. */
  generate(prompt: string, temperature: number): Promise<string>;
  /** Abort the in-flight WebLLM generation after a timeout. CPU has no abort. */
  interrupt(): void;
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(99, Math.round(n)));
}

/** Generation queue. Each step waits for the previous one, even one that timed out. */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(() => fn());
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function loadWebLlm(ctx: RpcServerContext): Promise<ScoreEngine> {
  if (!('gpu' in navigator)) {
    throw new Error('WEBGPU_UNAVAILABLE: navigator.gpu is missing in this worker');
  }
  const { CreateMLCEngine } = await import('@mlc-ai/web-llm');
  ctx.progress(0, { stage: 'llm_loading', note: 'loading model' });
  const engine = await CreateMLCEngine(
    LLM_MODEL_ID,
    {
      initProgressCallback: (report) => {
        ctx.progress(clampPct(report.progress * 100), { stage: 'llm_loading', note: report.text });
      },
    },
    // Smaller KV cache: the model's default window (4096) exhausts GPU memory.
    { context_window_size: LLM_CONTEXT_WINDOW },
  );
  return {
    reset: () => serial(() => engine.resetChat()),
    generate: (prompt, temperature) =>
      serial(async () => {
        const reply = await engine.chat.completions.create({
          messages: [{ role: 'user', content: prompt }],
          temperature,
          max_tokens: MAX_TOKENS,
        });
        return reply.choices[0]?.message?.content ?? '';
      }),
    interrupt: () => {
      void engine.interruptGenerate().catch(() => undefined);
    },
  };
}

async function loadTransformers(ctx: RpcServerContext): Promise<ScoreEngine> {
  const tf = await import('@huggingface/transformers');
  // Each worker has its own module state, so configure ONNX WASM here as the
  // ASR worker does: self-hosted WASM under /ort/, not the CDN.
  tf.env.allowLocalModels = false;
  tf.env.useBrowserCache = true;
  const onnxWasm = tf.env.backends.onnx?.wasm;
  if (onnxWasm) {
    onnxWasm.wasmPaths = `${self.location.origin}/ort/`;
    onnxWasm.numThreads = self.crossOriginIsolated
      ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1))
      : 1;
  }

  ctx.progress(0, { stage: 'llm_loading', note: CPU_LOADING_NOTE });
  type Generator = (input: unknown, options: Record<string, unknown>) => Promise<unknown>;
  const generator = (await tf.pipeline('text-generation', CPU_MODEL_ID, {
    device: 'wasm',
    dtype: CPU_DTYPE,
    progress_callback: (ev: { status?: string; progress?: number }) => {
      if (ev.status === 'progress' && typeof ev.progress === 'number') {
        ctx.progress(clampPct(ev.progress), { stage: 'llm_loading', note: CPU_LOADING_NOTE });
      }
    },
  })) as unknown as Generator;

  return {
    reset: async () => undefined,
    generate: (prompt, temperature) =>
      serial(async () => {
        const out = await generator([{ role: 'user', content: prompt }], {
          max_new_tokens: MAX_TOKENS,
          do_sample: temperature > 0,
          ...(temperature > 0 ? { temperature } : {}),
          return_full_text: false,
        });
        return extractGeneratedText(out);
      }),
    interrupt: () => undefined,
  };
}

/** The engine in use. Loaded once per worker; a failed load is cleared so a retry can run. */
let active: { kind: EngineKind; promise: Promise<ScoreEngine> } | null = null;

function loadEngine(kind: EngineKind, ctx: RpcServerContext): Promise<ScoreEngine> {
  if (active && active.kind === kind) return active.promise;
  const promise = kind === 'webllm' ? loadWebLlm(ctx) : loadTransformers(ctx);
  const entry = { kind, promise };
  active = entry;
  promise.catch(() => {
    if (active === entry) active = null;
  });
  return promise;
}

async function score(
  payload: LlmMethods['llm.score']['payload'],
  ctx: RpcServerContext,
): Promise<LlmMethods['llm.score']['result']> {
  if (!active) throw new Error('llm.score called before llm.load');
  const kind = active.kind;
  const engine = await active.promise;
  const timeoutMs = kind === 'webllm' ? WINDOW_TIMEOUT_MS : CPU_WINDOW_TIMEOUT_MS;
  const total = payload.candidates.length;
  const out: Candidate[] = [];

  for (let i = 0; i < total; i++) {
    const c = payload.candidates[i];
    // Each window is scored in isolation: no chat history carries over.
    await engine.reset();
    const generate = (prompt: string, temperature: number): Promise<string> =>
      engine.generate(prompt, temperature);
    // A stalled window is interrupted and scored at the default, so the job moves on.
    const result = await scoreWithRetry(generate, c.text, {
      timeoutMs,
      onTimeout: () => engine.interrupt(),
    });
    out.push({ ...c, score: result.score, reason: result.reason, source: 'scored' });
    ctx.progress(Math.round(((i + 1) / total) * 100), { stage: 'scoring', done: i + 1, total });
  }
  return out;
}

serveRpc<LlmMethods>(
  self as unknown as {
    addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
    postMessage(message: unknown, transfer?: Transferable[]): void;
  },
  {
    'llm.load': async (payload, ctx) => {
      await loadEngine(payload.engine ?? 'webllm', ctx);
    },
    'llm.score': (payload, ctx) => score(payload, ctx),
  },
);
