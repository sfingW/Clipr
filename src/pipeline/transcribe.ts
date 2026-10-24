/**
 * Transcription orchestration (SPEC §3 step 3, §10, §11, §20). Runs after
 * ingest: extract audio → ASR → `transcript_ready` → `ready`.
 *
 * ASR never fails the job. Any error (model download, out-of-memory, worker
 * crash) records a non-blocking ASR error, drops the tier to `minimal` (manual
 * cutting only, SPEC §11) and moves the job to `ready`.
 *
 * Results are applied only while the source they belong to is still open. If
 * the user opens another file mid-run, the stale result is discarded.
 */
import { useAppStore, type AppStore } from '../app/store';
import type { JobState } from '../core/jobMachine';
import type { AudioTrack, SourceMeta, Transcript } from '../core/types';
import { extractAudioTrack } from './audioExtract';
import type { AsrWorker, DemuxWorker, RpcClient } from '../core/rpc';

export interface RunAsrArgs {
  audioPath: string;
  tier: 'full' | 'basic';
  onProgress: (p: { stage?: string; pct: number; note?: string }) => void;
}

export interface TranscribeDeps {
  extractAudio: (args: {
    source: SourceMeta;
    onProgress: (pct: number) => void;
  }) => Promise<AudioTrack>;
  runAsr: (args: RunAsrArgs) => Promise<Transcript>;
}

/**
 * Turn an ASR failure into a short, user-facing sentence. The raw message is
 * kept out of the UI because it is usually a library/engine internal.
 */
export function describeAsrError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // Crash first: a worker crash message can mention memory too.
  if (/worker (error|terminated)|worker crashed|stopped unexpectedly/i.test(msg)) {
    return 'The transcription worker stopped unexpectedly. You can still cut manually.';
  }
  if (/out of memory|allocation failed|array buffer allocation/i.test(msg)) {
    return 'Not enough memory to transcribe this video on this device. You can still cut manually.';
  }
  if (/failed to fetch|networkerror|load failed|\b(4\d\d|5\d\d)\b|could not locate|model.*not found/i.test(msg)) {
    return 'Could not download the speech model. Check your connection and reopen the file to retry. You can still cut manually.';
  }
  return 'Transcription failed. You can still cut manually.';
}

/** Run transcription for `source`. Never rejects. */
export async function runTranscription(
  source: SourceMeta,
  deps: TranscribeDeps,
  store: { getState: () => AppStore } = useAppStore,
): Promise<void> {
  const s = () => store.getState();
  const isCurrent = (): boolean => s().source?.id === source.id;
  const advance = (to: JobState): void => {
    if (isCurrent()) s().setJobState(to); // setJobState rejects illegal edges
  };
  const patchAsr = (patch: Parameters<AppStore['setAsr']>[0]): void => {
    if (isCurrent()) s().setAsr(patch);
  };
  /** Only the ASR path may leave an ASR state; export/done must not be cut short. */
  const inAsr = (): boolean => {
    const st = s().jobState;
    return st === 'asr_loading' || st === 'asr_running';
  };

  if (s().tier === 'minimal') {
    // SPEC §11: minimal tier has no ASR; the cutter is the whole product.
    patchAsr({ phase: 'skipped', pct: 0, note: null, error: null });
    advance('ready');
    return;
  }

  advance('asr_loading');
  patchAsr({ phase: 'loading', pct: 0, note: 'Preparing audio', error: null });

  try {
    const audio = await deps.extractAudio({
      source,
      onProgress: (pct) => patchAsr({ phase: 'loading', pct, note: 'Preparing audio' }),
    });
    if (!isCurrent()) return;

    const tier = s().tier === 'full' ? 'full' : 'basic';
    const transcript = await deps.runAsr({
      audioPath: audio.opfsPath,
      tier,
      onProgress: (p) => {
        if (!isCurrent()) return;
        if (p.stage === 'asr_running') {
          advance('asr_running');
          patchAsr({ phase: 'running', pct: p.pct, note: p.note ?? 'Transcribing' });
        } else {
          patchAsr({ phase: 'loading', pct: p.pct, note: p.note ?? 'Downloading speech model' });
        }
      },
    });
    if (!isCurrent()) return;

    // The transcript is stored whatever the job state is (export may be running).
    s().setTranscript(transcript);
    patchAsr({ phase: 'ready', pct: 100, note: null, error: null });
    if (inAsr()) {
      advance('transcript_ready');
      advance('ready');
    }
  } catch (err) {
    if (!isCurrent()) return;
    console.warn('[clipr] transcription degraded to manual cutting:', err);
    patchAsr({ phase: 'failed', error: describeAsrError(err), note: null });
    s().setTier('minimal');
    if (inAsr()) advance('ready');
  }
}

/** Idle timeout for `asr.run`: re-armed on every progress message (long files stay alive). */
const ASR_IDLE_TIMEOUT_MS = 120_000;

/** Production dependencies: the real demux + ASR workers. */
export function defaultTranscribeDeps(
  demux: () => RpcClient<DemuxWorker>,
  asr: () => RpcClient<AsrWorker>,
): TranscribeDeps {
  return {
    extractAudio: ({ source, onProgress }) =>
      extractAudioTrack(demux(), {
        sourceOpfsPath: source.opfsPath,
        opfsPath: `${jobIdOf(source.opfsPath)}/audio.wav`,
        maxDurationSec: source.durationSec,
        onProgress,
      }),
    runAsr: ({ audioPath, tier, onProgress }) =>
      asr().request(
        'asr.run',
        { audioPath, tier },
        {
          timeoutMs: ASR_IDLE_TIMEOUT_MS,
          resetOnProgress: true,
          onProgress: (p) => onProgress({ stage: p.stage, pct: p.pct, note: p.note }),
        },
      ),
  };
}

/** `source.opfsPath` is `${jobId}/source.${ext}` (SPEC §8.1); the audio lives beside it. */
export function jobIdOf(opfsPath: string): string {
  const seg = opfsPath.split('/').filter(Boolean);
  if (seg.length < 2) throw new Error(`invalid source path: ${opfsPath}`);
  return seg.slice(0, -1).join('/');
}
