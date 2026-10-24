import { beforeEach, describe, expect, it } from 'vitest';
import { INITIAL_ASR, useAppStore } from '../src/app/store';
import type { SourceMeta, Transcript } from '../src/core/types';

const src = (id: string): SourceMeta => ({
  id,
  opfsPath: `${id}/source.mp4`,
  fileName: `${id}.mp4`,
  durationSec: 30,
  width: 640,
  height: 360,
  videoCodec: 'avc1',
  audioCodec: 'mp4a.40.2',
  frameRate: 30,
  sizeBytes: 1,
});

beforeEach(() => {
  useAppStore.setState({
    tier: 'basic',
    jobState: 'idle',
    source: null,
    transcript: null,
    asr: INITIAL_ASR,
    playheadSec: 0,
    error: null,
  });
});

describe('store: shared playhead', () => {
  it('moves the playhead and clamps it at zero', () => {
    useAppStore.getState().setPlayhead(12.5);
    expect(useAppStore.getState().playheadSec).toBe(12.5);
    useAppStore.getState().setPlayhead(-3);
    expect(useAppStore.getState().playheadSec).toBe(0);
  });
});

describe('store: a new source clears the previous job', () => {
  it('drops transcript, ASR status and playhead', () => {
    const st = useAppStore.getState();
    st.setSource(src('one'));
    st.setTranscript({ language: 'en', words: [], segments: [] } as Transcript);
    st.setAsr({ phase: 'ready', pct: 100 });
    st.setPlayhead(7);
    st.setSource(src('two'));
    const after = useAppStore.getState();
    expect(after.transcript).toBeNull();
    expect(after.asr).toEqual(INITIAL_ASR);
    expect(after.playheadSec).toBe(0);
  });
});

describe('store: resetJob', () => {
  it('returns to idle from any ASR state, which setJobState cannot do', () => {
    const st = useAppStore.getState();
    st.setSource(src('one'));
    st.setJobState('ingesting');
    st.setJobState('ingesting_done');
    st.setJobState('asr_loading');
    st.setJobState('asr_running');
    st.setJobState('idle'); // illegal edge: ignored
    expect(useAppStore.getState().jobState).toBe('asr_running');
    useAppStore.getState().resetJob();
    expect(useAppStore.getState().jobState).toBe('idle');
  });
});
