# Publishing CADView 1.0.0 on Google Play and the App Store

Version 1.0.0 is free, has no ads, no in-app purchases and no account, and doesn't use the internet. That keeps both reviews simple: the privacy answers are all "no data collected".

This guide goes in order. Android can be done from any computer. iOS needs a Mac (or a rented cloud Mac, see section 5.1).

---

## 0. What's in this package

| Path | What it is |
|---|---|
| `store/PUBLISHING.md` | This guide |
| `store/FORMS.md` | Answers for every questionnaire: Play "App content", data safety, content rating, Apple App Privacy, age rating, export compliance, notes for App Review |
| `store/listing/google-play.md` | Play listing text: name, short and full description, category, release notes |
| `store/listing/app-store.md` | App Store listing text: name, subtitle, keywords, description, URLs, category |
| `store/website/` | Support page (`index.html`) and privacy policy (`privacy.html`) to host online |
| `store/assets/play-icon-512.png` | Play Store icon, 512×512 |
| `store/assets/play-feature-graphic-1024x500.png` | Play feature graphic |
| `store/assets/app-store-icon-1024.png` | App Store icon (the build already contains it) |
| `store/screenshots/google-play/phone/` | 7 phone screenshots, 1080×1920 |
| `store/screenshots/google-play/tablet-7in/` | 7 screenshots, 1200×1920 |
| `store/screenshots/google-play/tablet-10in/` | 7 screenshots, 2560×1600 (landscape) |
| `store/screenshots/app-store/iphone-6.9in/` | 7 screenshots, 1320×2868 |
| `store/screenshots/app-store/ipad-13in-landscape/` | 7 screenshots, 2752×2064 |
| `store/screenshots/app-store/ipad-13in-portrait/` | 7 screenshots, 2064×2752 |
| `scripts/make-upload-key.sh` | Creates your Android upload key and `android/keystore.properties` |
| `scripts/check-listing.cjs` | Checks the listing texts against the character limits |
| `scripts/make-screenshots.cjs` | Re-creates all screenshots from the app (`npm run store:screenshots`) |
| `ios/App/App/PrivacyInfo.xcprivacy` | Apple privacy manifest (no tracking, no data collected) |

Already set up in the projects:
- Android: app ID `app.cadview.viewer`, versionName 1.0.0, versionCode 10, targetSdk 36, minSdk 24 (Android 7.0+). Release signing reads `android/keystore.properties`. No INTERNET permission.
- iOS: bundle ID `app.cadview.viewer`, version 1.0.0, build 1, iOS 15+, iPhone and iPad. All four iPad orientations are on, so iPad landscape, Split View and Stage Manager work. Export compliance is answered in Info.plist. DWG, DXF and SKP are registered as document types, so "Open in CADView" appears in Files and Mail.

---

## 1. Decide these first (they can't be changed later)

1. **App ID / bundle ID.** It is currently `app.cadview.viewer`. Once the first build is uploaded, it's permanent on both stores. If you'd like your own, for example `com.yourname.cadview`, change it now in:
   - `capacitor.config.ts` → `appId`
   - `android/app/build.gradle` → `applicationId` and `namespace`. Also move `android/app/src/main/java/app/cadview/viewer/` to the new package path and update the `package` line in its `.java` files.
   - Xcode → App target → General → Bundle Identifier
2. **App name.** The listing uses "CADView: DWG, DXF & SKP Viewer". The App Store requires a unique name. Search both stores first. If "CADView" is taken, try something like "CADView Offline" or a name of your own. The name on the home screen stays "CADView" (CFBundleDisplayName / app_name).
   Keep "AutoCAD" and "SketchUp" out of the app name, icon and App Store keywords. They are other companies' trademarks. Mentioning in the description that the app opens their files is fine, and the description carries a disclaimer.
3. **Developer name.** It appears on both store pages. Individual accounts show your legal name. A company account shows the company name and needs a D-U-N-S number (free from Dun & Bradstreet, about 1–2 weeks).
4. **Support email.** It is shown publicly on Google Play. Consider a separate address, for example cadview.support@…

---

## 2. Fill in the placeholders

Search the `store/` folder for `[[` and replace:

