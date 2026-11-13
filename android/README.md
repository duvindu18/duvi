# Veil Cam (Android)

A pro video camera for Android that blurs faces live, with the same face
detection, tracking and anonymization as the Veil desktop app.

## Face blur (same behaviour as the desktop app)

* **Detector:** InsightFace SCRFD on ONNX Runtime, on the phone (nothing is
  uploaded). *Fast* = SCRFD-500M at 480 px, *Accurate* = SCRFD-10G at 640 px.
* **Any head angle:** rotated detector passes (±40°, ±90°, ±135°, 180°) rendered
  on the GPU, scheduled round-robin with "hot" angles, merged with their true
  orientation; tilt-aware coverage margins from the landmarks.
* **Tracking:** ByteTrack (Kalman filter, overlap + motion-distance
  association, low-score recovery).
* **Faces in video: 1 / 2 / Any:** sticky face slots, landmark plausibility, a
  re-found face inherits its slot, a clearly stronger face displaces a weak
  holder; stray detections never get a blur.
* **Styles:** Gaussian (strength scales with face size), pixelate, black box,
  mask (built-in or your PNG), ellipse or rectangle, intensity, coverage, hold
  after loss, soft edges.
* **Frame-exact recording:** every camera frame waits in a small GPU ring until
  the detector has results for its timestamp, then the faces are interpolated
  to that exact moment. A face entering the shot is never recorded unblurred.
  Until detection has started the whole picture is blurred and REC is disabled.

## Pro camera

* Manual **ISO** and **shutter** (speed or angle) on a tape dial, auto with
  exposure compensation, AE lock.
* **White balance:** auto, lock, Kelvin 2500-10000 K and tint (camera preset plus
  fine GPU correction).
* **Focus:** continuous AF, tap to focus and meter, manual focus distance,
  **focus peaking** (4 colours, adjustable).
* **Exposure tools:** **zebras** (level), **false colour**, live **histogram**
  (luma + RGB).
* **Looks:** 3D **LUTs** (built-in looks or **import .cube**), strength, show on
  monitor and/or bake into the recording; **Flat** picture profile with a
  matching Flat → Rec.709 LUT.
* **Format:** 720p / 1080p / 4K, 24/25/30/48/50/60 fps (what the camera
  supports), **H.265** or H.264, three bitrates, AAC audio with level meters.
* **Lens and zoom:** lens list, zoom presets (0.5×-10× as available), pinch, OIS
  and digital stabilization. Detection runs on the stabilised frames, so the blur stays aligned.
* **Framing:** frame guides (2.39, 1.85, 4:5, 9:16, 1:1), thirds grid, horizon
  level, timecode, storage time left, battery.
* **Controls:** volume keys start and stop recording, photo capture (blurred), camera sounds.
* **Horizontal or vertical video** (H/V button or Settings → Camera → Orientation, or
  auto-rotate); the recording follows the screen and is locked while recording.
  Controls keep clear of display cutouts and curved / rounded screen corners.
* Videos go to `Movies/VeilCam`, photos to `Pictures/VeilCam`.

## Build

```bash
# Android SDK (platform 35, build-tools 35), JDK 17+, Gradle 8.9+
cd android
mkdir -p models && cp /path/to/det_500m.onnx /path/to/det_10g.onnx models/   # InsightFace buffalo_s / buffalo_l
echo "sdk.dir=$ANDROID_HOME" > local.properties
gradle :core:test :app:assembleRelease \
  -PveilKeystore=/path/release.jks -PveilKeystorePassword=...      # unsigned keys -> debug signing
# -> app/build/outputs/apk/release/app-release.apk
```

## Tests

* `gradle :core:test`: tracker, Hungarian assignment, 1/2-face selector, timeline
  interpolation, LUT parser and looks. With `VEIL_TEST_MODEL` (det_500m.onnx) and
  `VEIL_TEST_FIXTURES` set, it also runs the Kotlin detector on real photos
  against the desktop detector, including rotated faces.
* `tools/gl_check.py photo.jpg det_500m.onnx out/ [90|270]` runs the app's real
  GLSL shaders on a software GL (Mesa). It checks that the detector canvas
  finds the face, that the output is upright, and that every style hides the
  face while leaving the background untouched, and it checks the LUT path.

The models are InsightFace research models (non-commercial licence) and are not
stored in git.
