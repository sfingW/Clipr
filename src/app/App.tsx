/**
 * Clipr — Phase 1 shell (SPEC §16 build order: file drop → OPFS write →
 * mp4box metadata → WebCodecs decode → in/out scrub UI → export via
 * WebCodecs + mp4box mux; FFmpeg fallback §8.11 on codec gaps).
 *
 * All async flows set `jobState` through the §10 machine (guarded in the
 * store) and surface §20 failures via `error` — never an unhandled rejection.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import DropZone from '../components/DropZone';
import ClipPreview from '../components/ClipPreview';
import ExportPanel from '../components/ExportPanel';
import TranscriptPane from '../components/TranscriptPane';
import CandidateList from '../components/CandidateList';
import ModelStatus from '../components/ModelStatus';
import { useAppStore } from './store';
import { ingestFile, resumeFromOpfs, IngestError, type OpenedJob } from '../pipeline/ingest';
import { renderClipToBlob, isCodecUnsupported, type RenderProgress } from '../pipeline/render';
import { renderClipViaFfmpeg } from '../pipeline/ffmpegFallback';
import { listJobs, removeJob } from '../core/opfs';
import type { ClipSpec, SourceMeta } from '../core/types';

function wholeFileClip(source: SourceMeta): ClipSpec {
  return {
    id: crypto.randomUUID(),
    sourceStartSec: 0,
    sourceEndSec: source.durationSec,
    crop: [],
    captionStyleId: 'bold-center',
    captions: [],
    format: 'original',
    exportPreset: '1080p',
  };
}

export default function App() {
  const jobState = useAppStore((s) => s.jobState);
  const source = useAppStore((s) => s.source);
  const clip = useAppStore((s) => s.clips.find((c) => c.id === s.activeClipId) ?? null);
  const setJobState = useAppStore((s) => s.setJobState);
  const setSource = useAppStore((s) => s.setSource);
  const setClips = useAppStore((s) => s.setClips);
  const setActiveClip = useAppStore((s) => s.setActiveClip);
  const setProgress = useAppStore((s) => s.setProgress);
  const setError = useAppStore((s) => s.setError);
  const setCut = useAppStore((s) => s.setCut);

  const [resumeIds, setResumeIds] = useState<string[]>([]);
  const [bgWarning, setBgWarning] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);

  const closeRef = useRef<(() => Promise<void>) | null>(null);
  const fileRef = useRef<File | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const busy = jobState === 'ingesting' || jobState === 'rendering' || jobState === 'exporting';

  const adoptOpened = useCallback(
    (opened: OpenedJob): void => {
      closeRef.current?.();
      closeRef.current = opened.close;
      fileRef.current = opened.file;
      jobIdRef.current = opened.jobId;
      const next = wholeFileClip(opened.source);
      setSource(opened.source);
      setClips([next]);
      setActiveClip(next.id);
      setProgress(null);
      setError(null);
      setJobState('ingesting_done');
      setJobState('ready');
    },
    [setSource, setClips, setActiveClip, setProgress, setError, setJobState],
  );

  const handleFiles = useCallback(
    (files: File[]): void => {
      const file = files[0];
      if (!file || busy) return;
      setError(null);
      setResultUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      setJobState('ingesting');
      setProgress({ stage: 'ingest', pct: 0, note: 'starting' });
      void ingestFile(file, {
        onProgress: (pct, note) => setProgress({ stage: 'ingest', pct, note }),
      })
        .then(adoptOpened)
        .catch((err: unknown) => {
          setProgress(null);
          setJobState('idle');
          setError(
            err instanceof IngestError
              ? err.message
              : `Ingest failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    },
    [busy, adoptOpened, setJobState, setProgress, setError],
  );

  /** WebCodecs first, FFmpeg fallback on codec rejection (SPEC §8.11). */
  const runRender = useCallback(
    async (spec: ClipSpec, src: SourceMeta): Promise<Blob> => {
      const onProgress = (p: RenderProgress): void => {
        setProgress({ stage: 'rendering', pct: p.pct, note: p.note, etaSec: p.etaSec });
      };
      try {
        return await renderClipToBlob(spec, src, onProgress);
      } catch (err) {
        if (isCodecUnsupported(err)) {
          onProgress({ pct: 0, stage: 'rendering', note: 'webcodecs unsupported — ffmpeg fallback' });
          return renderClipViaFfmpeg(spec, src, (p) => onProgress({ ...p, stage: 'rendering' }));
        }
        throw err;
      }
    },
    [setProgress],
  );

  const handleExport = useCallback((): void => {
    if (!source || !clip || busy) return;
    const current = useAppStore.getState().jobState;
    if (current === 'done') setJobState('ready');
    setJobState('rendering');
    setError(null);
    setProgress({ stage: 'rendering', pct: 0, note: 'starting' });
    void runRender(clip, source)
      .then((blob) => {
        setJobState('exporting');
        setResultUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return URL.createObjectURL(blob);
        });
        setProgress(null);
        setJobState('done');
      })
      .catch((err: unknown) => {
        // §20: keep intermediates (source stays in OPFS), offer the raw file.
        setProgress(null);
        setJobState('ready');
        setError(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  }, [source, clip, busy, runRender, setJobState, setProgress, setError]);

/** Start over with a different file — closes the demux session and drops
 * the stored source (deliberate switch, not a §20 failure: no keep needed). */
  const handleOpenAnother = useCallback((): void => {
    if (busy) return;
    void closeRef.current?.();
    closeRef.current = null;
    fileRef.current = null;
    const oldJob = jobIdRef.current;
    jobIdRef.current = null;
    setResultUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setSource(null);
    setClips([]);
    setActiveClip(null);
    setProgress(null);
    setError(null);
    setJobState('idle');
    void (async () => {
      if (oldJob) await removeJob(oldJob).catch(() => undefined);
      setResumeIds(await listJobs());
    })();
  }, [busy, setSource, setClips, setActiveClip, setProgress, setError, setJobState]);

  const handleDownloadRaw = useCallback((): void => {
    const file = fileRef.current;
    if (!file) return;
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }, []);

  // §20 — reload-resume: OPFS persists across reloads, the worker session does not.
  useEffect(() => {
    void listJobs().then((ids) => setResumeIds(ids));
  }, []);

  const resumeFirst = useCallback((): void => {
    const [jobId] = resumeIds;
    if (!jobId) return;
    setError(null);
    setJobState('ingesting');
    setProgress({ stage: 'ingest', pct: 50, note: 'resuming' });
    void resumeFromOpfs(jobId)
      .then(adoptOpened)
      .catch((err: unknown) => {
        setProgress(null);
        setJobState('idle');
        setError(err instanceof Error ? err.message : String(err));
      });
  }, [resumeIds, adoptOpened, setJobState, setProgress, setError]);

  const discardStored = useCallback((): void => {
    void Promise.all(resumeIds.map((id) => removeJob(id))).then(() => setResumeIds([]));
  }, [resumeIds]);

  // §20 — backgrounded tab warning while rendering (mobile may pause).
  useEffect(() => {
    const onVis = (): void => {
      const rendering = useAppStore.getState().jobState === 'rendering';
      if (document.visibilityState === 'hidden' && rendering) {
        setBgWarning('Tab is in the background — some mobile browsers pause rendering here.');
      } else {
        setBgWarning(null);
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const banners = (
    <>
      {resumeIds.length > 0 && !source ? (
        <div className="banner banner--resume" role="alert">
          <span>Unfinished job stored in this browser — resume it?</span>
          <button type="button" className="btn" onClick={resumeFirst}>
            Resume
          </button>
          <button type="button" className="btn btn--ghost" onClick={discardStored}>
            Discard
          </button>
        </div>
      ) : null}
      {bgWarning ? (
        <div className="banner banner--warn" role="status">
          {bgWarning}
        </div>
      ) : null}
    </>
  );

  if (!source) {
    return (
      <main className="app app--drop">
        {banners}
        <DropZone onFiles={handleFiles} disabled={busy} />
        <footer className="app__footer">
          <ModelStatus />
          <span className="app__footnote">Runs fully in your browser — no uploads.</span>
        </footer>
      </main>
    );
  }

  return (
    <main className="app app--edit">
      {banners}
      <header className="app__header">
        <h1 className="app__title">Clipr</h1>
        <div className="app__header-actions">
          <ModelStatus />
          <button
            type="button"
            className="btn btn--ghost"
            onClick={handleOpenAnother}
            disabled={busy}
          >
            Open another file
          </button>
        </div>
      </header>
      <div className="app__grid">
        <div className="app__main-col">
          {clip ? <ClipPreview source={source} clip={clip} onCut={setCut} /> : null}
        </div>
        <div className="app__side-col">
          {clip ? (
            <ExportPanel
              source={source}
              clip={clip}
              onExport={handleExport}
              onDownloadRaw={handleDownloadRaw}
              busy={busy}
              resultUrl={resultUrl}
            />
          ) : null}
          <TranscriptPane />
          <CandidateList />
        </div>
      </div>
    </main>
  );
}
