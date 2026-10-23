/**
 * Pure MP4 (ISO-BMFF) metadata parsing (SPEC §8.1) built on mp4box.js.
 *
 * mp4box's `appendBuffer` only parses when the FIRST buffer has
 * `fileStart === 0` and an `ftyp` precedes `moov`, so `parseMoovBytes`
 * prepends a synthetic 32-byte ftyp, parses, then rebases every box's
 * absolute `start` by (moovFileOffset − 32) to map back into the real file.
 */
import MP4Box, { type Mp4Box, type Mp4Buffer, type Mp4SampleEntry } from 'mp4box';
import { extractAscFromDescriptor } from './mp4Mux';

const SYNTH_FTYYP_LEN = 32;

/** Async byte-range reader over the source file (never the whole file). */
export type ByteRangeReader = (offset: number, length: number) => Promise<Uint8Array>;

/** Normalized sample tables for one track. Indexes are parallel arrays. */
export interface TrackSampleTable {
  count: number;
  /** Absolute file byte offset of each sample's payload. */
  offsets: number[];
  sizes: number[];
  /** Decode timestamps, media timescale units (monotonic). */
  dts: number[];
  /** Presentation timestamps, media timescale units. */
  pts: number[];
  /** Sync (key) samples. */
  sync: boolean[];
  /**
   * stts-derived media duration (Σ sample deltas) in track units — the
   * trustworthy timeline length. mdhd.duration is a separate claim that can
   * disagree (observed 2× off), so prefer this over mdhd everywhere.
   */
  durationUnits: number;
}

export interface ParsedTrack {
  kind: 'video' | 'audio';
  /** RFC 6381 codec string, e.g. `avc1.640028` / `mp4a.40.2`. */
  codec: string;
  width?: number;
  height?: number;
  sampleRate?: number;
  channelCount?: number;
  /** Media timescale (units per second). */
  timescale: number;
  /** Media duration in timescale units (stale `0` is tolerated for v0 mdhd). */
  durationSamples: number;
  table?: TrackSampleTable;
  /** stsd sample entry — carries `avcC` (video) / `esds` (audio) boxes. */
  stsdEntry?: Mp4SampleEntry;
}

export interface ParsedMp4 {
  durationSec: number;
  fragmented: boolean;
  video?: ParsedTrack;
  audio?: ParsedTrack;
}

export interface MoovLocation {
  offset: number;
  size: number;
}

/** Child box by type — checks the convenience property, then `.boxes`.
 *  Generic because box payload fields vary per box kind (§18 shim). */
function boxByType<T = Mp4Box>(box: Mp4Box | undefined, type: string): T | undefined {
  if (!box) return undefined;
  const direct = (box as unknown as Record<string, unknown>)[type];
  if (direct && typeof direct === 'object') return direct as T;
  const found = box.boxes?.find((b) => b.type === type);
  return found as T | undefined;
}

/**
 * Locate the `moov` box by walking top-level box headers only (16-byte
 * reads) — works whether moov sits at the front or after a large mdat.
 */
