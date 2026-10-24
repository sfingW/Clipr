/**
 * Caption rendering tests (SPEC §8.9, §17). Pure helpers plus drawCaptions /
 * drawClipCaptions against a recording mock 2D context. No browser, no DOM,
 * and no transformers import: only src/pipeline/caption.ts is loaded.
 */
import { describe, expect, it } from 'vitest';
import {
  CAPTION_MAX_CHARS,
  CAPTION_MAX_WORDS,
  CAPTION_STYLES,
  clipWordsRelative,
  drawCaptions,
  drawClipCaptions,
  groupLines,
  karaokeActiveIndex,
  planCaptionFrame,
  relativeCaptionTime,
  resolveCaptionStyle,
  type CaptionCtx,
  type MeasureFn,
} from '../src/pipeline/caption';
import type { Word } from '../src/core/types';

const W = 1080;
const H = 1920;

/** Width proportional to font px: 0.5 px per char. Deterministic and linear. */
const measure: MeasureFn = (text, font) => {
  const px = Number(/([\d.]+)px/.exec(font)?.[1] ?? '0');
  return text.length * px * 0.5;
};

interface Call {
  op: 'fillText' | 'strokeText';
  text: string;
  x: number;
  y: number;
  font: string;
  fillStyle: unknown;
}

/** Records every draw call; measureText uses the same metric as `measure`. */
class RecCtx implements CaptionCtx {
  canvas = { width: W, height: H };
  font = '';
  textAlign = '';
  textBaseline = '';
  lineJoin = '';
  miterLimit = 0;
  lineWidth = 0;
  strokeStyle: unknown = '';
  fillStyle: unknown = '';
  calls: Call[] = [];
  measureText(text: string): { width: number } {
    return { width: measure(text, this.font) };
  }
  strokeText(text: string, x: number, y: number): void {
    this.calls.push({ op: 'strokeText', text, x, y, font: this.font, fillStyle: this.fillStyle });
  }
  fillText(text: string, x: number, y: number): void {
    this.calls.push({ op: 'fillText', text, x, y, font: this.font, fillStyle: this.fillStyle });
  }
}

const w = (text: string, start: number, end: number): Word => ({ text, start, end });

describe('groupLines', () => {
  it('breaks after 4 words', () => {
    const words = ['a', 'b', 'c', 'd', 'e', 'f'].map((t, i) => w(t, i * 0.1, i * 0.1 + 0.08));
    const groups = groupLines(words);
    expect(groups.map((g) => g.words.length)).toEqual([4, 2]);
    expect(CAPTION_MAX_WORDS).toBe(4);
    for (const g of groups) expect(g.words.length).toBeLessThanOrEqual(4);
  });

  it('breaks when a line would exceed 22 characters', () => {
    // "abcdefgh ijklmnop" = 17 chars; adding "qrstuvwx" (8) would be 26 > 22.
    const groups = groupLines([w('abcdefgh', 0, 0.3), w('ijklmnop', 0.3, 0.6), w('qrstuvwx', 0.6, 0.9)]);
    expect(groups.map((g) => g.text)).toEqual(['abcdefgh ijklmnop', 'qrstuvwx']);
    for (const g of groups) expect(g.text.length).toBeLessThanOrEqual(CAPTION_MAX_CHARS);
  });

  it('keeps a line that is exactly 22 characters together', () => {
    // 10 + 1 + 11 = 22
    const groups = groupLines([w('abcdefghij', 0, 0.3), w('klmnopqrstu', 0.3, 0.6)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].text.length).toBe(22);
  });

  it('breaks on a pause longer than 1 s, not on a shorter one', () => {
    const groups = groupLines([w('one', 0, 0.3), w('two', 0.5, 0.8), w('three', 2.0, 2.3)]);
    expect(groups.map((g) => g.text)).toEqual(['one two', 'three']);
    const noBreak = groupLines([w('one', 0, 0.3), w('two', 1.2, 1.5)]); // gap 0.9 s
    expect(noBreak).toHaveLength(1);
  });

  it('gives a line start/end from its first word and latest end', () => {
    const [g] = groupLines([w('hi', 1, 1.2), w('there', 1.3, 1.9)]);
    expect(g.start).toBe(1);
    expect(g.end).toBe(1.9);
  });

  it('skips blank words and sorts by start time', () => {
    const groups = groupLines([w('  ', 0.5, 0.6), w('late', 1, 1.2), w('early', 0, 0.2)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].text).toBe('early late');
  });

  it('gives an over-long single word its own line', () => {
    const groups = groupLines([w('supercalifragilisticexpialidocious!!', 0, 1)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].words).toHaveLength(1);
  });
});

