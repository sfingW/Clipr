/**
 * Chunking (SPEC §8.5) — pure and testable: sliding windows over the
 * transcript → candidate windows the LLM will score. This is where most of the
 * clip quality is decided, so the rules are small, explicit and unit tested.
 *
 *  - 40 s windows, 15 s stride, over the whole transcript.
 *  - Each boundary snaps to the nearest segment start/end within 3 s.
 *  - Windows shorter than 3 s, or with fewer than 8 words, are dropped.
 *  - Windows overlapping another by more than 80% (of the shorter one) are
 *    merged: the one with more words is kept.
 *
 * No I/O, no model. Words are assigned to a window by their midpoint.
 */
import type { Candidate, Segment, Transcript, Word } from '../core/types';

export const WINDOW_SEC = 40;
export const STRIDE_SEC = 15;
export const SNAP_SEC = 3;
export const MIN_WINDOW_SEC = 3;
export const MIN_WORDS = 8;
export const DEDUPE_OVERLAP = 0.8;

interface Draft {
  startSec: number;
  endSec: number;
  words: Word[];
}

/** Nearest boundary within SNAP_SEC of t, or t itself when none is that close. */
export function snapToBoundary(t: number, boundaries: readonly number[]): number {
  let best = t;
  let bestDist = SNAP_SEC + Number.EPSILON;
  for (const b of boundaries) {
    const d = Math.abs(b - t);
    if (d <= SNAP_SEC && d < bestDist) {
      best = b;
      bestDist = d;
    }
  }
  return best;
}

/** Segment starts and ends, sorted and de-duplicated. Words stand in when there are no segments. */
function boundariesOf(segments: Segment[], words: Word[]): number[] {
  const src: { start: number; end: number }[] =
    segments.length > 0 ? segments : words.map((w) => ({ start: w.start, end: w.end }));
  const set = new Set<number>();
  for (const s of src) {
    set.add(s.start);
    set.add(s.end);
  }
  return [...set].sort((a, b) => a - b);
}

function durationOf(t: Transcript): number {
  let end = 0;
  for (const w of t.words) end = Math.max(end, w.end);
  for (const s of t.segments) end = Math.max(end, s.end);
  return end;
}

function overlapRatio(a: Draft, b: Draft): number {
  const inter = Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec);
  if (inter <= 0) return 0;
  const shorter = Math.min(a.endSec - a.startSec, b.endSec - b.startSec);
  return shorter > 0 ? inter / shorter : 0;
}

/** Merge drafts that overlap more than DEDUPE_OVERLAP; the one with more words wins. */
export function dedupeDrafts(drafts: Draft[]): Draft[] {
  const sorted = [...drafts].sort((a, b) => a.startSec - b.startSec || b.endSec - a.endSec);
  const kept: Draft[] = [];
  for (const d of sorted) {
    const idx = kept.findIndex((k) => overlapRatio(k, d) > DEDUPE_OVERLAP);
    if (idx === -1) {
      kept.push(d);
    } else if (d.words.length > kept[idx].words.length) {
      kept[idx] = d;
    }
  }
  return kept.sort((a, b) => a.startSec - b.startSec);
}

/** Stable id from the snapped boundaries (centiseconds), so reruns give the same ids. */
function idFor(startSec: number, endSec: number): string {
  return `chunk-${Math.round(startSec * 100)}-${Math.round(endSec * 100)}`;
}

export function chunkTranscript(transcript: Transcript): Candidate[] {
  const words = [...transcript.words].sort((a, b) => a.start - b.start);
  const duration = durationOf(transcript);
  if (words.length === 0 || duration <= 0) return [];

  const boundaries = boundariesOf(transcript.segments, words);
  const drafts: Draft[] = [];

  for (let rawStart = 0; rawStart < duration; rawStart += STRIDE_SEC) {
    const rawEnd = Math.min(duration, rawStart + WINDOW_SEC);
    const startSec = snapToBoundary(rawStart, boundaries);
    const endSec = Math.min(duration, snapToBoundary(rawEnd, boundaries));
    if (endSec - startSec >= MIN_WINDOW_SEC) {
      const inWindow = words.filter((w) => {
        const mid = (w.start + w.end) / 2;
        return mid >= startSec && mid < endSec;
      });
      if (inWindow.length >= MIN_WORDS) {
        drafts.push({ startSec, endSec, words: inWindow });
      }
    }
    if (rawEnd >= duration) break;
  }

  return dedupeDrafts(drafts).map((d) => ({
    id: idFor(d.startSec, d.endSec),
    startSec: d.startSec,
    endSec: d.endSec,
    text: d.words.map((w) => w.text).join(' '),
    source: 'chunked',
  }));
}
