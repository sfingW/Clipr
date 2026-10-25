/**
 * Reframing (SPEC §8.8): turns face samples into crop keyframes for the 9:16
 * vertical export. Pure: given boxes, it returns keyframes. No workers, no
 * DOM, no WebCodecs, so it is unit tested (SPEC §17).
 *
 * Pipeline, in order:
 *   1. Subject per sample: the largest face (most central if sizes are close).
 *   2. Hysteresis: keep the locked speaker. Switch only when a different face
 *      is ≥ SWITCH_AREA_RATIO larger for SWITCH_CONFIRM_SAMPLES samples in a row.
 *   3. Median filter over MEDIAN_WINDOW samples, to remove single-sample jitter.
 *   4. Quantize the crop position to POSITION_COUNT fixed positions across the
 *      source width. A moving pan looks amateur; static framings that cut
 *      between each other look deliberate (SPEC §8.8).
 *   5. Emit a keyframe only where the quantized position changes.
 *
 * No faces at all → empty array → the consumer uses a center crop.
 */
import type { CropKeyframe, FaceBox, FaceSample } from '../core/types';

/** Speaker-lock switch: a challenger must be this many times larger… */
export const SWITCH_AREA_RATIO = 1.3;
/** …for this many consecutive samples before the lock moves. */
export const SWITCH_CONFIRM_SAMPLES = 3;
/** Median filter window, in samples (SPEC §8.8). */
export const MEDIAN_WINDOW = 5;
/** Discrete crop positions across the source width (SPEC §8.8: 3–5). */
export const POSITION_COUNT = 5;
/**
 * Normalized centre distance under which a face counts as the same speaker as
 * the locked one (a quarter of the frame width).
 */
export const TRACK_MAX_DIST = 0.25;

/** Normalized (0–1) face centre x. */
function centerX(b: FaceBox): number {
  return b.x + b.w / 2;
}

function area(b: FaceBox): number {
  return b.w * b.h;
}

/**
 * The largest face. Faces within 10% of the largest area count as equal, and
 * the most central of those wins (so a wide two-shot picks the middle speaker).
 */
export function pickSubject(boxes: FaceBox[]): FaceBox | null {
  if (boxes.length === 0) return null;
  const maxArea = Math.max(...boxes.map(area));
  const near = boxes.filter((b) => area(b) >= maxArea * 0.9);
  return near.reduce((best, b) => (Math.abs(centerX(b) - 0.5) < Math.abs(centerX(best) - 0.5) ? b : best));
}

/** The face nearest to `cx`, if one is within TRACK_MAX_DIST. */
function trackNear(boxes: FaceBox[], cx: number): FaceBox | null {
  let best: FaceBox | null = null;
  let bestDist = Infinity;
  for (const b of boxes) {
    const d = Math.abs(centerX(b) - cx);
    if (d <= TRACK_MAX_DIST && d < bestDist) {
      best = b;
      bestDist = d;
    }
  }
  return best;
}

/**
 * Hysteresis speaker lock. Returns one normalized centre x per sample, or null
 * before the first face has been seen. Samples with no faces hold the last
 * position.
 */
export function lockSpeaker(samples: FaceSample[]): Array<number | null> {
  const out: Array<number | null> = [];
  let lockCx: number | null = null;
  let lockArea = 0;
  let streak = 0;

  for (const s of samples) {
    const big = pickSubject(s.boxes);
    if (!big) {
      out.push(lockCx);
      continue;
    }
    if (lockCx === null) {
      lockCx = centerX(big);
      lockArea = area(big);
      streak = 0;
      out.push(lockCx);
      continue;
    }
    const tracked = trackNear(s.boxes, lockCx);
    if (!tracked) {
      // The locked speaker has left the frame: nothing to hold, so move now.
      lockCx = centerX(big);
      lockArea = area(big);
      streak = 0;
    } else {
      lockCx = centerX(tracked);
      lockArea = area(tracked);
      const challengerIsOther = Math.abs(centerX(big) - lockCx) > TRACK_MAX_DIST;
      if (challengerIsOther && area(big) >= lockArea * SWITCH_AREA_RATIO) {
        streak++;
        if (streak >= SWITCH_CONFIRM_SAMPLES) {
          lockCx = centerX(big);
          lockArea = area(big);
          streak = 0;
        }
      } else {
        streak = 0;
      }
    }
    out.push(lockCx);
  }
  return out;
}

/**
 * Median over a centred window, clamped at the edges. Null entries are filled
 * from the previous value first (and from the next value at the start).
 */
export function medianFilter(values: Array<number | null>, window: number = MEDIAN_WINDOW): number[] {
  const filled: number[] = [];
  let prev: number | null = null;
  for (const v of values) {
    if (v !== null) prev = v;
    filled.push(v ?? prev ?? NaN);
  }
  // Leading nulls take the first real value.
  const firstReal = filled.find((v) => !Number.isNaN(v));
  if (firstReal === undefined) return [];
  for (let i = 0; i < filled.length; i++) {
    if (Number.isNaN(filled[i])) filled[i] = firstReal;
  }
  const half = Math.floor(window / 2);
  return filled.map((_, i) => {
    const lo = Math.max(0, i - half);
    const hi = Math.min(filled.length - 1, i + half);
    const win = filled.slice(lo, hi + 1).sort((a, b) => a - b);
    return win[Math.floor(win.length / 2)];
  });
}

/** Crop width in source pixels: 9:16 of the source height, clamped to the source. */
export function cropWidthFor(sourceWidth: number, sourceHeight: number): number {
  const w = Math.round((sourceHeight * 9) / 16);
  return Math.max(2, Math.min(sourceWidth, w - (w % 2)));
}

/**
 * Quantize a median-filtered centre x to one of POSITION_COUNT crop slots.
 * Returns the slot index, 0 = far left, POSITION_COUNT-1 = far right.
 */
export function quantizeSlot(centre: number, cropFrac: number): number {
  const range = 1 - cropFrac;
  if (range <= 0) return 0;
  const left = Math.max(0, Math.min(range, centre - cropFrac / 2));
  return Math.round((left / range) * (POSITION_COUNT - 1));
}

export interface ReframeOptions {
  /** Clip window in absolute source seconds. Keyframe t is relative to the start. */
  clipStartSec: number;
  clipEndSec: number;
  sourceWidth: number;
  sourceHeight: number;
}

/**
 * Crop keyframes for a clip (SPEC §8.8). Empty when there are no faces, which
 * means a center crop.
 */
export function computeCropKeyframes(samples: FaceSample[], opts: ReframeOptions): CropKeyframe[] {
  const inWindow = samples
    .filter((s) => s.t >= opts.clipStartSec && s.t <= opts.clipEndSec)
    .sort((a, b) => a.t - b.t);
  if (!inWindow.some((s) => s.boxes.length > 0)) return [];

  const cropW = cropWidthFor(opts.sourceWidth, opts.sourceHeight);
  const cropFrac = cropW / opts.sourceWidth;
  const maxX = opts.sourceWidth - cropW;

  const centres = medianFilter(lockSpeaker(inWindow));
  if (centres.length === 0) return [];

  const keys: CropKeyframe[] = [];
  let lastSlot = -1;
  centres.forEach((c, i) => {
    const slot = quantizeSlot(c, cropFrac);
    if (slot === lastSlot) return;
    lastSlot = slot;
    const x = Math.round((slot / (POSITION_COUNT - 1)) * maxX);
    keys.push({
      t: keys.length === 0 ? 0 : inWindow[i].t - opts.clipStartSec,
      x: Math.max(0, Math.min(maxX, x)),
      width: cropW,
    });
  });
  return keys;
}
