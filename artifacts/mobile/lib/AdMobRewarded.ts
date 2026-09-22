/**
 * TypeScript fallback used by the editor/typechecker.
 * Platform-specific files provide the real implementation at runtime.
 */
export async function showRewardedAd(): Promise<boolean> {
  return false;
}