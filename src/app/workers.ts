/**
 * Worker singletons (SPEC §7): one demux worker and one render worker per
 * app lifetime, wrapped in typed RPC clients (§9).
 */
import {
  createRpcClient,
  type AsrWorker,
  type DemuxWorker,
  type RenderWorker,
  type RpcClient,
  type VisionWorker,
} from '../core/rpc';

let vision: RpcClient<VisionWorker> | null = null;

/**
 * Vision worker (SPEC §8.8). A crash drops the singleton, so the next
 * Auto-Reframe starts a fresh worker. Like ASR, the crashed one may be broken.
 */
export function getVisionClient(): RpcClient<VisionWorker> {
  if (!vision) {
    const worker = new Worker(new URL('../workers/vision.worker.ts', import.meta.url), {
      type: 'module',
    });
    const client: RpcClient<VisionWorker> = createRpcClient<VisionWorker>(worker, {
      onCrash: () => {
        worker.terminate();
        if (vision === client) vision = null;
      },
    });
    vision = client;
  }
  return vision;
}

let demux: RpcClient<DemuxWorker> | null = null;
let render: RpcClient<RenderWorker> | null = null;
let asr: RpcClient<AsrWorker> | null = null;

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
