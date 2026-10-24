/**
 * Caption rendering (SPEC §8.9). One implementation, two callers:
 *  - ClipPreview draws onto a transparent overlay canvas sized outW×outH,
 *    positioned over the crop rect (same geometry as the export frame).
 *  - render.worker (and the FFmpeg fallback) draw onto the composited export
 *    frame of the same outW×outH size.
 * Both go through `drawClipCaptions`, so the preview and the export share
 * line grouping, timing, typography, placement and fit-scaling. Layout is
 * expressed as fractions of the frame height, so the preview (smaller on
 * screen) and the export produce the same picture, scaled.
 *
 * Canvas 2D only — no DOM, no external caption library. Fonts are system
 * stacks: web fonts do not load inside workers.
 *
 * Pure parts (grouping, timing, planning) take no canvas and are unit tested.
 */
import type { Word } from '../core/types';

/** Line limits (SPEC §8.9): ≤4 words, ≤22 characters per line. */
export const CAPTION_MAX_WORDS = 4;
export const CAPTION_MAX_CHARS = 22;
/**
 * A pause longer than this starts a new line even when the line is not full.
 * Beyond SPEC §8.9's word/char limits — keeps captions from sitting on screen
 * across silence.
 */
export const CAPTION_MAX_PAUSE_SEC = 1;
/** Lines wider than this fraction of the frame width are shrunk to fit. */
export const CAPTION_MAX_WIDTH_FRAC = 0.9;

export type CaptionStyleId = 'bold-center' | 'karaoke';
/** Dropdown values. `none` disables captions entirely. */
export type CaptionStyleKey = CaptionStyleId | 'none';

export interface CaptionStyle {
  id: CaptionStyleId;
  label: string;
  uppercase: boolean;
  weight: number;
  family: string;
  /** Font size as a fraction of frame height. */
  fontFrac: number;
  /** Baseline position as a fraction of frame height (from the top). */
  baselineFrac: number;
  fill: string;
  /** Fill for the active word (karaoke). null → no per-word highlight. */
  highlight: string | null;
  stroke: string;
  /** Stroke width as a fraction of the font size. */
  strokeEm: number;
}

export const CAPTION_STYLES: Record<CaptionStyleId, CaptionStyle> = {
  'bold-center': {
    id: 'bold-center',
    label: 'Bold center',
    uppercase: true,
    weight: 900,
    family: '"Arial Black", "Helvetica Neue", Arial, Helvetica, sans-serif',
    fontFrac: 0.075,
    baselineFrac: 0.84,
    fill: '#ffffff',
    highlight: null,
    stroke: '#000000',
    strokeEm: 0.16,
  },
  karaoke: {
    id: 'karaoke',
    label: 'Karaoke',
    uppercase: false,
    weight: 700,
    family: '"Helvetica Neue", Arial, Helvetica, sans-serif',
    fontFrac: 0.058,
    baselineFrac: 0.82,
    fill: '#ffffff',
    highlight: '#ffd60a',
    stroke: '#000000',
    strokeEm: 0.12,
  },
};

/** Resolve a style id; `none` and unknown ids return null (no captions). */
export function resolveCaptionStyle(id: string): CaptionStyle | null {
  return Object.prototype.hasOwnProperty.call(CAPTION_STYLES, id)
    ? CAPTION_STYLES[id as CaptionStyleId]
    : null;
}

export interface CaptionGroup {
  /** Words on this line, in order, with clip-relative timings. */
  words: Word[];
  /** Line text as displayed by the plain (non-karaoke) readout. */
  text: string;
  /** Line is on screen for start ≤ t < end (clip-relative seconds). */
  start: number;
  end: number;
}

function makeGroup(words: Word[]): CaptionGroup {
  return {
    words,
    text: words.map((w) => w.text).join(' '),
    start: words[0].start,
    end: Math.max(...words.map((w) => w.end)),
  };
}

