import { describe, expect, it } from 'vitest';
import {
  ASR_SAMPLE_RATE,
  SincResampler,
  WAV_HEADER_BYTES,
  downmixToMono,
  parseWavFloat32Header,
  wavFloat32Header,
} from '../src/pipeline/audioExtract';

function sine(freq: number, rate: number, seconds: number, amp = 0.5): Float32Array {
  const n = Math.round(rate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

function resampleAll(input: Float32Array, inRate: number, outRate: number, chunk?: number): Float32Array {
  const r = new SincResampler(inRate, outRate);
  const parts: Float32Array[] = [];
  if (chunk === undefined) {
    parts.push(r.push(input));
  } else {
    for (let i = 0; i < input.length; i += chunk) parts.push(r.push(input.subarray(i, i + chunk)));
  }
  parts.push(r.flush());
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

describe('downmixToMono', () => {
  it('averages channels', () => {
    const l = Float32Array.from([1, 0, -1]);
    const r = Float32Array.from([0, 0, 1]);
    expect(Array.from(downmixToMono([l, r]))).toEqual([0.5, 0, 0]);
  });

  it('passes a mono plane through unchanged', () => {
    const m = Float32Array.from([0.1, 0.2]);
    expect(downmixToMono([m])).toBe(m);
  });

  it('rejects mismatched channel lengths', () => {
    expect(() => downmixToMono([new Float32Array(2), new Float32Array(3)])).toThrow(/length mismatch/);
  });
});

describe('WAV float32 header', () => {
  it('writes a canonical 44-byte IEEE float header', () => {
    const h = wavFloat32Header(1000, 16000, 1);
    expect(h.byteLength).toBe(WAV_HEADER_BYTES);
    const v = new DataView(h.buffer);
    const tag = (o: number) => String.fromCharCode(h[o], h[o + 1], h[o + 2], h[o + 3]);
    expect(tag(0)).toBe('RIFF');
    expect(tag(8)).toBe('WAVE');
    expect(tag(12)).toBe('fmt ');
    expect(tag(36)).toBe('data');
    expect(v.getUint16(20, true)).toBe(3); // IEEE float
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint32(28, true)).toBe(64000); // 16000 * 1 * 4
    expect(v.getUint16(32, true)).toBe(4);
    expect(v.getUint16(34, true)).toBe(32);
    expect(v.getUint32(40, true)).toBe(4000);
    expect(v.getUint32(4, true)).toBe(4036);
  });

  it('round-trips through the parser', () => {
    const info = parseWavFloat32Header(wavFloat32Header(16000, 16000, 1));
    expect(info).toEqual({ sampleRate: 16000, channels: 1, sampleCount: 16000, dataOffset: 44 });
  });

  it('rejects non-float or non-RIFF input', () => {
    const h = wavFloat32Header(10, 16000, 1);
    const pcm16 = h.slice();
    new DataView(pcm16.buffer).setUint16(20, 1, true);
    expect(() => parseWavFloat32Header(pcm16)).toThrow(/float/);
    const bad = h.slice();
    bad[0] = 0x58; // 'X'
    expect(() => parseWavFloat32Header(bad)).toThrow(/RIFF/);
    expect(() => parseWavFloat32Header(h.subarray(0, 20))).toThrow(/truncated/);
  });
});

describe('SincResampler', () => {
  it('produces the expected output length for 48 kHz → 16 kHz', () => {
    const input = sine(440, 48000, 2);
    const out = resampleAll(input, 48000, ASR_SAMPLE_RATE);
    expect(out.length).toBe(32000);
  });

  it('keeps DC at unity gain in the interior', () => {
    const input = new Float32Array(48000).fill(0.75);
    const out = resampleAll(input, 48000, 16000);
    for (let i = 100; i < out.length - 100; i++) expect(out[i]).toBeCloseTo(0.75, 3);
  });

  it('preserves a 1 kHz tone at 16 kHz amplitude', () => {
    const input = sine(1000, 48000, 1, 0.5);
    const out = resampleAll(input, 48000, 16000);
    let peak = 0;
    for (let i = 200; i < out.length - 200; i++) peak = Math.max(peak, Math.abs(out[i]));
    expect(peak).toBeGreaterThan(0.48);
    expect(peak).toBeLessThan(0.52);
  });

  it('suppresses content above the 16 kHz Nyquist (anti-aliasing)', () => {
    // 12 kHz would alias to 4 kHz at 16 kHz output if not filtered.
    const input = sine(12000, 48000, 1, 0.5);
    const out = resampleAll(input, 48000, 16000);
    let peak = 0;
    for (let i = 200; i < out.length - 200; i++) peak = Math.max(peak, Math.abs(out[i]));
    expect(peak).toBeLessThan(0.05);
  });

  it('gives identical output regardless of how input is chunked', () => {
    const input = sine(300, 44100, 1.3, 0.4);
    const oneShot = resampleAll(input, 44100, 16000);
    for (const chunk of [1, 7, 512, 4096]) {
      const streamed = resampleAll(input, 44100, 16000, chunk);
      expect(streamed.length).toBe(oneShot.length);
      expect(streamed).toEqual(oneShot);
    }
  });

  it('rejects push after flush', () => {
    const r = new SincResampler(48000, 16000);
    r.flush();
    expect(() => r.push(new Float32Array(4))).toThrow(/after flush/);
  });

  it('rejects non-positive rates', () => {
    expect(() => new SincResampler(0, 16000)).toThrow();
  });
});
