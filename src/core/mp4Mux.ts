/**
 * MP4 muxing on top of mp4-muxer (WebCodecs-native, progressive output).
 *
 * Why not mp4box: mp4box.js 0.5.x writes fragmented MP4 (`moof` per sample +
 * `mvex`), which QuickTime/QuickLook times from the fragments rather than the
 * movie header. mp4-muxer writes a single `moov` + `mdat` file with the moov
 * placed first (`fastStart: 'in-memory'`), so no `moof`/`mvex` boxes exist and
 * every duration in the header is derived from the chunk timestamps we pass.
 *
 * Callers still hand us samples in TRACK timescale units; we convert them to
 * the microseconds mp4-muxer expects.
 */
import { ArrayBufferTarget, Muxer } from 'mp4-muxer';

export interface MuxSample {
  data: Uint8Array;
  /** Decode timestamp, track timescale units. */
  dts: number;
  /** Presentation timestamp (dts + composition offset), same units. */
  cts: number;
  /** Sample duration, same units. */
  duration: number;
  isSync: boolean;
}

export interface MuxVideoTrack {
  codecType: 'avc1';
  width: number;
  height: number;
  timescale: number;
  /** avcC content bytes (WebCodecs `decoderConfig.description`, 'avc' format). */
  avcDecoderConfigRecord: Uint8Array;
  samples: MuxSample[];
}

export interface MuxAudioTrack {
  codecType: 'mp4a';
  sampleRate: number;
  channelCount: number;
  sampleSize: number;
  timescale: number;
  /**
   * MPEG-4 ES descriptor payload (AAC), required by `muxToMp4` when audio is
   * present. The AudioSpecificConfig is read from it; mp4-muxer writes esds.
   */
  esdsDescriptor?: Uint8Array;
  samples: MuxSample[];
}

export interface MuxInput {
  brands?: string[];
  video: MuxVideoTrack;
  audio?: MuxAudioTrack;
}

/**
 * Build the MPEG-4 ES_Descriptor payload (DecoderConfig + AAC
 * DecoderSpecificInfo + SLConfig) that lives inside an `esds` box.
 * Used when audio was encoded in-tab (transcode path) rather than remuxed.
 */
export function buildEsdDescriptor(asc: Uint8Array): Uint8Array {
  if (asc.byteLength >= 128) throw new Error('ASC too long for single-byte descriptor length');
  const dsi = new Uint8Array(2 + asc.byteLength);
  dsi[0] = 0x05; // DecoderSpecificInfo
  dsi[1] = asc.byteLength;
  dsi.set(asc, 2);

  const decBodyLen = 13 + dsi.byteLength;
  const dec = new Uint8Array(2 + decBodyLen);
  dec[0] = 0x04; // DecoderConfigDescriptor
  dec[1] = decBodyLen;
  dec[2] = 0x40; // objectTypeIndication: Audio ISO/IEC 14496-3
  dec[3] = 0x15; // streamType audioStream, upstream 0, reserved 1
  // dec[4..6] bufferSizeDB = 0
  // dec[7..10] maxBitrate = 0
  // dec[11..14] avgBitrate = 0
  dec.set(dsi, 2 + 13);

  const sl = new Uint8Array([0x06, 0x01, 0x02]); // SLConfigDescriptor, predefined 2

  const esBodyLen = 3 + dec.byteLength + sl.byteLength;
  const es = new Uint8Array(2 + esBodyLen);
  es[0] = 0x03; // ES_Descriptor
  es[1] = esBodyLen;
  es[2] = 0x00; // ES_ID high
  es[3] = 0x01; // ES_ID low
  es[4] = 0x00; // flags
  es.set(dec, 5);
  es.set(sl, 5 + dec.byteLength);
  return es;
}

function readVint(buf: Uint8Array, i: number): { len: number; next: number } | null {
  let len = 0;
  let bytes = 0;
  while (i + bytes < buf.byteLength) {
    const b = buf[i + bytes];
    len = ((len << 7) | (b & 0x7f)) >>> 0;
    bytes++;
    if (!(b & 0x80)) return { len, next: i + bytes };
    if (bytes > 4) return null;
  }
  return null;
}

