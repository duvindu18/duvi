# Seedform for Android

The phone app for Seedform. It finds the computer running Seedform on the same network and shows its interface: everything you can do on the computer, saved on the computer. See *Phone access and the Android app* in `../studio-morfis-desktop/README.md`.

- **The app:** `MainActivity.java` is a full-screen web view.
  - **Finding the computer:** it sends a "MORFIS?" broadcast on UDP port 47821, and the computer answers.
  - **Files:** chosen files upload to the computer, downloads go to Downloads/Seedform and open in the phone's viewer.
  - **Links and Back:** links open in the browser; Back closes what is open in the page first.
- **The connect screen:** `assets/connect.html` lists the computers found and takes an address.
- **Signing:** builds are signed with `app/sideload.keystore`, so a newer APK installs over an older one. To sign with your own key, set `MORFIS_KEYSTORE`, `MORFIS_KEYSTORE_PASSWORD`, `MORFIS_KEY_ALIAS` and `MORFIS_KEY_PASSWORD`. Changing the key means uninstalling the old app once.
- **Version:** it follows `../studio-morfis-desktop/package.json`.

To build locally (Android SDK and JDK 17): `gradle -p studio-morfis-android assembleRelease`; the APK is in `app/build/outputs/apk/release/`.
