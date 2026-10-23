/**
 * Worker singletons (SPEC §7): one demux worker and one render worker per
 * app lifetime, wrapped in typed RPC clients (§9).
 */
import { createRpcClient, type DemuxWorker, type RenderWorker, type RpcClient } from '../core/rpc';

let demux: RpcClient<DemuxWorker> | null = null;
let render: RpcClient<RenderWorker> | null = null;

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
