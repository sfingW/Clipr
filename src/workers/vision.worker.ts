/**
 * Vision worker (SPEC §8.8): MediaPipe FaceDetector (short-range) over the clip
 * window → `FaceSample[]` for the reframe pipeline.
 *
 * Frames arrive as acked `videoBatch` stream messages, relayed from the demux
 * worker (the same pattern as render). Every 3rd frame is downscaled to at most
 * 320 px wide and detected on CPU. Boxes are normalized to 0–1 of that frame.
 * Samples with no faces are kept, so the reframe lock can hold its position.
 *
 * Ownership rule: every VideoFrame this worker receives is closed exactly once,
 * and every batch is acknowledged. If the detector cannot load, or detection
 * throws, the worker switches to drain mode. It keeps closing and acking
 * incoming batches until the stream ends (`last`) or is aborted, and only then
 * rejects the request. Frames are never left for the garbage collector.
 */
import { serveRpc, type VisionWorker as VisionMethods, type RpcServerContext, type StreamMessage } from '../core/rpc';
import type { FaceBox, FaceSample } from '../core/types';

/**
 * MediaPipe tasks-vision 1.1.1 as a pre-bundled ES module from jsDelivr (`+esm`).
 * Loaded at runtime rather than from npm, so Vite never bundles it. The worker
 * is built as a classic (IIFE) script, which cannot hold a static import; a
 * dynamic import() is valid there.
 */
export const MEDIAPIPE_ESM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/+esm';

/** The subset of the MediaPipe API used here. */
interface MpDetection {
  boundingBox?: { originX: number; originY: number; width: number; height: number };
  categories: { score: number }[];
}
interface FaceDetector {
  detect(image: CanvasImageSource): { detections: MpDetection[] };
}
interface MediapipeModule {
  FilesetResolver: { forVisionTasks(basePath: string): Promise<unknown> };
  FaceDetector: {
    createFromOptions(fileset: unknown, options: Record<string, unknown>): Promise<FaceDetector>;
  };
}

/** SPEC §8.8: sample every 3rd frame, at most 320 px wide. */
export const SAMPLE_EVERY = 3;
export const MAX_SAMPLE_WIDTH = 320;
/** Detections below this confidence are dropped. */
const MIN_CONFIDENCE = 0.5;
/**
 * After an abort or failure, keep catching late in-flight batches this long
 * before detaching the listener, so none of them are left unclosed.
 */
const LATE_BATCH_GRACE_MS = 500;

/**
 * Loaded from CDNs, pinned to the installed @mediapipe/tasks-vision version (1.1.1).
 * Both hosts send Access-Control-Allow-Origin: *, so they pass the COEP require-corp policy.
 */
export const WASM_PATH = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/wasm';
export const MODEL_PATH =
  'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';

type VideoBatch = Extract<StreamMessage, { kind: 'videoBatch' }>;

let detectorPromise: Promise<FaceDetector> | null = null;

function loadDetector(): Promise<FaceDetector> {
  if (detectorPromise) return detectorPromise;
  const p = (async (): Promise<FaceDetector> => {
    console.log('[clipr] Initializing MediaPipe WASM from:', WASM_PATH);
    try {
      const mp = (await import(/* @vite-ignore */ MEDIAPIPE_ESM_URL)) as MediapipeModule;
      if (!mp || !mp.FilesetResolver || !mp.FaceDetector) {
        throw new Error(
          `[clipr] MediaPipe module at ${MEDIAPIPE_ESM_URL} did not export FilesetResolver/FaceDetector`,
        );
      }
      const fileset = await mp.FilesetResolver.forVisionTasks(WASM_PATH);
      console.log(
        '[clipr] FilesetResolver loaded. globalThis.ModuleFactory is:',
        typeof (globalThis as { ModuleFactory?: unknown }).ModuleFactory,
      );
      return await mp.FaceDetector.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: MODEL_PATH,
          // CPU on purpose: the GPU delegate is the path that loses devices on
          // some Macs, and this pass is small.
          delegate: 'CPU',
        },
        runningMode: 'IMAGE',
        minDetectionConfidence: MIN_CONFIDENCE,
      });
    } catch (err) {
      console.error('[clipr] MediaPipe init error:', err);
      throw err;
    }
  })();
  detectorPromise = p;
  p.catch(() => {
    if (detectorPromise === p) detectorPromise = null;
  });
  return p;
}

