package com.veil.cam

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.RectF
import android.graphics.drawable.GradientDrawable
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.hardware.display.DisplayManager
import android.media.MediaActionSound
import android.net.Uri
import android.os.BatteryManager
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.StatFs
import android.util.Size
import android.view.Gravity
import android.view.ViewGroup
import android.view.KeyEvent
import android.view.Surface
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.veil.cam.camera.CameraCaps
import com.veil.cam.camera.CameraController
import com.veil.cam.camera.CameraReadout
import com.veil.cam.core.CubeParser
import com.veil.cam.core.Geom
import com.veil.cam.core.Looks
import com.veil.cam.core.Lut3D
import com.veil.cam.face.FaceEngine
import com.veil.cam.gl.Renderer
import com.veil.cam.record.AudioCapture
import com.veil.cam.record.Recorder
import com.veil.cam.ui.CircleButton
import com.veil.cam.ui.DialView
import com.veil.cam.ui.OverlayView
import com.veil.cam.ui.ParamChip
import com.veil.cam.ui.RecordButton
import com.veil.cam.ui.RoundToggle
import com.veil.cam.ui.Rows
import com.veil.cam.ui.Theme
import java.io.File
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.roundToInt

class MainActivity : Activity(), Renderer.Listener {
    private val main = Handler(Looper.getMainLooper())
    private lateinit var settings: Settings
    private lateinit var engine: FaceEngine
    private lateinit var renderer: Renderer
    private lateinit var camera: CameraController
    private var audio: AudioCapture? = null
    private var cameras: List<CameraCaps> = emptyList()
    private var caps: CameraCaps? = null
    private var recording = false
    private var lastUri: Uri? = null
    private var readout: CameraReadout? = null
    private val sound = MediaActionSound()
    private var detectorReady = false
    private var resumed = false
    private var audioBoot = true

