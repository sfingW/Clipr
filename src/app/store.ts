import { create } from 'zustand';
import type { Candidate, ClipSpec, SourceMeta, Transcript } from '../core/types';
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

  // ui state
  selectedCandidateId: string | null;
  captionStyleId: string;
  exportPreset: '1080p' | '720p';

  // job actions
  setTier: (tier: Tier) => void;
  setJobState: (state: JobState) => void;
  setSource: (source: SourceMeta | null) => void;
  /** Frame-accurate in/out for the active clip (SPEC §8.6). */
  setCut: (startSec: number, endSec: number) => void;
  setFormat: (format: ClipSpec['format']) => void;
  setTranscript: (transcript: Transcript | null) => void;
  setCandidates: (candidates: Candidate[]) => void;
  setClips: (clips: ClipSpec[]) => void;
  setActiveClip: (id: string | null) => void;
  setProgress: (progress: JobProgress | null) => void;
  setError: (error: string | null) => void;

  // ui actions
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

  selectedCandidateId: null,
  captionStyleId: 'bold-center',
  exportPreset: '1080p',

  setTier: (tier) => set({ tier }),
  setJobState: (jobState) =>
    set((s) => (s.jobState === jobState || canTransition(s.jobState, jobState) ? { jobState } : s)),
  setSource: (source) => set({ source }),
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
  setTranscript: (transcript) => set({ transcript }),
  setCandidates: (candidates) => set({ candidates }),
  setClips: (clips) => set({ clips }),
  setActiveClip: (activeClipId) => set({ activeClipId }),
  setProgress: (progress) => set({ progress }),
  setError: (error) => set({ error }),

  selectCandidate: (selectedCandidateId) => set({ selectedCandidateId }),
  setCaptionStyle: (captionStyleId) => set({ captionStyleId }),
  setExportPreset: (exportPreset) => set({ exportPreset }),
}));
