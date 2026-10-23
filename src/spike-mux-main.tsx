/**
 * `/spike-mux.html` entry — Phase-1 proof harness (SPEC §18: mp4box.js is the
 * only muxer; no hand-rolled boxes). Runs the REAL pipeline end-to-end in a
 * bare page (no app state), then re-parses + re-decodes the produced MP4 to
 * prove the output is well-formed.
 */
import { ingestFile } from './pipeline/ingest';
import { renderClipToBlob } from './pipeline/render';
import { locateMoov, parseMoovBytes, type ByteRangeReader } from './core/mp4Parse';
import type { ClipSpec, SourceMeta } from './core/types';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

const fileInput = $<HTMLInputElement>('file');
const startInput = $<HTMLInputElement>('start');
const endInput = $<HTMLInputElement>('end');
const runBtn = $<HTMLButtonElement>('run');
const logEl = $<HTMLPreElement>('log');
const statusEl = $<HTMLSpanElement>('status');
const downloadEl = $<HTMLAnchorElement>('download');

let picked: File | null = null;
let opened: Awaited<ReturnType<typeof ingestFile>> | null = null;
let resultUrl: string | null = null;

function log(line: string): void {
  const t = new Date().toISOString().slice(11, 23);
  logEl.textContent += `[${t}] ${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

fileInput.addEventListener('change', () => {
  picked = fileInput.files?.[0] ?? null;
  runBtn.disabled = !picked;
  log(picked ? `picked: ${picked.name} (${picked.size} bytes)` : 'no file');
});

function memoryReader(bytes: Uint8Array): ByteRangeReader {
  return async (offset, length) => {
    const end = Math.min(bytes.byteLength, offset + length);
    if (offset >= bytes.byteLength || end <= offset) return new Uint8Array(0);
    return bytes.subarray(offset, end);
  };
}

async function verifyOutput(blob: Blob): Promise<void> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  log(`output: ${blob.size} bytes`);

  const reader = memoryReader(bytes);
  const moov = await locateMoov(reader, bytes.byteLength);
  if (!moov) throw new Error('output has no moov');
  const parsed = await parseMoovBytes(await reader(moov.offset, moov.size), moov.offset);
  log(
    `parsed: duration=${parsed.durationSec.toFixed(3)}s ` +
      `video=${parsed.video ? `${parsed.video.width}x${parsed.video.height} ${parsed.video.codec}` : 'none'} ` +
      `audio=${parsed.audio ? `${parsed.audio.codec} ${parsed.audio.sampleRate}Hz` : 'none'}`,
  );
  const vt = parsed.video;
  if (!vt?.table) throw new Error('output video track missing sample table');
  log(`video samples=${vt.table.count} (first size=${vt.table.sizes[0]}B)`);

  // Decode the first output sample — proof the avcC + sample bytes are sane.
  const entry = vt.stsdEntry;
  const avcC = entry?.avcC ?? entry?.boxes?.find((b) => b.type === 'avcC');
  if (!avcC || avcC.start === undefined || avcC.size === undefined) throw new Error('output has no avcC');
  const description = await reader(avcC.start + (avcC.hdr_size ?? 0), avcC.size - (avcC.hdr_size ?? 0));
  const data = await reader(vt.table.offsets[0], vt.table.sizes[0]);
  const frame = await new Promise<VideoFrame>((resolve, reject) => {
    const dec = new VideoDecoder({
      output: (f) => {
        dec.close();
        resolve(f);
      },
      error: (e) => reject(e),
    });
    dec.configure({
      codec: vt.codec,
      codedWidth: vt.width,
      codedHeight: vt.height,
      description,
      optimizeForLatency: true,
    });
    dec.decode(
      new EncodedVideoChunk({ type: 'key', timestamp: 0, data }),
    );
    void dec.flush().catch(reject);
  });
  log(`first output frame decodes: ${frame.displayWidth}x${frame.displayHeight}`);
  frame.close();
  log('SPIKE PASS — mux produced a parseable, decodable MP4');
}

runBtn.addEventListener('click', () => {
  const file = picked;
  if (!file) return;
  void (async () => {
    runBtn.disabled = true;
    downloadEl.style.display = 'none';
    if (resultUrl) {
      URL.revokeObjectURL(resultUrl);
      resultUrl = null;
    }
    try {
      statusEl.textContent = 'running…';
      if (!opened) {
        log('ingest: writing to OPFS + mp4box probe…');
        opened = await ingestFile(file, {
          onProgress: (pct, note) => log(`ingest ${pct.toFixed(0)}% ${note ?? ''}`),
        });
        const s = opened.source;
        log(
          `source: ${s.fileName} ${s.width}x${s.height} ${s.durationSec.toFixed(3)}s ` +
            `fps=${s.frameRate.toFixed(2)} video=${s.videoCodec} audio=${s.audioCodec}`,
        );
      }
      const source: SourceMeta = opened.source;
      const startSec = Math.max(0, Number(startInput.value) || 0);
      const endSec = Math.min(source.durationSec, Number(endInput.value) || source.durationSec);
      if (endSec - startSec < 0.2) throw new Error('end must exceed start by ≥0.2s');
      const spec: ClipSpec = {
        id: crypto.randomUUID(),
        sourceStartSec: startSec,
        sourceEndSec: endSec,
        crop: [],
        captionStyleId: 'bold-center',
        captions: [],
        format: 'original',
        exportPreset: '1080p',
      };
      log(`render: cut [${startSec}, ${endSec}) …`);
      const blob = await renderClipToBlob(spec, source, (p) => {
        statusEl.textContent = `${p.pct.toFixed(0)}% ${p.note ?? ''}`;
      });
      log('render: done — verifying output…');
      await verifyOutput(blob);
      resultUrl = URL.createObjectURL(blob);
      downloadEl.href = resultUrl;
      downloadEl.style.display = '';
      statusEl.textContent = 'done';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`FAIL: ${msg}`);
      statusEl.textContent = 'failed';
    } finally {
      runBtn.disabled = !picked;
    }
  })();
});

log('ready — pick an MP4 (fixtures were built with ffmpeg: 1s and 16s test clips).');
