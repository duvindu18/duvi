package com.veil.cam

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.RectF
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import com.veil.cam.ui.ControlSource
import com.veil.cam.ui.ControlSpec
import com.veil.cam.ui.ControllerView
import com.veil.cam.ui.FormatPill
import com.veil.cam.ui.GlassButton
import com.veil.cam.ui.Glyph
import com.veil.cam.ui.HudToast
import com.veil.cam.ui.ModeCarousel
import com.veil.cam.ui.OverlayView
import com.veil.cam.ui.SheetView
import com.veil.cam.ui.ShutterButton
import com.veil.cam.ui.SnapButton
import com.veil.cam.ui.Theme
import com.veil.cam.ui.ThumbView
import com.veil.cam.ui.TimerPill
import com.veil.cam.ui.TrayItem
import com.veil.cam.ui.TrayView
import com.veil.cam.ui.ZoomControl
import app.cash.paparazzi.DeviceConfig
import app.cash.paparazzi.Paparazzi
import com.android.resources.Density
import org.junit.Rule
import org.junit.Test

/**
 * Renders the camera UI components on the JVM (Paparazzi / layoutlib) into PNGs, laid
 * out as on the camera screen of a Pixel 9 Pro XL, for visual review without a phone.
 * Optional VEIL_SNAPSHOT_BG: a photo behind the controls.
 *   gradle -PveilSnapshots :app:recordPaparazziRelease
 */
class UiSnapshotTest {
    @get:Rule val paparazzi = Paparazzi(
        deviceConfig = DeviceConfig.PIXEL_6_PRO.copy(screenWidth = 1344, screenHeight = 2992, xdpi = 486, ydpi = 486, density = Density.XXHIGH),
        theme = "android:Theme.Material.NoActionBar",
        showSystemUi = false,
    )
    private val a get() = paparazzi.context
    private fun dp(v: Float) = Theme.dpi(a, v)

    private fun save(v: View, name: String, ms: Long = 1500) = paparazzi.snapshot(v, name, offsetMillis = ms)

    // Layoutlib does not run animation frames: make every animator jump to its end state.
    @org.junit.Before fun instantMotion() {
        android.animation.ValueAnimator::class.java.getMethod("setDurationScale", Float::class.javaPrimitiveType).invoke(null, 0f)
    }

    private fun background(): Bitmap? = System.getenv("VEIL_SNAPSHOT_BG")?.let { BitmapFactory.decodeFile(it) }

    private val source = object : ControlSource {
        val iso = listOf(50, 64, 80, 100, 125, 160, 200, 250, 320, 400, 500, 640, 800, 1000, 1250, 1600, 2000, 2500, 3200)
        override fun labels(key: String) = when (key) { "ISO" -> iso.map { "$it" }; "EV" -> (-6..6).map { if (it == 0) "0" else "%+.1f".format(it / 3f) }; else -> (0..20).map { "$it" } }
        override fun index(key: String) = when (key) { "ISO" -> 9; "EV" -> 7; else -> 10 }
        override fun set(key: String, i: Int) {}
        override fun auto(key: String) = if (key == "ISO") false else null
        override fun toggleAuto(key: String) {}
        override fun value(key: String) = when (key) { "ISO" -> "ISO 400"; "EV" -> "+0.3 EV"; else -> "ƒ2.8" }
    }

    private class Screen(
        val root: FrameLayout, val overlay: OverlayView, val modes: ModeCarousel, val tray: TrayView, val controller: ControllerView,
        val zoom: ZoomControl, val shutter: ShutterButton, val timer: TimerPill, val chevron: GlassButton, val thumb: ThumbView,
        val pause: GlassButton, val flip: GlassButton, val snap: SnapButton, val rot: List<View>, val format: FormatPill, val toast: HudToast,
    )

