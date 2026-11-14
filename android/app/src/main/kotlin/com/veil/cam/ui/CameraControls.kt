package com.veil.cam.ui

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Shader
import android.view.Gravity
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewConfiguration
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin

private fun View.dp(v: Float) = Theme.dp(context, v)

/** Pressed controls shrink a little and spring back. */
private fun View.pressFeedback(pressed: Boolean, scale: Float = 0.9f) {
    spring(Spring.SNAPPY).scaleX(if (pressed) scale else 1f).scaleY(if (pressed) scale else 1f).start()
}

/** Round (or pill, with [text]) glass button with a glyph; yellow when [active]. */
class GlassButton(ctx: Context, glyph: Glyph?, desc: String, private val sizeDp: Float = 40f, text: String? = null) : View(ctx) {
    var glyph = glyph
        set(v) { field = v; invalidate() }
    var text = text
        set(v) { field = v; requestLayout(); invalidate() }
    var active = false
        set(v) { field = v; invalidate() }
    var glyphColor: Int? = null
        set(v) { field = v; invalidate() }
    var glass = true
    var fillColor = Theme.GLASS
        set(v) { field = v; invalidate() }
    /** Extra spin of the glyph only (the flip arrows turn on tap). */
    var spin = 0f
        set(v) { field = v; invalidate() }
    private val p = Paint(Paint.ANTI_ALIAS_FLAG)
    private val tp = Theme.textPaint(ctx, 13f)
    private val r = RectF()

    init { contentDescription = desc; isClickable = true; isFocusable = true }

    override fun setPressed(pressed: Boolean) {
        if (pressed != isPressed) pressFeedback(pressed)
        super.setPressed(pressed)
    }

    override fun onMeasure(w: Int, h: Int) {
        val s = dp(sizeDp).roundToInt()
        val t = text
        if (t == null) setMeasuredDimension(resolveSize(s, w), resolveSize(s, h)) else {
            val gw = if (glyph != null) dp(18f) else 0f
            setMeasuredDimension(max(s.toFloat(), tp.measureText(t) + gw + dp(26f)).roundToInt(), s)
        }
    }

    override fun onDraw(c: Canvas) {
        r.set(0f, 0f, width.toFloat(), height.toFloat())
        if (glass) Glass.draw(c, r, height / 2f, fillColor, resources.displayMetrics.density)
        val col = glyphColor ?: if (active) Theme.YELLOW else Theme.TEXT
        p.color = col
        val t = text
        if (t == null) {
            glyph?.let {
                c.save(); c.rotate(spin, width / 2f, height / 2f)
                Glyphs.draw(c, it, width / 2f, height / 2f, height * 0.52f, p)
                c.restore()
            }
        } else {
            tp.color = col
            var x = width / 2f
            glyph?.let { g ->
                val gs = height * 0.42f
                val total = gs + dp(4f) + tp.measureText(t)
                val gx = (width - total) / 2 + gs / 2
                Glyphs.draw(c, g, gx, height / 2f, gs, p)
                x = gx + gs / 2 + dp(4f) + tp.measureText(t) / 2
            }
            c.drawText(t, x, height / 2f - (tp.descent() + tp.ascent()) / 2, tp)
        }
    }
}

