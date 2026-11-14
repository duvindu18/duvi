package com.veil.cam.ui

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.os.SystemClock
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.view.ViewConfiguration
import com.veil.cam.Settings
import com.veil.cam.core.Coverage
import com.veil.cam.core.FramingAdvisor
import com.veil.cam.core.FramingHint
import com.veil.cam.core.Geom
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin

/**
 * Everything drawn on the picture (never recorded): the focus square with its
 * exposure sun, frame guides, grid, level, histogram, audio meters and tracked
 * face shapes. Gestures: tap to focus, drag the sun (or anywhere, right after a
 * tap) for exposure, press and hold for AE/AF lock, pinch to zoom, swipe sideways
 * for the mode, swipe up / down for the settings tray.
 *
 * The screen layout is fixed in portrait; [uiRotation] turns the readouts to how
 * the phone is held and [frameRotation] the guides to the recorded frame.
 */
class OverlayView(ctx: Context) : View(ctx) {
    var settings = Settings()
        set(v) { field = v; invalidate() }
    var content = RectF()
        set(v) { field = v; invalidate() }
    var hud = RectF()
        set(v) { field = v; invalidate() }
    var uiRotation = 0
        set(v) { field = v; invalidate() }
    var frameRotation = 0
        set(v) { field = v; invalidate() }
    var levels = floatArrayOf(-90f, -90f)
        set(v) { field = v; if (settings.audio) invalidate() }
    var roll = 0f
        set(v) { if (abs(v - field) > 0.2f) { field = v; if (settings.level) invalidate() } }
    var startingHint = false
        set(v) { field = v; invalidate() }
    /** Exposure compensation shown by the sun, -1 .. 1. */
    var exposure = 0f
        set(v) { field = v; invalidate() }
    /** Exposure can be dragged (auto exposure, not locked to manual ISO / shutter). */
    var exposureEnabled = true
    var locked = false
        set(v) { field = v; if (v) { lockAt = now(); focusAt = now() - 2000 }; invalidate() }

    var onTap: ((viewX: Float, viewY: Float, imgX: Float, imgY: Float) -> Unit)? = null
    var onLongPress: ((viewX: Float, viewY: Float, imgX: Float, imgY: Float) -> Unit)? = null
    var onDoubleTap: (() -> Unit)? = null
    var onZoom: ((factor: Float) -> Unit)? = null
    var onPinch: ((active: Boolean) -> Unit)? = null
    var onSwipeMode: ((dir: Int) -> Unit)? = null
    var onSwipeTray: ((up: Boolean) -> Unit)? = null
    var onExposure: ((delta: Float) -> Unit)? = null // in units of the full sun travel

    /** Recording: framing hints are for before the take, so they hide. */
    var recording = false
    /** Scene recognition badge ("NIGHT · 8×"), or null. */
    var sceneBadge: String? = null
        set(v) { if (v != field) { field = v; invalidate() } }
    /** A-B focus pull marks (image px), or null. */
    var markA: FloatArray? = null
        set(v) { field = v; invalidate() }
    var markB: FloatArray? = null
        set(v) { field = v; invalidate() }
    /** Palm held: 0..1 progress ring; [countdown] > 0 shows the big countdown number. */
    var palmHold = 0f
        set(v) { if (v != field) { field = v; invalidate() } }
    var countdown = 0
        set(v) { if (v != field) { field = v; invalidate() } }
    private var tracked: FloatArray? = null
    private var trackedAt = 0L
    private var hint: FramingHint? = null
    private var hintCandidate: String? = null
    private var hintSince = 0L
    private var hintLost = 0L

