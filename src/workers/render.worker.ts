/**
 * Render worker (SPEC §8.10): accepts acked frame batches from the demux
 * pipeline, encodes video (H.264 avc1.640028) + audio through WebCodecs, and
 * muxes to MP4 with mp4box.js (mandatory muxer — SPEC §18).
 *
 * Codec/config rejections are tagged (WEB_CODECS_VIDEO_UNSUPPORTED /
 * AUDIO_ENCODER_UNSUPPORTED / ENCODER_UNSUPPORTED) so the main thread can take
 * the FFmpeg fallback path (§8.11).
 *
 * Batches are processed as serialized jobs: each job fully consumes its
 * batch, acks the demux worker (release), and only then does the next job
 * start — that is the backpressure loop, so at most one batch is buffered.
 * The handler resolves its RPC result only after the 'end' job finalizes the
 * mux.
 *
 * Audio paths:
 * - remux: AAC frame bytes passthrough from demux (source esds bytes reused).
 * - pcm: AudioEncoder transcode → ASC from encoder metadata → ES descriptor.
 */
import { clampBitrate, computeLayout, VIDEO_CODEC } from '../core/renderLayout';
import {
  buildEsdDescriptor,
  muxToMp4,
  type MuxAudioTrack,
  type MuxSample,
  type MuxVideoTrack,
} from '../core/mp4Mux';
import {
  serveRpc,
  type RenderWorker as RenderMethods,
  type RpcServerContext,
  type StreamMeta,
} from '../core/rpc';
import type { SourceMeta } from '../core/types';

const AAC_SAMPLE_RATE_FALLBACK = 48000;

function audioSampleRateOk(sr: number): boolean {
  // AAC-LC supports 44100/48000/96000 but not 8000/16000/22050/32000.
  return sr === 44100 || sr === 48000 || sr === 96000;
}

function tagged(code: string, err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  return new Error(msg.startsWith(`${code}:`) ? msg : `${code}: ${msg}`);
}

interface RemuxPart {
  start: number;
  length: number;
  dts: number;
  cts: number;
  duration: number;
}

interface RenderState {
  ctx: RpcServerContext;
  source: SourceMeta;
  meta: StreamMeta | null;
  layout: { sx: number; sy: number; sw: number; sh: number; outW: number; outH: number };
  fps: number;
  framesReceived: number;
  samplesWritten: number;
  encoderReady: boolean;
  videoError: Error | null;
  audioError: Error | null;
  aborted: boolean;
  videoQueue: VideoFrame[];
  audioQueue: (AudioData | null)[];
  videoEncoder: VideoEncoder | null;
  audioEncoder: AudioEncoder | null;
  videoTrack: MuxVideoTrack | null;
  audioAscd: Uint8Array | null; // ASC from AudioEncoder metadata (pcm path)
  muxAudio: MuxAudioTrack | null;
  remuxParts: RemuxPart[] | null;
  remuxBuffer: ArrayBuffer | null;
  remuxTimescale: number;
  resolveDone: (v: { mp4: Uint8Array }) => void;
  rejectDone: (e: Error) => void;
}

async function drainVideoQueueAsync(st: RenderState): Promise<void> {
  const enc = st.videoEncoder;
  if (!enc || enc.state !== 'configured') return;
  try {
    while (st.videoQueue.length > 0) {
      while (st.videoQueue.length > 0 && enc.encodeQueueSize < 6) {
        const frame = st.videoQueue.shift();
        if (!frame) break;
        enc.encode(frame, { keyFrame: st.samplesWritten % 60 === 0 });
        st.samplesWritten++;
      }
      if (st.videoQueue.length > 0) {
        // flush() resolves when every queued chunk has been emitted — the
        // encoder then has room again. No promise chains, no deadlock: the
        // queue only grows inside this job (batches are serialized).
        await enc.flush();
      }
    }
    if (st.videoError) throw st.videoError;
  } catch (err) {
    st.videoError ??= err instanceof Error ? err : new Error(String(err));
    for (;;) {
      const f = st.videoQueue.shift();
      if (!f) break;
      f.close();
    }
    throw st.videoError;
  }
}

