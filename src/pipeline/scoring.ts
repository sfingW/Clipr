/**
 * Scoring (SPEC §8.6): the LLM scores pre-built candidate windows with a fixed
 * prompt. It never writes clips or summaries.
 *
 * This module is pure apart from `runScoring`, which is the main-thread
 * orchestration (job states, candidate list, degradation). It deliberately
 * does NOT import WebLLM or the worker, so the prompt and the JSON parsing can
 * be unit tested in Node. The worker imports from here for the same logic.
 */
import { useAppStore, type AppStore } from '../app/store';
import type { RpcClient, LlmWorker } from '../core/rpc';
import type { Candidate, SourceMeta } from '../core/types';
import { chunkTranscript } from './chunking';

export const SCORE_TEMPERATURE = 0.2;
export const RETRY_TEMPERATURE = 0;
export const MAX_TOKENS = 60;
/** SPEC §8.6: after scoring, keep the top 8 by default. */
export const TOP_N = 8;
/** Used when the model's output cannot be read even after the retry. */
export const DEFAULT_SCORE = 5;
export const MAX_REASON_WORDS = 12;
/**
 * Context window for the scoring engine. A window is ~40 s of speech (≈150
 * tokens) plus the prompt and a 60-token reply, so 1024 is ample. The model's
 * default (4096) makes the KV cache too big for the GPU memory budget.
 */
export const LLM_CONTEXT_WINDOW = 1024;
/** Per-window limit for one `chat.completions.create` call. */
export const WINDOW_TIMEOUT_MS = 10_000;

/** Thrown by `withTimeout` when the call does not settle in time. */
export class ScoreTimeoutError extends Error {
  constructor(ms: number) {
    super(`score timeout after ${ms}ms`);
    this.name = 'ScoreTimeoutError';
  }
}

export function isScoreTimeout(err: unknown): boolean {
  return err instanceof ScoreTimeoutError;
}

/**
 * Race `p` against a timer. On timeout, `onTimeout` runs (the worker uses it to
 * interrupt the stuck generation) and the promise rejects with ScoreTimeoutError.
 * A late settlement of `p` is ignored.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new ScoreTimeoutError(ms));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Prompt template from SPEC §8.6 — "final, do not soften". Only {text} varies. */
export function buildScoringPrompt(text: string): string {
  return [
    'Rate how well the following transcript window would work as a',
    'standalone vertical short (1–10).',
    '',
    'Criteria:',
    '- strong opening hook in the first 3 seconds',
    '- self-contained: makes sense without prior context',
    '- has an emotional, insight, or humor payoff',
    '- does not start mid-sentence or leave setup unresolved',
    '',
    'Return strict JSON only: {"score": <1-10>, "reason": "<12 words max>"}',
    '',
    'WINDOW:',
    `"${text}"`,
  ].join('\n');
}

export interface ParsedScore {
  score: number;
  reason: string;
}

export interface ScoreResult extends ParsedScore {
  /** False when the default score was used because the output was unreadable. */
  parsed: boolean;
}

function clampScore(n: number): number {
  return Math.min(10, Math.max(1, Math.round(n)));
}

function capWords(text: string, max: number): string {
  const words = text.trim().split(/\s+/).filter((w) => w.length > 0);
  return words.slice(0, max).join(' ');
}

/**
 * Lenient parse of a model reply. Takes the span from the first `{` to the
 * last `}` (so prose or a code fence around the JSON is fine), then falls back
 * to a `"score": N` pattern when the JSON itself is broken. Score is clamped to
 * 1–10 and rounded; reason is capped at 12 words. Returns null when no score
 * can be found at all.
 */
