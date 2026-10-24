/**
 * Capability tiers (SPEC §11).
 *
 * `detectTier()` still returns `'basic'`: ASR keeps the shipped Whisper model
 * (Phase 2). WebGPU is probed separately by `probeWebGpu()` because it gates
 * the AI scoring controls (Phase 4) without changing the transcription model.
 */
export type Tier = 'full' | 'basic' | 'minimal';

export async function detectTier(): Promise<Tier> {
  return 'basic';
}

/** Minimal shape of `navigator.gpu` (WebGPU types are not in the tsconfig lib). */
interface GpuAdapterLike {
  features: { has(feature: string): boolean };
}
interface GpuLike {
  requestAdapter(): Promise<GpuAdapterLike | null>;
}

/**
 * True when WebGPU can run the scoring model: an adapter exists and it has
 * `shader-f16`, which SmolLM2-360M-Instruct-q4f16_1 requires. Never throws.
 */
export async function probeWebGpu(): Promise<boolean> {
  try {
    const gpu = (globalThis.navigator as unknown as { gpu?: GpuLike } | undefined)?.gpu;
    if (!gpu) return false;
    const adapter = await gpu.requestAdapter();
    if (!adapter) return false;
    return adapter.features.has('shader-f16');
  } catch {
    return false;
  }
}