function drainAudioQueue(st: RenderState): void {
  const enc = st.audioEncoder;
  if (!enc || enc.state !== 'configured') return;
  try {
    while (st.audioQueue.length > 0 && enc.encodeQueueSize < 16) {
      const item = st.audioQueue.shift();
      if (item === null || item === undefined) continue; // gap marker
      enc.encode(item);
      item.close();
    }
  } catch (err) {
    st.audioError ??= err instanceof Error ? err : new Error(String(err));
    for (;;) {
      const item = st.audioQueue.shift();
      if (item === null || item === undefined) break;
      item.close();
    }
  }
}

async function ensureEncoders(st: RenderState): Promise<void> {
  if (st.encoderReady) return;
  st.encoderReady = true;
  const { layout, meta } = st;
  const fps = st.fps;

  const videoEncoder = new VideoEncoder({
    output: (chunk, metadata) => {
      if (!st.videoTrack) {
        const desc = metadata?.decoderConfig?.description;
        if (!desc) {
          st.videoError ??= new Error('encoder produced no avcC configuration');
          return;
        }
        st.videoTrack = {
          codecType: 'avc1',
          width: layout.outW,
          height: layout.outH,
          timescale: Math.max(1, Math.round(fps * 1000)),
          avcDecoderConfigRecord: new Uint8Array(desc as ArrayBuffer),
          samples: [],
        };
      }
      const track = st.videoTrack;
      if (!track) return;
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      track.samples.push({
        // stored in µs here; converted to track timescale units at finalize
        dts: chunk.timestamp,
        cts: chunk.timestamp,
        duration: chunk.duration ?? 0,
        isSync: chunk.type === 'key',
        data,
      });
      const total = st.meta?.totalVideoFrames ?? 1;
      st.ctx.progress(Math.min(97, (st.samplesWritten / Math.max(1, total)) * 100), {
        stage: 'rendering',
        done: st.samplesWritten,
        total,
      });
    },
    error: (e) => {
      st.videoError ??= e instanceof Error ? e : new Error(String(e));
    },
  });
  try {
    videoEncoder.configure({
      codec: VIDEO_CODEC,
      width: layout.outW,
      height: layout.outH,
      bitrate: clampBitrate(layout.outW, layout.outH, fps),
      framerate: fps,
      latencyMode: 'quality',
    });
  } catch (err) {
    if (videoEncoder.state !== 'closed') videoEncoder.close();
    throw tagged('ENCODER_UNSUPPORTED', err);
  }
  if (videoEncoder.state !== 'configured') {
    videoEncoder.close();
    throw tagged('ENCODER_UNSUPPORTED', new Error(`codec rejected: ${VIDEO_CODEC}`));
  }
  st.videoEncoder = videoEncoder;

  // Audio encoder only on the pcm (transcode) path — remux passes bytes.
  if (meta?.audio && meta.audio.mode === 'pcm' && meta.audio.channels > 0) {
    const sr = audioSampleRateOk(meta.audio.sampleRate) ? meta.audio.sampleRate : AAC_SAMPLE_RATE_FALLBACK;
    const ch = Math.min(2, meta.audio.channels);
    const audioEncoder = new AudioEncoder({
      output: (chunk, metadata) => {
        if (!st.audioAscd) {
          const desc = metadata?.decoderConfig?.description;
          if (desc) st.audioAscd = new Uint8Array(desc as ArrayBuffer);
        }
        if (!st.muxAudio) {
          st.muxAudio = {
            codecType: 'mp4a',
            sampleRate: sr,
            channelCount: ch,
            sampleSize: 16,
            timescale: sr,
            samples: [],
          };
        }
        const track = st.muxAudio;
        if (!track) return;
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        track.samples.push({
          dts: chunk.timestamp, // µs; converted at finalize
          cts: chunk.timestamp,
          duration: chunk.duration || 0,
          isSync: true,
          data,
        });
      },
      error: (e) => {
        st.audioError ??= e instanceof Error ? e : new Error(String(e));
      },
    });
    try {
      audioEncoder.configure({ codec: 'mp4a.40.2', sampleRate: sr, numberOfChannels: ch, bitrate: 128_000 });
    } catch (err) {
      if (audioEncoder.state !== 'closed') audioEncoder.close();
      throw tagged('AUDIO_ENCODER_UNSUPPORTED', err);
    }
    if (audioEncoder.state !== 'configured') {
      audioEncoder.close();
      throw tagged('AUDIO_ENCODER_UNSUPPORTED', new Error('codec rejected: mp4a.40.2'));
    }
    st.audioEncoder = audioEncoder;
  }
}

