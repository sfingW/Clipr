/**
 * Typed worker RPC (SPEC §9): request/response protocol over `postMessage`
 * with progress and streaming channels.
 *
 * Envelope types match §9; `Progress` is extended additively with optional
 * `stage`/`etaSec`/`done`/`total` so §8 progress events ({stage:'rendering',
 * pct, etaSec}, {stage:'scoring', done, total}) fit the wire shape.
 */
import type { Candidate, ClipSpec, FaceSample, Transcript } from './types';

export type Request<T extends string, P> = { id: string; type: T; payload: P };
export type Response<T extends string, R> =
  | { id: string; type: T; ok: true; result: R }
  | { id: string; type: T; ok: false; error: string };
export type Progress = {
  id: string;
  pct: number;
  note?: string;
  stage?: 'ingest' | 'asr' | 'asr_loading' | 'asr_running' | 'scoring' | 'vision' | 'rendering';
  etaSec?: number;
  done?: number;
  total?: number;
};

/** Streaming messages piped between workers through the main thread.
 * Video/audio flow in acked batches so decoded frames never queue unbounded
 * (memory bound); acks travel back the other way on the same request id.
 * `go` is the orchestrator's start signal (sent after stream handlers are
 * wired on both sides, so no early message can be dropped). */
export type StreamMessage =
  | { id: string; kind: 'go' }
  | { id: string; kind: 'meta'; meta: StreamMeta }
  | { id: string; kind: 'videoBatch'; frames: VideoFrame[]; batchId: number; last: boolean }
  | { id: string; kind: 'audioRemux'; audio: StreamRemuxAudio }
  | { id: string; kind: 'audioPcmBatch'; items: AudioData[]; batchId: number; last: boolean }
  | { id: string; kind: 'ack'; batchId: number }
  | { id: string; kind: 'abort' }
  | { id: string; kind: 'end' };

export interface StreamMeta {
  totalVideoFrames: number;
  fps: number;
  audio:
    | { mode: 'none' }
    | { mode: 'remux'; esdsDescriptor: Uint8Array; sampleRate: number; channels: number; timescale: number }
    | { mode: 'pcm'; sampleRate: number; channels: number };
}

export interface StreamRemuxAudio {
  /** Concatenated encoded AAC sample bytes (transferable). */
  buffer: ArrayBuffer;
  parts: { start: number; length: number; dts: number; cts: number; duration: number }[];
  timescale: number;
}

/** Per-worker method tables: `type` → payload/result pairs (SPEC §9). */
export interface AsrWorker {
  'asr.run': {
    payload: { audioPath: string; tier: 'full' | 'basic' };
    result: Transcript;
  };
}

export interface LlmWorker {
  'llm.load': {
    payload: { tier: 'full' | 'basic' };
    result: void;
  };
  'llm.score': {
    payload: { candidates: Candidate[] };
    result: Candidate[]; // with score+reason
  };
}

export interface VisionWorker {
  'vision.track': {
    payload: { sourcePath: string; start: number; end: number };
    result: FaceSample[];
  };
}

export interface RenderWorker {
  'render.clip': {
    payload: { spec: ClipSpec; source: import('./types').SourceMeta; words: import('./types').Word[] };
    result: { mp4: Uint8Array };
  };
}

export interface DemuxWorker {
  'demux.open': {
    payload: {
      handle: FileSystemFileHandle;
      opfsPath: string;
      fileName: string;
      sizeBytes: number;
    };
    result: import('./types').SourceMeta;
  };
  'demux.frameAt': {
    payload: { tSec: number };
    result: { frame: VideoFrame; tSec: number };
  };
  'demux.streamClip': {
    payload: { startSec: number; endSec: number; audio: 'remux' | 'pcm' | 'none' };
    result: { videoFrames: number };
  };
  'demux.close': {
    payload: Record<string, never>;
    result: void;
  };
  /** Decode the source audio to 16 kHz mono float32 WAV in OPFS (SPEC §8.3). */
  'demux.extractAudio': {
    /** `sourceOpfsPath` guards against a source being swapped mid-extraction. */
    payload: { sourceOpfsPath: string; outPath: string; sampleRate: number; maxDurationSec: number };
    result: { opfsPath: string; durationSec: number; sampleCount: number };
  };
}

/** Default request timeouts (SPEC §9): 10 min render, 5 min ASR; configurable per request. */
export const DEFAULT_TIMEOUTS_MS: Record<string, number> = {
  'render.clip': 10 * 60_000,
  'asr.run': 5 * 60_000,
  'demux.open': 60_000,
  'demux.frameAt': 30_000,
  'demux.streamClip': 10 * 60_000,
};