/** Format pill "4K · 24": tap the left half for resolution, the right half for frame rate. */
class FormatPill(ctx: Context, private val heightDp: Float = 32f) : View(ctx) {
    var left = "4K"
        set(v) { field = v; requestLayout(); invalidate() }
    var right = "24"
        set(v) { field = v; requestLayout(); invalidate() }
    var onLeft: (() -> Unit)? = null
    var onRight: (() -> Unit)? = null
    private val tp = Theme.textPaint(ctx, 13f)
    private val dot = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Theme.SECONDARY }
    private val r = RectF()

    init { isClickable = true; contentDescription = "Video format" }

    override fun onMeasure(w: Int, h: Int) {
        val tw = tp.measureText(left) + tp.measureText(right) + dp(16f) + dp(28f)
        setMeasuredDimension(tw.roundToInt(), dp(heightDp).roundToInt())
    }

    override fun onDraw(c: Canvas) {
        r.set(0f, 0f, width.toFloat(), height.toFloat())
        Glass.draw(c, r, height / 2f, Theme.GLASS, resources.displayMetrics.density)
        val base = height / 2f - (tp.descent() + tp.ascent()) / 2
        val lw = tp.measureText(left); val rw = tp.measureText(right)
        val x0 = (width - (lw + rw + dp(16f))) / 2
        c.drawText(left, x0 + lw / 2, base, tp)
        c.drawCircle(x0 + lw + dp(8f), height / 2f, dp(1.6f), dot)
        c.drawText(right, x0 + lw + dp(16f) + rw / 2, base, tp)
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(e: MotionEvent): Boolean {
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> pressFeedback(true, 0.94f)
            MotionEvent.ACTION_UP -> {
                pressFeedback(false)
                tick()
                if (e.x < width / 2f) onLeft?.invoke() else onRight?.invoke()
            }
            MotionEvent.ACTION_CANCEL -> pressFeedback(false)
        }
        return true
    }
}

/** Red recording timer pill (pulses while paused). */
class TimerPill(ctx: Context) : View(ctx) {
    var text = "00:00:00"
        set(v) { if (v != field) { field = v; invalidate() } }
    var paused = false
        set(v) {
            if (v == field) return
            field = v
            pulse?.cancel(); pulse = null; alpha = 1f
            if (v) pulse = ValueAnimator.ofFloat(1f, 0.35f).apply {
                duration = 700; repeatMode = ValueAnimator.REVERSE; repeatCount = ValueAnimator.INFINITE
                addUpdateListener { alpha = it.animatedValue as Float }; start()
            }
        }
    private var pulse: ValueAnimator? = null
    private val tp = Theme.textPaint(ctx, 16f)
    private val bg = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Theme.RED }

    override fun onMeasure(w: Int, h: Int) = setMeasuredDimension((tp.measureText("00:00:00") + dp(20f)).roundToInt(), dp(30f).roundToInt())

    override fun onDraw(c: Canvas) {
        c.drawRoundRect(0f, 0f, width.toFloat(), height.toFloat(), dp(7f), dp(7f), bg)
        c.drawText(text, width / 2f, height / 2f - (tp.descent() + tp.ascent()) / 2, tp)
    }
}

/**
 * The shutter: white ring, red disc for video (morphs into a rounded square while
 * recording), white disc for photos. The disc shrinks while pressed.
 */
class ShutterButton(ctx: Context, private val sizeDp: Float = 78f) : View(ctx) {
    var video = true
        set(v) {
            if (v == field) return
            field = v
            colorAnim?.cancel()
            colorAnim = springFloat(colorMix, if (v) 1f else 0f, Spring.SMOOTH) { colorMix = it; invalidate() }
        }
    var recording = false
        set(v) {
            if (v == field) return
            field = v
            morphAnim?.cancel()
            morphAnim = springFloat(morph, if (v) 1f else 0f, Spring(0.74f, 0.4f)) { morph = it; invalidate() }
            contentDescription = if (v) "Stop recording" else if (video) "Record" else "Take photo"
        }
    private var colorMix = 1f
    private var morph = 0f
    private var press = 0f
    private var colorAnim: ValueAnimator? = null
    private var morphAnim: ValueAnimator? = null
    private var pressAnim: ValueAnimator? = null
    private val p = Paint(Paint.ANTI_ALIAS_FLAG)
    private val r = RectF()

    init { isClickable = true; contentDescription = "Record" }

    override fun onMeasure(w: Int, h: Int) { val s = dp(sizeDp).roundToInt(); setMeasuredDimension(s, s) }

    override fun setPressed(pressed: Boolean) {
        if (pressed != isPressed) {
            pressAnim?.cancel()
            pressAnim = springFloat(press, if (pressed) 1f else 0f, Spring.SNAPPY) { press = it; invalidate() }
        }
        super.setPressed(pressed)
    }

