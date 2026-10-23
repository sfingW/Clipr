/**
 * Demux + decode worker (SPEC §8.2): mp4box.js sample extraction feeding
 * WebCodecs VideoDecoder/AudioDecoder. Window-based only — sample bytes are
 * read via File.slice ranges; full files/frames are never buffered.
 *
 * Export flow: batched, acked streams (backpressure) piped through the main
 * thread to render.worker (SPEC §4, §8.10).
 */
import {
  frameRateOf,
  lastSyncIndexBefore,
  locateMoov,
  parseMoovBytes,
  sampleIndexAtTime,
  sampleRangeForWindow,
  type ByteRangeReader,
  type ParsedMp4,
  type ParsedTrack,
} from '../core/mp4Parse';
import { extractAscFromDescriptor } from '../core/mp4Mux';
import {
  serveRpc,
  type DemuxWorker as DemuxMethods,
  type RpcServerContext,
  type StreamMeta,
  type StreamRemuxAudio,
} from '../core/rpc';
import type { SourceMeta } from '../core/types';

interface Session {
  handle: FileSystemFileHandle;
  reader: ByteRangeReader;
  parsed: ParsedMp4;
  fps: number;
  avcC: Uint8Array;
}

let session: Session | null = null;
let videoDecoder: VideoDecoder | null = null;
let decodeError: Error | null = null;
let collector: ((frame: VideoFrame) => void) | null = null;

/** Serializes all decode work — one VideoDecoder cannot interleave streams. */
let decodeLock: Promise<unknown> = Promise.resolve();
function withDecodeLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = decodeLock.then(fn, fn);
  decodeLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

const toUs = (units: number, timescale: number): number =>
  Math.round((units * 1_000_000) / timescale);

function videoTrack(): ParsedTrack {
  if (!session?.parsed.video) throw new Error('no open video track');
  if (!session.parsed.video.table) throw new Error('video track has no sample table (fragmented?)');
  return session.parsed.video;
}

async function readSample(track: ParsedTrack, index: number): Promise<Uint8Array> {
  const table = track.table!;
  const bytes = await session!.reader(table.offsets[index], table.sizes[index]);
  if (bytes.byteLength !== table.sizes[index]) {
    throw new Error(`short sample read: ${bytes.byteLength}/${table.sizes[index]} @${index}`);
  }
  return bytes;
}

function tagged(code: string, err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  return new Error(msg.startsWith(`${code}:`) ? msg : `${code}: ${msg}`);
}

function ensureVideoDecoder(): VideoDecoder {
  if (decodeError) {
    const err = tagged('WEB_CODECS_VIDEO_UNSUPPORTED', decodeError);
    decodeError = null;
    throw err;
  }
  if (videoDecoder && videoDecoder.state !== 'closed') return videoDecoder;
  const dec = new VideoDecoder({
    output: (frame) => {
      if (collector) collector(frame);
      else frame.close();
    },
    error: (e) => {
      decodeError = e instanceof Error ? e : new Error(String(e));
      try {
        if (dec.state !== 'closed') dec.close();
      } catch {
        /* already closed */
      }
    },
  });
  try {
    const track = videoTrack();
    dec.configure({
      codec: track.codec,
      codedWidth: track.width,
      codedHeight: track.height,
      description: session!.avcC,
      optimizeForLatency: true,
    });
  } catch (err) {
    if (dec.state !== 'closed') dec.close();
    throw tagged('WEB_CODECS_VIDEO_UNSUPPORTED', err);
  }
  videoDecoder = dec;
  return dec;
}

function closeVideoDecoder(): void {
  if (videoDecoder && videoDecoder.state !== 'closed') {
    try {
      videoDecoder.close();
    } catch {
      /* already closed */
    }
  }
  videoDecoder = null;
  decodeError = null;
}

/** Content bytes of a parsed box (box.start is absolute after rebasing). */
function boxContent(box: { start?: number; size?: number; hdr_size?: number }): Promise<Uint8Array> {
  const start = (box.start ?? 0) + (box.hdr_size ?? 0);
  const size = (box.size ?? 0) - (box.hdr_size ?? 0);
  if (size <= 0) return Promise.reject(new Error('empty box content'));
  return session!.reader(start, size);
}

function readerFor(handle: FileSystemFileHandle): ByteRangeReader {
  return async (offset, length) => {
    const file = await handle.getFile();
    const end = Math.min(file.size, offset + length);
    if (offset >= file.size || end <= offset) return new Uint8Array(0);
    return new Uint8Array(await file.slice(offset, end).arrayBuffer());
  };
}

