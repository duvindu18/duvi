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

## New in 1.8: cinema tools, gestures, gimbals, multi-frame photos

* **Pre-record.** Settings › Cinema Tools: Off / 3 / 5 / 10 s. The encoder keeps the last
  seconds in RAM (encoded, not raw frames; capped at 160 MB). A take starts from a
  keyframe that far back, so the moment before you pressed record is in the clip. It
  stops in the background. It costs about 10 % more battery while you frame.
* **Cinema file names.** `A001_C001_20261114.MOV`. The camera letter is A–D. Clips count
  up, and a new reel starts each day or on demand. You can choose .MOV or .MP4.
* **Metadata.** Each clip has a timed metadata track (`application/x-veilcam-camera+json`,
  once a second) and a `.json` sidecar. They hold the lens, focal length, ISO, shutter
  speed and angle, white balance, focus distance, frame rate, codec, bitrate and
  pre-record time. With Embed GPS on, the location goes in the MP4 header and the
  sidecar.
* **A-B focus pulls.**
  * Set the marks: tap a subject, then choose *Set A* under *A-B Focus* in the tray.
    Do the same for B.
  * Run the pull: *A → B* or *B → A*, with a duration from 0.3 to 10 s and a curve
    (linear, ease in, ease out, ease in-out, S-curve).
  * The pull drives the lens in diopters. In Cinematic the depth of field follows it.
    It ends in manual focus on the end mark.
* **Tap to track.** In Cinematic / Portrait, a tapped person or object is followed:
  the person mask for people, the same depth for objects. Corner brackets show what
  is in focus.
* **Anamorphic de-squeeze.** 1.33×, 1.55× or 2.0×, on the monitor only, along the
  recording's horizontal axis. The file keeps the squeezed picture.
* **Palm gesture.** Hold an open palm towards the camera for about half a second. A
  ring fills, a countdown runs (off / 3 / 5 / 10 s), then recording starts. A palm
  while recording stops it. It uses the MediaPipe gesture recogniser on the phone.
* **Gimbals and remotes.**
  * Bluetooth HID buttons work: volume, camera, media, Enter, zoom and D-pad keys. An
    Osmo Mobile 7 in Bluetooth camera-control mode records and zooms with its own
    buttons.
  * You can learn any button for any action: record, shutter, zoom, flip, focus pull,
    pause or mode.
  * Motor, joystick and ActiveTrack control use DJI's own protocol, which only DJI
    Mimo has. The OM 7P tracking module tracks by itself with any app.
* **Multi-frame photos.**
  * Burst: 2–8 frames, each aligned to the reference frame (pyramid SAD with
    sub-pixel refinement).
  * Merge: robust, in half floats on the GPU. Anything that moved is taken from one
    frame only, so it never ghosts.
  * HDR: the burst is shot a stop under and the shadows are lifted afterwards. Then a
    soft highlight roll-off and a light sharpen.
  * Face blur is applied to the merged photo exactly as to a single frame.
  * `tools/burst_check.py` checks it on Mesa: +8 dB PSNR for 8 frames, no ghosting,
    and a shadow lift of 1.8×.
* **Scene recognition.** Night, low light, backlit, portrait, close-up, landscape and
  bright, from the exposure, histogram, faces and focus distance. A scene has to
  hold for a moment before it changes. It chooses the frame count and HDR for photos
  and shows a badge.
* **Framing suggestions.** Thirds placement and headroom for the main face, with a
  dashed guide to the thirds point. Level hints too. They hide while recording.
* **Video.** Quality now has Max (×3.2 bitrate). Shutter angle, frame rates,
  HEVC / H.264 and LUT monitoring are unchanged (Exposure, Record Video and Styles).

## New in 1.7: depth-based blur, layout pass, real recording time

* **Cinematic depth from real depth.**
  * Model: Depth Anything V2 Small (int8 ONNX, Apache 2.0), a few times a second.
  * What stays sharp: everything at the subject's distance (the chair a person sits on,
    a table beside them). Things in front and behind blur with their distance from it.
  * Focus subject: what you tap (a focus pull to it), otherwise the people in frame,
    otherwise the centre. Double-tap returns to automatic. The focus plane eases between
    subjects.
  * Blur: per-pixel radius with scatter-as-gather, so sharp things never bleed into it.
    Edges are still traced on every frame by the guided filter.
  * Models: `models/depth_anything_v2_small.onnx` comes from the npm package
    `@richardmcquiston01/ai-tools` (`models/`); `tools/depth_check.py --depth` runs it
    on a photo.
* **Layout.**
  * The screen is three bands: the top bar just below the camera hole (one control
    height), an exact 9:16 picture under it, and the shutter row centred in the space
    below. Zoom and modes overlap the picture on a soft gradient.
  * Mode names fade at the screen edge. The tray is one glass panel.
  * Thumbnail and flip are the same size and inset.
  * The histogram and meters share one row in the picture's top corners. The level
    shows only near level.
