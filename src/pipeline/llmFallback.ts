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

  /** Terminate the current worker (if any) and start a new one on `next`. */
  const respawn = (next: EngineKind): void => {
    client?.terminate();
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

  /** Switch to CPU after a GPU failure and tell the UI why. */
  const fallToCpu = (report: Report, err: unknown): void => {
    console.warn('[clipr] WebGPU AI failed; retrying on CPU:', err);
    opts.onFallback?.(err);
    report({ engine: 'cpu', pct: 0, note: GPU_FALLBACK_NOTE });
    respawn('transformers');
  };

  const loadWithFallback = async (report: Report): Promise<void> => {
    if (!client) respawn(kind);
    if (kind === 'transformers') report({ engine: 'cpu', pct: 0, note: CPU_LOADING_NOTE });
    try {
      await loadOn(report);
    } catch (err) {
      if (kind !== 'webllm' || !isGpuFailure(err)) throw err;
      fallToCpu(report, err);
      report({ engine: 'cpu', pct: 0, note: CPU_LOADING_NOTE });
      await loadOn(report);
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
        fallToCpu(report, err);
        report({ engine: 'cpu', pct: 0, note: CPU_LOADING_NOTE });
        await loadOn(report);
        return scoreOn(candidates, onProgress);
      }
    },
  };
}
