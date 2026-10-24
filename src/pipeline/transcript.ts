/**
 * Pure transcript normalization (SPEC §5, §8.4). The ASR worker produces raw
 * word chunks per 30 s window; this module turns them into the `Transcript`
 * shape the UI and job machine consume:
 *
 *  - timestamps are finite float seconds, clamped to [0, duration];
 *  - words are non-empty, strictly ordered by start, and never overlap
 *    (an overlapping previous word is trimmed to the next word's onset);
 *  - words that begin at or after the end of the video are dropped;
 *  - windows overlap for context, so words are assigned to exactly one window
 *    by their start time before normalization (no duplicates at seams).
 */
import type { Segment, Transcript, Word } from '../core/types';

/** A word as emitted by the ASR pipeline (`return_timestamps: 'word'`). */
export interface RawWord {
  text?: unknown;
  timestamp?: unknown;
}

/** Window schedule used by the ASR worker (Whisper's native input is 30 s). */
export const ASR_WINDOW_SEC = 30;
export const ASR_OVERLAP_SEC = 2;

/** Segment breaking: a pause at least this long, or sentence-ending punctuation. */
const SEGMENT_GAP_SEC = 1.0;
const SEGMENT_MAX_WORDS = 40;

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Parse a raw `[start, end]` pair; either side may be missing/null/NaN. */
function timingOf(raw: RawWord): { start: number | null; end: number | null } {
  const ts = Array.isArray(raw.timestamp) ? raw.timestamp : [];
  const s = ts[0];
  const e = ts[1];
  return {
    start: typeof s === 'number' && Number.isFinite(s) ? s : null,
    end: typeof e === 'number' && Number.isFinite(e) ? e : null,
  };
}

/**
 * Normalize raw words to `Word[]`.
 *
 * Missing timestamps are interpolated from neighbours (a missing start takes
 * the previous word's end, a missing end collapses to the start). Words whose
 * text is empty after trimming are dropped. `durationSec <= 0` disables the
 * upper clamp (unknown duration), but timestamps are still made monotonic.
 */
export function normalizeWords(raw: readonly RawWord[], durationSec: number): Word[] {
  const hasDuration = Number.isFinite(durationSec) && durationSec > 0;
  const out: Word[] = [];
  let prevEnd = 0;

  for (const r of raw) {
    const text = typeof r.text === 'string' ? r.text.trim() : '';
    if (text.length === 0) continue;

    const { start: rawStart, end: rawEnd } = timingOf(r);
    let start = finiteOr(rawStart, prevEnd);
    let end = finiteOr(rawEnd, start);

    start = Math.max(0, start);
    end = Math.max(start, end);

    if (hasDuration) {
      if (start >= durationSec) continue; // entirely past the end of the video
      end = Math.min(end, durationSec);
    }

    // Keep starts non-decreasing (raw output can be slightly out of order).
    const last = out[out.length - 1];
    if (last) {
      if (start < last.start) start = last.start;
      // Overlap: trim the previous word to this word's onset.
      if (last.end > start) last.end = Math.max(last.start, start);
    }
    end = Math.max(start, end);
    if (hasDuration) end = Math.min(end, durationSec);

    out.push({ text, start, end });
    prevEnd = end;
  }
  return out;
}

export interface SegmentGroup {
  segment: Segment;
  /** Index range [from, to) of this segment's words in the word list. */
  from: number;
  to: number;
}

/** Group normalized words into segments (sentence end, pause, or length), with word ranges. */
export function groupWords(words: readonly Word[]): SegmentGroup[] {
  const groups: SegmentGroup[] = [];
  let from = 0;
  const flush = (to: number): void => {
    if (to <= from) return;
    const slice = words.slice(from, to);
    groups.push({
      segment: {
        start: slice[0].start,
        end: slice[slice.length - 1].end,
        text: slice.map((w) => w.text).join(' '),
      },
      from,
      to,
    });
    from = to;
  };

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1];
    const count = i + 1 - from;
    const sentenceEnd = /[.!?]["')\]]?$/.test(w.text);
    const pause = next !== undefined && next.start - w.end >= SEGMENT_GAP_SEC;
    if (sentenceEnd || pause || count >= SEGMENT_MAX_WORDS) flush(i + 1);
  }
  flush(words.length);
  return groups;
}

export function buildSegments(words: readonly Word[]): Segment[] {
  return groupWords(words).map((g) => g.segment);
}

/**
 * Index of the word under the playhead: the last word that has started by `t`.
 * Holding the last word through short pauses keeps the highlight stable.
 * Returns -1 before the first word.
 */
export function activeWordIndex(words: readonly Word[], t: number): number {
  let lo = 0;
  let hi = words.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].start <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** Full normalization: words + segments, clamped to the video duration. */
export function normalizeTranscript(
  raw: readonly RawWord[],
  opts: { durationSec: number; language?: string },
): Transcript {
  const words = normalizeWords(raw, opts.durationSec);
  return {
    language: opts.language ?? 'en',
    words,
    segments: buildSegments(words),
  };
}

export interface WindowPlan {
  /** Absolute start of the window in seconds. */
  offsetSec: number;
  /** Window length in seconds (the last window may be shorter). */
  lengthSec: number;
}

/**
 * Plan overlapping windows covering [0, durationSec). Window `i` starts at
 * `i * (windowSec - overlapSec)`, so consecutive windows share `overlapSec`.
 */
export function planWindows(
  durationSec: number,
  windowSec = ASR_WINDOW_SEC,
  overlapSec = ASR_OVERLAP_SEC,
): WindowPlan[] {
  if (!(durationSec > 0)) return [];
  if (!(overlapSec >= 0 && overlapSec < windowSec)) throw new Error('planWindows: bad overlap');
  const step = windowSec - overlapSec;
  const plans: WindowPlan[] = [];
  for (let offset = 0; offset < durationSec; offset += step) {
    plans.push({ offsetSec: offset, lengthSec: Math.min(windowSec, durationSec - offset) });
    if (offset + windowSec >= durationSec) break;
  }
  return plans;
}

/**
 * Turn per-window raw words into one absolute-time list, keeping each word
 * only in the window that "owns" it. A word is owned by its absolute start
 * time (or by its window offset when untimed). Ownership boundaries are the
 * midpoints of the overlaps, so a word spoken in the overlap appears once.
 */
export function stitchWindows(
  windows: readonly { offsetSec: number; words: readonly RawWord[] }[],
  opts: { windowSec?: number; overlapSec?: number } = {},
): RawWord[] {
  const windowSec = opts.windowSec ?? ASR_WINDOW_SEC;
  const overlapSec = opts.overlapSec ?? ASR_OVERLAP_SEC;
  const step = windowSec - overlapSec;
  const out: RawWord[] = [];

  windows.forEach((win, i) => {
    const keepFrom = i === 0 ? -Infinity : win.offsetSec + overlapSec / 2;
    const keepTo = i === windows.length - 1 ? Infinity : win.offsetSec + step + overlapSec / 2;
    for (const w of win.words) {
      const { start, end } = timingOf(w);
      const absStart = start === null ? null : start + win.offsetSec;
      const absEnd = end === null ? null : end + win.offsetSec;
      const owner = absStart ?? win.offsetSec;
      if (owner >= keepFrom && owner < keepTo) {
        out.push({ text: w.text, timestamp: [absStart, absEnd] });
      }
    }
  });
  return out;
}