describe('clipWordsRelative and relativeCaptionTime', () => {
  it('shifts absolute words by the clip start', () => {
    const rel = clipWordsRelative([w('hello', 10, 10.5), w('world', 10.5, 11)], 10, 12);
    expect(rel).toEqual([w('hello', 0, 0.5), w('world', 0.5, 1)]);
  });

  it('drops words outside the clip and clamps words crossing its edges', () => {
    const abs = [w('before', 4, 5), w('cross-in', 4.5, 6), w('inside', 6, 7), w('cross-out', 9.5, 11), w('after', 12, 13)];
    const rel = clipWordsRelative(abs, 5, 10);
    expect(rel.map((x) => x.text)).toEqual(['cross-in', 'inside', 'cross-out']);
    expect(rel[0]).toEqual({ text: 'cross-in', start: 0, end: 1 });
    expect(rel[2].end).toBeCloseTo(5, 9); // clamped to the cut length
    for (const x of rel) {
      expect(x.start).toBeGreaterThanOrEqual(0);
      expect(x.end).toBeLessThanOrEqual(5);
    }
  });

  it('relativeCaptionTime subtracts the clip start and does not clamp', () => {
    expect(relativeCaptionTime(12.5, 10)).toBe(2.5);
    // Before the clip maps negative, so nothing is drawn there.
    expect(relativeCaptionTime(9, 10)).toBe(-1);
  });
});

describe('karaokeActiveIndex', () => {
  const words = [w('a', 0, 0.5), w('b', 0.5, 1), w('c', 1.5, 2)];
  it('returns the word being spoken', () => {
    expect(karaokeActiveIndex(words, 0.25)).toBe(0);
    expect(karaokeActiveIndex(words, 0.5)).toBe(1);
    expect(karaokeActiveIndex(words, 1.9)).toBe(2);
  });
  it('holds the last started word through a pause', () => {
    expect(karaokeActiveIndex(words, 1.2)).toBe(1);
  });
  it('returns -1 before the first word', () => {
    expect(karaokeActiveIndex(words, -0.1)).toBe(-1);
  });
});

describe('planCaptionFrame: bold-center', () => {
  const style = CAPTION_STYLES['bold-center'];
  const words = [w('make', 0, 0.4), w('it', 0.4, 0.7), w('count', 0.7, 1.2)];

  it('uppercases the line and places it bottom-centre', () => {
    const [op] = planCaptionFrame(words, 0.5, style, W, H, measure);
    expect(op.text).toBe('MAKE IT COUNT');
    expect(op.y).toBeCloseTo(H * style.baselineFrac, 6);
    expect(op.y).toBeGreaterThan(H * 0.7); // lower part of the frame
    const width = measure(op.text, op.font);
    expect(op.x + width / 2).toBeCloseTo(W / 2, 6); // horizontally centred
    expect(op.fill).toBe('#ffffff');
    expect(op.stroke).toBe('#000000');
    expect(op.strokeWidth).toBeGreaterThan(0);
  });

  it('shows nothing outside the line window', () => {
    expect(planCaptionFrame(words, 1.3, style, W, H, measure)).toEqual([]);
    expect(planCaptionFrame(words, -0.2, style, W, H, measure)).toEqual([]);
  });

  it('shrinks a long line so it fits 90% of the frame width', () => {
    const long = [w('extraordinarily', 0, 0.5), w('unbelievable', 0.5, 1)]; // 29 chars, 15 chars
    const [op] = planCaptionFrame(long, 0.2, style, W, H, measure);
    const width = measure(op.text, op.font);
    expect(width).toBeLessThanOrEqual(W * 0.9 + 1e-6);
    expect(width).toBeGreaterThan(W * 0.9 - 1); // scaled to the limit, not far below
    const basePx = H * style.fontFrac;
    expect(Number(/([\d.]+)px/.exec(op.font)?.[1])).toBeLessThan(basePx);
  });

  it('does not upscale a short line', () => {
    const [op] = planCaptionFrame(words, 0.5, style, W, H, measure);
    expect(Number(/([\d.]+)px/.exec(op.font)?.[1])).toBeCloseTo(H * style.fontFrac, 1);
  });
});

describe('planCaptionFrame: karaoke', () => {
  const style = CAPTION_STYLES.karaoke;
  const words = [w('hello', 0, 0.5), w('big', 0.5, 0.9), w('world', 0.9, 1.4)];

  it('uses sentence case (first word capitalised only)', () => {
    const ops = planCaptionFrame(words, 0.2, style, W, H, measure);
    expect(ops.map((o) => o.text)).toEqual(['Hello', 'big', 'world']);
  });

  it('highlights exactly the active word', () => {
    const ops = planCaptionFrame(words, 0.7, style, W, H, measure);
    expect(ops.map((o) => o.fill)).toEqual(['#ffffff', style.highlight, '#ffffff']);
  });

  it('keeps the highlight on the previous word during a pause', () => {
    const ops = planCaptionFrame(words, 0.95, style, W, H, measure);
    // "world" starts at 0.9, so it is active; check a gap inside the group instead
    expect(ops[2].fill).toBe(style.highlight);
    const gap = [w('one', 0, 0.2), w('two', 0.6, 0.9)];
    const gapOps = planCaptionFrame(gap, 0.4, style, W, H, measure);
    expect(gapOps.map((o) => o.fill)).toEqual([style.highlight, '#ffffff']);
  });

  it('lays words left to right with spaces and stays within the frame', () => {
    const ops = planCaptionFrame(words, 0.2, style, W, H, measure);
    for (let i = 1; i < ops.length; i++) expect(ops[i].x).toBeGreaterThan(ops[i - 1].x);
    const last = ops[ops.length - 1];
    expect(last.x + measure(last.text, last.font)).toBeLessThanOrEqual(W);
    expect(ops[0].x).toBeGreaterThanOrEqual(0);
  });
});