export async function locateMoov(
  reader: ByteRangeReader,
  fileSize: number,
): Promise<MoovLocation | null> {
  let pos = 0;
  let guard = 0;
  while (pos + 8 <= fileSize && guard++ < 100_000) {
    const head = await reader(pos, 16);
    if (head.byteLength < 8) return null;
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    let size = view.getUint32(0);
    const type = String.fromCharCode(head[4], head[5], head[6], head[7]);
    let headerLen = 8;
    if (size === 1) {
      if (head.byteLength < 16) return null;
      const big = view.getBigUint64(8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(big);
      headerLen = 16;
    } else if (size === 0) {
      size = fileSize - pos; // box extends to EOF
    }
    if (size < headerLen) return null;
    if (type === 'moov') return { offset: pos, size };
    pos += size;
  }
  return null;
}

function syntheticFtyp(): Uint8Array {
  const b = new Uint8Array(SYNTH_FTYYP_LEN);
  const v = new DataView(b.buffer);
  v.setUint32(0, SYNTH_FTYYP_LEN);
  b.set([0x66, 0x74, 0x79, 0x70], 4); // 'ftyp'
  b.set([0x69, 0x73, 0x6f, 0x6d], 8); // major 'isom'
  v.setUint32(12, 512); // minor version
  b.set([0x69, 0x73, 0x6f, 0x6d], 16); // 'isom'
  b.set([0x69, 0x73, 0x6f, 0x32], 20); // 'iso2'
  b.set([0x61, 0x76, 0x63, 0x31], 24); // 'avc1'
  b.set([0x6d, 0x70, 0x34, 0x31], 28); // 'mp41'
  return b;
}

interface Mp4MvhdLike {
  timescale?: number;
  duration?: number;
}
interface HandlerBox {
  /** mp4box 0.5.2 name (`handler_type` kept as fallback). */
  handler?: string;
  handler_type?: string;
}
interface TkhdBox {
  width?: number;
  height?: number;
}
interface SdsdBox {
  entries?: Mp4SampleEntry[];
  sample_entries?: Mp4SampleEntry[];
}

const AAC_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

/** Box payload bytes for a box inside the moov we still hold in memory. */
function moovContent(moovBytes: Uint8Array, moovFileOffset: number, box: Mp4Box): Uint8Array | null {
  const start = (box.start ?? 0) + (box.hdr_size ?? 0);
  const rel = start - moovFileOffset;
  const size = (box.size ?? 0) - (box.hdr_size ?? 0);
  if (rel < 0 || size <= 0 || rel + size > moovBytes.byteLength) return null;
  return moovBytes.subarray(rel, rel + size);
}

interface StszBox {
  sample_size?: number;
  sample_count?: number;
  /** mp4box 0.5.2 name for per-sample sizes. */
  sample_sizes?: number[];
  entries?: number[];
}
interface SttsBox {
  /** mp4box 0.5.2 uses parallel arrays… */
  sample_counts?: number[];
  sample_deltas?: number[];
  /** …older/other shapes use entry objects. */
  entries?: { count: number; delta: number }[];
}
interface StssBox {
  /** 1-based key sample numbers. */
  sample_numbers?: number[];
  entries?: (number | { sampleNumber?: number; first_sample?: number; sample_number?: number })[];
}
interface CttsBox {
  sample_counts?: number[];
  composition_offsets?: number[];
  compositionOffsets?: number[];
  entries?: { count: number; compositionOffset: number }[];
}
interface StscBox {
  first_chunk?: number[];
  samples_per_chunk?: number[];
  sample_description_index?: number[];
  entries?: { first_chunk: number; samples_per_chunk: number; sample_description_index: number }[];
}
interface OffsetBox {
  chunk_offsets?: number[];
  entries?: number[];
}

function buildSampleTable(stbl: Mp4Box): TrackSampleTable | null {
  const stsz = boxByType<StszBox>(stbl, 'stsz');
  const stts = boxByType<SttsBox>(stbl, 'stts');
  const stsc = boxByType<StscBox>(stbl, 'stsc');
  const stco = boxByType<OffsetBox>(stbl, 'stco') ?? boxByType<OffsetBox>(stbl, 'co64');
  if (!stsz || !stts || !stsc || !stco) return null;

  const uniform = stsz.sample_size ?? 0;
  const perSample = stsz.sample_sizes ?? stsz.entries;
  const count = stsz.sample_count ?? perSample?.length ?? 0;
  if (count <= 0) return null;
  const sizes: number[] = new Array(count);
  if (uniform > 0) {
    sizes.fill(uniform);
  } else {
    for (let i = 0; i < count; i++) sizes[i] = perSample?.[i] ?? 0;
  }

  // DTS from stts runs (+ the stts total span, which becomes durationUnits).
  const dts: number[] = new Array(count);
  let durationUnits = 0;
  {
    const runs: { count: number; delta: number }[] =
      stts.sample_counts && stts.sample_deltas
        ? stts.sample_counts.map((c, i) => ({ count: c, delta: stts.sample_deltas![i] ?? 0 }))
        : [...(stts.entries ?? [])];
    let cur = 0;
    let i = 0;
    for (const run of runs) {
      for (let k = 0; k < run.count && i < count; k++, i++) {
        dts[i] = cur;
        cur += run.delta;
      }
    }
    for (; i < count; i++) dts[i] = cur;
    durationUnits = cur; // Σ deltas applied over `count` samples
  }

  // PTS = DTS + composition offsets (absent ctts → identity).
  const pts: number[] = new Array(count);
  const ctts = boxByType<CttsBox>(stbl, 'ctts');
  const cttsOffsets = ctts?.composition_offsets ?? ctts?.compositionOffsets;
  if (ctts && ctts.sample_counts && cttsOffsets) {
    const comp: number[] = new Array(count).fill(0);
    let i = 0;
    for (let r = 0; r < ctts.sample_counts.length; r++) {
      const n = ctts.sample_counts[r];
      const off = cttsOffsets[r] ?? 0;
      for (let k = 0; k < n && i < count; k++, i++) comp[i] = off;
    }
    for (let j = 0; j < count; j++) pts[j] = dts[j] + comp[j];
  } else if (ctts?.entries?.length) {
    const comp: number[] = new Array(count).fill(0);
    let i = 0;
    for (const run of ctts.entries) {
      for (let k = 0; k < run.count && i < count; k++, i++) comp[i] = run.compositionOffset;
    }
    for (let j = 0; j < count; j++) pts[j] = dts[j] + comp[j];
  } else {
    for (let j = 0; j < count; j++) pts[j] = dts[j];
  }

  // Sample offsets from chunk table (stco/co64 + stsc).
  const chunkOffsets = stco.chunk_offsets ?? stco.entries ?? [];
  const scRuns: { first_chunk: number; samples_per_chunk: number; sample_description_index: number }[] =
    stsc.first_chunk && stsc.samples_per_chunk
      ? stsc.first_chunk.map((fc, i) => ({
          first_chunk: fc,
          samples_per_chunk: stsc.samples_per_chunk![i] ?? 0,
          sample_description_index: stsc.sample_description_index?.[i] ?? 1,
        }))
      : [...(stsc.entries ?? [])];
  const runs = scRuns.sort((a, b) => a.first_chunk - b.first_chunk);
  const offsets: number[] = new Array(count).fill(0);
  let s = 0;
  let runIdx = 0;
  for (let c = 1; c <= chunkOffsets.length && s < count; c++) {
    while (runIdx + 1 < runs.length && runs[runIdx + 1].first_chunk <= c) runIdx++;
    const sppc = runs[runIdx]?.samples_per_chunk ?? 0;
    let off = chunkOffsets[c - 1];
    for (let k = 0; k < sppc && s < count; k++, s++) {
      offsets[s] = off;
      off += sizes[s];
    }
  }
  // Tolerate sparse trailing chunks (rare): continue linearly.
  if (s < count && chunkOffsets.length > 0) {
    let off = offsets[Math.max(0, s - 1)] + (s > 0 ? sizes[s - 1] : 0);
    for (; s < count; s++) {
      offsets[s] = off;
      off += sizes[s];
    }
  }

  // Sync samples from stss (absent → every sample is sync).
  const sync: boolean[] = new Array(count).fill(false);
  const stss = boxByType<StssBox>(stbl, 'stss');
  const keyNums =
    stss?.sample_numbers ??
    stss?.entries?.map((e) => (typeof e === 'number' ? e : e.sampleNumber ?? e.sample_number ?? 0)) ??
    [];
  if (!keyNums.length) {
    sync.fill(true);
  } else {
    for (const n of keyNums) {
      if (n >= 1 && n <= count) sync[n - 1] = true;
    }
  }

  return { count, offsets, sizes, dts, pts, sync, durationUnits };
}

/**
 * Parse a standalone `moov` byte range into `ParsedMp4`.
 * `moovFileOffset` is the box's absolute offset in the real file.
 */
export function parseMoovBytes(moovBytes: Uint8Array, moovFileOffset: number): ParsedMp4 {
  const combined = new Uint8Array(SYNTH_FTYYP_LEN + moovBytes.byteLength);
  combined.set(syntheticFtyp(), 0);
  combined.set(moovBytes, SYNTH_FTYYP_LEN);
  const buf = combined.buffer as Mp4Buffer;
  buf.fileStart = 0;

  const file = MP4Box.createFile();
  let parseError: string | null = null;
  file.onError = (reason) => {
    parseError = reason;
  };
  file.appendBuffer(buf);
  if (parseError) throw new Error(`mp4box parse error: ${parseError}`);

  const moov = file.moov;
  if (!moov) throw new Error('mp4box parse: no moov in buffer');

  // Rebase absolute positions from synthetic coordinates back to the file.
  // Sample entries are reached via `stsd.entries` (stsd exposes no `.boxes`),
  // so the walk covers both child arrays.
  const delta = moovFileOffset - SYNTH_FTYYP_LEN;
  const rebaseTree = (box: Mp4Box): void => {
    if (typeof box.start === 'number') box.start += delta;
    for (const child of box.boxes ?? []) rebaseTree(child);
    const entries = (box as unknown as { entries?: unknown[] }).entries;
    if (Array.isArray(entries)) {
      for (const e of entries) {
        if (e && typeof e === 'object' && typeof (e as { start?: unknown }).start === 'number') {
          rebaseTree(e as Mp4Box);
        }
      }
    }
  };
  rebaseTree(moov);

  const mvhd = moov.mvhd ?? boxByType<Mp4MvhdLike>(moov, 'mvhd');
  const mvhdTimescale = mvhd?.timescale ?? 0;
  const mvhdDuration = mvhd?.duration ?? 0;
  const fragmented = Boolean(boxByType(moov, 'mvex'));

  const traks: Mp4Box[] = [];
  if (moov.traks?.length) traks.push(...moov.traks);
  else for (const b of moov.boxes ?? []) if (b.type === 'trak') traks.push(b);

  let video: ParsedTrack | undefined;
  let audio: ParsedTrack | undefined;
  let videoDurationSec = 0;
  let audioDurationSec = 0;
  let maxDurationSec = 0;

  for (const trak of traks) {
    const mdia = trak.mdia ?? boxByType(trak, 'mdia');
    const mdhd =
      (mdia && (mdia.mdhd ?? boxByType<Mp4MvhdLike>(mdia, 'mdhd'))) ?? undefined;
    const hdlr =
      (mdia && (mdia.hdlr ?? boxByType<HandlerBox>(mdia, 'hdlr'))) ?? undefined;
    const handler = hdlr?.handler ?? hdlr?.handler_type ?? '';
    const timescale = mdhd?.timescale ?? 0;
    const durationSamples = mdhd?.duration ?? 0;
    if (!timescale) continue;
    const trackSec = durationSamples / timescale;
    maxDurationSec = Math.max(maxDurationSec, trackSec);
    if (handler !== 'vide' && handler !== 'soun') continue;

    const minf = (mdia && (mdia.minf ?? boxByType(mdia, 'minf'))) ?? undefined;
    const stbl = (minf && (minf.stbl ?? boxByType(minf, 'stbl'))) ?? undefined;
    if (!stbl) continue;
    const stsd = boxByType<SdsdBox>(stbl, 'stsd');
    const entry = stsd?.entries?.[0] ?? stsd?.sample_entries?.[0];
    if (!entry) continue;

    const table = buildSampleTable(stbl) ?? undefined;
    const isVideo = handler === 'vide';

    let codec = '';
    let sampleRate: number | undefined;
    let channelCount: number | undefined;

    if (isVideo) {
      const avcC = entry.avcC ?? boxByType(entry, 'avcC');
      const content = avcC ? moovContent(moovBytes, moovFileOffset, avcC) : null;
      if (content && content.byteLength >= 4) {
        codec = `avc1.${content[1].toString(16).padStart(2, '0')}${content[2]
          .toString(16)
          .padStart(2, '0')}${content[3].toString(16).padStart(2, '0')}`;
      }
    } else {
      const esds = entry.esds ?? boxByType(entry, 'esds');
      const content = esds ? moovContent(moovBytes, moovFileOffset, esds) : null;
      if (content) {
        const asc = extractAscFromDescriptor(content);
        if (asc && asc.byteLength >= 2) {
          const objectType = asc[0] >> 3;
          codec = `mp4a.40.${objectType}`;
          const freqIdx = ((asc[0] & 0x07) << 1) | (asc[1] >> 7);
          if (freqIdx === 15 && asc.byteLength >= 5) {
            sampleRate = ((asc[1] & 0x7f) << 17) | (asc[2] << 9) | (asc[3] << 1) | (asc[4] >> 7);
          } else if (freqIdx < AAC_SAMPLE_RATES.length) {
            sampleRate = AAC_SAMPLE_RATES[freqIdx];
          }
          channelCount = (asc[1] >> 3) & 0x0f;
          if (channelCount === 0) channelCount = undefined;
        }
      }
      if (!sampleRate) sampleRate = timescale; // common layout: mdhd == sample rate
    }

    const tkhd = trak.tkhd ?? boxByType<TkhdBox>(trak, 'tkhd');
    const widthFixed = entry.width ?? (tkhd?.width ?? 0) / 65536;
    const heightFixed = entry.height ?? (tkhd?.height ?? 0) / 65536;

    const track: ParsedTrack = {
      kind: isVideo ? 'video' : 'audio',
      codec,
      timescale,
      durationSamples,
      table,
      stsdEntry: entry,
      ...(isVideo
        ? { width: Math.round(widthFixed), height: Math.round(heightFixed) }
        : { sampleRate, channelCount }),
    };
    if (isVideo && !video) {
      video = track;
      // Timeline length from the stts pts span, NOT mdhd: mdhd can disagree
      // with the sample table (observed exactly 2× on a source file, which
      // poisoned frameRateOf → N/fps arithmetic → a 2× export duration).
      videoDurationSec = (table ? table.durationUnits / timescale : 0) || trackSec;
    } else if (!isVideo && !audio) {
      audio = track;
      audioDurationSec = (table ? table.durationUnits / timescale : 0) || trackSec;
    }
  }

  // Prefer the video timeline (stts pts span; falls back to mdhd when the
  // sample table is missing), then audio, then mvhd, then any track.
  const mvhdSec = mvhdDuration > 0 && mvhdTimescale > 0 ? mvhdDuration / mvhdTimescale : 0;
  const durationSec = videoDurationSec || audioDurationSec || mvhdSec || maxDurationSec;
  return { durationSec, fragmented, video, audio };
}

/** Frame rate from sample count over duration, snapped to broadcast rates. */
export function frameRateOf(track: ParsedTrack, durationSec: number): number {
  const count = track.table?.count ?? 0;
  if (!durationSec || count <= 0) return 30;
  const raw = count / durationSec;
  const common = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
  for (const c of common) if (Math.abs(raw - c) / c < 0.03) return c;
  return Math.round(raw * 100) / 100;
}

/**
 * Frame rate for the FFmpeg fallback's image2 input such that
 * `count / rate` equals the frames' ACTUAL pts span (+ one average frame) —
 * i.e. the encoded file's duration matches the cut exactly, whatever
 * frameRateOf()/mdhd claim. The old `N / frameRateOf(mdhd)` arithmetic came
 * out exactly 2× when mdhd overstated the stts span by 2×.
 */
export function encodeFramerateFromPts(
  firstPtsUs: number,
  lastPtsUs: number,
  count: number,
  fallbackFps: number,
): number {
  const fallback = Number.isFinite(fallbackFps) && fallbackFps > 0 ? fallbackFps : 25;
  if (count <= 1 || !Number.isFinite(firstPtsUs) || !Number.isFinite(lastPtsUs)) return fallback;
  const spanSec = (lastPtsUs - firstPtsUs) / 1_000_000;
  if (spanSec <= 0) return fallback;
  const durSec = spanSec + spanSec / (count - 1); // pts span + one average frame
  const rate = count / durSec;
  if (!Number.isFinite(rate) || rate <= 0) return fallback;
  return rate;
}

/** Index of the sample whose presentation window contains `tSec`
 *  (monotonic pts assumed — sources are B-frame-free). */
export function sampleIndexAtTime(table: TrackSampleTable, timescale: number, tSec: number): number {
  if (table.count === 0) throw new Error('empty sample table');
  const target = tSec * timescale;
  let lo = 0;
  let hi = table.count; // first index with pts > target
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (table.pts[mid] <= target) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, Math.min(table.count - 1, lo - 1));
}

