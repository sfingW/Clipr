/**
 * Transcript pane (SPEC §3 step 3, §8.4). Shows ASR progress, a non-blocking
 * failure notice, and the transcript as clickable words:
 *  - click a word → the shared playhead moves to its start (ClipPreview seeks);
 *  - the word under the playhead is highlighted and kept in view.
 *
 * Highlight follows the playhead (scrub position), not a media element: the app
 * has no <video> element yet, so true playback highlighting is a follow-up.
 *
 * Only the segment containing the active word re-renders as the playhead moves
 * (SegmentView is memoized and receives `activeIdx` only when it owns it).
 */
import { memo, useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useAppStore, type AsrStatus } from '../app/store';
import { activeWordIndex, groupWords, type SegmentGroup } from '../pipeline/transcript';
import type { Word } from '../core/types';

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

function statusLine(asr: AsrStatus): string {
  switch (asr.phase) {
    case 'loading':
      return `${asr.note ?? 'Loading'} · ${Math.round(asr.pct)}%`;
    case 'running':
      return `Transcribing · ${Math.round(asr.pct)}%`;
    default:
      return '';
  }
}

interface SegmentViewProps {
  words: readonly Word[];
  group: SegmentGroup;
  /** Active word index if it belongs to this segment, otherwise -1. */
  activeIdx: number;
  onSeek: (sec: number) => void;
}

const SegmentView = memo(function SegmentView({ words, group, activeIdx, onSeek }: SegmentViewProps) {
  const activeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (activeIdx >= 0) activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  const items: ReactNode[] = [];
  for (let i = group.from; i < group.to; i++) {
    const w = words[i];
    const active = i === activeIdx;
    items.push(
      <button
        key={i}
        ref={active ? activeRef : undefined}
        type="button"
        className={active ? 'tword tword--active' : 'tword'}
        aria-current={active ? 'true' : undefined}
        title={`${fmt(w.start)}`}
        onClick={() => onSeek(w.start)}
      >
        {w.text}
      </button>,
      ' ',
    );
  }
  return (
    <p className="transcript__segment">
      <button type="button" className="transcript__time" onClick={() => onSeek(group.segment.start)}>
        {fmt(group.segment.start)}
      </button>
      {items}
    </p>
  );
});

export default function TranscriptPane() {
  const transcript = useAppStore((s) => s.transcript);
  const asr = useAppStore((s) => s.asr);
  const reframeBusy = useAppStore((s) => s.reframeBusy);
  const playheadSec = useAppStore((s) => s.playheadSec);
  const setPlayhead = useAppStore((s) => s.setPlayhead);

  const words = transcript?.words ?? EMPTY_WORDS;
  const groups = useMemo(() => groupWords(words), [words]);
  const activeIdx = useMemo(() => activeWordIndex(words, playheadSec), [words, playheadSec]);
  const onSeek = useCallback((sec: number) => setPlayhead(sec), [setPlayhead]);

  const showWords = asr.phase === 'ready' && transcript !== null;
  const busy = asr.phase === 'loading' || asr.phase === 'running';

  return (
    <section className="transcript" aria-label="Transcript">
      <header className="transcript__header">
        <h2 className="transcript__title">Transcript</h2>
        {showWords ? <span className="transcript__count">{words.length} words</span> : null}
      </header>

      {busy ? (
        <div className="transcript__loading" role="status">
          <span>{statusLine(asr)}</span>
          <progress className="transcript__progress" max={100} value={Math.round(asr.pct)} />
        </div>
      ) : null}

      {reframeBusy ? (
        <div className="transcript__notice" role="status">
          Auto-Reframe is tracking faces on the active clip. Transcription runs independently.
        </div>
      ) : null}

      {asr.phase === 'failed' ? (
        <div className="transcript__notice" role="status">
          {asr.error ?? 'Transcription unavailable.'}
        </div>
      ) : null}

      {asr.phase === 'skipped' ? (
        <div className="transcript__notice" role="status">
          Transcription is off for this device tier. Cut manually.
        </div>
      ) : null}

      {asr.phase === 'idle' && !transcript ? (
        <p className="transcript__empty">The transcript appears here once the video is ready.</p>
      ) : null}

      {showWords && words.length === 0 ? (
        <p className="transcript__empty">No speech was detected in this video.</p>
      ) : null}

      {showWords && words.length > 0 ? (
        <div className="transcript__body">
          {groups.map((g) => (
            <SegmentView
              key={g.from}
              words={words}
              group={g}
              activeIdx={activeIdx >= g.from && activeIdx < g.to ? activeIdx : -1}
              onSeek={onSeek}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

const EMPTY_WORDS: readonly Word[] = [];
