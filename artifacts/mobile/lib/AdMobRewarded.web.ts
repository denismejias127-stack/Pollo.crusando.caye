declare global {
  interface Window {
    __POLLO_REWARDED_AD__?: () => Promise<boolean> | boolean;
  }
}

export async function showRewardedAd(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const bridge = window.__POLLO_REWARDED_AD__;
  if (!bridge) return false;
  return Boolean(await bridge());
}