    private var viewToImg = floatArrayOf(1f, 0f, 0f, 0f, 1f, 0f)
    private var imgToView = floatArrayOf(1f, 0f, 0f, 0f, 1f, 0f)
    private var faces: List<Geom> = emptyList()
    private var hist: Array<IntArray>? = null
    private var focus: Pair<Float, Float>? = null
    private var focusAt = 0L
    private var lockAt = 0L
    private var lastExposureTouch = 0L
    private var dragExposure = false
    private val p = Paint(Paint.ANTI_ALIAS_FLAG)
    private val label = Theme.textPaint(ctx, 13f, Theme.semibold)
    private val small = Theme.textPaint(ctx, 11f, Theme.bold)
    private val big = Theme.textPaint(ctx, 96f, Theme.semibold).apply { setShadowLayer(12f, 0f, 2f, Color.argb(140, 0, 0, 0)) }
    private fun dp(v: Float) = Theme.dp(context, v)
    private fun now() = SystemClock.uptimeMillis()

    fun setTransform(viewToImage: FloatArray) {
        viewToImg = viewToImage
        val det = viewToImage[0] * viewToImage[4] - viewToImage[1] * viewToImage[3]
        if (abs(det) < 1e-9f) return
        val a = viewToImage[4] / det; val b = -viewToImage[1] / det; val d = -viewToImage[3] / det; val e = viewToImage[0] / det
        imgToView = floatArrayOf(a, b, -(a * viewToImage[2] + b * viewToImage[5]), d, e, -(d * viewToImage[2] + e * viewToImage[5]))
        invalidate()
    }

    fun setFaces(f: List<Geom>) { faces = f; updateFraming(); invalidate() }

    /** Cinematic focus is following a tapped subject at image point ([x], [y]). */
    fun setTracked(x: Float, y: Float) { tracked = floatArrayOf(x, y); trackedAt = now(); invalidate() }
    fun clearTracked() { tracked = null; invalidate() }

    /** Largest face as (cx, cy, w, h), normalised to the recorded frame (x right, y down). */
    fun facesInFrame(): List<FloatArray> {
        val r = content
        if (r.width() <= 0) return emptyList()
        val q = ((frameRotation / 90) % 2 + 2) % 2 == 1
        val fw = if (q) r.height() else r.width(); val fh = if (q) r.width() else r.height()
        val rad = Math.toRadians(-frameRotation.toDouble()); val cs = cos(rad).toFloat(); val sn = sin(rad).toFloat()
        return faces.map { g ->
            val vx = mapX(g.cx, g.cy) - r.centerX(); val vy = mapY(g.cx, g.cy) - r.centerY()
            val lx = vx * cs - vy * sn; val ly = vx * sn + vy * cs
            // Face size in view px (the image -> view map is a similarity).
            val k = kotlin.math.hypot(imgToView[0], imgToView[3])
            val w = g.w * k; val h = g.h * k
            floatArrayOf(lx / fw + 0.5f, ly / fh + 0.5f, (if (q) h else w) / fw, (if (q) w else h) / fh)
        }
    }

    /** Framing hints change only once they have held for a moment (faces jitter). */
    private fun updateFraming() {
        if (!settings.framingGuide || recording) { hint = null; return }
        val h = FramingAdvisor.advise(facesInFrame(), roll).lastOrNull()
        val t = now()
        if (h == null) {
            if (hint != null && t - hintLost > 700) hint = null
            hintCandidate = null
            return
        }
        hintLost = t
        if (h.message != hintCandidate) { hintCandidate = h.message; hintSince = t }
        if (t - hintSince > 600 || hint?.message == h.message) hint = h
    }
    fun setHistogram(l: IntArray, r: IntArray, g: IntArray, b: IntArray) { hist = arrayOf(l, r, g, b); invalidate() }

    fun showFocus(x: Float, y: Float) { focus = x to y; focusAt = now(); invalidate() }
    fun clearFocusBox() { focus = null; locked = false; invalidate() }
    val focusVisible get() = focus != null && (locked || now() - focusAt < 4200 || now() - lastExposureTouch < 2500)

    private fun img(x: Float, y: Float) = floatArrayOf(viewToImg[0] * x + viewToImg[1] * y + viewToImg[2], viewToImg[3] * x + viewToImg[4] * y + viewToImg[5])

