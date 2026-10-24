/**
 * Audio extraction helpers (SPEC §8.3): decoded source audio → 16 kHz mono
 * Float32 PCM → WAV. Everything here is pure (no DOM, no OPFS) so it is unit
 * testable in Node. The demux worker drives decode + OPFS writes and calls
 * these helpers; `extractAudioTrack` is the pipeline entry point that asks
 * the demux worker for the WAV.
 *
 * The WAV is the sole input to the ASR worker.
 */
import type { DemuxWorker, RpcClient } from '../core/rpc';
import type { AudioTrack } from '../core/types';

export const ASR_SAMPLE_RATE = 16_000;
export const WAV_HEADER_BYTES = 44;
const BYTES_PER_SAMPLE = 4; // IEEE float32

/** Minimum half-width of the windowed-sinc kernel, in input samples. */
const KERNEL_HALF_MIN = 16;
/** Phase resolution of the polyphase table (fractional input offsets). */
const PHASES = 512;

/** Average planar channels into one mono channel. */
export function downmixToMono(planes: readonly Float32Array[]): Float32Array {
  if (planes.length === 0) return new Float32Array(0);
  if (planes.length === 1) return planes[0];
  const n = planes[0].length;
  const out = new Float32Array(n);
  const inv = 1 / planes.length;
  for (const p of planes) {
    if (p.length !== n) throw new Error('downmix: channel length mismatch');
    for (let i = 0; i < n; i++) out[i] += p[i];
  }
  for (let i = 0; i < n; i++) out[i] *= inv;
  return out;
}

function blackman(x: number): number {
  // x in [-1, 1]; zero outside.
  if (x <= -1 || x >= 1) return 0;
  const t = (x + 1) / 2; // 0..1
  return 0.42 - 0.5 * Math.cos(2 * Math.PI * t) + 0.08 * Math.cos(4 * Math.PI * t);
}

function sinc(x: number): number {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

/**
 * Streaming polyphase windowed-sinc resampler (mono). Output sample `n` sits
 * at input position `n * inRate / outRate`. Push any chunking you like —
 * the output is identical to a single push of the same samples.
 */
export class SincResampler {
  private readonly ratio: number; // input samples per output sample
  private readonly outRate: number;
  private readonly inRate: number;
  /** Kernel half-width (input samples); widened for large decimation ratios. */
  private readonly half: number;
  private readonly width: number;
  private readonly table: Float32Array; // PHASES × width
  /** Input history; `buf[0]` is absolute input index `bufStart`. */
  private buf = new Float32Array(0);
  private bufStart = 0;
  private totalIn = 0;
  private nextOut = 0;
  private finished = false;

  constructor(inRate: number, outRate: number) {
    if (!(inRate > 0) || !(outRate > 0)) throw new Error('resampler: rates must be positive');
    this.inRate = inRate;
    this.outRate = outRate;
    this.ratio = inRate / outRate;
    this.half = Math.max(KERNEL_HALF_MIN, Math.ceil((KERNEL_HALF_MIN * Math.max(1, this.ratio)) / 2));
    this.width = 2 * this.half;
    // Ideal low-pass cutoff in cycles per input sample: 95% of the lower Nyquist.
    const fc = 0.5 * Math.min(1, outRate / inRate) * 0.95;
    const width = this.width;
    this.table = new Float32Array(PHASES * width);
    for (let p = 0; p < PHASES; p++) {
      const frac = p / PHASES;
      let sum = 0;
      const row = new Float64Array(width);
      for (let j = 0; j < width; j++) {
        const d = j - (this.half - 1); // input offset from floor(center)
        const x = d - frac; // distance from the true center, input samples
        const w = 2 * fc * sinc(2 * fc * x) * blackman(x / this.half);
        row[j] = w;
        sum += w;
      }
      for (let j = 0; j < width; j++) this.table[p * width + j] = row[j] / sum; // unity DC gain
    }
  }

  /** Feed input samples; returns the output samples that are now complete. */
  push(input: Float32Array): Float32Array {
    if (this.finished) throw new Error('resampler: push after flush');
    if (input.length === 0) return new Float32Array(0);
    // Append to history.
    const merged = new Float32Array(this.buf.length + input.length);
    merged.set(this.buf, 0);
    merged.set(input, this.buf.length);
    this.buf = merged;
    this.totalIn += input.length;
    const available = this.bufStart + this.buf.length; // exclusive end (absolute)

    const emitted: number[] = [];
    // Output n needs inputs [floor(c)-K+1, floor(c)+K]; emit only when complete.
    for (;;) {
      const c = this.nextOut * this.ratio;
      const base = Math.floor(c);
      if (base + this.half >= available) break;
      emitted.push(this.evaluate(c));
      this.nextOut++;
    }
    this.trim();
    return Float32Array.from(emitted);
  }

  /** Emit the remaining output (zero-padded past the end of input). */
  flush(): Float32Array {
    if (this.finished) return new Float32Array(0);
    this.finished = true;
    const expected = Math.ceil((this.totalIn * this.outRate) / this.inRate);
    const emitted: number[] = [];
    while (this.nextOut < expected) {
      emitted.push(this.evaluate(this.nextOut * this.ratio));
      this.nextOut++;
    }
    this.buf = new Float32Array(0);
    return Float32Array.from(emitted);
  }

  private evaluate(c: number): number {
    const base = Math.floor(c);
    const p = Math.min(PHASES - 1, Math.round((c - base) * PHASES) % PHASES);
    const width = this.width;
    let acc = 0;
    for (let j = 0; j < width; j++) {
      const idx = base + j - (this.half - 1) - this.bufStart;
      if (idx < 0 || idx >= this.buf.length) continue; // zero outside history / end
      acc += this.buf[idx] * this.table[p * width + j];
    }
    return acc;
  }

  private trim(): void {
    // Keep only what the next output sample can still reach.
    const keepFrom = Math.floor(this.nextOut * this.ratio) - (this.half - 1);
    const drop = keepFrom - this.bufStart;
    if (drop > 0 && drop <= this.buf.length) {
      this.buf = this.buf.slice(drop);
      this.bufStart += drop;
    }
  }
}

/** Canonical 44-byte WAV header for 32-bit IEEE float PCM. */
export function wavFloat32Header(sampleCount: number, sampleRate: number, channels: number): Uint8Array {
  const dataBytes = sampleCount * channels * BYTES_PER_SAMPLE;
  const h = new Uint8Array(WAV_HEADER_BYTES);
  const v = new DataView(h.buffer);
  const ascii = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) h[off + i] = s.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 3, true); // WAVE_FORMAT_IEEE_FLOAT
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * BYTES_PER_SAMPLE, true); // byte rate
  v.setUint16(32, channels * BYTES_PER_SAMPLE, true); // block align
  v.setUint16(34, 32, true); // bits per sample
  ascii(36, 'data');
  v.setUint32(40, dataBytes, true);
  return h;
}