* **Recording time.** The lower of battery and storage. Battery uses the phone's
  measured draw while recording, learned per format. A warning appears at about 10 and
  3 minutes left.

## New in 1.6: background blur that eases in and out

* **Aperture in 1/3 stops.** The scale runs from Off through ƒ22 to ƒ1.4. Blur grows
  as 1/ƒ-number like a real lens, so it rises gradually from nothing. Small blurs are
  made from the full-resolution frame and hand over to the lens blur as the radius
  grows, so there is no step from sharp to soft.
* **Smooth changes.** Switching Cinematic ↔ Video, picking another aperture, or the
  person mask first arriving eases over about 0.7 s on the camera clock, like a focus
  pull, and is recorded that way.
* `tools/depth_check.py` measures the change from Off through every stop to ƒ1.4.

## New in 1.5: cinematic depth rebuilt

* **Segmentation.** MediaPipe image segmenter on the GPU with the multiclass selfie
  model, which separates hair, skin and clothes from the background. A light temporal
  blend keeps the outline steady. The model `selfie_multiclass_256x256.tflite`
  (Apache 2.0, from `storage.googleapis.com/mediapipe-models`) goes into `models/`
  next to the face models.
* **Edges.** The coarse mask is refined on every frame with a colour guided filter,
  using the frame itself as the guide. The alpha is rebuilt at full resolution from
  its coefficients, so the outline follows hair, shoulders and hands of the frame
  being recorded. Hair gets a finer setting.
* **Lens blur (bokeh).** Only the background is blurred: people are weighted out, so
  they never bleed into the blur as a halo. Lights clearly brighter than their
  surroundings open into discs.
  * Shapes: Circle (cat's eyes towards the corners), six-blade, anamorphic (tall
    ovals in the recorded frame) and swirl.
  * Set the shape and highlight strength in Settings → Cinematic Depth or on the
    camera controller.
* **Check.** `tools/depth_check.py` runs the real model and the app's shaders on a
  photo, comparing the old and new paths and every bokeh shape.

## New in 1.4: camera-app interface

The screen is laid out in portrait like a phone camera and never rotates. Its buttons
turn upright with the phone, and recordings follow how the phone is held (Settings →
Camera → Video orientation can lock horizontal or vertical).

* **Top bar.**
  * Left: torch and face blur (hold the face button for blur strength).
  * Centre: the chevron opens the settings tray. While recording, a red timer
    replaces it.
  * Right: the format pill. Tap "4K" for resolution and "24" for frame rate. In
    Cinematic and Portrait, an ƒ button sets the depth.
* **Modes.** CINEMATIC (video with background blur), VIDEO, PHOTO and PORTRAIT
  (photo with background blur). Swipe sideways on the picture or tap a label; the
  carousel springs to it.
* **Shutter.**
  * The red disc morphs into a rounded square while recording. In the photo modes
    it is white.
  * While recording, Pause replaces the thumbnail and a still-capture button
    replaces Flip.
* **Zoom.**
  * Lens buttons .5, 1×, 2 and 5 glide to their zoom.
  * Press and hold, drag sideways or pinch to open the zoom wheel, an arc scale that
    turns under the finger.
* **Focus and exposure.**
  * Tap: a yellow square springs in with a sun beside it. Drag up or down to change
    exposure.
  * Press and hold: AE/AF lock.
  * Double-tap: continuous AF.
* **Camera controls (dial button).** A picker of controls on a curved row, then a
  curved ruler with haptic ticks and AUTO. Controls: Exposure, ISO, Shutter, White
  Balance, Tint, Focus, Zoom, Depth, Face Blur, Style, Style Strength and Film.
* **Settings tray.** Swipe up or tap the chevron for Faces, Exposure, Styles, Film,
  Resolution, Frame rate, Codec, Stabilize, Assist (zebras, peaking, false color,
  grid, level, histogram), Locks, Audio, Power and Settings.
* **Settings sheet.** A grouped list that slides up and can be dragged down to
  dismiss. Pages push in from the right.
* **Library and viewers.**
  * Three-column library, newest at the bottom; long-press for a menu.
  * The viewer zooms out of the camera thumbnail. Photos support pinch and
    double-tap zoom.
  * The player has a filmstrip scrubber and an Edit mode with a yellow frame.
* All icons are drawn in code. Springs, glass surfaces and haptics are in
  `ui/Theme.kt`.
* UI screenshots without a phone:
  `gradle -PveilSnapshots :app:recordPaparazziRelease` (images land in
  `app/src/test/snapshots/`, ignored by git).

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
# plus selfie_multiclass_256x256.tflite, depth_anything_v2_small.onnx, gesture_recognizer.task (MediaPipe)
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
* `tools/burst_check.py photo.jpg out/` runs the burst-merge shaders: noise reduction,
  ghost rejection and the HDR tone curve.
* `tools/sched_sim.py` simulates the renderer's frame scheduling for every power
  tier, frame rate and detection speed. It checks that no frame is emitted before
  its detection and that the preview never drops a frame.

The models are InsightFace research models (non-commercial licence) and are not
stored in git.
