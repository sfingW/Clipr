/**
 * Capability tiers (SPEC §11).
 *
 * Phase 0: `detectTier()` is a hardcoded stub returning `'basic'`.
 * The real WebGPU probe (adapter presence + limits) lands before Phase 4.
 */
export type Tier = 'full' | 'basic' | 'minimal';

export async function detectTier(): Promise<Tier> {
  return 'basic';
}