export function extractAscFromDescriptor(descriptor: Uint8Array): Uint8Array | null {
  // Payload may or may not carry a 4-byte FullBox version/flags prefix.
  let base = 0;
  if (descriptor[0] !== 0x03) {
    if (descriptor.byteLength > 4 && descriptor[4] === 0x03) base = 4;
    else return null;
  }
  const tag = descriptor[base];
  if (tag !== 0x03) return null;
  const esLen = readVint(descriptor, base + 1);
  if (!esLen) return null;
  // ES_Descriptor body: ES_ID (2) + flags (1) then nested descriptors.
  let p = esLen.next + 3;
  const end = Math.min(esLen.next + esLen.len, descriptor.byteLength);
  while (p + 2 <= end) {
    const nestedTag = descriptor[p];
    const nl = readVint(descriptor, p + 1);
    if (!nl) return null;
    const body = nl.next;
    if (nestedTag === 0x05) {
      return descriptor.slice(body, body + nl.len);
    }
    if (nestedTag === 0x04 && nl.len >= 13 && body + 13 + 2 <= descriptor.byteLength) {
      // DecoderConfigDescriptor: 13-byte body, then nested DSI (tag 0x05).
      const nested = body + 13;
      if (descriptor[nested] === 0x05) {
        const dl = readVint(descriptor, nested + 1);
        if (dl) return descriptor.slice(dl.next, dl.next + dl.len);
      }
    }
    p = body + nl.len;
    if (nl.len === 0) return null;
  }
  return null;
}

/**
 * PCM frames a single AAC access unit decodes to — the real per-packet
 * duration. MPEG-4 audio frames are constant-length: GASpecificConfig
 * frameLengthFlag selects 1024 (flag 0) or 960 (flag 1); explicit SBR/PS
 * (AOT 5/29) doubles the decoder output (×2). Anything unparseable falls
 * back to 1024 (AAC-LC default). Timing derived from this never consults the
 * source stts box, so a broken time-to-sample table cannot inflate the
 * muxed audio span (the sample durations are in the track
 * timescale, which we set to the sample rate).
 */
export function aacAccessUnitFrames(asc: Uint8Array | null | undefined): number {
  if (!asc || asc.byteLength < 2) return 1024;
  let bit = 0;
  const bits = (n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = asc[bit >> 3] ?? 0;
      v = (v << 1) | ((byte >> (7 - (bit & 7))) & 1);
      bit++;
    }
    return v;
  };
  const getAot = (): number => {
    let aot = bits(5);
    if (aot === 31) aot = 32 + bits(6);
    return aot;
  };
  let aot = getAot();
  let sfi = bits(4);
  if (sfi === 0xf) bits(24); // explicit sampling frequency
  bits(4); // channelConfiguration
  let sbr = false;
  if (aot === 5 || aot === 29) {
    // The frequency read above is the extension rate; core AOT + rate follow.
    sbr = true;
    aot = getAot();
    sfi = bits(4);
    if (sfi === 0xf) bits(24);
  }
  let longFrame = false;
  if ([1, 2, 3, 4, 7, 17, 19, 21, 22, 23].includes(aot)) {
    longFrame = bits(1) === 1; // GASpecificConfig.frameLengthFlag → 960
  }
  return (longFrame ? 960 : 1024) * (sbr ? 2 : 1);
}

function sumDurations(samples: MuxSample[]): number {
  let total = 0;
  for (const s of samples) total += s.duration;
  return total;
}

const MICROSECONDS = 1_000_000;

/** Track timescale units → integer microseconds (mp4-muxer's input unit). */
function toUs(units: number, timescale: number): number {
  return Math.round((units * MICROSECONDS) / timescale);
}

