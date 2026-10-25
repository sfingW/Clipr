/**
 * Per-time crop lookup (SPEC §8.8). Preview and export both call computeLayout,
 * so these also pin the geometry they share.
 */
import { describe, expect, it } from 'vitest';
import { computeLayout, cropAt } from '../src/core/renderLayout';
import type { ClipSpec, SourceMeta } from '../src/core/types';

const SOURCE = { width: 1920, height: 1080 } as SourceMeta;

const spec = (crop: ClipSpec['crop'], format: ClipSpec['format'] = 'vertical'): ClipSpec => ({
  id: 'c',
  sourceStartSec: 0,
  sourceEndSec: 10,
  crop,
  captionStyleId: 'none',
  captions: [],
  format,
  exportPreset: '1080p',
});

describe('cropAt: step lookup', () => {
  const keys = [
    { t: 0, x: 100, width: 600 },
    { t: 2, x: 900, width: 600 },
    { t: 5, x: 1300, width: 600 },
  ];

  it('is undefined with no keyframes (center crop)', () => {
    expect(cropAt([], 1)).toBeUndefined();
  });

  it('holds each keyframe until the next one', () => {
    expect(cropAt(keys, 0)?.x).toBe(100);
    expect(cropAt(keys, 1.99)?.x).toBe(100);
    expect(cropAt(keys, 2)?.x).toBe(900);
    expect(cropAt(keys, 4.9)?.x).toBe(900);
    expect(cropAt(keys, 9)?.x).toBe(1300);
  });

  it('uses the first keyframe before the first time', () => {
    expect(cropAt(keys, -1)?.x).toBe(100);
  });
});

describe('computeLayout with keyframes', () => {
  it('changes the source rect over time, with the same output size', () => {
    const s = spec([
      { t: 0, x: 100, width: 608 },
      { t: 3, x: 1000, width: 608 },
    ]);
    const early = computeLayout(s, SOURCE, 1);
    const late = computeLayout(s, SOURCE, 4);
    expect(early.sx).toBe(100);
    expect(late.sx).toBe(1000);
    expect(early.outW).toBe(late.outW);
    expect(early.outH).toBe(late.outH);
  });

  it('defaults to the first keyframe (tRel = 0), matching the old behaviour', () => {
    const s = spec([{ t: 0, x: 200, width: 608 }]);
    expect(computeLayout(s, SOURCE).sx).toBe(200);
  });

  it('a center crop with no keyframes is unchanged by time', () => {
    const s = spec([]);
    expect(computeLayout(s, SOURCE, 0)).toEqual(computeLayout(s, SOURCE, 7));
  });

  it('original format keeps the existing crop behaviour (crop applies in any format)', () => {
    // Unchanged from before keyframes: crop[0] sizes the source rect in every
    // format. Auto-Reframe always switches the clip to vertical anyway.
    const s = spec([{ t: 0, x: 100, width: 608 }], 'original');
    const lay = computeLayout(s, SOURCE, 0);
    expect(lay.sw).toBe(608);
    expect(lay.outW).toBe(608);
    expect(lay.outH).toBe(1080);
  });
});
