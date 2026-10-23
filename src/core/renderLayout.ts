/**
 * Shared render layout math (SPEC §8.6 crop/format, §8.10 output sizing).
 * Pure: used by render.worker and the FFmpeg fallback so both produce
 * identical output geometry.
 */
import type { ClipSpec, SourceMeta } from './types';

export const VIDEO_CODEC = 'avc1.640028'; // ≤ High 3.1 — broadly supported in tabs

export interface OutputLayout {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  outW: number;
  outH: number;
}

export function align2(n: number): number {
  return Math.max(2, n & ~1);
}

export function computeLayout(spec: ClipSpec, source: SourceMeta): OutputLayout {
  let sx = 0;
  let sy = 0;
  let sw = source.width;
  let sh = source.height;

  const key = spec.crop[0];
  if (key && key.width > 0) {
    sx = Math.round(key.x);
    sw = Math.round(key.width);
    sx = Math.max(0, Math.min(sx, source.width - 2));
    sw = Math.max(2, Math.min(sw, source.width - sx));
  }
  if (spec.format === 'vertical') {
    const targetAR = 9 / 16;
    const cropAR = sw / Math.max(1, sh);
    if (Math.abs(cropAR - targetAR) > 0.01) {
      if (cropAR > targetAR) {
        const newW = Math.round(sh * targetAR);
        sx += Math.round((sw - newW) / 2);
        sw = newW;
      } else {
        const newH = Math.round(sw / targetAR);
        sy += Math.round((sh - newH) / 2);
        sh = newH;
      }
    }
    const outH = spec.exportPreset === '720p' ? 1280 : 1920;
    const outW = Math.round((outH * targetAR) / 2) * 2;
    return { sx, sy, sw, sh, outW, outH };
  }

  // 'original' aspect: cap the long edge, never upscale, align2.
  const maxDim = spec.exportPreset === '720p' ? 1280 : 1920;
  const scale = Math.min(1, maxDim / Math.max(sw, sh));
  return {
    sx,
    sy,
    sw,
    sh,
    outW: align2(Math.round(sw * scale)),
    outH: align2(Math.round(sh * scale)),
  };
}

export function clampBitrate(w: number, h: number, fps: number): number {
  return Math.max(1_500_000, Math.min(12_000_000, Math.round(w * h * fps * 0.12)));
}