/** Downscale factor so the width is at most MAX_SAMPLE_WIDTH (never upscale). */
export function sampleSize(width: number, height: number): { w: number; h: number } {
  const scale = Math.min(1, MAX_SAMPLE_WIDTH / Math.max(1, width));
  return { w: Math.max(2, Math.round(width * scale)), h: Math.max(2, Math.round(height * scale)) };
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// The clip window is set by the caller's demux stream, so the payload is unused.
async function track(ctx: RpcServerContext): Promise<VisionMethods['vision.track']['result']> {
  // Register first: frames can start as soon as the request is posted.
  const batches: VideoBatch[] = [];
  let aborted = false;
  // Set once the request is finishing. Batches that arrive after that are closed
  // on arrival, never queued.
  let finished = false;
  let wake: (() => void) | null = null;
  const notify = (): void => {
    const w = wake;
    wake = null;
    w?.();
  };

  const closeAndAck = (batch: VideoBatch): void => {
    for (const f of batch.frames) f.close();
    ctx.sendStream({ kind: 'ack', batchId: batch.batchId });
  };

  // The demux sends `end` after its last batch. It can arrive without a `last`
  // batch, when the final batch was already sent, so it also ends the loop.
  let ended = false;
  const offStream = ctx.onStream((msg) => {
    if (msg.kind === 'videoBatch') {
      if (finished) closeAndAck(msg);
      else {
        batches.push(msg);
        notify();
      }
    } else if (msg.kind === 'end') {
      ended = true;
      notify();
    } else if (msg.kind === 'abort') {
      aborted = true;
      notify();
    }
  });

  let failure: unknown = null;
  try {
    let detector: FaceDetector | null = null;
    try {
      detector = await loadDetector();
    } catch (err) {
      failure = err;
    }

    let ctx2d: OffscreenCanvasRenderingContext2D | null = null;
    const canvas = new OffscreenCanvas(2, 2);
    if (detector) {
      ctx2d = canvas.getContext('2d', { alpha: false });
      if (!ctx2d) failure = new Error('vision: 2d context unavailable');
    }

    const samples: FaceSample[] = [];
    let index = 0;

    /** Process one batch. Always closes every frame and acks, even on throw. */
    const handleBatch = (batch: VideoBatch): void => {
      const sampling = detector !== null && ctx2d !== null && failure === null;
      try {
        for (const frame of batch.frames) {
          try {
            if (sampling && index % SAMPLE_EVERY === 0) {
              const { w, h } = sampleSize(frame.displayWidth, frame.displayHeight);
              canvas.width = w;
              canvas.height = h;
              ctx2d!.drawImage(frame, 0, 0, w, h);
              const result = detector!.detect(canvas);
              const boxes: FaceBox[] = result.detections.flatMap((d) => {
                const bb = d.boundingBox;
                if (!bb) return [];
                return [
                  {
                    x: clamp01(bb.originX / w),
                    y: clamp01(bb.originY / h),
                    w: clamp01(bb.width / w),
                    h: clamp01(bb.height / h),
                    score: d.categories[0]?.score ?? 0,
                  },
                ];
              });
              samples.push({ t: frame.timestamp / 1e6, boxes });
            }
          } finally {
            index++;
            frame.close();
          }
        }
      } finally {
        ctx.sendStream({ kind: 'ack', batchId: batch.batchId });
      }
    };

    let done = false;
    while (!done && !aborted) {
      const batch = batches.shift();
      if (!batch) {
        if (ended) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      try {
        handleBatch(batch);
      } catch (err) {
        // Detection failed mid-run: drain the rest, so the stream still finishes.
        failure = failure ?? err;
      }
      if (batch.last) done = true;
    }

    if (failure) throw failure instanceof Error ? failure : new Error(String(failure));
    if (aborted) throw new Error('vision: aborted');
    return samples;
  } finally {
    // Stop queueing. Late batches are closed on arrival during the grace period.
    finished = true;
    if (failure || aborted) await sleep(LATE_BATCH_GRACE_MS);
    offStream();
    for (const b of batches.splice(0)) closeAndAck(b);
  }
}

serveRpc<VisionMethods>(
  self as unknown as {
    addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
    postMessage(message: unknown, transfer?: Transferable[]): void;
  },
  {
    'vision.track': (_payload, ctx) => track(ctx),
  },
);