async function processVideoBatch(st: RenderState, frames: VideoFrame[]): Promise<void> {
  try {
    await ensureEncoders(st);
    const { sx, sy, sw, sh, outW, outH } = st.layout;
    const durUs = Math.round(1_000_000 / Math.max(1, st.fps));
    for (const frame of frames) {
      const g = frame.displayWidth / Math.max(1, frame.codedWidth);
      const offscreen = new OffscreenCanvas(outW, outH);
      const ctx2d = offscreen.getContext('2d', { alpha: false });
      if (!ctx2d) {
        frame.close();
        throw new Error('2d context unavailable');
      }
      ctx2d.drawImage(
        frame,
        Math.round(sx * g),
        Math.round(sy * g),
        Math.round(sw * g),
        Math.round(sh * g),
        0,
        0,
        outW,
        outH,
      );
      frame.close();
      const vf = new VideoFrame(offscreen, {
        timestamp: Math.round((st.framesReceived * 1_000_000) / Math.max(1, st.fps)),
        duration: durUs,
      });
      st.videoQueue.push(vf);
      st.framesReceived++;
    }
    await drainVideoQueueAsync(st);
  } catch (err) {
    for (const f of frames) {
      try {
        f.close();
      } catch {
        /* already closed */
      }
    }
    throw err;
  }
}

async function processAudioBatch(st: RenderState, items: AudioData[]): Promise<void> {
  await ensureEncoders(st);
  for (const item of items) st.audioQueue.push(item);
  drainAudioQueue(st);
}

