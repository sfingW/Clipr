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
  planRemuxAudio,
  sampleIndexAtTime,
  sampleRangeForWindow,
  type ByteRangeReader,
  type ParsedMp4,
  type ParsedTrack,
} from '../core/mp4Parse';
import { aacAccessUnitFrames, extractAscFromDescriptor } from '../core/mp4Mux';
import { ensureFileHandle } from '../core/opfs';
import {
  SincResampler,
  WAV_HEADER_BYTES,
  downmixToMono,
  wavFloat32Header,
} from '../pipeline/audioExtract';
import {
  serveRpc,
  type DemuxWorker as DemuxMethods,
  type RpcServerContext,
  type StreamMeta,
  type StreamRemuxAudio,
} from '../core/rpc';
import type { SourceMeta } from '../core/types';

/** Subset of FileSystemSyncAccessHandle used here (not in the DOM typings). */
interface SyncAccessHandle {
  write(buf: ArrayBufferView, opts: { at: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}

interface Session {
  opfsPath: string;
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

/**
 * Serializes the shared reader and decode calls. Waits for acks happen outside
 * the lock, so a long stream never holds it between batches (other requests
 * such as audio extraction run in between). Each stream decodes on its own
 * VideoDecoder, so no other request can change its GOP state.
 */
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

/**
 * A configured AVC VideoDecoder. Output and error go to the callbacks given, so
 * a caller owns its frames and state. Throws WEB_CODECS_VIDEO_UNSUPPORTED.
 */
function newVideoDecoder(onFrame: (frame: VideoFrame) => void, onError: (e: Error) => void): VideoDecoder {
  const dec: VideoDecoder = new VideoDecoder({
    output: onFrame,
    error: (e) => {
      onError(e instanceof Error ? e : new Error(String(e)));
      try {
        if (dec.state !== 'closed') dec.close();
      } catch {
        /* already closed */
      }
    },
  });
  try {
    const track = videoTrack();
    const description = session!.avcC;
    // AVC decoders need the avcC extradata; without `description` configure()
    // can appear to succeed yet decoding fails (SPEC §8.2 — avcC from stsd).
    if (!description || description.byteLength === 0) {
      throw new Error('avcC extradata missing — VideoDecoderConfig.description is required for AVC');
    }
    dec.configure({
      codec: track.codec,
      codedWidth: track.width,
      codedHeight: track.height,
      description,
      optimizeForLatency: true,
    });
  } catch (err) {
    if (dec.state !== 'closed') dec.close();
    throw tagged('WEB_CODECS_VIDEO_UNSUPPORTED', err);
  }
  return dec;
}

/** The shared decoder used by frameAt. Its frames go to `collector`. */
function ensureVideoDecoder(): VideoDecoder {
  if (decodeError) {
    const err = tagged('WEB_CODECS_VIDEO_UNSUPPORTED', decodeError);
    decodeError = null;
    throw err;
  }
  if (videoDecoder && videoDecoder.state !== 'closed') return videoDecoder;
  const dec = newVideoDecoder(
    (frame) => {
      if (collector) collector(frame);
      else frame.close();
    },
    (err) => {
      decodeError = err;
    },
  );
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

  const next: Session = {
    opfsPath: payload.opfsPath,
    handle: payload.handle,
    reader,
    parsed,
    fps: 0,
    avcC: new Uint8Array(0),
  };
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
  framesPerAu: number,
  sampleRate: number,
  startSec: number,
  endSec: number,
): Promise<StreamRemuxAudio | null> {
  const table = audio.table!;
  // Window AND timing come from PCM frame counts (planRemuxAudio) — the
  // source stts box is ignored: a broken time-to-sample table used to shift
  // the selection and inflate the muxed audio span (muxToMp4 additionally
  // hard-caps audio at the video pts span, but the source must be right too).
  const plan = planRemuxAudio(table.count, framesPerAu, sampleRate, startSec, endSec);
  if (!plan) return null;

  let totalBytes = 0;
  for (const i of plan.indices) totalBytes += table.sizes[i];
  const buffer = new ArrayBuffer(totalBytes);
  const view = new Uint8Array(buffer);
  const parts: StreamRemuxAudio['parts'] = [];
  let offset = 0;
  for (let k = 0; k < plan.indices.length; k++) {
    const i = plan.indices[k];
    const bytes = await session!.reader(table.offsets[i], table.sizes[i]);
    view.set(bytes, offset);
    parts.push({ start: offset, length: bytes.byteLength, ...plan.parts[k] });
    offset += bytes.byteLength;
  }
  return { buffer, parts, timescale: plan.timescale };
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
  // AAC: pick packets from PCM frame counts (same plan as the remux path) —
  // a broken source stts must not pull double the real audio into the PCM
  // stream. This WAV feeds the FFmpeg fallback, which never passes through
  // the muxToMp4 video-master cap, so over-collection here becomes a
  // too-long container. Non-AAC keeps stts overlap (no frames-per-AU model).
  const plan = audio.codec.startsWith('mp4a')
    ? planRemuxAudio(table.count, aacAccessUnitFrames(asc), config.sampleRate, startSec, endSec)
    : null;
  const selected: number[] = plan
    ? [...plan.indices]
    : (() => {
        const out: number[] = [];
        for (let i = 0; i < table.count; i++) if (overlap(i)) out.push(i);
        return out;
      })();
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
      await withDecodeLock(async () => {
      for (let k = start; k < end; k++) {
        const i = selected[k];
        const data = await session!.reader(table.offsets[i], table.sizes[i]);
        dec.decode(
          new EncodedAudioChunk({
            type: 'key',
            // Source-stts derived and unused by the PCM capture (the
            // selector above is frame-count based and the fallback only
            // consumes decoded PCM, never AudioData timestamps); the
            // WebCodecs pcm path re-stamps in render.worker anyway.
            timestamp: toUs(table.pts[i], audio.timescale),
            data,
          }),
        );
      }
      await dec.flush();
      });
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
  let remuxFramesPerAu = 0;
  let remuxRate = 0;
  if (!audioUsable || !audio || !audioEsds) {
    meta = { totalVideoFrames: totalSend, fps: session!.fps, audio: { mode: 'none' } };
  } else if (payload.audio === 'remux') {
    const esdsBytes = await boxContent(audioEsds);
    remuxFramesPerAu = aacAccessUnitFrames(extractAscFromDescriptor(esdsBytes));
    // Timing rate = codec sample rate (stsd/ASC), NOT the mdhd/stts machinery:
    // parts from buildRemuxAudio are in these units and the mux track
    // timescale is set to match (see planRemuxAudio).
    remuxRate = audio.sampleRate || audio.timescale || 48000;
    meta = {
      totalVideoFrames: totalSend,
      fps: session!.fps,
      audio: {
        mode: 'remux',
        esdsDescriptor: esdsBytes,
        sampleRate: remuxRate,
        channels: audio.channelCount ?? 2,
        timescale: remuxRate,
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
    // Audio first. The lock is held only around reads and decodes, never across
    // an ack wait, so other requests run between batches.
    if (meta.audio.mode === 'remux') {
      const remux = await withDecodeLock(() =>
        buildRemuxAudio(audio!, remuxFramesPerAu, remuxRate, payload.startSec, payload.endSec),
      );
      if (remux) ctx.sendStream({ kind: 'audioRemux', audio: remux });
    } else if (meta.audio.mode === 'pcm') {
      await streamPcmAudio(audio!, payload.startSec, payload.endSec, ctx, gate);
    }

    // Video decodes on a decoder of its own, not the shared one frameAt uses, so
    // its GOP state can't be touched by another request while it waits for acks.
    const w = session!.parsed.video!.width ?? 640;
    const h = session!.parsed.video!.height ?? 360;
    const batchSize = Math.max(4, Math.min(24, Math.round(2_000_000 / Math.max(1, w * h))));
    let pending: VideoFrame[] = [];
    let decodeErr: Error | null = null;
    const dec = newVideoDecoder(
      (frame) => {
        if (frame.timestamp >= startUs - 1000 && frame.timestamp < endUs) pending.push(frame);
        else frame.close();
      },
      (e) => {
        decodeErr = e;
      },
    );
    try {
      // WebCodecs requires a key chunk after configure() *and after every
      // flush()*. So the only flush is the one after the loop, and the first
      // chunk is always a key. Between samples the decoder keeps its state.
      for (let i = from; i < to; i++) {
        await withDecodeLock(async () => {
          const data = await readSample(track, i);
          if (decodeErr) throw decodeErr;
          dec.decode(
            new EncodedVideoChunk({
              // First chunk of the window is always typed 'key': `from` is
              // sync-anchored by sampleRangeForWindow; force it regardless.
              type: i === from || table.sync[i] ? 'key' : 'delta',
              timestamp: toUs(table.pts[i], timescale),
              data,
            }),
          );
        });
        while (pending.length >= batchSize) {
          const frames = pending.splice(0, batchSize);
          sent += frames.length;
          const id = batchId++;
          ctx.sendStream({ kind: 'videoBatch', frames, batchId: id, last: false });
          await gate.wait(id);
        }
        if (i % 8 === 0) {
          ctx.progress(Math.min(95, 30 + ((sent + pending.length) / totalSend) * 65), {
            stage: 'rendering',
            done: sent + pending.length,
            total: totalSend,
          });
        }
      }
      // Single legal flush: drains every remaining output; nothing decodes after it.
      await withDecodeLock(async () => {
        await dec.flush();
        if (decodeErr) throw decodeErr;
      });
      sent += pending.length;
      if (pending.length > 0) {
        const frames = pending.splice(0);
        const id = batchId++;
        ctx.sendStream({ kind: 'videoBatch', frames, batchId: id, last: true });
        await gate.wait(id);
      }
    } catch (err) {
      throw tagged('WEB_CODECS_VIDEO_UNSUPPORTED', err);
    } finally {
      // Close anything we still own (frames not yet handed to a transfer).
      for (const f of pending.splice(0)) f.close();
      if (dec.state !== 'closed') dec.close();
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

/** Downmix one decoded AudioData to mono Float32 (any channel layout/format). */
function audioDataToMono(data: AudioData): Float32Array {
  const ch = data.numberOfChannels;
  const frames = data.numberOfFrames;
  const planes: Float32Array[] = [];
  if (data.format === 'f32-planar') {
    for (let c = 0; c < ch; c++) {
      const p = new Float32Array(frames);
      data.copyTo(p, { planeIndex: c });
      planes.push(p);
    }
  } else {
    // Interleaved or integer formats: ask WebCodecs for planar float32.
    for (let c = 0; c < ch; c++) {
      const p = new Float32Array(frames);
      data.copyTo(p, { planeIndex: c, format: 'f32-planar' });
      planes.push(p);
    }
  }
  return downmixToMono(planes);
}

/** Batch size (AAC access units, ~2.5 s) between decode-lock releases. */
const EXTRACT_BATCH = 120;

/**
 * Decode the whole audio track → 16 kHz mono float32 WAV at `outPath` (SPEC
 * §8.3). One AudioDecoder is kept for the whole file (no per-batch reset of
 * the AAC overlap state). Each batch of packets runs under the decode lock, so
 * frame requests from the UI are served between batches.
 */
async function extractAudioInner(
  payload: DemuxMethods['demux.extractAudio']['payload'],
  ctx: RpcServerContext,
): Promise<DemuxMethods['demux.extractAudio']['result']> {
  const sess = session;
  if (!sess) throw new Error('no source open');
  if (sess.opfsPath !== payload.sourceOpfsPath) {
    throw new Error('stale-source: another file was opened during audio extraction');
  }
  const audio = sess.parsed.audio;
  if (!audio?.table) throw new Error('no-audio-track: source has no audio to transcribe');
  const table = audio.table;
  const esdsBox = audio.stsdEntry?.esds ?? audio.stsdEntry?.boxes?.find((b) => b.type === 'esds');
  const descriptor = esdsBox ? await boxContent(esdsBox) : null;
  const asc = descriptor ? extractAscFromDescriptor(descriptor) : null;
  const config: AudioDecoderConfig = {
    codec: audio.codec,
    sampleRate: audio.sampleRate ?? 48000,
    numberOfChannels: audio.channelCount ?? 2,
    ...(asc ? { description: asc } : {}),
  };
  const outRate = payload.sampleRate;
  // Never produce audio past the video's end (SPEC §8.3 cap).
  const cap = payload.maxDurationSec > 0 ? Math.floor(payload.maxDurationSec * outRate) : Infinity;

  const resampler = new SincResampler(config.sampleRate!, outRate);
  // Sync access handles exist only in dedicated workers (not in the DOM typings).
  const fh = (await ensureFileHandle(payload.outPath)) as FileSystemFileHandle & {
    createSyncAccessHandle(): Promise<SyncAccessHandle>;
  };
  const sync = await fh.createSyncAccessHandle();
  let written = 0;
  let writePos = WAV_HEADER_BYTES;
  const writeSamples = (pcm: Float32Array): void => {
    const room = cap - written;
    const s = pcm.length > room ? pcm.subarray(0, Math.max(0, room)) : pcm;
    if (s.length === 0) return;
    // Little-endian on every platform the app runs on (WAV is LE).
    sync.write(new Uint8Array(s.buffer, s.byteOffset, s.byteLength), { at: writePos });
    writePos += s.byteLength;
    written += s.length;
  };

  const queue: AudioData[] = [];
  let decErr: Error | null = null;
  let dec: AudioDecoder | null = null;
  try {
    sync.truncate(0);
    sync.write(new Uint8Array(WAV_HEADER_BYTES), { at: 0 }); // patched at the end
    try {
      dec = new AudioDecoder({
        output: (data) => queue.push(data),
        error: (e) => {
          decErr = e instanceof Error ? e : new Error(String(e));
        },
      });
      dec.configure(config);
    } catch (err) {
      throw tagged('AUDIO_DECODER_UNSUPPORTED', err);
    }
    const drain = (): void => {
      for (const data of queue.splice(0)) {
        try {
          writeSamples(resampler.push(audioDataToMono(data)));
        } finally {
          data.close();
        }
      }
    };
    const total = table.count;
    for (let start = 0; start < total && written < cap; start += EXTRACT_BATCH) {
      if (session !== sess) throw new Error('stale-source: another file was opened during audio extraction');
      const end = Math.min(total, start + EXTRACT_BATCH);
      await withDecodeLock(async () => {
        for (let i = start; i < end; i++) {
          const data = await sess.reader(table.offsets[i], table.sizes[i]);
          dec!.decode(
            new EncodedAudioChunk({ type: 'key', timestamp: toUs(table.pts[i], audio.timescale), data }),
          );
        }
        await dec!.flush();
        if (decErr) throw decErr;
        drain();
      });
      ctx.progress(Math.round((end / total) * 100), { stage: 'asr_loading', note: 'decoding audio' });
    }
    writeSamples(resampler.flush());
    sync.write(wavFloat32Header(written, outRate, 1), { at: 0 });
    sync.truncate(WAV_HEADER_BYTES + written * 4);
    sync.flush();
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('stale-source')) throw err;
    throw tagged('AUDIO_EXTRACT_FAILED', err);
  } finally {
    if (dec && dec.state !== 'closed') dec.close();
    sync.close();
  }
  return { opfsPath: payload.outPath, durationSec: written / outRate, sampleCount: written };
}

serveRpc<DemuxMethods>(
  self as unknown as {
    addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
    postMessage(message: unknown, transfer?: Transferable[]): void;
  },
  {
    'demux.open': (payload) => withDecodeLock(() => open(payload)),
    'demux.frameAt': (payload) => withDecodeLock(() => frameAtInner(payload)),
    // Not wrapped in withDecodeLock: the lock is taken per operation inside.
    'demux.streamClip': (payload, ctx) => streamClipInner(payload, ctx),
    'demux.close': () => withDecodeLock(() => close()),
    // Not wrapped in withDecodeLock: each batch takes the lock itself.
    'demux.extractAudio': (payload, ctx) => extractAudioInner(payload, ctx),
  },
);