    override fun onDraw(c: Canvas) {
        val cx = width / 2f; val cy = height / 2f; val R = width / 2f
        p.style = Paint.Style.STROKE
        p.strokeWidth = dp(4.2f)
        p.color = Color.WHITE
        c.drawCircle(cx, cy, R - p.strokeWidth / 2, p)
        p.style = Paint.Style.FILL
        val red = Theme.RED
        p.color = Color.rgb(
            (255 + (Color.red(red) - 255) * colorMix).roundToInt(),
            (255 + (Color.green(red) - 255) * colorMix).roundToInt(),
            (255 + (Color.blue(red) - 255) * colorMix).roundToInt(),
        )
        val disc = R - dp(8f)
        val square = R * 0.4f
        val half = (disc + (square - disc) * morph) * (1f - 0.08f * press * (if (video) 1f else 1.6f))
        val corner = half * (1f - 0.78f * morph)
        r.set(cx - half, cy - half, cx + half, cy + half)
        c.drawRoundRect(r, corner, corner, p)
    }
}

/** Small white still-capture button shown while recording. */
class SnapButton(ctx: Context) : View(ctx) {
    private val p = Paint(Paint.ANTI_ALIAS_FLAG)
    init { isClickable = true; contentDescription = "Take photo" }
    override fun setPressed(pressed: Boolean) { if (pressed != isPressed) pressFeedback(pressed, 0.86f); super.setPressed(pressed) }
    override fun onMeasure(w: Int, h: Int) { val s = dp(48f).roundToInt(); setMeasuredDimension(resolveSize(s, w), resolveSize(s, h)) }
    override fun onDraw(c: Canvas) {
        val R = width / 2f
        p.style = Paint.Style.STROKE; p.strokeWidth = dp(2.5f); p.color = Color.WHITE
        c.drawCircle(R, R, R - p.strokeWidth, p)
        p.style = Paint.Style.FILL
        c.drawCircle(R, R, R - dp(6.5f), p)
    }
}

/**
 * Mode carousel: capital labels in a row, the selected one yellow and centred.
 * Tap a label or swipe; the row springs to the new mode with a haptic tick.
 */
class ModeCarousel(ctx: Context, val modes: List<String>) : View(ctx) {
    var selected = 0
        private set
    var onSelect: ((Int) -> Unit)? = null
    private var offset = 0f // px: centre of the selected label relative to the view centre
    private var anim: ValueAnimator? = null
    private val tp = Theme.textPaint(ctx, 13.5f, Theme.semibold).apply {
        letterSpacing = 0.06f
        setShadowLayer(Theme.dp(ctx, 3f), 0f, 0f, 0x8C000000.toInt()) // readable over bright scenes
    }
    private val gap = dp(26f)
    private var downX = 0f
    private var dragging = false
    private var startOffset = 0f
    private val slop = ViewConfiguration.get(ctx).scaledTouchSlop

    private fun centreOf(i: Int): Float {
        var x = 0f
        for (k in 0 until i) x += tp.measureText(modes[k]) / 2 + gap + tp.measureText(modes[k + 1]) / 2
        return x
    }

    fun select(i: Int, animate: Boolean = true, notify: Boolean = false) {
        val n = i.coerceIn(0, modes.size - 1)
        val changed = n != selected
        selected = n
        anim?.cancel()
        if (animate) anim = springFloat(offset, centreOf(n), Spring.SMOOTH) { offset = it; invalidate() } else { offset = centreOf(n); invalidate() }
        if (changed) { tick(); if (notify) onSelect?.invoke(n) }
    }

    fun step(dir: Int) = select(selected + dir, notify = true)

    override fun onMeasure(w: Int, h: Int) = setMeasuredDimension(MeasureSpec.getSize(w), dp(34f).roundToInt())