/** Index of the nearest sync sample at or before `index`. */
export function lastSyncIndexBefore(table: TrackSampleTable, index: number): number {
  for (let i = Math.max(0, index); i >= 0; i--) {
    if (table.sync[i]) return i;
  }
  return 0;
}

/** Sample index range [from, to) covering presentation [startSec, endSec]. */
export function sampleRangeForWindow(
  track: ParsedTrack,
  startSec: number,
  endSec: number,
): { from: number; to: number } {
  const table = track.table;
  if (!table) throw new Error('track has no sample table (fragmented)');
  const start = sampleIndexAtTime(table, track.timescale, startSec);
  const from = lastSyncIndexBefore(table, start);
  let to = start;
  const end = endSec * track.timescale;
  while (to < table.count && table.pts[to] < end) to++;
  return { from, to: Math.max(to, from + 1) };
}

/** Presentation timestamp (seconds) of a sample index. */
export function sampleTimeSec(track: ParsedTrack, index: number): number {
  const table = track.table;
  if (!table) throw new Error('track has no sample table (fragmented)');
  return table.pts[index] / track.timescale;
}

export interface RemuxAudioPlan {
  /** Selected packet indices, ascending. */
  indices: number[];
  /** Timestamp/duration unit = PCM frames per second — pass as the mux track timescale. */
  timescale: number;
  /** Per-packet timing (timescale units), rebased so the first part starts at 0. */
  parts: { dts: number; cts: number; duration: number }[];
}

