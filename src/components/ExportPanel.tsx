/**
 * Export panel: format/preset controls, progress, download (SPEC §8.10,
 * §20 failure surfacing). Renders from the store: `progress` while the
 * render pipeline runs, `error` for §20 states, and the completed-blob URL
 * handed down by App after a successful export.
 */
import { useState } from 'react';
import { useAppStore } from '../app/store';
import type { ClipSpec, SourceMeta } from '../core/types';
import { runAutoReframe } from '../pipeline/reframeRun';

/** Auto-Reframe tracks slower on long ranges; ask before starting above this. */
export const REFRAME_LONG_SEC = 60;

export interface ExportPanelProps {
  source: SourceMeta;
  clip: ClipSpec;
  onExport: () => void;
  onDownloadRaw: () => void;
  busy: boolean;
  resultUrl: string | null;
}

function downloadName(clip: ClipSpec, source: SourceMeta): string {
  const base = source.fileName.replace(/\.[^.]+$/, '');
  return `${base}_${clip.sourceStartSec.toFixed(2)}-${clip.sourceEndSec.toFixed(2)}s.mp4`;
}

export default function ExportPanel({
  source,
  clip,
  onExport,
  onDownloadRaw,
  busy,
  resultUrl,
}: ExportPanelProps) {
  const format = clip.format;
  const preset = clip.exportPreset;
  const progress = useAppStore((s) => s.progress);
  const error = useAppStore((s) => s.error);
  const setError = useAppStore((s) => s.setError);
  const setFormat = useAppStore((s) => s.setFormat);
  const setExportPreset = useAppStore((s) => s.setExportPreset);
  const setCrop = useAppStore((s) => s.setCrop);
  const [reframing, setReframing] = useState(false);
  const [reframeNote, setReframeNote] = useState<string | null>(null);
  const [confirmLong, setConfirmLong] = useState(false);
  const setReframeBusy = useAppStore((s) => s.setReframeBusy);
  const asrBusy = useAppStore((s) => s.asr.phase === 'loading' || s.asr.phase === 'running');

  const cutLen = clip.sourceEndSec - clip.sourceStartSec;
  const cutValid = cutLen >= 0.2 && clip.sourceEndSec <= source.durationSec + 0.001;
  const rendering = progress !== null && progress.stage === 'rendering';
  const longClip = cutLen > REFRAME_LONG_SEC;

  /** Face-track the active In/Out range (SPEC §8.8) and switch to a vertical crop. */
  const runReframe = async (): Promise<void> => {
    const clipId = clip.id;
    setConfirmLong(false);
    setReframing(true);
    setReframeBusy(true);
    setReframeNote(null);
    try {
      const out = await runAutoReframe(clip, source);
      // Apply only if the same clip is still active when the analysis finishes.
      if (useAppStore.getState().activeClipId === clipId) {
        setCrop(out.crop);
        setFormat('vertical');
      }
      const positions = new Set(out.crop.map((k) => k.x)).size;
      setReframeNote(
        out.crop.length > 0
          ? `Auto-reframe: following the speaker across ${positions} crop position${positions === 1 ? '' : 's'}.`
          : (out.note ?? 'Auto-reframe: center crop.'),
      );
    } finally {
      setReframing(false);
      setReframeBusy(false);
    }
  };

  /** Clips over the limit need an explicit confirmation before tracking starts. */
  const onAutoReframeClick = (): void => {
    if (longClip) setConfirmLong(true);
    else void runReframe();
  };

  return (
    <section className="export" aria-label="Export">
      <div className="export__row">
        <div className="export__field">
          <span className="export__label">Format</span>
          <div className="segmented" role="group" aria-label="Format">
            <button
              type="button"
              className={`segmented__btn${format === 'original' ? ' is-active' : ''}`}
              onClick={() => setFormat('original')}
              disabled={busy}
            >
              Original
            </button>
            <button
              type="button"
              className={`segmented__btn${format === 'vertical' ? ' is-active' : ''}`}
              onClick={() => setFormat('vertical')}
              disabled={busy}
            >
              Vertical 9:16
            </button>
          </div>
        </div>

        <div className="export__field">
          <span className="export__label">Preset</span>
          <select
            value={preset}
            onChange={(e) => setExportPreset(e.target.value as '1080p' | '720p')}
            disabled={busy}
            aria-label="Export preset"
          >
            <option value="1080p">1080p</option>
            <option value="720p">720p</option>
          </select>
        </div>

        <div className="export__field export__field--meta">
          <span className="export__label">Cut</span>
          <span className="export__meta">
            {cutLen.toFixed(2)}s · {source.width}×{source.height} @ {source.frameRate.toFixed(2)}fps
          </span>
        </div>
      </div>

      <p className="export__note">
        Captions come from the transcript and are drawn the same way in the preview and the
        export. Auto-Reframe follows the speaker in the vertical crop; with no face found, the
        crop is centered.
      </p>

      <div className="export__actions">
        <button
          type="button"
          className="btn btn--ghost"
          onClick={onAutoReframeClick}
          disabled={busy || reframing || rendering || !cutValid || asrBusy || confirmLong}
          title={asrBusy ? 'Available when transcription finishes' : undefined}
        >
          {reframing ? 'Tracking faces…' : 'Auto-Reframe'}
        </button>
        <button
          type="button"
          className="btn btn--primary"
          onClick={onExport}
          disabled={busy || !cutValid}
        >
          {busy ? 'Exporting…' : 'Export clip'}
        </button>
        {resultUrl ? (
          <a
            className="btn btn--success"
            href={resultUrl}
            download={downloadName(clip, source)}
          >
            Download MP4
          </a>
        ) : null}
      </div>

      {asrBusy && !reframing ? (
        <p className="export__note" role="status">
          Auto-Reframe is available when transcription finishes.
        </p>
      ) : null}

      {confirmLong ? (
        <div className="export__note" role="alertdialog" aria-label="Confirm Auto-Reframe">
          <p>Auto-Reframe works best on clips under 60s. Processing may take a long time.</p>
          <div className="export__actions">
            <button type="button" className="btn btn--primary" onClick={() => void runReframe()}>
              Track anyway
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => setConfirmLong(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {reframeNote ? (
        <p className="export__note" role="status">
          {reframeNote}
        </p>
      ) : null}

      {rendering && progress ? (
        <div
          className="export__progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress.pct ?? 0)}
        >
          <div className="export__bar" style={{ width: `${Math.round(progress.pct ?? 0)}%` }} />
          <span className="export__progress-text">
            {Math.round(progress.pct ?? 0)}%
            {progress.note ? ` · ${progress.note}` : ''}
            {progress.done !== undefined && progress.total !== undefined
              ? ` · ${progress.done}/${progress.total}`
              : ''}
            {progress.etaSec ? ` · ~${Math.ceil(progress.etaSec)}s left` : ''}
          </span>
        </div>
      ) : null}

      {error ? (
        <div className="export__error" role="alert">
          <span>{error}</span>
          <span className="export__error-actions">
            <button type="button" className="btn btn--ghost" onClick={onDownloadRaw}>
              Download original
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => setError(null)}>
              Dismiss
            </button>
          </span>
        </div>
      ) : null}
    </section>
  );
}