/** Shape every method-table entry must satisfy. (Self-referential generic —
 * interfaces like `DemuxWorker` have no index signature, so `Record` can't be
 * the constraint.) */
type MethodShape = { payload: unknown; result: unknown };

/** `StreamMessage` with `id` stripped, distributed over the union. */
export type WithoutId<T> = T extends unknown
  ? T extends { id: string }
    ? Omit<T, 'id'>
    : T
  : never;

export type StreamHandler = (msg: StreamMessage) => void;
export type ProgressHandler = (p: Progress) => void;

export interface RpcClientOptions {
  timeouts?: Record<string, number>;
  defaultTimeoutMs?: number;
  onCrash?: (error: Error) => void;
}

export interface RpcClient<M extends { [K in keyof M]: MethodShape }> {
  request<K extends keyof M & string>(
    type: K,
    payload: M[K]['payload'],
    opts?: {
      timeoutMs?: number;
      onProgress?: ProgressHandler;
      /** Pre-generate the request id so streams can target it immediately. */
      requestId?: string;
      /**
       * Treat `timeoutMs` as an idle timeout: every progress message re-arms
       * the timer. Long jobs that keep reporting progress never time out.
       */
      resetOnProgress?: boolean;
    },
  ): Promise<M[K]['result']>;
  sendStream(msg: StreamMessage): void;
  onStream(handler: StreamHandler): () => void;
  onProgress(handler: ProgressHandler): () => void;
  terminate(): void;
}

interface Pending {
  type: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  onProgress?: ProgressHandler;
  /** Re-arm `timer` on every progress message (idle timeout). */
  idleTimeoutMs?: number;
}

function rpcError(message: string, code?: string): Error {
  const err = new Error(code ? `${code}: ${message}` : message);
  return err;
}

export function createRpcClient<M extends { [K in keyof M]: MethodShape }>(
  worker: Worker,
  options: RpcClientOptions = {},
): RpcClient<M> {
  const pending = new Map<string, Pending>();
  const streamHandlers = new Set<StreamHandler>();
  const progressHandlers = new Set<ProgressHandler>();
  const timeouts = { ...DEFAULT_TIMEOUTS_MS, ...options.timeouts };
  const defaultTimeout = options.defaultTimeoutMs ?? 60_000;

  const cleanup = (id: string): Pending | undefined => {
    const p = pending.get(id);
    if (p?.timer) clearTimeout(p.timer);
    pending.delete(id);
    return p;
  };

  const armTimer = (id: string, entry: Pending, ms: number): void => {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      cleanup(id);
      entry.reject(new Error(`rpc timeout: ${entry.type} after ${ms}ms`));
    }, ms);
  };

  worker.addEventListener('message', (event: MessageEvent<unknown>) => {
    const msg = event.data as
      | Response<string, unknown>
      | Progress
      | StreamMessage
      | { kind?: undefined };
    if (msg && 'kind' in msg && 'id' in msg) {
      const stream = msg as StreamMessage;
      for (const h of streamHandlers) h(stream);
      // Note: pending is NOT cleaned up on stream messages — the handler's
      // final Response (with the result) always follows and must resolve
      // the request promise.
      return;
    }
    if (msg && 'pct' in msg && 'id' in msg && !('ok' in msg)) {
      const progress = msg as Progress;
      const entry = pending.get(progress.id);
      if (entry?.idleTimeoutMs !== undefined) armTimer(progress.id, entry, entry.idleTimeoutMs);
      entry?.onProgress?.(progress);
      for (const h of progressHandlers) h(progress);
      return;
    }
    const resp = msg as Response<string, unknown>;
    if (!('ok' in resp)) return;
    const p = cleanup(resp.id);
    if (!p) return;
    if (resp.ok) p.resolve(resp.result);
    else p.reject(rpcError(resp.error));
  });

  worker.addEventListener('error', (event) => {
    const error = new Error(`worker error: ${event.message}`);
    options.onCrash?.(error);
    for (const [, p] of pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(error);
    }
    pending.clear();
  });

  return {
    request(type, payload, opts) {
      const id = opts?.requestId ?? crypto.randomUUID();
      const timeoutMs = opts?.timeoutMs ?? timeouts[type] ?? defaultTimeout;
      return new Promise((resolve, reject) => {
        const entry: Pending = {
          type,
          resolve: resolve as (value: unknown) => void,
          reject,
          timer: null,
          onProgress: opts?.onProgress,
          idleTimeoutMs: opts?.resetOnProgress ? timeoutMs : undefined,
        };
        armTimer(id, entry, timeoutMs);
        pending.set(id, entry);
        worker.postMessage({ id, type, payload } satisfies Request<string, unknown>);
      });
    },
    sendStream(msg) {
      const transfer: Transferable[] = [];
      if (msg.kind === 'videoBatch') transfer.push(...msg.frames);
      else if (msg.kind === 'audioPcmBatch') transfer.push(...msg.items);
      else if (msg.kind === 'audioRemux') transfer.push(msg.audio.buffer);
      worker.postMessage(msg, transfer);
    },
    onStream(handler) {
      streamHandlers.add(handler);
      return () => streamHandlers.delete(handler);
    },
    onProgress(handler) {
      progressHandlers.add(handler);
      return () => progressHandlers.delete(handler);
    },
    terminate() {
      for (const [, p] of pending) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(new Error('worker terminated'));
      }
      pending.clear();
      worker.terminate();
    },
  };
}