    override fun onDraw(c: Canvas) {
        val cx = width / 2f
        val base = height / 2f - (tp.descent() + tp.ascent()) / 2
        val fade = dp(56f)
        for (i in modes.indices) {
            val x = cx + centreOf(i) - offset
            val half = tp.measureText(modes[i]) / 2
            // Labels running off the screen fade out instead of being cut.
            val edge = (minOf(x - half, width - (x + half)) / fade + 1f).coerceIn(0f, 1f)
            if (edge <= 0f) continue
            val a = if (i == selected) 1f else 0.82f
            tp.color = if (i == selected) Theme.YELLOW else Color.WHITE
            tp.alpha = (255 * a * edge).toInt()
            c.drawText(modes[i], x, base, tp)
        }
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(e: MotionEvent): Boolean {
        if (!isEnabled) return false
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> { downX = e.x; dragging = false; startOffset = offset; anim?.cancel(); parent?.requestDisallowInterceptTouchEvent(true) }
            MotionEvent.ACTION_MOVE -> {
                if (!dragging && abs(e.x - downX) > slop) dragging = true
                if (dragging) { offset = (startOffset - (e.x - downX) * 0.6f).coerceIn(-gap, centreOf(modes.size - 1) + gap); invalidate() }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                if (dragging) {
                    val dx = e.x - downX
                    val target = when {
                        dx < -dp(30f) -> selected + 1
                        dx > dp(30f) -> selected - 1
                        else -> selected
                    }
                    select(target, notify = true)
                    if (target.coerceIn(0, modes.size - 1) == selected) select(selected)
                } else {
                    // Tap: the label under the finger.
                    val cx = width / 2f
                    val hit = modes.indices.minByOrNull { abs(cx + centreOf(it) - offset - e.x) } ?: selected
                    select(hit, notify = true)
                }
            }
        }
        return true
    }
}

/** Last capture: rounded thumbnail that pops in when a new clip is saved. */
class ThumbView(ctx: Context) : View(ctx) {
    private var bmp: Bitmap? = null
    private val p = Paint(Paint.ANTI_ALIAS_FLAG)
    private val rim = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; color = Color.argb(70, 255, 255, 255) }
    private val r = RectF()

    init { isClickable = true; contentDescription = "Last capture" }

    override fun setPressed(pressed: Boolean) { if (pressed != isPressed) pressFeedback(pressed, 0.9f); super.setPressed(pressed) }
    override fun onMeasure(w: Int, h: Int) { val s = dp(46f).roundToInt(); setMeasuredDimension(resolveSize(s, w), resolveSize(s, h)) }

    fun set(b: Bitmap?, pop: Boolean) {
        bmp = b
        if (b != null) {
            val s = max(width.coerceAtLeast(1).toFloat() / b.width, height.coerceAtLeast(1).toFloat() / b.height)
            p.shader = BitmapShader(b, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP).apply {
                setLocalMatrix(Matrix().apply { setScale(s, s); postTranslate((width - b.width * s) / 2, (height - b.height * s) / 2) })
            }
        } else p.shader = null
        if (pop) {
            scaleX = 0.4f; scaleY = 0.4f; alpha = 0f
            spring(Spring.BOUNCY).scaleX(1f).scaleY(1f).alpha(1f).start()
        }
        invalidate()
    }

    override fun onSizeChanged(w: Int, h: Int, ow: Int, oh: Int) { bmp?.let { set(it, false) } }

    override fun onDraw(c: Canvas) {
        r.set(0f, 0f, width.toFloat(), height.toFloat())
        val rad = dp(9f)
        if (bmp == null) { p.shader = null; p.color = Theme.SHEET }
        c.drawRoundRect(r, rad, rad, p)
        rim.strokeWidth = dp(1f)
        c.drawRoundRect(r.left + 0.5f, r.top + 0.5f, r.right - 0.5f, r.bottom - 0.5f, rad, rad, rim)
    }
}

/**
 * Zoom: lens buttons in a glass capsule (the active one shows the exact zoom in
 * yellow). Tap a button to glide to that lens; press and hold or drag sideways to
 * open the zoom wheel, an arc scale that turns under the finger; it folds away
 * shortly after you let go.
 */
