/**
 * Phase 4 scoring tests (SPEC §8.6, §10, §17): prompt, the lenient JSON parse
 * the LLM worker uses, the retry/default rules, ranking, and the main-thread
 * orchestration (job states, degradation, source guard). No WebLLM, no worker.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { INITIAL_LLM, useAppStore } from '../src/app/store';
import type { JobState } from '../src/core/jobMachine';
import type { Candidate, SourceMeta, Transcript, Word } from '../src/core/types';
import {
  DEFAULT_SCORE,
  MAX_REASON_WORDS,
  TOP_N,
  buildScoringPrompt,
  describeLlmError,
  parseScore,
  rankCandidates,
  runScoring,
  scoreWithRetry,
  type ScoringDeps,
} from '../src/pipeline/scoring';

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

describe('buildScoringPrompt', () => {
  it('embeds the window text and the strict JSON instruction from SPEC §8.6', () => {
    const p = buildScoringPrompt('the secret is patience');
    expect(p).toContain('"the secret is patience"');
    expect(p).toContain('Return strict JSON only: {"score": <1-10>, "reason": "<12 words max>"}');
    expect(p).toContain('standalone vertical short (1–10).');
    expect(p).toContain('strong opening hook in the first 3 seconds');
  });
});

// ---------------------------------------------------------------------------
// Lenient parse (the worker's JSON logic)
// ---------------------------------------------------------------------------

describe('parseScore: lenient JSON parse', () => {
  it('reads strict JSON', () => {
    expect(parseScore('{"score": 8, "reason": "Strong hook and clear payoff"}')).toEqual({
      score: 8,
      reason: 'Strong hook and clear payoff',
    });
  });

  it('finds the JSON inside prose or a code fence', () => {
    expect(parseScore('Sure! Here it is: {"score": 6, "reason": "Decent setup"} Hope that helps.')?.score).toBe(6);
    expect(parseScore('```json\n{"score": 4, "reason": "Starts mid-sentence"}\n```')?.score).toBe(4);
  });

  it('accepts a numeric string score', () => {
    expect(parseScore('{"score": "7", "reason": "ok"}')?.score).toBe(7);
  });

  it('clamps out-of-range scores to 1–10 and rounds fractions', () => {
    expect(parseScore('{"score": 15, "reason": "x"}')?.score).toBe(10);
    expect(parseScore('{"score": 0, "reason": "x"}')?.score).toBe(1);
    expect(parseScore('{"score": -3, "reason": "x"}')?.score).toBe(1);
    expect(parseScore('{"score": 6.6, "reason": "x"}')?.score).toBe(7);
  });

  it('caps the reason at 12 words and collapses whitespace', () => {
    const long = Array.from({ length: 20 }, (_, i) => `w${i}`).join('   ');
    const r = parseScore(`{"score": 5, "reason": "${long}"}`);
    expect(r?.reason.split(' ')).toHaveLength(MAX_REASON_WORDS);
    expect(r?.reason.startsWith('w0 w1 w2')).toBe(true);
  });

  it('uses an empty reason when the model omits it', () => {
    expect(parseScore('{"score": 9}')).toEqual({ score: 9, reason: '' });
  });

  it('falls back to a score pattern when the JSON is broken', () => {
    const r = parseScore('{"score": 7, "reason": "unterminated string');
    expect(r?.score).toBe(7);
  });

  it('returns null when there is no score at all', () => {
    expect(parseScore('I cannot rate this.')).toBeNull();
    expect(parseScore('{"rating": "high"}')).toBeNull();
    expect(parseScore('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Retry and default
// ---------------------------------------------------------------------------

describe('scoreWithRetry', () => {
  it('uses the first readable reply at temperature 0.2', async () => {
    const temps: number[] = [];
    const generate = async (_p: string, t: number): Promise<string> => {
      temps.push(t);
      return '{"score": 9, "reason": "Great"}';
    };
    const r = await scoreWithRetry(generate, 'window text');
    expect(r).toEqual({ score: 9, reason: 'Great', parsed: true });
    expect(temps).toEqual([0.2]);
  });

  it('retries once at temperature 0 when the reply is unreadable', async () => {
    const temps: number[] = [];
    const replies = ['no json here', '{"score": 3, "reason": "Weak opening"}'];
    const generate = async (_p: string, t: number): Promise<string> => {
      temps.push(t);
      return replies[temps.length - 1];
    };
    const r = await scoreWithRetry(generate, 'window text');
    expect(temps).toEqual([0.2, 0]);
    expect(r).toEqual({ score: 3, reason: 'Weak opening', parsed: true });
  });

  it('defaults to 5 when both attempts are unreadable', async () => {
    const generate = async (): Promise<string> => 'garbage';
    const r = await scoreWithRetry(generate, 'window text');
    expect(r.score).toBe(DEFAULT_SCORE);
    expect(DEFAULT_SCORE).toBe(5);
    expect(r.parsed).toBe(false);
  });

  it('lets engine errors propagate instead of defaulting', async () => {
    const generate = async (): Promise<string> => {
      throw new Error('out of memory');
    };
    await expect(scoreWithRetry(generate, 'window text')).rejects.toThrow('out of memory');
  });
});

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

const cand = (id: string, startSec: number, score?: number): Candidate => ({
  id,
  startSec,
  endSec: startSec + 10,
  text: id,
  source: score === undefined ? 'chunked' : 'scored',
  score,
});

describe('rankCandidates', () => {
  it('sorts best-first, ties by earlier start, unscored last', () => {
    const out = rankCandidates([
      cand('a', 30, 6),
      cand('b', 0, 9),
      cand('c', 10, 6),
      cand('d', 50),
    ]);
    expect(out.map((c) => c.id)).toEqual(['b', 'c', 'a', 'd']); // a and c tie at 6: earlier start (c, 10s) first
  });

  it('keeps the top 8 by default (SPEC §8.6)', () => {
    const many = Array.from({ length: 12 }, (_, i) => cand(`x${i}`, i * 15, i + 1));
    const out = rankCandidates(many);
    expect(out).toHaveLength(TOP_N);
    expect(TOP_N).toBe(8);
    expect(out[0].score).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

const SRC: SourceMeta = {
  id: 'src-1',
  opfsPath: 'job-1/source.mp4',
  fileName: 'a.mp4',
  durationSec: 60,
  width: 1920,
  height: 1080,
  videoCodec: 'avc1',
  audioCodec: 'mp4a.40.2',
  frameRate: 30,
  sizeBytes: 1,
};

/** 120 words over 60 s, a segment every 10 words (5 s): enough for several windows. */
function transcript(): Transcript {
  const words: Word[] = [];
  for (let i = 0; i < 120; i++) words.push({ text: `t${i}`, start: i * 0.5, end: i * 0.5 + 0.4 });
  const segments = [];
  for (let i = 0; i < 120; i += 10) {
    segments.push({ text: 'seg', start: words[i].start, end: words[i + 9].end });
  }
  return { language: 'en', words, segments };
}