export interface RpcServerContext {
  id: string;
  progress: (pct: number, extra?: Omit<Partial<Progress>, 'id' | 'pct'>) => void;
  /** Server-side send: the request id is attached automatically. */
  sendStream: (msg: WithoutId<StreamMessage>) => void;
  /** Subscribe to stream messages sent TO this worker for this request. */
  onStream: (handler: (msg: StreamMessage) => void) => () => void;
}

export type RpcHandler<M extends { [K in keyof M]: MethodShape }, K extends keyof M & string> = (
  payload: M[K]['payload'],
  ctx: RpcServerContext,
) => Promise<M[K]['result']> | M[K]['result'];

export type RpcHandlers<M extends { [K in keyof M]: MethodShape }> = {
  [K in keyof M & string]: RpcHandler<M, K>;
};

/** Wire a worker global to a set of typed request handlers. */
export function serveRpc<M extends { [K in keyof M]: MethodShape }>(
  target: {
    addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
    postMessage(message: unknown, transfer?: Transferable[]): void;
  },
  handlers: RpcHandlers<M>,
): void {
  const streamSubs = new Map<string, Set<(msg: StreamMessage) => void>>();

  target.addEventListener('message', (event) => {
    const msg = event.data as Request<string, unknown> | StreamMessage;
    if (msg && 'kind' in msg && 'id' in msg) {
      streamSubs.get(msg.id)?.forEach((h) => h(msg as StreamMessage));
      return;
    }
    const req = msg as Request<string, unknown>;
    const handler = (handlers as Record<string, ((p: unknown, c: RpcServerContext) => unknown) | undefined>)[
      req.type
    ];
    const respond = (resp: Response<string, unknown>, transfer?: Transferable[]) => {
      target.postMessage(resp, transfer ?? []);
    };
    if (!handler) {
      respond({ id: req.id, type: req.type, ok: false, error: `unknown rpc type: ${req.type}` });
      return;
    }
    const ctx: RpcServerContext = {
      id: req.id,
      progress: (pct, extra) => {
        target.postMessage({ id: req.id, pct, ...extra } satisfies Progress);
      },
      sendStream: (s) => {
        const full = { ...s, id: req.id } as StreamMessage;
        const transfer: Transferable[] = [];
        if (full.kind === 'videoBatch') transfer.push(...full.frames);
        else if (full.kind === 'audioPcmBatch') transfer.push(...full.items);
        else if (full.kind === 'audioRemux') transfer.push(full.audio.buffer);
        target.postMessage(full, transfer);
      },
      onStream: (cb) => {
        let set = streamSubs.get(req.id);
        if (!set) {
          set = new Set();
          streamSubs.set(req.id, set);
        }
        set.add(cb);
        return () => {
          set!.delete(cb);
          if (set!.size === 0) streamSubs.delete(req.id);
        };
      },
    };
    Promise.resolve()
      .then(() => handler(req.payload, ctx))
      .then(
        (result) => {
          streamSubs.delete(req.id); // handler finished — drop stream subscriptions
          const transfer: Transferable[] = [];
          if (result && typeof result === 'object') {
            const r = result as Record<string, unknown>;
            if (r.mp4 instanceof Uint8Array) transfer.push(r.mp4.buffer as ArrayBuffer);
            if (r.frame instanceof VideoFrame) transfer.push(r.frame);
          }
          respond({ id: req.id, type: req.type, ok: true, result } as Response<string, unknown>, transfer);
        },
        (err: unknown) => {
          streamSubs.delete(req.id);
          const error = err instanceof Error ? (err.message || err.name) : String(err);
          respond({ id: req.id, type: req.type, ok: false, error });
        },
      );
  });
}
