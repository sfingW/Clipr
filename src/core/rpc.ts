/**
 * Typed worker RPC (SPEC §9). Request/response protocol over `postMessage`.
 * Types only in Phase 0 — transport implementation lands with the first worker.
 */
import type { Candidate, ClipSpec, FaceSample, Transcript } from './types';

export type Request<T extends string, P> = { id: string; type: T; payload: P };
export type Response<T extends string, R> =
  | { id: string; type: T; ok: true; result: R }
  | { id: string; type: T; ok: false; error: string };
export type Progress = { id: string; pct: number; note?: string };

/** Per-worker method tables: `type` → payload/result pairs (SPEC §9). */
export interface AsrWorker {
  'asr.run': {
    payload: { audioPath: string; tier: 'full' | 'basic' };
    result: Transcript;
  };
}

export interface LlmWorker {
  'llm.load': {
    payload: { tier: 'full' | 'basic' };
    result: void;
  };
  'llm.score': {
    payload: { candidates: Candidate[] };
    result: Candidate[]; // with score+reason
  };
}

export interface VisionWorker {
  'vision.track': {
    payload: { sourcePath: string; start: number; end: number };
    result: FaceSample[];
  };
}

export interface RenderWorker {
  'render.clip': {
    payload: { spec: ClipSpec; sourcePath: string };
    result: { mp4: Uint8Array };
  };
}

/** Default request timeouts (SPEC §9): 10 min render, 5 min ASR; configurable per request. */
export const DEFAULT_TIMEOUTS_MS = {
  render: 10 * 60_000,
  asr: 5 * 60_000,
} as const;
