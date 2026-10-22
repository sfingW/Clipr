/**
 * Job state machine (SPEC §10) — one machine per ingested file.
 *
 *   idle → ingesting → ingesting_done
 *                    → asr_loading → asr_running → transcript_ready
 *                                                 → llm_loading → scoring → candidates_ready
 *                                                                      → ready           (user can edit & export)
 *                                                                      → rendering → exporting → done
 *
 * Rules:
 * - `transcript_ready` implies the cutter is usable.
 * - `ready` is entered as soon as either transcript OR candidates exist.
 * - Failure of `asr_*`/`llm_*` degrades (skips forward), never fails the job.
 * - `rendering` failures return to `ready` with a surfaced error.
 *
 * Phase 0: state shape only; transition validation ships with the orchestrator.
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
