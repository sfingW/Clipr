/**
 * Worker singletons (SPEC §7): one demux worker and one render worker per
 * app lifetime, wrapped in typed RPC clients (§9).
 */
import {
  createRpcClient,
  type AsrWorker,
  type DemuxWorker,
  type LlmWorker,
  type RenderWorker,
  type RpcClient,
} from '../core/rpc';

let demux: RpcClient<DemuxWorker> | null = null;
let render: RpcClient<RenderWorker> | null = null;
let asr: RpcClient<AsrWorker> | null = null;
let llm: RpcClient<LlmWorker> | null = null;

export function getDemuxClient(): RpcClient<DemuxWorker> {
  if (!demux) {
    const worker = new Worker(new URL('../workers/demux.worker.ts', import.meta.url), {
      type: 'module',
    });
    demux = createRpcClient<DemuxWorker>(worker);
  }
  return demux;
}

export function getRenderClient(): RpcClient<RenderWorker> {
  if (!render) {
    const worker = new Worker(new URL('../workers/render.worker.ts', import.meta.url), {
      type: 'module',
    });
    render = createRpcClient<RenderWorker>(worker);
  }
  return render;
}

/**
 * ASR worker. A crash terminates the worker and drops the singleton, so the
 * next attempt starts a fresh one (the crashed one may hold a broken model).
 */
export function getAsrClient(): RpcClient<AsrWorker> {
  if (!asr) {
    const worker = new Worker(new URL('../workers/asr.worker.ts', import.meta.url), {
      type: 'module',
    });
    const client: RpcClient<AsrWorker> = createRpcClient<AsrWorker>(worker, {
      onCrash: () => {
        worker.terminate();
        if (asr === client) asr = null;
      },
    });
    asr = client;
  }
  return asr;
}

/**
 * LLM worker (Phase 4). Like ASR: a crash terminates it and drops the
 * singleton, so the next "Find Best Clips" starts a fresh engine.
 */
export function getLlmClient(): RpcClient<LlmWorker> {
  if (!llm) {
    const worker = new Worker(new URL('../workers/llm.worker.ts', import.meta.url), {
      type: 'module',
    });
    const client: RpcClient<LlmWorker> = createRpcClient<LlmWorker>(worker, {
      onCrash: () => {
        worker.terminate();
        if (llm === client) llm = null;
      },
    });
    llm = client;
  }
  return llm;
}
