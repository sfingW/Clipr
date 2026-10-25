/**
 * Reframing (SPEC §8.8, §17): subject choice, hysteresis speaker lock, median
 * filter, quantization, keyframes and the no-face fallback. All pure.
 */
import { describe, expect, it } from 'vitest';
import {
  MEDIAN_WINDOW,
  POSITION_COUNT,
  SWITCH_CONFIRM_SAMPLES,
  computeCropKeyframes,
  cropWidthFor,
  lockSpeaker,
  medianFilter,
  pickSubject,
  quantizeSlot,
} from '../src/pipeline/reframe';
import type { FaceBox, FaceSample } from '../src/core/types';

/** A face box with its centre at cx and area w*h (normalized). */
const face = (cx: number, size: number): FaceBox => ({
  x: cx - size / 2,
  y: 0.3,
  w: size,
  h: size,
  score: 0.9,
});

const sample = (t: number, ...boxes: FaceBox[]): FaceSample => ({ t, boxes });

const SRC = { sourceWidth: 1920, sourceHeight: 1080 };

describe('pickSubject', () => {
  it('returns the largest face', () => {
    expect(pickSubject([face(0.2, 0.1), face(0.7, 0.3)])?.x).toBeCloseTo(0.7 - 0.15);
  });

  it('prefers the most central face when sizes are within 10%', () => {
    const left = face(0.25, 0.2);
    const middle = face(0.5, 0.195);
    expect(pickSubject([left, middle])).toBe(middle);
  });

  it('returns null with no faces', () => {
    expect(pickSubject([])).toBeNull();
  });
});

describe('lockSpeaker: hysteresis', () => {
  it('locks onto the first face and follows it', () => {
    const out = lockSpeaker([sample(0, face(0.3, 0.1)), sample(1, face(0.32, 0.1))]);
    expect(out[0]).toBeCloseTo(0.3);
    expect(out[1]).toBeCloseTo(0.32);
  });

  it(`switches only after ${SWITCH_CONFIRM_SAMPLES} consecutive larger samples`, () => {
    // Locked on a small face at 0.2; a much larger face at 0.8 appears.
    const locked = face(0.2, 0.1);
    const big = face(0.8, 0.3);
    const samples = [
      sample(0, locked),
      sample(1, locked, big),
      sample(2, locked, big),
      sample(3, locked, big), // third consecutive: switch on this sample
      sample(4, big),
    ];
    const out = lockSpeaker(samples);
    expect(out.slice(0, 3)).toEqual([0.2, 0.2, 0.2]);
    expect(out[3]).toBeCloseTo(0.8);
  });

  it('does not switch when the streak is broken', () => {
    const locked = face(0.2, 0.1);
    const big = face(0.8, 0.3);
    const samples = [
      sample(0, locked),
      sample(1, locked, big),
      sample(2, locked, big),
      sample(3, locked), // streak breaks
      sample(4, locked, big),
      sample(5, locked, big),
    ];
    expect(lockSpeaker(samples).every((c) => c !== null && Math.abs(c - 0.2) < 1e-9)).toBe(true);
  });

  it('ignores a challenger that is not meaningfully larger', () => {
    const locked = face(0.2, 0.1); // area 0.01
    const similar = face(0.8, 0.11); // area 0.0121, ratio 1.21 < 1.3
    // Lock on the first speaker alone, then let the similar-sized face appear.
    const samples = [sample(0, locked), ...Array.from({ length: 8 }, (_, i) => sample(i + 1, locked, similar))];
    expect(lockSpeaker(samples).every((c) => c !== null && Math.abs(c - 0.2) < 1e-9)).toBe(true);
  });

  it('moves at once when the locked speaker leaves the frame', () => {
    const out = lockSpeaker([sample(0, face(0.2, 0.1)), sample(1, face(0.7, 0.1))]);
    expect(out[1]).toBeCloseTo(0.7);
  });

  it('holds the last position through samples with no faces', () => {
    const out = lockSpeaker([sample(0, face(0.4, 0.1)), sample(1), sample(2)]);
    expect(out).toEqual([0.4, 0.4, 0.4]);
  });
});

