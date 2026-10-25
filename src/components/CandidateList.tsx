/**
 * Ranked clip candidates (SPEC §8.6, Phase 4).
 *
 * Shows the "Find Best Clips" action (whenever a transcript exists), the
 * model/scoring progress, and the candidate list sorted best-first. Clicking a
 * candidate sets the clip's In/Out to its window and moves the playhead there.
 *
 * AI runs on WebGPU when available, and on CPU otherwise or after a GPU
 * failure. The UI shows which engine is in use. The manual cutter is unaffected.
 */
import { getLlmDeps } from '../workers/llmClient';
import { useAppStore } from '../app/store';
import { runScoring } from '../pipeline/scoring';
import type { Candidate } from '../core/types';

const SNIPPET_WORDS = 18;

function fmtTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t - m * 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function snippet(text: string): string {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  return words.length > SNIPPET_WORDS ? `${words.slice(0, SNIPPET_WORDS).join(' ')}…` : words.join(' ');
}

/** Put the clip's In/Out on the candidate and move the playhead to its start. */
export function selectCandidateInClip(c: Candidate): void {
  const st = useAppStore.getState();
  st.setCut(c.startSec, c.endSec);
  st.setPlayhead(c.startSec);
  st.selectCandidate(c.id);
}

function CandidateItem({ c, selected }: { c: Candidate; selected: boolean }) {
  return (
    <li>
      <button
        type="button"
        className={`candidate${selected ? ' candidate--selected' : ''}`}
        onClick={() => selectCandidateInClip(c)}
        aria-pressed={selected}
      >
        <span className="candidate__head">
          <span className="candidate__score" aria-label={c.score !== undefined ? `score ${c.score} of 10` : 'not scored'}>
            {c.score !== undefined ? `${c.score}/10` : '—'}
          </span>
          <span className="candidate__time">
            {fmtTime(c.startSec)}–{fmtTime(c.endSec)}
          </span>
        </span>
        {c.reason ? <span className="candidate__reason">{c.reason}</span> : null}
        <span className="candidate__snippet">{snippet(c.text)}</span>
      </button>
    </li>
  );
}

export default function CandidateList() {
  const source = useAppStore((s) => s.source);
  const transcript = useAppStore((s) => s.transcript);
  const jobState = useAppStore((s) => s.jobState);
  const webgpu = useAppStore((s) => s.webgpu);
  const llm = useAppStore((s) => s.llm);
  const candidates = useAppStore((s) => s.candidates);
  const selectedId = useAppStore((s) => s.selectedCandidateId);

  if (!source) return null;

  const scoring = jobState === 'llm_loading' || jobState === 'scoring';
  const canFind = transcript !== null && (jobState === 'ready' || jobState === 'candidates_ready');

  const onFind = (): void => {
    if (!source) return;
    void runScoring(source, getLlmDeps(webgpu !== 'unavailable'));
  };

  return (
    <section className="candidates" aria-label="Clip candidates">
      <header className="candidates__header">
        <h2 className="candidates__title">Best clips</h2>
        {canFind ? (
          <button type="button" className="btn btn--primary" onClick={onFind} disabled={scoring}>
            Find Best Clips
          </button>
        ) : null}
      </header>

      {webgpu === 'unavailable' ? (
        <p className="candidates__notice" role="status">
          This browser has no WebGPU, so AI scoring will run on CPU (slower).
        </p>
      ) : null}

      {llm.engine === 'cpu' && (scoring || llm.phase === 'loading' || llm.phase === 'ready') ? (
        <p className="candidates__notice" role="status">
          AI engine: CPU (WASM).
        </p>
      ) : null}

      {scoring || llm.phase === 'loading' ? (
        <div className="candidates__progress" role="status">
          <span>
            {llm.phase === 'scoring' && llm.total !== undefined
              ? `Scoring clips ${llm.done ?? 0}/${llm.total}…`
              : `${llm.note ?? 'Loading AI model…'} ${Math.round(llm.pct)}%`}
          </span>
          <progress className="candidates__bar" max={100} value={Math.round(llm.pct)} />
        </div>
      ) : null}

      {llm.error ? (
        <p className="candidates__notice" role="status">
          {llm.error}
        </p>
      ) : null}

      {candidates.length > 0 ? (
        <ol className="candidates__list">
          {candidates.map((c) => (
            <CandidateItem key={c.id} c={c} selected={c.id === selectedId} />
          ))}
        </ol>
      ) : llm.phase === 'ready' || llm.phase === 'failed' ? (
        <p className="candidates__empty">No candidate windows were found in this transcript.</p>
      ) : !scoring && transcript === null ? (
        <p className="candidates__empty">Candidates appear once the transcript is ready.</p>
      ) : null}
    </section>
  );
}