class ZoomControl(ctx: Context) : View(ctx) {
    var stops: List<Float> = listOf(1f)
        set(v) { field = v; requestLayout(); invalidate() }
    var minZoom = 1f
    var maxZoom = 10f
    var zoom = 1f
        set(v) { field = v; invalidate() }
    var onZoom: ((Float) -> Unit)? = null
    var onWheel: ((Boolean) -> Unit)? = null // wheel opened / closed
    /** Lens labels turn upright with the phone. */
    var textRotation = 0f
        set(v) { field = v; invalidate() }

    private var wheel = 0f // 0 closed .. 1 open
    private var wheelAnim: ValueAnimator? = null
    private var glide: ValueAnimator? = null
    private val p = Paint(Paint.ANTI_ALIAS_FLAG)
    private val tp = Theme.textPaint(ctx, 12f, Theme.semibold)
    private val vp = Theme.textPaint(ctx, 15f, Theme.semibold)
    private val r = RectF()
    private var downX = 0f
    private var lastX = 0f
    private var dragging = false
    private var downOnCapsule = false
    private val slop = ViewConfiguration.get(ctx).scaledTouchSlop
    private val closer = Runnable { setWheel(false) }
    private val opener = Runnable { if (downOnCapsule && !dragging) { setWheel(true); thud() } }
    private val btn get() = dp(36f)
    private val capH get() = dp(46f)
    private val wheelH get() = dp(118f)

    override fun onMeasure(w: Int, h: Int) = setMeasuredDimension(MeasureSpec.getSize(w), (capH + wheelH).roundToInt())

    private fun capsule(): RectF {
        val n = stops.size
        val w = n * btn + (n - 1) * dp(4f) + dp(10f)
        return RectF(width / 2f - w / 2, height - capH, width / 2f + w / 2, height.toFloat())
    }

    private fun activeStop(): Int {
        var a = 0
        for (i in stops.indices) if (zoom >= stops[i] - 0.03f) a = i
        return a
    }

    fun label(z: Float): String {
        val v = if (abs(z - z.roundToInt()) < 0.05f && z >= 0.95f) "${z.roundToInt()}" else "%.1f".format(z).trimEnd('0').trimEnd('.').let { if (it.startsWith("0")) it.substring(1) else it }
        return v + "×"
    }

    /** Show the wheel briefly (pinch zoom on the picture). */
    fun peek() { setWheel(true); removeCallbacks(closer); postDelayed(closer, 1400) }

    private fun setWheel(open: Boolean) {
        val target = if (open) 1f else 0f
        if (wheel == target && wheelAnim?.isRunning != true) return
        wheelAnim?.cancel()
        wheelAnim = springFloat(wheel, target, if (open) Spring.SMOOTH else Spring.GENTLE) { wheel = it; invalidate() }
        onWheel?.invoke(open)
    }

    private fun uOf(z: Float) = (ln(z / minZoom) / ln(maxZoom / minZoom)).coerceIn(0f, 1f)
    private fun zOf(u: Float) = minZoom * exp(u * ln(maxZoom / minZoom))
    private val span = 3.2f // radians for the whole range