export function parseScore(raw: string): ParsedScore | null {
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try {
      const obj = JSON.parse(raw.slice(first, last + 1)) as { score?: unknown; reason?: unknown };
      const n = typeof obj.score === 'string' ? Number(obj.score) : obj.score;
      if (typeof n === 'number' && Number.isFinite(n)) {
        return {
          score: clampScore(n),
          reason: typeof obj.reason === 'string' ? capWords(obj.reason, MAX_REASON_WORDS) : '',
        };
      }
    } catch {
      // fall through to the pattern fallback
    }
  }
  const m = /"?score"?\s*[:=]\s*"?(-?\d+(?:\.\d+)?)/i.exec(raw);
  if (m) {
    const reasonMatch = /"?reason"?\s*[:=]\s*"([^"]*)"/i.exec(raw);
    return {
      score: clampScore(Number(m[1])),
      reason: reasonMatch ? capWords(reasonMatch[1], MAX_REASON_WORDS) : '',
    };
  }
  return null;
}

/** One generation call. Errors from the engine (not parse failures) propagate. */
export type GenerateFn = (prompt: string, temperature: number) => Promise<string>;

export interface ScoreOptions {
  /** Per-call limit. Defaults to WINDOW_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Called when a call times out, e.g. to interrupt the engine. */
  onTimeout?: () => void;
}

/**
 * Score one window (SPEC §8.6): temperature 0.2, then one retry at 0 if the
 * reply is unreadable, then the default score of 5. A timed-out call returns the
 * default at once (no retry, so a stalled window cannot double its wait). Other
 * engine errors propagate, so the caller can degrade the whole run.
 */
export async function scoreWithRetry(
  generate: GenerateFn,
  text: string,
  opts: ScoreOptions = {},
): Promise<ScoreResult> {
  const prompt = buildScoringPrompt(text);
  const timeoutMs = opts.timeoutMs ?? WINDOW_TIMEOUT_MS;
  for (const temperature of [SCORE_TEMPERATURE, RETRY_TEMPERATURE]) {
    let raw: string;
    try {
      raw = await withTimeout(generate(prompt, temperature), timeoutMs, opts.onTimeout);
    } catch (err) {
      if (isScoreTimeout(err)) {
        return { score: DEFAULT_SCORE, reason: 'Scoring timed out; default score.', parsed: false };
      }
      throw err;
    }
    const parsed = parseScore(raw);
    if (parsed) return { ...parsed, parsed: true };
  }
  return { score: DEFAULT_SCORE, reason: 'Model reply unreadable; default score.', parsed: false };
}

/**
 * Best-first ordering. Unscored candidates sort last; ties keep the earlier
 * start. `topN` trims the list (SPEC §8.6), pass Infinity to keep all.
 */
export function rankCandidates(candidates: Candidate[], topN: number = TOP_N): Candidate[] {
  const key = (c: Candidate): number => (c.score ?? Number.NEGATIVE_INFINITY);
  return [...candidates]
    .sort((a, b) => key(b) - key(a) || a.startSec - b.startSec)
    .slice(0, topN);
}

// ---------------------------------------------------------------------------
// Orchestration (main thread)
// ---------------------------------------------------------------------------

export interface ScoringDeps {
  /** Download/initialise the model. Resolves when it is ready to score. */
  loadModel: (onProgress: (pct: number, note?: string) => void) => Promise<void>;
  /** Score every candidate. `onProgress` is called after each one. */
  score: (
    candidates: Candidate[],
    onProgress: (done: number, total: number) => void,
  ) => Promise<Candidate[]>;
}

/** Load and idle timeouts. The first load downloads hundreds of MB, so these are generous. */
const LLM_IDLE_TIMEOUT_MS = 300_000;

/** Production dependencies: the real LLM worker behind its RPC client. */
export function defaultScoringDeps(llm: () => RpcClient<LlmWorker>): ScoringDeps {
  return {
    loadModel: (onProgress) =>
      llm()
        .request(
          'llm.load',
          { tier: 'full' },
          {
            timeoutMs: LLM_IDLE_TIMEOUT_MS,
            resetOnProgress: true,
            onProgress: (p) => onProgress(p.pct, p.note),
          },
        )
        .then(() => undefined),
    score: (candidates, onProgress) =>
      llm().request(
        'llm.score',
        { candidates },
        {
          timeoutMs: LLM_IDLE_TIMEOUT_MS,
          resetOnProgress: true,
          onProgress: (p) => {
            if (p.stage === 'scoring' && p.done !== undefined) {
              onProgress(p.done, p.total ?? candidates.length);
            }
          },
        },
      ),
  };
}