async function open(payload: DemuxMethods['demux.open']['payload']): Promise<SourceMeta> {
  const reader = readerFor(payload.handle);
  const moov = await locateMoov(reader, payload.sizeBytes);
  if (!moov) {
    throw new Error(
      'unsupported-container: not an ISO-BMFF file (no moov atom) — this browser build can only edit MP4',
    );
  }
  const moovBytes = await reader(moov.offset, moov.size);
  const parsed = await parseMoovBytes(moovBytes, moov.offset);
  if (parsed.fragmented) {
    throw new Error('fragmented-mp4: fragmented sample tables are not editable yet');
  }
  const vt = parsed.video;
  if (!vt) throw new Error('no-video-track: source has no editable video track');
  const avcC = vt.stsdEntry?.avcC ?? vt.stsdEntry?.boxes?.find((b) => b.type === 'avcC');
  if (!avcC) throw new Error('missing-avcc: video track has no avcC decoder config');

  const next: Session = { handle: payload.handle, reader, parsed, fps: 0, avcC: new Uint8Array(0) };
  session = next; // boxContent needs session set before reading avcC
  next.avcC = await boxContent(avcC);
  next.fps = frameRateOf(vt, parsed.durationSec);
  closeVideoDecoder();

  return {
    id: crypto.randomUUID(),
    opfsPath: payload.opfsPath,
    fileName: payload.fileName,
    durationSec: parsed.durationSec,
    width: vt.width ?? 0,
    height: vt.height ?? 0,
    videoCodec: vt.codec,
    audioCodec: parsed.audio?.codec ?? '',
    frameRate: next.fps,
    sizeBytes: payload.sizeBytes,
  };
}

async function frameAtInner(payload: { tSec: number }): Promise<{ frame: VideoFrame; tSec: number }> {
  const track = videoTrack();
  const table = track.table!;
  const target = sampleIndexAtTime(table, track.timescale, payload.tSec);
  const from = lastSyncIndexBefore(table, target);
  const targetTs = toUs(table.pts[target], track.timescale);

  const dec = ensureVideoDecoder();
  const kept: { frame: VideoFrame | null } = { frame: null };
  let success = false;
  collector = (frame) => {
    if (frame.timestamp === targetTs && !kept.frame) kept.frame = frame;
    else frame.close();
  };
  try {
    for (let i = from; i <= target; i++) {
      const data = await readSample(track, i);
      dec.decode(
        new EncodedVideoChunk({
          type: table.sync[i] ? 'key' : 'delta',
          timestamp: toUs(table.pts[i], track.timescale),
          data,
        }),
      );
    }
    await dec.flush();
    success = true;
  } catch (err) {
    throw tagged('WEB_CODECS_VIDEO_UNSUPPORTED', err);
  } finally {
    collector = null;
    if (!success && kept.frame) {
      kept.frame.close();
      kept.frame = null;
    }
  }
  if (!kept.frame) throw new Error(`decode produced no frame for t=${payload.tSec}s`);
  return { frame: kept.frame, tSec: table.pts[target] / track.timescale };
}

interface AckGate {
  wait(batchId: number, timeoutMs?: number): Promise<void>;
  close(): void;
}

function ackGate(ctx: RpcServerContext): AckGate {
  let pending: { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null =
    null;
  let aborted = false;
  const off = ctx.onStream((msg) => {
    if (msg.kind === 'abort') {
      aborted = true;
      if (pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error('aborted by orchestrator'));
        pending = null;
      }
    } else if (msg.kind === 'ack' && pending) {
      clearTimeout(pending.timer);
      pending.resolve();
      pending = null;
    }
  });
  return {
    wait(batchId, timeoutMs = 300_000) {
      if (aborted) return Promise.reject(new Error('aborted by orchestrator'));
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending = null;
          reject(new Error(`ack timeout for batch ${batchId}`));
        }, timeoutMs);
        pending = { resolve, reject, timer };
      });
    },
    close: off,
  };
}

