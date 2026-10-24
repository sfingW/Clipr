import { describe, expect, it } from 'vitest';
import {
  ASR_OVERLAP_SEC,
  ASR_WINDOW_SEC,
  activeWordIndex,
  groupWords,
  buildSegments,
  normalizeTranscript,
  normalizeWords,
  planWindows,
  stitchWindows,
  type RawWord,
} from '../src/pipeline/transcript';

const w = (text: string, start: number | null, end: number | null): RawWord => ({
  text,
  timestamp: [start, end],
});

function assertInvariants(words: { start: number; end: number }[], duration: number): void {
  for (let i = 0; i < words.length; i++) {
    const x = words[i];
    expect(Number.isFinite(x.start)).toBe(true);
    expect(Number.isFinite(x.end)).toBe(true);
    expect(x.start).toBeGreaterThanOrEqual(0);
    expect(x.end).toBeGreaterThanOrEqual(x.start);
    expect(x.end).toBeLessThanOrEqual(duration);
    if (i > 0) {
      expect(x.start).toBeGreaterThanOrEqual(words[i - 1].start);
      expect(x.start).toBeGreaterThanOrEqual(words[i - 1].end);
    }
  }
}

describe('normalizeWords', () => {
  it('returns an empty list for empty model output', () => {
    expect(normalizeWords([], 10)).toEqual([]);
    expect(normalizeTranscript([], { durationSec: 10 })).toEqual({
      language: 'en',
      words: [],
      segments: [],
    });
  });

  it('drops words whose text is empty or whitespace', () => {
    const out = normalizeWords([w('  ', 0, 0.2), w('', 0.2, 0.4), w(' hi ', 0.4, 0.8)], 5);
    expect(out).toEqual([{ text: 'hi', start: 0.4, end: 0.8 }]);
  });

  it('interpolates missing timestamps from neighbours', () => {
    const out = normalizeWords(
      [w('a', 1, 1.5), w('b', null, null), w('c', 2, null), w('d', null, 4)],
      10,
    );
    // b: start from previous end (1.5), zero-length end collapses to start
    expect(out[1]).toEqual({ text: 'b', start: 1.5, end: 1.5 });
    // c: missing end collapses to its start
    expect(out[2]).toEqual({ text: 'c', start: 2, end: 2 });
    // d: missing start takes previous end (2)
    expect(out[3]).toEqual({ text: 'd', start: 2, end: 4 });
    assertInvariants(out, 10);
  });

  it('treats NaN and infinite timestamps as missing', () => {
    const out = normalizeWords([w('a', 0.5, 1), w('b', Number.NaN, Number.POSITIVE_INFINITY)], 10);
    expect(out[1].start).toBe(1);
    expect(Number.isFinite(out[1].end)).toBe(true);
    assertInvariants(out, 10);
  });

  it('clamps timestamps to the video duration', () => {
    const out = normalizeWords([w('late', 9.5, 12.0)], 10);
    expect(out).toEqual([{ text: 'late', start: 9.5, end: 10 }]);
  });

  it('drops words that start at or after the end of the video', () => {
    const out = normalizeWords([w('ok', 1, 2), w('ghost', 10, 11), w('ghost2', 14, 15)], 10);
    expect(out.map((x) => x.text)).toEqual(['ok']);
  });

  it('clamps negative starts to zero', () => {
    const out = normalizeWords([w('early', -0.4, 0.3)], 10);
    expect(out).toEqual([{ text: 'early', start: 0, end: 0.3 }]);
  });

  it('trims overlapping previous words to the next onset (no overlaps)', () => {
    const out = normalizeWords([w('one', 0, 1.2), w('two', 1.0, 1.5), w('three', 1.4, 2.0)], 10);
    expect(out.map((x) => [x.text, x.start, x.end])).toEqual([
      ['one', 0, 1],
      ['two', 1, 1.4],
      ['three', 1.4, 2],
    ]);
    assertInvariants(out, 10);
  });

  it('keeps starts monotonic when the model emits out-of-order words', () => {
    const out = normalizeWords([w('b', 2, 2.5), w('a', 1, 1.5)], 10);
    expect(out[1].start).toBeGreaterThanOrEqual(out[0].start);
    assertInvariants(out, 10);
  });

  it('keeps an unknown duration unclamped but still ordered', () => {
    const out = normalizeWords([w('a', 0, 50)], 0);
    expect(out).toEqual([{ text: 'a', start: 0, end: 50 }]);
  });
});

describe('buildSegments', () => {
  it('breaks on sentence end and on long pauses', () => {
    const words = normalizeWords(
      [
        w('Hello', 0, 0.4),
        w('world.', 0.5, 0.9),
        w('Next', 0.95, 1.2),
        w('one', 3.0, 3.3), // 1.8 s pause → new segment
      ],
      10,
    );
    const segs = buildSegments(words);
    expect(segs.map((s) => s.text)).toEqual(['Hello world.', 'Next', 'one']);
    expect(segs[0]).toEqual({ start: 0, end: 0.9, text: 'Hello world.' });
  });
});