    override fun onDraw(c: Canvas) {
        val cap = capsule()
        // Wheel (fans out of the capsule).
        if (wheel > 0.01f) {
            val R = width * 0.62f
            val cx = width / 2f
            val cy = height - capH * 0.2f + R - wheelH * wheel - capH * 0.3f
            c.save()
            c.clipRect(0f, 0f, width.toFloat(), height.toFloat())
            p.style = Paint.Style.FILL
            // A dark band under the scale, fading inwards (the dial, not a filled disc).
            p.shader = android.graphics.RadialGradient(cx, cy, R, intArrayOf(Color.TRANSPARENT, Color.argb((70 * wheel).toInt(), 0, 0, 0), Color.argb((165 * wheel).toInt(), 0, 0, 0), Color.TRANSPARENT),
                floatArrayOf(0.62f, 0.8f, 0.95f, 1f), Shader.TileMode.CLAMP)
            c.drawCircle(cx, cy, R, p)
            p.shader = null
            val uz = uOf(zoom)
            var z = minZoom
            p.strokeCap = Paint.Cap.ROUND
            while (z <= maxZoom + 1e-3f) {
                val a = (uOf(z) - uz) * span
                if (abs(a) < 1.25f) {
                    val major = stops.any { abs(it - z) < 0.01f } || (z >= 10f && abs(z - z.roundToInt()) < 0.01f && z.roundToInt() % 5 == 0)
                    val fade = (1f - abs(a) / 1.25f) * wheel
                    p.color = Color.argb((255 * fade).toInt(), 255, 255, 255)
                    p.strokeWidth = dp(if (major) 1.8f else 1f)
                    val len = dp(if (major) 12f else 7f)
                    val sx = cx + R * 0.93f * sin(a); val sy = cy - R * 0.93f * cos(a)
                    val ex = cx + (R * 0.93f - len) * sin(a); val ey = cy - (R * 0.93f - len) * cos(a)
                    c.drawLine(sx, sy, ex, ey, p)
                    if (major) {
                        tp.color = p.color
                        c.save(); c.rotate(Math.toDegrees(a.toDouble()).toFloat(), cx, cy)
                        c.drawText(label(z).removeSuffix("×"), cx, cy - R * 0.93f + len + dp(14f), tp)
                        c.restore()
                    }
                }
                z += when { z < 1f -> 0.05f; z < 2f -> 0.1f; z < 5f -> 0.2f; z < 10f -> 0.5f; else -> 1f }
                z = (z * 100).roundToInt() / 100f
            }
            // Pointer and value.
            p.color = Color.argb((255 * wheel).toInt(), 255, 214, 10)
            p.strokeWidth = dp(2.4f)
            c.drawLine(cx, cy - R * 0.93f - dp(6f), cx, cy - R * 0.93f + dp(12f), p)
            vp.color = p.color
            c.drawText(label(zoom), cx, cy - R * 0.93f - dp(14f), vp)
            c.restore()
        }
        // Capsule of lens buttons (fades while the wheel is open).
        val ca = 1f - wheel * 0.85f
        if (ca > 0.02f) {
            c.saveLayerAlpha(cap, (255 * ca).toInt())
            Glass.draw(c, cap, cap.height() / 2, Theme.GLASS, resources.displayMetrics.density)
            val act = activeStop()
            for (i in stops.indices) {
                val x = cap.left + dp(5f) + btn / 2 + i * (btn + dp(4f))
                val y = cap.centerY()
                val on = i == act
                p.style = Paint.Style.FILL; p.shader = null
                p.color = Color.argb(if (on) 150 else 90, 0, 0, 0)
                c.drawCircle(x, y, if (on) btn / 2 else btn * 0.38f, p)
                val t = if (on) label(zoom) else label(stops[i]).removeSuffix("×")
                tp.color = if (on) Theme.YELLOW else Theme.TEXT
                tp.textSize = (if (on) 12.5f else 11f) * resources.displayMetrics.scaledDensity
                c.save(); c.rotate(textRotation, x, y)
                c.drawText(t, x, y - (tp.descent() + tp.ascent()) / 2, tp)
                c.restore()
            }
            tp.textSize = 12f * resources.displayMetrics.scaledDensity
            c.restore()
        }
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(e: MotionEvent): Boolean {
        val cap = capsule()
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downOnCapsule = cap.contains(e.x, e.y)
                // Outside the capsule the picture below gets the touch, unless the wheel is open.
                if (!downOnCapsule && wheel < 0.5f) return false
                downX = e.x; lastX = e.x; dragging = false
                glide?.cancel()
                removeCallbacks(closer)
                if (downOnCapsule && wheel < 0.5f) postDelayed(opener, 380)
                parent?.requestDisallowInterceptTouchEvent(true)
            }
            MotionEvent.ACTION_MOVE -> {
                if (!dragging && abs(e.x - downX) > slop) { dragging = true; removeCallbacks(opener); setWheel(true) }
                if (dragging) {
                    val R = width * 0.62f
                    val du = -(e.x - lastX) / (R * span)
                    lastX = e.x
                    val nz = zOf(uOf(zoom) + du).coerceIn(minZoom, maxZoom)
                    val crossed = stops.any { (it - zoom) * (it - nz) < 0f }
                    zoom = nz
                    if (crossed) tick()
                    onZoom?.invoke(nz)
                }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                removeCallbacks(opener)
                if (!dragging && downOnCapsule && wheel < 0.5f && e.actionMasked == MotionEvent.ACTION_UP) {
                    // Tap a lens button.
                    val i = ((e.x - cap.left - dp(5f)) / (btn + dp(4f))).toInt().coerceIn(0, stops.size - 1)
                    glideTo(stops[i])
                    tick()
                }
                postDelayed(closer, if (dragging) 1200 else 1600)
                dragging = false
            }
        }
        return true
    }

    /** Smooth zoom ramp to [target], like turning a zoom ring. */
    fun glideTo(target: Float) {
        glide?.cancel()
        val from = zoom
        glide = ValueAnimator.ofFloat(0f, 1f).apply {
            interpolator = Spring.SMOOTH; duration = 320
            addUpdateListener {
                val f = it.animatedValue as Float
                zoom = (from * exp(ln(target / from) * f))
                onZoom?.invoke(zoom)
            }
            start()
        }
    }
}