/**
 * Window selection + passthrough timing for an AAC track derived purely from
 * PCM frame counts (§8.10): packet `i` occupies media seconds
 * [i·framesPerAu/sampleRate, (i+1)·framesPerAu/sampleRate), because every
 * AAC access unit carries a fixed number of PCM frames. The source stts box
 * is never consulted — a broken time-to-sample table must not shift the cut
 * window or inflate the muxed audio span. For a healthy AAC-LC file this is
 * numerically identical to its stts (uniform 1024-unit deltas from 0).
 */
export function planRemuxAudio(
  packetCount: number,
  framesPerAu: number,
  sampleRate: number,
  startSec: number,
  endSec: number,
): RemuxAudioPlan | null {
  const rate = sampleRate > 0 ? sampleRate : 48000;
  const fl = framesPerAu > 0 ? framesPerAu : 1024;
  const durSec = fl / rate;
  const indices: number[] = [];
  for (let i = 0; i < packetCount; i++) {
    const sec = i * durSec;
    if (sec + durSec > startSec && sec < endSec) indices.push(i);
  }
  if (indices.length === 0) return null;
  const base = indices[0];
  const parts = indices.map((i) => ({ dts: (i - base) * fl, cts: (i - base) * fl, duration: fl }));
  return { indices, timescale: rate, parts };
}
