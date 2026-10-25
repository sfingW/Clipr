/**
 * Main-thread side of the AI tiers. This module only creates real Workers. The
 * fallback decisions live in pipeline/llmFallback.ts, which is unit tested.
 *
 * One `ScoringDeps` is shared for the session, so a GPU failure that switches
 * to CPU stays switched: the next "Find Best Clips" does not hit the crashed
 * GPU again. The model is also loaded once, not on every click.
 */
import { createRpcClient, type LlmWorker, type RpcClient } from '../core/rpc';
import { createFallbackDeps } from '../pipeline/llmFallback';
import type { ScoringDeps } from '../pipeline/scoring';

function spawnLlmWorker(): RpcClient<LlmWorker> {
  const worker = new Worker(new URL('./llm.worker.ts', import.meta.url), { type: 'module' });
  return createRpcClient<LlmWorker>(worker);
}

let shared: { preferWebGpu: boolean; deps: ScoringDeps } | null = null;

/**
 * Scoring deps for the session. `preferWebGpu=false` starts on CPU directly.
 * Passing a different value rebuilds the deps, which is only expected once
 * (the WebGPU probe runs at startup).
 */
export function getLlmDeps(preferWebGpu: boolean): ScoringDeps {
  if (!shared || shared.preferWebGpu !== preferWebGpu) {
    shared = {
      preferWebGpu,
      deps: createFallbackDeps({ preferWebGpu, spawn: spawnLlmWorker }),
    };
  }
  return shared.deps;
}
