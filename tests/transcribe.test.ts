import { beforeEach, describe, expect, it } from 'vitest';
import { INITIAL_ASR, useAppStore } from '../src/app/store';
import type { JobState } from '../src/core/jobMachine';
import type { SourceMeta, Transcript } from '../src/core/types';
import {
  describeAsrError,
  jobIdOf,
  runTranscription,
  type TranscribeDeps,
} from '../src/pipeline/transcribe';

const source = (id: string): SourceMeta => ({
  id,
  opfsPath: `job-${id}/source.mp4`,
  fileName: `${id}.mp4`,
  durationSec: 20,
  width: 1280,
  height: 720,
  videoCodec: 'avc1',
  audioCodec: 'mp4a.40.2',
  frameRate: 30,
  sizeBytes: 1000,
});

const transcript: Transcript = {
  language: 'en',
  words: [{ text: 'hello', start: 0.5, end: 1 }],
  segments: [{ start: 0.5, end: 1, text: 'hello' }],
} as Transcript;

function reset(): void {
  useAppStore.setState({
    tier: 'basic',
    jobState: 'idle',
    source: null,
    transcript: null,
    candidates: [],
    clips: [],
    activeClipId: null,
    progress: null,
    error: null,
    asr: INITIAL_ASR,
    playheadSec: 0,
  });
}

/** Mirror App.handleFiles → adoptOpened: a source is open and ingest is done. */
function openSource(s: SourceMeta): void {
  useAppStore.getState().setSource(s);
  useAppStore.getState().setJobState('ingesting');
  useAppStore.getState().setJobState('ingesting_done');
}

async function waitUntil(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !pred(); i++) await new Promise((r) => setTimeout(r, 0));
  if (!pred()) throw new Error('waitUntil: condition never became true');
}

function okExtract(): TranscribeDeps['extractAudio'] {
  return async ({ source: s, onProgress }) => {
    onProgress(100);
    return { opfsPath: `${jobIdOf(s.opfsPath)}/audio.wav`, durationSec: s.durationSec, sampleRate: 16000 };
  };
}

function recordStates(): { states: JobState[]; stop: () => void } {
  const states: JobState[] = [useAppStore.getState().jobState];
  const unsub = useAppStore.subscribe((s) => {
    if (s.jobState !== states[states.length - 1]) states.push(s.jobState);
  });
  return { states, stop: unsub };
}

beforeEach(reset);

describe('runTranscription — success', () => {
  it('walks ingesting_done → asr_loading → asr_running → transcript_ready → ready', async () => {
    const s = source('a');
    openSource(s);
    const rec = recordStates();
    await runTranscription(s, {
      extractAudio: okExtract(),
      runAsr: async ({ onProgress, audioPath }) => {
        expect(audioPath).toBe('job-a/audio.wav');
        onProgress({ stage: 'asr_loading', pct: 40, note: 'downloading model' });
        onProgress({ stage: 'asr_running', pct: 50, note: 'transcribing' });
        return transcript;
      },
    });
    rec.stop();
    expect(rec.states).toEqual(['ingesting_done', 'asr_loading', 'asr_running', 'transcript_ready', 'ready']);
    const st = useAppStore.getState();
    expect(st.transcript).toEqual(transcript);
    expect(st.asr.phase).toBe('ready');
    expect(st.asr.error).toBeNull();
    expect(st.tier).toBe('basic');
  });
});

