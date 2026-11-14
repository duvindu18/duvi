package com.veil.cam

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.RectF
import android.graphics.RenderEffect
import android.graphics.Shader
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.media.MediaActionSound
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.BatteryManager
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.StatFs
import android.os.SystemClock
import android.util.Size
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.PixelCopy
import android.view.Surface
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import com.veil.cam.camera.CameraCaps
import com.veil.cam.camera.CameraController
import com.veil.cam.camera.CameraReadout
import com.veil.cam.core.CubeParser
import com.veil.cam.core.Geom
import com.veil.cam.core.Looks
import com.veil.cam.core.Lut3D
import com.veil.cam.core.PowerBudget
import com.veil.cam.core.PowerMode
import com.veil.cam.face.FaceEngine
import com.veil.cam.face.DepthEstimator
import com.veil.cam.face.GestureWatcher
import com.veil.cam.core.AccessoryKeys
import com.veil.cam.core.Ease
import com.veil.cam.core.FocusMark
import com.veil.cam.core.FocusPull
import com.veil.cam.core.KeyAction
import com.veil.cam.core.Scene
import com.veil.cam.core.SceneAnalyzer
import com.veil.cam.face.PersonSegmenter
import com.veil.cam.gl.Renderer
import com.veil.cam.media.MediaStorage
import com.veil.cam.media.isVideo
import com.veil.cam.power.ThermalMonitor
import com.veil.cam.record.AudioCapture
import com.veil.cam.ui.ControlSource
import com.veil.cam.ui.ControlSpec
import com.veil.cam.ui.ControllerView
import com.veil.cam.ui.Form
import com.veil.cam.ui.FormatPill
import com.veil.cam.ui.GlassButton
import com.veil.cam.ui.Glyph
import com.veil.cam.ui.HudToast
import com.veil.cam.ui.ModeCarousel
import com.veil.cam.ui.OverlayView
import com.veil.cam.ui.SheetView
import com.veil.cam.ui.ShutterButton
import com.veil.cam.ui.SnapButton
import com.veil.cam.ui.Spring
import com.veil.cam.ui.Theme
import com.veil.cam.ui.ThumbView
import com.veil.cam.ui.TimerPill
import com.veil.cam.ui.TrayItem
import com.veil.cam.ui.TrayView
import com.veil.cam.ui.ZoomControl
import com.veil.cam.ui.rotateUpright
import com.veil.cam.ui.spring
import com.veil.cam.ui.springFloat
import com.veil.cam.ui.thud
import com.veil.cam.ui.tick
import java.io.File
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.hypot
import kotlin.math.roundToInt

/**
 * The camera screen. Laid out in portrait like a phone camera: format and face-blur
 * buttons on top, the picture, zoom lenses, the mode carousel and the shutter row.
 * The layout never rotates; its buttons turn upright with the phone and recordings
 * follow how the phone is held.
 */
class MainActivity : Activity(), Renderer.Listener {
    private val main = Handler(Looper.getMainLooper())
    private lateinit var settings: Settings
    private lateinit var engine: FaceEngine
    private lateinit var renderer: Renderer
    private lateinit var segmenter: PersonSegmenter
    private lateinit var depthNet: DepthEstimator
    private lateinit var gesture: GestureWatcher
    private lateinit var license: com.veil.cam.license.License
    private val sceneAnalyzer = SceneAnalyzer()
    private var scene = Scene.AUTO
    private var lastScene = 0L
    private var faceArea = 0f
    // A-B focus pulls.
    private var markA: FocusMark? = null
    private var markB: FocusMark? = null
    private var pull: FocusPull? = null
    private var pullStart = 0L
    private var nextPullReverse = false
    private var lastTapImg: FloatArray? = null
    // Accessory button learning: the action waiting for a button press.
    private var learning: KeyAction? = null
    private var countdownLeft = 0
    private var hdrPending = false
    private lateinit var camera: CameraController
    private var audio: AudioCapture? = null
    private var cameras: List<CameraCaps> = emptyList()
    private var caps: CameraCaps? = null
    private var recording = false
    private var recPaused = false
    private var lastUri: Uri? = null
    private var readout: CameraReadout? = null
    private val sound = MediaActionSound()
    private var detectorReady = false
    private var resumed = false
    private var audioBoot = true

    // ---- views
    private lateinit var root: FrameLayout
    private lateinit var surfaceView: SurfaceView
    private lateinit var viewfinder: FrameLayout
    private lateinit var scrim: View
    private lateinit var topScrim: View
    private lateinit var shutterRow: FrameLayout
    private var barTop = 0 // top of the top bar (below the camera hole)
    private lateinit var overlay: OverlayView
    private lateinit var snapshot: ImageView
    private lateinit var blink: View
    private lateinit var ui: FrameLayout
    private lateinit var topBar: FrameLayout
    private lateinit var torchBtn: GlassButton
    private lateinit var facesBtn: GlassButton
    private lateinit var chevron: GlassButton
    private lateinit var timer: TimerPill
    private lateinit var heatBtn: GlassButton
    private lateinit var depthBtn: GlassButton
    private lateinit var format: FormatPill
    private lateinit var toast: HudToast
    private lateinit var bottom: LinearLayout
    private lateinit var controller: ControllerView
    private lateinit var zoomRow: FrameLayout
    private lateinit var zoom: ZoomControl
    private lateinit var controlBtn: GlassButton
    private lateinit var modes: ModeCarousel
    private lateinit var tray: TrayView
    private lateinit var thumb: ThumbView
    private lateinit var pauseBtn: GlassButton
    private lateinit var shutter: ShutterButton
    private lateinit var flipBtn: GlassButton
    private lateinit var snapBtn: SnapButton
    private lateinit var sheet: SheetView
    private var safe = android.graphics.Rect()
    private var trayOpen = false

