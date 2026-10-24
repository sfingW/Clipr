/**
 * MP4 muxing wrapper around mp4box.js (SPEC §8.10: "Mux with mp4box.js").
 * Pure: mp4box serializes every box; we only drive its packaging API
 * (`addTrack` / `addSample` / `getBuffer`). Never hand-roll MP4 boxes.
 */
import MP4Box, { type Mp4Box } from 'mp4box';

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
  /** esds box parsed from the source container (AAC remux path). */
  sourceEsdsBox?: Mp4Box;
  /** MPEG-4 ES descriptor payload for a freshly built esds (transcode path). */
  esdsDescriptor?: Uint8Array;
  samples: MuxSample[];
}

export interface MuxInput {
  brands?: string[];
  video: MuxVideoTrack;
  audio?: MuxAudioTrack;
}

function toOwnedBuffer(data: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
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

function makeEsdsBox(descriptor: Uint8Array): Mp4Box {
  const box = new MP4Box.BoxParser.esdsBox();
  box.set('version', 0);
  box.set('flags', 0);
  box.data = descriptor;
  return box;
}

/**
 * Pull the AAC AudioSpecificConfig (DecoderSpecificInfo, tag 0x05) out of an
 * ES_Descriptor payload — needed to configure WebCodecs audio codecs/decoders.
 * Handles both single-byte and 4-byte expandable descriptor lengths (ffmpeg
 * emits `80 80 80 xx`).
 */
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
 * muxed audio span (mp4box `addSample` durations are in the track
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

/**
 * Mux encoded video (+ optional audio) samples into a single MP4.
 * Uses mp4box's packaging flow: ftyp + moov, then one moof+mdat per sample
 * (fragmented layout — mp4box 0.5.x's first-party write path).
 */
export function muxToMp4(input: MuxInput): Uint8Array {
  const { video } = input;
  if (video.samples.length === 0) throw new Error('mux: no video samples');

  // Video is the MASTER CLOCK: the container duration is the video pts span,
  // and audio is hard-capped to it before anything touches mp4box. Source
  // audio metadata can be broken beyond diagnosis (observed: a 44.08s cut
  // exported with a 2:18 / 3.13× player timeline), so never let it decide
  // how long the file is: audio packets that start at or after the video end
  // are dropped and the last survivor is truncated to stop exactly at the
  // video end. mdhd/tkhd/mvhd then all agree with the video track.
  const videoDur = sumDurations(video.samples); // video timescale units
  const videoSpanSec = videoDur / video.timescale;
  let audio: MuxAudioTrack | undefined;
  if (input.audio && input.audio.samples.length > 0) {
    const limit = Math.floor(videoSpanSec * input.audio.timescale); // audio units
    const before = input.audio.samples.length;
    const kept = input.audio.samples.filter((s) => Math.round(s.dts) < limit);
    let trimmedUnits = 0;
    if (kept.length > 0) {
      const last = kept[kept.length - 1];
      const cappedDur = Math.max(1, Math.min(last.duration, limit - Math.round(last.dts)));
      trimmedUnits = last.duration - cappedDur;
      const samples = kept.map((s, i) => (i === kept.length - 1 ? { ...s, duration: cappedDur } : s));
      audio = { ...input.audio, samples };
    }
    // Diagnostic (requested): prove whether the video-master cap actually
    // drops / truncates audio past the video span.
    console.warn('AUDIO_CAP:', {
      before,
      after: kept.length,
      droppedSamples: before - kept.length,
      trimmedUnits,
      limitUnits: limit,
      videoSpanSec,
    });
  }

  const file = MP4Box.createFile();
  file.onError = (reason) => {
    throw new Error(`mp4box mux error: ${reason}`);
  };

  const videoTrackId = file.addTrack({
    type: 'avc1',
    width: video.width,
    height: video.height,
    timescale: video.timescale,
    hdlr: 'vide',
    name: 'Clipr Video',
    brands: input.brands ?? ['isom', 'iso6', 'avc1', 'mp41'],
    avcDecoderConfigRecord: toOwnedBuffer(video.avcDecoderConfigRecord),
  });

  let audioTrackId = 0;
  let audioTimescale = 1;
  if (audio && audio.samples.length > 0) {
    const description = audio.sourceEsdsBox
      ? audio.sourceEsdsBox
      : audio.esdsDescriptor
        ? makeEsdsBox(audio.esdsDescriptor)
        : undefined;
    if (!description) throw new Error('mux: audio track needs sourceEsdsBox or esdsDescriptor');
    audioTrackId = file.addTrack({
      type: 'mp4a',
      timescale: audio.timescale,
      channel_count: audio.channelCount,
      samplesize: audio.sampleSize,
      samplerate: audio.sampleRate << 16,
      hdlr: 'soun',
      name: 'Clipr Audio',
      description,
    });
    audioTimescale = audio.timescale;
  }

  // NOTE: sample duration/dts/cts below are already in the TRACK's
  // timescale units (render.worker converts µs → units via
  // `us * timescale / 1_000_000`) — mp4box takes them as-is. Passing raw
  // microseconds here would scale the duration by timescale/1e6.
  for (const s of video.samples) {
    file.addSample(videoTrackId, s.data, {
      duration: Math.max(1, Math.round(s.duration)),
      dts: Math.round(s.dts),
      cts: Math.round(s.cts),
      is_sync: s.isSync,
    });
  }
  if (audio && audioTrackId !== 0) {
    for (const s of audio.samples) {
      file.addSample(audioTrackId, s.data, {
        duration: Math.max(1, Math.round(s.duration)),
        dts: Math.round(s.dts),
        cts: Math.round(s.cts),
        is_sync: true,
      });
    }
  }

  // Durations (mp4box leaves them at 0 otherwise). The MOVIE header is
  // forced to standard milliseconds (1000), never whatever timescale the
  // source or mp4box's init() carried over (a poisoned ~15000 made a
  // 30.73s cut play as 61s: 921000/15000). mvhd.duration = video duration
  // in ms = Math.round(videoDurationSec * 1000); tkhd durations live in
  // mvhd units too, so they convert through the same 1000.
  const movieTimescale = 1000;
  const videoMovieDur = Math.round((videoDur * movieTimescale) / video.timescale);
  const vtrak = file.getTrackById(videoTrackId);
  vtrak?.mdia?.mdhd?.set?.('duration', videoDur);
  vtrak?.tkhd?.set?.('duration', videoMovieDur);
  if (audio && audioTrackId !== 0) {
    const audioDur = sumDurations(audio.samples);
    const atrak = file.getTrackById(audioTrackId);
    atrak?.mdia?.mdhd?.set?.('duration', audioDur);
    atrak?.tkhd?.set?.('duration', Math.round((audioDur * movieTimescale) / audioTimescale));
    // Audio was capped at the video span above, so its movie duration can
    // never exceed videoMovieDur — but the container follows VIDEO either
    // way: mvhd.duration = video track duration, exactly (master clock).
  }
  file.moov?.mvhd?.set?.('timescale', movieTimescale);
  file.moov?.mvhd?.set?.('duration', videoMovieDur);

  // Diagnostic (requested): the exact durations written into the file,
  // logged right before getBuffer() freezes them.
  const lastVideoSample = video.samples[video.samples.length - 1];
  const lastAudioSample = audio && audio.samples.length > 0 ? audio.samples[audio.samples.length - 1] : null;
  console.warn('MUX_DIAGNOSTICS:', {
    videoDurationSec: lastVideoSample.cts / video.timescale,
    audioDurationSec: audio && lastAudioSample ? lastAudioSample.cts / audio.timescale : 0,
    videoTimescale: video.timescale,
    audioTimescale: audio ? audio.timescale : 0,
    movieDuration: file.moov?.mvhd?.duration,
    movieTimescale: file.moov?.mvhd?.timescale ?? movieTimescale,
  });

  const buffer = file.getBuffer();
  return new Uint8Array(buffer.slice(0));
}