function finalize(st: RenderState): { mp4: Uint8Array } {
  // Encoders are flushed/closed by the caller before this runs (finalizeVideo
  // / finalizeAudio) — kept together for clarity of the sample math.

  const videoTrack = st.videoTrack;
  if (!videoTrack || videoTrack.samples.length === 0) {
    throw new Error(st.framesReceived > 0 ? 'encoder produced no samples' : 'render produced no video samples');
  }

  // Video: µs → track timescale units, monotonic dts from 0, neighbor durations.
  {
    const TS = videoTrack.timescale;
    const toUnits = (us: number): number => Math.round((us * TS) / 1_000_000);
    const base = videoTrack.samples[0].dts;
    const durUs = Math.round(1_000_000 / Math.max(1, st.fps));
    const units: MuxSample[] = videoTrack.samples.map((s, i) => {
      const next = videoTrack.samples[i + 1];
      const durationUs = next ? next.dts - s.dts : durUs;
      return {
        data: s.data,
        dts: Math.max(0, toUnits(s.dts - base)),
        cts: Math.max(0, toUnits(s.cts - base)),
        duration: Math.max(1, toUnits(durationUs)),
        isSync: s.isSync,
      };
    });
    // enforce monotonicity (B-frame reordering can shuffle decode times)
    let prev = 0;
    for (const s of units) {
      s.dts = Math.max(prev, s.dts);
      s.cts = Math.max(s.dts, s.cts);
      prev = s.dts + s.duration;
    }
    videoTrack.samples = units;
  }

  let audio: MuxAudioTrack | undefined;

  if (st.remuxParts && st.remuxBuffer && st.meta?.audio && st.meta.audio.mode === 'remux') {
    // Passthrough AAC: source units (timescale = source audio timescale),
    // contiguous from 0 (demux rebased dts), esds bytes from the source.
    const buf = new Uint8Array(st.remuxBuffer);
    const ts = st.remuxTimescale;
    const samples: MuxSample[] = st.remuxParts.map((p) => ({
      data: buf.slice(p.start, p.start + p.length),
      dts: p.dts,
      cts: p.cts,
      duration: Math.max(1, p.duration),
      isSync: true,
    }));
    let prev = 0;
    for (const s of samples) {
      s.dts = Math.max(prev, s.dts);
      s.cts = s.dts;
      prev = s.dts + s.duration;
    }
    if (samples.length > 0 && st.meta) {
      audio = {
        codecType: 'mp4a',
        sampleRate: st.meta.audio.sampleRate || 44100,
        channelCount: st.meta.audio.channels || 2,
        sampleSize: 16,
        timescale: ts,
        esdsDescriptor: st.meta.audio.esdsDescriptor,
        samples,
      };
    }
  } else if (st.muxAudio && st.muxAudio.samples.length > 0) {
    // Transcoded AAC: µs → audio timescale units, monotonic from 0.
    const track = st.muxAudio;
    if (!st.audioAscd) throw tagged('AUDIO_ENCODER_UNSUPPORTED', new Error('encoder produced no AAC descriptor'));
    track.esdsDescriptor = buildEsdDescriptor(st.audioAscd);
    const TS = track.timescale;
    const toUnits = (us: number): number => Math.round((us * TS) / 1_000_000);
    const base = track.samples[0].dts;
    const units: MuxSample[] = track.samples.map((s, i) => {
      const next = track.samples[i + 1];
      const durUs = next ? next.dts - s.dts : Math.round((1024 * 1_000_000) / TS);
      return {
        data: s.data,
        dts: Math.max(0, toUnits(s.dts - base)),
        cts: 0,
        duration: Math.max(1, toUnits(durUs)),
        isSync: true,
      };
    });
    let prev = 0;
    for (const s of units) {
      s.dts = Math.max(prev, s.dts);
      s.cts = s.dts;
      prev = s.dts + s.duration;
    }
    track.samples = units;
    audio = track;
  }

  const mp4 = muxToMp4({
    video: videoTrack,
    ...(audio ? { audio } : {}),
    brands: ['isom', 'iso6', 'avc1', 'mp41'],
  });
  return { mp4 };
}

function closeQueues(st: RenderState): void {
  for (;;) {
    const f = st.videoQueue.shift();
    if (!f) break;
    f.close();
  }
  for (;;) {
    const a = st.audioQueue.shift();
    if (a === undefined) break;
    if (a !== null) a.close();
  }
}