    // Views
    private lateinit var root: FrameLayout
    private lateinit var surfaceView: SurfaceView
    private lateinit var overlay: OverlayView
    private lateinit var topBar: LinearLayout
    private lateinit var timecode: TextView
    private lateinit var status: TextView
    private lateinit var recButton: RecordButton
    private lateinit var panel: LinearLayout
    private lateinit var panelTitle: TextView
    private lateinit var panelAuto: TextView
    private lateinit var dial: DialView
    private lateinit var sheet: ScrollView
    private lateinit var toast: TextView
    private lateinit var zoomColumn: LinearLayout
    private val chips = LinkedHashMap<String, ParamChip>()
    private val toggles = HashMap<String, RoundToggle>()
    private var activeParam: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.attributes = window.attributes.apply { layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES }
        settings = Settings.load(this)
        requestedOrientation = orientationRequest()
        engine = FaceEngine(applicationContext)
        engine.onError = { msg -> main.post { flash(msg) } }
        engine.configure(settings)
        renderer = Renderer(applicationContext, engine).also { it.listener = this }
        renderer.update(settings)
        camera = CameraController(applicationContext)
        camera.onReadout = { r -> main.post { readout = r; refreshChips() } }
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
        startCamera()
        startAudio()
        registerSensors()
    }

    override fun onPause() {
        resumed = false
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
        renderer.setDisplayRotation(displayDegrees())
        renderer.configureCamera(size, c.sensorOrientation, c.front)
        buildZoomButtons()
        refreshChips()
        if (audio != null && audioBoot != c.bootTimeTimestamps) startAudio() // audio must share the camera's clock
    }

    override fun onCameraSurface(surface: Surface, size: Size) {
        val c = caps ?: return
        main.post { if (resumed) camera.open(c, surface, size, settings) }
    }

    private fun startAudio() {
        if (!settings.audio || checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return
        val boot = caps?.bootTimeTimestamps ?: true
        if (audio != null && audioBoot == boot) return
        audio?.stop()
        audioBoot = boot
        val a = AudioCapture(bootTimeClock = boot)
        if (a.start()) {
            audio = a
            renderer.setAudio(a)
            meterLoop()
        }
    }

    private fun meterLoop() {
        val a = audio ?: return
        overlay.levels = a.levels
        main.postDelayed({ meterLoop() }, 60)
    }

    private fun displayDegrees(): Int = when (display?.rotation ?: Surface.ROTATION_90) {
        Surface.ROTATION_0 -> 0
        Surface.ROTATION_90 -> 90
        Surface.ROTATION_180 -> 180
        else -> 270
    }

    private val displayListener = object : DisplayManager.DisplayListener {
        override fun onDisplayAdded(id: Int) {}
        override fun onDisplayRemoved(id: Int) {}
        override fun onDisplayChanged(id: Int) { renderer.setDisplayRotation(displayDegrees()) }
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
        if (s.audio != old.audio) { if (s.audio) startAudio() else { audio?.stop(); audio = null; renderer.setAudio(null) } }
        if (s.blurOn && !old.blurOn) overlay.startingHint = !detectorReady
        if (!s.blurOn) overlay.startingHint = false
        if (restart) {
            // Start the new camera only once the old one has stopped using its surface.
            camera.close { main.post { if (resumed) startCamera() } }
        } else camera.update(s)
        refreshChips()
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
                    val safe = lut.name.replace(Regex("[^A-Za-z0-9 _.-]"), "_").take(40).ifBlank { "Imported" }
                    customLutFile(safe).apply { parentFile?.mkdirs(); writeText(text) }
                    main.post { apply(settings.copy(lut = safe)); flash("LUT “$safe” imported (${lut.size}³)"); if (sheet.visibility == View.VISIBLE) openSheet() }
                } catch (e: Exception) {
                    main.post { flash("Not a valid 3D .cube LUT: ${e.message}") }
                }
            }.start()
            REQ_MASK -> Thread {
                try {
                    val f = File(filesDir, "mask.png")
                    contentResolver.openInputStream(uri)!!.use { inp -> f.outputStream().use { inp.copyTo(it) } }
                    main.post { apply(settings.copy(maskPath = f.absolutePath, style = BlurStyle.MASK)); flash("Mask image set") }
                } catch (e: Exception) {
                    main.post { flash("Cannot read that image") }
                }
            }.start()
        }
    }

    // ---- UI construction -----------------------------------------------------------------------------
    private fun dp(v: Float) = Theme.dpi(this, v)

    private var leftRail: View? = null
    private var rightRail: View? = null
    private var controls: FrameLayout? = null
    private var portraitLayout = false
    private var safe = android.graphics.Rect()

    private fun buildUi() {
        root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        surfaceView = SurfaceView(this)
        surfaceView.holder.addCallback(object : SurfaceHolder.Callback {
            override fun surfaceCreated(h: SurfaceHolder) {}
            override fun surfaceChanged(h: SurfaceHolder, f: Int, w: Int, hgt: Int) { renderer.setPreview(h.surface, w, hgt) }
            override fun surfaceDestroyed(h: SurfaceHolder) { renderer.setPreview(null, 0, 0) }
        })
        root.addView(surfaceView, FrameLayout.LayoutParams(-1, -1))
        overlay = OverlayView(this).apply { settings = this@MainActivity.settings }
        overlay.onTap = { _, _, ix, iy -> tapFocus(ix, iy) }
        overlay.onDoubleTap = { camera.resetFocus(); flash("Continuous autofocus") }
        overlay.onZoom = { f -> setZoom(settings.zoom * f) }
        root.addView(overlay, FrameLayout.LayoutParams(-1, -1))

        // Views that survive orientation changes (their parents are rebuilt).
        topBar = LinearLayout(this)
        for ((key, cap) in listOf("RES" to "RES", "FPS" to "FPS", "CODEC" to "CODEC", "ISO" to "ISO", "SHUTTER" to "SHUTTER",
            "WB" to "WB", "TINT" to "TINT", "FOCUS" to "FOCUS", "EV" to "EV", "BLUR" to "BLUR", "LUT" to "LUT")) {
            val chip = ParamChip(this, cap)
            chip.setOnClickListener { onChip(key) }
            chips[key] = chip
        }
        status = TextView(this).apply { setTextColor(Theme.DIM); textSize = 11f; typeface = Theme.mono; gravity = Gravity.END }
        timecode = TextView(this).apply { setTextColor(Theme.TEXT); textSize = 20f; typeface = Theme.mono; text = "00:00:00:00" }
        recButton = RecordButton(this).apply { setOnClickListener { toggleRecording() } }
        zoomColumn = LinearLayout(this).apply { gravity = Gravity.CENTER }
        for ((key, label, hint) in listOf(
            Triple("blur", "BLUR", "Face blur on / off"), Triple("zebra", "Z", "Zebras"), Triple("peak", "FP", "Focus peaking"),
            Triple("false", "FC", "False colour"), Triple("grid", "#", "Grid"), Triple("ael", "AE-L", "Lock exposure"), Triple("awbl", "WB-L", "Lock white balance"),
        )) {
            val t = RoundToggle(this, label, hint)
            t.setOnClickListener { onToggle(key) }
            toggles[key] = t
        }
        panel = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(14f), dp(8f), dp(14f), dp(8f))
            background = Theme.pill(Theme.SCRIM, Theme.dp(this@MainActivity, 26f))
            visibility = View.GONE
        }
        panelTitle = TextView(this).apply { setTextColor(Theme.DIM); textSize = 11f; typeface = Theme.medium; letterSpacing = 0.12f; minWidth = dp(64f) }
        panel.addView(panelTitle)
        panelAuto = Rows.button(this, "AUTO") { onPanelAuto() }
        panel.addView(panelAuto, LinearLayout.LayoutParams(-2, dp(36f)).apply { rightMargin = dp(10f) })
        dial = DialView(this)
        dial.onChange = { i -> onDial(i) }
        panel.addView(dial, LinearLayout.LayoutParams(0, -2, 1f))
        sheet = ScrollView(this).apply {
            setBackgroundColor(Theme.SURFACE)
            visibility = View.GONE
            isVerticalScrollBarEnabled = false
        }
        toast = TextView(this).apply {
            setTextColor(Theme.TEXT); textSize = 13f; typeface = Theme.medium
            background = Theme.pill(Theme.SURFACE3, Theme.dp(this@MainActivity, 18f))
            setPadding(dp(16f), dp(9f), dp(16f), dp(9f)); alpha = 0f
        }

        root.setOnApplyWindowInsetsListener { _, insets ->
            val r = safeInsets(insets)
            if (r != safe) { safe = r; layoutControls() }
            insets
        }
        setContentView(root)
        layoutControls()
        refreshChips()
        refreshToggles()
    }

    /**
     * Space the controls must keep clear of: display cutout, curved / rounded
     * screen corners and edge gesture areas, plus a comfortable base margin.
     */
    private fun safeInsets(insets: WindowInsets): android.graphics.Rect {
        val cut = insets.getInsets(WindowInsets.Type.displayCutout())
        val gest = insets.getInsets(WindowInsets.Type.systemGestures())
        // Rounded-corner radii are only reported from Android 12; assume a typical curve before that.
        fun corner(pos: Int) =
            if (android.os.Build.VERSION.SDK_INT >= 31) insets.getRoundedCorner(pos)?.radius ?: 0 else dp(32f)
        val tl = corner(android.view.RoundedCorner.POSITION_TOP_LEFT)
        val tr = corner(android.view.RoundedCorner.POSITION_TOP_RIGHT)
        val bl = corner(android.view.RoundedCorner.POSITION_BOTTOM_LEFT)
        val br = corner(android.view.RoundedCorner.POSITION_BOTTOM_RIGHT)
        // A control at 45° into a rounded corner of radius r is clipped up to ~0.3 r from each edge;
        // curved-edge screens also distort the outermost pixels, so keep a larger base margin.
        val base = dp(20f)
        val edge = (maxOf(tl, tr, bl, br) * 0.32f).roundToInt()
        return android.graphics.Rect(
            base + maxOf(cut.left, gest.left / 2, edge),
            base / 2 + maxOf(cut.top, (maxOf(tl, tr) * 0.25f).roundToInt()),
            base + maxOf(cut.right, gest.right / 2, edge),
            base / 2 + maxOf(cut.bottom, gest.bottom / 2, (maxOf(bl, br) * 0.25f).roundToInt()),
        )
    }

    private fun detach(v: View) { (v.parent as? ViewGroup)?.removeView(v) }

    /** Build the control layout for the current orientation (keeps every control's state). */
    private fun layoutControls() {
        val portrait = resources.configuration.orientation == android.content.res.Configuration.ORIENTATION_PORTRAIT
        portraitLayout = portrait
        controls?.let { root.removeView(it) }
        for (v in listOf<View>(topBar, status, timecode, recButton, zoomColumn, panel, sheet, toast) + chips.values + toggles.values) detach(v)
        val ui = FrameLayout(this).apply { setPadding(safe.left, safe.top, safe.right, safe.bottom); clipToPadding = false }
        controls = ui

        // Status chips scroll sideways when they do not fit.
        topBar.removeAllViews()
        val chipRow = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        chips.values.forEach { chipRow.addView(it) }
        val chipScroll = android.widget.HorizontalScrollView(this).apply { isHorizontalScrollBarEnabled = false; addView(chipRow) }
        topBar.background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(0xCC000000.toInt(), 0x00000000))
        topBar.setPadding(0, 0, 0, dp(10f))

        fun circle(label: String, desc: String, size: Float = 46f, onClick: () -> Unit) =
            CircleButton(this, label, desc, size).apply { setOnClickListener { onClick() } }
        val photoB = circle("PHOTO", "Photo") { photo() }
        val playB = circle("PLAY", "Last clip") { openLast() }
        val flipB = circle("FLIP", "Switch camera") { switchLens() }
        val menuB = circle("MENU", "Settings") { if (sheet.visibility == View.VISIBLE) closeSheet() else openSheet() }
        val orientB = circle(if (portrait) "HORZ" else "VERT", "Switch between horizontal and vertical") { toggleOrientation() }

        if (!portrait) {
            topBar.orientation = LinearLayout.HORIZONTAL
            topBar.gravity = Gravity.CENTER_VERTICAL
            topBar.addView(chipScroll, LinearLayout.LayoutParams(0, -2, 1f))
            status.gravity = Gravity.END
            topBar.addView(status, LinearLayout.LayoutParams(-2, -2).apply { leftMargin = dp(10f); rightMargin = dp(12f) })
            topBar.addView(timecode)
            ui.addView(topBar, FrameLayout.LayoutParams(-1, -2, Gravity.TOP))

            val left = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL }
            toggles.values.sortedBy { listOf("blur", "zebra", "peak", "false", "grid", "ael", "awbl").indexOf(keyOf(it)) }
                .forEach { left.addView(it, LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = dp(8f) }) }
            val leftScroll = ScrollView(this).apply { isVerticalScrollBarEnabled = false; addView(left) }
            leftRail = leftScroll
            ui.addView(leftScroll, FrameLayout.LayoutParams(-2, -1, Gravity.START).apply { topMargin = dp(58f) })

            val right = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL }
            zoomColumn.orientation = LinearLayout.VERTICAL
            right.addView(zoomColumn)
            right.addView(recButton, LinearLayout.LayoutParams(-2, -2).apply { topMargin = dp(6f); bottomMargin = dp(8f) })
            val r1 = LinearLayout(this).apply { gravity = Gravity.CENTER }
            r1.addView(photoB, LinearLayout.LayoutParams(-2, -2).apply { rightMargin = dp(6f) }); r1.addView(playB)
            val r2 = LinearLayout(this).apply { gravity = Gravity.CENTER }
            r2.addView(flipB, LinearLayout.LayoutParams(-2, -2).apply { rightMargin = dp(6f) }); r2.addView(menuB)
            right.addView(r1)
            right.addView(r2, LinearLayout.LayoutParams(-2, -2).apply { topMargin = dp(6f) })
            right.addView(orientB, LinearLayout.LayoutParams(-2, -2).apply { topMargin = dp(6f) })
            val rightScroll = ScrollView(this).apply { isVerticalScrollBarEnabled = false; isFillViewport = true; addView(right) }
            rightRail = rightScroll
            ui.addView(rightScroll, FrameLayout.LayoutParams(-2, -1, Gravity.END).apply { topMargin = dp(58f) })

            // The dial sits between the two rails, never under them.
            ui.addView(panel, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM).apply { leftMargin = dp(60f); rightMargin = dp(112f) })
            ui.addView(sheet, FrameLayout.LayoutParams(dp(380f), -1, Gravity.END))
            sheet.setPadding(dp(20f), dp(10f), dp(20f), dp(20f))
            overlayHud(dp(60f), dp(58f), dp(112f), dp(84f))
        } else {
            topBar.orientation = LinearLayout.VERTICAL
            topBar.addView(chipScroll, LinearLayout.LayoutParams(-1, -2))
            val second = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL; setPadding(dp(8f), dp(2f), dp(8f), 0) }
            status.gravity = Gravity.START
            second.addView(status, LinearLayout.LayoutParams(0, -2, 1f))
            second.addView(timecode)
            topBar.addView(second)
            ui.addView(topBar, FrameLayout.LayoutParams(-1, -2, Gravity.TOP))

            val bottom = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL }
            bottom.addView(panel, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(10f) })
            val tRow = LinearLayout(this).apply { gravity = Gravity.CENTER }
            toggles.values.sortedBy { listOf("blur", "zebra", "peak", "false", "grid", "ael", "awbl").indexOf(keyOf(it)) }
                .forEach { tRow.addView(it, LinearLayout.LayoutParams(-2, -2).apply { rightMargin = dp(6f) }) }
            bottom.addView(android.widget.HorizontalScrollView(this).apply { isHorizontalScrollBarEnabled = false; addView(tRow) },
                LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = dp(10f) })
            zoomColumn.orientation = LinearLayout.HORIZONTAL
            bottom.addView(zoomColumn, LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = dp(8f) })
            val ctl = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
            ctl.addView(photoB); ctl.addView(playB, LinearLayout.LayoutParams(-2, -2).apply { leftMargin = dp(8f) })
            ctl.addView(View(this), LinearLayout.LayoutParams(0, 1, 1f))
            ctl.addView(recButton)
            ctl.addView(View(this), LinearLayout.LayoutParams(0, 1, 1f))
            ctl.addView(flipB, LinearLayout.LayoutParams(-2, -2).apply { rightMargin = dp(8f) }); ctl.addView(menuB)
            bottom.addView(ctl, LinearLayout.LayoutParams(-1, -2))
            bottom.addView(orientB, LinearLayout.LayoutParams(-2, -2).apply { topMargin = dp(8f) })
            leftRail = null; rightRail = bottom
            ui.addView(bottom, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM))
            ui.addView(sheet, FrameLayout.LayoutParams(-1, (resources.displayMetrics.heightPixels * 0.62f).toInt(), Gravity.BOTTOM))
            sheet.setPadding(dp(20f), dp(14f), dp(20f), dp(20f))
            overlayHud(0, dp(86f), 0, dp(330f))
        }
        ui.addView(toast, FrameLayout.LayoutParams(-2, -2, Gravity.CENTER_HORIZONTAL or Gravity.TOP).apply { topMargin = dp(if (portrait) 96f else 66f) })
        root.addView(ui, FrameLayout.LayoutParams(-1, -1))
        buildZoomButtons()
        activeParam?.let { k -> chips[k]?.active = true; panel.visibility = View.VISIBLE }
    }

    private fun keyOf(t: RoundToggle) = toggles.entries.first { it.value === t }.key

    /** Free picture area for the histogram / meters, in view pixels. */
    private fun overlayHud(left: Int, top: Int, right: Int, bottom: Int) {
        root.post {
            overlay.hud = RectF(
                (safe.left + left).toFloat(), (safe.top + top).toFloat(),
                (root.width - safe.right - right).toFloat(), (root.height - safe.bottom - bottom).toFloat(),
            )
        }
    }

    private fun orientationRequest(): Int = when (settings.orientation) {
        "Portrait" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
        "Auto" -> ActivityInfo.SCREEN_ORIENTATION_FULL_USER
        else -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
    }

    private fun toggleOrientation() {
        if (recording) { flash("Stop recording to change orientation"); return }
        apply(settings.copy(orientation = if (portraitLayout) "Landscape" else "Portrait"))
        requestedOrientation = orientationRequest()
        flash(if (portraitLayout) "Horizontal video" else "Vertical video")
    }

    override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
        super.onConfigurationChanged(newConfig)
        val portrait = newConfig.orientation == android.content.res.Configuration.ORIENTATION_PORTRAIT
        if (portrait != portraitLayout) {
            if (sheet.visibility == View.VISIBLE) sheet.visibility = View.GONE
            layoutControls()
            root.requestApplyInsets()
        }
        renderer.setDisplayRotation(displayDegrees())
    }

    private fun hideSystemBars() {
        window.insetsController?.let {
            it.hide(WindowInsets.Type.systemBars())
            it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    // ---- status chips & dial -----------------------------------------------------------------------------
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

    private fun focusStops(c: CameraCaps): List<Float> {
        val n = 60
        return List(n + 1) { i -> c.minFocusDiopters * i / n }
    }

    private fun shutterLabel(ns: Long): String = if (settings.shutterAngle) {
        val a = ns.toDouble() * settings.fps / 1e9 * 360
        "${a.roundToInt()}°"
    } else "1/${(1e9 / ns.coerceAtLeast(1)).roundToInt()}"

    private fun focusLabel(d: Float) = if (d <= 0.001f) "∞" else if (1 / d >= 1f) "%.1fm".format(1 / d) else "${(100 / d).roundToInt()}cm"

    private fun refreshChips() {
        val s = settings
        val c = caps
        chips["RES"]?.set(when (s.width) { 3840 -> "4K"; 1920 -> "1080p"; 1280 -> "720p"; else -> "${s.height}p" })
        chips["FPS"]?.set("${s.fps}")
        chips["CODEC"]?.set(if (s.hevc) "H.265" else "H.264")
        val ro = readout
        val manual = !s.autoExposure && c?.manualSensor == true
        chips["ISO"]?.apply { auto = !manual; set(if (manual) "${s.iso}" else ro?.iso?.takeIf { it > 0 }?.let { "A $it" } ?: "AUTO") }
        chips["SHUTTER"]?.apply { auto = !manual; set(if (manual) shutterLabel(s.shutterNs) else ro?.exposureNs?.takeIf { it > 0 }?.let { "A " + shutterLabel(it) } ?: "AUTO") }
        chips["WB"]?.apply { auto = s.autoWb; set(if (s.autoWb) (if (s.awbLock) "AWB-L" else "AWB") else "${s.kelvin}K") }
        chips["TINT"]?.apply { auto = s.autoWb; set(if (s.tint > 0) "+${s.tint}" else "${s.tint}") }
        chips["FOCUS"]?.apply { auto = s.autoFocus; set(if (s.autoFocus || c?.minFocusDiopters == 0f) "AF" else focusLabel(s.focusDiopters)) }
        chips["EV"]?.apply {
            visibility = if (manual) View.GONE else View.VISIBLE
            val step = c?.evStep ?: 0.333f
            val v = s.ev * step
            set(if (abs(v) < 0.01f) "0.0" else "%+.1f".format(v))
        }
        chips["BLUR"]?.apply {
            set(if (!s.blurOn) "OFF" else when (s.maxFaces) { 1 -> "1 FACE"; 2 -> "2 FACES"; else -> "ANY" })
            value.setTextColor(if (s.blurOn) Theme.ACCENT else Theme.REC)
        }
        chips["LUT"]?.set(if (s.lut == "None") "OFF" else s.lut.take(10))
        refreshStatus()
    }

    private fun refreshStatus() {
        val bm = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = bm?.let { it.getIntExtra(BatteryManager.EXTRA_LEVEL, 0) * 100 / it.getIntExtra(BatteryManager.EXTRA_SCALE, 100).coerceAtLeast(1) } ?: 0
        val stat = runCatching { StatFs(Environment.getExternalStorageDirectory().path) }.getOrNull()
        val mins = stat?.let { it.availableBytes * 8 / settings.bitrate().coerceAtLeast(1) / 60 } ?: 0
        val det = if (settings.blurOn) " · FACE ${"%.0f".format(lastDetectFps)}fps" else ""
        status.text = "${mins}min · BAT $level%$det"
    }

    private fun onChip(key: String) {
        when (key) {
            "RES" -> {
                val c = caps ?: return
                val opts = c.sizes.filter { it.width in listOf(3840, 1920, 1280) }.distinctBy { it.width }
                if (opts.isEmpty()) return
                val i = opts.indexOfFirst { it.width == settings.width }
                val next = opts[(i + 1) % opts.size]
                apply(settings.copy(width = next.width, height = next.height), restart = true)
                flash("${next.width}×${next.height}")
                return
            }
            "FPS" -> {
                val c = caps ?: return
                val opts = listOf(24, 25, 30, 48, 50, 60).filter { c.supportsFps(it) }
                if (opts.isEmpty()) return
                val i = opts.indexOf(settings.fps)
                val next = opts[(i + 1) % opts.size]
                if (recording) { flash("Stop recording to change this"); return }
                apply(settings.copy(fps = next, shutterNs = settings.shutterNs.coerceAtMost(1_000_000_000L / next)))
                flash("$next fps")
                return
            }
            "CODEC" -> { if (recording) flash("Stop recording to change this") else apply(settings.copy(hevc = !settings.hevc)); return }
            "BLUR" -> { openSheet(); return }
            "LUT" -> { openSheet(scrollTo = "look"); return }
        }
        if (activeParam == key) { closePanel(); return }
        activeParam = key
        chips.forEach { (k, v) -> v.active = k == key }
        panel.visibility = View.VISIBLE
        panelTitle.text = key
        configureDial(key)
    }

    private fun closePanel() {
        activeParam = null
        chips.values.forEach { it.active = false }
        panel.visibility = View.GONE
    }

    private fun configureDial(key: String) {
        val c = caps ?: return
        val s = settings
        panelAuto.visibility = View.VISIBLE
        when (key) {
            "ISO" -> {
                if (!c.manualSensor) { panelAuto.visibility = View.GONE; flash("This camera does not allow manual ISO") }
                val st = isoStops(c)
                dial.labels = st.map { "$it" }
                dial.setIndex(st.indexOfFirst { it >= (if (s.autoExposure) readout?.iso ?: s.iso else s.iso) }.coerceAtLeast(0))
                markAuto(s.autoExposure)
            }
            "SHUTTER" -> {
                if (!c.manualSensor) { panelAuto.visibility = View.GONE; flash("This camera does not allow manual shutter") }
                val st = shutterStops(c)
                dial.labels = st.map { it.label }
                val cur = if (s.autoExposure) readout?.exposureNs ?: s.shutterNs else s.shutterNs
                dial.setIndex(st.indexOfFirst { it.ns >= cur }.let { if (it < 0) st.size - 1 else it })
                markAuto(s.autoExposure)
            }
            "WB" -> {
                val st = (25..100).map { it * 100 }
                dial.labels = st.map { "${it}K" }
                dial.setIndex(st.indexOf((s.kelvin / 100) * 100).coerceAtLeast(0))
                markAuto(s.autoWb)
            }
            "TINT" -> {
                dial.labels = (-50..50).map { if (it > 0) "+$it" else "$it" }
                dial.setIndex(s.tint + 50)
                markAuto(s.autoWb)
            }
            "FOCUS" -> {
                if (c.minFocusDiopters <= 0f) { flash("This lens has fixed focus"); closePanel(); return }
                val st = focusStops(c)
                dial.labels = st.map { focusLabel(it) }
                dial.setIndex(st.indexOfFirst { it >= s.focusDiopters }.coerceAtLeast(0))
                markAuto(s.autoFocus)
            }
            "EV" -> {
                panelAuto.text = "0"
                val st = (c.evRange.lower..c.evRange.upper).toList()
                dial.labels = st.map { val v = it * c.evStep; if (abs(v) < 0.01f) "0" else "%+.1f".format(v) }
                dial.setIndex(st.indexOf(s.ev).coerceAtLeast(0))
            }
        }
    }

    private fun markAuto(auto: Boolean) {
        panelAuto.text = "AUTO"
        panelAuto.background = Theme.pill(if (auto) Theme.ACCENT else Theme.SURFACE2, Theme.dp(this, 18f))
        panelAuto.setTextColor(if (auto) Theme.ON_LIGHT else Theme.TEXT)
    }

    private fun onPanelAuto() {
        val s = settings
        when (activeParam) {
            "ISO", "SHUTTER" -> {
                if (s.autoExposure && caps?.manualSensor != true) return
                // Leaving auto keeps the exposure the camera was using.
                val ro = readout
                apply(if (s.autoExposure) s.copy(autoExposure = false, iso = ro?.iso?.takeIf { it > 0 } ?: s.iso,
                    shutterNs = ro?.exposureNs?.takeIf { it > 0 }?.coerceAtMost(1_000_000_000L / s.fps) ?: s.shutterNs) else s.copy(autoExposure = true))
            }
            "WB", "TINT" -> apply(s.copy(autoWb = !s.autoWb))
            "FOCUS" -> apply(s.copy(autoFocus = !s.autoFocus, focusDiopters = readout?.focusDiopters ?: s.focusDiopters))
            "EV" -> apply(s.copy(ev = 0))
        }
        activeParam?.let { configureDial(it) }
    }

    private fun onDial(i: Int) {
        val c = caps ?: return
        val s = settings
        when (activeParam) {
            "ISO" -> if (c.manualSensor) apply(s.copy(autoExposure = false, iso = isoStops(c)[i],
                shutterNs = if (s.autoExposure) readout?.exposureNs?.takeIf { it > 0 }?.coerceAtMost(1_000_000_000L / s.fps) ?: s.shutterNs else s.shutterNs))
            "SHUTTER" -> if (c.manualSensor) apply(s.copy(autoExposure = false, shutterNs = shutterStops(c)[i].ns,
                iso = if (s.autoExposure) readout?.iso?.takeIf { it > 0 } ?: s.iso else s.iso))
            "WB" -> apply(s.copy(autoWb = false, kelvin = (25 + i) * 100))
            "TINT" -> apply(s.copy(autoWb = false, tint = i - 50))
            "FOCUS" -> apply(s.copy(autoFocus = false, focusDiopters = focusStops(c)[i]))
            "EV" -> apply(s.copy(ev = c.evRange.lower + i))
        }
        activeParam?.let { if (it != "EV") markAuto(when (it) { "ISO", "SHUTTER" -> settings.autoExposure; "WB", "TINT" -> settings.autoWb; else -> settings.autoFocus }) }
    }

    // ---- toggles / zoom / lens ------------------------------------------------------------------------------
    private fun onToggle(key: String) {
        val s = settings
        apply(when (key) {
            "blur" -> s.copy(blurOn = !s.blurOn)
            "zebra" -> s.copy(zebra = !s.zebra)
            "peak" -> s.copy(peaking = !s.peaking)
            "false" -> s.copy(falseColor = !s.falseColor)
            "grid" -> s.copy(grid = !s.grid)
            "ael" -> s.copy(aeLock = !s.aeLock)
            "awbl" -> s.copy(awbLock = !s.awbLock, autoWb = true)
            else -> s
        })
        if (key == "blur" && !settings.blurOn) flash("Face blur is OFF: faces will be recorded")
        refreshToggles()
    }

    private fun refreshToggles() {
        val s = settings
        toggles["blur"]?.apply { on = s.blurOn; accent = Theme.ACCENT }
        toggles["zebra"]?.on = s.zebra
        toggles["peak"]?.on = s.peaking
        toggles["false"]?.on = s.falseColor
        toggles["grid"]?.on = s.grid
        toggles["ael"]?.on = s.aeLock
        toggles["awbl"]?.on = s.awbLock
    }

    private fun buildZoomButtons() {
        zoomColumn.removeAllViews()
        val c = caps ?: return
        val stops = listOf(0.5f, 0.6f, 1f, 2f, 3f, 5f, 10f).filter { it >= c.zoomRange.lower - 0.01f && it <= c.zoomRange.upper + 0.01f }
            .let { l -> if (c.zoomRange.lower < 0.99f && l.none { it < 1f }) listOf(c.zoomRange.lower) + l else l }
            .distinct().take(5)
        for (z in stops) {
            val label = if (z < 1f) "%.1f".format(z) else "${z.roundToInt()}x"
            val b = CircleButton(this, label, "Zoom $label", 40f)
            b.highlight = abs(settings.zoom - z) < 0.05f
            b.setOnClickListener { setZoom(z) }
            zoomColumn.addView(b, LinearLayout.LayoutParams(-2, -2).apply { if (portraitLayout) { leftMargin = dp(4f); rightMargin = dp(4f) } else bottomMargin = dp(6f) })
        }
    }

    private fun setZoom(z: Float) {
        val c = caps ?: return
        val v = z.coerceIn(c.zoomRange.lower, c.zoomRange.upper)
        if (abs(v - settings.zoom) < 0.005f) return
        apply(settings.copy(zoom = v))
        for (i in 0 until zoomColumn.childCount) (zoomColumn.getChildAt(i) as? CircleButton)?.let { b ->
            val t = b.contentDescription.toString().removePrefix("Zoom ").removeSuffix("x").toFloatOrNull() ?: return@let
            b.highlight = abs(v - t) < 0.05f
        }
    }

    private fun switchLens() {
        if (recording) { flash("Stop recording to switch camera"); return }
        val c = caps ?: return
        val next = cameras.firstOrNull { it.front != c.front } ?: return
        apply(settings.copy(cameraId = next.id, zoom = 1f), restart = true)
    }

    private fun tapFocus(ix: Float, iy: Float) {
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
    }

    // ---- record / photo -------------------------------------------------------------------------------------
    private fun toggleRecording() {
        if (recording) {
            renderer.stopRecording()
            recButton.recording = false
            if (settings.sounds) sound.play(MediaActionSound.STOP_VIDEO_RECORDING)
        } else {
            if (caps == null) return
            if (settings.blurOn && !detectorReady) { flash("Face detection is still starting"); return }
            renderer.startRecording()
            if (settings.sounds) sound.play(MediaActionSound.START_VIDEO_RECORDING)
        }
    }

    private fun photo() {
        if (settings.sounds) sound.play(MediaActionSound.SHUTTER_CLICK)
        renderer.takePhoto()
    }

    private fun openLast() {
        val uri = lastUri ?: run { flash("Videos are saved in Movies/VeilCam"); return }
        runCatching {
            startActivity(Intent(Intent.ACTION_VIEW).apply { setDataAndType(uri, contentResolver.getType(uri) ?: "video/mp4"); addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION) })
        }.onFailure { flash("No app to play the clip") }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_VOLUME_DOWN || keyCode == KeyEvent.KEYCODE_VOLUME_UP || keyCode == KeyEvent.KEYCODE_CAMERA) {
            if (event.repeatCount == 0) toggleRecording()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        when {
            sheet.visibility == View.VISIBLE -> closeSheet()
            panel.visibility == View.VISIBLE -> closePanel()
            else -> @Suppress("DEPRECATION") super.onBackPressed()
        }
    }

    // ---- settings sheet ---------------------------------------------------------------------------------------
    private fun closeSheet() {
        val anim = sheet.animate().setDuration(180).withEndAction { sheet.visibility = View.GONE; sheet.translationX = 0f; sheet.translationY = 0f }
        if (portraitLayout) anim.translationY(sheet.height.toFloat()) else anim.translationX(sheet.width.toFloat())
        anim.start()
    }

    private fun openSheet(scrollTo: String? = null) {
        val s = settings
        val c = caps
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        var lookAnchor: View? = null
        fun add(v: View) = col.addView(v, LinearLayout.LayoutParams(-1, -2))

        add(TextView(this).apply { text = "Veil Cam"; setTextColor(Theme.TEXT); textSize = 22f; typeface = Theme.regular; setPadding(0, dp(8f), 0, 0) })

        add(Rows.section(this, "Face blur"))
        add(Rows.switch(this, "Blur faces", s.blurOn) { apply(settings.copy(blurOn = it)); refreshToggles() })
        add(Rows.hint(this, "Faces in video"))
        add(Rows.segments(this, listOf("1", "2", "Any"), when (s.maxFaces) { 1 -> 0; 2 -> 1; else -> 2 }) { apply(settings.copy(maxFaces = listOf(1, 2, 0)[it])) })
        add(Rows.hint(this, when (s.maxFaces) {
            1 -> "Only the single most certain face is hidden. Weak detections are ignored, so no stray blur."
            2 -> "Only the two most certain faces are hidden. Brief false detections never get blurred."
            else -> "Every detected face is hidden, including small background faces."
        }))
        add(Rows.hint(this, "Style"))
        add(Rows.segments(this, listOf("Gaussian", "Pixelate", "Black box", "Mask"), s.style.ordinal) { apply(settings.copy(style = BlurStyle.entries[it])) })
        add(Rows.hint(this, "Shape"))
        add(Rows.segments(this, listOf("Ellipse", "Rectangle"), if (s.ellipse) 0 else 1) { apply(settings.copy(ellipse = it == 0)) })
        add(Rows.slider(this, "Intensity", 1, 100, s.intensity, { "$it" }) { apply(settings.copy(intensity = it)) })
        add(Rows.slider(this, "Coverage", 0, 80, (s.coverage * 100).roundToInt(), { "+$it%" }) { apply(settings.copy(coverage = it / 100f)) })
        add(Rows.slider(this, "Hold after loss", 0, 30, s.holdFrames, { "$it fr" }) { apply(settings.copy(holdFrames = it)) })
        add(Rows.switch(this, "Soft edges", s.softEdges) { apply(settings.copy(softEdges = it)) })
        add(Rows.hint(this, "Detector"))
        add(Rows.segments(this, listOf("Fast", "Accurate"), if (s.accurateModel) 1 else 0) { apply(settings.copy(accurateModel = it == 1)) })
        add(Rows.hint(this, "Face angles"))
        add(Rows.segments(this, listOf("Any angle", "Tilted ±75°"), if (s.allAngles) 0 else 1) { apply(settings.copy(allAngles = it == 0)) })
        val maskRow = LinearLayout(this).apply { setPadding(0, dp(6f), 0, dp(6f)) }
        maskRow.addView(Rows.button(this, "Custom mask PNG") { importMask() }, LinearLayout.LayoutParams(-2, dp(36f)).apply { rightMargin = dp(8f) })
        maskRow.addView(Rows.button(this, "Built-in mask") { apply(settings.copy(maskPath = "")) }, LinearLayout.LayoutParams(-2, dp(36f)))
        add(maskRow)
        add(Rows.switch(this, "Show tracked face shapes", s.showBoxes) { apply(settings.copy(showBoxes = it)) })
        add(Rows.hint(this, "Recordings are blurred frame-exactly: each frame waits until its faces are known. The picture stays fully blurred until face detection has started."))

        add(Rows.section(this, "Video"))
        val sizes = c?.sizes?.filter { it.width in listOf(3840, 1920, 1280) }?.distinctBy { it.width } ?: emptyList()
        if (sizes.isNotEmpty()) {
            add(Rows.hint(this, "Resolution"))
            add(Rows.segments(this, sizes.map { when (it.width) { 3840 -> "4K UHD"; 1920 -> "1080p"; else -> "720p" } }, sizes.indexOfFirst { it.width == s.width }.coerceAtLeast(0)) {
                apply(settings.copy(width = sizes[it].width, height = sizes[it].height), restart = true)
            })
        }
        val fpsOpts = listOf(24, 25, 30, 48, 50, 60).filter { c?.supportsFps(it) == true }
        if (fpsOpts.isNotEmpty()) {
            add(Rows.hint(this, "Frame rate"))
            add(Rows.segments(this, fpsOpts.map { "$it" }, fpsOpts.indexOf(s.fps).coerceAtLeast(0)) {
                if (recording) flash("Stop recording to change this") else apply(settings.copy(fps = fpsOpts[it], shutterNs = settings.shutterNs.coerceAtMost(1_000_000_000L / fpsOpts[it])))
            })
        }
        add(Rows.hint(this, "Codec"))
        add(Rows.segments(this, listOf("H.265 / HEVC", "H.264 / AVC"), if (s.hevc) 0 else 1) { if (!recording) apply(settings.copy(hevc = it == 0)) })
        add(Rows.hint(this, "Quality (${s.bitrate() / 1_000_000} Mbps)"))
        add(Rows.segments(this, listOf("Low", "Standard", "High"), s.bitrateLevel) { if (!recording) apply(settings.copy(bitrateLevel = it)) })
        add(Rows.switch(this, "Record audio", s.audio) { apply(settings.copy(audio = it)) })
        if (c?.ois == true) add(Rows.switch(this, "Optical stabilization (OIS)", s.ois) { apply(settings.copy(ois = it)) })
        if (c?.eis == true || c?.previewStabilization == true) add(Rows.switch(this, "Digital stabilization", s.eis) { apply(settings.copy(eis = it)) })
        add(Rows.switch(this, "Low-latency preview", s.lowLatencyPreview) { apply(settings.copy(lowLatencyPreview = it)) })
        add(Rows.hint(this, "Off: the monitor shows exactly what is recorded (a few frames behind). On: newest frame, blur follows faces by prediction."))

        lookAnchor = Rows.section(this, "Look")
        add(lookAnchor)
        if (c?.toneCurve == true) {
            add(Rows.hint(this, "Picture profile"))
            add(Rows.segments(this, listOf("Standard", "Flat"), if (s.flatProfile) 1 else 0) {
                apply(settings.copy(flatProfile = it == 1, lut = if (it == 1 && settings.lut == "None") "Flat → Rec.709" else settings.lut))
            })
        }
        val names = lutNames()
        add(Rows.hint(this, "LUT"))
        for (chunk in names.chunked(4)) {
            add(Rows.segments(this, chunk, chunk.indexOf(s.lut)) { i -> apply(settings.copy(lut = chunk[i])); openSheet(scrollTo = "look") })
        }
        add(Rows.button(this, "Import .cube LUT…") { importLut() }.also { it.layoutParams = LinearLayout.LayoutParams(-2, dp(36f)) })
        add(Rows.slider(this, "LUT strength", 0, 100, (s.lutAmount * 100).roundToInt(), { "$it%" }) { apply(settings.copy(lutAmount = it / 100f)) })
        add(Rows.switch(this, "Show LUT on monitor", s.lutOnMonitor) { apply(settings.copy(lutOnMonitor = it)) })
        add(Rows.switch(this, "Bake LUT into recording", s.bakeLut) { apply(settings.copy(bakeLut = it)) })

        add(Rows.section(this, "Monitoring"))
        add(Rows.switch(this, "Zebras", s.zebra) { apply(settings.copy(zebra = it)); refreshToggles() })
        add(Rows.slider(this, "Zebra level", 70, 100, (s.zebraLevel * 100).roundToInt(), { "$it%" }) { apply(settings.copy(zebraLevel = it / 100f)) })
        add(Rows.switch(this, "Focus peaking", s.peaking) { apply(settings.copy(peaking = it)); refreshToggles() })
        add(Rows.segments(this, listOf("Lime", "Red", "White", "Blue"), s.peakColor) { apply(settings.copy(peakColor = it)) })
        add(Rows.slider(this, "Peaking sensitivity", 0, 100, (s.peakSensitivity * 100).roundToInt(), { "$it" }) { apply(settings.copy(peakSensitivity = it / 100f)) })
        add(Rows.switch(this, "False colour", s.falseColor) { apply(settings.copy(falseColor = it)); refreshToggles() })
        add(Rows.switch(this, "Histogram", s.histogram) { apply(settings.copy(histogram = it)) })
        add(Rows.switch(this, "Grid", s.grid) { apply(settings.copy(grid = it)); refreshToggles() })
        add(Rows.switch(this, "Horizon level", s.level) { apply(settings.copy(level = it)) })
        val guides = listOf("Off", "2.39:1", "1.85:1", "4:5", "9:16", "1:1")
        add(Rows.hint(this, "Frame guide"))
        add(Rows.segments(this, guides, guides.indexOf(s.guide).coerceAtLeast(0)) { apply(settings.copy(guide = guides[it])) })
        add(Rows.hint(this, "Shutter display"))
        add(Rows.segments(this, listOf("Angle", "Speed"), if (s.shutterAngle) 0 else 1) { apply(settings.copy(shutterAngle = it == 0)) })

        add(Rows.section(this, "Camera"))
        if (cameras.size > 1) {
            add(Rows.hint(this, "Lens"))
            add(Rows.segments(this, cameras.map { it.label }, cameras.indexOfFirst { it.id == c?.id }.coerceAtLeast(0)) {
                apply(settings.copy(cameraId = cameras[it].id, zoom = 1f), restart = true)
            })
        }
        val orients = listOf("Landscape", "Portrait", "Auto")
        add(Rows.hint(this, "Orientation (video is recorded the way the screen faces)"))
        add(Rows.segments(this, listOf("Horizontal", "Vertical", "Auto-rotate"), orients.indexOf(s.orientation).coerceAtLeast(0)) {
            if (recording) flash("Stop recording to change orientation") else {
                apply(settings.copy(orientation = orients[it])); requestedOrientation = orientationRequest()
            }
        })
        add(Rows.switch(this, "Mirror front camera recordings", s.mirrorFront) { apply(settings.copy(mirrorFront = it)) })
        add(Rows.switch(this, "Camera sounds", s.sounds) { apply(settings.copy(sounds = it)) })
        add(Rows.hint(this, "Volume keys start / stop recording. Tap the picture to focus and meter, double-tap for continuous AF, pinch to zoom."))
        add(Rows.section(this, "About"))
        add(Rows.hint(this, "Veil Cam ${BuildConfigLite.VERSION} · videos in Movies/VeilCam, photos in Pictures/VeilCam. Face detection runs on the phone; nothing is uploaded. Face models: InsightFace SCRFD (non-commercial research licence)."))

        sheet.removeAllViews()
        sheet.addView(col)
        if (sheet.visibility != View.VISIBLE) {
            sheet.visibility = View.VISIBLE
            if (portraitLayout) {
                sheet.translationY = resources.displayMetrics.heightPixels * 0.62f
                sheet.animate().translationY(0f).setDuration(200).start()
            } else {
                sheet.translationX = dp(380f).toFloat()
                sheet.animate().translationX(0f).setDuration(200).start()
            }
        }
        if (scrollTo == "look") lookAnchor?.let { a -> sheet.post { sheet.smoothScrollTo(0, a.top) } }
    }

    // ---- helpers ------------------------------------------------------------------------------------------------
    private fun flash(msg: String) {
        toast.text = msg
        toast.animate().cancel()
        toast.alpha = 1f
        toast.animate().alpha(0f).setStartDelay(2600).setDuration(400).start()
    }

    private var imageSize = 0 to 0
    private var lastDetectFps = 0f

    // ---- Renderer.Listener (GL thread -> main) -------------------------------------------------------------------
    override fun onDisplayTransform(imgW: Int, imgH: Int, content: RectF, viewToImg: FloatArray) {
        main.post { imageSize = imgW to imgH; overlay.content = content; overlay.setTransform(viewToImg) }
    }

    override fun onFaces(faces: List<Geom>) { main.post { overlay.setFaces(faces) } }

    override fun onHistogram(luma: IntArray, r: IntArray, g: IntArray, b: IntArray) { main.post { overlay.setHistogram(luma, r, g, b) } }

    override fun onStats(cameraFps: Float, detectFps: Float, detectMs: Float, delayFrames: Int) {
        main.post { lastDetectFps = detectFps; if (!recording) refreshStatus() }
    }

    override fun onRecording(active: Boolean, elapsedNs: Long, uri: Uri?, error: String?) {
        main.post {
            if (active) {
                if (!recording) {
                    recording = true; recButton.recording = true; closeSheet()
                    requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LOCKED // the take keeps its orientation
                }
                timecode.text = Recorder.durationText(elapsedNs, settings.fps)
                timecode.setTextColor(Theme.REC)
            } else {
                recording = false
                recButton.recording = false
                timecode.setTextColor(Theme.TEXT)
                requestedOrientation = orientationRequest()
                if (uri != null) { lastUri = uri; flash("Saved to Movies/VeilCam") }
                if (error != null) flash(error)
            }
        }
    }

    override fun onPhoto(uri: Uri?, error: String?) { main.post { if (uri != null) flash("Photo saved to Pictures/VeilCam") else flash("Photo failed: $error") } }

    override fun onDetectorReady(ready: Boolean) { main.post { detectorReady = ready; overlay.startingHint = settings.blurOn && !ready } }

    // ---- sensors ------------------------------------------------------------------------------------------------------
    private val sensorListener = object : SensorEventListener {
        override fun onSensorChanged(e: SensorEvent) {
            val a = Math.toDegrees(atan2(e.values[0].toDouble(), e.values[1].toDouble())).toFloat()
            var roll = a - displayDegrees()
            while (roll > 180) roll -= 360
            while (roll < -180) roll += 360
            overlay.roll = roll
        }
        override fun onAccuracyChanged(s: Sensor?, a: Int) {}
    }

    private fun registerSensors() {
        val sm = getSystemService(Context.SENSOR_SERVICE) as SensorManager
        sm.getDefaultSensor(Sensor.TYPE_GRAVITY)?.let { sm.registerListener(sensorListener, it, SensorManager.SENSOR_DELAY_UI) }
        (getSystemService(Context.DISPLAY_SERVICE) as DisplayManager).registerDisplayListener(displayListener, main)
    }

    private fun unregisterSensors() {
        (getSystemService(Context.SENSOR_SERVICE) as SensorManager).unregisterListener(sensorListener)
        (getSystemService(Context.DISPLAY_SERVICE) as DisplayManager).unregisterDisplayListener(displayListener)
    }

    companion object {
        private const val REQ_LUT = 11
        private const val REQ_MASK = 12
    }
}

object BuildConfigLite { const val VERSION = "1.1.0" }