    // ---- gestures --------------------------------------------------------------------------------
    private val gestures = GestureDetector(ctx, object : GestureDetector.SimpleOnGestureListener() {
        override fun onDown(e: MotionEvent) = true
        override fun onSingleTapUp(e: MotionEvent): Boolean {
            if (!content.contains(e.x, e.y)) return false
            val i = img(e.x, e.y)
            locked = false
            showFocus(e.x, e.y)
            onTap?.invoke(e.x, e.y, i[0], i[1])
            return true
        }
        override fun onDoubleTap(e: MotionEvent): Boolean { focus = null; locked = false; onDoubleTap?.invoke(); invalidate(); return true }
        override fun onLongPress(e: MotionEvent) {
            if (!content.contains(e.x, e.y) || axis != 0 || multi) return
            val i = img(e.x, e.y)
            showFocus(e.x, e.y)
            locked = true
            thud()
            onLongPress?.invoke(e.x, e.y, i[0], i[1])
        }
    })
    private val scale = ScaleGestureDetector(ctx, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScaleBegin(d: ScaleGestureDetector): Boolean { onPinch?.invoke(true); return true }
        override fun onScale(d: ScaleGestureDetector): Boolean { onZoom?.invoke(d.scaleFactor); return true }
        override fun onScaleEnd(d: ScaleGestureDetector) { onPinch?.invoke(false) }
    })
    private var downX = 0f
    private var downY = 0f
    private var lastX = 0f
    private var lastY = 0f
    private var axis = 0 // 0 undecided, 1 horizontal, 2 vertical, 3 exposure
    private var multi = false
    private val slop = ViewConfiguration.get(ctx).scaledTouchSlop * 1.4f

    /** The user's "up" on the screen for how the phone is held. */
    private fun upVector(): Pair<Float, Float> = when ((uiRotation % 360 + 360) % 360) {
        90 -> 1f to 0f
        270 -> -1f to 0f
        180 -> 0f to 1f
        else -> 0f to -1f
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(e: MotionEvent): Boolean {
        scale.onTouchEvent(e)
        if (e.actionMasked == MotionEvent.ACTION_DOWN) { multi = false; axis = 0; downX = e.x; downY = e.y; lastX = e.x; lastY = e.y }
        if (e.pointerCount > 1 || scale.isInProgress) multi = true
        if (!multi) gestures.onTouchEvent(e) else if (e.actionMasked == MotionEvent.ACTION_POINTER_DOWN) gestures.onTouchEvent(MotionEvent.obtain(e).apply { action = MotionEvent.ACTION_CANCEL })
        when (e.actionMasked) {
            MotionEvent.ACTION_MOVE -> if (!multi) {
                val dx = e.x - downX; val dy = e.y - downY
                if (axis == 0 && (abs(dx) > slop || abs(dy) > slop)) {
                    axis = if (focusVisible && exposureEnabled) 3 else if (abs(dx) > abs(dy)) 1 else 2
                    if (axis == 3) { dragExposure = true; parent?.requestDisallowInterceptTouchEvent(true) }
                }
                if (axis == 3) {
                    val (ux, uy) = upVector()
                    val d = ((e.x - lastX) * ux + (e.y - lastY) * uy) / dp(150f)
                    lastExposureTouch = now()
                    onExposure?.invoke(d)
                    invalidate()
                }
                lastX = e.x; lastY = e.y
            }
            MotionEvent.ACTION_UP -> {
                val dx = e.x - downX; val dy = e.y - downY
                if (!multi) when (axis) {
                    1 -> if (abs(dx) > dp(44f)) onSwipeMode?.invoke(if (dx < 0) 1 else -1)
                    2 -> if (abs(dy) > dp(44f)) onSwipeTray?.invoke(dy < 0)
                }
                if (dragExposure) { dragExposure = false; lastExposureTouch = now(); invalidate() }
            }
            MotionEvent.ACTION_CANCEL -> dragExposure = false
        }
        return true
    }

    // ---- drawing ---------------------------------------------------------------------------------
    /** Run [block] in a frame turned by [deg] that exactly covers [r] (width and height swap). */
    private inline fun turned(c: Canvas, r: RectF, deg: Int, block: (RectF) -> Unit) {
        val q = ((deg / 90) % 2 + 2) % 2 == 1
        val w = if (q) r.height() else r.width()
        val h = if (q) r.width() else r.height()
        c.save()
        c.translate(r.centerX(), r.centerY())
        c.rotate(deg.toFloat())
        block(RectF(-w / 2, -h / 2, w / 2, h / 2))
        c.restore()
    }

    override fun onDraw(c: Canvas) {
        val r = content
        if (r.width() <= 0) return
        turned(c, r, frameRotation) { f -> drawGuides(c, f); if (settings.grid) drawGrid(c, f); hint?.let { drawHint(c, f, it) } }
        if (settings.showBoxes) drawFaces(c)
        turned(c, r, uiRotation) { f ->
            if (settings.level && abs(roll) < 12f) drawLevel(c, f)
            if (startingHint) drawStarting(c, f)
            sceneBadge?.let { drawBadge(c, f, it) }
            if (palmHold > 0f || countdown > 0) drawPalm(c, f)
        }
        drawMarks(c)
        val area = RectF(r).apply { if (hud.width() > 0 && !intersect(hud)) set(r) }
        turned(c, area, uiRotation) { f ->
            if (settings.histogram) drawHistogram(c, f)
            if (settings.audio) drawMeters(c, f)
        }
        drawFocus(c)
    }

    private fun drawGuides(c: Canvas, r: RectF) {
        val ratio = when (settings.guide) { "2.39:1" -> 2.39f; "1.85:1" -> 1.85f; "4:5" -> 0.8f; "9:16" -> 9f / 16f; "1:1" -> 1f; else -> return }
        var w = r.width(); var h = r.height()
        if (w / h > ratio) w = h * ratio else h = w / ratio
        val inner = RectF(r.centerX() - w / 2, r.centerY() - h / 2, r.centerX() + w / 2, r.centerY() + h / 2)
        p.style = Paint.Style.FILL
        p.color = Color.argb(150, 0, 0, 0)
        c.drawRect(r.left, r.top, r.right, inner.top, p)
        c.drawRect(r.left, inner.bottom, r.right, r.bottom, p)
        c.drawRect(r.left, inner.top, inner.left, inner.bottom, p)
        c.drawRect(inner.right, inner.top, r.right, inner.bottom, p)
        p.style = Paint.Style.STROKE
        p.strokeWidth = dp(1f)
        p.color = Color.argb(150, 255, 255, 255)
        c.drawRect(inner, p)
    }

    private fun drawGrid(c: Canvas, r: RectF) {
        p.style = Paint.Style.STROKE
        p.strokeWidth = dp(0.7f)
        p.color = Color.argb(120, 255, 255, 255)
        for (i in 1..2) {
            val x = r.left + r.width() * i / 3; val y = r.top + r.height() * i / 3
            c.drawLine(x, r.top, x, r.bottom, p)
            c.drawLine(r.left, y, r.right, y, p)
        }
    }

    private fun mapX(x: Float, y: Float) = imgToView[0] * x + imgToView[1] * y + imgToView[2]
    private fun mapY(x: Float, y: Float) = imgToView[3] * x + imgToView[4] * y + imgToView[5]

    private fun drawFaces(c: Canvas) {
        p.style = Paint.Style.STROKE
        p.strokeWidth = dp(1.5f)
        p.color = Theme.YELLOW
        for (g in faces) {
            val s = Coverage.shape(g, settings.coverage, settings.ellipse)
            val rad = Math.toRadians(s.angle.toDouble())
            val cs = cos(rad).toFloat(); val sn = sin(rad).toFloat()
            val path = Path()
            val n = 36
            for (i in 0..n) {
                val t = (2 * Math.PI * i / n)
                val lx: Float; val ly: Float
                if (settings.ellipse) { lx = (s.hw * cos(t)).toFloat(); ly = (s.hh * sin(t)).toFloat() } else {
                    val k = i % 9; val side = i / 9
                    val f = k / 9f * 2 - 1
                    when (side) { 0 -> { lx = s.hw * f; ly = -s.hh }; 1 -> { lx = s.hw; ly = s.hh * f }; 2 -> { lx = -s.hw * f; ly = s.hh }; else -> { lx = -s.hw; ly = -s.hh * f } }
                }
                val ix = s.cx + lx * cs - ly * sn
                val iy = s.cy + lx * sn + ly * cs
                val vx = mapX(ix, iy); val vy = mapY(ix, iy)
                if (i == 0) path.moveTo(vx, vy) else path.lineTo(vx, vy)
            }
            c.drawPath(path, p)
        }
    }

    /** Level: two short lines that turn yellow and join when the phone is level. */
    private fun drawLevel(c: Canvas, r: RectF) {
        val len = dp(34f)
        val ok = abs(roll) < 1f
        p.style = Paint.Style.STROKE
        p.strokeCap = Paint.Cap.ROUND
        p.strokeWidth = dp(1.2f)
        // Fades in as the phone gets close to level.
        val a = (1f - (abs(roll) - 6f) / 6f).coerceIn(0f, 1f)
        p.color = if (ok) Theme.YELLOW else Color.argb((200 * a).toInt(), 255, 255, 255)
        val cx = r.centerX(); val cy = r.centerY()
        c.drawLine(cx - len * 2, cy, cx - len, cy, p)
        c.drawLine(cx + len, cy, cx + len * 2, cy, p)
        if (!ok) {
            val rad = Math.toRadians(-roll.toDouble())
            val dx = (cos(rad) * len).toFloat(); val dy = (sin(rad) * len).toFloat()
            c.drawLine(cx - dx, cy - dy, cx + dx, cy + dy, p)
        } else c.drawLine(cx - len, cy, cx + len, cy, p)
    }

    private val springIn = Spring(0.55f, 0.32f)

    private fun drawFocus(c: Canvas) {
        val fp = focus ?: return
        val t = now()
        val age = t - focusAt
        val sinceDrag = t - lastExposureTouch
        if (!locked && age > 4200 && sinceDrag > 2500 && !dragExposure) { focus = null; return }
        val box = dp(37f)
        // Spring in from 1.45x; on lock, two quick pulses.
        var s = 1f + 0.45f * (1f - springIn.getInterpolation((age / springIn.durationMs.toFloat()).coerceIn(0f, 1f)))
        val la = t - lockAt
        if (locked && la < 700) s *= 1f + 0.12f * abs(sin(la / 700f * 2 * Math.PI)).toFloat()
        val active = dragExposure || sinceDrag < 600 || age < 1500 || locked && la < 1200
        val alpha = when {
            active -> 1f
            locked -> 0.6f
            else -> (0.6f - ((age - 3600).coerceAtLeast(0) / 600f) * 0.6f).coerceIn(0f, 0.6f)
        }
        c.save()
        c.translate(fp.first, fp.second)
        c.rotate(uiRotation.toFloat())
        p.style = Paint.Style.STROKE
        p.strokeWidth = dp(1.3f)
        p.color = Theme.YELLOW
        p.alpha = (255 * alpha).toInt()
        val h = box * s
        c.drawRect(-h, -h, h, h, p)
        val n = dp(4f)
        c.drawLine(0f, -h, 0f, -h + n, p); c.drawLine(0f, h, 0f, h - n, p)
        c.drawLine(-h, 0f, -h + n, 0f, p); c.drawLine(h, 0f, h - n, 0f, p)
        // The sun: exposure, on a line that appears while it is dragged.
        if (exposureEnabled) {
            val sx = h + dp(17f)
            val sy = -exposure.coerceIn(-1f, 1f) * box * 1.4f
            if (dragExposure || sinceDrag < 900) {
                val gap = dp(11f)
                p.strokeWidth = dp(1.1f)
                if (sy - gap > -box * 1.5f) c.drawLine(sx, -box * 1.5f, sx, sy - gap, p)
                if (sy + gap < box * 1.5f) c.drawLine(sx, sy + gap, sx, box * 1.5f, p)
            }
            p.strokeWidth = dp(1.3f)
            Glyphs.draw(c, Glyph.SUN, sx, sy, dp(19f), p)
        }
        c.restore()
        p.alpha = 255
        postInvalidateOnAnimation()
    }

    private fun drawHistogram(c: Canvas, r: RectF) {
        val h = hist ?: return
        val w = dp(110f); val hh = dp(60f)
        val x0 = r.left + dp(14f)
        val y0 = r.top + dp(10f)
        val box = RectF(x0, y0, x0 + w, y0 + hh)
        Glass.draw(c, box, dp(9f), Theme.GLASS, resources.displayMetrics.density)
        val colors = intArrayOf(Color.argb(200, 255, 255, 255), Color.argb(110, 255, 80, 80), Color.argb(110, 80, 255, 120), Color.argb(110, 90, 140, 255))
        val maxV = h[0].maxOrNull()?.coerceAtLeast(1) ?: 1
        p.style = Paint.Style.FILL
        for (ch in 3 downTo 0) {
            val path = Path()
            path.moveTo(x0 + 6, y0 + hh - 6)
            val bins = h[ch]
            for (i in bins.indices) {
                val x = x0 + 6 + (w - 12) * i / (bins.size - 1)
                val y = y0 + hh - 6 - (hh - 12) * min(1f, bins[i].toFloat() / maxV)
                path.lineTo(x, y)
            }
            path.lineTo(x0 + w - 6, y0 + hh - 6)
            path.close()
            p.color = colors[ch]
            c.drawPath(path, p)
        }
    }

    private fun drawMeters(c: Canvas, r: RectF) {
        val w = dp(4f); val hh = dp(44f)
        val x0 = r.right - dp(14f) - dp(8f) - 2 * w - dp(3f)
        val y0 = r.top + dp(18f) // backing spans the histogram's row exactly (10..70 dp)
        val back = RectF(x0 - dp(8f), y0 - dp(8f), x0 + 2 * w + dp(3f) + dp(8f), y0 + hh + dp(8f))
        Glass.draw(c, back, dp(9f), Theme.GLASS, resources.displayMetrics.density)
        p.style = Paint.Style.FILL
        for (ch in 0..1) {
            val x = x0 + ch * (w + dp(3f))
            p.color = Color.argb(90, 255, 255, 255)
            c.drawRoundRect(x, y0, x + w, y0 + hh, w / 2, w / 2, p)
            val db = levels[ch].coerceIn(-60f, 0f)
            val f = (db + 60f) / 60f
            p.color = when { db > -3f -> Theme.RED; db > -12f -> Theme.YELLOW; else -> Theme.GREEN }
            c.drawRoundRect(x, y0 + hh * (1 - f), x + w, y0 + hh, w / 2, w / 2, p)
        }
    }

    /** Framing hint: a dashed path from the eyes to the thirds point, a ring there, the advice below. */
    private fun drawHint(c: Canvas, r: RectF, h: FramingHint) {
        val fx = r.left + h.fromX * r.width(); val fy = r.top + h.fromY * r.height()
        val tx = r.left + h.toX * r.width(); val ty = r.top + h.toY * r.height()
        p.style = Paint.Style.STROKE
        p.strokeWidth = dp(1.4f)
        p.color = Color.argb(220, 255, 214, 10)
        if (kotlin.math.hypot(tx - fx, ty - fy) > dp(8f)) {
            p.pathEffect = android.graphics.DashPathEffect(floatArrayOf(dp(5f), dp(5f)), 0f)
            c.drawLine(fx, fy, tx, ty, p)
            p.pathEffect = null
            c.drawCircle(tx, ty, dp(9f), p)
            c.drawCircle(fx, fy, dp(3f), p)
        }
        val text = h.message
        val tw = label.measureText(text) + dp(24f); val th = dp(28f)
        val box = RectF(r.centerX() - tw / 2, r.bottom - th - dp(16f), r.centerX() + tw / 2, r.bottom - dp(16f))
        Glass.draw(c, box, th / 2, Theme.GLASS_STRONG, resources.displayMetrics.density)
        c.drawText(text, box.centerX(), box.centerY() - (label.descent() + label.ascent()) / 2, label)
    }

    /** Scene recognition badge, top centre. */
    private fun drawBadge(c: Canvas, r: RectF, text: String) {
        val tw = small.measureText(text) + dp(18f); val th = dp(22f)
        val box = RectF(r.centerX() - tw / 2, r.top + dp(10f), r.centerX() + tw / 2, r.top + dp(10f) + th)
        Glass.draw(c, box, th / 2, Theme.GLASS_STRONG, resources.displayMetrics.density)
        small.color = Theme.YELLOW
        c.drawText(text, box.centerX(), box.centerY() - (small.descent() + small.ascent()) / 2, small)
    }

    /** Palm gesture: a ring filling while the palm is held, then the countdown. */
    private fun drawPalm(c: Canvas, r: RectF) {
        val cx = r.centerX(); val cy = r.centerY()
        if (countdown > 0) {
            big.color = Color.WHITE
            c.drawText("$countdown", cx, cy - (big.descent() + big.ascent()) / 2, big)
            return
        }
        val rad = dp(30f)
        p.style = Paint.Style.STROKE; p.strokeCap = Paint.Cap.ROUND
        p.strokeWidth = dp(3f)
        p.color = Color.argb(90, 255, 255, 255)
        c.drawCircle(cx, cy, rad, p)
        p.color = Theme.YELLOW
        c.drawArc(RectF(cx - rad, cy - rad, cx + rad, cy + rad), -90f, 360f * palmHold, false, p)
        Glyphs.draw(c, Glyph.PLAY, cx, cy, dp(22f), p.apply { style = Paint.Style.FILL; color = Color.WHITE })
    }

    /** A / B focus marks and the subject the cinematic focus follows. */
    private fun drawMarks(c: Canvas) {
        p.style = Paint.Style.STROKE
        p.strokeWidth = dp(1.5f)
        for ((m, name) in listOf(markA to "A", markB to "B")) {
            val pt = m ?: continue
            val x = mapX(pt[0], pt[1]); val y = mapY(pt[0], pt[1])
            p.color = Theme.YELLOW
            c.drawCircle(x, y, dp(13f), p)
            small.color = Theme.YELLOW
            c.drawText(name, x, y - (small.descent() + small.ascent()) / 2, small)
        }
        val t = tracked ?: return
        if (now() - trackedAt > 1500) { tracked = null; return }
        val x = mapX(t[0], t[1]); val y = mapY(t[0], t[1]); val h = dp(22f)
        p.color = Theme.YELLOW
        val k = dp(7f)
        // Corner brackets: "tracking".
        for ((sx, sy) in listOf(-1f to -1f, 1f to -1f, -1f to 1f, 1f to 1f)) {
            c.drawLine(x + sx * h, y + sy * h, x + sx * (h - k), y + sy * h, p)
            c.drawLine(x + sx * h, y + sy * h, x + sx * h, y + sy * (h - k), p)
        }
    }

    private fun drawStarting(c: Canvas, r: RectF) {
        val text = "Starting face detection…"
        val tw = label.measureText(text) + dp(28f)
        val th = dp(32f)
        val box = RectF(r.centerX() - tw / 2, r.centerY() - th / 2, r.centerX() + tw / 2, r.centerY() + th / 2)
        Glass.draw(c, box, th / 2, Theme.GLASS_STRONG, resources.displayMetrics.density)
        c.drawText(text, r.centerX(), r.centerY() - (label.descent() + label.ascent()) / 2, label)
    }
}