describe('runTranscription — fallback (never fails the app)', () => {
  it('worker crash → job reaches ready, tier drops to minimal, error is non-blocking', async () => {
    const s = source('a');
    openSource(s);
    await runTranscription(s, {
      extractAudio: okExtract(),
      runAsr: async () => {
        throw new Error('worker error: Uncaught RuntimeError: memory access out of bounds');
      },
    });
    const st = useAppStore.getState();
    expect(st.jobState).toBe('ready');
    expect(st.transcript).toBeNull();
    expect(st.tier).toBe('minimal');
    expect(st.asr.phase).toBe('failed');
    expect(st.asr.error).toMatch(/stopped unexpectedly/);
    expect(st.error).toBeNull(); // the global export error stays clear
  });

  it('model download failure → ready with a download message', async () => {
    const s = source('a');
    openSource(s);
    await runTranscription(s, {
      extractAudio: okExtract(),
      runAsr: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    expect(useAppStore.getState().jobState).toBe('ready');
    expect(useAppStore.getState().asr.error).toMatch(/download the speech model/);
  });

  it('out-of-memory → ready with a memory message', async () => {
    const s = source('a');
    openSource(s);
    await runTranscription(s, {
      extractAudio: okExtract(),
      runAsr: async () => {
        throw new RangeError('Array buffer allocation failed');
      },
    });
    expect(useAppStore.getState().jobState).toBe('ready');
    expect(useAppStore.getState().asr.error).toMatch(/Not enough memory/);
  });

  it('audio extraction failure → ready, ASR never starts', async () => {
    const s = source('a');
    openSource(s);
    let asrCalled = false;
    await runTranscription(s, {
      extractAudio: async () => {
        throw new Error('AUDIO_EXTRACT_FAILED: decoder error');
      },
      runAsr: async () => {
        asrCalled = true;
        return transcript;
      },
    });
    expect(asrCalled).toBe(false);
    expect(useAppStore.getState().jobState).toBe('ready');
    expect(useAppStore.getState().asr.phase).toBe('failed');
  });

  it('minimal tier skips ASR entirely and goes straight to ready', async () => {
    const s = source('a');
    openSource(s);
    useAppStore.getState().setTier('minimal');
    let extracted = false;
    await runTranscription(s, {
      extractAudio: async () => {
        extracted = true;
        throw new Error('should not run');
      },
      runAsr: async () => transcript,
    });
    expect(extracted).toBe(false);
    expect(useAppStore.getState().asr.phase).toBe('skipped');
    expect(useAppStore.getState().jobState).toBe('ready');
  });
});

describe('runTranscription — concurrency with export and new files', () => {
  it('export can start during ASR, and a late transcript is stored without a state change', async () => {
    const s = source('a');
    openSource(s);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const run = runTranscription(s, {
      extractAudio: okExtract(),
      runAsr: async ({ onProgress }) => {
        onProgress({ stage: 'asr_running', pct: 10 });
        await gate;
        return transcript;
      },
    });
    // Wait until ASR is running, then the user exports.
    await waitUntil(() => useAppStore.getState().jobState === 'asr_running');
    expect(useAppStore.getState().setJobState('rendering')).toBeUndefined();
    expect(useAppStore.getState().jobState).toBe('rendering');

    release();
    await run;
    const st = useAppStore.getState();
    expect(st.transcript).toEqual(transcript); // stored
    expect(st.jobState).toBe('rendering'); // not moved by ASR
    expect(st.asr.phase).toBe('ready');
  });

  it('discards results for a source that was replaced mid-run', async () => {
    const first = source('first');
    openSource(first);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered = false;
    const run = runTranscription(first, {
      extractAudio: okExtract(),
      runAsr: async () => {
        entered = true;
        await gate;
        return transcript;
      },
    });
    await waitUntil(() => entered);
    // The user opens a different file: reset, then the new source is adopted.
    useAppStore.getState().resetJob();
    openSource(source('second'));

    release();
    await run;
    const st = useAppStore.getState();
    expect(st.source?.id).toBe('second');
    expect(st.transcript).toBeNull(); // stale result discarded
    expect(st.asr.phase).toBe('idle');
    expect(st.jobState).toBe('ingesting_done');
  });

  it('a stale failure does not degrade the new source', async () => {
    const first = source('first');
    openSource(first);
    let fail!: (e: Error) => void;
    const gate = new Promise<void>((_, rej) => (fail = rej));
    let entered = false;
    const run = runTranscription(first, {
      extractAudio: okExtract(),
      runAsr: async () => {
        entered = true;
        await gate;
        return transcript;
      },
    });
    await waitUntil(() => entered);
    useAppStore.getState().resetJob();
    openSource(source('second'));
    fail(new Error('worker error: late'));
    await run;
    expect(useAppStore.getState().tier).toBe('basic');
    expect(useAppStore.getState().asr.phase).toBe('idle');
  });
});

describe('describeAsrError', () => {
  it('maps known causes to short, non-technical messages', () => {
    expect(describeAsrError(new Error('worker error: boom'))).toMatch(/stopped unexpectedly/);
    expect(describeAsrError(new Error('Array buffer allocation failed'))).toMatch(/memory/);
    expect(describeAsrError(new Error('NetworkError when attempting to fetch resource'))).toMatch(/download/);
    expect(describeAsrError(new Error('something odd'))).toMatch(/^Transcription failed/);
    expect(describeAsrError('plain string')).toMatch(/Transcription failed/);
  });
});

describe('jobIdOf', () => {
  it('returns the job directory of a source path', () => {
    expect(jobIdOf('abc-123/source.mp4')).toBe('abc-123');
    expect(() => jobIdOf('nope')).toThrow();
  });
});