async function renderClipInner(
  payload: RenderMethods['render.clip']['payload'],
  ctx: RpcServerContext,
): Promise<{ mp4: Uint8Array }> {
  const { spec, source } = payload;
  const layout = computeLayout(spec, source);

  let resolveDone!: (v: { mp4: Uint8Array }) => void;
  let rejectDone!: (e: Error) => void;
  const done = new Promise<{ mp4: Uint8Array }>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });
  done.catch(() => undefined) as Promise<{ mp4: Uint8Array }>;

  const st: RenderState = {
    ctx,
    source,
    meta: null,
    layout,
    fps: Math.min(60, Math.max(1, source.frameRate || 25)),
    framesReceived: 0,
    samplesWritten: 0,
    encoderReady: false,
    videoError: null,
    audioError: null,
    aborted: false,
    videoQueue: [],
    audioQueue: [],
    videoEncoder: null,
    audioEncoder: null,
    videoTrack: null,
    audioAscd: null,
    muxAudio: null,
    remuxParts: null,
    remuxBuffer: null,
    remuxTimescale: 1000,
    resolveDone,
    rejectDone,
  };

  const jobs: Promise<void>[] = [];
  let fatalError: Error | null = null;

  const fail = (err: unknown): void => {
    const e = err instanceof Error ? err : new Error(String(err));
    if (fatalError) return;
    fatalError = e;
    try {
      ctx.sendStream({ kind: 'abort' });
    } catch {
      /* channel may already be gone */
    }
    closeQueues(st);
    rejectDone(e);
  };

  const ack = (batchId: number): void => {
    ctx.sendStream({ kind: 'ack', batchId });
  };

  const offStream = ctx.onStream((msg) => {
    if (fatalError) return;
    switch (msg.kind) {
      case 'meta':
        st.meta = msg.meta;
        st.fps = Math.min(60, Math.max(1, msg.meta.fps || source.frameRate || 25));
        break;
      case 'audioRemux':
        st.remuxBuffer = msg.audio.buffer;
        st.remuxTimescale = msg.audio.timescale;
        st.remuxParts = msg.audio.parts.map((p) => ({ ...p }));
        break;
      case 'videoBatch': {
        const frames = msg.frames;
        jobs.push(
          processVideoBatch(st, frames)
            .then(() => ack(msg.batchId))
            .catch((err) => {
              for (const f of frames) {
                try {
                  f.close();
                } catch {
                  /* handled */
                }
              }
              fail(err);
            }),
        );
        break;
      }
      case 'audioPcmBatch': {
        const items = msg.items;
        jobs.push(
          processAudioBatch(st, items)
            .then(() => ack(msg.batchId))
            .catch((err) => {
              for (const item of items) {
                try {
                  item.close();
                } catch {
                  /* handled */
                }
              }
              fail(err);
            }),
        );
        break;
      }
      case 'end': {
        const prior = [...jobs];
        jobs.push(
          (async () => {
            await Promise.all(prior);
            if (fatalError) return;
            try {
              // Flush + close encoders before sample math.
              if (st.videoEncoder && st.videoEncoder.state === 'configured') {
                try {
                  await drainVideoQueueAsync(st);
                  await st.videoEncoder.flush();
                } catch (err) {
                  throw /Unsupported|NotSupported|avc1|rejected/i.test(err instanceof Error ? err.message : '')
                    ? tagged('WEB_CODECS_VIDEO_UNSUPPORTED', err)
                    : err;
                }
                st.videoEncoder.close();
                st.videoEncoder = null;
              }
              if (st.videoError) throw tagged('WEB_CODECS_VIDEO_UNSUPPORTED', st.videoError);
              if (st.audioEncoder && st.audioEncoder.state === 'configured') {
                try {
                  drainAudioQueue(st);
                  await st.audioEncoder.flush();
                } catch (err) {
                  throw tagged('AUDIO_ENCODER_UNSUPPORTED', err);
                }
                st.audioEncoder.close();
                st.audioEncoder = null;
              }
              if (st.audioError) throw tagged('AUDIO_ENCODER_UNSUPPORTED', st.audioError);
              resolveDone(finalize(st));
            } catch (err) {
              fail(err);
            }
          })(),
        );
        break;
      }
      case 'abort':
        fail(new Error('aborted by orchestrator'));
        break;
      default:
        break;
    }
  });

  try {
    const result = await done;
    // Give in-flight acks a beat to flush before teardown (best-effort).
    await Promise.allSettled(jobs);
    return result;
  } finally {
    offStream();
    closeQueues(st);
    if (st.videoEncoder && st.videoEncoder.state !== 'closed') {
      try {
        st.videoEncoder.close();
      } catch {
        /* already closed */
      }
    }
    if (st.audioEncoder && st.audioEncoder.state !== 'closed') {
      try {
        st.audioEncoder.close();
      } catch {
        /* already closed */
      }
    }
  }
}

serveRpc<RenderMethods>(
  self as unknown as {
    addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
    postMessage(message: unknown, transfer?: Transferable[]): void;
  },
  {
    'render.clip': (payload, ctx) => renderClipInner(payload, ctx),
  },
);
