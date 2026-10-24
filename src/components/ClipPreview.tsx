/**
 * Frame-accurate scrub + in/out marking (SPEC §3 step 4, §16 Phase 1
 * "in/out scrub UI"). Every scrub position decodes a real frame from the
 * demux worker (decode-on-scrub) — no proxy track, no <video> element:
 * the source lives in OPFS, and `demux.frameAt` does keyframe-seek +
 * sequential decode so any frame is exact.
 *
 * The position is the shared playhead (store `playheadSec`): the transcript
 * seeks it by clicking a word. Real playback is a follow-up (no media element).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getDemuxClient } from '../app/workers';
import { useAppStore } from '../app/store';
import { computeLayout } from '../core/renderLayout';
import type { ClipSpec, SourceMeta } from '../core/types';
import { CAPTION_STYLES, drawClipCaptions, type CaptionStyleKey } from '../pipeline/caption';

export interface ClipPreviewProps {
  source: SourceMeta;
  clip: ClipSpec;
  onCut: (startSec: number, endSec: number) => void;
}

const STYLE_OPTIONS: { value: CaptionStyleKey; label: string }[] = [
  { value: 'bold-center', label: CAPTION_STYLES['bold-center'].label },
  { value: 'karaoke', label: CAPTION_STYLES.karaoke.label },
  { value: 'none', label: 'None' },
];

const MIN_CUT_SEC = 0.2;

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

export default function ClipPreview({ source, clip, onCut }: ClipPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Caption overlay: sized to the export frame (outW×outH) and placed over the
  // crop rect, so what it draws lines up with the exported picture.
  const overlayRef = useRef<HTMLCanvasElement>(null);
  // The playhead lives in the store so the transcript can seek and highlight it.
  const scrubSec = useAppStore((s) => s.playheadSec);
  const setScrubSec = useAppStore((s) => s.setPlayhead);
  const setCaptionStyle = useAppStore((s) => s.setCaptionStyle);
  const words = useAppStore((s) => s.transcript?.words);
  const [decodeErr, setDecodeErr] = useState<string | null>(null);
  const requestToken = useRef(0);
  // Absolute source time of the last decoded frame — the caption overlay is
  // redrawn at this time when the style or transcript changes without a scrub.
  const lastFrameSec = useRef<number | null>(null);

  const inSec = clip.sourceStartSec;
  const outSec = clip.sourceEndSec;
  const layout = computeLayout(clip, source);

  const drawOverlay = useCallback(
    (tAbsSec: number | null): void => {
      const overlay = overlayRef.current;
      if (!overlay) return;
      if (overlay.width !== layout.outW) overlay.width = layout.outW;
      if (overlay.height !== layout.outH) overlay.height = layout.outH;
      const ctx = overlay.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      if (tAbsSec === null) return;
      drawClipCaptions(
        ctx,
        words ?? [],
        { startSec: clip.sourceStartSec, endSec: clip.sourceEndSec },
        tAbsSec,
        clip.captionStyleId,
      );
    },
    // layout values are primitives, so this is stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [words, clip.sourceStartSec, clip.sourceEndSec, clip.captionStyleId, layout.outW, layout.outH],
  );

  useEffect(() => {
    drawOverlay(lastFrameSec.current);
  }, [drawOverlay]);

  // Decode-on-scrub: latest request wins; superseded frames are closed by the
  // worker (collector swaps them out) or here if they arrived late.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const token = ++requestToken.current;
    let frame: VideoFrame | null = null;
    void (async () => {
      try {
        const res = await getDemuxClient().request('demux.frameAt', { tSec: scrubSec });
        if (token !== requestToken.current) {
          res.frame.close();
          return;
        }
        frame = res.frame;
        canvas.width = source.width;
        canvas.height = source.height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
          setDecodeErr(null);
        }
        // Same time base as export: the decoded frame's source pts.
        lastFrameSec.current = res.tSec;
        drawOverlay(res.tSec);
        frame.close();
        frame = null;
      } catch (err) {
        if (token !== requestToken.current) return;
        setDecodeErr(err instanceof Error ? err.message : String(err));
      } finally {
        if (frame && token !== requestToken.current) frame.close();
      }
    })();
  }, [scrubSec, source.width, source.height, drawOverlay]);

  const setIn = useCallback(() => {
    onCut(Math.min(scrubSec, outSec - MIN_CUT_SEC), outSec);
  }, [scrubSec, outSec, onCut]);

  const setOut = useCallback(() => {
    onCut(inSec, Math.max(scrubSec, inSec + MIN_CUT_SEC));
  }, [scrubSec, inSec, onCut]);

  // Keyboard: I = set in, O = set out (frame nudged by scrub position).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (e.key === 'i' || e.key === 'I') setIn();
      else if (e.key === 'o' || e.key === 'O') setOut();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setIn, setOut]);

  const step = 1 / Math.max(1, source.frameRate || 25);

  return (
    <section className="preview" aria-label="Clip preview">
      <div className="preview__stage">
        <div className="preview__frame">
        <canvas ref={canvasRef} className="preview__canvas" />
        <canvas
          ref={overlayRef}
          className="preview__captions"
          aria-hidden
          style={{
            left: `${(layout.sx / source.width) * 100}%`,
            top: `${(layout.sy / source.height) * 100}%`,
            width: `${(layout.sw / source.width) * 100}%`,
            height: `${(layout.sh / source.height) * 100}%`,
          }}
        />
        </div>
        {decodeErr ? <div className="preview__error">{decodeErr}</div> : null}
        <div
          className="preview__window"
          style={{
            left: `${(inSec / source.durationSec) * 100}%`,
            width: `${((outSec - inSec) / source.durationSec) * 100}%`,
          }}
          aria-hidden
        />
      </div>

      <div className="preview__transport">
        <span className="preview__time">{fmt(scrubSec)}</span>
        <input
          className="preview__scrub"
          type="range"
          min={0}
          max={source.durationSec}
          step={step}
          value={scrubSec}
          aria-label="Scrub"
          onChange={(e) => setScrubSec(Number(e.target.value))}
        />
        <span className="preview__time">{fmt(source.durationSec)}</span>
      </div>

      <div className="preview__cuts">
        <button type="button" className="btn" onClick={setIn}>
          Set in <kbd>I</kbd>
        </button>
        <span className="preview__cut-readout">
          {fmt(inSec)} → {fmt(outSec)} · {(outSec - inSec).toFixed(2)}s
        </span>
        <button type="button" className="btn" onClick={setOut}>
          Set out <kbd>O</kbd>
        </button>
        <label className="preview__captions-style">
          Captions
          <select
            value={clip.captionStyleId}
            onChange={(e) => setCaptionStyle(e.target.value)}
          >
            {STYLE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </section>
  );
}
