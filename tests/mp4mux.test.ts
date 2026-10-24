/**
 * Mux spike suite (SPEC §8.1, §8.10): proves the mp4box parse → window →
 * mux → ffprobe-validated pipeline in Node, independent of the browser.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import {
  encodeFramerateFromPts,
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
} from '../src/core/mp4Parse';
import {
  aacAccessUnitFrames,
  buildEsdDescriptor,
  extractAscFromDescriptor,
  muxToMp4,
  type MuxSample,
} from '../src/core/mp4Mux';

const nodeRequire = createRequire(import.meta.url);
const ffmpegPath: string = nodeRequire('@ffmpeg-installer/ffmpeg').path;
const ffprobePath: string = nodeRequire('@ffprobe-installer/ffprobe').path;

const DIR = '/tmp/spike';
const FRONT = `${DIR}/out_front.mp4`;
const END = `${DIR}/out_end.mp4`;
const LONG = `${DIR}/out_long.mp4`;
const MUXED = `${DIR}/out_muxed.mp4`;
const CUT = `${DIR}/out_cut.mp4`;

function genFixture(out: string, duration: number, faststart: boolean): void {
  const args = [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=320x240:rate=25:duration=${duration}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:sample_rate=44100:duration=${duration}`,
    '-ac',
    '2',
    '-c:v',
    'libx264',
    '-profile:v',
    'high',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '25',
    '-bf',
    '0',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
  ];
  if (faststart) args.push('-movflags', '+faststart');
  args.push(out);
  const r = spawnSync(ffmpegPath, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg fixture failed: ${r.stderr}`);
}

beforeAll(() => {
  mkdirSync(DIR, { recursive: true });
  if (!existsSync(FRONT)) genFixture(FRONT, 1, true);
  if (!existsSync(END)) genFixture(END, 1, false);
  if (!existsSync(LONG)) genFixture(LONG, 16, false);
}, 120_000);

function readerFor(absPath: string): ByteRangeReader {
  const buf = readFileSync(absPath);
  return async (offset, length) => new Uint8Array(buf.subarray(offset, offset + length));
}

interface Loaded {
  parsed: ParsedMp4;
  moovBytes: Uint8Array;
  moovOffset: number;
  reader: ByteRangeReader;
}

async function load(path: string): Promise<Loaded> {
  const size = statSync(path).size;
  const reader = readerFor(path);
  const moov = await locateMoov(reader, size);
  expect(moov, `moov not found in ${path}`).not.toBeNull();
  const loc = moov!;
  const moovBytes = await reader(loc.offset, loc.size);
  const parsed = parseMoovBytes(moovBytes, loc.offset);
  return { parsed, moovBytes, moovOffset: loc.offset, reader };
}

function contentOf(file: Loaded, box: { start?: number; size?: number; hdr_size?: number }): Uint8Array {
  const start = (box.start ?? 0) + (box.hdr_size ?? 0);
  const size = (box.size ?? 0) - (box.hdr_size ?? 0);
  const rel = start - file.moovOffset;
  return file.moovBytes.subarray(rel, rel + size);
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  channels?: number;
  sample_rate?: string;
  duration?: string;
}
interface Probe {
  streams: ProbeStream[];
  format: { duration: string };
}

function ffprobe(file: string): Probe {
  const r = spawnSync(ffprobePath, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], {
    encoding: 'utf8',
  });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as Probe;
}

function expectCleanDecode(file: string): void {
  const r = spawnSync(ffmpegPath, ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
}

function topLevelBoxes(absPath: string): { type: string; start: number; size: number }[] {
  const buf = readFileSync(absPath);
  const out: { type: string; start: number; size: number }[] = [];
  let pos = 0;
  while (pos + 8 <= buf.length) {
    const size = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    if (size < 8) break;
    out.push({ type, start: pos, size });
    pos += size;
  }
  return out;
}

describe('moov location (front + back layouts)', () => {
  it('finds moov at the front of a faststart file', async () => {
    const size = statSync(FRONT).size;
    const loc = await locateMoov(readerFor(FRONT), size);
    expect(loc).not.toBeNull();
    expect(loc!.offset).toBeLessThan(1024); // right behind ftyp
    const head = await readerFor(FRONT)(loc!.offset, 8);
    expect(String.fromCharCode(head[4], head[5], head[6], head[7])).toBe('moov');
  });

  it('finds moov at the end, after mdat', async () => {
    const size = statSync(END).size;
    const loc = await locateMoov(readerFor(END), size);
    expect(loc).not.toBeNull();
    expect(loc!.offset).toBeGreaterThan(size / 2);
    const head = await readerFor(END)(loc!.offset, 8);
    expect(String.fromCharCode(head[4], head[5], head[6], head[7])).toBe('moov');
  });
});

describe('SourceMeta-grade metadata extraction (§8.1)', () => {
  it('parses tracks, codecs, timescales, tables and frame rate', async () => {
    const f = await load(FRONT);
    const p = f.parsed;
    expect(p.fragmented).toBe(false);
    expect(p.durationSec).toBeCloseTo(1.0, 2);

    const v = p.video;
    expect(v).toBeDefined();
    expect(v!.codec).toMatch(/^avc1\.64[0-9a-f]{4}$/i); // High profile
    expect(v!.width).toBe(320);
    expect(v!.height).toBe(240);
    expect(v!.timescale).toBe(12800);
    expect(v!.table).toBeDefined();
    expect(v!.table!.count).toBe(25); // 1s @ 25fps
    expect(frameRateOf(v!, p.durationSec)).toBe(25);
    expect(v!.stsdEntry?.avcC ?? v!.stsdEntry?.boxes?.find((b) => b.type === 'avcC')).toBeDefined();

    const a = p.audio;
    expect(a).toBeDefined();
    expect(a!.codec).toBe('mp4a.40.2');
    expect(a!.timescale).toBe(44100);
    expect(a!.sampleRate).toBe(44100);
    expect(a!.channelCount).toBe(2);
    expect(a!.table!.count).toBeGreaterThanOrEqual(40);
    expect(a!.table!.count).toBeLessThanOrEqual(45);
    const esds = a!.stsdEntry?.esds ?? a!.stsdEntry?.boxes?.find((b) => b.type === 'esds');
    expect(esds).toBeDefined();
    const asc = extractAscFromDescriptor(contentOf(f, esds!));
    expect(asc).not.toBeNull();
    expect(asc!.byteLength).toBeGreaterThanOrEqual(2);
  });

  it('parses a back-of-file moov to the same key values', async () => {
    const f = await load(END);
    const v = f.parsed.video;
    expect(v).toBeDefined();
    expect(v!.table!.count).toBe(25);
    expect(v!.timescale).toBe(12800);
    expect(f.parsed.durationSec).toBeCloseTo(1.0, 2);
    expect(f.parsed.audio!.codec).toBe('mp4a.40.2');
  });
});

describe('sample tables + cut-window math (§8.2)', () => {
  it('maps sample offsets exactly onto mdat and cuts [5,15) correctly', async () => {
    const f = await load(LONG);
    const v = f.parsed.video!;
    const a = f.parsed.audio!;
    expect(v.table!.count).toBe(400); // 16s @ 25fps

    const mdat = topLevelBoxes(LONG).find((b) => b.type === 'mdat');
    expect(mdat).toBeDefined();
    const payloadStart = mdat!.start + 8;
    const payloadEnd = mdat!.start + mdat!.size;
    const all = [...v.table!.offsets.map((o, i) => o + v.table!.sizes[i]), ...a.table!.offsets.map((o, i) => o + a.table!.sizes[i])];
    const minOff = Math.min(...v.table!.offsets, ...a.table!.offsets);
    const maxEnd = Math.max(...all);
    expect(minOff).toBeGreaterThanOrEqual(payloadStart);
    expect(maxEnd).toBeLessThanOrEqual(payloadEnd);
    expect(maxEnd).toBe(payloadEnd); // samples fill mdat exactly

    // monotonic offsets, positive sizes
    for (let i = 1; i < v.table!.count; i++) {
      expect(v.table!.offsets[i]).toBeGreaterThanOrEqual(
        v.table!.offsets[i - 1] + v.table!.sizes[i - 1],
      );
    }
    expect(v.table!.sizes.every((s) => s > 0)).toBe(true);

    // window math
    const { from, to } = sampleRangeForWindow(v, 5, 15);
    expect(v.table!.sync[from]).toBe(true);
    expect(from).toBeLessThanOrEqual(sampleIndexAtTime(v.table!, v.timescale, 5));
    expect(to).toBeGreaterThan(from);
    expect(v.table!.pts[to - 1]).toBeLessThan(15 * v.timescale);
    expect(sampleIndexAtTime(v.table!, v.timescale, 0)).toBe(0);
    expect(sampleIndexAtTime(v.table!, v.timescale, v.table!.pts[100] / v.timescale)).toBe(100);
    expect(sampleIndexAtTime(v.table!, v.timescale, 999)).toBe(v.table!.count - 1);
    expect(lastSyncIndexBefore(v.table!, 100)).toBeLessThanOrEqual(100);
    for (let i = 1; i < v.table!.count; i++) {
      expect(v.table!.pts[i]).toBeGreaterThanOrEqual(v.table!.pts[i - 1]); // B-free
    }
  });

  it('anchors cuts that start mid-GOP on the nearest sync sample (WebCodecs requires a key frame first)', async () => {
    const f = await load(LONG);
    const v = f.parsed.video!;
    const table = v.table!;

    // The reported bug: a cut starting at a non-sync sample must decode from
    // the key frame at-or-before it — the first chunk after configure() (and
    // after any flush) has to be typed 'key' or Chrome throws
    // "A key frame is required after configure() or flush()".
    const deltaSamples: number[] = [];
    for (let i = 1; i < table.count; i++) if (!table.sync[i]) deltaSamples.push(i);
    expect(deltaSamples.length).toBeGreaterThan(100); // fixture is mostly inter frames

    const quarter = (q: number): number => deltaSamples[Math.floor(q * deltaSamples.length)];
    for (const i of [quarter(0.1), quarter(0.35), quarter(0.6), quarter(0.9)]) {
      // Start inside sample i (mid-frame epsilon keeps sampleIndexAtTime exact).
      const start = (table.pts[i] + 256) / v.timescale;
      const idx = sampleIndexAtTime(table, v.timescale, start);
      expect(idx).toBe(i);
      expect(table.sync[idx]).toBe(false); // the cut point itself is a delta frame

      const end = start + 2;
      const { from, to } = sampleRangeForWindow(v, start, end);
      expect(table.sync[from]).toBe(true); // first decoded chunk = key frame
      expect(from).toBeLessThanOrEqual(idx); // anchored at-or-before the cut …
      expect(from).toBe(lastSyncIndexBefore(table, idx)); // … and it is the nearest
      expect(to).toBeGreaterThan(idx); // window still covers the cut
      expect(table.pts[to - 1]).toBeLessThan(end * v.timescale); // end bound exact
      if (to < table.count) expect(table.pts[to]).toBeGreaterThanOrEqual(end * v.timescale);

      // Samples between the anchor and the cut are decoded but discarded by
      // the demux worker until frame.timestamp >= start (frame-accurate edge).
      for (let k = from + 1; k < idx; k++) expect(table.sync[k]).toBe(false); // …strictly after it, all deltas
    }
  });
});

function videoSamplesFor(
  file: Loaded,
  track: ParsedTrack,
  from: number,
  to: number,
  baseDts: number,
): MuxSample[] {
  const table = track.table!;
  const out: MuxSample[] = [];
  for (let i = from; i < to; i++) {
    const dts = table.dts[i] - baseDts;
    const nextDts = i + 1 < table.count ? table.dts[i + 1] : table.dts[i] + track.timescale / 25;
    out.push({
      data: readSync(file, table.offsets[i], table.sizes[i]),
      dts,
      cts: table.pts[i] - baseDts,
      duration: Math.max(1, nextDts - table.dts[i]),
      isSync: table.sync[i],
    });
  }
  return out;
}

function readSync(file: Loaded, offset: number, length: number): Uint8Array {
  // readerFor's backing buffer is fully loaded; perform a sync slice via the
  // already-opened handle is impossible in sync context, so cache lazily:
  const cached = readCache.get(file);
  if (!cached) throw new Error('reader cache missing');
  return cached.subarray(offset, offset + length);
}

const readCache = new WeakMap<Loaded, Buffer>();
function cacheFile(path: string, file: Loaded): void {
  readCache.set(file, readFileSync(path));
}

function audioOverlapSamples(
  file: Loaded,
  track: ParsedTrack,
  startSec: number,
  endSec: number,
): MuxSample[] {
  const table = track.table!;
  const out: MuxSample[] = [];
  let base = -1;
  const pick: number[] = [];
  for (let i = 0; i < table.count; i++) {
    const dur = i + 1 < table.count ? table.dts[i + 1] - table.dts[i] : track.durationSamples - table.dts[i];
    const sec = table.pts[i] / track.timescale;
    const durSec = dur / track.timescale;
    if (sec + durSec > startSec && sec < endSec) pick.push(i);
  }
  if (pick.length > 0) base = table.dts[pick[0]];
  for (const i of pick) {
    const dur = i + 1 < table.count ? table.dts[i + 1] - table.dts[i] : track.durationSamples - table.dts[i];
    out.push({
      data: readSync(file, table.offsets[i], table.sizes[i]),
      dts: table.dts[i] - base,
      cts: table.pts[i] - base,
      duration: dur,
      isSync: true,
    });
  }
  return out;
}

describe('muxToMp4 (§8.10, mp4box as the only muxer)', () => {
  it('muxes a full clip → ffprobe-validated H.264 + AAC with clean decode', async () => {
    const f = await load(FRONT);
    cacheFile(FRONT, f);
    const v = f.parsed.video!;
    const a = f.parsed.audio!;
    const avcC = f.parsed.video!.stsdEntry?.avcC ?? f.parsed.video!.stsdEntry!.boxes!.find((b) => b.type === 'avcC')!;
    const esds = a.stsdEntry?.esds ?? a.stsdEntry!.boxes!.find((b) => b.type === 'esds')!;
    const asc = extractAscFromDescriptor(contentOf(f, esds));
    expect(asc).not.toBeNull();

    const audioSamples: MuxSample[] = [];
    const table = a.table!;
    for (let i = 0; i < table.count; i++) {
      const dur = i + 1 < table.count ? table.dts[i + 1] - table.dts[i] : 1024;
      audioSamples.push({
        data: readSync(f, table.offsets[i], table.sizes[i]),
        dts: table.dts[i],
        cts: table.pts[i],
        duration: dur,
        isSync: true,
      });
    }

    const mp4 = muxToMp4({
      video: {
        codecType: 'avc1',
        width: 320,
        height: 240,
        timescale: v.timescale,
        avcDecoderConfigRecord: contentOf(f, avcC),
        samples: videoSamplesFor(f, v, 0, v.table!.count, 0),
      },
      audio: {
        codecType: 'mp4a',
        sampleRate: a.sampleRate ?? 44100,
        channelCount: a.channelCount ?? 2,
        sampleSize: 16,
        timescale: a.timescale,
        esdsDescriptor: buildEsdDescriptor(asc!),
        samples: audioSamples,
      },
    });
    expect(mp4.byteLength).toBeGreaterThan(10_000);
    writeFileSync(MUXED, mp4);

    const probe = ffprobe(MUXED);
    expect(probe.streams).toHaveLength(2);
    const vs = probe.streams.find((s) => s.codec_type === 'video');
    const as = probe.streams.find((s) => s.codec_type === 'audio');
    expect(vs?.codec_name).toBe('h264');
    expect(vs?.width).toBe(320);
    expect(vs?.height).toBe(240);
    expect(as?.codec_name).toBe('aac');
    expect(as?.channels).toBe(2);
    expect(Number(probe.format.duration)).toBeCloseTo(1.0, 1);
    expectCleanDecode(MUXED);
  }, 60_000);

  it('muxes cut window [5,15) of a 16s source → ~10s clip, clean decode', async () => {
    const f = await load(LONG);
    cacheFile(LONG, f);
    const v = f.parsed.video!;
    const a = f.parsed.audio!;

    // video samples presenting inside [5,15) (decoder-window filter equivalent)
    const startUs = 5 * v.timescale;
    const endUs = 15 * v.timescale;
    let first = sampleIndexAtTime(v.table!, v.timescale, 5);
    while (first < v.table!.count && v.table!.pts[first] < startUs) first++;
    let last = first;
    while (last < v.table!.count && v.table!.pts[last] < endUs) last++;
    expect(last - first).toBe(250); // 10s @ 25fps

    const avcC = v.stsdEntry?.avcC ?? v.stsdEntry!.boxes!.find((b) => b.type === 'avcC')!;
    const esds = a.stsdEntry?.esds ?? a.stsdEntry!.boxes!.find((b) => b.type === 'esds')!;
    const asc = extractAscFromDescriptor(contentOf(f, esds));
    expect(asc).not.toBeNull();

    const mp4 = muxToMp4({
      video: {
        codecType: 'avc1',
        width: 320,
        height: 240,
        timescale: v.timescale,
        avcDecoderConfigRecord: contentOf(f, avcC),
        samples: videoSamplesFor(f, v, first, last, v.table!.dts[first]),
      },
      audio: {
        codecType: 'mp4a',
        sampleRate: a.sampleRate ?? 44100,
        channelCount: a.channelCount ?? 2,
        sampleSize: 16,
        timescale: a.timescale,
        esdsDescriptor: buildEsdDescriptor(asc!),
        samples: audioOverlapSamples(f, a, 5, 15),
      },
    });
    writeFileSync(CUT, mp4);

    const probe = ffprobe(CUT);
    expect(probe.streams).toHaveLength(2);
    expect(probe.streams.find((s) => s.codec_type === 'video')?.codec_name).toBe('h264');
    expect(probe.streams.find((s) => s.codec_type === 'audio')?.codec_name).toBe('aac');
    const dur = Number(probe.format.duration);
    expect(dur).toBeGreaterThan(9.8);
    expect(dur).toBeLessThan(10.3);
    expectCleanDecode(CUT);
  }, 60_000);

  it('derives duration from source pts — invariant to a wrong fps/timescale guess (§8.10 regression)', async () => {
    // Regression for the "export is exactly 2× the cut" bug: render.worker
    // stamps encoded frames with the decoded SOURCE pts (µs) and converts
    // µs → track units via `us * TS / 1e6`. Even when frameRateOf() guesses
    // a wrong fps (modelled here: TS = 12500 as if 12.5fps for a 25fps
    // source), the muxed duration must equal the real pts span — index/fps
    // arithmetic (i / fps) would come out 2× with the same TS.
    const f = await load(LONG);
    cacheFile(LONG, f);
    const v = f.parsed.video!;
    const table = v.table!;
    const { from, to } = sampleRangeForWindow(v, 5, 15);
    expect(from).toBe(125); // 5.0s keyframe anchor
    expect(to).toBe(375); // 15.0s exclusive

    const WRONG_TS = 12500; // fps guess = 12.5 while source really runs 25
    const ptsUs = (i: number): number => Math.round((table.pts[i] * 1_000_000) / v.timescale);
    const baseUs = ptsUs(from);
    const stepUs = Math.round(1_000_000 / 25); // real frame cadence for the final sample
    const samples: MuxSample[] = [];
    for (let i = from; i < to; i++) {
      const dtsUs = ptsUs(i);
      const nextUs = i + 1 < to ? ptsUs(i + 1) : dtsUs + stepUs;
      samples.push({
        data: readSync(f, table.offsets[i], table.sizes[i]),
        dts: Math.round(((dtsUs - baseUs) * WRONG_TS) / 1_000_000),
        cts: Math.round(((dtsUs - baseUs) * WRONG_TS) / 1_000_000),
        duration: Math.max(1, Math.round(((nextUs - dtsUs) * WRONG_TS) / 1_000_000)),
        isSync: table.sync[i],
      });
    }
    const expectedSec = (ptsUs(to - 1) + stepUs - baseUs) / 1_000_000;
    expect(expectedSec).toBeCloseTo(10.0, 1);

    const avcC = v.stsdEntry?.avcC ?? v.stsdEntry!.boxes!.find((b) => b.type === 'avcC')!;
    const mp4 = muxToMp4({
      video: {
        codecType: 'avc1',
        width: v.width ?? 320,
        height: v.height ?? 240,
        timescale: WRONG_TS,
        avcDecoderConfigRecord: contentOf(f, avcC),
        samples,
      },
    });
    const out = `${DIR}/out_pts_invariance.mp4`;
    writeFileSync(out, mp4);
    const dur = Number(ffprobe(out).format.duration);
    expect(dur).toBeCloseTo(expectedSec, 1); // 10.0s, NOT ~20s
  }, 60_000);

  it('caps audio at the video span and writes every duration box (raw bytes)', async () => {
    // muxToMp4 must land its duration sets on every box (mp4box leaves them
    // at 0 otherwise). Video is the MASTER CLOCK: the fixture's AAC tail
    // (16.0178s) overhangs the 16.0s video, so audio must be truncated to
    // exactly the video span and mvhd.duration = video duration — audio
    // metadata can never decide how long the file is.
    const f = await load(LONG);
    cacheFile(LONG, f);
    const v = f.parsed.video!;
    const a = f.parsed.audio!;
    const avcC = v.stsdEntry?.avcC ?? v.stsdEntry!.boxes!.find((b) => b.type === 'avcC')!;

    const videoSamples = videoSamplesFor(f, v, 0, v.table!.count, v.table!.dts[0]);
    const audioSamples = audioOverlapSamples(f, a, 0, 16.5);
    const expVideo = videoSamples.reduce((acc, x) => acc + x.duration, 0);
    const expAudioRaw = audioSamples.reduce((acc, x) => acc + x.duration, 0);
    const capLimit = Math.floor((expVideo / v.timescale) * a.timescale);
    expect(expVideo / v.timescale).toBeCloseTo(16.0, 3);
    expect(expAudioRaw).toBeGreaterThan(capLimit); // fixture overhangs on purpose

    const mp4 = muxToMp4({
      video: {
        codecType: 'avc1',
        width: v.width ?? 320,
        height: v.height ?? 240,
        timescale: v.timescale,
        avcDecoderConfigRecord: contentOf(f, avcC),
        samples: videoSamples,
      },
      audio: {
        codecType: 'mp4a',
        sampleRate: a.sampleRate ?? 44100,
        channelCount: a.channelCount ?? 2,
        sampleSize: 16,
        timescale: a.timescale,
        esdsDescriptor: new Uint8Array(
          contentOf(f, a.stsdEntry?.esds ?? a.stsdEntry!.boxes!.find((b) => b.type === 'esds')!),
        ),
        samples: audioSamples,
      },
    });
    const out = `${DIR}/out_duration_boxes.mp4`;
    writeFileSync(out, mp4);
    const buf = readFileSync(out);

    // Nested box walker for the three duration-bearing boxes (v0 layouts).
    const find = (type: string): number[] => {
      const acc: number[] = [];
      const walk = (from: number, end: number): void => {
        let pos = from;
        while (pos + 8 <= end) {
          const size = buf.readUInt32BE(pos);
          const t = buf.toString('latin1', pos + 4, pos + 8);
          if (size < 8) break;
          if (t === type) acc.push(pos);
          if (['moov', 'trak', 'mdia'].includes(t)) walk(pos + 8, pos + size);
          pos += size;
        }
      };
      walk(0, buf.length);
      return acc;
    };

    const mv = find('mvhd')[0];
    const mvTs = buf.readUInt32BE(mv + 20);
    const mvDur = buf.readUInt32BE(mv + 24);
    const tks = find('tkhd');
    const mds = find('mdhd');
    const tk0 = buf.readUInt32BE(tks[0] + 28);
    const tk1 = buf.readUInt32BE(tks[1] + 28);
    const md0Ts = buf.readUInt32BE(mds[0] + 20);
    const md0Dur = buf.readUInt32BE(mds[0] + 24);
    const md1Ts = buf.readUInt32BE(mds[1] + 20);
    const md1Dur = buf.readUInt32BE(mds[1] + 24);

    expect(mvTs).toBe(v.timescale); // mvhd adopts the first track's timescale
    expect(md0Ts).toBe(v.timescale);
    expect(md0Dur).toBe(expVideo); // media duration = Σ sample durations
    expect(md1Ts).toBe(a.timescale);
    expect(md1Dur).toBe(capLimit); // audio mdhd capped exactly at the video span
    const expTk0 = Math.round((expVideo * mvTs) / v.timescale);
    const expTk1 = Math.round((capLimit * mvTs) / a.timescale);
    expect(tk0).toBe(expTk0);
    expect(tk1).toBe(expTk1);
    expect(expTk1).toBeLessThanOrEqual(expTk0); // audio never outlives video
    expect(mvDur).toBe(expTk0); // mvhd = video track duration, exactly
    expect(mvDur / mvTs).toBeCloseTo(16.0, 1);
  }, 60_000);

  it('locks the player timeline to the video pts span even when audio claims 1.6× more', async () => {
    // Reported bug (nuclear-option spec): a 44.08s cut exported with a 2:18
    // / 3.13× player timeline — the audio track hijacked the container
    // duration. Model it with the fixture's FULL 16.02s audio beside a 10s
    // video window: whatever the audio samples claim, every duration source
    // in the output must read 10.0s.
    const f = await load(LONG);
    cacheFile(LONG, f);
    const v = f.parsed.video!;
    const a = f.parsed.audio!;
    const { from, to } = sampleRangeForWindow(v, 5, 15);
    expect(to - from).toBe(250);
    const avcC = v.stsdEntry?.avcC ?? v.stsdEntry!.boxes!.find((b) => b.type === 'avcC')!;
    const esds = a.stsdEntry?.esds ?? a.stsdEntry!.boxes!.find((b) => b.type === 'esds')!;

    const videoSamples = videoSamplesFor(f, v, from, to, v.table!.dts[from]);
    const expVideo = videoSamples.reduce((acc, x) => acc + x.duration, 0);
    expect(expVideo / v.timescale).toBeCloseTo(10.0, 3);
    const audioSamples = audioOverlapSamples(f, a, 0, 16.5); // full track ≈ 16.02s
    const rawAudioSec =
      audioSamples.reduce((acc, x) => acc + x.duration, 0) / a.timescale;
    expect(rawAudioSec).toBeGreaterThan(1.5 * (expVideo / v.timescale)); // >1.6× the video

    const mp4 = muxToMp4({
      video: {
        codecType: 'avc1',
        width: v.width ?? 320,
        height: v.height ?? 240,
        timescale: v.timescale,
        avcDecoderConfigRecord: contentOf(f, avcC),
        samples: videoSamples,
      },
      audio: {
        codecType: 'mp4a',
        sampleRate: a.sampleRate ?? 44100,
        channelCount: a.channelCount ?? 2,
        sampleSize: 16,
        timescale: a.timescale,
        esdsDescriptor: new Uint8Array(contentOf(f, esds)),
        samples: audioSamples,
      },
    });
    const out = `${DIR}/out_audio_cap.mp4`;
    writeFileSync(out, mp4);

    const probe = ffprobe(out);
    expect(probe.streams).toHaveLength(2);
    const vs = probe.streams.find((s) => s.codec_type === 'video')!;
    const as = probe.streams.find((s) => s.codec_type === 'audio')!;
    const total = Number(probe.format.duration);
    const vDur = Number(vs.duration);
    const aDur = Number(as.duration);
    // Container, video track, and audio track ALL read the video pts span —
    // no inflated timeline is possible, whatever the source metadata claims.
    expect(total).toBeCloseTo(10.0, 2);
    expect(vDur).toBeCloseTo(10.0, 2);
    expect(aDur).toBeCloseTo(10.0, 2);
    expect(Math.abs(aDur - vDur)).toBeLessThan(0.05);
    expectCleanDecode(out);
  }, 60_000);
});

describe('audio timing from PCM frame counts (stts-independent, §8.10 regression)', () => {
  it('derives frames-per-access-unit from the ASC: 1024 / 960 / SBR ×2, safe defaults', async () => {
    // Real AAC-LC ASC from the fixture esds → 1024.
    const f = await load(LONG);
    const a = f.parsed.audio!;
    const esds = a.stsdEntry?.esds ?? a.stsdEntry!.boxes!.find((b) => b.type === 'esds')!;
    const asc = extractAscFromDescriptor(contentOf(f, esds));
    expect(asc).not.toBeNull();
    expect(aacAccessUnitFrames(asc)).toBe(1024);

    // Hand-assembled AudioSpecificConfig bitstreams:
    // AAC-LC 44.1kHz stereo, frameLengthFlag = 1 → 960; flag 0 → 1024.
    expect(aacAccessUnitFrames(new Uint8Array([0x12, 0x14]))).toBe(960);
    expect(aacAccessUnitFrames(new Uint8Array([0x12, 0x10]))).toBe(1024);
    // Explicit SBR (AOT 5, extension 44.1k / core 22.05k): ×2 output frames.
    expect(aacAccessUnitFrames(new Uint8Array([0x2a, 0x10, 0x9c, 0x00]))).toBe(2048);
    // Unparseable input falls back to the AAC-LC default — never to stts.
    expect(aacAccessUnitFrames(null)).toBe(1024);
    expect(aacAccessUnitFrames(new Uint8Array([0xff]))).toBe(1024);
  });

  it('plans the cut window and part timing from packet index alone (a broken stts cannot inflate it)', () => {
    const RATE = 44100;
    const FL = 1024;
    const COUNT = Math.ceil((16 * RATE) / FL); // packets a 16s AAC-LC track holds
    const plan = planRemuxAudio(COUNT, FL, RATE, 5, 15);
    expect(plan).not.toBeNull();

    // Packet i occupies [i·FL/RATE, (i+1)·FL/RATE): first packet overlapping
    // 5s starts at 4.992s (ends 5.016s), last packet starting below 15s at
    // 14.977s — 431 packets ≈ 10.008s of audio for the 10s video window.
    expect(plan!.indices[0]).toBe(215);
    expect(plan!.indices[plan!.indices.length - 1]).toBe(645);
    expect(plan!.indices.length).toBe(431);
    expect(plan!.timescale).toBe(RATE);

    // Contiguous, fixed-size parts rebased to the window start — the mux
    // receives span = n·FL/RATE (10.008s) regardless of what any source
    // stts box claims, and durations are already in the track timescale.
    expect(plan!.parts[0]).toEqual({ dts: 0, cts: 0, duration: FL });
    expect(plan!.parts[plan!.parts.length - 1].dts).toBe(430 * FL);
    const span = (plan!.indices.length * FL) / RATE;
    expect(span).toBeGreaterThan(10.0);
    expect(span).toBeLessThan(10.02);

    // Window beyond the track → no packets (render then drops the audio track).
    expect(planRemuxAudio(COUNT, FL, RATE, 20, 30)).toBeNull();
  });

  it('muxes planned audio beside the video window → track spans match, mvhd sane', async () => {
    const f = await load(LONG);
    cacheFile(LONG, f);
    const v = f.parsed.video!;
    const a = f.parsed.audio!;
    const { from, to } = sampleRangeForWindow(v, 5, 15);
    expect(to - from).toBe(250); // 10s @ 25fps

    const avcC = v.stsdEntry?.avcC ?? v.stsdEntry!.boxes!.find((b) => b.type === 'avcC')!;
    const esds = a.stsdEntry?.esds ?? a.stsdEntry!.boxes!.find((b) => b.type === 'esds')!;
    const asc = extractAscFromDescriptor(contentOf(f, esds));
    expect(asc).not.toBeNull();
    const rate = a.sampleRate ?? 44100;

    const plan = planRemuxAudio(a.table!.count, aacAccessUnitFrames(asc), rate, 5, 15)!;
    expect(plan).not.toBeNull();
    // Healthy fixture: stts selection and frame-count selection agree packet
    // for packet (uniform 1024-unit deltas) — the new path only differs when
    // the source metadata is broken.
    expect(plan.indices.length).toBe(audioOverlapSamples(f, a, 5, 15).length);

    const audioSamples: MuxSample[] = plan.indices.map((idx, k) => ({
      data: readSync(f, a.table!.offsets[idx], a.table!.sizes[idx]),
      ...plan.parts[k],
      isSync: true,
    }));

    const mp4 = muxToMp4({
      video: {
        codecType: 'avc1',
        width: v.width ?? 320,
        height: v.height ?? 240,
        timescale: v.timescale,
        avcDecoderConfigRecord: contentOf(f, avcC),
        samples: videoSamplesFor(f, v, from, to, v.table!.dts[from]),
      },
      audio: {
        codecType: 'mp4a',
        sampleRate: rate,
        channelCount: a.channelCount ?? 2,
        sampleSize: 16,
        timescale: plan.timescale, // sample rate — part units map 1:1
        esdsDescriptor: buildEsdDescriptor(asc!),
        samples: audioSamples,
      },
    });
    const out = `${DIR}/out_audio_plan.mp4`;
    writeFileSync(out, mp4);

    const probe = ffprobe(out);
    expect(probe.streams).toHaveLength(2);
    const vs = probe.streams.find((s) => s.codec_type === 'video')!;
    const as = probe.streams.find((s) => s.codec_type === 'audio')!;
    // Audio span (Σ 1024 PCM frames @ sampleRate per packet) matches the
    // video pts span — and muxToMp4 caps audio at video regardless, so the
    // container duration can no longer be blown out by broken stts.
    const vDur = Number(vs.duration);
    const aDur = Number(as.duration);
    expect(aDur).toBeGreaterThan(9.95);
    expect(Math.abs(aDur - vDur)).toBeLessThan(0.1);
    const total = Number(probe.format.duration);
    expect(total).toBeGreaterThan(9.95);
    expect(total).toBeLessThan(10.15);
    expectCleanDecode(out);
  }, 60_000);
});

describe('duration timeline = stts pts span (poisoned-mdhd regression, §8.10)', () => {
  it('ignores an mdhd that claims 2× the stts span for durationSec and frameRateOf', async () => {
    // Observed on a real source: mdhd.duration overstated the sample table by
    // exactly 2×. durationSec feeds the UI timeline AND frameRateOf, whose
    // N/fps arithmetic is load-bearing in the FFmpeg fallback — a 2× mdhd
    // used to mean a 2× export (166.2s cut → 332s; 18.75s → 37.5s).
    const f = await load(LONG);
    const v = f.parsed.video!;
    const bytes = Buffer.from(f.moovBytes); // Buffer for BE reads + latin1 substrings

    // Locate the video track's mdhd (match by its distinct timescale) and
    // double its duration claim, leaving the stts box untouched.
    let mdhdPos = -1;
    const walk = (from: number, end: number): void => {
      let pos = from;
      while (pos + 8 <= end) {
        const size = bytes.readUInt32BE(pos);
        const t = bytes.toString('latin1', pos + 4, pos + 8);
        if (size < 8) break;
        if (t === 'mdhd' && bytes.readUInt32BE(pos + 20) === v.timescale) mdhdPos = pos;
        if (['moov', 'trak', 'mdia'].includes(t)) walk(pos + 8, pos + size);
        pos += size;
      }
    };
    walk(0, bytes.length);
    expect(mdhdPos).toBeGreaterThan(0);
    const origDur = bytes.readUInt32BE(mdhdPos + 24);
    expect(origDur / v.timescale).toBeCloseTo(16.0, 1);
    bytes.writeUInt32BE(origDur * 2, mdhdPos + 24);

    const p = parseMoovBytes(bytes, f.moovOffset);
    expect(p.video).toBeTruthy();
    // durationSec follows the sample table (16.0), not the poisoned mdhd (32.0)…
    expect(p.durationSec).toBeCloseTo(16.0, 1);
    expect(p.durationSec).toBeLessThan(20);
    // …so frameRateOf stays at the real 25 fps. Half of that (12.5) was the
    // multiplier that doubled N/fps-derived durations exactly.
    expect(frameRateOf(p.video!, p.durationSec)).toBe(25);
  });

  it('encodes the FFmpeg fallback at a pts-derived framerate (count/rate = cut length)', () => {
    // CFR sanity: 100 frames with a 40000µs step (25fps) → exactly 25.
    expect(encodeFramerateFromPts(0, 99 * 40_000, 100, 999)).toBeCloseTo(25, 6);

    // 30fps window of 18.75s: pts-derived rate ≈ 30, so image2 output
    // duration = count/rate ≈ 18.767s (span + one frame) — the old
    // N/frameRateOf(mdhd) arithmetic with a 2× mdhd would have used 15 and
    // produced 37.5s, exactly the reported bug.
    const count = 563;
    const last = (count - 1) * (1_000_000 / 30);
    const rate = encodeFramerateFromPts(0, last, count, 15);
    expect(rate).toBeCloseTo(30, 1);
    expect(count / rate).toBeCloseTo(18.7667, 3);

    // Degenerate inputs fall back to the provided fps (or 25 when absurd).
    expect(encodeFramerateFromPts(1000, 1000, 10, 30)).toBe(30); // zero span
    expect(encodeFramerateFromPts(0, 1000, 1, 30)).toBe(30); // single frame
    expect(encodeFramerateFromPts(Number.NaN, 1000, 10, 30)).toBe(30);
    expect(encodeFramerateFromPts(0, 0, 5, Number.NaN)).toBe(25); // absurd fallback
    // A valid pts span is trusted even when the fps fallback is absurd.
    expect(encodeFramerateFromPts(0, 99 * 40_000, 100, Number.NaN)).toBeCloseTo(25, 6);
  });
});

describe('ffmpeg fallback arg contract (§8.11 duration cap)', () => {
  const FB = `${DIR}/fallback`;

  it('never exceeds the cut: -t caps the container even with 2× audio (-shortest belt alongside)', () => {
    // Reproduces the reported fallback bug shape with the fallback's exact
    // input construction: image2 frames for 4s of video + a WAV twice as
    // long as the video (poisoned-stts PCM extraction). Without duration
    // flags the container follows the LONGEST stream → video ends at 4s and
    // freezes while the timeline runs to 8s — the reported 30s+30s freeze.
    mkdirSync(FB, { recursive: true });
    const first = `${FB}/f000001.jpg`;
    if (!existsSync(first)) {
      const gen = spawnSync(
        ffmpegPath,
        [
          '-y', '-v', 'error', '-f', 'lavfi',
          '-i', 'testsrc2=size=320x240:rate=25:duration=4',
          '-frames:v', '100',
          `${FB}/f%06d.jpg`,
        ],
        { encoding: 'utf8' },
      );
      expect(gen.status, gen.stderr).toBe(0);
    }
    const wav = `${FB}/a.wav`;
    if (!existsSync(wav)) {
      const gen = spawnSync(
        ffmpegPath,
        ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=8', '-ac', '2', wav],
        { encoding: 'utf8' },
      );
      expect(gen.status, gen.stderr).toBe(0);
    }
    const CUT = 4;

    const run = (out: string, args: string[]): Probe => {
      const r = spawnSync(ffmpegPath, args, { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      return ffprobe(out);
    };
    const baseInputs = ['-framerate', '25.000000', '-i', `${FB}/f%06d.jpg`, '-i', wav];
    const encode = [
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
    ];

    // Control: no duration flags → container = longest stream (8s) while
    // video is only 4s — the freeze pattern under test.
    const ctrl = run(`${FB}/out_none.mp4`, [...baseInputs, ...encode, '-movflags', '+faststart', `${FB}/out_none.mp4`]);
    expect(Number(ctrl.format.duration)).toBeGreaterThan(7.5);
    expect(Number(ctrl.streams.find((s) => s.codec_type === 'video')!.duration)).toBeLessThan(4.5);

    // '-t' alone must cap the container at the cut…
    const tOnly = run(`${FB}/out_t.mp4`, [...baseInputs, ...encode, '-t', CUT.toFixed(3), '-movflags', '+faststart', `${FB}/out_t.mp4`]);
    expect(Number(tOnly.format.duration)).toBeLessThan(CUT + 0.05);

    // …and the shipped argument set (-shortest + -t) caps every duration
    // source: container, video stream, audio stream.
    const shipped = run(`${FB}/out_ship.mp4`, [
      ...baseInputs,
      ...encode,
      '-shortest',
      '-t', CUT.toFixed(3),
      '-movflags', '+faststart',
      `${FB}/out_ship.mp4`,
    ]);
    expect(Number(shipped.format.duration)).toBeLessThan(CUT + 0.05);
    expect(Number(shipped.streams.find((s) => s.codec_type === 'video')!.duration)).toBeLessThan(CUT + 0.05);
    expect(Number(shipped.streams.find((s) => s.codec_type === 'audio')!.duration)).toBeLessThan(CUT + 0.05);
    expectCleanDecode(`${FB}/out_ship.mp4`);
  }, 120_000);
});
