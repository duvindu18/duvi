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
import com.veil.cam.face.PersonSegmenter
import com.veil.cam.gl.Renderer
import com.veil.cam.media.MediaStorage
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
        if (settings.depthMode && settings.depth <= 0f) settings = settings.copy(depth = settings.cineDepth)
        engine = FaceEngine(applicationContext)
        engine.onError = { msg -> main.post { flash(msg) } }
        engine.configure(settings)
        segmenter = PersonSegmenter(applicationContext).also { it.onError = { msg -> main.post { flash(msg) } } }
        renderer = Renderer(applicationContext, engine, segmenter).also { it.listener = this }
        renderer.update(settings)
        thermal = ThermalMonitor(this) { level, status -> onThermal(level, status) }
        camera = CameraController(applicationContext)
        camera.onReadout = { r -> main.post { readout = r; controller.refresh(); refreshTop() } }
        camera.onError = { msg -> main.post { flash(msg) } }
        buildUi()
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
        loadThumb(pop = false)
        main.removeCallbacks(idleCheck)
        main.postDelayed(idleCheck, 2_000)
    }

    override fun onPause() {
        resumed = false
        main.removeCallbacks(idleCheck)
        thermal?.stop()
        setDim(false)
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
        sound.release()
        super.onDestroy()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
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
        root.addView(surfaceView, FrameLayout.LayoutParams(-1, -1))
        surfaceView.addOnLayoutChangeListener { _, l, t, r, b, ol, ot, orr, ob -> if (r - l != orr - ol || b - t != ob - ot) applyPreviewSize() }
        snapshot = ImageView(this).apply { scaleType = ImageView.ScaleType.FIT_XY; visibility = View.GONE }
        root.addView(snapshot, FrameLayout.LayoutParams(-1, -1))
        blink = View(this).apply { setBackgroundColor(Color.BLACK); alpha = 0f }
        root.addView(blink, FrameLayout.LayoutParams(-1, -1))
        overlay = OverlayView(this).apply { settings = this@MainActivity.settings }
        overlay.onTap = { _, _, ix, iy -> tapFocus(ix, iy, lock = false) }
        overlay.onLongPress = { _, _, ix, iy -> tapFocus(ix, iy, lock = true) }
        overlay.onDoubleTap = { camera.resetFocus(); unlockAe() }
        overlay.onZoom = { f -> setZoom(settings.zoom * f); zoom.peek() }
        overlay.onPinch = { zoom.peek() }
        overlay.onSwipeMode = { dir -> if (!recording && !trayOpen) modes.step(dir) }
        overlay.onSwipeTray = { up -> if (up) openTray() else closeTray() }
        overlay.onExposure = { d -> dragExposure(d) }
        root.addView(overlay, FrameLayout.LayoutParams(-1, -1))

        ui = FrameLayout(this).apply { clipToPadding = false; clipChildren = false }

        // ---- top bar: torch, face blur | chevron / timer | heat, depth, format
        topBar = FrameLayout(this)
        val left = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        torchBtn = GlassButton(this, Glyph.BOLT, "Torch", 36f).apply { setOnClickListener { toggleTorch() } }
        facesBtn = GlassButton(this, Glyph.FACE, "Face blur", 36f).apply {
            setOnClickListener { toggleBlur() }
            setOnLongClickListener { thud(); controller.open("FACES"); true }
        }
        left.addView(torchBtn, LinearLayout.LayoutParams(-2, -2).apply { rightMargin = dp(10f) })
        left.addView(facesBtn)
        topBar.addView(left, FrameLayout.LayoutParams(-2, -2, Gravity.START or Gravity.CENTER_VERTICAL))
        chevron = GlassButton(this, Glyph.CHEVRON_UP, "Camera settings", 32f).apply { setOnClickListener { if (trayOpen) closeTray() else openTray() } }
        topBar.addView(chevron, FrameLayout.LayoutParams(-2, -2, Gravity.CENTER))
        timer = TimerPill(this).apply { visibility = View.GONE }
        topBar.addView(timer, FrameLayout.LayoutParams(-2, -2, Gravity.CENTER))
        val right = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        heatBtn = GlassButton(this, Glyph.THERMO, "Phone temperature", 32f).apply { glyphColor = Theme.ORANGE; visibility = View.GONE; setOnClickListener { flash(heatText()) } }
        depthBtn = GlassButton(this, null, "Depth", 32f, "ƒ2.8").apply { setOnClickListener { tick(); controller.open("DEPTH") } }
        format = FormatPill(this).apply { onLeft = { cycleResolution() }; onRight = { cycleFps() } }
        right.addView(heatBtn, LinearLayout.LayoutParams(-2, -2).apply { rightMargin = dp(8f) })
        right.addView(depthBtn, LinearLayout.LayoutParams(-2, -2).apply { rightMargin = dp(8f) })
        right.addView(format)
        topBar.addView(right, FrameLayout.LayoutParams(-2, -2, Gravity.END or Gravity.CENTER_VERTICAL))
        ui.addView(topBar, FrameLayout.LayoutParams(-1, dp(44f), Gravity.TOP).apply { topMargin = dp(4f) })
        toast = HudToast(this)
        ui.addView(toast, FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply { topMargin = dp(58f) })

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
        zoomRow.addView(controlBtn, FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM or Gravity.START).apply { leftMargin = dp(18f); bottomMargin = dp(3f) })
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
        bottom.addView(modeSlot, LinearLayout.LayoutParams(-1, dp(76f)))
        val shutterRow = FrameLayout(this)
        thumb = ThumbView(this).apply { setOnClickListener { openLatest() } }
        pauseBtn = GlassButton(this, Glyph.PAUSE, "Pause recording", 48f).apply { visibility = View.GONE; setOnClickListener { togglePause() } }
        shutter = ShutterButton(this).apply { setOnClickListener { onShutter() } }
        flipBtn = GlassButton(this, Glyph.FLIP, "Switch camera", 48f).apply { setOnClickListener { switchLens() } }
        snapBtn = SnapButton(this).apply { visibility = View.GONE; setOnClickListener { photo() } }
        shutterRow.addView(thumb, FrameLayout.LayoutParams(-2, -2, Gravity.START or Gravity.CENTER_VERTICAL).apply { leftMargin = dp(28f) })
        shutterRow.addView(pauseBtn, FrameLayout.LayoutParams(-2, -2, Gravity.START or Gravity.CENTER_VERTICAL).apply { leftMargin = dp(27f) })
        shutterRow.addView(shutter, FrameLayout.LayoutParams(-2, -2, Gravity.CENTER))
        shutterRow.addView(flipBtn, FrameLayout.LayoutParams(-2, -2, Gravity.END or Gravity.CENTER_VERTICAL).apply { rightMargin = dp(27f) })
        shutterRow.addView(snapBtn, FrameLayout.LayoutParams(-2, -2, Gravity.END or Gravity.CENTER_VERTICAL).apply { rightMargin = dp(27f) })
        bottom.addView(shutterRow, LinearLayout.LayoutParams(-1, dp(100f)))
        ui.addView(bottom, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM))
        root.addView(ui, FrameLayout.LayoutParams(-1, -1))

        sheet = SheetView(this).apply { onClosed = { refreshUi() } }
        root.addView(sheet, FrameLayout.LayoutParams(-1, -1))

        root.setOnApplyWindowInsetsListener { _, insets ->
            val r = safeInsets(insets)
            if (r != safe) { safe = r; ui.setPadding(r.left, r.top, r.right, r.bottom); layoutHud() }
            insets
        }
        root.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> layoutHud() }
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

    /** Free picture area for the histogram and meters (between the top bar and the zoom lenses). */
    private fun layoutHud() {
        root.post {
            val top = ui.paddingTop + topBar.bottom + dp(4f)
            val bottomY = bottom.top + zoomRow.top + zoomRow.height - dp(52f)
            overlay.hud = RectF(0f, top.toFloat(), root.width.toFloat(), bottomY.toFloat())
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
        out += TrayItem("tools", Glyph.PEAK, "Assist", s.zebra || s.peaking || s.falseColor || s.grid,
            listOf("Zebras", "Peaking", "False color", "Grid", "Level", "Histogram"),
            listOf(s.zebra, s.peaking, s.falseColor, s.grid, s.level, s.histogram), multi = true)
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

    /** Depth: simulated aperture (background blur strength 0..1). */
    private val APERTURES = listOf(0.12f to "ƒ16", 0.24f to "ƒ11", 0.36f to "ƒ8", 0.48f to "ƒ5.6", 0.6f to "ƒ4", 0.72f to "ƒ2.8", 0.86f to "ƒ2", 1f to "ƒ1.4")
    private val BOKEH_SHAPES = listOf("Circle", "Blades", "Anamorphic", "Swirl")
    private fun apertureLabel(d: Float) = if (d <= 0f) "ƒ" else APERTURES.minByOrNull { abs(it.first - d) }!!.second

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
                "DEPTH" -> APERTURES.indexOfFirst { it.first >= s.cineDepth - 0.001f }.coerceAtLeast(0)
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

    // ---- record / photo -------------------------------------------------------------------------------
    private fun toggleRecording() {
        if (recording) {
            renderer.stopRecording()
            if (settings.sounds) sound.play(MediaActionSound.STOP_VIDEO_RECORDING)
        } else {
            if (caps == null) return
            if (settings.blurOn && !detectorReady) { flash("Face detection is still starting"); return }
            closeTray(); controller.dismiss()
            renderer.startRecording()
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
        if (settings.blurOn && !detectorReady) { flash("Face detection is still starting"); return }
        if (settings.sounds) sound.play(MediaActionSound.SHUTTER_CLICK)
        // Shutter blink.
        blink.animate().cancel()
        blink.alpha = 0.85f
        blink.animate().alpha(0f).setDuration(180).start()
        renderer.takePhoto()
    }

    /** Newest capture for the thumbnail (the private gallery). */
    private fun loadThumb(pop: Boolean) {
        Thread {
            val f = MediaStorage.list(this).firstOrNull()
            val b = f?.let { file ->
                runCatching {
                    if (file.extension == "mp4") MediaMetadataRetriever().use { r ->
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
            startActivity(Intent(this, if (f.extension == "mp4") com.veil.cam.ui.PlayerActivity::class.java else com.veil.cam.ui.PhotoActivity::class.java)
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

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        lastTouch = SystemClock.uptimeMillis()
        if (dimmed) setDim(false)
        val shutterKey = keyCode == KeyEvent.KEYCODE_VOLUME_DOWN || keyCode == KeyEvent.KEYCODE_VOLUME_UP || keyCode == KeyEvent.KEYCODE_CAMERA
        if (sleeping && shutterKey) { wake(); return true }
        if (shutterKey) {
            if (event.repeatCount == 0 && !sheet.isOpen) onShutter()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        when {
            sheet.isOpen -> if (!sheet.pop()) sheet.close()
            controller.isOpen -> controller.dismiss()
            trayOpen -> closeTray()
            else -> @Suppress("DEPRECATION") super.onBackPressed()
        }
    }

    // ---- settings sheet ---------------------------------------------------------------------------------------
    private fun batteryLevel(): Int {
        val bm = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        return bm?.let { it.getIntExtra(BatteryManager.EXTRA_LEVEL, 0) * 100 / it.getIntExtra(BatteryManager.EXTRA_SCALE, 100).coerceAtLeast(1) } ?: 0
    }

    private fun minutesLeft(): Long {
        val stat = runCatching { StatFs(Environment.getExternalStorageDirectory().path) }.getOrNull()
        return stat?.let { it.availableBytes * 8 / settings.bitrate().coerceAtLeast(1) / 60 } ?: 0
    }

    private fun openSettings() {
        sheet.open("Settings") { f -> pageRoot(f) }
    }

    private fun maxFacesLabel() = if (!settings.blurOn) "Off" else when (settings.maxFaces) { 1 -> "1 face"; 2 -> "2 faces"; else -> "Any" }

    private fun pageRoot(f: Form) {
        val s = settings
        f.section(null) {
            info("Battery", "${batteryLevel()} %")
            info("Recording time left", "${minutesLeft()} min")
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
        f.section("Tools") {
            nav("Monitoring", null, Glyph.PEAK) { sheet.push("Monitoring") { pageMonitoring(it) } }
            nav("Exposure", if (s.shutterPriority) "Shutter priority" else if (s.autoExposure) "Auto" else "Manual", Glyph.SUN) { sheet.push("Exposure") { pageExposure(it) } }
            nav("Camera", if (s.orientation == "Auto") "Follow phone" else s.orientation, Glyph.GEAR) { sheet.push("Camera") { pageCamera(it) } }
        }
        f.section("Device") {
            nav("Power & Heat", PowerMode.names[s.powerMode], Glyph.POWER) { sheet.push("Power & Heat") { pagePower(it) } }
            nav("Storage", if (s.privateGallery) "Private" else "Phone gallery", Glyph.LIBRARY) { sheet.push("Storage") { pageStorage(it) } }
        }
        f.section("About", "Veil Cam ${BuildConfigLite.VERSION}. Face detection runs on the phone; nothing is uploaded. Face models: InsightFace SCRFD (non-commercial research licence).") {
            info("Version", BuildConfigLite.VERSION)
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
            segmented(listOf("Low", "Standard", "High"), s.bitrateLevel, "Quality") { if (!recording) { apply(settings.copy(bitrateLevel = it)); sheet.refresh() } }
        }
        f.section("Stabilization", "Enhanced adds digital stabilization (a slight crop).") {
            if (c?.ois == true) switch("Optical (OIS)", s.ois) { apply(settings.copy(ois = it)) }
            if (c?.eis == true || c?.previewStabilization == true) switch("Enhanced", s.eis) { apply(settings.copy(eis = it)) }
        }
        f.section("Monitor", "Off: the screen shows exactly what is recorded, a few frames behind. On: the newest frame, with the blur following faces by prediction.") {
            switch("Low-Latency Preview", s.lowLatencyPreview) { apply(settings.copy(lowLatencyPreview = it)) }
        }
    }

    private fun pageDepth(f: Form) {
        val s = settings
        f.section(null, "Cinematic and Portrait keep people sharp and give the background a lens blur. Tap ƒ on the camera screen to change it while you frame.") {
            slider("Aperture", 0, APERTURES.size - 1, APERTURES.indexOfFirst { it.first >= s.cineDepth - 0.001f }.coerceAtLeast(0), { APERTURES[it].second }) {
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

    override fun onFaces(faces: List<Geom>) { main.post { overlay.setFaces(faces) } }

    override fun onHistogram(luma: IntArray, r: IntArray, g: IntArray, b: IntArray) { main.post { overlay.setHistogram(luma, r, g, b); shutterPriority(luma) } }

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

    override fun onPhoto(uri: Uri?, error: String?) { main.post { if (uri != null) loadThumb(pop = true) else flash("Photo failed: $error") } }

    override fun onDetectorReady(ready: Boolean) { main.post { detectorReady = ready; overlay.startingHint = settings.blurOn && !ready } }

    companion object {
        private const val REQ_LUT = 11
        private const val REQ_MASK = 12
    }
}

object BuildConfigLite { const val VERSION = "1.5.0" }
