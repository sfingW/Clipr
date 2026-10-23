/**
 * Ingest (SPEC §8.1): File → streamed OPFS write (never a full ArrayBuffer)
 * → mp4box metadata probe in demux.worker → `SourceMeta`.
 *
 * Failures map to §20 UI states via `IngestError` (quota / unsupported /
 * unknown); callers must clean up the partial job via `cleanupJob`.
 */
import { findSourceInJob, getFileHandle, removeJob, writeStreaming, OpfsError } from '../core/opfs';
import { getDemuxClient } from '../app/workers';

export type IngestErrorKind = 'quota' | 'unsupported' | 'unknown';

export class IngestError extends Error {
  readonly kind: IngestErrorKind;
  constructor(kind: IngestErrorKind, message: string) {
    super(message);
    this.name = 'IngestError';
    this.kind = kind;
  }
}

const EXT_OK = /\.(mp4|m4v|mov)$/i;

function extFor(file: File): string | null {
  if (!EXT_OK.test(file.name) && file.type !== 'video/mp4' && file.type !== 'video/quicktime') {
    return null;
  }
  const m = /\.([a-z0-9]+)$/i.exec(file.name);
  const ext = (m?.[1] ?? 'mp4').toLowerCase();
  return ext === 'm4v' || ext === 'mov' ? ext : 'mp4';
}

/** Ingest a picked/dropped file. Throws `IngestError` for §20 states. */
export async function ingestFile(
  file: File,
  cb: IngestCallbacks,
): Promise<OpenedJob> {
  const ext = extFor(file);
  if (!ext) {
    throw new IngestError(
      'unsupported',
      `Unsupported container: "${file.name}" — Phase 1 edits MP4/MOV only (FFmpeg-fallback conversion arrives later).`,
    );
  }
  const jobId = crypto.randomUUID();
  const opfsPath = `${jobId}/source.${ext}`;
  let opened = false;
  try {
    cb.onProgress(2, 'preparing');
    await writeStreaming(opfsPath, file, (written, total) => {
      cb.onProgress(2 + (total > 0 ? written / total : 0) * 0.68, 'writing to disk');
    });
    const handle = await getFileHandle(opfsPath);
    cb.onProgress(72, 'parsing');
    const source = await getDemuxClient().request('demux.open', {
      handle,
      opfsPath,
      fileName: file.name,
      sizeBytes: file.size,
    });
    opened = true;
    cb.onProgress(100, 'ready');
    return {
      jobId,
      source,
      file,
      close: async () => {
        try {
          await getDemuxClient().request('demux.close', {});
        } catch {
          /* worker may already be gone */
        }
      },
    };
  } catch (err) {
    // Clean up any partial OPFS data so quota can't leak (§20).
    await removeJob(jobId).catch(() => undefined);
    void opened;
    throw toIngestError(err, 'Ingest');
  }
}

/** Map pipeline/OPFS failures onto §20 UI states. */
function toIngestError(err: unknown, verb: string): IngestError {
  if (err instanceof IngestError) return err;
  if (err instanceof OpfsError && err.failure === 'quota') {
    return new IngestError('quota', 'Storage quota exceeded — free space in this browser and retry.');
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/unsupported-container|fragmented-mp4|no-video-track|missing-avcc|not an ISO-BMFF/.test(msg)) {
    return new IngestError('unsupported', msg);
  }
  return new IngestError('unknown', `${verb} failed: ${msg}`);
}

export interface IngestCallbacks {
  onProgress: (pct: number, note?: string) => void;
}

export interface OpenedJob {
  jobId: string;
  source: import('../core/types').SourceMeta;
  /** Original bytes (raw download for §20 render-failure fallback). */
  file: File;
  close: () => Promise<void>;
}

/**
 * Reopen a persisted job after a reload (SPEC §20 — OPFS survives, the
 * worker session does not).
 */
export async function resumeFromOpfs(jobId: string): Promise<OpenedJob> {
  const found = await findSourceInJob(jobId);
  if (!found) {
    throw new IngestError('unknown', 'Stored job is missing its source file — discard it and re-drop the video.');
  }
  const file = await found.handle.getFile();
  const opfsPath = `${jobId}/${found.name}`;
  try {
    const source = await getDemuxClient().request('demux.open', {
      handle: found.handle,
      opfsPath,
      fileName: file.name,
      sizeBytes: file.size,
    });
    return {
      jobId,
      source,
      file,
      close: async () => {
        try {
          await getDemuxClient().request('demux.close', {});
        } catch {
          /* worker may already be gone */
        }
      },
    };
  } catch (err) {
    throw toIngestError(err, 'Resume');
  }
}
