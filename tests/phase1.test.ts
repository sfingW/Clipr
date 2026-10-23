/**
 * Phase-1 unit tests: job state machine (SPEC §10) and render layout math
 * (SPEC §8.6/§8.10 sizing). Pure logic only — browser pipelines are covered
 * by mp4mux.test.ts fixtures and the /spike-mux.html harness.
 */
import { describe, expect, it } from 'vitest';
import { INITIAL_JOB_STATE, JOB_TRANSITIONS, canTransition, type JobState } from '../src/core/jobMachine';
import { align2, clampBitrate, computeLayout } from '../src/core/renderLayout';
import type { ClipSpec, SourceMeta } from '../src/core/types';

const ALL_STATES: JobState[] = [
  'idle',
  'ingesting',
  'ingesting_done',
  'asr_loading',
  'asr_running',
  'transcript_ready',
  'llm_loading',
  'scoring',
  'candidates_ready',
  'ready',
  'rendering',
  'exporting',
  'done',
];

function walk(path: JobState[]): boolean {
  for (let i = 0; i + 1 < path.length; i++) {
    if (!canTransition(path[i], path[i + 1])) return false;
  }
  return true;
}

describe('job state machine (§10)', () => {
  it('starts idle and can begin ingest', () => {
    expect(INITIAL_JOB_STATE).toBe('idle');
    expect(canTransition('idle', 'ingesting')).toBe(true);
  });

  it('walks the Phase-1 ingest path to ready without AI stages', () => {
    // Phase 1: no ASR/LLM — ingesting_done → ready directly (§21 decision).
    expect(walk(['idle', 'ingesting', 'ingesting_done', 'ready'])).toBe(true);
    expect(canTransition('ingesting', 'ready')).toBe(false);
  });

  it('walks export and supports the failed-render return to ready', () => {
    expect(walk(['ready', 'rendering', 'exporting', 'done'])).toBe(true);
    expect(canTransition('rendering', 'ready')).toBe(true); // §10/§20 failure path
    expect(canTransition('exporting', 'ready')).toBe(true);
  });

  it('allows done → ready (export another clip) but never done → rendering directly', () => {
    expect(canTransition('done', 'ready')).toBe(true);
    expect(canTransition('done', 'rendering')).toBe(false);
    expect(canTransition('ready', 'done')).toBe(false);
  });

  it('keeps the transition table closed over known states', () => {
    const keys = Object.keys(JOB_TRANSITIONS) as JobState[];
    expect(new Set(keys)).toEqual(new Set(ALL_STATES));
    for (const targets of Object.values(JOB_TRANSITIONS)) {
      for (const t of targets) expect(ALL_STATES).toContain(t);
    }
  });
});

describe('render layout (§8.6 crop, §8.10 output sizing)', () => {
  const base: SourceMeta = {
    id: '00000000-0000-0000-0000-000000000000',
    opfsPath: 'job/source.mp4',
    fileName: 'source.mp4',
    durationSec: 60,
    width: 1920,
    height: 1080,
    videoCodec: 'avc1.640028',
    audioCodec: 'mp4a.40.2',
    frameRate: 25,
    sizeBytes: 1_000_000,
  };
  const clip = (over: Partial<ClipSpec> = {}): ClipSpec => ({
    id: 'c1',
    sourceStartSec: 0,
    sourceEndSec: 10,
    crop: [],
    captionStyleId: 'bold-center',
    captions: [],
    format: 'original',
    exportPreset: '1080p',
    ...over,
  });

  it('original format never upscales and aligns to even dims', () => {
    const small: SourceMeta = { ...base, width: 641, height: 481 };
    const out = computeLayout(clip(), small);
    expect(out.outW).toBe(640); // align2 of 641 at scale 1
    expect(out.outH).toBe(480);
    expect(out.sw).toBe(641);
    expect(out.sh).toBe(481);
  });

  it('720p preset caps the long edge at 1280', () => {
    const out = computeLayout(clip({ exportPreset: '720p' }), base);
    expect(out.outW).toBe(1280);
    expect(out.outH).toBe(720);
  });

  it('vertical format crops 16:9 into exact 9:16 at 1080×1920', () => {
    const out = computeLayout(clip({ format: 'vertical' }), base);
    expect(out.outW).toBe(1080);
    expect(out.outH).toBe(1920);
    expect(out.sh).toBe(1080); // full source height kept
    expect(out.sw).toBe(608); // round(1080 × 9/16), centred
    expect(Math.abs(out.sw / out.sh - 9 / 16)).toBeLessThan(0.01);
  });

  it('vertical leaves an already-9:16 source uncropped', () => {
    const tall: SourceMeta = { ...base, width: 1080, height: 1920 };
    const out = computeLayout(clip({ format: 'vertical' }), tall);
    expect(out.sw).toBe(1080);
    expect(out.sh).toBe(1920);
    expect(out.outW).toBe(1080);
    expect(out.outH).toBe(1920);
  });

  it('clampBitrate respects the 1.5–12 Mbps envelope', () => {
    expect(clampBitrate(2, 2, 1)).toBe(1_500_000);
    expect(clampBitrate(7680, 4320, 60)).toBe(12_000_000);
    expect(clampBitrate(1280, 720, 30)).toBe(Math.round(1280 * 720 * 30 * 0.12));
    expect(align2(1081)).toBe(1080);
    expect(align2(1)).toBe(2);
  });
});