/**
 * Group clip-relative words into display lines. Breaks when a line already has
 * CAPTION_MAX_WORDS words, adding the next word would exceed CAPTION_MAX_CHARS,
 * or the gap since the previous word exceeds CAPTION_MAX_PAUSE_SEC.
 * A single word longer than the char limit gets a line of its own.
 */
export function groupLines(words: Word[]): CaptionGroup[] {
  const groups: CaptionGroup[] = [];
  const sorted = words
    .map((w) => ({ text: w.text.trim(), start: w.start, end: w.end }))
    .filter((w) => w.text.length > 0)
    .sort((a, b) => a.start - b.start);

  let cur: Word[] = [];
  let curChars = 0;
  const flush = (): void => {
    if (cur.length > 0) groups.push(makeGroup(cur));
    cur = [];
    curChars = 0;
  };

  for (const w of sorted) {
    if (cur.length > 0) {
      const last = cur[cur.length - 1];
      const nextChars = curChars + 1 + w.text.length;
      const gap = w.start - last.end;
      if (cur.length >= CAPTION_MAX_WORDS || nextChars > CAPTION_MAX_CHARS || gap > CAPTION_MAX_PAUSE_SEC) {
        flush();
      }
    }
    curChars = cur.length > 0 ? curChars + 1 + w.text.length : w.text.length;
    cur.push(w);
  }
  flush();
  return groups;
}

/**
 * Absolute (source) word timings → clip-relative timings for [startSec, endSec).
 * Keeps every word that overlaps the clip, shifts by -startSec, and clamps each
 * word to [0, cut length] so no word extends outside the clip.
 */