| Placeholder | Example |
|---|---|
| `[[DEVELOPER NAME]]` | Your legal name or company |
| `[[CONTACT EMAIL]]` | Your support email |
| `[[SUPPORT URL]]` | `https://<github-user>.github.io/cadview/` (with the trailing slash) |
| `[[DATE]]` | The date you publish the privacy policy |

```bash
grep -rn "\[\[" store/
```

---

## 3. Put the privacy policy and support page online

Both stores require a public privacy policy URL. Apple also requires a support URL. The pages in `store/website/` are plain HTML and can go on any static host. The easiest free options:

**GitHub Pages, from a small public repo** (works even if your app's code repo stays private):
1. On GitHub, create a new **public** repo named `cadview`.
2. Upload the three files from `store/website/` (index.html, privacy.html, style.css) to it.
3. Repo → Settings → Pages → Source: *Deploy from a branch* → `main` / root → Save.
4. After a minute the pages are at `https://<github-user>.github.io/cadview/` and `…/cadview/privacy.html`.

Other options: Netlify Drop (drag the folder onto app.netlify.com/drop), Cloudflare Pages, or Google Sites (paste the text in).

Open both URLs on your phone before you continue. Reviewers do check that they load.

---

## 4. Android: Google Play

### 4.1 Test on your own phones and tablets first

`release/CADView-1.0.0-debug.apk` installs directly. Copy it to the device, open it, and allow "Install unknown apps" for your file manager when asked.

Things to try on a phone **and** a tablet in landscape:
- Open each home-screen sample
- Share a .dwg from WhatsApp or Gmail to CADView
- Measure, add notes, export a PDF
- Switch light/dark, rotate the device

The debug APK and the Play version are signed with different keys. Uninstall the debug one before installing from Play.

### 4.2 What you need

- A Google account and **US$25** (one-time) for a Play Console developer account: https://play.google.com/console/signup
- **Personal** account: identity verification with a government ID, a verified phone number, and confirmation that you have access to a real Android device (done through the Play Console mobile app). It usually takes 1–3 days.
- **Organisation** account: a D-U-N-S number, the organisation's website, and verification of the organisation's details.
- On your computer: Node.js 20+, JDK 21 (or Android Studio, which bundles one), and the Android SDK (Android Studio installs it).

### 4.3 Create your upload key (once)

```bash
bash scripts/make-upload-key.sh
```

This creates `~/cadview-keys/cadview-upload.jks` and `android/keystore.properties`. `.gitignore` already excludes both from git.
**Back up the .jks file and its password** in a password manager plus an offline copy. Google holds the real signing key (Play App Signing); this one only proves uploads come from you. If you lose it, Play support can reset it, but it takes days.

### 4.4 Build the release bundle

```bash
npm ci
npm run release:android
```

Output: `android/app/build/outputs/bundle/release/app-release.aab` (about 4.6 MB).
This was test-built in this project with a throwaway key: the AAB and the release APK build without errors, contain no native libraries (so the 16 KB page-size rule doesn't apply), and request only the VIBRATE permission.

If you prefer Android Studio: `npm run cap:android` → Build → Generate Signed App Bundle → Android App Bundle → choose your .jks.

### 4.5 Create the app in Play Console

1. Play Console → **Create app**
   - App name: `CADView: DWG, DXF & SKP Viewer`
   - Default language: English (United States), or your choice
   - App or game: **App**. Free or paid: **Free**. A free app can never be made paid later, but you can add ads or in-app purchases.
   - Tick the declarations → Create app
2. **Policy and programs → App content**: work through every item using `store/FORMS.md`.
3. **Grow users → Store presence → Main store listing**: paste the texts from `store/listing/google-play.md`, then upload the icon, the feature graphic and the phone, 7-inch and 10-inch screenshots.
4. **Store settings**: category Productivity, contact email, optional website.

### 4.6 Testing tracks: required before production for new personal accounts

Google requires personal developer accounts created after November 2023 to run a **closed test with at least 12 testers who stay opted in for 14 days in a row** before you can apply for production. Organisation accounts can skip this, but it's still a good idea.

1. **Test and release → Testing → Internal testing** → Create new release → upload `app-release.aab` → release name `1.0.0 (10)` → Save → Review → Roll out.
   - Add yourself as a tester (an email list). Open the opt-in link on your phone, then install from Play. Check that it works. Internal testing doesn't need review and is live within minutes.
2. **Closed testing** → Create track (or use "Closed testing – Alpha") → **promote** the same release from internal testing → countries: all → add testers.
   - Testers need a Google account. Use an email list or a Google Group. Friends, colleagues, a CAD forum or an architecture student group all work.
   - Each tester opens the opt-in link, joins, and **installs the app from Play**. Ask them to open it a few times over the two weeks. Google looks at engagement, not just sign-ups.
   - Recruit 15 or more, because some people forget to opt in.
3. After 14 days with at least 12 opted-in testers: **Dashboard → Apply for production**. Google asks a few short questions about the test (how you found testers, what feedback you got, what you changed). Approval usually takes up to 7 days.

### 4.7 Production release

1. **Test and release → Production → Create new release** → add the same AAB from the library (or a newer one) → release notes from the listing file.
2. Countries/regions: **Add countries → All**.
3. **Send for review.** The first review of a new app typically takes 1–7 days. When approved, publish (or set "Managed publishing" to choose the moment).

### 4.8 Updates

- Increase `versionCode` (10 → 11 → …) and `versionName` (1.0.1, 1.1.0) in `android/app/build.gradle` for every upload. Play rejects a versionCode it has already seen.
- Also update `"version"` in `package.json`, because the About screen shows it.
- `npm run release:android` → upload to Production (or test first in Internal testing).
- Each August Google raises the minimum target API for updates. If an update is blocked by target API, raise `targetSdkVersion` in `android/variables.gradle`, then rebuild and test.

---

## 5. iOS and iPad: App Store

### 5.1 What you need

- **A Mac with macOS 15.6 (Sequoia) or later and Xcode 26 or later** (free from the Mac App Store). App Store Connect only accepts builds made with the current major SDK (iOS 26 since spring 2026).
  - No Mac? Rent one by the hour (MacinCloud, AWS EC2 Mac), or use a CI service with macOS machines (Codemagic, Bitrise, GitHub Actions macOS runners). The steps below are the same, run remotely.
- **Apple Developer Program, US$99 per year**: https://developer.apple.com/programs/enroll/
  - Individual: an Apple Account with two-factor authentication, and your legal name. Approval is usually 1–2 days.
  - Organisation: a D-U-N-S number, legal entity status, and a website on the company domain.
  - The Apple Developer app on iPhone/iPad can also handle enrolment and is often faster.
- An **iPad** (and an iPhone if you have one) for testing.

### 5.2 Open the project on the Mac

```bash
git clone <your repo> && cd duvi/cadview
npm ci
npm run release:ios          # builds the web app, syncs it into ios/, opens Xcode
```

The iOS project uses Swift Package Manager (Capacitor 8), so there is no CocoaPods step. Xcode resolves packages the first time it opens the project (give it a minute).

In Xcode, select the **App** project → **App** target → **Signing & Capabilities**:
- Tick **Automatically manage signing**
- **Team**: your developer team (sign in under Xcode → Settings → Accounts first)
- **Bundle Identifier**: `app.cadview.viewer`, or the one you chose in section 1

Then **General** tab:
- Display name: CADView. Version 1.0.0, build 1.
- Supported destinations: iPhone and iPad are already listed. Don't add "Mac (Designed for iPad)" or visionOS unless you want them.
- iPad orientations: all four ticked (already set). Don't tick "Requires full screen". It would turn off Split View and Stage Manager.

### 5.3 Run it on your iPad (no review needed)

1. Connect the iPad with a cable, then tap **Trust** on the iPad.
2. On the iPad, go to Settings → Privacy & Security → **Developer Mode** → on (the iPad restarts).
3. In Xcode, pick the iPad at the top (next to the App scheme) → press **Run** (▶).
4. The app installs and opens. Rotate the iPad to check landscape, try Split View (drag another app from the Dock to the side), and try Stage Manager if your iPad supports it.

Builds signed with a paid developer account keep working for a year. Builds signed with a free Apple ID stop after 7 days. For other people's iPads, use TestFlight (5.6).

### 5.4 Register the app in App Store Connect

1. https://appstoreconnect.apple.com → **Apps → + → New App**
   - Platforms: **iOS**. This covers iPhone and iPad, because the build supports both.
   - Name: `CADView: DWG, DXF & SKP Viewer` (must be unique on the store)
   - Primary language: English (U.S.)
   - Bundle ID: pick `app.cadview.viewer` from the list. If it isn't listed, Xcode hasn't registered it yet. Run once on a device as in 5.3, or add it at developer.apple.com → Identifiers.
   - SKU: `cadview-ios-1` (any text, never shown)
   - User access: Full access
2. **Business** (account level, once): sign the **Free Apps Agreement**, which is accepted automatically by your membership. Paid apps would need banking and tax details. Free apps don't.
   Answer the **EU Digital Services Act trader status** question (see FORMS.md).

### 5.5 Archive and upload the build

In Xcode:
1. At the top, choose **Any iOS Device (arm64)** as the destination.
2. **Product → Archive**. It takes a few minutes, then the Organizer window opens.
3. **Distribute App → App Store Connect → Upload**, and keep the default options (automatic signing, upload symbols).
4. After 5–30 minutes the build appears in App Store Connect → your app → **TestFlight** with status "Ready to Submit" (or "Missing Compliance". That shouldn't happen, because Info.plist already answers it).

### 5.6 TestFlight: install on iPads and iPhones

- **Internal testers** (up to 100 people on your App Store Connect team): TestFlight tab → Internal Testing → **+** → add people → they get the build right away, with no review.
- **External testers** (up to 10,000, by email or a public link): TestFlight → External Testing → create a group → add the build → fill in "What to Test" → **Submit for Beta Review**. The first one takes about 1 day. After that, you share the public link.
- Testers install the free **TestFlight** app from the App Store on their iPad or iPhone, then open your invite or link. A TestFlight build works for 90 days.

### 5.7 Fill in the App Store page

App Store Connect → your app:
1. **App Information**: subtitle, category (Productivity / Utilities), content rights (No), age rating questionnaire (all No → 4+). See FORMS.md.
2. **Pricing and Availability**: Price **Free** (USD 0), all countries and regions.
3. **App Privacy**: Privacy Policy URL → **Data Not Collected** (FORMS.md).
4. **iOS App → 1.0 Prepare for Submission**:
   - Screenshots: **iPhone 6.9"** → upload the 7 files from `store/screenshots/app-store/iphone-6.9in/`. **iPad 13"** → `ipad-13in-landscape/` (or portrait). You can drag them in, then reorder.
   - Promotional text, description, keywords, support URL, marketing URL: from `store/listing/app-store.md`
   - Version: 1.0.0. Copyright: `2026 Your Name`
   - **Build**: click + and pick the uploaded build
   - **App Review Information**: sign-in not required. Add your contact name, phone and email, and paste the review notes from FORMS.md.
   - **Version Release**: "Automatically release this version" or "Manually release".
5. **Add for Review → Submit to App Review**.

Review usually takes 24–48 hours. If it's rejected, the message in **App Review → Resolution Center** says why. Fix it, upload a new build if needed (raise the build number), and reply there.

### 5.8 Updates

- Xcode → App target → General: raise **Version** (1.0.1) and **Build** (2, 3, …). Every upload needs a new build number.
- Update `package.json` `"version"` to match (the About screen shows it).
- `npm run release:ios` → Product → Archive → Upload → App Store Connect → **+ Version** → choose the build → Submit.

---

## 6. iPad landscape: what's done and what to check

Configured in the project:
- `UISupportedInterfaceOrientations~ipad` lists all four orientations, and `UIRequiresFullScreen` is not set. Apple requires this for iPad multitasking, and it lets the app run in Split View, Slide Over and Stage Manager windows of any size.
- `TARGETED_DEVICE_FAMILY = 1,2`: a native iPad app, not an iPhone app scaled up.
- The layout responds to the window size rather than the device type. In wide windows the toolbar stays centred at the bottom and panels open as side sheets. On short landscape phones the toolbar becomes a rail on the right. The drawing is framed so nothing sits under the bars. This was fixed in this version: the fit used to measure the toolbar before its buttons existed.
- The iPad 13" landscape screenshots in `store/screenshots/app-store/ipad-13in-landscape/` were made from the real app at 2752×2064.

Check on a real iPad before you submit:
- Rotate while a drawing is open: the view stays centred and the toolbar moves to the right place.
- In Split View at 1/3 width, the app should use the phone layout.
- With a Magic Keyboard or trackpad, if you have one: check that pinch and scrolling zoom. Touch gestures are the main way to use the app, and trackpad support hasn't been tested on a real iPad yet.

---

## 7. Costs and time

| | Google Play | App Store |
|---|---|---|
| Fee | US$25 once | US$99 per year |
| Account approval | 1–3 days (ID check) | 1–2 days (individual), 1–2 weeks (company, D-U-N-S) |
| Testing before release | Personal accounts: 12+ testers for 14 days | None required (TestFlight optional) |
| Review of version 1.0 | 1–7 days after production access | Usually 1–2 days |
| Hardware | Any computer | A Mac with Xcode 26+ (or a rented one) |

A realistic plan: create both accounts on day 1, start the Play closed test as soon as the Play account is verified, and submit to Apple during the 14-day Play test. Both stores can go live in about 3 weeks.

---

## 8. Common rejection reasons and how this build handles them

| Reason | Status |
|---|---|
| Privacy policy missing or doesn't load | Pages in `store/website/`. Host them (section 3) and test the links. |
| Data safety / App Privacy doesn't match the app | The app has no network access and no SDKs that collect data, so "no data collected" is accurate. |
| Apple 4.2 Minimum functionality (looks like a website) | It works fully offline, with native file handling, share sheet, haptics and document types. |
| Apple 2.1 App completeness: reviewer can't test | Built-in samples cover every feature, and the review notes explain them. |
| Apple 2.3.7 / Play metadata: trademarks in name or keywords | Name and keywords don't use AutoCAD or SketchUp. The description has a disclaimer. |
| Apple 5.1.1: asks for permissions it doesn't need | No permission prompts at all. Files come through the system picker. |
| Play: target API too low | targetSdk 36 |
| Play: 16 KB page size | No native libraries in the bundle |
| Crashes on a reviewer's device | Test on an older phone (Android 8–10 / iPhone with iOS 15–16) and a tablet before you submit. |
| iPad layout problems (Apple tests iPad builds on iPad) | Landscape and multitasking are supported and screenshotted. Check on a real iPad (section 6). |

---

## 9. Final checklist

**Both**
- [ ] App ID / bundle ID final (section 1)
- [ ] Placeholders filled (`grep -rn "\[\[" store/` returns nothing)
- [ ] Privacy and support URLs load on a phone
- [ ] Tested on an Android phone, an Android tablet, an iPhone and an iPad, in portrait and landscape

**Google Play**
- [ ] Developer account verified
- [ ] `scripts/make-upload-key.sh` run, key backed up
- [ ] `npm run release:android` → AAB built
- [ ] App content: all items green (FORMS.md)
- [ ] Main store listing: text, icon, feature graphic, phone and tablet screenshots
- [ ] Internal test installed and working
- [ ] Closed test: 12+ testers for 14 days → production access approved
- [ ] Production release → all countries → sent for review

**App Store**
- [ ] Developer Program membership active
- [ ] Runs on your iPad from Xcode (landscape, Split View)
- [ ] App created in App Store Connect, DSA trader status answered
- [ ] Archive uploaded, build processed
- [ ] TestFlight install checked on iPad
- [ ] App Privacy: Data Not Collected. Age rating 4+. Price Free.
- [ ] iPhone 6.9" and iPad 13" screenshots, texts, URLs, review notes
- [ ] Submitted for review

---

## 10. Not in 1.0.0, on purpose

- **Ads**: switched off (`src/ads.ts`, `AD_CONFIG.enabled = false`), and the AdMob plugin is not installed. Turning them on later means a new privacy policy, new data safety and App Privacy answers, and the consent prompts. The steps are in `src/ads.ts` and at the end of FORMS.md.
- **Paper-space layouts (sheets)** in DWG/DXF are not drawn yet; the model space is. Export can produce the whole drawing, the visible area or a selected area.