async function buildRemuxAudio(
  audio: ParsedTrack,
  startSec: number,
  endSec: number,
): Promise<StreamRemuxAudio | null> {
  const table = audio.table!;
  const selected: number[] = [];
  for (let i = 0; i < table.count; i++) {
    const dur = i + 1 < table.count ? table.dts[i + 1] - table.dts[i] : audio.durationSamples - table.dts[i];
    const sec = table.pts[i] / audio.timescale;
    const durSec = dur / audio.timescale;
    if (sec + durSec > startSec && sec < endSec) selected.push(i);
  }
  if (selected.length === 0) return null;

  let totalBytes = 0;
  for (const i of selected) totalBytes += table.sizes[i];
  const buffer = new ArrayBuffer(totalBytes);
  const view = new Uint8Array(buffer);
  const base = table.dts[selected[0]];
  const parts: StreamRemuxAudio['parts'] = [];
  let offset = 0;
  for (const i of selected) {
    const bytes = await session!.reader(table.offsets[i], table.sizes[i]);
    view.set(bytes, offset);
    const dur = i + 1 < table.count ? table.dts[i + 1] - table.dts[i] : audio.durationSamples - table.dts[i];
    parts.push({
      start: offset,
      length: bytes.byteLength,
      dts: table.dts[i] - base,
      cts: table.pts[i] - base,
      duration: dur,
    });
    offset += bytes.byteLength;
  }
  return { buffer, parts, timescale: audio.timescale };
}

async function streamPcmAudio(
  audio: ParsedTrack,
  startSec: number,
  endSec: number,
  ctx: RpcServerContext,
  gate: AckGate,
): Promise<void> {
  const table = audio.table!;
  const esdsBox = session!.parsed.audio?.stsdEntry?.esds ??
    session!.parsed.audio?.stsdEntry?.boxes?.find((b) => b.type === 'esds');
  const descriptor = esdsBox ? await boxContent(esdsBox) : null;
  const asc = descriptor ? extractAscFromDescriptor(descriptor) : null;
  const config: AudioDecoderConfig = {
    codec: audio.codec,
    sampleRate: audio.sampleRate ?? 48000,
    numberOfChannels: audio.channelCount ?? 2,
    ...(asc ? { description: asc } : {}),
  };

  const overlap = (i: number): boolean => {
    const dur = i + 1 < table.count ? table.dts[i + 1] - table.dts[i] : audio.durationSamples - table.dts[i];
    const sec = table.pts[i] / audio.timescale;
    const durSec = dur / audio.timescale;
    return sec + durSec > startSec && sec < endSec;
  };
  const selected: number[] = [];
  for (let i = 0; i < table.count; i++) if (overlap(i)) selected.push(i);
  if (selected.length === 0) return;

  const CHUNK = 120; // ~2.5s of AAC frames per acked batch
  let batchId = 0;
  for (let start = 0; start < selected.length; start += CHUNK) {
    const end = Math.min(selected.length, start + CHUNK);
    const items: AudioData[] = [];
    let dec: AudioDecoder;
    let decErr: Error | null = null;
    try {
      dec = new AudioDecoder({
        output: (data) => items.push(data),
        error: (e) => {
          decErr = e instanceof Error ? e : new Error(String(e));
        },
      });
      dec.configure(config);
    } catch (err) {
      throw tagged('AUDIO_DECODER_UNSUPPORTED', err);
    }
    try {
      for (let k = start; k < end; k++) {
        const i = selected[k];
        const data = await session!.reader(table.offsets[i], table.sizes[i]);
        dec.decode(
          new EncodedAudioChunk({
            type: 'key',
            timestamp: toUs(table.pts[i], audio.timescale),
            data,
          }),
        );
      }
      await dec.flush();
      if (decErr) throw decErr;
    } catch (err) {
      if (dec.state !== 'closed') dec.close();
      throw tagged('AUDIO_DECODER_UNSUPPORTED', err);
    }
    if (dec.state !== 'closed') dec.close();
    if (items.length > 0) {
      const id = batchId++;
      const last = end >= selected.length;
      ctx.sendStream({ kind: 'audioPcmBatch', items, batchId: id, last });
      await gate.wait(id);
    }
  }
}

