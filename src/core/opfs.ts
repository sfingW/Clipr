/**
 * OPFS job storage (SPEC §8.1) — the only `core` module that touches
 * browser filesystem APIs (§18 exception). Paths are relative to the
 * `jobs/` root: `${jobId}/source.ext`.
 */
import type { ByteRangeReader } from './mp4Parse';

export type OpfsFailure = 'quota' | 'not-found' | 'security' | 'unknown';

export class OpfsError extends Error {
  readonly failure: OpfsFailure;
  constructor(failure: OpfsFailure, message: string) {
    super(message);
    this.name = 'OpfsError';
    this.failure = failure;
  }
}

const JOBS_ROOT = 'jobs';
const CHUNK_BYTES = 8 * 1024 * 1024;

function toOpfsError(err: unknown): OpfsError {
  if (err instanceof OpfsError) return err;
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : String(err);
  if (name === 'QuotaExceededError' || /quota/i.test(message)) {
    return new OpfsError('quota', `OPFS quota exceeded: ${message}`);
  }
  if (name === 'NotFoundError') return new OpfsError('not-found', `OPFS entry not found: ${message}`);
  if (name === 'SecurityError') return new OpfsError('security', `OPFS access denied: ${message}`);
  return new OpfsError('unknown', message);
}

async function jobsRoot(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(JOBS_ROOT, { create: true });
}

/** Resolve `path` ("jobId/file.ext") to a file handle, creating dirs as needed. */
async function handleForPath(path: string, create: boolean): Promise<FileSystemFileHandle> {
  const segments = path.split('/').filter(Boolean);
  if (segments.length < 2) throw new OpfsError('unknown', `invalid OPFS path: ${path}`);
  const fileName = segments.pop()!;
  try {
    let dir = await jobsRoot();
    for (const seg of segments) {
      dir = await dir.getDirectoryHandle(seg, { create });
    }
    return await dir.getFileHandle(fileName, { create });
  } catch (err) {
    throw toOpfsError(err);
  }
}

/** Stream a File into OPFS in 8 MB chunks — never buffers the whole file. */
export async function writeStreaming(
  path: string,
  file: File,
  onProgress?: (bytesWritten: number, totalBytes: number) => void,
): Promise<void> {
  try {
    const handle = await handleForPath(path, true);
    const writable = await handle.createWritable();
    try {
      let offset = 0;
      while (offset < file.size) {
        const chunk = file.slice(offset, Math.min(offset + CHUNK_BYTES, file.size));
        const buf = await chunk.arrayBuffer();
        await writable.write(buf);
        offset += buf.byteLength;
        onProgress?.(offset, file.size);
      }
    } finally {
      await writable.close();
    }
  } catch (err) {
    throw toOpfsError(err);
  }
}

/**
 * Get-or-create a file handle (creating parent directories). Used by workers
 * that stream into a file via `createSyncAccessHandle()` (dedicated workers only).
 */
export async function ensureFileHandle(path: string): Promise<FileSystemFileHandle> {
  return handleForPath(path, true);
}

export async function getFileHandle(path: string): Promise<FileSystemFileHandle> {
  return handleForPath(path, false);
}

/** Range reader over a file handle — how mp4box reads metadata + samples. */
export function opfsRangeReader(handle: FileSystemFileHandle): ByteRangeReader {
  return async (offset, length) => {
    const file = await handle.getFile();
    const end = Math.min(file.size, offset + length);
    if (offset >= file.size || end <= offset) return new Uint8Array(0);
    return new Uint8Array(await file.slice(offset, end).arrayBuffer());
  };
}

/** Remove an entire job directory (failure cleanup, §20). */
export async function removeJob(jobId: string): Promise<void> {
  try {
    const jobs = await jobsRoot();
    await jobs.removeEntry(jobId, { recursive: true });
  } catch (err) {
    const e = toOpfsError(err);
    if (e.failure === 'not-found') return;
    throw e;
  }
}

export async function readAll(path: string): Promise<Uint8Array> {
  try {
    const handle = await handleForPath(path, false);
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch (err) {
    throw toOpfsError(err);
  }
}

export async function writeBytes(path: string, bytes: Uint8Array): Promise<void> {
  try {
    const handle = await handleForPath(path, true);
    const writable = await handle.createWritable();
    try {
      await writable.write(bytes.buffer.slice(0) as ArrayBuffer);
    } finally {
      await writable.close();
    }
  } catch (err) {
    throw toOpfsError(err);
  }
}

const VIDEO_EXT_RE = /\.(mp4|m4v|mov)$/i;

/** Job directories currently persisted (SPEC §20 reload-resume). */
export async function listJobs(): Promise<string[]> {
  try {
    const root = await jobsRoot();
    const ids: string[] = [];
    for await (const [name, handle] of root.entries()) {
      if (handle.kind === 'directory') ids.push(name);
    }
    return ids;
  } catch {
    return [];
  }
}

/** Locate the source video inside a persisted job directory (SPEC §20). */
export async function findSourceInJob(
  jobId: string,
): Promise<{ handle: FileSystemFileHandle; name: string } | null> {
  try {
    const root = await jobsRoot();
    const dir = await root.getDirectoryHandle(jobId, { create: false });
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'file' && VIDEO_EXT_RE.test(name)) {
        return { handle: handle as FileSystemFileHandle, name };
      }
    }
    return null;
  } catch {
    return null;
  }
}
