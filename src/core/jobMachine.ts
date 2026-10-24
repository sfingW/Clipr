/**
 * Job state machine (SPEC §10) — one machine per ingested file.
 *
 *   idle → ingesting → ingesting_done
 *                    → asr_loading → asr_running → transcript_ready
 *                                                 → llm_loading → scoring → candidates_ready
 *                                                                      → ready           (user can edit & export)
 *                                                                      → rendering → exporting → done
 *   ready → llm_loading: the user starts AI scoring from the ready cutter (Phase 4).
 *   The transcript path ends at `ready`, so this edge is how scoring starts.
 *
 * Rules:
 * - `transcript_ready` implies the cutter is usable.
 * - `ready` is entered as soon as either transcript OR candidates exist —
 *   and in Phase 1 (no AI) directly from `ingesting_done`.
 * - Export (`rendering`) is allowed from any ASR state: the cutter works before
 *   the transcript exists, so ASR must not block export.
 * - Failure of `asr_*`/`llm_*` degrades (skips forward), never fails the job.
 * - `rendering` failures return to `ready` with a surfaced error (§10, §20).
 * - Ingest failure returns to `idle` with a surfaced error.
 */
export type JobState =
  | 'idle'
  | 'ingesting'
  | 'ingesting_done'
  | 'asr_loading'
  | 'asr_running'
  | 'transcript_ready'
  | 'llm_loading'
  | 'scoring'
  | 'candidates_ready'
  | 'ready'
  | 'rendering'
  | 'exporting'
  | 'done';

export const INITIAL_JOB_STATE: JobState = 'idle';

/** Allowed transitions — the single source of truth for job movement. */
export const JOB_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  idle: ['ingesting'],
  ingesting: ['ingesting_done', 'idle'],
  ingesting_done: ['ready', 'asr_loading'],
  // ASR degrades, never fails the job: any asr_* state can fall back to `ready`
  // (manual cutting). Export is allowed while ASR runs (the cutter is usable).
  asr_loading: ['asr_running', 'transcript_ready', 'ready', 'rendering'],
  asr_running: ['transcript_ready', 'ready', 'rendering'],
  transcript_ready: ['llm_loading', 'ready', 'rendering'],
  llm_loading: ['scoring', 'candidates_ready'],
  scoring: ['candidates_ready'],
  candidates_ready: ['ready'],
  // `llm_loading` is the user's "Find Best Clips" action (Phase 4).
  ready: ['rendering', 'idle', 'llm_loading'],
  rendering: ['exporting', 'ready'],
  exporting: ['done', 'ready'],
  done: ['idle', 'ready'], // 'ready' = export another clip from the same source
};

export function canTransition(from: JobState, to: JobState): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}
