/**
 * Frame-accurate scrub + in/out marking (SPEC §3 step 4, §16 Phase 1
 * "in/out scrub UI"). Every scrub position decodes a real frame from the
 * demux worker (decode-on-scrub) — no proxy track, no <video> element:
 * the source lives in OPFS, and `demux.frameAt` does keyframe-seek +
 * sequential decode so any frame is exact.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getDemuxClient } from '../app/workers';
import type { ClipSpec, SourceMeta } from '../core/types';

export interface ClipPreviewProps {
  source: SourceMeta;
  clip: ClipSpec;
  onCut: (startSec: number, endSec: number) => void;
}

const MIN_CUT_SEC = 0.2;

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

export default function ClipPreview({ source, clip, onCut }: ClipPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [scrubSec, setScrubSec] = useState(() => clip.sourceStartSec);
  const [decodeErr, setDecodeErr] = useState<string | null>(null);
  const requestToken = useRef(0);

  const inSec = clip.sourceStartSec;
  const outSec = clip.sourceEndSec;

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
        frame.close();
        frame = null;
      } catch (err) {
        if (token !== requestToken.current) return;
        setDecodeErr(err instanceof Error ? err.message : String(err));
      } finally {
        if (frame && token !== requestToken.current) frame.close();
      }
    })();
  }, [scrubSec, source.width, source.height]);

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
        <canvas ref={canvasRef} className="preview__canvas" />
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
      </div>
    </section>
  );
}