describe('medianFilter (window 5)', () => {
  it('removes a single-sample spike', () => {
    expect(medianFilter([0.2, 0.2, 0.9, 0.2, 0.2], MEDIAN_WINDOW)).toEqual([0.2, 0.2, 0.2, 0.2, 0.2]);
  });

  it('fills null gaps from the previous value, and leading nulls from the first real value', () => {
    expect(medianFilter([null, 0.5, null, null, 0.5])).toEqual([0.5, 0.5, 0.5, 0.5, 0.5]);
  });

  it('returns empty when there is no value at all', () => {
    expect(medianFilter([null, null])).toEqual([]);
  });
});

describe('quantization (3–5 discrete positions)', () => {
  const frac = cropWidthFor(1920, 1080) / 1920; // ≈ 0.317

  it('uses exactly POSITION_COUNT slots and spans far left to far right', () => {
    expect(POSITION_COUNT).toBeGreaterThanOrEqual(3);
    expect(POSITION_COUNT).toBeLessThanOrEqual(5);
    expect(quantizeSlot(0.0, frac)).toBe(0);
    expect(quantizeSlot(1.0, frac)).toBe(POSITION_COUNT - 1);
    expect(quantizeSlot(0.5, frac)).toBe(Math.floor(POSITION_COUNT / 2));
  });

  it('maps nearby centres to the same slot (no jitter between slots)', () => {
    expect(quantizeSlot(0.49, frac)).toBe(quantizeSlot(0.51, frac));
  });
});

describe('cropWidthFor', () => {
  it('is 9:16 of the source height, even, and within the source width', () => {
    const w = cropWidthFor(1920, 1080);
    expect(w % 2).toBe(0);
    expect(Math.abs(w / 1080 - 9 / 16)).toBeLessThan(0.01);
    expect(cropWidthFor(300, 1080)).toBe(300);
  });
});

describe('computeCropKeyframes', () => {
  it('returns no keyframes when there are no faces (center crop fallback)', () => {
    const samples = [sample(0), sample(1), sample(2)];
    expect(computeCropKeyframes(samples, { clipStartSec: 0, clipEndSec: 3, ...SRC })).toEqual([]);
  });

  it('returns no keyframes for an empty sample list', () => {
    expect(computeCropKeyframes([], { clipStartSec: 0, clipEndSec: 3, ...SRC })).toEqual([]);
  });

  it('emits a single keyframe for a static, centred speaker', () => {
    const samples = Array.from({ length: 10 }, (_, i) => sample(10 + i * 0.1, face(0.5, 0.1)));
    const keys = computeCropKeyframes(samples, { clipStartSec: 10, clipEndSec: 11, ...SRC });
    expect(keys).toHaveLength(1);
    expect(keys[0].t).toBe(0);
    expect(keys[0].width).toBe(cropWidthFor(1920, 1080));
    // Centre slot: halfway across the free range.
    expect(keys[0].x).toBe(Math.round((1920 - keys[0].width) / 2));
  });

  it('emits keyframes only where the quantized position changes, relative to clip start', () => {
    // Speaker moves from far left (0.1) to far right (0.9) at t = 12.
    const samples: FaceSample[] = [];
    for (let i = 0; i < 40; i++) {
      const t = 10 + i * 0.1;
      samples.push(sample(t, face(t < 12 ? 0.1 : 0.9, 0.2)));
    }
    const keys = computeCropKeyframes(samples, { clipStartSec: 10, clipEndSec: 14, ...SRC });
    expect(keys.length).toBe(2);
    expect(keys[0].t).toBe(0);
    expect(keys[1].t).toBeGreaterThan(1.5);
    expect(keys[1].t).toBeLessThan(2.5);
    expect(keys[0].x).toBeLessThan(keys[1].x);
  });

  it('ignores samples outside the clip window', () => {
    const outside = Array.from({ length: 5 }, (_, i) => sample(i, face(0.9, 0.2)));
    expect(computeCropKeyframes(outside, { clipStartSec: 10, clipEndSec: 11, ...SRC })).toEqual([]);
  });

  it('keeps keyframe x within the source bounds', () => {
    const samples = Array.from({ length: 6 }, (_, i) => sample(i, face(i % 2 ? 0.0 : 1.0, 0.1)));
    const keys = computeCropKeyframes(samples, { clipStartSec: 0, clipEndSec: 6, ...SRC });
    for (const k of keys) {
      expect(k.x).toBeGreaterThanOrEqual(0);
      expect(k.x + k.width).toBeLessThanOrEqual(1920);
    }
  });
});
