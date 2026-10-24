/**
 * chunkTranscript unit tests (SPEC §8.5, §17). Pure: no workers, no model.
 */
import { describe, expect, it } from 'vitest';
import {
  DEDUPE_OVERLAP,
  MIN_WINDOW_SEC,
  MIN_WORDS,
  SNAP_SEC,
  WINDOW_SEC,
  chunkTranscript,
  dedupeDrafts,
  snapToBoundary,
} from '../src/pipeline/chunking';
import type { Segment, Transcript, Word } from '../src/core/types';

/**
 * Evenly spaced words; a segment every `wordsPerSegment` words. With dt=0.5 and
 * 10 words per segment, segments are 5 s long, so boundaries fall on multiples
 * of 5 s and snapping is exact.
 */
function makeTranscript(wordCount: number, dt = 0.5, wordsPerSegment = 10): Transcript {
  const words: Word[] = [];
  for (let i = 0; i < wordCount; i++) {
    const start = i * dt;
    words.push({ text: `w${i}`, start, end: start + dt * 0.8 });
  }
  const segments: Segment[] = [];
  for (let i = 0; i < wordCount; i += wordsPerSegment) {
    const group = words.slice(i, i + wordsPerSegment);
    segments.push({
      text: group.map((w) => w.text).join(' '),
      start: group[0].start,
      end: group[group.length - 1].end,
    });
  }
  return { language: 'en', words, segments };
}

describe('chunkTranscript: window sizes and stride', () => {
  // 120 s of speech: windows start every 15 s, each 40 s long.
  const t = makeTranscript(240);
  const cands = chunkTranscript(t);

  it('produces windows no longer than 40 s and no shorter than 3 s', () => {
    expect(cands.length).toBeGreaterThan(0);
    for (const c of cands) {
      const len = c.endSec - c.startSec;
      expect(len).toBeLessThanOrEqual(WINDOW_SEC + 1e-9);
      expect(len).toBeGreaterThanOrEqual(MIN_WINDOW_SEC);
    }
  });

  it('steps by the 15 s stride (boundaries sit on segment edges here)', () => {
    const starts = cands.map((c) => c.startSec);
    expect(starts).toEqual([0, 15, 30, 45, 60, 75]);
  });

  it('keeps full-length windows at exactly 40 s when boundaries align', () => {
    for (const c of cands) expect(c.endSec - c.startSec).toBeCloseTo(WINDOW_SEC, 9);
  });

  it('marks every candidate as a chunked window with no score yet', () => {
    for (const c of cands) {
      expect(c.source).toBe('chunked');
      expect(c.score).toBeUndefined();
      expect(c.reason).toBeUndefined();
    }
  });
});

describe('chunkTranscript: word counts and text', () => {
  it('builds text from the words inside each window', () => {
    const t = makeTranscript(240);
    const [first] = chunkTranscript(t);
    expect(first.text.split(' ')[0]).toBe('w0');
    // 40 s at 0.5 s per word = 80 words.
    expect(first.text.split(' ')).toHaveLength(80);
  });

  it('keeps only windows with at least MIN_WORDS words', () => {
    // 40 words over 20 s; every window has ≥8 words, so none are dropped.
    const dense = chunkTranscript(makeTranscript(40));
    for (const c of dense) expect(c.text.split(' ').length).toBeGreaterThanOrEqual(MIN_WORDS);
  });

  it('discards a region with fewer than MIN_WORDS words', () => {
    // 5 words in 2.5 s: under 8 words, and under 3 s.
    expect(chunkTranscript(makeTranscript(5))).toEqual([]);
  });

  it('discards a transcript shorter than the minimum window length', () => {
    // 10 words at 0.2 s = 2 s of speech: a window would be < 3 s.
    expect(chunkTranscript(makeTranscript(10, 0.2, 5))).toEqual([]);
  });
});

