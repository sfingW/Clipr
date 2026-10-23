/**
 * Type shim for mp4box 0.5.2 (ships no types) — SPEC §18 tolerates this as
 * the single loose-typing point. Shapes mirror mp4box's runtime: boxes expose
 * known children as properties, and all boxes carry absolute `start`/`size`
 * after parsing.
 */

declare module 'mp4box' {
  /** A parsed box: absolute file positions after `appendBuffer`. */
  export interface Mp4Box {
    type?: string;
    /** Absolute byte offset of the box in the appended stream. */
    start?: number;
    /** Total box size (header + payload). */
    size?: number;
    /** Header size (8, 16, or 24 bytes depending on size field). */
    hdr_size?: number;
    fileStart?: number;
    boxes?: Mp4Box[];
    /** Container conveniences (present on container boxes). */
    mvhd?: Mp4Mvhd;
    traks?: Mp4Trak[];
    trak?: Mp4Trak;
    edts?: Mp4Edit[];
    elst?: Mp4Edit[];
    mdia?: Mp4Box;
    minf?: Mp4Box;
    stbl?: Mp4Stbl;
    mdhd?: { timescale?: number; duration?: number; set?(key: string, value: unknown): void };
    hdlr?: { handler?: string; handler_type?: string };
    tkhd?: { width?: number; height?: number; set(key: string, value: unknown): void };
    stsd?: { entries?: Mp4SampleEntry[]; sample_entries?: Mp4SampleEntry[] };
    stts?: { entries?: { count: number; delta: number }[] };
    stss?: { entries?: { sampleNumber?: number; first_sample?: number }[] };
    ctts?: { version?: number; entries?: { count: number; compositionOffset: number }[] };
    stsc?: { entries?: { first_chunk: number; samples_per_chunk: number; sample_description_index: number }[] };
    stsz?: { sample_size?: number; sample_count?: number; entries?: number[] };
    stco?: { entries?: number[] };
    co64?: { entries?: number[] };
    mvex?: Mp4Box;
    /** Decoder-config boxes live on their sample entry (or via `.boxes`). */
    avcC?: Mp4Box;
    esds?: Mp4Box;
  }

  export interface Mp4Mvhd {
    timescale?: number;
    duration?: number;
    set(key: string, value: unknown): void;
  }

  export type Mp4Trak = Mp4Box;

  export type Mp4Edit = Mp4Box;

  export interface Mp4SampleEntry extends Mp4Box {
    type?: string;
    width?: number;
    height?: number;
    avcC?: Mp4Box;
    esds?: Mp4Box;
  }

  export type Mp4Stbl = Mp4Box;

  /** Buffer handed to `appendBuffer` — mp4box REQUIRES `fileStart`. */
  export type Mp4Buffer = ArrayBuffer & { fileStart?: number };

  export interface Mp4BoxSettable {
    set(key: string, value: unknown): void;
    data?: Uint8Array;
  }

  export interface Mp4TrackInfo {
    codec?: string;
    type?: string;
    nb_samples?: number;
    timescale?: number;
    duration?: number;
    video?: { width?: number; height?: number };
    audio?: { channelcount?: number; samplerate?: number };
    edits?: Mp4Edit[];
  }

  export interface Mp4Info {
    duration?: number;
    timescale?: number;
    isFragmented?: boolean;
    tracks?: Mp4TrackInfo[];
  }

  export interface ISOFile {
    onError?: (reason: string) => void;
    onReady?: (info: Mp4Info) => void;
    appendBuffer(buffer: Mp4Buffer): ISOFile;
    getInfo(): Mp4Info;
    flush(): void;
    releaseUsedSamples(trackId: number, sampleNum: number): void;
    setExtractionOptions(trackId: number, options: unknown, cb?: () => void): void;
    getTrackById(id: number): Mp4Trak | undefined;
    addTrack(config: Mp4TrackConfig): number;
    addSample(
      trackId: number,
      data: Uint8Array,
      options: { duration: number; dts: number; cts: number; is_sync: boolean },
    ): void;
    getBuffer(): ArrayBuffer;
    moov?: Mp4Moov;
    totalFileSize?: number;
    initialized?: boolean;
  }

  export interface Mp4Moov extends Mp4Box {
    mvhd?: Mp4Mvhd;
    traks?: Mp4Trak[];
  }

  export type Mp4TrackConfig =
    | {
        type: 'avc1';
        width: number;
        height: number;
        timescale: number;
        hdlr?: string;
        name?: string;
        brands?: string[];
        avcDecoderConfigRecord: ArrayBuffer;
      }
    | {
        type: 'mp4a';
        timescale: number;
        channel_count: number;
        samplesize: number;
        samplerate: number;
        hdlr?: string;
        name?: string;
        description?: Mp4Box;
      };

  export function createFile(): ISOFile;

  export const BoxParser: {
    esdsBox: new () => Mp4Box & Mp4BoxSettable;
  };

  const MP4Box: {
    createFile: typeof createFile;
    BoxParser: typeof BoxParser;
  };
  export default MP4Box;
}