export interface WavInfo {
  sampleRate: number;
  channels: number;
  sampleCount: number; // frames per channel
  dataOffset: number;
}

/** Parse the canonical float32 WAV header written by `wavFloat32Header`. */
export function parseWavFloat32Header(bytes: Uint8Array): WavInfo {
  if (bytes.byteLength < WAV_HEADER_BYTES) throw new Error('wav: header truncated');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (off: number): string => String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || tag(12) !== 'fmt ' || tag(36) !== 'data') {
    throw new Error('wav: not a RIFF/WAVE file');
  }
  const format = v.getUint16(20, true);
  const channels = v.getUint16(22, true);
  const sampleRate = v.getUint32(24, true);
  const bits = v.getUint16(34, true);
  if (format !== 3 || bits !== 32) throw new Error('wav: expected 32-bit float PCM');
  if (channels < 1) throw new Error('wav: no channels');
  const dataBytes = v.getUint32(40, true);
  const sampleCount = Math.floor(dataBytes / (channels * BYTES_PER_SAMPLE));
  return { sampleRate, channels, sampleCount, dataOffset: WAV_HEADER_BYTES };
}

/**
 * Ask the demux worker to decode the source audio track, resample it to
 * 16 kHz mono and write `outPath` (WAV) into OPFS. Audio is capped at
 * `maxDurationSec` (the video duration) so the transcript never runs past it.
 */
export async function extractAudioTrack(
  demux: Pick<RpcClient<DemuxWorker>, 'request'>,
  opts: { sourceOpfsPath: string; opfsPath: string; maxDurationSec: number; onProgress?: (pct: number) => void },
): Promise<AudioTrack> {
  const res = await demux.request(
    'demux.extractAudio',
    {
      sourceOpfsPath: opts.sourceOpfsPath,
      outPath: opts.opfsPath,
      sampleRate: ASR_SAMPLE_RATE,
      maxDurationSec: opts.maxDurationSec,
    },
    {
      // Decoding a long file takes minutes; only a stall should time out.
      resetOnProgress: true,
      timeoutMs: 60_000,
      onProgress: opts.onProgress ? (p) => opts.onProgress!(p.pct) : undefined,
    },
  );
  return { opfsPath: res.opfsPath, durationSec: res.durationSec, sampleRate: ASR_SAMPLE_RATE };
}
