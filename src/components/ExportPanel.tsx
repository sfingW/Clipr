/**
 * Export panel: format/preset controls, progress, download (SPEC §8.10,
 * §20 failure surfacing). Renders from the store: `progress` while the
 * render pipeline runs, `error` for §20 states, and the completed-blob URL
 * handed down by App after a successful export.
 */
import { useAppStore } from '../app/store';
import type { ClipSpec, SourceMeta } from '../core/types';

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

  const cutLen = clip.sourceEndSec - clip.sourceStartSec;
  const cutValid = cutLen >= 0.2 && clip.sourceEndSec <= source.durationSec + 0.001;
  const rendering = progress !== null && progress.stage === 'rendering';

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
        Captions and speaker tracking arrive in a later phase (see SPEC §21) — this is the
        frame-accurate cutter.
      </p>

      <div className="export__actions">
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