/** Turn a model failure into a short, user-facing sentence (no raw engine text). */
export function describeLlmError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/WEBGPU_UNAVAILABLE|webgpu/i.test(msg)) {
    return 'AI features need WebGPU, which this browser does not have. Showing unscored clips.';
  }
  if (/out of memory|device.*lost|allocation failed/i.test(msg)) {
    return 'Not enough GPU memory for the AI model on this device. Showing unscored clips.';
  }
  if (/failed to fetch|networkerror|load failed|\b(4\d\d|5\d\d)\b/i.test(msg)) {
    return 'Could not download the AI model. Check your connection and try again. Showing unscored clips.';
  }
  return 'AI scoring failed. Showing unscored clips.';
}

/** Unscored fallback: every window, in timeline order. */
function unscoredInOrder(candidates: Candidate[]): Candidate[] {
  return [...candidates].sort((a, b) => a.startSec - b.startSec);
}

/**
 * Run AI scoring for the open source. Never rejects. Job-state path (SPEC §10):
 *   ready → llm_loading → scoring → candidates_ready → ready
 * Degrades on failure: the unscored windows are listed, and the job still
 * ends at `ready`. Results only apply while the same source is still open.
 */
export async function runScoring(
  source: SourceMeta,
  deps: ScoringDeps,
  store: { getState: () => AppStore } = useAppStore,
): Promise<void> {
  const s = () => store.getState();
  const isCurrent = (): boolean => s().source?.id === source.id;
  const advance = (to: Parameters<AppStore['setJobState']>[0]): void => {
    if (isCurrent()) s().setJobState(to); // setJobState rejects illegal edges
  };
  const patchLlm = (patch: Parameters<AppStore['setLlm']>[0]): void => {
    if (isCurrent()) s().setLlm(patch);
  };
  const finish = (list: Candidate[]): void => {
    if (!isCurrent()) return;
    s().setCandidates(list);
    advance('candidates_ready');
    advance('ready');
  };

  const transcript = s().transcript;
  if (!isCurrent() || !transcript || s().webgpu !== 'available') return;
  if (s().jobState !== 'ready' && s().jobState !== 'candidates_ready') return;

  const windows = chunkTranscript(transcript);
  advance('llm_loading');
  if (!isCurrent() || s().jobState !== 'llm_loading') return;
  patchLlm({ phase: 'loading', pct: 0, note: 'Preparing AI model', error: null, done: undefined, total: undefined });

  try {
    await deps.loadModel((pct, note) => patchLlm({ phase: 'loading', pct, note: note ?? 'Downloading AI model' }));
  } catch (err) {
    if (!isCurrent()) return;
    console.warn('[clipr] AI scoring unavailable:', err);
    patchLlm({ phase: 'failed', error: describeLlmError(err), note: null });
    finish(unscoredInOrder(windows));
    return;
  }

  if (windows.length === 0) {
    patchLlm({ phase: 'ready', pct: 100, note: null, error: null });
    finish([]);
    return;
  }

  try {
    const scored = await deps.score(windows, (done, total) => {
      if (!isCurrent()) return;
      if (s().jobState === 'llm_loading') advance('scoring');
      patchLlm({ phase: 'scoring', pct: total > 0 ? (done / total) * 100 : 0, done, total, note: null });
    });
    if (!isCurrent()) return;
    patchLlm({ phase: 'ready', pct: 100, note: null, error: null, done: undefined, total: undefined });
    finish(rankCandidates(scored, TOP_N));
  } catch (err) {
    if (!isCurrent()) return;
    console.warn('[clipr] AI scoring failed:', err);
    patchLlm({ phase: 'failed', error: describeLlmError(err), note: null, done: undefined, total: undefined });
    finish(unscoredInOrder(windows));
  }
}
