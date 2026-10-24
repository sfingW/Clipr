/**
 * FFmpeg fallback (SPEC §8.11): used when WebCodecs rejects the codec
 * (Safari). Decode still runs in demux.worker (H.264 decode is universal);
 * the main thread captures JPEG frames + WAV audio from the SAME acked
 * stream protocol, then encodes in-tab with @ffmpeg/ffmpeg (libx264 + AAC).
 *
 * Memory stays bounded: each frame batch is written to the ffmpeg FS and
 * acked before the next one is requested.
 */
import { FFmpeg } from '@ffmpeg/ffmpeg';
import coreURL from '@ffmpeg/core?url';
import wholeWasmURL from '@ffmpeg/core/wasm?url';
import { getDemuxClient } from '../app/workers';
import { computeLayout } from '../core/renderLayout';
import type { DemuxWorker, RpcClient, StreamMessage } from '../core/rpc';
import type { ClipSpec, SourceMeta } from '../core/types';

interface ProgressSink {
  (p: { pct: number; note?: string; etaSec?: number }): void;
}

interface WasmManifest {
  parts: string[];
  totalSize: number;
}

/**
 * Resolve the core wasm URL for `ffmpeg.load()` (SPEC §8.11).
 *
 * The production build splits any >25 MiB asset (Cloudflare Pages limit,
 * see vite.config.ts) into same-origin parts + `<wasm>.parts.json`; here we
 * fetch the parts and reassemble them into a `blob:` URL (same-origin, so
 * COOP/COEP isolation is unaffected). When no manifest exists — `vite dev`,
 * or an already-small asset — the whole-file URL is used directly.
 */
async function resolveWasmURL(): Promise<string> {
  let manifest: WasmManifest | null = null;
  try {
    const res = await fetch(`${wholeWasmURL}.parts.json`);
    if (res.ok) manifest = (await res.json()) as WasmManifest;
  } catch {
    manifest = null;
  }
  if (!manifest || manifest.parts.length === 0) return wholeWasmURL;
  const dir = wholeWasmURL.slice(0, wholeWasmURL.lastIndexOf('/') + 1);
  const buffers: ArrayBuffer[] = [];
  for (const part of manifest.parts) {
    const res = await fetch(dir + part);
    if (!res.ok) throw new Error(`ffmpeg core part "${part}" failed: HTTP ${res.status}`);
    buffers.push(await res.arrayBuffer());
  }
  return URL.createObjectURL(new Blob(buffers, { type: 'application/wasm' }));
}

/**
 * AudioData → interleaved f32 PCM. WebCodecs decoders emit `f32-planar`
 * (one plane per channel) or `f32` (packed); both are normalized here.
 * Returns null for exotic formats (not produced by AAC/H.264 decode paths).
 */
function readAudioData(item: AudioData): Float32Array | null {
  const frames = item.numberOfFrames;
  const ch = item.numberOfChannels;
  if (item.format === 'f32') {
    const buf = new Float32Array(frames * ch);
    item.copyTo(buf, { format: 'f32', planeIndex: 0 });
    return buf;
  }
  if (item.format === 'f32-planar') {
    const out = new Float32Array(frames * ch);
    const plane = new Float32Array(frames);
    for (let c = 0; c < ch; c++) {
      item.copyTo(plane, { format: 'f32-planar', planeIndex: c });
      for (let f = 0; f < frames; f++) out[f * ch + c] = plane[f];
    }
    return out;
  }
  return null;
}

