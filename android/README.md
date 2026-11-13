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

## New in 1.2

* **Capsule design:** a black status pill ("● REC" / "● STBY" with the format),
  the control capsule (● timecode · zoom ruler · 1× · ruler · pause · record/stop),
  capsule toggle and tool columns, and a red accent.
* **Pause / resume** inside one clip.
* **Cinematic depth:** people stay sharp and the background is defocused, using
  on-device person segmentation. Strength is shown as an aperture (f/16 to f/1.4)
  on the DEPTH dial, which opens right after tap-to-focus.
* **Film look:** grain (luminance-weighted, size scales with resolution),
  halation, bloom, chromatic aberration, light leaks, film burn and vignette,
  with presets (35mm, 16mm, Super 8, Dream). These run as a second GPU pass on
  the already-anonymized picture, so no effect can bring back face pixels.
* **Noise cancellation:** the platform noise suppressor, an 80 Hz wind / rumble
  filter and a spectral noise gate (minimum-statistics noise floor, Wiener gain
  with a floor); *Standard* or *Strong*.
* **Private gallery:** recordings and photos stay in app storage, never in the
  phone gallery. The in-app gallery has a player, frame stepping, share, export
  to the phone gallery and delete.
* **Editing:** remove parts by dragging on the timeline or with In/Out marks.
  *Auto-trim* finds pauses from the clip's own room tone. The edit is saved as a
  new clip with frame-accurate video (re-encoded) and copied audio.
* **Tracking:** while no tilted face is followed, the upright detector pass runs
  up to twice as often; predicted positions grow with a face's speed.
* **Exposure:** shutter priority (fixed shutter such as 180°, auto ISO); new
  installs default to 24 fps and 180°.
* No network permission: everything runs on the phone.

## New in 1.3: battery and heat (tuned for Pixel 9 Pro XL)

Settings → Power offers **Max quality**, **Balanced** (default) and **Battery saver**.
Privacy never depends on the mode: every frame still waits for a detection taken at
or after its own moment, and faces are interpolated to it exactly. A face first seen
in the next detection is also grown by how far it could have moved in the gap.

* **Paced face detection.** Detection runs every frame for fast or lost faces and less
  often for calm or empty scenes. The gap is capped so a waiting frame never
  overflows the ring and the preview never drops a frame (`tools/sched_sim.py`).
  Standby (not recording) is one step lighter than recording.
* **Thermal governor.** The thermal status and the 10 s headroom forecast step the
  pipeline down *before* the SoC throttles. The status pill shows WARM or HOT.
* **CPU (Tensor G4).** ONNX Runtime uses 2 threads, which land on the mid cores.
  Only Max quality also wakes the prime core. Worker threads sleep instead of
  busy-spinning between inferences. ADPF performance hints (Android 12+) tell the
  scheduler each thread's real deadline, so cores run at the lowest clock that meets
  it, and Android 15+ is asked to prefer efficiency.
* **GPU (Mali-G715).**
  * The background blur pyramid is built only when a blurred face, the privacy
    start or cinematic depth needs it.
  * Without film effects or monitoring tools, the picture is drawn straight to the
    screen or encoder, skipping a full-resolution pass and its mipmaps.
  * Blur colour math runs in FP16.
  * The preview is redrawn only when a new frame is ready.
* **Display.**
  * The preview buffer is rendered at the video's resolution, not the panel's
    2992 × 1344. The hardware compositor scales it up for free.
  * The preview surface tells the 120 Hz LTPO panel it changes only at the video
    frame rate.
  * The screen dims to 8 % after 10 s without a touch while recording. A tap
    restores it.
* **Auto standby.** After 3 minutes idle without recording, the camera, detector
  and microphone turn off. Tap to wake.

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
  face while leaving the background untouched. It also checks the LUT path, the
  film pass, the direct (no-film) path and the GPU blur chain.
* `tools/sched_sim.py` simulates the renderer's frame scheduling for every power
  tier, frame rate and detection speed. It checks that no frame is emitted before
  its detection and that the preview never drops a frame.

The models are InsightFace research models (non-commercial licence) and are not
stored in git.
