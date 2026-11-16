# Store questionnaires – answers for CADView 1.0.0

These answers match what version 1.0.0 actually does: no internet permission, no ads, no analytics, no account, files stay on the device. If you add ads or any online feature later, these answers change. See "When you add ads" at the end.

---

## Google Play Console

Find these under **Policy and programs → App content** (Play Console calls the page "App content"). Every item must show a green tick before you can send a release for review.

### Privacy policy
URL: `[[SUPPORT URL]]privacy.html`

### Ads
**Does your app contain ads?** No.

### App access
**All functionality is available without any special access.**
(There is no login. Put the sample-files link from the review notes below in the "instructions" box, so the reviewer has files to open.)

### Content rating (IARC questionnaire)
- Email: your contact email
- Category: **All other app types** (not Game, not Social/Communication)
- Violence, sexuality, language, controlled substances, gambling: **No** to every question
- Does the app allow users to interact or exchange content with other users? **No**. Sharing a file through the system share sheet doesn't count; there's no in-app communication.
- Does the app share the user's current physical location? **No**
- Does the app allow users to purchase digital goods? **No**
- Is the app a web browser or search engine? **No**
- Unrestricted internet access? **No**

Expected result: **Everyone / PEGI 3 / USK 0 / ESRB Everyone**.

### Target audience and content
- Target age groups: **18 and over** (you may also tick 13–15 and 16–17). Don't tick any age under 13. If you do, the app falls under the Families policy and needs more review for no benefit.
- Could your store listing unintentionally appeal to children? **No**

### Data safety
- Does your app collect or share any of the required user data types? **No**
- (The form then skips the data-type list.)
- Is all of the user data collected by your app encrypted in transit? Not asked when nothing is collected.
- Do you provide a way for users to request that their data be deleted? Not asked when nothing is collected.

Why "No" is correct: Google defines *collect* as sending data off the device. CADView processes files only on the device and has no INTERNET permission, so nothing can leave the device. The share sheet is a user-initiated transfer to an app the user chooses, which Google excludes.

### Government apps
**No**

### Financial features
**My app doesn't provide any financial features**

### Health
**My app does not have any health features**

### News apps
**No**

### Advertising ID
**No**. The app doesn't use the advertising ID. (Version 1.0.0 doesn't declare the AD_ID permission.)

### Photo and video permissions
Not applicable. The app doesn't request READ_MEDIA_IMAGES or READ_MEDIA_VIDEO. Files come through the system document picker.

### Store settings
- App category: **Productivity**
- Contact email: required and shown publicly. Use a separate support address if you don't want your personal email listed.

---

## App Store Connect

### App Privacy (App Store Connect → your app → App Privacy)
- **Do you or your third-party partners collect data from this app?** **No, we do not collect data from this app.**
- The product page then shows **"Data Not Collected"**.
- Privacy Policy URL: `[[SUPPORT URL]]privacy.html`

The build includes `ios/App/App/PrivacyInfo.xcprivacy` (no tracking and no collected data; it declares file timestamp access, reason C617.1, for the app's own files). Capacitor ships its own manifest for the rest. Xcode merges it into the app's privacy report. You don't need to do anything with it.

### Age rating (App Information → Age Rating)
Answer **None / No** to every content question, and **No** for:
- Unrestricted web access
- User-generated content / messaging
- Gambling, contests, loot boxes
- Parental controls, age assurance (not applicable)

Expected result: **4+**. Apple changed the age rating questions in 2025, with more categories and new 13+, 16+ and 18+ levels. All of the new questions are also "No" for this app.

### Export compliance (encryption)
Already answered in the build: `ITSAppUsesNonExemptEncryption = NO` in Info.plist. App Store Connect won't ask about it for each build. Reason: the app uses no encryption apart from what iOS provides, and doesn't even make network requests.

### Content rights
**Does your app contain, show, or access third-party content?** **No**. The sample drawings on the support page were made for this project. User files belong to the user.

### Digital Services Act (EU trader status)
App Store Connect asks this under **Business** once, for the whole account. Google asks the same in Play Console account details.
- If you publish as a private individual, don't sell anything and don't act as a business, you can declare yourself a **non-trader**. Then your address isn't shown in the EU.
- If you publish as a business, or think you might charge for the app later, declare **trader**. Then the address, phone number and email you give are shown on the EU product page.

If you're not sure, ask a local adviser. Neither store gives legal advice on this.

### Sign-in information for App Review
**Sign-in required:** No.

### Notes for App Review (paste this)
> CADView is an offline viewer for CAD drawings (DWG, DXF) and 3D models (SketchUp SKP, GLB, OBJ, STL and others). It has no account and makes no network requests.
>
> Test files (made for this app, free to use) can be downloaded here: [[SUPPORT URL]]#samples
> In Safari, tap a file, then Download; then open CADView, tap "Open a file" and pick it from Downloads. On Android, download it in Chrome and open it from the app the same way.
> - detail.dwg: construction detail with hatches, line types, leaders and multi-line text
> - floorplan-rev-A.dxf and floorplan-rev-B.dxf: open A, then More → Compare revision and pick B
> - house.skp: SketchUp model (tags, components, section cut)
>
> To test opening a file from another app: in Files, long-press a .dwg or .dxf file, tap Share, then tap CADView.
>
> Export: open any file, tap the Share button at the top right, then choose PDF or PNG.

---

## When you add ads later (for reference, not for 1.0.0)

These answers become "Yes" and both privacy pages change:
- Play: Ads → **Yes**. Data safety → device or other IDs, app interactions, diagnostics, and approximate location (AdMob), shared with Google for advertising. Advertising ID → **Yes, Advertising or marketing**.
- Apple: App Privacy → Identifiers, Usage Data and Diagnostics, "Used to track you" if you show personalised ads. Add the App Tracking Transparency prompt (already written in `src/ads.ts`).
- Re-enable as described in `src/ads.ts`, add the INTERNET permission back, update `privacy.html`, and do all of this **before** you upload that version.
