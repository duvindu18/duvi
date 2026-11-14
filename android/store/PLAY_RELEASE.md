# Publishing Veil Cam on Google Play

The **play** flavor is the store build: commercially licensed models only (see
`THIRD_PARTY_NOTICES.md`), a one-time purchase through Google Play, targetSdk 36,
16 KB-page-aligned native code, R8-shrunk, shipped as an Android App Bundle (`.aab`).
The **personal** flavor is your own sideloaded build and is never uploaded.

Steps marked **(you)** need your Google account, identity or money and can only be done
in Play Console.

## 1. Developer account (you)
1. Create a Play Console developer account (one-time US$25 fee) and complete identity
   verification. For a paid product you also need a **payments profile** (Play Console >
   Settings > Payments profile) with your bank account and tax details.
2. **New personal accounts must run a closed test before production:** at least 12
   testers opted in for 14 days in a row. Organisation accounts (with a D-U-N-S number)
   are exempt. Plan for this two-week step.

## 2. Create the app (you)
1. Play Console > Create app: name *Veil Cam*, default language, **App** (not game),
   **Free** (the purchase is in-app; a free download that unlocks with a one-time product
   lets people try the viewfinder first). Accept the declarations.
2. The package name is `com.veil.cam` (in `app/build.gradle.kts`, `applicationId`). It is
   permanent once uploaded. If Play says it is taken, change `applicationId` (e.g.
   `com.yourname.veilcam`) before the first upload.
3. Check the name *Veil Cam* is free to use as a trademark where you sell (a quick
   search of your country's trademark register and Play itself).

## 3. Keys for the build (you, then the build)
1. **Upload key:** your existing keystore (the one `VEIL_KEYSTORE` points to) becomes
   the upload key. Keep it and its password backed up; you need it for every update.
2. **Play App Signing** is on by default: Google re-signs the app for users with its own
   key. After the first upload, copy *Test and release > App integrity > App signing >
   App signing key certificate > SHA-256*.
3. **Licence key:** *Monetize > Monetization setup > Licensing* — copy the Base64 RSA
   public key. The app uses it to verify purchase signatures on the phone.
4. Build (put the values in `~/.gradle/gradle.properties` rather than on the command
   line if you prefer):

   ```bash
   cd android
   gradle :app:bundlePlayRelease \
     -PveilKeystore=/path/upload.jks -PveilKeystorePassword=... \
     -PveilPlayLicenseKey='MIIBIjANBgkq...' \
     -PveilPlaySigningSha256='AB:CD:...'      # from step 3.2; leave out for the very first upload
   # -> app/build/outputs/bundle/playRelease/app-play-release.aab
   ```
   The build fails if a model on the play allow-list is missing from `models/`
   (`face_yunet_2023mar_dyn.onnx`, `depth_anything_v2_small.onnx`,
   `selfie_multiclass_256x256.tflite`, `gesture_recognizer.task`).

   Provenance of the depth model: the copy in this workspace came from an npm package
   (`@richardmcquiston01/ai-tools`) and matches the official architecture. For the store,
   export it yourself from the official Apache-2.0 checkpoint
   (`depth-anything/Depth-Anything-V2-Small`) so the file's origin is documented.

   The very first upload can be built without `veilPlaySigningSha256` (the signing
   certificate is only known afterwards). Rebuild with it for every later release:
   from then on a re-signed (modified) copy of the app never unlocks.

## 4. The one-time product (you)
1. Upload the first `.aab` to **Internal testing** (Test and release > Testing > Internal
   testing > Create release). Play only allows products once a build with the billing
   permission is uploaded.
2. *Monetize > Products > One-time products > Create*: product ID **`veil_cam_unlock`**
   (must match `StoreLicense.PRODUCT_ID`), name "Veil Cam", a description, and a price.
   Play converts the price for every country; adjust any you like. Activate it.
3. *Settings > License testing*: add your Google account(s). Test purchases from those
   accounts are free and can be refunded instantly to test the lock coming back.

### What to test on the phone (internal testing track)
- Fresh install: viewfinder works; shutter opens the purchase sheet with the local price.
- Buy (test card): capture unlocks within seconds; "Veil Cam unlocked" appears.
- Airplane mode, restart: still unlocked (works offline up to 30 days after the last
  check with Google Play).
- Refund the test order in Play Console (Order management): after the phone is online
  and Play has synced, capture locks again (re-checked at every start, resume and
  network change).
- "Restore Purchase" on a second device with the same account: unlocks.

## 5. Store listing and App content (you, text provided)
- Listing text, data-safety answers and content-rating notes: `store/LISTING.md`.
- Icon and feature graphic: `store/icon-512.png`, `store/feature-1024x500.png`
  (`tools/store_graphics.py` regenerates them from the launcher icon).
- Screenshots: take 4–8 on your phone (Power + Volume down).
- Privacy policy: fill in `store/PRIVACY_POLICY.md` (name, email, date) and host it at a
  public URL (GitHub Pages, Google Sites or your own site); paste the URL in Play
  Console > App content > Privacy policy.
- Countries: *Production > Countries / regions > Add all*. The listing is English; add
  translations in Play Console when you have them (Play can machine-translate the
  listing; the app's interface is English).

## 6. Release
1. Closed test (12+ testers, 14 days) if your account needs it, then *Apply for
   production*.
2. Production release: upload the same `.aab` (bump `versionCode` for every new upload).
   Review usually takes a few days for a new app.

## How the purchase check works, and its limits
- The app asks Google Play for the account's purchases on every start, on resume and
  whenever a network comes up. Play returns signed purchase data; the app checks the
  RSA signature with your licence key, the product ID and the package name, and
  acknowledges new purchases (Play refunds unacknowledged ones after three days).
- A refund or revoked purchase is reported by Play as "not owned" once the phone is
  online, and capture locks again.
- Offline, the last verified purchase keeps working for 30 days; a clock set back does
  not extend that.
- A copy re-signed with any key other than Play's (the usual way cracked APKs are made)
  never unlocks, once `veilPlaySigningSha256` is set.
- R8 shrinks and obfuscates the release build.
- **Limits, honestly:** every check that runs on the phone can, with enough effort, be
  patched out of a modified copy; no app can make that impossible. The strongest
  addition is a small server of your own that verifies the purchase token with the Google
  Play Developer API (and Play Integrity verdicts) before trusting it. That needs a
  server, a Google Cloud service account and internet access in the app, which would
  change the "no internet permission" privacy promise; it is left out on purpose.

## Phones it supports
- Android 11 (API 30) or later, 64-bit ARM (every current phone), OpenGL ES 3.0, any
  camera. Play filters out devices without these.
- Camera features adapt to the phone: frame rates, 4K, HEVC (falls back to H.264), manual
  sensor control, OIS/EIS, the GPU path (MediaPipe falls back from GPU to CPU), float
  render targets for the depth filter and multi-frame merge (both fall back).
- Tablets and foldables keep the phone layout (Android 16 opt-out; it stops applying
  when the app targets API 37, due as a Play requirement around August 2027).
- Not tested on real devices other than a Pixel 9 Pro XL. Before production, try the
  internal-testing build on a few phones (e.g. a Samsung Galaxy, a Xiaomi/Redmi, a
  Motorola), or use Play Console's *Pre-launch report*, which runs the app on Google's
  test devices automatically after each upload and reports crashes.