/** Glass message pill that springs in under the top bar. */
@SuppressLint("AppCompatCustomView") // platform activities, no AppCompat
class HudToast(ctx: Context) : TextView(ctx) {
    private val hide = Runnable { spring(Spring.GENTLE).alpha(0f).scaleX(0.9f).scaleY(0.9f).start() }
    init {
        setTextColor(Theme.TEXT); textSize = 13f; typeface = Theme.semibold; gravity = Gravity.CENTER
        setPadding(Theme.dpi(ctx, 14f), Theme.dpi(ctx, 7f), Theme.dpi(ctx, 14f), Theme.dpi(ctx, 7f))
        alpha = 0f
    }

    /** [badge]: yellow tag with black text (AE/AF LOCK style). */
    fun show(msg: String, badge: Boolean = false, ms: Long = 2400) {
        text = msg
        background = if (badge) Theme.pill(Theme.YELLOW, Theme.dp(context, 6f)) else GlassDrawable(Theme.dp(context, 16f), Theme.GLASS_STRONG, resources.displayMetrics.density)
        setTextColor(if (badge) Color.BLACK else Theme.TEXT)
        removeCallbacks(hide)
        animate().cancel()
        if (alpha < 0.1f) { scaleX = 0.85f; scaleY = 0.85f }
        spring(Spring.BOUNCY).alpha(1f).scaleX(1f).scaleY(1f).start()
        postDelayed(hide, ms)
    }
}

/** One option of the settings tray. */
data class TrayItem(
    val key: String, val glyph: Glyph, val caption: String, val active: Boolean = false,
    val options: List<String> = emptyList(), val selected: List<Boolean> = emptyList(), val multi: Boolean = false,
)

/**
 * Settings tray: replaces the mode carousel with a row of glass buttons (swipe up on
 * the picture or tap the chevron). Buttons with choices open them in place as a row
 * of options; the rest act directly.
 */
class TrayView(ctx: Context) : FrameLayout(ctx) {
    var onItem: ((TrayItem) -> Unit)? = null
    var onOption: ((TrayItem, Int) -> Unit)? = null
    private val mainScroll = HorizontalScrollView(ctx).apply { isHorizontalScrollBarEnabled = false; overScrollMode = OVER_SCROLL_NEVER }
    private val mainRow = LinearLayout(ctx).apply { gravity = Gravity.CENTER_VERTICAL }
    private val subScroll = HorizontalScrollView(ctx).apply { isHorizontalScrollBarEnabled = false; overScrollMode = OVER_SCROLL_NEVER; alpha = 0f; visibility = GONE }
    private val subRow = LinearLayout(ctx).apply { gravity = Gravity.CENTER_VERTICAL }
    private var openKey: String? = null
    private var items: List<TrayItem> = emptyList()
    val buttons = ArrayList<View>()

