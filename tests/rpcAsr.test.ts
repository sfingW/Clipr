/**
 * RPC + ASR wiring through the real `createRpcClient` / `serveRpc` code, using an
 * in-memory pair of endpoints instead of a Worker. Covers:
 *  - idle timeout for `asr.run` (progress re-arms the timer);
 *  - worker crash rejects in-flight requests and fires `onCrash`;
 *  - the crash-fallback path: a crashed ASR worker still leaves the job at `ready`.
 */
import { describe, expect, it } from 'vitest';

// serveRpc checks `result.frame instanceof VideoFrame` on every response. Node
// has no VideoFrame, so without this stub the response is never sent.
(globalThis as { VideoFrame?: unknown }).VideoFrame ??= class VideoFrame {};
import { INITIAL_ASR, useAppStore } from '../src/app/store';
import { createRpcClient, serveRpc, type AsrWorker, type RpcServerContext } from '../src/core/rpc';
import type { SourceMeta } from '../src/core/types';
import { defaultTranscribeDeps, runTranscription } from '../src/pipeline/transcribe';

type Listener = (ev: { data?: unknown; message?: string }) => void;

/** One side of an in-memory "worker" channel. */
class Endpoint {
  peer: Endpoint | null = null;
  private listeners = new Map<string, Set<Listener>>();
  addEventListener(type: string, fn: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  postMessage(data: unknown): void {
    const peer = this.peer!;
    queueMicrotask(() => peer.emit('message', { data }));
  }
  emit(type: string, ev: { data?: unknown; message?: string }): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }
  terminate(): void {
    /* no-op */
  }
}

function pair(): { client: Endpoint; server: Endpoint } {
  const client = new Endpoint();
  const server = new Endpoint();
  client.peer = server;
  server.peer = client;
  return { client, server };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('rpc idle timeout (resetOnProgress)', () => {
  it('a long request that keeps reporting progress does not time out', async () => {
    const { client, server } = pair();
    serveRpc<AsrWorker>(server as never, {
      'asr.run': async (_p, ctx: RpcServerContext) => {
        for (let i = 1; i <= 6; i++) {
          await sleep(40);
          ctx.progress(i * 15, { stage: 'asr_running' });
        }
        return { language: 'en', words: [], segments: [] };
      },
    });
    const rpc = createRpcClient<AsrWorker>(client as never);
    const result = await rpc.request(
      'asr.run',
      { audioPath: 'j/audio.wav', tier: 'basic' },
      { timeoutMs: 120, resetOnProgress: true },
    );
    expect(result.words).toEqual([]);
  });

  it('without resetOnProgress the same request times out at the fixed deadline', async () => {
    const { client, server } = pair();
    serveRpc<AsrWorker>(server as never, {
      'asr.run': async (_p, ctx: RpcServerContext) => {
        for (let i = 1; i <= 6; i++) {
          await sleep(40);
          ctx.progress(i * 15, { stage: 'asr_running' });
        }
        return { language: 'en', words: [], segments: [] };
      },
    });
    const rpc = createRpcClient<AsrWorker>(client as never);
    await expect(
      rpc.request('asr.run', { audioPath: 'j/audio.wav', tier: 'basic' }, { timeoutMs: 120 }),
    ).rejects.toThrow(/rpc timeout/);
  });
});

describe('worker crash', () => {
  it('rejects in-flight requests with "worker error" and reports onCrash', async () => {
    const { client } = pair();
    let crashed: Error | null = null;
    const rpc = createRpcClient<AsrWorker>(client as never, {
      onCrash: (e) => {
        crashed = e;
      },
    });
    const pending = rpc.request('asr.run', { audioPath: 'j/audio.wav', tier: 'basic' }, { timeoutMs: 5_000 });
    await sleep(5);
    client.emit('error', { message: 'Uncaught OOM' });
    await expect(pending).rejects.toThrow(/worker error/);
    expect(crashed).not.toBeNull();
  });
});

const source: SourceMeta = {
  id: 'crash-src',
  opfsPath: 'job-crash/source.mp4',
  fileName: 'crash.mp4',
  durationSec: 12,
  width: 640,
  height: 360,
  videoCodec: 'avc1',
  audioCodec: 'mp4a.40.2',
  frameRate: 30,
  sizeBytes: 10,
};

describe('fallback: ASR worker crash still reaches ready', () => {
  it('uses the real RPC client and ends at ready with manual cutting available', async () => {
    useAppStore.setState({
      tier: 'basic',
      jobState: 'idle',
      source: null,
      transcript: null,
      asr: INITIAL_ASR,
      playheadSec: 0,
      error: null,
    });
    useAppStore.getState().setSource(source);
    useAppStore.getState().setJobState('ingesting');
    useAppStore.getState().setJobState('ingesting_done');

    // ASR worker: accepts the request, reports progress, then hangs until the
    // worker dies (the 'error' event below is the crash).
    const asrPair = pair();
    serveRpc<AsrWorker>(asrPair.server as never, {
      'asr.run': (_p, ctx) => {
        ctx.progress(10, { stage: 'asr_loading', note: 'downloading model' });
        return new Promise(() => undefined);
      },
    });
    let crashCount = 0;
    const asrClient = createRpcClient<AsrWorker>(asrPair.client as never, {
      onCrash: () => {
        crashCount++;
      },
    });
    setTimeout(() => asrPair.client.emit('error', { message: 'out of memory in wasm' }), 20);

    // Demux stub: extraction succeeds.
    const demux = {
      request: async () => ({ opfsPath: 'job-crash/audio.wav', durationSec: 12, sampleCount: 192000 }),
    } as never;

    await runTranscription(source, defaultTranscribeDeps(() => demux, () => asrClient));

    const st = useAppStore.getState();
    expect(st.jobState).toBe('ready');
    expect(st.transcript).toBeNull();
    expect(st.asr.phase).toBe('failed');
    expect(st.tier).toBe('minimal');
    expect(st.error).toBeNull();
    expect(crashCount).toBe(1);
  });
});