describe('normalizeTranscript', () => {
  it('produces words and segments that agree', () => {
    const t = normalizeTranscript([w('Hi.', 0, 0.5), w('there', 0.6, 1)], { durationSec: 2 });
    expect(t.segments.length).toBe(2);
    expect(t.words.length).toBe(2);
    expect(t.segments[0].start).toBe(t.words[0].start);
    expect(t.segments[1].end).toBe(t.words[1].end);
  });
});

describe('planWindows', () => {
  it('covers the duration with overlapping 30 s windows', () => {
    const plans = planWindows(65);
    expect(plans[0]).toEqual({ offsetSec: 0, lengthSec: 30 });
    expect(plans[1].offsetSec).toBeCloseTo(ASR_WINDOW_SEC - ASR_OVERLAP_SEC);
    const last = plans[plans.length - 1];
    expect(last.offsetSec + last.lengthSec).toBeCloseTo(65);
  });

  it('returns one window for short audio and none for empty audio', () => {
    expect(planWindows(10)).toEqual([{ offsetSec: 0, lengthSec: 10 }]);
    expect(planWindows(0)).toEqual([]);
  });
});

describe('stitchWindows', () => {
  it('assigns each word in an overlap to exactly one window', () => {
    // Window 0 covers [0,30), window 1 covers [28,58). The overlap is [28,30).
    // A word at absolute 29.0 is heard by both windows; it must appear once.
    const win0 = { offsetSec: 0, words: [w('a', 1, 1.2), w('edge', 29.0, 29.3)] };
    const win1 = { offsetSec: 28, words: [w('edge', 1.0, 1.3), w('b', 5, 5.2)] };
    const stitched = stitchWindows([win0, win1]);
    const texts = stitched.map((x) => x.text);
    expect(texts).toEqual(['a', 'edge', 'b']);
    const starts = stitched.map((x) => (x.timestamp as number[])[0]);
    expect(starts).toEqual([1, 29, 33]);
  });

  it('shifts timestamps into absolute time', () => {
    const out = stitchWindows([{ offsetSec: 0, words: [w('x', 2, 2.5)] }]);
    expect(out[0].timestamp).toEqual([2, 2.5]);
  });

  it('returns no words for no windows', () => {
    expect(stitchWindows([])).toEqual([]);
  });
});

describe('end to end: stitched windows normalize without duplicates', () => {
  it('produces ordered, clamped words across a seam', () => {
    const plans = planWindows(40);
    // Window 0 hears 'word' at abs 28.5 (inside the overlap). Window 1 hears the
    // same word at its local 0.5 (= abs 28.5). Ownership is decided by midpoint
    // (29 s), so window 0 keeps it and window 1's copy is dropped.
    const perWindow = [
      { offsetSec: 0, words: [w('word', 0.5, 0.9), w('mid', 10, 10.4), w('tail', 27.8, 28.2), w('word', 28.5, 28.9)] },
      { offsetSec: plans[1].offsetSec, words: [w('word', 0.5, 0.9), w('mid', 10, 10.4), w('tail', 27.8, 28.2)] },
    ];
    const raw = stitchWindows(perWindow);
    const words = normalizeWords(raw, 40);
    assertInvariants(words, 40);
    // Window 1's 'mid' lands at abs 38 (owned by window 1); its 'tail' lands at
    // abs 55.8, past the 40 s video, so it is dropped.
    expect(words.map((x) => x.text)).toEqual(['word', 'mid', 'tail', 'word', 'mid']);
    expect(words.map((x) => x.start)).toEqual([0.5, 10, 27.8, 28.5, 38]);
  });
});

describe('groupWords (segment → word ranges for the pane)', () => {
  it('covers every word exactly once, in order', () => {
    const words = normalizeWords(
      [w('One', 0, 0.3), w('two.', 0.35, 0.6), w('three', 2.0, 2.3), w('four', 2.35, 2.6), w('five', 2.65, 2.9)],
      10,
    );
    const groups = groupWords(words);
    expect(groups.map((g) => [g.from, g.to])).toEqual([
      [0, 2],
      [2, 5],
    ]);
    expect(groups[0].segment.text).toBe('One two.');
    expect(groups[0].segment.start).toBe(0);
    expect(groups[1].segment.end).toBe(words[4].end);
  });

  it('is empty for no words', () => {
    expect(groupWords([])).toEqual([]);
  });

  it('agrees with buildSegments', () => {
    const words = normalizeWords([w('a', 0, 0.2), w('b.', 0.25, 0.5), w('c', 3, 3.2)], 10);
    expect(groupWords(words).map((g) => g.segment)).toEqual(buildSegments(words));
  });
});

describe('activeWordIndex (playhead → highlighted word)', () => {
  const words = normalizeWords([w('a', 1, 1.5), w('b', 2, 2.5), w('c', 4, 4.5)], 10);

  it('returns -1 before the first word', () => {
    expect(activeWordIndex(words, 0.5)).toBe(-1);
    expect(activeWordIndex([], 3)).toBe(-1);
  });

  it('returns the word that has started, and holds it through a pause', () => {
    expect(activeWordIndex(words, 1.2)).toBe(0);
    expect(activeWordIndex(words, 3.0)).toBe(1); // in the gap after "b"
    expect(activeWordIndex(words, 4.0)).toBe(2);
    expect(activeWordIndex(words, 99)).toBe(2);
  });

  it('is exact at word starts', () => {
    expect(activeWordIndex(words, 2)).toBe(1);
  });
});