export function clipWordsRelative(absWords: Word[], startSec: number, endSec: number): Word[] {
  const len = Math.max(0, endSec - startSec);
  const out: Word[] = [];
  for (const w of absWords) {
    if (w.end <= startSec || w.start >= endSec) continue;
    const s = Math.max(0, w.start - startSec);
    const e = Math.min(len, w.end - startSec);
    if (e <= s) continue;
    out.push({ text: w.text, start: s, end: e });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Absolute source time → clip-relative time. Deliberately NOT clamped: a time
 * before the clip start must map to a negative value, so nothing is shown
 * there in either the preview or the export.
 */
export function relativeCaptionTime(absSec: number, startSec: number): number {
  return absSec - startSec;
}

/**
 * Index of the word highlighted by karaoke at clip-relative time t. The word
 * being spoken wins; in a pause, the most recently started word stays
 * highlighted; before the first word, -1.
 */
export function karaokeActiveIndex(words: Word[], tRelSec: number): number {
  let idx = -1;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (tRelSec >= w.start && tRelSec < w.end) return i;
    if (w.start <= tRelSec) idx = i;
  }
  return idx;
}

/** A single text draw. Coordinates are in output (outW×outH) pixels. */
export interface TextOp {
  text: string;
  x: number;
  y: number;
  font: string;
  fill: string;
  stroke: string | null;
  strokeWidth: number;
}

/** Measures `text` in the given CSS font, returning width in pixels. */
export type MeasureFn = (text: string, font: string) => number;

function fontString(style: CaptionStyle, px: number): string {
  return `${style.weight} ${px.toFixed(2)}px ${style.family}`;
}

function capitalizeFirst(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/**
 * Pure layout: which line is on screen at tRelSec and where each text op goes.
 * Returns [] when no line is active. Fit-scaling shrinks the font (only ever
 * down) so the line fits within CAPTION_MAX_WIDTH_FRAC of the frame width.
 */
export function planCaptionFrame(
  relWords: Word[],
  tRelSec: number,
  style: CaptionStyle,
  W: number,
  H: number,
  measure: MeasureFn,
): TextOp[] {
  if (W <= 0 || H <= 0) return [];
  const group = groupLines(relWords).find((g) => tRelSec >= g.start && tRelSec < g.end);
  if (!group) return [];

  const maxW = W * CAPTION_MAX_WIDTH_FRAC;
  const y = H * style.baselineFrac;
  const basePx = H * style.fontFrac;
  const baseFont = fontString(style, basePx);

  if (style.id === 'bold-center') {
    const text = style.uppercase ? group.text.toUpperCase() : group.text;
    const w0 = measure(text, baseFont);
    const scale = w0 > maxW && w0 > 0 ? maxW / w0 : 1;
    const px = basePx * scale;
    const width = w0 * scale;
    return [
      {
        text,
        x: (W - width) / 2,
        y,
        font: fontString(style, px),
        fill: style.fill,
        stroke: style.stroke,
        strokeWidth: px * style.strokeEm,
      },
    ];
  }

  // karaoke: sentence case (first word capitalised), per-word fill.
  const texts = group.words.map((w, i) => (i === 0 ? capitalizeFirst(w.text) : w.text));
  const spaceW = measure(' ', baseFont);
  const widths = texts.map((t) => measure(t, baseFont));
  const total0 = widths.reduce((a, b) => a + b, 0) + spaceW * Math.max(0, texts.length - 1);
  const scale = total0 > maxW && total0 > 0 ? maxW / total0 : 1;
  const px = basePx * scale;
  const font = fontString(style, px);
  const active = karaokeActiveIndex(group.words, tRelSec);

  let x = (W - total0 * scale) / 2;
  const ops: TextOp[] = [];
  for (let i = 0; i < texts.length; i++) {
    const isActive = i === active && style.highlight !== null;
    ops.push({
      text: texts[i],
      x,
      y,
      font,
      fill: isActive ? (style.highlight as string) : style.fill,
      stroke: style.stroke,
      strokeWidth: px * style.strokeEm,
    });
    x += (widths[i] + spaceW) * scale;
  }
  return ops;
}

/** Minimal 2D context surface used by drawing (satisfied by real and mock contexts). */
export interface CaptionCtx {
  canvas: { width: number; height: number };
  font: string;
  textAlign: string;
  textBaseline: string;
  lineJoin: string;
  miterLimit: number;
  lineWidth: number;
  strokeStyle: string | unknown;
  fillStyle: string | unknown;
  measureText(text: string): { width: number };
  strokeText(text: string, x: number, y: number): void;
  fillText(text: string, x: number, y: number): void;
}

/**
 * Draw the caption for clip-relative time tRelSec onto ctx. The canvas size
 * is the frame size. Does not clear the canvas — callers own that.
 */
export function drawCaptions(
  ctx: CaptionCtx,
  relWords: Word[],
  tRelSec: number,
  styleKey: string,
): void {
  const style = resolveCaptionStyle(styleKey);
  if (!style) return;
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const measure: MeasureFn = (text, font) => {
    ctx.font = font;
    return ctx.measureText(text).width;
  };
  const ops = planCaptionFrame(relWords, tRelSec, style, W, H, measure);
  if (ops.length === 0) return;

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  for (const op of ops) {
    ctx.font = op.font;
    if (op.stroke !== null) {
      ctx.lineWidth = op.strokeWidth;
      ctx.strokeStyle = op.stroke;
      ctx.strokeText(op.text, op.x, op.y);
    }
    ctx.fillStyle = op.fill;
    ctx.fillText(op.text, op.x, op.y);
  }
}

/**
 * The entry point both callers use. Takes absolute (source) word timings, the
 * clip window, and the absolute frame time. Filters, shifts and draws.
 * `none`/unknown styles and empty transcripts draw nothing.
 */
export function drawClipCaptions(
  ctx: CaptionCtx,
  absWords: Word[],
  win: { startSec: number; endSec: number },
  tAbsSec: number,
  styleKey: string,
): void {
  if (!resolveCaptionStyle(styleKey) || absWords.length === 0) return;
  const rel = clipWordsRelative(absWords, win.startSec, win.endSec);
  if (rel.length === 0) return;
  drawCaptions(ctx, rel, relativeCaptionTime(tAbsSec, win.startSec), styleKey);
}
