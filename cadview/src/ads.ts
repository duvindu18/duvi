// AdMob banner, shown on the home screen only. Never in the viewer, never full-screen, and hidden
// whenever a panel or dialog is open, so it can't get in the way of working on a drawing.
// Without internet the banner simply doesn't appear; everything else keeps working offline.
import { Capacitor } from '@capacitor/core';

/**
 * Ad unit IDs. These are Google's public TEST IDs: replace them with your own from the AdMob console
 * before publishing (and the app IDs in AndroidManifest.xml and ios/App/App/Info.plist).
 */
export const AD_CONFIG = {
  enabled: true,
  testing: true,
  bannerAndroid: 'ca-app-pub-3940256099942544/9214589741',
  bannerIos: 'ca-app-pub-3940256099942544/2435281174',
};

type AdMobApi = typeof import('@capacitor-community/admob');
let api: AdMobApi | null = null;
let ready: Promise<boolean> | null = null;
let wanted = false; // should the banner be visible right now?
let shown = false; // has showBanner() been called (banner exists)?
let visible = false;

const native = () => Capacitor.isNativePlatform() && AD_CONFIG.enabled;

/** Initialise once: consent (GDPR/UK via Google's UMP form, iOS tracking prompt), then the SDK. */
function init(): Promise<boolean> {
  if (!native()) return Promise.resolve(false);
  return (ready ??= (async () => {
    try {
      api = await import('@capacitor-community/admob');
      const { AdMob, AdmobConsentStatus, BannerAdPluginEvents } = api;
      await AdMob.initialize({ initializeForTesting: AD_CONFIG.testing });
      try {
        const info = await AdMob.requestConsentInfo();
        if (info.isConsentFormAvailable && info.status === AdmobConsentStatus.REQUIRED) await AdMob.showConsentForm();
      } catch { /* consent service unreachable (offline): ads will just not load */ }
      if (Capacitor.getPlatform() === 'ios') {
        try { const t = await AdMob.trackingAuthorizationStatus(); if (t.status === 'notDetermined') await AdMob.requestTrackingAuthorization(); } catch { /* ignore */ }
      }
      // keep page content clear of the banner
      AdMob.addListener(BannerAdPluginEvents.SizeChanged, (s) => setInset(visible ? s.height : 0));
      AdMob.addListener(BannerAdPluginEvents.FailedToLoad, () => setInset(0));
      return true;
    } catch {
      return false;
    }
  })());
}

function setInset(h: number) {
  document.documentElement.style.setProperty('--ad-h', `${Math.max(0, Math.round(h))}px`);
}

/** Call with true while the home screen is in front and nothing covers it. */
export async function homeBanner(on: boolean) {
  wanted = on;
  if (!(await init()) || !api) return;
  if (wanted !== on) return; // a newer call superseded this one
  const { AdMob, BannerAdSize, BannerAdPosition } = api;
  try {
    if (on && !visible) {
      if (!shown) {
        await AdMob.showBanner({
          adId: Capacitor.getPlatform() === 'ios' ? AD_CONFIG.bannerIos : AD_CONFIG.bannerAndroid,
          adSize: BannerAdSize.ADAPTIVE_BANNER,
          position: BannerAdPosition.BOTTOM_CENTER,
          margin: 0,
          isTesting: AD_CONFIG.testing,
        });
        shown = true;
      } else await AdMob.resumeBanner();
      visible = true;
    } else if (!on && visible) {
      await AdMob.hideBanner();
      visible = false;
      setInset(0);
    }
  } catch {
    visible = false;
    setInset(0);
  }
}
