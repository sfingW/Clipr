import { create } from 'zustand';
import type { Candidate, ClipSpec, CropKeyframe, SourceMeta, Transcript } from '../core/types';
import { canTransition, type JobState } from '../core/jobMachine';
import type { Tier } from './tiers';

/** Progress events as emitted by the pipeline (SPEC §8.4, §8.6, §8.10). */
export interface JobProgress {
  stage: 'ingest' | 'asr' | 'scoring' | 'vision' | 'rendering';
  pct?: number;
  done?: number;
  total?: number;
  etaSec?: number;
  note?: string;
}

/**
 * ASR status, kept apart from the job state (SPEC §10): the transcript pane
 * shows progress and non-blocking errors whatever the job state is.
 */
export type AsrPhase = 'idle' | 'loading' | 'running' | 'ready' | 'failed' | 'skipped';

export interface AsrStatus {
  phase: AsrPhase;
  /** 0–100 within the current phase. */
  pct: number;
  note: string | null;
  /** Non-blocking, user-facing reason when `phase === 'failed'`. */
  error: string | null;
}

export const INITIAL_ASR: AsrStatus = { phase: 'idle', pct: 0, note: null, error: null };

/**
 * WebGPU capability, probed once at startup (SPEC §11). `unknown` until the
 * probe finishes. `unavailable` hides every AI control and shows a notice.
 */
export type WebGpuStatus = 'unknown' | 'available' | 'unavailable';

/** AI scoring status, kept apart from the job state (SPEC §8.6, §10). */
export type LlmPhase = 'idle' | 'loading' | 'scoring' | 'ready' | 'failed';

export interface LlmStatus {
  phase: LlmPhase;
  /** Which engine is in use: WebGPU, or CPU after a GPU failure (or no WebGPU). */
  engine: 'webgpu' | 'cpu' | null;
  /** 0–100 within the current phase (model download, or scoring). */
  pct: number;
  note: string | null;
  /** Non-blocking, user-facing reason when `phase === 'failed'`. */
  error: string | null;
  done?: number;
  total?: number;
}

export const INITIAL_LLM: LlmStatus = { phase: 'idle', engine: null, pct: 0, note: null, error: null };

/**
 * Store shape: job state + UI state (SPEC §6).
 * Job state follows the §10 state machine; one job per ingested file.
 */
export interface AppStore {
  // job state
  tier: Tier;
  jobState: JobState;
  source: SourceMeta | null;
  transcript: Transcript | null;
  candidates: Candidate[];
  clips: ClipSpec[];
  activeClipId: string | null;
  progress: JobProgress | null;
  error: string | null;
  asr: AsrStatus;
  llm: LlmStatus;
  webgpu: WebGpuStatus;

  // ui state
  /** Shared playhead in source seconds: scrub position, and what the transcript highlights. */
  playheadSec: number;
  selectedCandidateId: string | null;
  captionStyleId: string;
  exportPreset: '1080p' | '720p';

  // job actions
  setTier: (tier: Tier) => void;
  setJobState: (state: JobState) => void;
  /**
   * Abandon the current job and return to `idle` from any state, so a new file
   * can start while the previous job's ASR is still running. Its late results
   * are discarded by the source-id guard in `runTranscription`.
   */
  resetJob: () => void;
  setSource: (source: SourceMeta | null) => void;
  /** Frame-accurate in/out for the active clip (SPEC §8.6). */
  setCut: (startSec: number, endSec: number) => void;
  setFormat: (format: ClipSpec['format']) => void;
  /** Auto-reframe result for the active clip (SPEC §8.8). Empty = center crop. */
  setCrop: (crop: CropKeyframe[]) => void;
  setTranscript: (transcript: Transcript | null) => void;
  setCandidates: (candidates: Candidate[]) => void;
  setClips: (clips: ClipSpec[]) => void;
  setActiveClip: (id: string | null) => void;
  setProgress: (progress: JobProgress | null) => void;
  setError: (error: string | null) => void;
  setAsr: (patch: Partial<AsrStatus>) => void;
  setLlm: (patch: Partial<LlmStatus>) => void;
  setWebGpu: (status: WebGpuStatus) => void;

  // ui actions
  setPlayhead: (sec: number) => void;
  selectCandidate: (id: string | null) => void;
  setCaptionStyle: (id: string) => void;
  setExportPreset: (preset: '1080p' | '720p') => void;
}

export const useAppStore = create<AppStore>()((set) => ({
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
  llm: INITIAL_LLM,
  webgpu: 'unknown',

  playheadSec: 0,
  selectedCandidateId: null,
  captionStyleId: 'bold-center',
  exportPreset: '1080p',

  setTier: (tier) => set({ tier }),
  setJobState: (jobState) =>
    set((s) => (s.jobState === jobState || canTransition(s.jobState, jobState) ? { jobState } : s)),
  // A new source invalidates everything derived from the previous one.
  resetJob: () => set({ jobState: 'idle' }),
  setSource: (source) =>
    set({
      source,
      transcript: null,
      asr: INITIAL_ASR,
      llm: INITIAL_LLM,
      playheadSec: 0,
      candidates: [],
      selectedCandidateId: null,
    }),
  setCut: (startSec, endSec) =>
    set((s) => ({
      clips: s.clips.map((c) =>
        c.id === s.activeClipId ? { ...c, sourceStartSec: startSec, sourceEndSec: endSec } : c,
      ),
    })),
  setFormat: (format) =>
    set((s) => ({
      clips: s.clips.map((c) => (c.id === s.activeClipId ? { ...c, format } : c)),
    })),
  setCrop: (crop) =>
    set((s) => ({
      clips: s.clips.map((c) => (c.id === s.activeClipId ? { ...c, crop } : c)),
    })),
  setTranscript: (transcript) => set({ transcript }),
  setCandidates: (candidates) => set({ candidates }),
  setClips: (clips) => set({ clips }),
  setActiveClip: (activeClipId) => set({ activeClipId }),
  setProgress: (progress) => set({ progress }),
  setError: (error) => set({ error }),
  setAsr: (patch) => set((s) => ({ asr: { ...s.asr, ...patch } })),
  setLlm: (patch) => set((s) => ({ llm: { ...s.llm, ...patch } })),
  setWebGpu: (webgpu) => set({ webgpu }),

  setPlayhead: (playheadSec) => set({ playheadSec: Math.max(0, playheadSec) }),
  selectCandidate: (selectedCandidateId) => set({ selectedCandidateId }),
  // Keeps the store default and the active clip's spec in step: the render
  // reads captionStyleId from the spec, the preview reads it from the clip.
  setCaptionStyle: (captionStyleId) =>
    set((s) => ({
      captionStyleId,
      clips: s.clips.map((c) => (c.id === s.activeClipId ? { ...c, captionStyleId } : c)),
    })),
  setExportPreset: (exportPreset) => set({ exportPreset }),
}));
