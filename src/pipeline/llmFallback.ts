/**
 * Tiered AI engine fallback (Phase 4 cross-platform).
 *
 *   Tier 1  WebLLM on WebGPU (SmolLM2-360M q4f16). Fast; can crash the GPU.
 *   Tier 2  Transformers.js on WASM/CPU (SmolLM2-360M ONNX). Slower; no GPU.
 *   Tier 3  No AI: the caller lists the unscored windows (runScoring).
 *
 * This module owns the decision: a GPU-class failure on WebGPU terminates that
 * worker, spawns a fresh one on the CPU engine, and retries the same step. The
 * session stays on CPU afterwards, so a crashed GPU is not hit again. Pure
 * logic: the workers are supplied through `spawn`, which keeps it testable.
 */
import type { LlmWorker, RpcClient } from '../core/rpc';
import type { EngineLabel, Report, ScoringDeps } from './scoring';

export type EngineKind = 'webllm' | 'transformers';

export const GPU_FALLBACK_NOTE = 'GPU crashed. Retrying on CPU (this may take a moment)...';
export const CPU_LOADING_NOTE = 'Loading AI on CPU (this may take a moment)...';

/**
 * Idle limit for load and score requests. Progress events re-arm it. Each
 * window is bounded by its own per-call timeout, so a hang shows up as silence
 * here, and this is only the outer backstop.
 */
const IDLE_TIMEOUT_MS = 300_000;

/**
 * Errors that mean the WebGPU path is broken (device lost, GPU hang, out of GPU
 * memory, worker crash, idle timeout). Download and other errors are not GPU
 * failures, so they are not retried on CPU.
 */
const GPU_FAILURE = new RegExp(
  [
    'device.*lost',
    'gpu timeout',
    'mapAsync',
    'GPUBuffer',
    'command buffer',
    'out of memory',
    'insufficient memory',
    'allocation failed',
    'WEBGPU_UNAVAILABLE',
    'webgpu',
    'worker error',
    'rpc timeout',
  ].join('|'),
  'i',
);

export function isGpuFailure(err: unknown): boolean {
  // A dead worker (crash or messageerror) is a GPU failure on the WebGPU tier.
  // The name is checked, not instanceof, so this module stays free of runtime
  // imports from core/rpc.
  if (err instanceof Error && err.name === 'WorkerUnavailableError') return true;
  const msg = err instanceof Error ? err.message : String(err);
  return GPU_FAILURE.test(msg);
}

export type SpawnFn = () => RpcClient<LlmWorker>;

export interface FallbackOptions {
  /** False when WebGPU is known to be unavailable: start on CPU directly. */
  preferWebGpu: boolean;
  spawn: SpawnFn;
  onFallback?: (err: unknown) => void;
}

export function createFallbackDeps(opts: FallbackOptions): ScoringDeps {
  let kind: EngineKind = opts.preferWebGpu ? 'webllm' : 'transformers';
  let client: RpcClient<LlmWorker> | null = null;
  let loaded = false;

  const label = (): EngineLabel => (kind === 'webllm' ? 'webgpu' : 'cpu');

  /** Start a brand-new worker for `next`. Never reuse a crashed one. */
  const start = (next: EngineKind): void => {
    client = opts.spawn();
    kind = next;
    loaded = false;
  };

  const loadOn = async (report: Report): Promise<void> => {
    const c = client;
    if (!c) throw new Error('llm client missing');
    await c.request(
      'llm.load',
      { tier: 'full', engine: kind },
      {
        timeoutMs: IDLE_TIMEOUT_MS,
        resetOnProgress: true,
        onProgress: (p) => report({ pct: p.pct, note: p.note, engine: label() }),
      },
    );
    loaded = true;
  };

  /**
   * Hand off from the crashed WebGPU worker to a new CPU worker. Order matters
   * for latency: the WASM worker is spawned and its model load starts first
   * (the pre-warm); the dead GPU client is disposed in the same tick. Both
   * steps are sync, so the disposal does not hold up the download.
   * Returns the pre-warm promise, which resolves when the CPU model is ready.
   */
  const fallToCpu = (report: Report, err: unknown): Promise<void> => {
    console.warn('[clipr] WebGPU AI failed; retrying on CPU:', err);
    opts.onFallback?.(err);
    report({ engine: 'cpu', pct: 0, note: GPU_FALLBACK_NOTE });
    const gpu = client;
    start('transformers');
    report({ engine: 'cpu', pct: 0, note: CPU_LOADING_NOTE });
    const warm = loadOn(report);
    gpu?.terminate(); // idempotent: a crash may already have disposed it
    return warm;
  };

  const loadWithFallback = async (report: Report): Promise<void> => {
    if (!client) start(kind);
    if (kind === 'transformers') report({ engine: 'cpu', pct: 0, note: CPU_LOADING_NOTE });
    try {
      await loadOn(report);
    } catch (err) {
      if (kind !== 'webllm' || !isGpuFailure(err)) throw err;
      await fallToCpu(report, err);
    }
  };

  const scoreOn = (
    candidates: Parameters<ScoringDeps['score']>[0],
    onProgress: (done: number, total: number) => void,
  ) => {
    const c = client;
    if (!c) throw new Error('llm client missing');
    return c.request(
      'llm.score',
      { candidates },
      {
        timeoutMs: IDLE_TIMEOUT_MS,
        resetOnProgress: true,
        onProgress: (p) => {
          if (p.stage === 'scoring' && p.done !== undefined) onProgress(p.done, p.total ?? candidates.length);
        },
      },
    );
  };

  return {
    loadModel: (report) => loadWithFallback(report),
    score: async (candidates, onProgress, report) => {
      if (!loaded) await loadWithFallback(report);
      try {
        return await scoreOn(candidates, onProgress);
      } catch (err) {
        if (kind !== 'webllm' || !isGpuFailure(err)) throw err;
        // Partial GPU results are dropped: a crash can leave corrupted scores, so
        // the whole pass is re-run on CPU (mid-flight windows included).
        await fallToCpu(report, err);
        return scoreOn(candidates, onProgress);
      }
    },
  };
}
