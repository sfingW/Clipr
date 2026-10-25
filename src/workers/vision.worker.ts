/**
 * Vision worker (SPEC §8.8): MediaPipe FaceDetector (short-range) over the clip
 * window → `FaceSample[]` for the reframe pipeline.
 *
 * Frames arrive as acked `videoBatch` stream messages, relayed from the demux
 * worker (the same pattern as render). Every 3rd frame is downscaled to at most
 * 320 px wide and detected on CPU. Boxes are normalized to 0–1 of that frame.
 * Samples with no faces are kept, so the reframe lock can hold its position.
 *
 * The listener is registered before any await, so no early batch is dropped.
 * Any failure (model load, detector) rejects the request; the caller then falls
 * back to a center crop.
 */
import { FaceDetector, FilesetResolver } from '@mediapipe/tasks-vision';
import { serveRpc, type VisionWorker as VisionMethods, type RpcServerContext, type StreamMessage } from '../core/rpc';
import type { FaceBox, FaceSample } from '../core/types';

/** SPEC §8.8: sample every 3rd frame, at most 320 px wide. */
export const SAMPLE_EVERY = 3;
export const MAX_SAMPLE_WIDTH = 320;
/** Detections below this confidence are dropped. */
const MIN_CONFIDENCE = 0.5;

type VideoBatch = Extract<StreamMessage, { kind: 'videoBatch' }>;

/** Self-hosted under /mediapipe/ (scripts/copy-mediapipe.mjs), never a CDN. */
let detectorPromise: Promise<FaceDetector> | null = null;

function loadDetector(): Promise<FaceDetector> {
  if (detectorPromise) return detectorPromise;
  const p = (async (): Promise<FaceDetector> => {
    const base = `${self.location.origin}/mediapipe`;
    const fileset = await FilesetResolver.forVisionTasks(`${base}/wasm`);
    return FaceDetector.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: `${base}/face_detection_short_range.tflite`,
        // CPU on purpose: the GPU delegate is the path that loses devices on
        // some Macs, and this pass is small.
        delegate: 'CPU',
      },
      runningMode: 'IMAGE',
      minDetectionConfidence: MIN_CONFIDENCE,
    });
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

// The clip window is set by the caller's demux stream, so the payload is unused.
async function track(ctx: RpcServerContext): Promise<VisionMethods['vision.track']['result']> {
  // Register first: frames can start as soon as the request is posted.
  const batches: VideoBatch[] = [];
  let aborted = false;
  let wake: (() => void) | null = null;
  const notify = (): void => {
    const w = wake;
    wake = null;
    w?.();
  };
  const offStream = ctx.onStream((msg) => {
    if (msg.kind === 'videoBatch') {
      batches.push(msg);
      notify();
    } else if (msg.kind === 'abort') {
      aborted = true;
      notify();
    }
  });

  try {
    const detector = await loadDetector();
    const canvas = new OffscreenCanvas(2, 2);
    const ctx2d = canvas.getContext('2d', { alpha: false });
    if (!ctx2d) throw new Error('vision: 2d context unavailable');

    const samples: FaceSample[] = [];
    let index = 0;
    let done = false;
    while (!done) {
      if (aborted) throw new Error('vision: aborted');
      const batch = batches.shift();
      if (!batch) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      try {
        for (const frame of batch.frames) {
          try {
            if (index % SAMPLE_EVERY === 0) {
              const { w, h } = sampleSize(frame.displayWidth, frame.displayHeight);
              canvas.width = w;
              canvas.height = h;
              ctx2d.drawImage(frame, 0, 0, w, h);
              const result = detector.detect(canvas);
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
        // Ack even a failed batch, so the demux side is not left waiting.
        ctx.sendStream({ kind: 'ack', batchId: batch.batchId });
      }
      if (batch.last) done = true;
    }
    return samples;
  } finally {
    offStream();
    for (const b of batches) for (const f of b.frames) f.close();
  }
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
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