    private val MODES = listOf("CINEMATIC", "VIDEO", "PHOTO", "PORTRAIT")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.attributes = window.attributes.apply { layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES }
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        settings = Settings.load(this).copy(torch = false)
        // Depth now belongs to the Cinematic / Portrait modes: keep an older depth setting there.
        if (settings.depth > 0f && !settings.depthMode) settings = settings.copy(mode = if (settings.photoMode) "PORTRAIT" else "CINEMATIC", cineDepth = settings.depth)
        if (settings.depthMode && settings.depth <= 0f && settings.cineDepth > 0f) settings = settings.copy(depth = settings.cineDepth)
        engine = FaceEngine(applicationContext)
        engine.onError = { msg -> main.post { flash(msg) } }
        engine.configure(settings)
        segmenter = PersonSegmenter(applicationContext).also { it.onError = { msg -> main.post { flash(msg) } } }
        depthNet = DepthEstimator(applicationContext).also { it.onError = { msg -> main.post { flash(msg) } } }
        renderer = Renderer(applicationContext, engine, segmenter, depthNet).also { it.listener = this }
        gesture = GestureWatcher(applicationContext).also { g -> g.onPalm = { main.post { onPalm() } } }
        license = com.veil.cam.license.StoreLicense(this).also { l ->
            l.onChange = { if (sheet.isOpen && paywallOpen) sheet.refresh(); if (l.canCapture && paywallOpen) { paywallOpen = false; sheet.close(); flash("Veil Cam unlocked. Thank you!") } }
            l.start()
        }
        renderer.gesture = gesture
        renderer.update(settings)
        thermal = ThermalMonitor(this) { level, status -> onThermal(level, status) }
        camera = CameraController(applicationContext)
        camera.onReadout = { r -> main.post { readout = r; controller.refresh(); refreshTop() } }
        camera.onError = { msg -> main.post { flash(msg) } }
        buildUi()
        registerBack()
        loadLut(settings.lut)
        sound.load(MediaActionSound.START_VIDEO_RECORDING)
        sound.load(MediaActionSound.STOP_VIDEO_RECORDING)
        sound.load(MediaActionSound.SHUTTER_CLICK)
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        hideSystemBars()
        val missing = listOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)
            .filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) {
            requestPermissions(missing.toTypedArray(), 1)
            return
        }
        if (sleeping) { sleeping = false; sleepView?.visibility = View.GONE; window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
        lastTouch = SystemClock.uptimeMillis()
        startCamera()
        startAudio()
        registerSensors()
        thermal?.start()
        pushBudget()
        renderer.setArmAllowed(true)
        loadThumb(pop = false)
        main.removeCallbacks(idleCheck)
        main.postDelayed(idleCheck, 2_000)
        main.removeCallbacks(palmTick); main.post(palmTick)
        startLocation()
        license.refresh()
    }

    override fun onPause() {
        resumed = false
        main.removeCallbacks(idleCheck)
        main.removeCallbacks(palmTick); cancelCountdown(); stopPull(); stopLocation()
        thermal?.stop()
        setDim(false)
        renderer.setArmAllowed(false)
        if (recording) toggleRecording()
        camera.close()
        audio?.stop()
        renderer.setAudio(null)
        audio = null
        unregisterSensors()
        super.onPause()
    }

    override fun onDestroy() {
        renderer.release()
        camera.release()
        engine.release()
        segmenter.release()
        depthNet.release()
        gesture.release()
        license.stop()
        sound.release()
        super.onDestroy()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        if (requestCode == 2) {
            if (grantResults.any { it == PackageManager.PERMISSION_GRANTED }) startLocation() else flash("Without location, clips are not GPS tagged")
            return
        }
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            flash("Veil Cam needs the camera permission")
            return
        }
        if (resumed) { startCamera(); startAudio(); registerSensors() }
    }

    // ---- camera -------------------------------------------------------------------------------------
    private fun startCamera() {
        if (cameras.isEmpty()) cameras = camera.cameras()
        val c = cameras.firstOrNull { it.id == settings.cameraId } ?: cameras.firstOrNull { !it.front } ?: cameras.firstOrNull()
        if (c == null) { flash("No camera found"); return }
        caps = c
        renderer.availableAwb = c.awbModes
        val wanted = Size(settings.width, settings.height)
        val size = c.sizes.firstOrNull { it == wanted } ?: c.sizes.firstOrNull { it.width == 1920 } ?: c.sizes.first()
        if (size.width != settings.width || c.id != settings.cameraId) {
            settings = settings.copy(cameraId = c.id, width = size.width, height = size.height)
            Settings.save(this, settings)
        }
        if (!c.supportsFps(settings.fps)) settings = settings.copy(fps = 30)
        detectorReady = false
        overlay.startingHint = settings.blurOn
        renderer.update(settings)
        applyRotations(animate = false)
        renderer.configureCamera(size, c.sensorOrientation, c.front)
        refreshUi()
        if (audio != null && audioBoot != c.bootTimeTimestamps) startAudio() // audio must share the camera's clock
    }

    override fun onCameraSurface(surface: Surface, size: Size) {
        val c = caps ?: return
        main.post { if (resumed && !sleeping) camera.open(c, surface, size, settings) }
    }

    private fun startAudio() {
        if (!settings.audio || checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return
        val boot = caps?.bootTimeTimestamps ?: true
        if (audio != null && audioBoot == boot) return
        audio?.stop()
        audioBoot = boot
        val a = AudioCapture(bootTimeClock = boot)
        a.noiseReduction = settings.noiseReduction
        a.windFilter = settings.windFilter
        if (a.start()) {
            audio = a
            renderer.setAudio(a)
            meterLoop()
        }
    }

    private fun meterLoop() {
        val a = audio ?: return
        overlay.levels = a.levels
        main.postDelayed({ meterLoop() }, 100) // 10 Hz is smooth for a meter and halves the UI redraws
    }

    private fun displayDegrees(): Int = when (display?.rotation ?: Surface.ROTATION_0) {
        Surface.ROTATION_90 -> 90
        Surface.ROTATION_180 -> 180
        Surface.ROTATION_270 -> 270
        else -> 0
    }

    // ---- orientation: the layout stays in portrait, controls and recordings follow the phone ----------
    private var deviceRot = 0
    private var recOutputRot = 0

    private fun outputRot(): Int = when (settings.orientation) {
        "Portrait" -> 0
        "Landscape" -> if (deviceRot == 90 || deviceRot == 270) deviceRot else 90
        else -> deviceRot
    }

    private fun rotatables(): List<View> = listOf(torchBtn, facesBtn, heatBtn, controlBtn, thumb, pauseBtn, flipBtn, snapBtn) + tray.buttons

    private fun applyRotations(animate: Boolean = true) {
        renderer.setRotations(displayDegrees(), outputRot(), deviceRot)
        overlay.uiRotation = deviceRot
        overlay.frameRotation = if (recording) recOutputRot else outputRot()
        rotatables().forEach { it.rotateUpright(deviceRot, animate) }
        val target = deviceRot.toFloat().let { if (it > 180f) it - 360f else it }
        if (animate) springFloat(zoom.textRotation, target, Spring.SMOOTH) { zoom.textRotation = it } else zoom.textRotation = target
    }

    private val sensorListener = object : SensorEventListener {
        override fun onSensorChanged(e: SensorEvent) {
            val x = e.values[0]; val y = e.values[1]
            val a = Math.toDegrees(atan2(x.toDouble(), y.toDouble())).toFloat() // 0 upright, 90 turned left
            if (hypot(x, y) > 4.5f) {
                // Snap to 0 / 90 / 270 with hysteresis; upside down keeps the last orientation.
                val norm = (a + 360f) % 360f
                val cand = when { norm < 45f || norm >= 315f -> 0; norm < 135f -> 90; norm >= 225f -> 270; else -> -1 }
                if (cand >= 0 && cand != deviceRot) {
                    var diff = abs(norm - cand); if (diff > 180f) diff = 360f - diff
                    if (diff < 32f) { deviceRot = cand; applyRotations() }
                }
            }
            var roll = a - deviceRot
            while (roll > 180) roll -= 360
            while (roll < -180) roll += 360
            overlay.roll = roll
        }
        override fun onAccuracyChanged(s: Sensor?, a: Int) {}
    }

    private fun registerSensors() {
        val sm = getSystemService(Context.SENSOR_SERVICE) as SensorManager
        sm.getDefaultSensor(Sensor.TYPE_GRAVITY)?.let { sm.registerListener(sensorListener, it, SensorManager.SENSOR_DELAY_UI) }
    }

    private fun unregisterSensors() {
        (getSystemService(Context.SENSOR_SERVICE) as SensorManager).unregisterListener(sensorListener)
    }

    // ---- settings -----------------------------------------------------------------------------------
    private fun apply(s: Settings, restart: Boolean = false) {
        val old = settings
        if (restart && recording) { flash("Stop recording to change this"); return }
        settings = s
        Settings.save(this, s)
        renderer.update(s)
        engine.configure(s)
        overlay.settings = s
        if (s.lut != old.lut) loadLut(s.lut)
        audio?.let { it.noiseReduction = s.noiseReduction; it.windFilter = s.windFilter }
        if (s.audio != old.audio) { if (s.audio) startAudio() else { audio?.stop(); audio = null; renderer.setAudio(null) } }
        if (s.blurOn && !old.blurOn) overlay.startingHint = !detectorReady
        if (!s.blurOn) overlay.startingHint = false
        if (s.powerMode != old.powerMode || s.width != old.width || s.height != old.height) pushBudget()
        if (s.fps != old.fps) votePreviewRate()
        if (s.orientation != old.orientation) applyRotations()
        if (!s.dimWhileRecording) setDim(false)
        if (s.embedGps != old.embedGps) startLocation()
        if (s.fullView != old.fullView) { snapshotTransition(flip = false); layoutFrame() }
        if (restart) {
            snapshotTransition(flip = s.cameraId != old.cameraId)
            // Start the new camera only once the old one has stopped using its surface.
            camera.close { main.post { if (resumed) startCamera() } }
        } else camera.update(s)
        refreshUi()
    }

    private fun customLutFile(name: String) = File(File(filesDir, "luts"), "$name.cube")

    private fun lutNames(): List<String> = listOf("None") + Looks.names +
        (File(filesDir, "luts").listFiles()?.filter { it.extension == "cube" }?.map { it.nameWithoutExtension }?.sorted() ?: emptyList())

    private fun loadLut(name: String) {
        if (name == "None") { renderer.setLut(null); return }
        Thread {
            val lut: Lut3D? = try {
                if (name in Looks.names) Looks.build(name) else CubeParser.parse(customLutFile(name).readText(), name)
            } catch (e: Exception) {
                main.post { flash("LUT error: ${e.message}") }
                null
            }
            renderer.setLut(lut)
        }.start()
    }

    private fun importLut() {
        startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).apply { addCategory(Intent.CATEGORY_OPENABLE); type = "*/*" }, REQ_LUT)
    }

    private fun importMask() {
        startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).apply { addCategory(Intent.CATEGORY_OPENABLE); type = "image/png" }, REQ_MASK)
    }

    @Deprecated("Activity result API without AndroidX")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        val uri = data?.data ?: return
        if (resultCode != RESULT_OK) return
        when (requestCode) {
            REQ_LUT -> Thread {
                try {
                    val text = contentResolver.openInputStream(uri)!!.use { it.readBytes().toString(Charsets.UTF_8) }
                    val fallback = uri.lastPathSegment?.substringAfterLast('/')?.substringBeforeLast('.') ?: "Imported"
                    val lut = CubeParser.parse(text, fallback)
                    val safeName = lut.name.replace(Regex("[^A-Za-z0-9 _.-]"), "_").take(40).ifBlank { "Imported" }
                    customLutFile(safeName).apply { parentFile?.mkdirs(); writeText(text) }
                    main.post { apply(settings.copy(lut = safeName)); flash("LUT “$safeName” imported (${lut.size}³)"); sheet.refresh() }
                } catch (e: Exception) {
                    main.post { flash("Not a valid 3D .cube LUT: ${e.message}") }
                }
            }.start()
            REQ_MASK -> Thread {
                try {
                    val f = File(filesDir, "mask.png")
                    contentResolver.openInputStream(uri)!!.use { inp -> f.outputStream().use { inp.copyTo(it) } }
                    main.post { apply(settings.copy(maskPath = f.absolutePath, style = BlurStyle.MASK)); flash("Mask image set"); sheet.refresh() }
                } catch (e: Exception) {
                    main.post { flash("Cannot read that image") }
                }
            }.start()
        }
    }

    // ---- UI construction -----------------------------------------------------------------------------
    private fun dp(v: Float) = Theme.dpi(this, v)

    private fun buildUi() {
        root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        surfaceView = SurfaceView(this)
        surfaceView.holder.addCallback(object : SurfaceHolder.Callback {
            override fun surfaceCreated(h: SurfaceHolder) {}
            override fun surfaceChanged(h: SurfaceHolder, f: Int, w: Int, hgt: Int) {
                votePreviewRate()
                renderer.setPreview(h.surface, w, hgt, surfaceView.width, surfaceView.height)
            }
            override fun surfaceDestroyed(h: SurfaceHolder) { renderer.setPreview(null, 0, 0) }
        })
        // The picture: an exact 9:16 frame laid out under the top bar (see layoutFrame).
        viewfinder = FrameLayout(this)
        root.addView(viewfinder, FrameLayout.LayoutParams(-1, -1, Gravity.TOP))
        viewfinder.addView(surfaceView, FrameLayout.LayoutParams(-1, -1))
        surfaceView.addOnLayoutChangeListener { _, l, t, r, b, ol, ot, orr, ob -> if (r - l != orr - ol || b - t != ob - ot) applyPreviewSize() }
        snapshot = ImageView(this).apply { scaleType = ImageView.ScaleType.FIT_XY; visibility = View.GONE }
        viewfinder.addView(snapshot, FrameLayout.LayoutParams(-1, -1))
        blink = View(this).apply { setBackgroundColor(Color.BLACK); alpha = 0f }
        viewfinder.addView(blink, FrameLayout.LayoutParams(-1, -1))
        overlay = OverlayView(this).apply { settings = this@MainActivity.settings }
        overlay.onTap = { _, _, ix, iy -> tapFocus(ix, iy, lock = false) }
        overlay.onLongPress = { _, _, ix, iy -> tapFocus(ix, iy, lock = true) }
        overlay.onDoubleTap = {
            camera.resetFocus(); unlockAe(); renderer.setFocusPoint(null, null); overlay.clearTracked(); lastTapImg = null
            if (settings.depthMode) flash("Depth follows the subject")
        }
        overlay.onZoom = { f -> setZoom(settings.zoom * f); zoom.peek() }
        overlay.onPinch = { zoom.peek() }
        overlay.onSwipeMode = { dir -> if (!recording && !trayOpen) modes.step(dir) }
        overlay.onSwipeTray = { up -> if (up) openTray() else closeTray() }
        overlay.onExposure = { d -> dragExposure(d) }
        viewfinder.addView(overlay, FrameLayout.LayoutParams(-1, -1))
        // Soft dark gradient behind the controls that sit on the picture (zoom, modes, tray),
        // so they read on any scene without a hard bar.
        scrim = View(this).apply {
            background = android.graphics.drawable.GradientDrawable(android.graphics.drawable.GradientDrawable.Orientation.TOP_BOTTOM,
                intArrayOf(0x00000000, 0x40000000, 0x8C000000.toInt(), 0xCC000000.toInt()))
            isClickable = false
        }
        root.addView(scrim, FrameLayout.LayoutParams(-1, dp(220f), Gravity.TOP))
        // Full-screen view: the top bar sits on the picture too.
        topScrim = View(this).apply {
            background = android.graphics.drawable.GradientDrawable(android.graphics.drawable.GradientDrawable.Orientation.TOP_BOTTOM,
                intArrayOf(0xB3000000.toInt(), 0x66000000, 0x00000000))
            isClickable = false; visibility = View.GONE
        }
        root.addView(topScrim, FrameLayout.LayoutParams(-1, dp(120f), Gravity.TOP))

        ui = FrameLayout(this).apply { clipToPadding = false; clipChildren = false }

        // ---- top bar: torch, face blur | chevron / timer | heat, depth, format
        topBar = FrameLayout(this)
        val left = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        torchBtn = GlassButton(this, Glyph.BOLT, "Torch", BAR_H).apply { setOnClickListener { toggleTorch() } }
        facesBtn = GlassButton(this, Glyph.FACE, "Face blur", BAR_H).apply {
            setOnClickListener { toggleBlur() }
            setOnLongClickListener { thud(); controller.open("FACES"); true }
        }
        left.addView(torchBtn, LinearLayout.LayoutParams(-2, -2).apply { rightMargin = dp(12f) })
        left.addView(facesBtn)
        topBar.addView(left, FrameLayout.LayoutParams(-2, -2, Gravity.START or Gravity.CENTER_VERTICAL))
        timer = TimerPill(this).apply { visibility = View.GONE }
        topBar.addView(timer, FrameLayout.LayoutParams(-2, -2, Gravity.CENTER))
        val right = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        heatBtn = GlassButton(this, Glyph.THERMO, "Phone temperature", BAR_H).apply { glyphColor = Theme.ORANGE; visibility = View.GONE; setOnClickListener { flash(heatText()) } }
        depthBtn = GlassButton(this, null, "Depth", BAR_H, "ƒ2.8").apply { setOnClickListener { tick(); controller.open("DEPTH") } }
        format = FormatPill(this, BAR_H).apply { onLeft = { cycleResolution() }; onRight = { cycleFps() } }
        right.addView(heatBtn, LinearLayout.LayoutParams(-2, -2).apply { rightMargin = dp(12f) })
        right.addView(depthBtn, LinearLayout.LayoutParams(-2, -2).apply { rightMargin = dp(12f) })
        right.addView(format)
        topBar.addView(right, FrameLayout.LayoutParams(-2, -2, Gravity.END or Gravity.CENTER_VERTICAL))
        ui.addView(topBar, FrameLayout.LayoutParams(-1, dp(BAR_H + 4f), Gravity.TOP))
        toast = HudToast(this)
        ui.addView(toast, FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.CENTER_HORIZONTAL))

        // ---- bottom: controller, zoom, modes / tray, shutter row
        bottom = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; clipChildren = false }
        controller = ControllerView(this, controls)
        controller.onVisible = { v -> controlBtn.active = v }
        bottom.addView(controller, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(4f) })
        zoomRow = FrameLayout(this).apply { clipChildren = false }
        zoom = ZoomControl(this).apply { onZoom = { z -> setZoom(z, fromControl = true) } }
        zoomRow.addView(zoom, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM))
        controlBtn = GlassButton(this, Glyph.DIAL, "Camera controls", 40f).apply {
            setOnClickListener { if (controller.isOpen) controller.dismiss() else { closeTray(); controller.open(null) } }
        }
        zoomRow.addView(controlBtn, FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM or Gravity.START).apply { leftMargin = dp(14f); bottomMargin = dp(3f) })
        // Settings tray: bottom right, above the flip button (mirrors the controls dial on the left).
        chevron = GlassButton(this, Glyph.CHEVRON_UP, "Camera settings", 40f).apply { setOnClickListener { if (trayOpen) closeTray() else openTray() } }
        zoomRow.addView(chevron, FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM or Gravity.END).apply { rightMargin = dp(14f); bottomMargin = dp(3f) })
        bottom.addView(zoomRow, LinearLayout.LayoutParams(-1, -2))
        val modeSlot = FrameLayout(this)
        modes = ModeCarousel(this, MODES).apply { onSelect = { i -> setMode(MODES[i]) } }
        modeSlot.addView(modes, FrameLayout.LayoutParams(-1, -2, Gravity.CENTER))
        tray = TrayView(this).apply {
            visibility = View.GONE
            onItem = { onTrayItem(it) }
            onOption = { item, i -> onTrayOption(item, i) }
        }
        modeSlot.addView(tray, FrameLayout.LayoutParams(-1, -2, Gravity.CENTER))
        bottom.addView(modeSlot, LinearLayout.LayoutParams(-1, dp(72f)).apply { bottomMargin = dp(2f) })
        shutterRow = FrameLayout(this)
        thumb = ThumbView(this).apply { setOnClickListener { openLatest() } }
        pauseBtn = GlassButton(this, Glyph.PAUSE, "Pause recording", 48f).apply { visibility = View.GONE; setOnClickListener { togglePause() } }
        shutter = ShutterButton(this).apply { setOnClickListener { onShutter() } }
        flipBtn = GlassButton(this, Glyph.FLIP, "Switch camera", 48f).apply { setOnClickListener { switchLens() } }
        snapBtn = SnapButton(this).apply { visibility = View.GONE; setOnClickListener { photo() } }
        // Side controls: same 50 dp size, same 30 dp inset from each edge, centred on the shutter.
        for ((v, g) in listOf(thumb to Gravity.START, pauseBtn to Gravity.START, flipBtn to Gravity.END, snapBtn to Gravity.END)) {
            shutterRow.addView(v, FrameLayout.LayoutParams(dp(50f), dp(50f), g or Gravity.CENTER_VERTICAL).apply { leftMargin = dp(30f); rightMargin = dp(30f) })
        }
        shutterRow.addView(shutter, FrameLayout.LayoutParams(-2, -2, Gravity.CENTER))
        bottom.addView(shutterRow, LinearLayout.LayoutParams(-1, dp(96f)))
        ui.addView(bottom, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM))
        root.addView(ui, FrameLayout.LayoutParams(-1, -1))

        sheet = SheetView(this).apply { onClosed = { paywallOpen = false; refreshUi() } }
        root.addView(sheet, FrameLayout.LayoutParams(-1, -1))

        root.setOnApplyWindowInsetsListener { _, insets ->
            val r = safeInsets(insets)
            val hole = if (android.os.Build.VERSION.SDK_INT >= 29) insets.displayCutout?.boundingRectTop?.takeIf { !it.isEmpty }?.bottom ?: 0 else 0
            val corner = if (android.os.Build.VERSION.SDK_INT >= 31) maxOf(insets.getRoundedCorner(android.view.RoundedCorner.POSITION_TOP_LEFT)?.radius ?: 0,
                insets.getRoundedCorner(android.view.RoundedCorner.POSITION_TOP_RIGHT)?.radius ?: 0) else dp(32f)
            // The bar sits just below the camera hole (or clear of the rounded corners).
            val bt = maxOf(hole + dp(6f), (corner * 0.3f).roundToInt(), dp(10f))
            if (r != safe || bt != barTop) { safe = r; barTop = bt; ui.setPadding(r.left, 0, r.right, r.bottom); layoutFrame() }
            insets
        }
        root.addOnLayoutChangeListener { _, l, t, rr, b, ol, ot, orr, ob -> if (rr - l != orr - ol || b - t != ob - ot) root.post { layoutFrame() } }
        setContentView(root)
        modes.select(MODES.indexOf(settings.mode).coerceAtLeast(0), animate = false)
        shutter.video = !settings.photoMode
        refreshUi()
    }

    /**
     * Space the controls keep clear of: the camera cutout, the rounded corners and the
     * edge gesture areas (portrait layout), plus a small base margin.
     */
    private fun safeInsets(insets: WindowInsets): android.graphics.Rect {
        val cut = insets.getInsets(WindowInsets.Type.displayCutout())
        val gest = insets.getInsets(WindowInsets.Type.systemGestures())
        fun corner(pos: Int) =
            if (android.os.Build.VERSION.SDK_INT >= 31) insets.getRoundedCorner(pos)?.radius ?: 0 else dp(32f)
        val top = maxOf(corner(android.view.RoundedCorner.POSITION_TOP_LEFT), corner(android.view.RoundedCorner.POSITION_TOP_RIGHT))
        val bot = maxOf(corner(android.view.RoundedCorner.POSITION_BOTTOM_LEFT), corner(android.view.RoundedCorner.POSITION_BOTTOM_RIGHT))
        val side = dp(14f)
        return android.graphics.Rect(
            side + cut.left, maxOf(cut.top, (top * 0.3f).roundToInt()) + dp(4f),
            side + cut.right, maxOf(cut.bottom, gest.bottom / 2, (bot * 0.3f).roundToInt()) + dp(2f),
        )
    }

    /**
     * The screen in three bands: the top bar below the camera hole, an exact 9:16 picture
     * right under it, and the shutter row in the space left below (centred there). Zoom and
     * modes overlap the bottom of the picture on a soft gradient, as in phone cameras.
     */
    private fun layoutFrame() {
        val w = root.width; val h = root.height
        if (w == 0 || h == 0) return
        val full = settings.fullView
        val vh = if (full) h else (w * 16f / 9f).roundToInt().coerceAtMost(h)
        val top = if (full) 0 else (barTop + dp(BAR_H + 6f)).coerceAtMost(h - vh)
        topScrim.visibility = if (full) View.VISIBLE else View.GONE
        (topScrim.layoutParams as FrameLayout.LayoutParams).let { val th = barTop + dp(BAR_H + 40f); if (it.height != th) { it.height = th; topScrim.layoutParams = it } }
        (viewfinder.layoutParams as FrameLayout.LayoutParams).let { if (it.height != vh || it.topMargin != top) { it.height = vh; it.topMargin = top; viewfinder.layoutParams = it } }
        (topBar.layoutParams as FrameLayout.LayoutParams).let { if (it.topMargin != barTop) { it.topMargin = barTop; topBar.layoutParams = it } }
        val pictureTop = if (full) barTop + dp(BAR_H + 6f) else top
        (toast.layoutParams as FrameLayout.LayoutParams).let { it.topMargin = pictureTop + dp(12f); toast.layoutParams = it }
        // Shutter band: whatever is below the 9:16 picture (at least 96 dp, overlapping if it must).
        val framedBottom = barTop + dp(BAR_H + 6f) + (w * 16f / 9f).roundToInt()
        val band = (h - safe.bottom - if (full) framedBottom.coerceAtMost(h) else (top + vh)).coerceAtLeast(dp(96f))
        (shutterRow.layoutParams as LinearLayout.LayoutParams).let { if (it.height != band) { it.height = band; shutterRow.layoutParams = it } }
        root.post {
            val bandTop = h - safe.bottom - band
            val scrimTop = (bandTop - dp(190f)).coerceAtLeast(top)
            (scrim.layoutParams as FrameLayout.LayoutParams).let { it.topMargin = scrimTop; it.height = (top + vh) - scrimTop; scrim.layoutParams = it }
            // Full screen: the shutter row sits on the picture, so the scrim runs to the bottom (set above).
            layoutHud()
        }
    }

    /** Free picture area for the histogram and meters (inside the picture, above the zoom lenses). */
    private fun layoutHud() {
        root.post {
            val vTop = viewfinder.top
            val bottomY = bottom.top + zoomRow.top + zoomRow.height - dp(56f) - vTop
            // Full screen: keep the readouts clear of the top bar.
            val topY = if (settings.fullView) barTop + dp(BAR_H + 12f) - vTop else dp(6f)
            overlay.hud = RectF(0f, topY.toFloat(), viewfinder.width.toFloat(), bottomY.toFloat())
        }
    }

    private fun hideSystemBars() {
        window.insetsController?.let {
            it.hide(WindowInsets.Type.systemBars())
            it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    // ---- refreshing the controls -------------------------------------------------------------------
    private fun refreshUi() {
        if (!::shutter.isInitialized) return
        refreshTop()
        refreshZoom()
        refreshRecordUi()
        controller.specs = controlSpecs()
        controller.refresh()
        if (trayOpen) tray.setItems(trayItems())
        overlay.exposureEnabled = settings.autoExposure // compensation still applies while AE is locked
        overlay.exposure = evFraction()
    }

    private fun resLabel(w: Int) = when (w) { 3840 -> "4K"; 1920 -> "HD"; 1280 -> "720"; else -> "${w}p" }

    private fun refreshTop() {
        val s = settings
        val c = caps
        torchBtn.visibility = if (c?.flash == true) View.VISIBLE else View.GONE
        torchBtn.active = s.torch
        facesBtn.active = s.blurOn
        facesBtn.glyphColor = if (s.blurOn) Theme.YELLOW else Theme.RED
        format.left = resLabel(s.width)
        format.right = "${s.fps}"
        val showFormat = !s.photoMode && !recording
        format.visibility = if (showFormat) View.VISIBLE else View.GONE
        depthBtn.visibility = if (s.depthMode && !recording) View.VISIBLE else View.GONE
        depthBtn.text = apertureLabel(s.depth)
        depthBtn.active = s.depthMode
        heatBtn.visibility = if (heat > 0) View.VISIBLE else View.GONE
        heatBtn.glyphColor = if (heat >= 2) Theme.RED else Theme.ORANGE
    }

    private fun refreshZoom() {
        val c = caps ?: return
        zoom.minZoom = c.zoomRange.lower
        zoom.maxZoom = minOf(c.zoomRange.upper, 30f).coerceAtLeast(c.zoomRange.lower + 0.01f)
        zoom.stops = zoomStops()
        zoom.zoom = settings.zoom
    }

    /** Status, timer, shutter, thumbnail / pause and flip / still for the current record state. */
    private fun refreshRecordUi() {
        shutter.recording = recording
        overlay.recording = recording
        fun swap(show: View, hide: View) {
            if (show.visibility != View.VISIBLE) {
                show.visibility = View.VISIBLE; show.alpha = 0f; show.scaleX = 0.7f; show.scaleY = 0.7f
                show.spring(Spring.BOUNCY).alpha(1f).scaleX(1f).scaleY(1f).start()
            }
            if (hide.visibility == View.VISIBLE) hide.spring(Spring.SNAPPY).alpha(0f).scaleX(0.7f).scaleY(0.7f).withEndAction { hide.visibility = View.GONE }.start()
        }
        if (recording) { swap(pauseBtn, thumb); swap(snapBtn, flipBtn); swap(timer, chevron) } else { swap(thumb, pauseBtn); swap(flipBtn, snapBtn); swap(chevron, timer) }
        pauseBtn.glyph = if (recPaused) Glyph.PLAY else Glyph.PAUSE
        pauseBtn.contentDescription = if (recPaused) "Resume recording" else "Pause recording"
        timer.paused = recPaused
        modes.isEnabled = !recording
        modes.spring(Spring.SMOOTH).alpha(if (recording || trayOpen) 0f else 1f).start()
        controlBtn.visibility = View.VISIBLE
        refreshTop()
    }

    // ---- modes -----------------------------------------------------------------------------------------
    private fun setMode(m: String) {
        renderer.setFocusPoint(null, null)
        if (recording) { modes.select(MODES.indexOf(settings.mode)); return }
        if (m == settings.mode) return
        snapshotTransition(flip = false)
        val depth = if (m == "CINEMATIC" || m == "PORTRAIT") settings.cineDepth else 0f
        apply(settings.copy(mode = m, depth = depth))
        shutter.video = !settings.photoMode
        if (controller.key == "DEPTH" && !settings.depthMode) controller.dismiss()
    }

    private fun onShutter() {
        if (settings.photoMode) photo() else toggleRecording()
    }

    // ---- top bar actions -----------------------------------------------------------------------------
    private fun toggleTorch() {
        apply(settings.copy(torch = !settings.torch))
        flash(if (settings.torch) "Torch on" else "Torch off")
    }

    private fun toggleBlur() {
        apply(settings.copy(blurOn = !settings.blurOn))
        if (settings.blurOn) flash("Face blur on") else flash("Face blur OFF · faces will be recorded")
    }

    private fun cycleResolution() {
        val c = caps ?: return
        if (recording) return
        val opts = c.sizes.filter { it.width in listOf(3840, 1920, 1280) }.distinctBy { it.width }.sortedBy { it.width }
        if (opts.isEmpty()) return
        val i = opts.indexOfFirst { it.width == settings.width }
        val next = opts[(i + 1) % opts.size]
        apply(settings.copy(width = next.width, height = next.height), restart = true)
        flash("${resLabel(next.width).let { if (it == "HD") "1080p HD" else if (it == "4K") "4K UHD" else "720p" }} · ${settings.fps} fps")
    }

    private fun fpsOptions(): List<Int> = caps?.let { c -> listOf(24, 25, 30, 48, 50, 60).filter { c.supportsFps(it) } } ?: emptyList()

    private fun cycleFps() {
        if (recording) return
        val opts = fpsOptions()
        if (opts.isEmpty()) return
        val next = opts[(opts.indexOf(settings.fps) + 1) % opts.size]
        apply(settings.copy(fps = next, shutterNs = settings.shutterNs.coerceAtMost(1_000_000_000L / next)))
        flash("$next fps")
    }

    private fun heatText() = when (heat) { 2 -> "Phone is hot · saving power, every frame stays blurred"; 1 -> "Phone is warm · saving power"; else -> "Temperature normal" }

    // ---- tray -------------------------------------------------------------------------------------------
    private fun openTray() {
        if (recording || trayOpen) return
        controller.dismiss()
        trayOpen = true
        tray.setItems(trayItems())
        tray.buttons.forEach { it.rotateUpright(deviceRot, false) }
        tray.visibility = View.VISIBLE
        tray.alpha = 0f; tray.translationY = dp(18f).toFloat()
        tray.spring(Spring.SMOOTH).alpha(1f).translationY(0f).start()
        modes.spring(Spring.SMOOTH).alpha(0f).translationY(-dp(10f).toFloat()).start()
        chevron.glyph = Glyph.CHEVRON_DOWN
        root.tick()
    }

    private fun closeTray() {
        if (!trayOpen) return
        trayOpen = false
        tray.closeOptions()
        tray.spring(Spring.SMOOTH).alpha(0f).translationY(dp(18f).toFloat()).withEndAction { if (!trayOpen) tray.visibility = View.GONE }.start()
        modes.spring(Spring.SMOOTH).alpha(if (recording) 0f else 1f).translationY(0f).start()
        chevron.glyph = Glyph.CHEVRON_UP
    }

    private fun stabIndex() = when { settings.ois && settings.eis -> 2; settings.ois -> 1; else -> 0 }

    private fun trayItems(): List<TrayItem> {
        val s = settings
        val c = caps
        val out = ArrayList<TrayItem>()
        out += TrayItem("faces", Glyph.FACE, "Faces", s.blurOn, listOf("Off", "1 face", "2 faces", "Any"),
            listOf(!s.blurOn, s.blurOn && s.maxFaces == 1, s.blurOn && s.maxFaces == 2, s.blurOn && s.maxFaces == 0))
        out += TrayItem("exposure", Glyph.SUN, "Exposure", s.ev != 0 || !s.autoExposure)
        out += TrayItem("style", Glyph.STYLE, "Styles", s.lut != "None")
        out += TrayItem("film", Glyph.FILM, "Film", s.filmOn)
        val sizes = c?.sizes?.filter { it.width in listOf(3840, 1920, 1280) }?.distinctBy { it.width }?.sortedBy { it.width } ?: emptyList()
        if (sizes.isNotEmpty()) out += TrayItem("res", Glyph.FORMAT, "Resolution", false, sizes.map { when (it.width) { 3840 -> "4K"; 1920 -> "1080p"; else -> "720p" } }, sizes.map { it.width == s.width })
        if (!s.photoMode) {
            val f = fpsOptions()
            if (f.isNotEmpty()) out += TrayItem("fps", Glyph.SHUTTER, "Frame rate", false, f.map { "$it fps" }, f.map { it == s.fps })
            out += TrayItem("codec", Glyph.FORMAT, "Codec", false, listOf("HEVC", "H.264"), listOf(s.hevc, !s.hevc))
        }
        if (c?.ois == true || c?.eis == true || c?.previewStabilization == true)
            out += TrayItem("stab", Glyph.STAB, "Stabilize", s.eis, listOf("Off", "Standard", "Enhanced"), List(3) { it == stabIndex() })
        out += TrayItem("view", Glyph.FORMAT, "View", s.fullView, listOf("Framed", "Full screen"), listOf(!s.fullView, s.fullView))
        out += TrayItem("tools", Glyph.PEAK, "Assist", s.zebra || s.peaking || s.falseColor || s.grid,
            listOf("Zebras", "Peaking", "False color", "Grid", "Level", "Histogram"),
            listOf(s.zebra, s.peaking, s.falseColor, s.grid, s.level, s.histogram), multi = true)
        if (!s.photoMode) out += TrayItem("pull", Glyph.FOCUS, "A-B Focus", markA != null && markB != null,
            listOf(if (markA != null) "A ✓" else "Set A", if (markB != null) "B ✓" else "Set B", "A → B", "B → A", "Clear"), listOf(markA != null, markB != null, false, false, false))
        out += TrayItem("lock", Glyph.LOCK, "Locks", s.aeLock || s.awbLock, listOf("AE lock", "WB lock"), listOf(s.aeLock, s.awbLock), multi = true)
        out += TrayItem("mic", Glyph.MIC, "Audio", s.audio, listOf("Off", "Natural", "Standard", "Voice"),
            listOf(!s.audio, s.audio && s.noiseReduction == 0, s.audio && s.noiseReduction == 1, s.audio && s.noiseReduction == 2))
        out += TrayItem("power", Glyph.POWER, "Power", s.powerMode != PowerMode.BALANCED, PowerMode.names.map { it.substringBefore(" quality").replace("Battery saver", "Saver") }, List(3) { it == s.powerMode })
        out += TrayItem("settings", Glyph.GEAR, "Settings")
        return out
    }

    private fun onTrayItem(it: TrayItem) {
        when (it.key) {
            "exposure" -> { closeTray(); controller.open(if (settings.autoExposure) "EV" else "ISO") }
            "style" -> { closeTray(); controller.open("STYLE") }
            "film" -> { closeTray(); controller.open("FILM") }
            "settings" -> { closeTray(); openSettings() }
        }
    }

    private fun onTrayOption(item: TrayItem, i: Int) {
        val s = settings
        when (item.key) {
            "faces" -> apply(if (i == 0) s.copy(blurOn = false) else s.copy(blurOn = true, maxFaces = listOf(1, 2, 0)[i - 1]))
            "res" -> {
                val sizes = caps?.sizes?.filter { it.width in listOf(3840, 1920, 1280) }?.distinctBy { it.width }?.sortedBy { it.width } ?: return
                if (sizes[i].width != s.width) apply(s.copy(width = sizes[i].width, height = sizes[i].height), restart = true)
            }
            "fps" -> if (!recording) { val f = fpsOptions()[i]; apply(s.copy(fps = f, shutterNs = s.shutterNs.coerceAtMost(1_000_000_000L / f))) }
            "codec" -> if (!recording) apply(s.copy(hevc = i == 0))
            "stab" -> apply(s.copy(ois = i >= 1, eis = i == 2))
            "tools" -> apply(when (i) {
                0 -> s.copy(zebra = !s.zebra); 1 -> s.copy(peaking = !s.peaking); 2 -> s.copy(falseColor = !s.falseColor)
                3 -> s.copy(grid = !s.grid); 4 -> s.copy(level = !s.level); else -> s.copy(histogram = !s.histogram)
            })
            "lock" -> apply(if (i == 0) s.copy(aeLock = !s.aeLock) else s.copy(awbLock = !s.awbLock, autoWb = true))
            "mic" -> apply(if (i == 0) s.copy(audio = false) else s.copy(audio = true, noiseReduction = i - 1))
            "power" -> apply(s.copy(powerMode = i))
            "view" -> apply(s.copy(fullView = i == 1))
            "pull" -> when (i) {
                0 -> setMark(false); 1 -> setMark(true); 2 -> runPull(false); 3 -> runPull(true)
                else -> { stopPull(); markA = null; markB = null; overlay.markA = null; overlay.markB = null }
            }
        }
        if (item.key == "faces" && !settings.blurOn) flash("Face blur OFF · faces will be recorded")
        tray.setItems(trayItems())
        tray.buttons.forEach { it.rotateUpright(deviceRot, false) }
    }

    // ---- camera controller (camera-control style) ------------------------------------------------------
    private fun isoStops(c: CameraCaps): List<Int> {
        val all = listOf(25, 32, 40, 50, 64, 80, 100, 125, 160, 200, 250, 320, 400, 500, 640, 800, 1000, 1250, 1600, 2000, 2500, 3200, 4000, 5000, 6400, 8000, 10000, 12800)
        val r = c.isoRange ?: return listOf(100, 200, 400, 800, 1600)
        return all.filter { it in r.lower..r.upper }.ifEmpty { listOf(r.lower, r.upper) }
    }

    private data class Shutter(val ns: Long, val label: String)

    private fun shutterStops(c: CameraCaps): List<Shutter> {
        val frame = 1_000_000_000L / settings.fps
        val r = c.exposureRange
        val out = if (settings.shutterAngle) {
            listOf(11.25, 22.5, 45.0, 90.0, 144.0, 172.8, 180.0, 216.0, 270.0, 360.0).map { a ->
                Shutter((a / 360.0 * frame).toLong(), if (a % 1.0 == 0.0) "${a.toInt()}°" else "$a°")
            }
        } else {
            listOf(8000, 6400, 4000, 3200, 2000, 1600, 1000, 800, 500, 400, 250, 200, 125, 120, 100, 60, 50, 48, 30, 25, 24).map { d ->
                Shutter(1_000_000_000L / d, "1/$d")
            }.reversed()
        }
        return out.filter { it.ns <= frame && (r == null || it.ns in r.lower..r.upper) }.sortedBy { it.ns }
    }

    private fun focusStops(c: CameraCaps): List<Float> = List(61) { i -> c.minFocusDiopters * i / 60 }

    private fun shutterLabel(ns: Long): String = if (settings.shutterAngle) {
        "${(ns.toDouble() * settings.fps / 1e9 * 360).roundToInt()}°"
    } else "1/${(1e9 / ns.coerceAtLeast(1)).roundToInt()}"

    private fun focusLabel(d: Float) = if (d <= 0.001f) "∞" else if (1 / d >= 1f) "%.1f m".format(1 / d) else "${(100 / d).roundToInt()} cm"

    private val kelvins = (25..100).map { it * 100 }
    private val strengths = (1..20).map { it * 5 }

    private fun zoomList(): List<Float> {
        val c = caps ?: return listOf(1f)
        val out = ArrayList<Float>()
        var z = c.zoomRange.lower
        val max = minOf(c.zoomRange.upper, 30f)
        while (z <= max + 1e-3f) {
            out.add((z * 100).roundToInt() / 100f)
            z += when { z < 1f -> 0.05f; z < 3f -> 0.1f; z < 10f -> 0.5f; else -> 1f }
        }
        return out
    }

    private fun filmNames() = FilmPresets.names.filter { it != "Custom" || settings.filmPreset == "Custom" }

    private fun controlSpecs(): List<ControlSpec> {
        val c = caps
        val s = settings
        val out = ArrayList<ControlSpec>()
        if (s.autoExposure) out += ControlSpec("EV", "Exposure", Glyph.SUN)
        if (c?.manualSensor == true) { out += ControlSpec("ISO", "ISO", Glyph.ISO); out += ControlSpec("SHUTTER", "Shutter", Glyph.SHUTTER) }
        out += ControlSpec("WB", "White Balance", Glyph.WB)
        out += ControlSpec("TINT", "Tint", Glyph.TINT)
        if ((c?.minFocusDiopters ?: 0f) > 0f) out += ControlSpec("FOCUS", "Focus", Glyph.FOCUS)
        out += ControlSpec("ZOOM", "Zoom", Glyph.ZOOM)
        if (s.depthMode) {
            out += ControlSpec("DEPTH", "Depth", Glyph.DEPTH)
            out += ControlSpec("BOKEH", "Bokeh", Glyph.SHUTTER)
            out += ControlSpec("LIGHTS", "Bokeh Highlights", Glyph.SUN)
        }
        out += ControlSpec("FACES", "Face Blur", Glyph.FACE)
        out += ControlSpec("STYLE", "Style", Glyph.STYLE)
        if (s.lut != "None") out += ControlSpec("TONE", "Style Strength", Glyph.TONE)
        out += ControlSpec("FILM", "Film", Glyph.FILM)
        return out
    }

    // Simulated aperture in 1/3 stops, from Off (sharp) to f/1.4. Blur grows as 1/N like a
    // real lens, so it rises gradually from nothing instead of jumping on.
    private val F_STOPS = listOf(22f, 20f, 18f, 16f, 14f, 13f, 11f, 10f, 9f, 8f, 7.1f, 6.3f, 5.6f, 5f, 4.5f, 4f, 3.5f, 3.2f, 2.8f, 2.5f, 2.2f, 2f, 1.8f, 1.6f, 1.4f)
    private val APERTURES = listOf(0f to "Off") + F_STOPS.map { n -> (1.4f / n) to "ƒ" + (if (n % 1f == 0f) "${n.toInt()}" else "$n") }
    private val BOKEH_SHAPES = listOf("Circle", "Blades", "Anamorphic", "Swirl")
    private fun apertureIndex(d: Float) = APERTURES.indices.minByOrNull { abs(APERTURES[it].first - d) } ?: 0
    private fun apertureLabel(d: Float) = if (d <= 0.001f) "ƒ Off" else APERTURES[apertureIndex(d)].second

    private val controls = object : ControlSource {
        override fun labels(key: String): List<String> {
            val c = caps ?: return emptyList()
            return when (key) {
                "EV" -> (c.evRange.lower..c.evRange.upper).map { val v = it * c.evStep; if (abs(v) < 0.01f) "0" else "%+.1f".format(v) }
                "ISO" -> isoStops(c).map { "$it" }
                "SHUTTER" -> shutterStops(c).map { it.label }
                "WB" -> kelvins.map { "${it / 100}" }
                "TINT" -> (-50..50).map { if (it > 0) "+$it" else "$it" }
                "FOCUS" -> focusStops(c).map { focusLabel(it) }
                "ZOOM" -> zoomList().map { zoom.label(it).removeSuffix("×") }
                "DEPTH" -> APERTURES.map { it.second.removePrefix("ƒ") }
                "FACES", "TONE" -> strengths.map { "$it" }
                "BOKEH" -> BOKEH_SHAPES
                "LIGHTS" -> (0..10).map { "${it * 10}" }
                "STYLE" -> lutNames()
                "FILM" -> filmNames()
                else -> emptyList()
            }
        }

        override fun index(key: String): Int {
            val c = caps ?: return 0
            val s = settings
            val ro = readout
            return when (key) {
                "EV" -> s.ev - c.evRange.lower
                "ISO" -> isoStops(c).indexOfFirst { it >= (if (s.autoExposure) ro?.iso?.takeIf { v -> v > 0 } ?: s.iso else s.iso) }.let { if (it < 0) isoStops(c).size - 1 else it }
                "SHUTTER" -> { val cur = if (s.autoExposure) ro?.exposureNs?.takeIf { it > 0 } ?: s.shutterNs else s.shutterNs; shutterStops(c).indexOfFirst { it.ns >= cur }.let { if (it < 0) shutterStops(c).size - 1 else it } }
                "WB" -> kelvins.indexOf((s.kelvin / 100) * 100).coerceAtLeast(0)
                "TINT" -> s.tint + 50
                "FOCUS" -> { val d = if (s.autoFocus) ro?.focusDiopters ?: s.focusDiopters else s.focusDiopters; focusStops(c).indexOfFirst { it >= d - 1e-4f }.coerceAtLeast(0) }
                "ZOOM" -> zoomList().indexOfFirst { it >= s.zoom - 0.01f }.let { if (it < 0) zoomList().size - 1 else it }
                "DEPTH" -> apertureIndex(s.cineDepth)
                "FACES" -> strengths.indexOfFirst { it >= s.intensity }.coerceAtLeast(0)
                "BOKEH" -> s.bokehShape
                "LIGHTS" -> (s.bokehHighlights * 10).roundToInt()
                "TONE" -> strengths.indexOfFirst { it >= (s.lutAmount * 100).roundToInt() }.coerceAtLeast(0)
                "STYLE" -> lutNames().indexOf(s.lut).coerceAtLeast(0)
                "FILM" -> filmNames().indexOf(s.filmPreset).coerceAtLeast(0)
                else -> 0
            }
        }

        override fun set(key: String, i: Int) {
            val c = caps ?: return
            val s = settings
            val ro = readout
            when (key) {
                "EV" -> apply(s.copy(ev = c.evRange.lower + i))
                "ISO" -> if (c.manualSensor) apply(s.copy(autoExposure = false, iso = isoStops(c)[i],
                    shutterNs = if (s.autoExposure) ro?.exposureNs?.takeIf { it > 0 }?.coerceAtMost(1_000_000_000L / s.fps) ?: s.shutterNs else s.shutterNs))
                "SHUTTER" -> if (c.manualSensor) apply(s.copy(autoExposure = false, shutterNs = shutterStops(c)[i].ns,
                    iso = if (s.autoExposure) ro?.iso?.takeIf { it > 0 } ?: s.iso else s.iso))
                "WB" -> apply(s.copy(autoWb = false, kelvin = kelvins[i]))
                "TINT" -> apply(s.copy(autoWb = false, tint = i - 50))
                "FOCUS" -> apply(s.copy(autoFocus = false, focusDiopters = focusStops(c)[i]))
                "ZOOM" -> setZoom(zoomList()[i])
                "DEPTH" -> apply(s.copy(depth = APERTURES[i].first, cineDepth = APERTURES[i].first))
                "FACES" -> apply(s.copy(intensity = strengths[i], blurOn = true))
                "BOKEH" -> apply(s.copy(bokehShape = i))
                "LIGHTS" -> apply(s.copy(bokehHighlights = i / 10f))
                "TONE" -> apply(s.copy(lutAmount = strengths[i] / 100f))
                "STYLE" -> apply(s.copy(lut = lutNames()[i]))
                "FILM" -> apply(FilmPresets.apply(s, filmNames()[i]))
            }
        }

        override fun auto(key: String): Boolean? = when (key) {
            "ISO", "SHUTTER" -> settings.autoExposure
            "WB", "TINT" -> settings.autoWb
            "FOCUS" -> settings.autoFocus
            else -> null
        }

        override fun toggleAuto(key: String) {
            val s = settings
            when (key) {
                "ISO", "SHUTTER" -> {
                    if (caps?.manualSensor != true) return
                    // Leaving auto keeps the exposure the camera was using.
                    val ro = readout
                    apply(if (s.autoExposure) s.copy(autoExposure = false, iso = ro?.iso?.takeIf { it > 0 } ?: s.iso,
                        shutterNs = ro?.exposureNs?.takeIf { it > 0 }?.coerceAtMost(1_000_000_000L / s.fps) ?: s.shutterNs) else s.copy(autoExposure = true, shutterPriority = false))
                }
                "WB", "TINT" -> apply(s.copy(autoWb = !s.autoWb))
                "FOCUS" -> apply(s.copy(autoFocus = !s.autoFocus, focusDiopters = readout?.focusDiopters ?: s.focusDiopters))
            }
        }

        override fun value(key: String): String {
            val s = settings
            val c = caps
            val ro = readout
            return when (key) {
                "EV" -> { val v = s.ev * (c?.evStep ?: 0.333f); if (abs(v) < 0.01f) "0.0 EV" else "%+.1f EV".format(v) }
                "ISO" -> if (s.autoExposure) "Auto · ISO ${ro?.iso ?: "–"}" else "ISO ${s.iso}"
                "SHUTTER" -> if (s.autoExposure) "Auto · ${ro?.exposureNs?.takeIf { it > 0 }?.let { shutterLabel(it) } ?: "–"}" else shutterLabel(s.shutterNs)
                "WB" -> if (s.autoWb) (if (s.awbLock) "Auto · locked" else "Auto") else "${s.kelvin} K"
                "TINT" -> if (s.autoWb) "Auto" else (if (s.tint > 0) "+${s.tint}" else "${s.tint}")
                "FOCUS" -> if (s.autoFocus) "Auto · ${ro?.focusDiopters?.let { focusLabel(it) } ?: "–"}" else focusLabel(s.focusDiopters)
                "ZOOM" -> zoom.label(s.zoom)
                "DEPTH" -> apertureLabel(s.cineDepth)
                "FACES" -> if (s.blurOn) "Strength ${s.intensity}" else "Off"
                "BOKEH" -> BOKEH_SHAPES[s.bokehShape]
                "LIGHTS" -> "${(s.bokehHighlights * 100).roundToInt()} %"
                "TONE" -> "${(s.lutAmount * 100).roundToInt()} %"
                "STYLE" -> if (s.lut == "None") "Standard" else s.lut
                "FILM" -> if (s.filmPreset == "Off") "Off" else s.filmPreset
                else -> ""
            }
        }
    }

    // ---- exposure from the picture ----------------------------------------------------------------------
    private var evAcc = 0f

    private fun evFraction(): Float {
        val c = caps ?: return 0f
        val span = maxOf(abs(c.evRange.lower), abs(c.evRange.upper)).coerceAtLeast(1)
        return settings.ev.toFloat() / span
    }

    private fun dragExposure(d: Float) {
        val c = caps ?: return
        if (!settings.autoExposure) return
        val span = maxOf(abs(c.evRange.lower), abs(c.evRange.upper)).coerceAtLeast(1)
        evAcc += d * span
        val steps = evAcc.toInt()
        if (steps != 0) {
            evAcc -= steps
            val nv = (settings.ev + steps).coerceIn(c.evRange.lower, c.evRange.upper)
            if (nv != settings.ev) { overlay.tick(); apply(settings.copy(ev = nv)) }
        }
        overlay.exposure = evFraction()
    }

    // ---- zoom / lens / focus ----------------------------------------------------------------------------
    private fun zoomStops(): List<Float> {
        val c = caps ?: return listOf(1f)
        val lo = c.zoomRange.lower; val hi = c.zoomRange.upper
        val base = listOf(0.5f, 1f, 2f, 5f).filter { it >= lo - 0.01f && it <= hi + 0.01f }
        return (if (lo < 0.99f && base.none { it < 1f }) listOf(lo) + base else base).distinct().ifEmpty { listOf(1f) }
    }

    private fun setZoom(z: Float, fromControl: Boolean = false) {
        val c = caps ?: return
        val v = z.coerceIn(c.zoomRange.lower, c.zoomRange.upper)
        if (abs(v - settings.zoom) < 0.003f) return
        settings = settings.copy(zoom = v)
        camera.update(settings)
        if (!fromControl) zoom.zoom = v
        controller.refresh()
        main.removeCallbacks(saveZoom)
        main.postDelayed(saveZoom, 600)
    }

    private val saveZoom = Runnable { Settings.save(this, settings) }

    private fun switchLens() {
        if (recording) return
        val c = caps ?: return
        val next = cameras.firstOrNull { it.front != c.front } ?: return
        springFloat(0f, 180f, Spring(0.75f, 0.45f)) { flipBtn.spin = it }
        apply(settings.copy(cameraId = next.id, zoom = 1f), restart = true)
    }

    private fun tapFocus(ix: Float, iy: Float, lock: Boolean) {
        val c = caps ?: return
        val (w, h) = imageSize
        if (w == 0) return
        var u = ix / w; val v = iy / h
        if (c.front) u = 1f - u
        // Upright image -> sensor orientation.
        val (sx, sy) = when (c.sensorOrientation) {
            90 -> v to 1f - u
            270 -> 1f - v to u
            180 -> 1f - u to 1f - v
            else -> u to v
        }
        camera.focusAt(sx, sy)
        lastTapImg = floatArrayOf(ix, iy)
        if (pull != null) stopPull()
        // Cinematic / Portrait: the depth of field moves to what was tapped (a focus pull).
        if (settings.depthMode) renderer.setFocusPoint(ix, iy)
        evAcc = 0f
        if (lock) {
            apply(settings.copy(aeLock = true))
            toast.show("AE/AF LOCK", badge = true, ms = 3_600_000L)
        } else if (aeLockedByPress) unlockAe()
        aeLockedByPress = lock
        if (lock) overlay.locked = true
        overlay.exposure = evFraction()
    }

    private var aeLockedByPress = false

    private fun unlockAe() {
        if (aeLockedByPress || settings.aeLock) {
            aeLockedByPress = false
            if (settings.aeLock) apply(settings.copy(aeLock = false))
            toast.show("AE/AF LOCK OFF", ms = 900)
        }
    }

    /** Brief blurred still of the picture while the camera switches (card flip for the lens). */
    private fun snapshotTransition(flip: Boolean) {
        val surface = surfaceView.holder.surface
        if (surface == null || !surface.isValid || surfaceView.width == 0) return
        val bmp = Bitmap.createBitmap((surfaceView.width / 4).coerceAtLeast(1), (surfaceView.height / 4).coerceAtLeast(1), Bitmap.Config.ARGB_8888)
        runCatching {
            PixelCopy.request(surfaceView, bmp, { res ->
                if (res != PixelCopy.SUCCESS) return@request
                snapshot.setImageBitmap(bmp)
                if (android.os.Build.VERSION.SDK_INT >= 31) snapshot.setRenderEffect(RenderEffect.createBlurEffect(dp(18f).toFloat(), dp(18f).toFloat(), Shader.TileMode.CLAMP))
                snapshot.animate().cancel()
                snapshot.visibility = View.VISIBLE; snapshot.alpha = 1f; snapshot.rotationY = 0f
                snapshot.cameraDistance = 9000f * resources.displayMetrics.density
                if (flip) snapshot.spring(Spring(0.85f, 0.6f)).rotationY(180f).start()
                main.removeCallbacks(hideSnapshot)
                main.postDelayed(hideSnapshot, if (flip) 1500 else 380)
            }, main)
        }
    }

    private val hideSnapshot = Runnable {
        snapshot.animate().cancel()
        snapshot.animate().alpha(0f).setDuration(220).withEndAction { snapshot.visibility = View.GONE; snapshot.rotationY = 0f }.start()
    }

    // ---- takes: cinema naming, metadata, GPS --------------------------------------------------------------
    private val namingPrefs by lazy { getSharedPreferences("veil_naming", Context.MODE_PRIVATE) }
    private var forceNewReel = false

    private fun namingState() = com.veil.cam.core.NamingState(settings.cameraLetter.first(), namingPrefs.getInt("reel", 1),
        namingPrefs.getInt("clip", 0), namingPrefs.getString("date", "") ?: "")

    /** Next clip name, e.g. A001_C001_20261114 (GL thread calls this when the take starts). */
    private fun newTake(): com.veil.cam.record.TakeSpec {
        val s = settings
        val today = java.text.SimpleDateFormat("yyyyMMdd", java.util.Locale.US).format(java.util.Date())
        val base = if (s.cinemaNaming) {
            val (name, st) = com.veil.cam.core.ClipNaming.next(namingState(), today, s.newReelDaily, forceNewReel)
            forceNewReel = false
            namingPrefs.edit().putInt("reel", st.reel).putInt("clip", st.clip).putString("date", st.lastDate).apply()
            name.base
        } else null
        val out = MediaStorage.newVideo(this, s.privateGallery, baseName = base, mov = s.movExtension)
        return com.veil.cam.record.TakeSpec(out, base ?: (out.file?.nameWithoutExtension ?: "clip"), if (s.embedGps) lastLocation() else null)
    }

    private fun previewTakeName(): String {
        val today = java.text.SimpleDateFormat("yyyyMMdd", java.util.Locale.US).format(java.util.Date())
        val base = com.veil.cam.core.ClipNaming.next(namingState(), today, settings.newReelDaily, forceNewReel).first.base
        return base + if (settings.movExtension) ".MOV" else ".MP4"
    }

    private val locationListener = android.location.LocationListener { }

    /** While GPS tagging is on, keep a fresh fix (coarse updates: a few a minute). */
    @android.annotation.SuppressLint("MissingPermission")
    private fun startLocation() {
        stopLocation()
        if (!settings.embedGps || !resumed) return
        val lm = getSystemService(android.location.LocationManager::class.java) ?: return
        val fine = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        val coarse = checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
        val provider = when {
            fine && lm.isProviderEnabled(android.location.LocationManager.GPS_PROVIDER) -> android.location.LocationManager.GPS_PROVIDER
            (fine || coarse) && lm.isProviderEnabled(android.location.LocationManager.NETWORK_PROVIDER) -> android.location.LocationManager.NETWORK_PROVIDER
            else -> return
        }
        runCatching { lm.requestLocationUpdates(provider, 20_000L, 25f, locationListener, Looper.getMainLooper()) }
    }

    private fun stopLocation() {
        runCatching { getSystemService(android.location.LocationManager::class.java)?.removeUpdates(locationListener) }
    }

    @android.annotation.SuppressLint("MissingPermission")
    private fun lastLocation(): DoubleArray? {
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED &&
            checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) return null
        val lm = getSystemService(android.location.LocationManager::class.java) ?: return null
        val loc = listOf(android.location.LocationManager.GPS_PROVIDER, android.location.LocationManager.NETWORK_PROVIDER, android.location.LocationManager.PASSIVE_PROVIDER)
            .mapNotNull { runCatching { lm.getLastKnownLocation(it) }.getOrNull() }.maxByOrNull { it.time } ?: return null
        return doubleArrayOf(loc.latitude, loc.longitude, loc.altitude)
    }

    /** Camera settings right now, for the take's metadata track (once a second). */
    private fun cameraMeta(): org.json.JSONObject {
        val s = settings; val c = caps; val ro = readout
        val iso = if (s.autoExposure) ro?.iso ?: 0 else s.iso
        val exp = if (s.autoExposure) ro?.exposureNs ?: 0L else s.shutterNs
        return org.json.JSONObject().apply {
            put("iso", iso); put("exposure_ns", exp)
            put("shutter_angle", if (exp > 0) Math.round(exp.toDouble() * s.fps / 1e9 * 3600) / 10.0 else 0.0)
            put("white_balance", if (s.autoWb) "auto" else "${s.kelvin}K"); put("tint", s.tint)
            put("focus_m", (if (s.autoFocus) ro?.focusDiopters else s.focusDiopters)?.let { if (it > 0.001f) Math.round(100.0 / it) / 100.0 else "inf" } ?: "unknown")
            put("zoom", s.zoom.toDouble()); put("ev", s.ev * (c?.evStep ?: 0.333f).toDouble())
            if (s.depthMode) put("aperture_sim", apertureLabel(s.cineDepth))
        }
    }

    private val metaTick = object : Runnable {
        override fun run() {
            if (!recording) return
            renderer.addTakeMetadata(cameraMeta().toString())
            main.postDelayed(this, 1000)
        }
    }

    override fun onTakeSaved(spec: com.veil.cam.record.TakeSpec, meta: List<String>, startUs: Long) {
        val s = settings; val c = caps
        val j = org.json.JSONObject().apply {
            put("clip", spec.baseName)
            put("reel", spec.baseName.substringBefore("_"))
            put("camera", "Veil Cam ${BuildConfigLite.VERSION} · ${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}")
            put("lens", org.json.JSONObject().apply {
                put("id", c?.id); put("label", c?.label); put("focal_length_mm", (c?.focalMm ?: 0f).toDouble())
                put("zoom", s.zoom.toDouble()); put("anamorphic_squeeze", s.desqueeze.toDouble())
            })
            put("format", org.json.JSONObject().apply {
                put("resolution", "${s.width}x${s.height}"); put("fps", s.fps); put("codec", if (s.hevc) "HEVC" else "H.264")
                put("bitrate_bps", s.bitrate()); put("orientation", s.orientation)
            })
            put("look", org.json.JSONObject().apply {
                put("lut", s.lut); put("lut_baked", s.bakeLut); put("film", s.filmPreset); put("profile", if (s.flatProfile) "flat" else "standard")
            })
            put("privacy", org.json.JSONObject().apply { put("face_blur", s.blurOn); put("style", s.style.name); put("faces", s.maxFaces) })
            put("start", cameraMeta())
            spec.location?.let { l -> put("gps", org.json.JSONObject().apply { put("lat", l[0]); put("lon", l[1]); put("alt", l[2]) }) }
            put("recorded", java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssZ", java.util.Locale.US).format(java.util.Date()))
            put("preroll_s", s.prerollS)
            put("per_second", org.json.JSONArray(meta.map { org.json.JSONObject(it) }))
        }
        runCatching { MediaStorage.writeSidecar(this, spec.output, spec.baseName, j.toString(2)) }
    }

    // ---- record / photo -------------------------------------------------------------------------------
    private fun toggleRecording() {
        if (recording) {
            renderer.stopRecording()
            if (settings.sounds) sound.play(MediaActionSound.STOP_VIDEO_RECORDING)
        } else {
            if (caps == null) return
            if (!license.canCapture) { openPaywall(); return }
            if (settings.blurOn && !detectorReady) { flash("Face detection is still starting"); return }
            closeTray(); controller.dismiss()
            renderer.startRecording { newTake() }
            if (settings.sounds) sound.play(MediaActionSound.START_VIDEO_RECORDING)
        }
    }

    private fun togglePause() {
        if (!recording) return
        recPaused = !recPaused
        renderer.setRecordingPaused(recPaused)
        root.tick()
        refreshRecordUi()
    }

    private fun photo() {
        if (!license.canCapture) { openPaywall(); return }
        if (settings.blurOn && !detectorReady) { flash("Face detection is still starting"); return }
        if (settings.sounds) sound.play(MediaActionSound.SHUTTER_CLICK)
        // Shutter blink.
        blink.animate().cancel()
        blink.alpha = 0.85f
        blink.animate().alpha(0f).setDuration(180).start()
        if (!settings.burstMerge) { renderer.takePhoto(); return }
        val adv = SceneAnalyzer.advice(if (settings.sceneAuto) scene else Scene.AUTO)
        val iso = readout?.iso ?: settings.iso
        val sigma = 0.03f + 0.05f * (iso / 3200f).coerceIn(0f, 1f)
        val hdr = adv.hdrEv < 0 && settings.autoExposure && !settings.aeLock
        val lift = when {
            hdr -> 2.0f
            adv.scene == Scene.NIGHT -> 1.35f
            adv.scene == Scene.LOW_LIGHT -> 1.2f
            else -> 1f
        }
        val req = Renderer.BurstRequest(adv.mergeFrames, sigma, lift)
        if (adv.mergeFrames >= 6) flash("Hold still · merging ${adv.mergeFrames} frames")
        if (hdr) {
            // HDR: under-expose a stop so the highlights keep detail; the merge lifts the shadows.
            val steps = (1f / (caps?.evStep ?: 0.333f)).roundToInt()
            hdrPending = true
            camera.update(settings.copy(ev = settings.ev - steps))
            main.postDelayed({ renderer.takePhoto(req) }, 350)
        } else renderer.takePhoto(req)
    }

    /** Newest capture for the thumbnail (the private gallery). */
    private fun loadThumb(pop: Boolean) {
        Thread {
            val f = MediaStorage.list(this).firstOrNull()
            val b = f?.let { file ->
                runCatching {
                    if (file.isVideo) MediaMetadataRetriever().use { r ->
                        r.setDataSource(file.absolutePath)
                        r.getScaledFrameAtTime(0, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, 192, 192)
                    } else BitmapFactory.decodeFile(file.absolutePath, BitmapFactory.Options().apply { inSampleSize = 16 })
                }.getOrNull()
            }
            main.post { thumb.set(b, pop) }
        }.start()
    }

    private fun openLatest() {
        val f = MediaStorage.list(this).firstOrNull()
        if (f != null) {
            startActivity(Intent(this, if (f.isVideo) com.veil.cam.ui.PlayerActivity::class.java else com.veil.cam.ui.PhotoActivity::class.java)
                .putExtra("path", f.absolutePath).putExtra("fromCamera", true))
            @Suppress("DEPRECATION") overridePendingTransition(R.anim.veil_zoom_in, R.anim.veil_hold)
            return
        }
        val uri = lastUri
        if (uri != null) runCatching {
            startActivity(Intent(Intent.ACTION_VIEW).apply { setDataAndType(uri, contentResolver.getType(uri) ?: "video/mp4"); addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION) })
        } else startActivity(Intent(this, com.veil.cam.ui.GalleryActivity::class.java))
    }

    // ---- power -------------------------------------------------------------------------------------------
    private var thermal: ThermalMonitor? = null
    private val recordTime by lazy { com.veil.cam.power.RecordTime(applicationContext) }
    private var idleTicks = 0
    private var warnedLowTime = 0L
    private var heat = 0
    private var warnedHot = false
    private var previewScale = 1f
    private var appliedPreview = 0 to 0
    private var lastTouch = 0L
    private var dimmed = false
    private var sleeping = false
    private var sleepView: View? = null
    private var lastThermalStatus = 0

    private fun onThermal(level: Int, status: Int) {
        val was = heat
        heat = level
        if (level != was) { pushBudget(); refreshTop() }
        if (level == 2 && !warnedHot) { warnedHot = true; flash("Phone is hot · saving power (every frame stays blurred)") }
        val critical = android.os.PowerManager.THERMAL_STATUS_CRITICAL
        if (status >= critical && lastThermalStatus < critical && recording) flash("Phone is very hot · consider stopping the take")
        lastThermalStatus = status
        if (level == 0) warnedHot = false
    }

    /** Recompute the work budget (mode, temperature, recording) and hand it to the pipeline. */
    private fun pushBudget() {
        val b = PowerBudget.of(settings.powerMode, heat, recording)
        renderer.setBudget(b)
        previewScale = b.previewScale
        applyPreviewSize()
    }

    /**
     * Render the preview at the video's own resolution, not the panel's: the picture is
     * upscaled on the 2992 x 1344 screen anyway, so a smaller buffer looks the same
     * while the hardware compositor does the scaling for free.
     */
    private fun applyPreviewSize() {
        if (!::surfaceView.isInitialized) return
        val vw = surfaceView.width; val vh = surfaceView.height
        if (vw <= 0 || vh <= 0) return
        val long = maxOf(settings.width, settings.height).toDouble(); val short = minOf(settings.width, settings.height).toDouble()
        val (rw, rh) = if (vw >= vh) long to short else short to long
        val k = minOf(vw / rw, vh / rh) // screen px per video px
        val f = ((if (k > 1.0) 1.0 / k else 1.0) * previewScale).coerceIn(0.35, 1.0)
        val bw = ((vw * f).roundToInt() and 1.inv()).coerceAtLeast(2)
        val bh = ((vh * f).roundToInt() and 1.inv()).coerceAtLeast(2)
        val size = if (f >= 0.999) vw to vh else bw to bh
        if (size == appliedPreview) return
        appliedPreview = size
        if (f >= 0.999) surfaceView.holder.setSizeFromLayout() else surfaceView.holder.setFixedSize(bw, bh)
    }

    /** Tell the 120 Hz LTPO panel the preview only changes at the video frame rate. */
    private fun votePreviewRate() {
        if (!::surfaceView.isInitialized) return
        val surface = surfaceView.holder.surface
        if (surface == null || !surface.isValid) return
        runCatching { surface.setFrameRate(settings.fps.toFloat(), Surface.FRAME_RATE_COMPATIBILITY_FIXED_SOURCE) }
    }

    private fun setDim(on: Boolean) {
        if (on == dimmed) return
        dimmed = on
        // OLED power scales with brightness: 8 % keeps framing visible, a touch restores it.
        window.attributes = window.attributes.apply { screenBrightness = if (on) 0.08f else WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE }
    }

    private val idleCheck = object : Runnable {
        override fun run() {
            if (!resumed) return
            val idle = SystemClock.uptimeMillis() - lastTouch
            if (recording && settings.dimWhileRecording && idle > 10_000) setDim(true)
            // Learn the real battery draw of this format and warn before it runs out.
            if (recording && ++idleTicks % 3 == 0) {
                val s = settings
                recordTime.sample(s.width, s.fps, s.depthMode)
                val e = recordTime.estimate(s.width, s.fps, s.depthMode, s.bitrate())
                val left = e.minutes
                if ((left <= 10 && warnedLowTime == 0L) || (left <= 3 && warnedLowTime > 3)) {
                    warnedLowTime = left.coerceAtLeast(1)
                    flash("About $left min left (${e.limitedBy})")
                }
            }
            if (!recording) warnedLowTime = 0
            if (!recording && settings.autoStandby && !sleeping && idle > 180_000 && !sheet.isOpen) goToSleep()
            main.postDelayed(this, 2_000)
        }
    }

    /** Idle in standby: camera, detector and microphone off; the screen may time out. */
    private fun goToSleep() {
        sleeping = true
        camera.close()
        audio?.stop(); renderer.setAudio(null); audio = null
        val v = sleepView ?: TextView(this).apply {
            setBackgroundColor(Color.BLACK); setTextColor(Theme.SECONDARY); textSize = 15f; gravity = Gravity.CENTER; elevation = dp(30f).toFloat()
            text = "Standby · camera off to save battery\n\nTap to wake"
        }.also { sleepView = it; root.addView(it, FrameLayout.LayoutParams(-1, -1)) }
        v.visibility = View.VISIBLE
        v.bringToFront()
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    private fun wake() {
        if (!sleeping) return
        sleeping = false
        sleepView?.visibility = View.GONE
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        lastTouch = SystemClock.uptimeMillis()
        if (resumed) { startCamera(); startAudio() }
    }

    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        lastTouch = SystemClock.uptimeMillis()
        if (dimmed) setDim(false)
        if (sleeping) { if (ev.actionMasked == MotionEvent.ACTION_UP) wake(); return true }
        return super.dispatchTouchEvent(ev)
    }

    @android.annotation.SuppressLint("GestureBackNavigation") // only lets Back through while learning a button
    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        lastTouch = SystemClock.uptimeMillis()
        if (dimmed) setDim(false)
        learning?.let { a ->
            if (keyCode == KeyEvent.KEYCODE_BACK) return super.onKeyDown(keyCode, event)
            learning = null
            val m = AccessoryKeys.parse(settings.accessoryKeys).toMutableMap().apply { put(keyCode, a) }
            apply(settings.copy(accessoryKeys = AccessoryKeys.format(m)))
            flash("${KeyEvent.keyCodeToString(keyCode).removePrefix("KEYCODE_")} → ${a.label}")
            sheet.refresh()
            return true
        }
        val action = AccessoryKeys.actionFor(keyCode, AccessoryKeys.parse(settings.accessoryKeys), settings.volumeShutter)
            ?: return super.onKeyDown(keyCode, event)
        if (sleeping) { wake(); return true }
        if (sheet.isOpen && (keyCode == KeyEvent.KEYCODE_VOLUME_UP || keyCode == KeyEvent.KEYCODE_VOLUME_DOWN)) return true
        if (event.repeatCount > 0 && !AccessoryKeys.repeats(action)) return true
        runKeyAction(action)
        return true
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean {
        if (AccessoryKeys.actionFor(keyCode, AccessoryKeys.parse(settings.accessoryKeys), settings.volumeShutter) != null) return true
        return super.onKeyUp(keyCode, event)
    }

    /** A gimbal / remote button. */
    private fun runKeyAction(a: KeyAction) {
        when (a) {
            KeyAction.RECORD -> if (settings.photoMode) photo() else toggleRecording()
            KeyAction.PHOTO -> if (settings.photoMode) photo() else flash("Switch to Photo to take pictures")
            KeyAction.ZOOM_IN -> { setZoom(settings.zoom * 1.06f); zoom.peek() }
            KeyAction.ZOOM_OUT -> { setZoom(settings.zoom / 1.06f); zoom.peek() }
            KeyAction.SWITCH_LENS -> switchLens()
            KeyAction.PULL -> runPull(nextPullReverse)
            KeyAction.PAUSE -> togglePause()
            KeyAction.MODE_NEXT, KeyAction.MODE_PREV -> if (!recording) {
                val i = (MODES.indexOf(settings.mode) + if (a == KeyAction.MODE_NEXT) 1 else -1).coerceIn(0, MODES.size - 1)
                modes.select(i); setMode(MODES[i])
            }
            KeyAction.NONE -> {}
        }
    }

    // ---- palm gesture -------------------------------------------------------------------------------
    private val palmTick = object : Runnable {
        override fun run() {
            overlay.palmHold = if (settings.palmGesture && countdownLeft == 0) gesture.holding else 0f
            if (resumed) main.postDelayed(this, 80)
        }
    }

    private val countdownStep = object : Runnable {
        override fun run() {
            countdownLeft--
            overlay.countdown = countdownLeft
            if (countdownLeft > 0) { root.tick(); main.postDelayed(this, 1000) } else {
                root.thud()
                if (settings.photoMode) photo() else if (!recording) toggleRecording()
            }
        }
    }

    private fun cancelCountdown() { main.removeCallbacks(countdownStep); countdownLeft = 0; overlay.countdown = 0 }

    /** Open palm held towards the camera: start (after a countdown) or stop. */
    private fun onPalm() {
        if (!settings.palmGesture || !resumed || sheet.isOpen) return
        when {
            countdownLeft > 0 -> { cancelCountdown(); flash("Countdown cancelled") }
            recording -> { toggleRecording(); flash("Palm: recording stopped") }
            !license.canCapture -> openPaywall()
            settings.palmCountdownS <= 0 -> { root.thud(); if (settings.photoMode) photo() else toggleRecording() }
            else -> {
                countdownLeft = settings.palmCountdownS + 1
                main.removeCallbacks(countdownStep); countdownStep.run()
            }
        }
    }

    // ---- A-B focus pulls ----------------------------------------------------------------------------
    private fun currentMark(): FocusMark? {
        val (w, h) = imageSize
        if (w == 0) return null
        val pt = lastTapImg ?: floatArrayOf(w / 2f, h / 2f)
        val d = if (settings.autoFocus) readout?.focusDiopters ?: settings.focusDiopters else settings.focusDiopters
        return FocusMark(d, renderer.depthAt(pt[0], pt[1]) ?: Float.NaN, pt[0], pt[1])
    }

    private fun setMark(b: Boolean) {
        val m = currentMark() ?: return
        if (b) { markB = m; overlay.markB = floatArrayOf(m.imgX, m.imgY) } else { markA = m; overlay.markA = floatArrayOf(m.imgX, m.imgY) }
        root.tick()
        flash("Focus ${if (b) "B" else "A"} set · ${focusLabel(m.diopters)}")
    }

    private val pullFrame = object : Runnable {
        override fun run() {
            val p = pull ?: return
            val t = SystemClock.uptimeMillis() - pullStart
            val m = p.at(t)
            camera.setFocusOverride(m.diopters)
            if (settings.depthMode && !m.depth.isNaN()) renderer.setManualDepthFocus(m.depth)
            if (p.done(t)) {
                pull = null
                // Hold the end mark: manual focus there, depth fixed on it.
                apply(settings.copy(autoFocus = false, focusDiopters = m.diopters))
                camera.setFocusOverride(null)
                if (settings.depthMode) { renderer.setManualDepthFocus(null); renderer.setFocusPoint(m.imgX, m.imgY) }
                lastTapImg = floatArrayOf(m.imgX, m.imgY)
                controller.refresh()
            } else main.postDelayed(this, 16)
        }
    }

    private fun runPull(reverse: Boolean) {
        val a = markA; val b = markB
        if (a == null || b == null) { flash("Set focus A and B first: tap a subject, then A or B in the tray"); return }
        if (caps?.minFocusDiopters?.let { it <= 0f } == true && !settings.depthMode) { flash("This lens has fixed focus"); return }
        stopPull()
        val fill = { m: FocusMark -> if (m.depth.isNaN()) m.copy(depth = renderer.depthAt(m.imgX, m.imgY) ?: Float.NaN) else m }
        pull = FocusPull(fill(a), fill(b), settings.pullDurationMs.toLong(), Ease.entries[settings.pullEase.coerceIn(0, Ease.entries.size - 1)], reverse)
        nextPullReverse = !reverse
        pullStart = SystemClock.uptimeMillis()
        main.post(pullFrame)
        flash(if (reverse) "Pull B → A" else "Pull A → B")
    }

    private fun stopPull() {
        if (pull == null) return
        pull = null
        main.removeCallbacks(pullFrame)
        camera.setFocusOverride(null)
        renderer.setManualDepthFocus(null)
    }

    /** Back closes what is open (sheet page, controller, tray); otherwise leaves the camera. */
    private fun handleBack(): Boolean = when {
        sheet.isOpen -> { if (!sheet.pop()) sheet.close(); true }
        controller.isOpen -> { controller.dismiss(); true }
        trayOpen -> { closeTray(); true }
        else -> false
    }

    // Android 13+: back gestures go to this callback (onBackPressed is not called for them
    // once the app targets Android 16).
    private val backCallback: Any? = if (android.os.Build.VERSION.SDK_INT >= 33)
        android.window.OnBackInvokedCallback { if (!handleBack()) moveTaskToBack(true) } else null

    private fun registerBack() {
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, backCallback as android.window.OnBackInvokedCallback)
        }
    }

    @Deprecated("Deprecated in Java")
    @android.annotation.SuppressLint("GestureBackNavigation")
    override fun onBackPressed() {
        if (!handleBack()) @Suppress("DEPRECATION") super.onBackPressed()
    }

    // ---- settings sheet ---------------------------------------------------------------------------------------
    private fun batteryLevel(): Int {
        val bm = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        return bm?.let { it.getIntExtra(BatteryManager.EXTRA_LEVEL, 0) * 100 / it.getIntExtra(BatteryManager.EXTRA_SCALE, 100).coerceAtLeast(1) } ?: 0
    }

    private fun fmtMinutes(m: Long) = if (m >= 600) "${m / 60} h" else if (m >= 60) "${m / 60} h ${m % 60} min" else "$m min"

    private fun openSettings() {
        paywallOpen = false
        sheet.open("Settings") { f -> pageRoot(f) }
    }

    // ---- purchase ---------------------------------------------------------------------------------------
    private var paywallOpen = false

    private fun openPaywall() {
        closeTray(); controller.dismiss()
        paywallOpen = true
        license.refresh()
        sheet.open("Veil Cam") { f -> pagePaywall(f) }
    }

    private fun pagePaywall(f: Form) {
        val l = license
        f.section(null, "One payment, no subscription. The purchase belongs to your Google account and works on all your Android devices.") {
            info("Private by design", "Faces blurred on the phone")
            info("Cinema tools", "Depth, pulls, LUTs, pre-record")
            info("Photos", "Multi-frame night and HDR")
        }
        f.section(null, l.reason) {
            when (l.state) {
                com.veil.cam.core.LicenseState.LICENSED -> info("Status", "Unlocked")
                com.veil.cam.core.LicenseState.PENDING -> info("Status", "Payment pending")
                else -> action(l.price?.let { "Unlock for $it" } ?: "Unlock Veil Cam") { l.buy(this@MainActivity) }
            }
            action("Restore Purchase") { l.refresh(); flash("Checking with Google Play…") }
        }
        f.note("You can try the viewfinder and every setting before buying. Taking photos and recording need the one-time purchase.")
    }

    private fun pageLicences(f: Form) {
        val store = BuildConfig.STORE
        f.section("Models") {
            if (store) info("Face detection", "YuNet · MIT · Shiqi Yu / OpenCV Zoo")
            else info("Face detection", "SCRFD · InsightFace · non-commercial")
            info("Depth", "Depth Anything V2 Small · Apache 2.0")
            info("People, hair, gestures", "MediaPipe models · Apache 2.0 · Google")
        }
        f.section("Libraries") {
            info("ONNX Runtime", "MIT · Microsoft")
            info("MediaPipe Tasks", "Apache 2.0 · Google")
            info("AndroidX, Kotlin", "Apache 2.0")
            if (store) info("Play Billing Library", "Android SDK licence · Google")
        }
        f.note("Full licence texts are in the app's source (THIRD_PARTY_NOTICES.md). Film looks, LUTs, icons and the interface are original to Veil Cam.")
    }

    private fun maxFacesLabel() = if (!settings.blurOn) "Off" else when (settings.maxFaces) { 1 -> "1 face"; 2 -> "2 faces"; else -> "Any" }

    private fun pageRoot(f: Form) {
        val s = settings
        f.section(null, "Battery time uses this phone's measured power draw while recording in this format (an estimate until the first take in it).") {
            info("Battery", "${batteryLevel()} %")
            val e = recordTime.estimate(s.width, s.fps, s.depthMode, s.bitrate())
            info("Recording time left", if (e.charging) "${fmtMinutes(e.byStorage)} · charging" else "${fmtMinutes(e.minutes)} · ${e.limitedBy}")
            e.byBattery?.let { info("Battery allows", "${fmtMinutes(it)}${if (e.learned) "" else " (estimate)"}") }
            info("Storage allows", fmtMinutes(e.byStorage))
            info("Temperature", listOf("Normal", "Warm", "Hot")[heat])
        }
        f.section("Capture") {
            nav("Face Blur", maxFacesLabel(), Glyph.FACE) { sheet.push("Face Blur") { pageFaces(it) } }
            nav("Record Video", "${resLabel(s.width).let { if (it == "HD") "1080p" else it }} · ${s.fps} fps", Glyph.FORMAT) { sheet.push("Record Video") { pageVideo(it) } }
            nav("Cinematic Depth", apertureLabel(s.cineDepth), Glyph.DEPTH) { sheet.push("Cinematic Depth") { pageDepth(it) } }
            nav("Styles", if (s.lut == "None") "Standard" else s.lut, Glyph.STYLE) { sheet.push("Styles") { pageLook(it) } }
            nav("Film Look", s.filmPreset, Glyph.FILM) { sheet.push("Film Look") { pageFilm(it) } }
            nav("Audio", if (!s.audio) "Off" else listOf("Natural", "Standard", "Voice")[s.noiseReduction.coerceIn(0, 2)], Glyph.MIC) { sheet.push("Audio") { pageAudio(it) } }
        }
        f.section("Pro") {
            nav("Cinema Tools", listOfNotNull(if (s.prerollS > 0) "Pre-record ${s.prerollS} s" else null, if (s.desqueeze > 1f) "${desqueezeLabel(s.desqueeze)} de-squeeze" else null).joinToString(" · ").ifEmpty { "Naming, pulls" }, Glyph.SHUTTER) { sheet.push("Cinema Tools") { pageCinema(it) } }
            nav("Smart Capture", if (s.burstMerge) "Multi-frame" else "Single frame", Glyph.WAND) { sheet.push("Smart Capture") { pageSmart(it) } }
            nav("Gimbal & Remotes", if (s.palmGesture) "Palm on" else null, Glyph.DIAL) { sheet.push("Gimbal & Remotes") { pageAccessories(it) } }
        }
        f.section("Tools") {
            nav("Monitoring", null, Glyph.PEAK) { sheet.push("Monitoring") { pageMonitoring(it) } }
            nav("Exposure", if (s.shutterPriority) "Shutter priority" else if (s.autoExposure) "Auto" else "Manual", Glyph.SUN) { sheet.push("Exposure") { pageExposure(it) } }
            nav("Camera", if (s.orientation == "Auto") "Follow phone" else s.orientation, Glyph.GEAR) { sheet.push("Camera") { pageCamera(it) } }
        }
        f.section("Device") {
            nav("Power & Heat", PowerMode.names[s.powerMode], Glyph.POWER) { sheet.push("Power & Heat") { pagePower(it) } }
            nav("Storage", if (s.privateGallery) "Private" else "Phone gallery", Glyph.LIBRARY) { sheet.push("Storage") { pageStorage(it) } }
        }
        if (BuildConfig.STORE) f.section("Purchase") {
            nav("Veil Cam", if (license.canCapture) "Unlocked" else license.price ?: "Unlock", Glyph.CHECK) { openPaywall() }
        }
        f.section("About", "Veil Cam ${BuildConfigLite.VERSION}. Everything runs on the phone; no photo, video or face data leaves it.") {
            info("Version", BuildConfigLite.VERSION)
            nav("Licences", null, Glyph.LIBRARY) { sheet.push("Licences") { pageLicences(it) } }
            info("Face detection", if (settings.blurOn) "%.0f fps".format(lastDetectFps) else "Off")
        }
    }

    private fun pageFaces(f: Form) {
        val s = settings
        f.section(null, "Recordings are blurred frame-exactly: each frame waits until its faces are known. The picture stays fully blurred until face detection has started.") {
            switch("Blur Faces", s.blurOn) { apply(settings.copy(blurOn = it)) }
        }
        f.section("Faces in video", when (s.maxFaces) {
            1 -> "Only the single most certain face is hidden. Weak detections are ignored, so no stray blur."
            2 -> "Only the two most certain faces are hidden. Brief false detections never get blurred."
            else -> "Every detected face is hidden, including small background faces."
        }) { segmented(listOf("1", "2", "Any"), when (s.maxFaces) { 1 -> 0; 2 -> 1; else -> 2 }) { apply(settings.copy(maxFaces = listOf(1, 2, 0)[it])); sheet.refresh() } }
        f.section("Style") {
            segmented(listOf("Blur", "Pixelate", "Black", "Mask"), s.style.ordinal) { apply(settings.copy(style = BlurStyle.entries[it])) }
            segmented(listOf("Ellipse", "Rectangle"), if (s.ellipse) 0 else 1, "Shape") { apply(settings.copy(ellipse = it == 0)) }
            slider("Strength", 1, 100, s.intensity, { "$it" }) { apply(settings.copy(intensity = it)) }
            slider("Coverage", 0, 80, (s.coverage * 100).roundToInt(), { "+$it %" }) { apply(settings.copy(coverage = it / 100f)) }
            slider("Hold after loss", 0, 30, s.holdFrames, { "$it fr" }) { apply(settings.copy(holdFrames = it)) }
            switch("Soft Edges", s.softEdges) { apply(settings.copy(softEdges = it)) }
        }
        f.section("Mask") {
            action("Choose Mask Image…") { importMask() }
            action("Use Built-in Mask") { apply(settings.copy(maskPath = "")) }
        }
        f.section("Detector") {
            segmented(listOf("Fast", "Accurate"), if (s.accurateModel) 1 else 0, "Model") { apply(settings.copy(accurateModel = it == 1)) }
            segmented(listOf("Any angle", "Tilted ±75°"), if (s.allAngles) 0 else 1, "Face angles") { apply(settings.copy(allAngles = it == 0)) }
            switch("Show Tracked Faces", s.showBoxes) { apply(settings.copy(showBoxes = it)) }
        }
    }

    private fun pageVideo(f: Form) {
        val s = settings
        val c = caps
        val sizes = c?.sizes?.filter { it.width in listOf(3840, 1920, 1280) }?.distinctBy { it.width }?.sortedBy { it.width } ?: emptyList()
        val fps = fpsOptions()
        f.section("Format", "Higher resolution and frame rate take more space: ${s.bitrate() / 1_000_000} Mbps at the current setting.") {
            for (sz in sizes) for (r in fps) check("${when (sz.width) { 3840 -> "4K"; 1920 -> "1080p HD"; else -> "720p HD" }} at $r fps", sz.width == s.width && r == s.fps) {
                if (recording) { flash("Stop recording to change this"); return@check }
                val ns = settings.shutterNs.coerceAtMost(1_000_000_000L / r)
                apply(settings.copy(width = sz.width, height = sz.height, fps = r, shutterNs = ns), restart = sz.width != settings.width)
                sheet.refresh()
            }
        }
        f.section("Encoding") {
            segmented(listOf("HEVC", "H.264"), if (s.hevc) 0 else 1, "Codec") { if (!recording) apply(settings.copy(hevc = it == 0)) }
            segmented(listOf("Low", "Standard", "High", "Max"), s.bitrateLevel.coerceIn(0, 3), "Quality") { if (!recording) { apply(settings.copy(bitrateLevel = it)); sheet.refresh() } }
        }
        f.section("Stabilization", "Enhanced adds digital stabilization (a slight crop).") {
            if (c?.ois == true) switch("Optical (OIS)", s.ois) { apply(settings.copy(ois = it)) }
            if (c?.eis == true || c?.previewStabilization == true) switch("Enhanced", s.eis) { apply(settings.copy(eis = it)) }
        }
        f.section("Monitor", "Off: the screen shows exactly what is recorded, a few frames behind. On: the newest frame, with the blur following faces by prediction.") {
            switch("Low-Latency Preview", s.lowLatencyPreview) { apply(settings.copy(lowLatencyPreview = it)) }
        }
    }

    private val DESQUEEZE = listOf(1f, 1.33f, 1.55f, 2f)
    private fun desqueezeLabel(v: Float) = if (v <= 1f) "Off" else "${"%.2f".format(v).trimEnd('0').trimEnd('.')}×"

    private fun pageCinema(f: Form) {
        val s = settings
        val pre = listOf(0, 3, 5, 10)
        f.section("Pre-record", "Keeps the last seconds in memory before you press record, so a moment that already happened is in the clip. The encoder runs while you frame: about 10 % more battery.") {
            segmented(listOf("Off", "3 s", "5 s", "10 s"), pre.indexOf(s.prerollS).coerceAtLeast(0)) { if (!recording) apply(settings.copy(prerollS = pre[it])) }
        }
        val next = previewTakeName()
        f.section("File naming", if (s.cinemaNaming) "Next clip: $next. Reel and clip numbers count up; a new reel starts each day." else "Clips are named by date and time.") {
            switch("Reel / Clip Names", s.cinemaNaming) { apply(settings.copy(cinemaNaming = it)); sheet.refresh() }
            if (s.cinemaNaming) {
                val letters = listOf("A", "B", "C", "D")
                segmented(letters.map { "$it cam" }, letters.indexOf(s.cameraLetter).coerceAtLeast(0), "Camera") { apply(settings.copy(cameraLetter = letters[it])); sheet.refresh() }
                switch("New Reel Each Day", s.newReelDaily) { apply(settings.copy(newReelDaily = it)) }
                action("Start New Reel") { forceNewReel = true; flash("Next clip starts a new reel"); sheet.refresh() }
            }
            segmented(listOf(".MOV", ".MP4"), if (s.movExtension) 0 else 1, "File type") { apply(settings.copy(movExtension = it == 0)); sheet.refresh() }
        }
        f.section("Metadata", "Each clip carries lens, focal length, ISO, shutter angle, white balance and frame rate in a metadata track and a .json sidecar next to it.") {
            switch("Embed GPS Location", s.embedGps) {
                apply(settings.copy(embedGps = it))
                if (it && checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED)
                    requestPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION), 2)
            }
        }
        f.section("Anamorphic de-squeeze", "Stretches the monitor for anamorphic adapter lenses. The recording keeps the squeezed picture for de-squeezing in the edit.") {
            segmented(DESQUEEZE.map { desqueezeLabel(it) }, DESQUEEZE.indexOfFirst { abs(it - s.desqueeze) < 0.01f }.coerceAtLeast(0)) { apply(settings.copy(desqueeze = DESQUEEZE[it])) }
        }
        f.section("A-B focus pulls", "Tap a subject and choose Set A in the tray (A-B Focus), then the next subject and Set B. A → B runs the pull; in Cinematic the depth of field follows it.") {
            slider("Duration", 3, 100, (s.pullDurationMs / 100).coerceIn(3, 100), { "%.1f s".format(it / 10f) }) { apply(settings.copy(pullDurationMs = it * 100)) }
            segmented(Ease.entries.map { it.label.replace("Ease ", "").replaceFirstChar { c -> c.uppercase() } }, s.pullEase.coerceIn(0, Ease.entries.size - 1), "Curve") { apply(settings.copy(pullEase = it)) }
        }
        f.note("Frame rate, codec and quality are under Record Video; shutter angle under Exposure; LUT monitoring under Styles.")
    }

    private fun pageSmart(f: Form) {
        val s = settings
        f.section(null, "Photos merge several frames, aligned to the first: less noise in low light, and with HDR the highlights stay while shadows lift. Moving things are taken from one frame only, so they never ghost.") {
            switch("Multi-Frame Merge", s.burstMerge) { apply(settings.copy(burstMerge = it)) }
        }
        f.section("Scene recognition", "Recognises night, low light, backlight, portraits, close-ups and landscapes, and picks the merge and HDR for the photo.") {
            switch("Scene Recognition", s.sceneAuto) { apply(settings.copy(sceneAuto = it)) }
            if (s.sceneAuto) info("Now", scene.label)
        }
        f.section("Composition", "Thirds and headroom hints for the main face, before you press the shutter. The level and grid are under Monitoring.") {
            switch("Framing Suggestions", s.framingGuide) { apply(settings.copy(framingGuide = it)) }
            switch("Grid", s.grid) { apply(settings.copy(grid = it)) }
            switch("Level", s.level) { apply(settings.copy(level = it)) }
        }
    }

    private fun pageAccessories(f: Form) {
        val s = settings
        f.section("Palm gesture", "Hold an open palm towards the camera for half a second: a countdown, then recording starts. Show the palm again to stop. Recognised on the phone.") {
            switch("Palm to Record", s.palmGesture) { apply(settings.copy(palmGesture = it)); sheet.refresh() }
            if (s.palmGesture) segmented(listOf("No countdown", "3 s", "5 s", "10 s"), listOf(0, 3, 5, 10).indexOf(s.palmCountdownS).coerceAtLeast(1), "Countdown") {
                apply(settings.copy(palmCountdownS = listOf(0, 3, 5, 10)[it]))
            }
        }
        f.section("Gimbal buttons", "Pair the gimbal or remote with the phone's Bluetooth (on gimbals, its Bluetooth camera-control mode). Its record or shutter button and zoom then work here; any other button can be learnt below.") {
            switch("Volume & Shutter Buttons Record", s.volumeShutter) { apply(settings.copy(volumeShutter = it)) }
        }
        val learnt = AccessoryKeys.parse(s.accessoryKeys)
        f.section("Learn a button", "Choose an action, then press the button on the gimbal or remote.") {
            for (a in KeyAction.entries.filter { it != KeyAction.NONE }) {
                val keys = learnt.filterValues { it == a }.keys.joinToString { KeyEvent.keyCodeToString(it).removePrefix("KEYCODE_") }
                nav(a.label, keys.ifEmpty { null }, Glyph.DIAL) { learning = a; flash("Press the button for “${a.label}”") }
            }
            if (learnt.isNotEmpty()) action("Forget Learnt Buttons") { apply(settings.copy(accessoryKeys = "")); sheet.refresh() }
        }
        f.note("A gimbal's motors, joystick and app-based subject tracking use its maker's own protocol and stay in the maker's app. Gimbals with a built-in tracking module follow subjects by themselves, with any camera app.")
    }

    private fun pageDepth(f: Form) {
        val s = settings
        f.section(null, "Cinematic and Portrait keep people sharp and give the background a lens blur. Tap ƒ on the camera screen to change it while you frame.") {
            slider("Aperture", 0, APERTURES.size - 1, apertureIndex(s.cineDepth), { APERTURES[it].second }) {
                apply(settings.copy(cineDepth = APERTURES[it].first, depth = if (settings.depthMode) APERTURES[it].first else 0f))
            }
        }
        f.section("Bokeh", when (s.bokehShape) {
            1 -> "Six aperture blades: lights become soft hexagons, like a stopped-down cine lens."
            2 -> "Anamorphic: tall oval lights, the classic widescreen cinema look."
            3 -> "Swirl: the background spins towards the edges, like a vintage Petzval or Helios lens."
            else -> "Round lights that turn into cat's eyes towards the corners, as with a fast prime."
        }) {
            segmented(BOKEH_SHAPES, s.bokehShape) { apply(settings.copy(bokehShape = it)); sheet.refresh() }
            slider("Highlights", 0, 100, (s.bokehHighlights * 100).roundToInt(), { "$it %" }) { apply(settings.copy(bokehHighlights = it / 100f)) }
        }
        f.note("Edges are traced on every frame from the picture itself (hair, shoulders, hands) and people never bleed into the background blur.")
    }

    private fun pageLook(f: Form) {
        val s = settings
        if (caps?.toneCurve == true) f.section("Picture profile", "Flat keeps more highlight and shadow detail for grading.") {
            segmented(listOf("Standard", "Flat"), if (s.flatProfile) 1 else 0) {
                apply(settings.copy(flatProfile = it == 1, lut = if (it == 1 && settings.lut == "None") "Flat → Rec.709" else settings.lut)); sheet.refresh()
            }
        }
        f.section("Style") {
            for (n in lutNames()) check(if (n == "None") "Standard" else n, n == s.lut) { apply(settings.copy(lut = n)); sheet.refresh() }
        }
        f.section(null) {
            action("Import .cube LUT…") { importLut() }
            slider("Strength", 0, 100, (s.lutAmount * 100).roundToInt(), { "$it %" }) { apply(settings.copy(lutAmount = it / 100f)) }
            switch("Show on Screen", s.lutOnMonitor) { apply(settings.copy(lutOnMonitor = it)) }
            switch("Bake into Recording", s.bakeLut) { apply(settings.copy(bakeLut = it)) }
        }
    }

    private fun pageFilm(f: Form) {
        val s = settings
        f.section("Preset") {
            for (n in FilmPresets.names) check(n, n == s.filmPreset) { apply(FilmPresets.apply(settings, n)); sheet.refresh() }
        }
        f.section("Adjust", "Film effects are applied after face blur, so they can never reveal a face.") {
            fun film(label: String, v: Float, set: (Settings, Float) -> Settings) =
                slider(label, 0, 100, (v * 100).roundToInt(), { "$it" }) { apply(set(settings, it / 100f).copy(filmPreset = "Custom")) }
            film("Grain", s.grain) { x, v -> x.copy(grain = v) }
            film("Grain Size", s.grainSize) { x, v -> x.copy(grainSize = v) }
            film("Halation", s.halation) { x, v -> x.copy(halation = v) }
            film("Bloom", s.bloom) { x, v -> x.copy(bloom = v) }
            film("Chromatic Aberration", s.aberration) { x, v -> x.copy(aberration = v) }
            film("Light Leaks", s.leaks) { x, v -> x.copy(leaks = v) }
            film("Film Burn", s.burn) { x, v -> x.copy(burn = v) }
            film("Vignette", s.vignette) { x, v -> x.copy(vignette = v) }
            switch("Bake into Recording", s.bakeFilm) { apply(settings.copy(bakeFilm = it)) }
        }
    }

    private fun pageAudio(f: Form) {
        val s = settings
        f.section(null) { switch("Record Audio", s.audio) { apply(settings.copy(audio = it)) } }
        f.section("Noise reduction", "Voice removes steady background noise most strongly; Natural keeps the room sound.") {
            segmented(listOf("Natural", "Standard", "Voice"), s.noiseReduction.coerceIn(0, 2)) { apply(settings.copy(noiseReduction = it)) }
            switch("Wind / Rumble Filter", s.windFilter) { apply(settings.copy(windFilter = it)) }
        }
    }

    private fun pageMonitoring(f: Form) {
        val s = settings
        f.section("Exposure") {
            switch("Zebras", s.zebra) { apply(settings.copy(zebra = it)) }
            slider("Zebra Level", 70, 100, (s.zebraLevel * 100).roundToInt(), { "$it %" }) { apply(settings.copy(zebraLevel = it / 100f)) }
            switch("False Color", s.falseColor) { apply(settings.copy(falseColor = it)) }
            switch("Histogram", s.histogram) { apply(settings.copy(histogram = it)) }
        }
        f.section("Focus") {
            switch("Focus Peaking", s.peaking) { apply(settings.copy(peaking = it)) }
            segmented(listOf("Lime", "Red", "White", "Blue"), s.peakColor, "Color") { apply(settings.copy(peakColor = it)) }
            slider("Sensitivity", 0, 100, (s.peakSensitivity * 100).roundToInt(), { "$it" }) { apply(settings.copy(peakSensitivity = it / 100f)) }
        }
        val guides = listOf("Off", "2.39:1", "1.85:1", "4:5", "9:16", "1:1")
        f.section("Framing") {
            switch("Grid", s.grid) { apply(settings.copy(grid = it)) }
            switch("Level", s.level) { apply(settings.copy(level = it)) }
            segmented(guides, guides.indexOf(s.guide).coerceAtLeast(0), "Frame guide") { apply(settings.copy(guide = guides[it])) }
        }
    }

    private fun pageExposure(f: Form) {
        val s = settings
        f.section(null, "Keeps the shutter (e.g. 180° for natural motion blur) and adjusts ISO to the scene.") {
            switch("Shutter Priority", s.shutterPriority) { apply(settings.copy(shutterPriority = it, autoExposure = if (it) false else settings.autoExposure)) }
        }
        f.section("Shutter display") {
            segmented(listOf("Angle", "Speed"), if (s.shutterAngle) 0 else 1) { apply(settings.copy(shutterAngle = it == 0)) }
        }
        f.section("Locks", "Press and hold on the picture to lock focus and exposure there.") {
            switch("Exposure Lock", s.aeLock) { apply(settings.copy(aeLock = it)) }
            switch("White Balance Lock", s.awbLock) { apply(settings.copy(awbLock = it, autoWb = true)) }
        }
    }

    private fun pageCamera(f: Form) {
        val s = settings
        val c = caps
        if (cameras.size > 1) f.section("Lens") {
            for (cam in cameras) check(cam.label, cam.id == c?.id) { apply(settings.copy(cameraId = cam.id, zoom = 1f), restart = true); sheet.refresh() }
        }
        val orients = listOf("Auto", "Landscape", "Portrait")
        f.section("Video orientation", "Follow phone records the way you hold it, like any phone camera.") {
            segmented(listOf("Follow phone", "Horizontal", "Vertical"), orients.indexOf(s.orientation).coerceAtLeast(0)) {
                if (recording) flash("Stop recording to change orientation") else apply(settings.copy(orientation = orients[it]))
            }
        }
        f.section("Viewfinder", if (s.fullView) "The picture fills the screen behind the controls. The sides of the recording run past the screen edges; frame guides still show the whole recording." else "The whole recording is shown, between the top bar and the shutter.") {
            segmented(listOf("Framed", "Full screen"), if (s.fullView) 1 else 0) { apply(settings.copy(fullView = it == 1)); sheet.refresh() }
        }
        f.section("Controls", "Volume buttons take the picture or start and stop recording. Swipe sideways on the picture to change mode, up for camera settings.") {
            switch("Mirror Front Camera", s.mirrorFront) { apply(settings.copy(mirrorFront = it)) }
            switch("Camera Sounds", s.sounds) { apply(settings.copy(sounds = it)) }
        }
    }

    private fun pagePower(f: Form) {
        val s = settings
        f.section("Mode", when (s.powerMode) {
            PowerMode.MAX -> "Face detection on every frame and all CPU cores while recording. Warmest; still steps down if the phone gets hot."
            PowerMode.SAVER -> "Longest takes: sparser detection (frames in between are interpolated exactly), lighter preview, efficient cores only."
            else -> "Detection paced by motion: every frame for fast faces, less often for calm or empty scenes. Mid cores only."
        }) { segmented(listOf("Max", "Balanced", "Saver"), s.powerMode) { apply(settings.copy(powerMode = it)); sheet.refresh() } }
        f.section("Screen", "Privacy never depends on the power mode: every frame waits for its faces.") {
            switch("Dim While Recording", s.dimWhileRecording) { apply(settings.copy(dimWhileRecording = it)) }
            switch("Auto Standby (3 min idle)", s.autoStandby) { apply(settings.copy(autoStandby = it)) }
        }
    }

    private fun pageStorage(f: Form) {
        val s = settings
        f.section(null, "Private clips appear only in Veil's library; export any clip to the phone gallery from there.") {
            switch("Private Library", s.privateGallery) { apply(settings.copy(privateGallery = it)) }
            nav("Open Library", "${MediaStorage.list(this@MainActivity).size}", Glyph.LIBRARY) {
                startActivity(Intent(this@MainActivity, com.veil.cam.ui.GalleryActivity::class.java))
            }
        }
    }

    // ---- helpers ------------------------------------------------------------------------------------------------
    private fun flash(msg: String) = toast.show(msg)

    private var imageSize = 0 to 0
    private var lastDetectFps = 0f

    /**
     * Shutter priority: keep the chosen shutter (e.g. 180°) and steer ISO so the
     * average picture level sits near mid-grey, in 1/3-stop steps with damping.
     */
    private var lastIsoStep = 0L
    private fun shutterPriority(luma: IntArray) {
        val s = settings
        val c = caps ?: return
        if (!s.shutterPriority || s.autoExposure || !c.manualSensor) return
        val now = System.currentTimeMillis()
        if (now - lastIsoStep < 350) return
        var sum = 0.0; var n = 0L
        for (i in luma.indices) { sum += luma[i] * (i + 0.5) / luma.size; n += luma[i] }
        if (n == 0L) return
        val mean = (sum / n).coerceIn(0.01, 1.0)
        val stops = kotlin.math.ln(0.42 / mean) / kotlin.math.ln(2.0)
        if (abs(stops) < 0.2) return
        val iso = isoStops(c)
        val cur = iso.indexOfFirst { it >= s.iso }.coerceAtLeast(0)
        val next = (cur + if (stops > 0) 1 else -1).coerceIn(0, iso.size - 1)
        if (next != cur) { lastIsoStep = now; apply(s.copy(iso = iso[next])) }
    }

    // ---- Renderer.Listener (GL thread -> main) -------------------------------------------------------------------
    override fun onDisplayTransform(imgW: Int, imgH: Int, content: RectF, viewToImg: FloatArray) {
        main.post { imageSize = imgW to imgH; overlay.content = content; overlay.setTransform(viewToImg) }
    }

    override fun onFaces(faces: List<Geom>) {
        main.post {
            overlay.setFaces(faces)
            faceArea = overlay.facesInFrame().maxOfOrNull { it[2] * it[3] } ?: 0f
        }
    }

    override fun onHistogram(luma: IntArray, r: IntArray, g: IntArray, b: IntArray) {
        main.post {
            overlay.setHistogram(luma, r, g, b)
            if (settings.shutterPriority) shutterPriority(luma)
            updateScene(luma)
        }
    }

    /** Scene recognition: a few times a second from exposure, histogram, faces and focus. */
    private fun updateScene(luma: IntArray) {
        val now = SystemClock.uptimeMillis()
        if (!settings.sceneAuto || now - lastScene < 300) { if (!settings.sceneAuto) overlay.sceneBadge = null; return }
        lastScene = now
        val ro = readout ?: return
        scene = sceneAnalyzer.update(ro.iso, ro.exposureNs, luma, faceArea, ro.focusDiopters)
        val adv = SceneAnalyzer.advice(scene)
        overlay.sceneBadge = when {
            scene == Scene.AUTO || recording -> null
            settings.photoMode && settings.burstMerge -> "${scene.label.uppercase()} · ${adv.mergeFrames}×${if (adv.hdrEv < 0) " HDR" else ""}"
            else -> scene.label.uppercase()
        }
    }

    override fun onStats(cameraFps: Float, detectFps: Float, detectMs: Float, delayFrames: Int) { lastDetectFps = detectFps }

    override fun onFirstFrame() {
        main.post { if (snapshot.visibility == View.VISIBLE) { main.removeCallbacks(hideSnapshot); main.postDelayed(hideSnapshot, 140) } }
    }

    override fun onRecording(active: Boolean, elapsedNs: Long, uri: Uri?, error: String?) {
        main.post {
            if (active) {
                if (!recording) {
                    recording = true; recPaused = false
                    recOutputRot = outputRot(); overlay.frameRotation = recOutputRot
                    main.removeCallbacks(metaTick); main.postDelayed(metaTick, 300)
                    lastTouch = SystemClock.uptimeMillis()
                    pushBudget()
                    refreshRecordUi()
                }
                val sec = elapsedNs / 1_000_000_000L
                timer.text = "%02d:%02d:%02d".format(sec / 3600, sec / 60 % 60, sec % 60)
            } else {
                val was = recording
                recording = false
                recPaused = false
                setDim(false)
                if (was) pushBudget()
                applyRotations()
                refreshRecordUi()
                timer.text = "00:00:00"
                if (uri != null) { lastUri = uri; loadThumb(pop = true) }
                if (error != null) flash(error)
            }
        }
    }

    override fun onPhoto(uri: Uri?, error: String?) {
        main.post {
            if (hdrPending) { hdrPending = false; camera.update(settings) }
            if (uri != null) loadThumb(pop = true) else flash("Photo failed: $error")
        }
    }

    override fun onBurstMerged(frames: Int) { main.post { if (hdrPending) { hdrPending = false; camera.update(settings) } } }

    override fun onFocusTrack(x: Float, y: Float) { main.post { overlay.setTracked(x, y); lastTapImg = floatArrayOf(x, y) } }

    override fun onDetectorReady(ready: Boolean) { main.post { detectorReady = ready; overlay.startingHint = settings.blurOn && !ready } }

    companion object {
        private const val BAR_H = 40f // every top-bar control: one height
        private const val REQ_LUT = 11
        private const val REQ_MASK = 12
    }
}

object BuildConfigLite { const val VERSION = "1.9.0" }