async function streamClipInner(
  payload: DemuxMethods['demux.streamClip']['payload'],
  ctx: RpcServerContext,
): Promise<{ videoFrames: number }> {
  // Register the 'go' waiter FIRST (synchronously) — the orchestrator posts
  // 'go' right after the request, and it must never arrive before we listen.
  const started = new Promise<void>((resolve, reject) => {
    const off = ctx.onStream((m) => {
      if (m.kind === 'go') {
        off();
        resolve();
      } else if (m.kind === 'abort') {
        off();
        reject(new Error('aborted by orchestrator'));
      }
    });
  });
  // Guard: if the handler fails before `await started`, a late 'abort' must
  // not surface as an unhandled rejection.
  started.catch(() => undefined);

  const track = videoTrack();
  const table = track.table!;
  const { from, to } = sampleRangeForWindow(track, payload.startSec, payload.endSec);
  const timescale = track.timescale;
  const startUs = Math.round(payload.startSec * 1_000_000);
  const endUs = Math.round(payload.endSec * 1_000_000);

  let totalSend = 0;
  for (let i = from; i < to; i++) {
    if (toUs(table.pts[i], timescale) >= startUs - 1000) totalSend++;
  }
  if (totalSend === 0) throw new Error('empty-window: no decodable frames in cut range');

  await started;

  const parsed = session!.parsed;
  const audio = parsed.audio;
  const audioEsds =
    audio?.stsdEntry?.esds ?? audio?.stsdEntry?.boxes?.find((b) => b.type === 'esds');
  const audioUsable = Boolean(audio && audio.table && audioEsds && payload.audio !== 'none');
  let meta: StreamMeta;
  if (!audioUsable || !audio || !audioEsds) {
    meta = { totalVideoFrames: totalSend, fps: session!.fps, audio: { mode: 'none' } };
  } else if (payload.audio === 'remux') {
    meta = {
      totalVideoFrames: totalSend,
      fps: session!.fps,
      audio: {
        mode: 'remux',
        esdsDescriptor: await boxContent(audioEsds),
        sampleRate: audio.sampleRate ?? 48000,
        channels: audio.channelCount ?? 2,
        timescale: audio.timescale,
      },
    };
  } else {
    meta = {
      totalVideoFrames: totalSend,
      fps: session!.fps,
      audio: { mode: 'pcm', sampleRate: audio.sampleRate ?? 48000, channels: audio.channelCount ?? 2 },
    };
  }
  ctx.sendStream({ kind: 'meta', meta });

  const gate = ackGate(ctx);
  let sent = 0;
  let batchId = 0;
  try {
    if (meta.audio.mode === 'remux') {
      const remux = await buildRemuxAudio(audio!, payload.startSec, payload.endSec);
      if (remux) ctx.sendStream({ kind: 'audioRemux', audio: remux });
    } else if (meta.audio.mode === 'pcm') {
      await streamPcmAudio(audio!, payload.startSec, payload.endSec, ctx, gate);
    }

    const dec = ensureVideoDecoder();
    const w = session!.parsed.video!.width ?? 640;
    const h = session!.parsed.video!.height ?? 360;
    const batchSize = Math.max(4, Math.min(24, Math.round(2_000_000 / Math.max(1, w * h))));
    const out: VideoFrame[] = [];
    collector = (frame) => {
      if (frame.timestamp >= startUs - 1000 && frame.timestamp < endUs) out.push(frame);
      else frame.close();
    };
    let pending: VideoFrame[] = [];
    try {
      for (let i = from; i < to; ) {
        const chunkEnd = Math.min(to, i + 16);
        for (; i < chunkEnd; i++) {
          const data = await readSample(track, i);
          dec.decode(
            new EncodedVideoChunk({
              type: table.sync[i] ? 'key' : 'delta',
              timestamp: toUs(table.pts[i], timescale),
              data,
            }),
          );
        }
        await dec.flush();
        for (const frame of out.splice(0, out.length)) {
          pending.push(frame);
          sent++;
        }
        while (pending.length >= batchSize) {
          const frames = pending.slice(0, batchSize);
          pending = pending.slice(batchSize);
          const id = batchId++;
          ctx.sendStream({ kind: 'videoBatch', frames, batchId: id, last: false });
          await gate.wait(id);
        }
        ctx.progress(Math.min(95, 30 + (sent / totalSend) * 65), {
          stage: 'rendering',
          done: sent,
          total: totalSend,
        });
      }
      for (const frame of out.splice(0, out.length)) {
        pending.push(frame);
        sent++;
      }
      if (pending.length > 0) {
        const id = batchId++;
        ctx.sendStream({ kind: 'videoBatch', frames: pending, batchId: id, last: true });
        await gate.wait(id);
        pending = [];
      }
    } catch (err) {
      throw tagged('WEB_CODECS_VIDEO_UNSUPPORTED', err);
    } finally {
      collector = null;
      // Close anything we still own (frames not yet handed to a transfer).
      for (const f of out.splice(0)) f.close();
      for (const f of pending.splice(0)) f.close();
    }

    ctx.sendStream({ kind: 'end' });
    return { videoFrames: sent };
  } finally {
    gate.close();
  }
}

async function close(): Promise<void> {
  closeVideoDecoder();
  session = null;
}

serveRpc<DemuxMethods>(
  self as unknown as {
    addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
    postMessage(message: unknown, transfer?: Transferable[]): void;
  },
  {
    'demux.open': (payload) => withDecodeLock(() => open(payload)),
    'demux.frameAt': (payload) => withDecodeLock(() => frameAtInner(payload)),
    'demux.streamClip': (payload, ctx) => withDecodeLock(() => streamClipInner(payload, ctx)),
    'demux.close': () => withDecodeLock(() => close()),
  },
);