    /** The camera screen's layout, as built by MainActivity.buildUi. */
    private fun screen(): Screen {
        val root = FrameLayout(a).apply { setBackgroundColor(Color.BLACK) }
        val bg = background()
        val content = RectF(0f, (2992 - 1344 * 16 / 9) / 2f, 1344f, (2992 + 1344 * 16 / 9) / 2f)
        if (bg != null) {
            val img = ImageView(a).apply { scaleType = ImageView.ScaleType.CENTER_CROP; setImageBitmap(bg) }
            root.addView(img, FrameLayout.LayoutParams(1344, content.height().toInt(), Gravity.CENTER))
        }
        val overlay = OverlayView(a).apply {
            settings = Settings(histogram = true, level = true, grid = false)
            this.content = content
            setHistogram(IntArray(64) { (40 + 30 * kotlin.math.sin(it / 6.0) + it).toInt() }, IntArray(64) { 30 + it }, IntArray(64) { 50 }, IntArray(64) { 60 - it / 2 })
            levels = floatArrayOf(-14f, -18f)
        }
        root.addView(overlay, FrameLayout.LayoutParams(-1, -1))
        val ui = FrameLayout(a).apply { setPadding(dp(14f), dp(40f), dp(14f), dp(16f)); clipChildren = false; clipToPadding = false }
        val top = FrameLayout(a)
        val left = LinearLayout(a).apply { gravity = Gravity.CENTER_VERTICAL }
        val torch = GlassButton(a, Glyph.BOLT, "Torch", 36f)
        val faces = GlassButton(a, Glyph.FACE, "Faces", 36f).apply { active = true; glyphColor = Theme.YELLOW }
        left.addView(torch, LinearLayout.LayoutParams(-2, -2).apply { rightMargin = dp(10f) }); left.addView(faces)
        top.addView(left, FrameLayout.LayoutParams(-2, -2, Gravity.START or Gravity.CENTER_VERTICAL))
        val chevron = GlassButton(a, Glyph.CHEVRON_UP, "Settings", 32f)
        top.addView(chevron, FrameLayout.LayoutParams(-2, -2, Gravity.CENTER))
        val timer = TimerPill(a).apply { visibility = View.GONE; text = "00:01:23" }
        top.addView(timer, FrameLayout.LayoutParams(-2, -2, Gravity.CENTER))
        val right = LinearLayout(a).apply { gravity = Gravity.CENTER_VERTICAL }
        val depth = GlassButton(a, null, "Depth", 32f, "ƒ2.8").apply { visibility = View.GONE }
        val format = FormatPill(a).apply { this.left = "4K"; this.right = "24" }
        right.addView(depth, LinearLayout.LayoutParams(-2, -2).apply { rightMargin = dp(8f) }); right.addView(format)
        top.addView(right, FrameLayout.LayoutParams(-2, -2, Gravity.END or Gravity.CENTER_VERTICAL))
        ui.addView(top, FrameLayout.LayoutParams(-1, dp(44f), Gravity.TOP).apply { topMargin = dp(4f) })
        val toast = HudToast(a)
        ui.addView(toast, FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply { topMargin = dp(58f) })
        val bottom = LinearLayout(a).apply { orientation = LinearLayout.VERTICAL; clipChildren = false }
        val controller = ControllerView(a, source).apply {
            specs = listOf(ControlSpec("EV", "Exposure", Glyph.SUN), ControlSpec("ISO", "ISO", Glyph.ISO), ControlSpec("SHUTTER", "Shutter", Glyph.SHUTTER),
                ControlSpec("WB", "White Balance", Glyph.WB), ControlSpec("FOCUS", "Focus", Glyph.FOCUS), ControlSpec("DEPTH", "Depth", Glyph.DEPTH), ControlSpec("STYLE", "Style", Glyph.STYLE))
        }
        bottom.addView(controller, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(4f) })
        val zoomRow = FrameLayout(a).apply { clipChildren = false }
        val zoom = ZoomControl(a).apply { minZoom = 0.5f; maxZoom = 30f; stops = listOf(0.5f, 1f, 2f, 5f); zoom = 1f }
        zoomRow.addView(zoom, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM))
        val control = GlassButton(a, Glyph.DIAL, "Controls", 40f)
        zoomRow.addView(control, FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM or Gravity.START).apply { leftMargin = dp(18f); bottomMargin = dp(3f) })
        bottom.addView(zoomRow, LinearLayout.LayoutParams(-1, -2))
        val slot = FrameLayout(a)
        val modes = ModeCarousel(a, listOf("CINEMATIC", "VIDEO", "PHOTO", "PORTRAIT"))
        slot.addView(modes, FrameLayout.LayoutParams(-1, -2, Gravity.CENTER))
        val tray = TrayView(a).apply { visibility = View.GONE }
        slot.addView(tray, FrameLayout.LayoutParams(-1, -2, Gravity.CENTER))
        bottom.addView(slot, LinearLayout.LayoutParams(-1, dp(76f)))
        val row = FrameLayout(a)
        val thumb = ThumbView(a)
        val pause = GlassButton(a, Glyph.PAUSE, "Pause", 48f).apply { visibility = View.GONE }
        val shutter = ShutterButton(a)
        val flip = GlassButton(a, Glyph.FLIP, "Flip", 48f)
        val snap = SnapButton(a).apply { visibility = View.GONE }
        row.addView(thumb, FrameLayout.LayoutParams(-2, -2, Gravity.START or Gravity.CENTER_VERTICAL).apply { leftMargin = dp(28f) })
        row.addView(pause, FrameLayout.LayoutParams(-2, -2, Gravity.START or Gravity.CENTER_VERTICAL).apply { leftMargin = dp(27f) })
        row.addView(shutter, FrameLayout.LayoutParams(-2, -2, Gravity.CENTER))
        row.addView(flip, FrameLayout.LayoutParams(-2, -2, Gravity.END or Gravity.CENTER_VERTICAL).apply { rightMargin = dp(27f) })
        row.addView(snap, FrameLayout.LayoutParams(-2, -2, Gravity.END or Gravity.CENTER_VERTICAL).apply { rightMargin = dp(27f) })
        bottom.addView(row, LinearLayout.LayoutParams(-1, dp(100f)))
        ui.addView(bottom, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM))
        root.addView(ui, FrameLayout.LayoutParams(-1, -1))
        modes.select(1, animate = false)
        bg?.let { thumb.set(Bitmap.createScaledBitmap(it, 160, 160, true), false) }
        overlay.hud = RectF(0f, dp(96f).toFloat(), 1344f, 2992f - dp(330f))
        return Screen(root, overlay, modes, tray, controller, zoom, shutter, timer, chevron, thumb, pause, flip, snap,
            listOf(torch, faces, control, thumb, pause, flip, snap), format, toast)
    }

    private fun trayItems() = listOf(
        TrayItem("faces", Glyph.FACE, "Faces", true, listOf("Off", "1 face", "2 faces", "Any"), listOf(false, false, true, false)),
        TrayItem("exposure", Glyph.SUN, "Exposure"), TrayItem("style", Glyph.STYLE, "Styles"), TrayItem("film", Glyph.FILM, "Film", true),
        TrayItem("res", Glyph.FORMAT, "Resolution"), TrayItem("fps", Glyph.SHUTTER, "Frame rate"), TrayItem("settings", Glyph.GEAR, "Settings"),
    )

    @Test fun camera() {
        val s = screen()
        s.overlay.showFocus(1344 * 0.55f, 2992 * 0.42f)
        s.overlay.exposure = 0.3f
        save(s.root, "01_video")

        s.modes.select(2)
        s.shutter.video = false
        save(s.root, "02_photo")
        s.modes.select(1); s.shutter.video = true

        s.shutter.recording = true
        s.modes.alpha = 0f
        s.timer.visibility = View.VISIBLE; s.chevron.visibility = View.GONE
        s.thumb.visibility = View.GONE; s.pause.visibility = View.VISIBLE
        s.flip.visibility = View.GONE; s.snap.visibility = View.VISIBLE
        s.format.visibility = View.GONE
        save(s.root, "03_recording")
    }

    @Test fun trayAndController() {
        val s = screen()
        s.tray.setItems(trayItems()); s.tray.visibility = View.VISIBLE; s.modes.alpha = 0f
        save(s.root, "04_tray")
        s.tray.buttons[0].performClick()
        save(s.root, "05_tray_faces")
        s.tray.visibility = View.GONE; s.modes.alpha = 1f
        s.controller.open(null)
        save(s.root, "06_controller_picker")
        s.controller.open("ISO")
        save(s.root, "07_controller_iso")
        s.controller.dismiss()
        s.zoom.peek();
        save(s.root, "08_zoom_wheel")
    }

    @Test fun landscapeAndLock() {
        val s = screen()
        s.rot.forEach { it.rotation = 90f }
        s.zoom.textRotation = 90f
        s.overlay.uiRotation = 90
        s.overlay.showFocus(1344 * 0.45f, 2992 * 0.5f)
        s.overlay.locked = true
        s.toast.show("AE/AF LOCK", badge = true, ms = 100000)
        save(s.root, "09_landscape_lock")
    }

    @Test fun sheet() {
        val root = FrameLayout(a).apply { setBackgroundColor(Color.DKGRAY) }
        val sheet = SheetView(a)
        root.addView(sheet, FrameLayout.LayoutParams(-1, -1))
        sheet.open("Settings") { f ->
            f.section(null) { info("Battery", "76 %"); info("Recording time left", "412 min"); info("Temperature", "Normal") }
            f.section("Capture") {
                nav("Face Blur", "2 faces", Glyph.FACE) {}; nav("Record Video", "4K · 24 fps", Glyph.FORMAT) {}
                nav("Cinematic Depth", "ƒ2.8", Glyph.DEPTH) {}; nav("Styles", "Standard", Glyph.STYLE) {}; nav("Film Look", "35mm", Glyph.FILM) {}
            }
            f.section("Power", "Privacy never depends on the power mode.") {
                segmented(listOf("Max", "Balanced", "Saver"), 1) {}
                switch("Dim While Recording", true) {}; switch("Auto Standby", false) {}
                slider("Strength", 1, 100, 70, { "$it" }) {}
            }
        }
        save(root, "10_settings")
        sheet.push("Face Blur") { f ->
            f.section(null, "Recordings are blurred frame-exactly.") { switch("Blur Faces", true) {} }
            f.section("Faces in video") { segmented(listOf("1", "2", "Any"), 1) {} }
            f.section("Style") { check("Blur", true) {}; check("Pixelate", false) {}; check("Black", false) {} }
        }
        save(root, "11_settings_push")
    }
}