describe('chunkTranscript: snapping', () => {
  it('snaps to the nearest boundary within 3 s', () => {
    expect(snapToBoundary(10, [8.5, 14])).toBe(8.5); // 1.5 away; 14 is 4 away, out of range
    expect(snapToBoundary(10, [8.5, 11.2])).toBe(11.2); // 1.2 vs 1.5 → nearer wins
    expect(snapToBoundary(10, [6.9])).toBe(10); // 3.1 away → unchanged
    expect(snapToBoundary(10, [])).toBe(10);
    expect(SNAP_SEC).toBe(3);
  });

  it('moves a window start onto a nearby segment boundary', () => {
    // Segments start at 1, 6, 11, ... (not 0, 5, 10). Window starts at 0 → snaps to 1.
    const words: Word[] = [];
    for (let i = 0; i < 200; i++) words.push({ text: `x${i}`, start: i * 0.5, end: i * 0.5 + 0.4 });
    const segments: Segment[] = [];
    for (let s = 1; s < 100; s += 5) segments.push({ text: 'seg', start: s, end: s + 4 });
    const cands = chunkTranscript({ language: 'en', words, segments });
    expect(cands[0].startSec).toBe(1);
    for (const c of cands) {
      // Every boundary snapped to a segment edge, or stayed within SNAP_SEC of its raw value.
      const boundaries = segments.flatMap((s) => [s.start, s.end]);
      const nearEdge = boundaries.some((b) => Math.abs(b - c.startSec) < 1e-9);
      expect(nearEdge || c.startSec % 15 === 0).toBe(true);
    }
  });

  it('never ends past the end of the speech', () => {
    const t = makeTranscript(130); // 65 s
    for (const c of chunkTranscript(t)) expect(c.endSec).toBeLessThanOrEqual(65 + 1e-9);
  });
});

describe('chunkTranscript: deduplication', () => {
  it('merges windows overlapping more than 80% and keeps the wordier one', () => {
    const a = { startSec: 0, endSec: 40, words: [] as Word[] };
    const wordy = { startSec: 1, endSec: 40, words: new Array(60).fill({ text: 'x', start: 0, end: 0 }) as Word[] };
    // The shorter window (39 s) lies wholly inside the other → overlap 1.0 > 0.8
    const out = dedupeDrafts([a, wordy]);
    expect(out).toHaveLength(1);
    expect(out[0].words).toHaveLength(60);
    expect(DEDUPE_OVERLAP).toBe(0.8);
  });

  it('keeps windows that overlap less than 80%', () => {
    const a = { startSec: 0, endSec: 40, words: new Array(20).fill({ text: 'x', start: 0, end: 0 }) as Word[] };
    const b = { startSec: 15, endSec: 55, words: new Array(20).fill({ text: 'x', start: 0, end: 0 }) as Word[] };
    // 25 s shared of 40 s → 0.625 < 0.8
    expect(dedupeDrafts([a, b])).toHaveLength(2);
  });

  it('leaves no two surviving candidates above the overlap limit', () => {
    const t = makeTranscript(600); // 300 s, many overlapping windows
    const cands = chunkTranscript(t);
    expect(cands.length).toBeGreaterThan(5);
    for (let i = 0; i < cands.length; i++) {
      for (let j = i + 1; j < cands.length; j++) {
        const a = cands[i];
        const b = cands[j];
        const inter = Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec);
        const shorter = Math.min(a.endSec - a.startSec, b.endSec - b.startSec);
        if (inter > 0) expect(inter / shorter).toBeLessThanOrEqual(DEDUPE_OVERLAP + 1e-9);
      }
    }
  });

  it('orders output by start time', () => {
    const cands = chunkTranscript(makeTranscript(600));
    const starts = cands.map((c) => c.startSec);
    expect([...starts].sort((x, y) => x - y)).toEqual(starts);
  });
});

describe('chunkTranscript: edge cases and ids', () => {
  it('returns [] for an empty transcript', () => {
    expect(chunkTranscript({ language: 'en', words: [], segments: [] })).toEqual([]);
  });

  it('gives stable ids from the boundaries (same input, same ids)', () => {
    const a = chunkTranscript(makeTranscript(240)).map((c) => c.id);
    const b = chunkTranscript(makeTranscript(240)).map((c) => c.id);
    expect(a).toEqual(b);
    expect(a[0]).toBe('chunk-0-4000');
  });

  it('falls back to word boundaries when there are no segments', () => {
    const t = { ...makeTranscript(240), segments: [] };
    const cands = chunkTranscript(t);
    expect(cands.length).toBeGreaterThan(0);
    for (const c of cands) expect(c.endSec - c.startSec).toBeLessThanOrEqual(WINDOW_SEC + 1e-9);
  });
});