describe('style resolution', () => {
  it('resolves the two styles and treats none / unknown as no captions', () => {
    expect(resolveCaptionStyle('bold-center')?.id).toBe('bold-center');
    expect(resolveCaptionStyle('karaoke')?.id).toBe('karaoke');
    expect(resolveCaptionStyle('none')).toBeNull();
    expect(resolveCaptionStyle('toString')).toBeNull();
    expect(resolveCaptionStyle('')).toBeNull();
  });
});

describe('drawCaptions (mock ctx)', () => {
  it('draws the bold-center line as stroke then fill, at the planned position', () => {
    const ctx = new RecCtx();
    const words = [w('hi', 0, 1)];
    drawCaptions(ctx, words, 0.5, 'bold-center');
    expect(ctx.calls.map((c) => c.op)).toEqual(['strokeText', 'fillText']);
    expect(ctx.calls[0].text).toBe('HI');
    expect(ctx.calls[1].y).toBeCloseTo(H * CAPTION_STYLES['bold-center'].baselineFrac, 6);
    expect(ctx.textAlign).toBe('left');
    expect(ctx.textBaseline).toBe('alphabetic');
  });

  it('draws karaoke words with the highlight on the active word', () => {
    const ctx = new RecCtx();
    drawCaptions(ctx, [w('one', 0, 0.5), w('two', 0.5, 1)], 0.6, 'karaoke');
    const fills = ctx.calls.filter((c) => c.op === 'fillText');
    expect(fills.map((c) => c.text)).toEqual(['One', 'two']);
    expect(fills.map((c) => c.fillStyle)).toEqual(['#ffffff', '#ffd60a']);
  });

  it('draws nothing for `none`, an unknown style, or a time with no line', () => {
    const ctx = new RecCtx();
    const words = [w('hi', 0, 1)];
    drawCaptions(ctx, words, 0.5, 'none');
    drawCaptions(ctx, words, 0.5, 'nope');
    drawCaptions(ctx, words, 5, 'bold-center');
    expect(ctx.calls).toEqual([]);
  });
});

describe('drawClipCaptions (the shared entry point)', () => {
  it('shifts absolute source time by the clip start before drawing', () => {
    const ctx = new RecCtx();
    // Source words at 30.0–31.0; the clip starts at 30 → clip time 0.5 is "hi".
    drawClipCaptions(ctx, [w('hi', 30, 31)], { startSec: 30, endSec: 33 }, 30.5, 'bold-center');
    expect(ctx.calls.find((c) => c.op === 'fillText')?.text).toBe('HI');
  });

  it('draws nothing when the absolute time is outside the clip', () => {
    const ctx = new RecCtx();
    const abs = [w('hi', 30, 31)];
    drawClipCaptions(ctx, abs, { startSec: 30, endSec: 33 }, 29.5, 'bold-center'); // before clip
    drawClipCaptions(ctx, abs, { startSec: 30, endSec: 33 }, 33.5, 'bold-center'); // after clip
    expect(ctx.calls).toEqual([]);
  });

  it('ignores words from outside the clip window', () => {
    const ctx = new RecCtx();
    // Word at source 5.0–6.0 is outside [30, 33) → no caption even at t=5.5.
    drawClipCaptions(ctx, [w('far', 5, 6)], { startSec: 30, endSec: 33 }, 5.5, 'bold-center');
    expect(ctx.calls).toEqual([]);
  });

  it('draws nothing for `none` or an empty transcript', () => {
    const ctx = new RecCtx();
    drawClipCaptions(ctx, [w('hi', 0, 1)], { startSec: 0, endSec: 2 }, 0.5, 'none');
    drawClipCaptions(ctx, [], { startSec: 0, endSec: 2 }, 0.5, 'bold-center');
    expect(ctx.calls).toEqual([]);
  });

  it('gives identical draw calls for identical inputs (preview and export share one path)', () => {
    const abs = [w('the', 12, 12.3), w('quick', 12.3, 12.7), w('fox', 12.7, 13.2)];
    const a = new RecCtx();
    const b = new RecCtx();
    drawClipCaptions(a, abs, { startSec: 12, endSec: 14 }, 12.8, 'karaoke');
    drawClipCaptions(b, abs, { startSec: 12, endSec: 14 }, 12.8, 'karaoke');
    expect(a.calls).toEqual(b.calls);
    expect(a.calls.length).toBeGreaterThan(0);
  });
});
