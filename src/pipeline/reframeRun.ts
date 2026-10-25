/**
 * Auto-Reframe orchestration (SPEC §8.8), main thread. Relays the clip's video
 * from the demux worker to the vision worker (acked batches, as in render), then
 * turns the face samples into crop keyframes with the pure reframe module.
 *
 * Failure of any kind (no MediaPipe, model load error, worker crash) resolves to
 * an empty crop array, which means a center crop. The result is never an error
 * for the user, only a note.
 */
import type { ClipSpec, CropKeyframe, SourceMeta } from '../core/types';
import type { StreamMessage } from '../core/rpc';
import { getDemuxClient, getVisionClient } from '../app/workers';
import { computeCropKeyframes } from './reframe';

/** Loose upper bound for one clip's face pass. */
const TRACK_TIMEOUT_MS = 10 * 60_000;

export interface ReframeOutcome {
  crop: CropKeyframe[];
  /** Why the center crop was used, when it was (for the UI note). */
  note: string | null;
}

export async function runAutoReframe(spec: ClipSpec, source: SourceMeta): Promise<ReframeOutcome> {
  const centre = (note: string | null): ReframeOutcome => ({ crop: [], note });
  if (!(source.width > 0 && source.height > 0)) return centre('Auto-reframe needs a video size; using a center crop.');

  const demux = getDemuxClient();
  const vision = getVisionClient();
  const demuxId = crypto.randomUUID();
  const visionId = crypto.randomUUID();
  let torn = false;

  const forwardFromDemux = demux.onStream((msg: StreamMessage) => {
    if (msg.id !== demuxId || torn) return;
    vision.sendStream({ ...msg, id: visionId });
  });
  const forwardFromVision = vision.onStream((msg: StreamMessage) => {
    if (msg.id !== visionId || torn) return;
    if (msg.kind === 'ack') demux.sendStream({ id: demuxId, kind: 'ack', batchId: msg.batchId });
  });
  const teardown = (): void => {
    torn = true;
    forwardFromDemux();
    forwardFromVision();
  };

  try {
    const demuxReq = demux.request(
      'demux.streamClip',
      { startSec: spec.sourceStartSec, endSec: spec.sourceEndSec, audio: 'none' },
      { requestId: demuxId },
    );
    const visionReq = vision.request(
      'vision.track',
      { start: spec.sourceStartSec, end: spec.sourceEndSec },
      { requestId: visionId, timeoutMs: TRACK_TIMEOUT_MS },
    );
    // Each side aborts the other on failure: an unacked stream would otherwise
    // wait forever, and vision would wait out its timeout.
    const demuxDone = demuxReq.catch((err: unknown) => {
      vision.sendStream({ id: visionId, kind: 'abort' });
      throw err;
    });
    demuxDone.catch(() => undefined); // handled below; avoids an unhandled rejection
    // Start the demux only after both sides are listening.
    demux.sendStream({ id: demuxId, kind: 'go' });

    const samples = await visionReq.catch((err: unknown) => {
      demux.sendStream({ id: demuxId, kind: 'abort' });
      throw err;
    });
    await demuxDone;

    const crop = computeCropKeyframes(samples, {
      clipStartSec: spec.sourceStartSec,
      clipEndSec: spec.sourceEndSec,
      sourceWidth: source.width,
      sourceHeight: source.height,
    });
    return crop.length > 0
      ? { crop, note: null }
      : centre('No faces found in this clip; using a center crop.');
  } catch (err) {
    console.warn('[clipr] auto-reframe failed; using center crop:', err instanceof Error ? err.message : String(err));
    return centre('Auto-reframe unavailable; using a center crop.');
  } finally {
    teardown();
  }
}