/** RFC 6381 `avc1.PPCCLL` string from the avcC record (profile, constraints, level). */
export function avcCodecString(avcC: Uint8Array): string {
  if (avcC.byteLength < 4) throw new Error('mux: avcC record too short');
  const hex = (b: number): string => b.toString(16).padStart(2, '0');
  return `avc1.${hex(avcC[1])}${hex(avcC[2])}${hex(avcC[3])}`;
}

/**
 * Mux encoded video (+ optional audio) samples into one progressive MP4
 * (`ftyp` + `moov` + `mdat`, moov first). Returns the file bytes.
 *
 * Video is the MASTER CLOCK: the container duration is the video pts span,
 * and audio is hard-capped to it. Audio packets that start at or after the
 * video end are dropped, and the last survivor is trimmed to stop exactly at
 * the video end, so audio metadata can never decide how long the file is.
 */
export function muxToMp4(input: MuxInput): Uint8Array {
  const { video } = input;
  if (video.samples.length === 0) throw new Error('mux: no video samples');

  const videoDur = sumDurations(video.samples); // video timescale units
  const videoSpanSec = videoDur / video.timescale;
  let audio: MuxAudioTrack | undefined;
  if (input.audio && input.audio.samples.length > 0) {
    const limit = Math.floor(videoSpanSec * input.audio.timescale); // audio units
    const before = input.audio.samples.length;
    const kept = input.audio.samples.filter((s) => Math.round(s.dts) < limit);
    let trimmedUnits = 0;
    if (kept.length > 0) {
      // Trim the final audio packet so the audio timeline ends at the video end.
      const last = kept[kept.length - 1];
      const cappedDur = Math.max(1, Math.min(last.duration, limit - Math.round(last.dts)));
      trimmedUnits = last.duration - cappedDur;
      const samples = kept.map((s, i) => (i === kept.length - 1 ? { ...s, duration: cappedDur } : s));
      audio = { ...input.audio, samples };
    }
    console.warn('AUDIO_CAP:', {
      before,
      after: kept.length,
      droppedSamples: before - kept.length,
      trimmedUnits,
      limitUnits: limit,
      videoSpanSec,
    });
  }

  const avcC = video.avcDecoderConfigRecord;
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width: video.width, height: video.height },
    ...(audio ? { audio: { codec: 'aac' as const, numberOfChannels: audio.channelCount, sampleRate: audio.sampleRate } } : {}),
    // Progressive, moov first. No moof/mvex boxes are written.
    fastStart: 'in-memory',
    // Both tracks start at 0 in practice; cross-track offset preserves A/V sync if not.
    firstTimestampBehavior: 'cross-track-offset',
  });

  video.samples.forEach((s, i) => {
    const meta =
      i === 0
        ? { decoderConfig: { codec: avcCodecString(avcC), description: new Uint8Array(avcC) } }
        : undefined;
    const cts = toUs(s.cts, video.timescale);
    const cto = toUs(s.cts - s.dts, video.timescale);
    muxer.addVideoChunkRaw(s.data, s.isSync ? 'key' : 'delta', cts, toUs(Math.max(1, s.duration), video.timescale), meta, cto);
  });

  if (audio && audio.samples.length > 0) {
    if (!audio.esdsDescriptor) throw new Error('mux: audio track needs esdsDescriptor');
    const asc = extractAscFromDescriptor(audio.esdsDescriptor);
    if (!asc) throw new Error('mux: audio esds has no AudioSpecificConfig');
    const aot = asc[0] >> 3;
    const meta = {
      decoderConfig: {
        codec: `mp4a.40.${aot}`,
        description: asc,
        numberOfChannels: audio.channelCount,
        sampleRate: audio.sampleRate,
      },
    };
    audio.samples.forEach((s, i) => {
      muxer.addAudioChunkRaw(
        s.data,
        'key',
        toUs(s.dts, audio!.timescale),
        toUs(Math.max(1, s.duration), audio!.timescale),
        i === 0 ? meta : undefined,
      );
    });
  }

  muxer.finalize();
  return new Uint8Array(target.buffer);
}
