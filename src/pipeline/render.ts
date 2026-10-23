/**
 * Render orchestration (SPEC §8.10): wires demux.worker → main → render.worker
 * (frame batches with acked backpressure), merges progress (demux 0–25%,
 * encode 25–100%), and resolves to the MP4 Blob.
 *
 * On WebCodecs codec rejection the tagged error surfaces so callers can take
 * the FFmpeg fallback (§8.11). Rendering failures return the job to `ready`
 * (§10) — intermediates (the OPFS source) are preserved.
 */
import { getDemuxClient, getRenderClient } from '../app/workers';
import type { RpcClient, StreamMessage } from '../core/rpc';
import type { ClipSpec, SourceMeta } from '../core/types';

export interface RenderProgress {
  pct: number; // 0..100 across the whole render
  stage: 'rendering';
  note?: string;
  etaSec?: number;
}

/** True when WebCodecs rejected the codec/config → caller should FFmpeg-fallback. */
export function isCodecUnsupported(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /WEB_CODECS_VIDEO_UNSUPPORTED|AUDIO_ENCODER_UNSUPPORTED|ENCODER_UNSUPPORTED|B_FRAME_OUTPUT_UNSUPPORTED|NotSupportedError|avc1.*not supported|no available encoder/i.test(
    msg,
  );
}

function audioModeFor(source: SourceMeta): 'remux' | 'pcm' | 'none' {
  if (!source.audioCodec) return 'none';
  if (source.audioCodec.startsWith('mp4a.40.')) return 'remux';
  return 'pcm';
}

export async function renderClipToBlob(
  spec: ClipSpec,
  source: SourceMeta,
  onProgress: (p: RenderProgress) => void,
): Promise<Blob> {
  const demux: RpcClient<import('../core/rpc').DemuxWorker> = getDemuxClient();
  const render: RpcClient<import('../core/rpc').RenderWorker> = getRenderClient();

  const demuxId = crypto.randomUUID();
  const renderId = crypto.randomUUID();
  let torn = false;

  const forwardFromDemux = demux.onStream((msg: StreamMessage) => {
    if (msg.id !== demuxId || torn) return;
    // Re-target the message at the render request; sendStream transfers
    // VideoFrames/AudioData/buffers automatically by kind.
    render.sendStream({ ...msg, id: renderId });
  });
  const forwardFromRender = render.onStream((msg) => {
    if (msg.id !== renderId || torn) return;
    if (msg.kind === 'ack') {
      demux.sendStream({ id: demuxId, kind: 'ack', batchId: msg.batchId });
    }
  });

  const teardown = (): void => {
    torn = true;
    forwardFromDemux();
    forwardFromRender();
  };

  const abortAll = (): void => {
    demux.sendStream({ id: demuxId, kind: 'abort' });
    render.sendStream({ id: renderId, kind: 'abort' });
  };

  const demuxReq = demux.request(
    'demux.streamClip',
    {
      startSec: spec.sourceStartSec,
      endSec: spec.sourceEndSec,
      audio: audioModeFor(source),
    },
    {
      requestId: demuxId,
      onProgress: (p) => {
        onProgress({
          pct: Math.max(0, Math.min(25, p.pct * 0.25)),
          stage: 'rendering',
          note: p.note ?? 'reading',
        });
      },
    },
  );
  const renderReq = render.request(
    'render.clip',
    { spec, source },
    {
      requestId: renderId,
      onProgress: (p) => {
        onProgress({
          pct: Math.max(25, Math.min(100, 25 + p.pct * 0.75)),
          stage: 'rendering',
          note: p.note,
          etaSec: p.etaSec,
        });
      },
    },
  );

  // Start signals only after both handlers are live and forwards are wired.
  // (demux waits for its 'go'; render also waits for its own so neither can
  // observe messages before its onStream handler is registered.)
  demux.sendStream({ id: demuxId, kind: 'go' });
  render.sendStream({ id: renderId, kind: 'go' });

  const res = { mp4: null as Uint8Array | null };
  let firstError: Error | null = null;
  const track = async (p: Promise<unknown>, kind: 'demux' | 'render'): Promise<void> => {
    try {
      const value = await p;
      if (kind === 'render') {
        res.mp4 = (value as { mp4: Uint8Array }).mp4;
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (!firstError) {
        firstError = e;
        abortAll();
      }
    }
  };
  await Promise.all([track(demuxReq, 'demux'), track(renderReq, 'render')]);
  teardown();

  if (res.mp4) {
    return new Blob([res.mp4.slice().buffer as ArrayBuffer], { type: 'video/mp4' });
  }
  throw firstError ?? new Error('render produced no output');
}