    init {
        background = GlassDrawable(Theme.dp(ctx, 26f), Theme.GLASS_STRONG, ctx.resources.displayMetrics.density)
        setPadding(0, Theme.dpi(ctx, 6f), 0, Theme.dpi(ctx, 4f))
        mainScroll.isHorizontalFadingEdgeEnabled = true; mainScroll.setFadingEdgeLength(Theme.dpi(ctx, 24f))
        subScroll.isHorizontalFadingEdgeEnabled = true; subScroll.setFadingEdgeLength(Theme.dpi(ctx, 24f))
        mainScroll.addView(mainRow)
        subScroll.addView(subRow)
        addView(mainScroll, LayoutParams(-1, -2, Gravity.CENTER))
        addView(subScroll, LayoutParams(-1, -2, Gravity.CENTER))
    }

    private fun d(v: Float) = Theme.dpi(context, v)

    fun setItems(list: List<TrayItem>) {
        items = list
        mainRow.removeAllViews(); buttons.clear()
        mainRow.setPadding(d(12f), 0, d(12f), 0)
        for (it in list) {
            val col = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL }
            val b = GlassButton(context, it.glyph, it.caption, 40f).apply { active = it.active; fillColor = 0x33FFFFFF; setOnClickListener { _ -> pick(it) } }
            col.addView(b, LinearLayout.LayoutParams(d(40f), d(40f)))
            col.addView(TextView(context).apply {
                text = it.caption; textSize = 10f; typeface = Theme.medium; setTextColor(0xD9FFFFFF.toInt())
                gravity = Gravity.CENTER; maxLines = 1
            }, LinearLayout.LayoutParams(d(62f), -2).apply { topMargin = d(3f) })
            buttons.add(b)
            mainRow.addView(col, LinearLayout.LayoutParams(-2, -2))
        }
        if (mainRow.width < width) mainRow.post { mainScroll.scrollTo(0, 0) }
        openKey?.let { k -> list.firstOrNull { it.key == k }?.let { showOptions(it, false) } }
    }

    private fun pick(it: TrayItem) {
        if (it.options.isEmpty()) { onItem?.invoke(it); return }
        showOptions(it, true)
    }

    private fun showOptions(it: TrayItem, animate: Boolean) {
        openKey = it.key
        subRow.removeAllViews()
        subRow.setPadding(d(12f), 0, d(12f), 0)
        val back = GlassButton(context, Glyph.CLOSE, "Close", 38f).apply { setOnClickListener { closeOptions() } }
        buttons.add(back)
        subRow.addView(back, LinearLayout.LayoutParams(-2, -2).apply { rightMargin = d(10f) })
        it.options.forEachIndexed { i, o ->
            val sel = it.selected.getOrElse(i) { false }
            val b = GlassButton(context, null, o, 38f, o).apply {
                glyphColor = if (sel) Theme.YELLOW else Theme.TEXT
                fillColor = if (sel) 0xB33A3A3C.toInt() else Theme.GLASS
                setOnClickListener { _ -> tick(); onOption?.invoke(it, i) }
            }
            subRow.addView(b, LinearLayout.LayoutParams(-2, -2).apply { rightMargin = d(8f) })
        }
        if (animate) {
            subScroll.visibility = VISIBLE
            subScroll.translationX = d(40f).toFloat(); subScroll.alpha = 0f
            subScroll.spring(Spring.SMOOTH).translationX(0f).alpha(1f).start()
            mainScroll.spring(Spring.SMOOTH).alpha(0f).translationX(-d(40f).toFloat()).withEndAction { mainScroll.visibility = INVISIBLE }.start()
        } else {
            subScroll.visibility = VISIBLE; subScroll.alpha = 1f; subScroll.translationX = 0f
            mainScroll.visibility = INVISIBLE
        }
    }

    fun closeOptions() {
        if (openKey == null) return
        openKey = null
        mainScroll.visibility = VISIBLE
        mainScroll.spring(Spring.SMOOTH).alpha(1f).translationX(0f).start()
        subScroll.spring(Spring.SMOOTH).alpha(0f).translationX(d(40f).toFloat()).withEndAction { subScroll.visibility = GONE }.start()
    }
}
