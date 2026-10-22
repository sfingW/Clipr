/**
 * Data contracts (SPEC §5) — the interfaces between subsystems.
 * Defined before any pipeline code; changing them requires updating every
 * consumer.
 */

/** Set once at ingest. */
export interface SourceMeta {
  id: string;                  // uuid v4
  opfsPath: string;            // OPFS file handle path
  fileName: string;
  durationSec: number;
  width: number;
  height: number;
  videoCodec: string;          // e.g. "avc1.640028"
  audioCodec: string;          // e.g. "mp4a.40.2"
  frameRate: number;
  sizeBytes: number;
}

/** Extracted audio, 16kHz mono, for ASR. */
export interface AudioTrack {
  opfsPath: string;            // WAV or raw PCM
  durationSec: number;
  sampleRate: 16000;
}

/** Word-level timings. The IR. Everything downstream reads this. */
export interface Transcript {
  language: string;
  words: Word[];
  segments: Segment[];
}

export interface Word {
  text: string;
  start: number;               // seconds
  end: number;
}

export interface Segment {
  text: string;
  start: number;
  end: number;
  speaker?: number;            // diarization label, optional in v1
}

/** Pure-code candidate windows. Produced before any AI runs. */
export interface Candidate {
  id: string;
  startSec: number;
  endSec: number;
  text: string;
  score?: number;              // 1-10, filled by LLM
  reason?: string;             // ≤12 words, from LLM
  source: 'manual' | 'chunked' | 'scored';
}

/** Everything needed to render one clip. */
export interface ClipSpec {
  id: string;
  candidateId?: string;
  sourceStartSec: number;
  sourceEndSec: number;
  crop: CropKeyframe[];        // empty → center crop
  captionStyleId: string;
  captions: CaptionLine[];
  format: 'vertical' | 'original';
  exportPreset: '1080p' | '720p';
}

export interface CropKeyframe {
  t: number;                   // seconds relative to clip start
  x: number;                   // crop-left in source pixels
  width: number;               // crop width in source pixels
}

export interface CaptionLine {
  text: string;
  start: number;               // seconds relative to clip start
  end: number;
  words?: Word[];              // for word-sync highlighting
}

/** Face sample emitted by vision.worker (SPEC §8.8, carried by §9 `vision.track`). */
export interface FaceBox {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
}

export interface FaceSample {
  t: number;                   // seconds
  boxes: FaceBox[];
}
