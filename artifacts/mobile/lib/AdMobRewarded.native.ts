const ADMOB_ANDROID_REWARDED_UNIT_ID = "ca-app-pub-8438801760716180/1098974535";

export async function showRewardedAd(): Promise<boolean> {
  try {
    const {
      default: mobileAds,
      RewardedAd,
      RewardedAdEventType,
    } = require("react-native-google-mobile-ads");

    await mobileAds().initialize();
    const rewarded = RewardedAd.createForAdRequest(ADMOB_ANDROID_REWARDED_UNIT_ID);

    return await new Promise<boolean>((resolve) => {
      let earned = false;
      let settled = false;
      let loadedSubscription: { remove: () => void };
      let earnedSubscription: { remove: () => void };
      let closedSubscription: { remove: () => void };
      let errorSubscription: { remove: () => void };

      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        loadedSubscription?.remove();
        earnedSubscription?.remove();
        closedSubscription?.remove();
        errorSubscription?.remove();
        resolve(value);
      };

      loadedSubscription = rewarded.addAdEventListener(
        RewardedAdEventType.LOADED,
        () => { rewarded.show().catch(() => finish(false)); }
      );
      earnedSubscription = rewarded.addAdEventListener(
        RewardedAdEventType.EARNED_REWARD,
        () => { earned = true; }
      );
      closedSubscription = rewarded.addAdEventListener(
        RewardedAdEventType.CLOSED,
        () => finish(earned)
      );
      errorSubscription = rewarded.addAdEventListener(
        RewardedAdEventType.ERROR,
        () => finish(false)
      );
      rewarded.load();
    });
  } catch {
    return false;
  }
}