function primeStore(overrides: Partial<ReturnType<typeof useAppStore.getState>> = {}): void {
  useAppStore.setState({
    tier: 'basic',
    jobState: 'ready' as JobState,
    source: SRC,
    transcript: transcript(),
    candidates: [],
    clips: [],
    activeClipId: null,
    llm: INITIAL_LLM,
    webgpu: 'available',
    selectedCandidateId: null,
    ...overrides,
  });
}

/** Records every job-state change so tests can check the exact path. */
function recordStates(): { states: JobState[]; stop: () => void } {
  const states: JobState[] = [];
  let last = useAppStore.getState().jobState;
  const unsub = useAppStore.subscribe((s) => {
    if (s.jobState !== last) {
      last = s.jobState;
      states.push(s.jobState);
    }
  });
  return { states, stop: unsub };
}

beforeEach(() => {
  useAppStore.setState({ jobState: 'idle', source: null, transcript: null, candidates: [], llm: INITIAL_LLM });
});

describe('runScoring: happy path', () => {
  it('goes ready → llm_loading → scoring → candidates_ready → ready and keeps the top scores', async () => {
    primeStore();
    const rec = recordStates();
    const deps: ScoringDeps = {
      loadModel: async (onProgress) => onProgress(50, 'downloading'),
      score: async (cands, onProgress) =>
        cands.map((c, i) => {
          onProgress(i + 1, cands.length);
          return { ...c, score: (i * 3) % 10 + 1, reason: `r${i}`, source: 'scored' as const };
        }),
    };
    await runScoring(SRC, deps);
    rec.stop();

    expect(rec.states).toEqual(['llm_loading', 'scoring', 'candidates_ready', 'ready']);
    const st = useAppStore.getState();
    expect(st.jobState).toBe('ready');
    expect(st.llm.phase).toBe('ready');
    expect(st.candidates.length).toBeLessThanOrEqual(TOP_N);
    const scores = st.candidates.map((c) => c.score ?? 0);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('does nothing when WebGPU is unavailable', async () => {
    primeStore({ webgpu: 'unavailable' });
    let called = false;
    await runScoring(SRC, {
      loadModel: async () => {
        called = true;
      },
      score: async (c) => c,
    });
    expect(called).toBe(false);
    expect(useAppStore.getState().jobState).toBe('ready');
  });

  it('does nothing without a transcript', async () => {
    primeStore({ transcript: null });
    let called = false;
    await runScoring(SRC, {
      loadModel: async () => {
        called = true;
      },
      score: async (c) => c,
    });
    expect(called).toBe(false);
  });
});

describe('runScoring: degradation (SPEC §8.6, §20)', () => {
  it('a model load failure lists the unscored windows and still ends at ready', async () => {
    primeStore();
    const rec = recordStates();
    await runScoring(SRC, {
      loadModel: async () => {
        throw new Error('Failed to fetch');
      },
      score: async (c) => c,
    });
    rec.stop();
    expect(rec.states).toEqual(['llm_loading', 'candidates_ready', 'ready']);
    const st = useAppStore.getState();
    expect(st.jobState).toBe('ready');
    expect(st.llm.phase).toBe('failed');
    expect(st.llm.error).toMatch(/Could not download the AI model/);
    expect(st.candidates.length).toBeGreaterThan(0);
    expect(st.candidates.every((c) => c.score === undefined)).toBe(true);
    const starts = st.candidates.map((c) => c.startSec);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });

  it('a scoring crash mid-run also falls back to unscored windows', async () => {
    primeStore();
    await runScoring(SRC, {
      loadModel: async () => undefined,
      score: async () => {
        throw new Error('worker error: Uncaught RuntimeError: out of memory');
      },
    });
    const st = useAppStore.getState();
    expect(st.jobState).toBe('ready');
    expect(st.llm.phase).toBe('failed');
    expect(st.llm.error).toMatch(/GPU memory/);
    expect(st.candidates.every((c) => c.score === undefined)).toBe(true);
  });

  it('shows an empty list (not an error) when the transcript yields no windows', async () => {
    primeStore({
      transcript: { language: 'en', words: [{ text: 'hi', start: 0, end: 0.4 }], segments: [] },
    });
    await runScoring(SRC, {
      loadModel: async () => undefined,
      score: async (c) => c,
    });
    const st = useAppStore.getState();
    expect(st.jobState).toBe('ready');
    expect(st.candidates).toEqual([]);
    expect(st.llm.phase).toBe('ready');
  });
});

describe('runScoring: source guard', () => {
  it('discards results when the user has opened another file mid-run', async () => {
    primeStore();
    await runScoring(SRC, {
      loadModel: async () => {
        // The user opens a different file while the model is loading.
        useAppStore.setState({
          source: { ...SRC, id: 'src-2' },
          jobState: 'ready',
          candidates: [],
          llm: INITIAL_LLM,
        });
      },
      score: async (c) => c,
    });
    const st = useAppStore.getState();
    expect(st.source?.id).toBe('src-2');
    expect(st.candidates).toEqual([]);
    expect(st.llm.phase).toBe('idle');
  });
});

describe('describeLlmError', () => {
  it('maps failures to short, user-facing sentences', () => {
    expect(describeLlmError(new Error('WEBGPU_UNAVAILABLE: no gpu'))).toMatch(/WebGPU/);
    expect(describeLlmError(new Error('device lost'))).toMatch(/GPU memory/);
    expect(describeLlmError(new Error('Failed to fetch'))).toMatch(/download/);
    expect(describeLlmError(new Error('something odd'))).toBe('AI scoring failed. Showing unscored clips.');
    expect(describeLlmError('plain string')).toBe('AI scoring failed. Showing unscored clips.');
  });
});