/** Interleaved float32 PCM → 16-bit WAV bytes. */
function wavFromFloat32(samples: Float32Array, sampleRate: number, channels: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const writeStr = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * 2, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  writeStr(36, 'data');
  v.setUint32(40, dataBytes, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

export async function renderClipViaFfmpeg(
  spec: ClipSpec,
  source: SourceMeta,
  onProgress: ProgressSink,
): Promise<Blob> {
  const layout = computeLayout(spec, source);
  const demux: RpcClient<DemuxWorker> = getDemuxClient();
  const demuxId = crypto.randomUUID();
  const fps = source.frameRate || 25;
  const hasAudio = Boolean(source.audioCodec);

  const ffmpeg = new FFmpeg();
  // The output is hard-capped at the cut length (-t below): this path never
  // passes through the muxToMp4 video-master cap of PR #6.
  const cutSec = spec.sourceEndSec - spec.sourceStartSec;
  onProgress({ pct: 0, note: 'loading ffmpeg' });
  const assembledWasmURL = await resolveWasmURL();
  try {
    await ffmpeg.load({ coreURL, wasmURL: assembledWasmURL });
  } finally {
    if (assembledWasmURL.startsWith('blob:')) URL.revokeObjectURL(assembledWasmURL);
  }
  ffmpeg.on('progress', ({ progress }: { progress: number }) => {
    onProgress({ pct: 82 + Math.max(0, Math.min(1, progress)) * 18, note: 'ffmpeg encode' });
  });

  const canvas = new OffscreenCanvas(layout.outW, layout.outH);
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('fallback: 2d context unavailable');

  let frameIdx = 0;
  const pcmChunks: Float32Array[] = [];
  let audioChannels = 0;
  let audioRate = 0;
  let expectedFrames = Math.max(1, Math.round((spec.sourceEndSec - spec.sourceStartSec) * fps));
  let fatal: Error | null = null;

  const captureFrame = async (frame: VideoFrame): Promise<void> => {
    ctx.drawImage(frame, layout.sx, layout.sy, layout.sw, layout.sh, 0, 0, layout.outW, layout.outH);
    frame.close();
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    frameIdx++;
    await ffmpeg.writeFile(`f${String(frameIdx).padStart(6, '0')}.jpg`, bytes);
    if (frameIdx % 12 === 0) {
      onProgress({ pct: Math.min(80, (frameIdx / expectedFrames) * 80), note: 'frames' });
    }
  };

  const offStream = demux.onStream((msg: StreamMessage) => {
    if (msg.id !== demuxId) return;
    if (msg.kind === 'meta') {
      expectedFrames = Math.max(1, msg.meta.totalVideoFrames);
      return;
    }
    if (msg.kind !== 'videoBatch' && msg.kind !== 'audioPcmBatch') return;
    void (async () => {
      try {
        if (msg.kind === 'videoBatch') {
          for (const frame of msg.frames) await captureFrame(frame);
        } else {
          for (const item of msg.items) {
            const fmt = item.format;
            const pcm = readAudioData(item);
            audioChannels = item.numberOfChannels;
            audioRate = item.sampleRate;
            item.close();
            if (!pcm) throw new Error(`fallback: unexpected audio format ${fmt}`);
            pcmChunks.push(pcm);
          }
        }
        demux.sendStream({ id: demuxId, kind: 'ack', batchId: msg.batchId });
      } catch (e) {
        fatal ??= e instanceof Error ? e : new Error(String(e));
        demux.sendStream({ id: demuxId, kind: 'abort' });
      }
    })();
  });

  try {
    // Kick the stream; the request resolves only after every batch is acked,
    // which serializes with the async capture handler above.
    const req = demux.request(
      'demux.streamClip',
      {
        startSec: spec.sourceStartSec,
        endSec: spec.sourceEndSec,
        audio: hasAudio ? 'pcm' : 'none',
      },
      {
        requestId: demuxId,
        onProgress: (p) => {
          if (!fatal) onProgress({ pct: Math.min(80, p.pct * 0.8), note: p.note ?? 'decoding' });
        },
      },
    );
    demux.sendStream({ id: demuxId, kind: 'go' });

    try {
      await req;
    } catch (err) {
      if (!fatal) throw err;
    }
    if (fatal) throw fatal;
    if (frameIdx === 0) throw new Error('fallback: no frames decoded');

    let wroteWav = false;
    if (pcmChunks.length > 0) {
      let total = 0;
      for (const chunk of pcmChunks) total += chunk.length;
      const joined = new Float32Array(total);
      let off = 0;
      for (const chunk of pcmChunks) {
        joined.set(chunk, off);
        off += chunk.length;
      }
      pcmChunks.length = 0;
      // Hard-trim the PCM to exactly the cut length: packet selection can
      // over-collect when source metadata lies, and this WAV's length flows
      // straight into the container (there is no muxToMp4 cap on this path).
      const rate = audioRate || 48000;
      const ch = audioChannels || 2;
      const keep = Math.max(1, Math.floor(cutSec * rate)) * ch;
      const pcm = joined.length > keep ? joined.slice(0, keep) : joined;
      await ffmpeg.writeFile('a.wav', wavFromFloat32(pcm, rate, ch));
      wroteWav = true;
    }

    onProgress({ pct: 82, note: 'ffmpeg encode' });
    const outFps = frameIdx > 0 && cutSec > 0 ? frameIdx / cutSec : fps;
    const code = await ffmpeg.exec([
      '-framerate',
      outFps.toFixed(6),
      '-i',
      'f%06d.jpg',
      ...(wroteWav ? ['-i', 'a.wav'] : []),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p',
      ...(wroteWav ? ['-c:a', 'aac', '-b:a', '128k', '-shortest'] : []),
      // Hard duration cap: the container can NEVER exceed the cut length,
      // regardless of what any stream claims (belt alongside -shortest).
      '-t',
      cutSec.toFixed(3),
      '-movflags',
      '+faststart',
      'out.mp4',
    ]);
    if (code !== 0) throw new Error(`ffmpeg exec failed (code ${code})`);
    const out = (await ffmpeg.readFile('out.mp4')) as Uint8Array;
    onProgress({ pct: 100, note: 'done' });
    return new Blob([out.slice().buffer as ArrayBuffer], { type: 'video/mp4' });
  } finally {
    offStream();
    try {
      ffmpeg.terminate();
    } catch {
      /* already gone */
    }
  }
}
