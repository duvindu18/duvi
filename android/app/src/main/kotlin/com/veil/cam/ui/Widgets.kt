package com.veil.cam.ui

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.SeekBar
import android.widget.Switch
import android.widget.TextView
import android.widget.OverScroller
import kotlin.math.abs
import kotlin.math.roundToInt

object Theme {
    // Capsule design: pure black capsules, white type, one red accent.
    const val BG = 0xFF000000.toInt()
    const val SURFACE = 0xF2000000.toInt()   // capsule fill (slightly see-through over video)
    const val SURFACE2 = 0xFF1C1C1E.toInt()
    const val SURFACE3 = 0xFF2C2C2E.toInt()
    const val SCRIM = 0xE6000000.toInt()
    const val ACCENT = 0xFFFF453A.toInt()
    const val TEXT = 0xFFFFFFFF.toInt()
    const val DIM = 0xFFA1A1A6.toInt()
    const val FAINT = 0xFF636366.toInt()
    const val ON_LIGHT = 0xFFFFFFFF.toInt()
    const val REC = 0xFFFF3B30.toInt()
    const val WARN = 0xFFF5C451.toInt()

    fun dp(ctx: Context, v: Float) = v * ctx.resources.displayMetrics.density
    fun dpi(ctx: Context, v: Float) = dp(ctx, v).roundToInt()

    fun pill(color: Int, radius: Float) = GradientDrawable().apply { setColor(color); cornerRadius = radius }

    val mono: Typeface = Typeface.create("sans-serif-condensed", Typeface.BOLD)
    val regular: Typeface = Typeface.create("sans-serif", Typeface.NORMAL)
    val medium: Typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
}

fun View.haptic() = performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)

/** Status-bar parameter: small caption over a bold value; tap to open its control. */
class ParamChip(ctx: Context, caption: String) : LinearLayout(ctx) {
    private val cap = TextView(ctx).apply {
        text = caption; setTextColor(Theme.FAINT); textSize = 9f; typeface = Theme.medium; letterSpacing = 0.12f
    }
    val value = TextView(ctx).apply { setTextColor(Theme.TEXT); textSize = 14f; typeface = Theme.mono }
    var active = false
        set(v) { field = v; refresh() }
    var auto = false
        set(v) { field = v; refresh() }

    init {
        orientation = VERTICAL
        gravity = Gravity.CENTER_HORIZONTAL
        val p = Theme.dpi(ctx, 8f)
        setPadding(p, Theme.dpi(ctx, 4f), p, Theme.dpi(ctx, 4f))
        addView(cap); addView(value)
        isClickable = true
        refresh()
    }

    fun set(text: String) { value.text = text }

    private fun refresh() {
        background = if (active) Theme.pill(Theme.SURFACE3, Theme.dp(context, 10f)) else null
        value.setTextColor(if (active) Theme.ACCENT else if (auto) Theme.DIM else Theme.TEXT)
        cap.setTextColor(if (active) Theme.ACCENT else Theme.FAINT)
    }
}

/** Round toggle with a short text label (Z, FP, FC...). */
class RoundToggle(ctx: Context, private val label: String, private val hint: String) : View(ctx) {
    var on = false
        set(v) { field = v; invalidate() }
    var accent = Theme.ACCENT
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)

    init {
        contentDescription = hint
        isClickable = true
    }

    override fun onMeasure(w: Int, h: Int) {
        val s = Theme.dpi(context, 42f)
        setMeasuredDimension(s, s)
    }

    override fun onDraw(c: Canvas) {
        val r = width / 2f
        paint.style = Paint.Style.FILL
        paint.color = if (on) Theme.TEXT else Theme.SURFACE3
        c.drawCircle(r, r, r - 1, paint)
        paint.color = if (on) Color.BLACK else Theme.TEXT
        paint.textAlign = Paint.Align.CENTER
        paint.typeface = Theme.mono
        paint.textSize = Theme.dp(context, if (label.length > 2) 10f else 12f)
        c.drawText(label, r, r - (paint.descent() + paint.ascent()) / 2, paint)
    }
}

/** Record / stop: dark red disc with a red dot that morphs into a red square while recording. */
class RecordButton(ctx: Context, private val sizeDp: Float = 64f) : View(ctx) {
    var recording = false
        set(v) {
            if (field == v) return
            field = v
            ValueAnimator.ofFloat(morph, if (v) 1f else 0f).apply {
                duration = 200
                addUpdateListener { morph = it.animatedValue as Float; invalidate() }
                start()
            }
            contentDescription = if (v) "Stop recording" else "Record"
        }
    var enabledLook = true
        set(v) { field = v; invalidate() }
    private var morph = 0f
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)

    init { contentDescription = "Record"; isClickable = true }

    override fun onMeasure(w: Int, h: Int) {
        val s = Theme.dpi(context, sizeDp)
        setMeasuredDimension(s, s)
    }

    override fun onDraw(c: Canvas) {
        val cx = width / 2f; val cy = height / 2f
        paint.style = Paint.Style.FILL
        paint.color = Color.argb(if (enabledLook) 90 else 40, 255, 59, 48)
        c.drawCircle(cx, cy, cx, paint)
        paint.color = if (enabledLook) Theme.REC else Theme.FAINT
        val dot = cx * 0.46f
        val sq = cx * 0.34f
        val half = dot + (sq - dot) * morph
        val radius = half * (1f - 0.72f * morph)
        c.drawRoundRect(RectF(cx - half, cy - half, cx + half, cy + half), radius, radius, paint)
    }
}

enum class Icon { PAUSE, PLAY, GALLERY, PHOTO, FLIP, MENU, ORIENT, CAMERA }

/** Round dark button with a drawn icon (the pause button of the reference). */
class IconButton(ctx: Context, var icon: Icon, desc: String, private val sizeDp: Float = 52f) : View(ctx) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    var dim = false
        set(v) { field = v; invalidate() }

    init { contentDescription = desc; isClickable = true }

    override fun onMeasure(w: Int, h: Int) {
        val s = Theme.dpi(context, sizeDp)
        setMeasuredDimension(s, s)
    }

    override fun onDraw(c: Canvas) {
        val r = width / 2f
        paint.style = Paint.Style.FILL
        paint.color = Theme.SURFACE3
        c.drawCircle(r, r, r, paint)
        paint.color = if (dim) Theme.FAINT else Theme.TEXT
        paint.strokeWidth = Theme.dp(context, 2f)
        paint.strokeCap = Paint.Cap.ROUND
        paint.strokeJoin = Paint.Join.ROUND
        val u = r / 12f
        when (icon) {
            Icon.PAUSE -> { c.drawRoundRect(r - 4.5f * u, r - 5.5f * u, r - 1.5f * u, r + 5.5f * u, u, u, paint); c.drawRoundRect(r + 1.5f * u, r - 5.5f * u, r + 4.5f * u, r + 5.5f * u, u, u, paint) }
            Icon.PLAY -> c.drawPath(android.graphics.Path().apply { moveTo(r - 3.5f * u, r - 5.5f * u); lineTo(r + 5.5f * u, r); lineTo(r - 3.5f * u, r + 5.5f * u); close() }, paint)
            Icon.GALLERY -> {
                paint.style = Paint.Style.STROKE
                c.drawRoundRect(r - 5f * u, r - 3f * u, r + 3f * u, r + 5f * u, 1.5f * u, 1.5f * u, paint)
                c.drawLine(r - 2.5f * u, r - 5.5f * u, r + 5.5f * u, r - 5.5f * u, paint)
                c.drawLine(r + 5.5f * u, r - 5.5f * u, r + 5.5f * u, r + 2.5f * u, paint)
            }
            Icon.PHOTO -> { paint.style = Paint.Style.STROKE; c.drawCircle(r, r, 5.5f * u, paint); paint.style = Paint.Style.FILL; c.drawCircle(r, r, 3.2f * u, paint) }
            Icon.FLIP -> {
                paint.style = Paint.Style.STROKE
                c.drawArc(RectF(r - 5f * u, r - 5f * u, r + 5f * u, r + 5f * u), 200f, 140f, false, paint)
                c.drawArc(RectF(r - 5f * u, r - 5f * u, r + 5f * u, r + 5f * u), 20f, 140f, false, paint)
                c.drawLine(r + 4.7f * u, r - 1.7f * u, r + 5.9f * u, r - 4.2f * u, paint)
                c.drawLine(r - 4.7f * u, r + 1.7f * u, r - 5.9f * u, r + 4.2f * u, paint)
            }
            Icon.MENU -> {
                for (k in -1..1) {
                    val y = r + k * 3.5f * u
                    c.drawLine(r - 5.5f * u, y, r + 5.5f * u, y, paint)
                    paint.style = Paint.Style.FILL
                    c.drawCircle(r + (if (k == 0) 2.5f else -2.5f) * u, y, 1.6f * u, paint)
                }
            }
            Icon.ORIENT -> {
                paint.style = Paint.Style.STROKE
                c.drawRoundRect(r - 3f * u, r - 5.5f * u, r + 3f * u, r + 5.5f * u, 1.2f * u, 1.2f * u, paint)
                c.drawArc(RectF(r - 7f * u, r - 7f * u, r + 7f * u, r + 7f * u), -60f, 50f, false, paint)
            }
            Icon.CAMERA -> {
                c.drawRoundRect(r - 6f * u, r - 3.5f * u, r + 2f * u, r + 3.5f * u, 1.5f * u, 1.5f * u, paint)
                c.drawPath(android.graphics.Path().apply { moveTo(r + 2.5f * u, r - 0.8f * u); lineTo(r + 6f * u, r - 3f * u); lineTo(r + 6f * u, r + 3f * u); lineTo(r + 2.5f * u, r + 0.8f * u); close() }, paint)
            }
        }
        paint.style = Paint.Style.FILL
    }
}

/**
 * Status pill (top): "● REC" in red while recording, "● STBY" otherwise, with the
 * format and a camera glyph, as in the reference design.
 */
class StatusPill(ctx: Context) : View(ctx) {
    var recording = false
        set(v) { field = v; invalidate() }
    var paused = false
        set(v) { field = v; invalidate() }
    var format = ""
        set(v) { field = v; requestLayout(); invalidate() }
    private val p = Paint(Paint.ANTI_ALIAS_FLAG)
    private val start = System.currentTimeMillis()

    private fun label() = if (recording) (if (paused) "PAUSED" else "REC") else "STBY"

    override fun onMeasure(w: Int, h: Int) {
        p.textSize = Theme.dp(context, 15f); p.typeface = Theme.medium
        val tw = p.measureText(label()) + p.measureText(format).let { if (format.isEmpty()) 0f else it + Theme.dp(context, 18f) }
        setMeasuredDimension((tw + Theme.dp(context, 92f)).toInt(), Theme.dpi(context, 40f))
    }

    override fun onDraw(c: Canvas) {
        val h = height.toFloat()
        p.style = Paint.Style.FILL
        p.color = Theme.SURFACE
        c.drawRoundRect(0f, 0f, width.toFloat(), h, h / 2, h / 2, p)
        val blink = recording && !paused && ((System.currentTimeMillis() - start) / 600) % 2 == 0L
        p.color = if (recording) (if (blink || paused) Theme.REC else Color.argb(110, 255, 59, 48)) else Theme.FAINT
        c.drawCircle(h * 0.62f, h / 2, h * 0.17f, p)
        p.color = Theme.TEXT
        p.textSize = Theme.dp(context, 15f); p.typeface = Theme.medium
        p.textAlign = Paint.Align.LEFT
        val base = h / 2 - (p.descent() + p.ascent()) / 2
        var x = h * 0.95f
        c.drawText(label(), x, base, p)
        x += p.measureText(label()) + Theme.dp(context, 14f)
        if (format.isNotEmpty()) {
            p.color = Theme.DIM; p.textSize = Theme.dp(context, 12f); p.typeface = Theme.mono
            c.drawText(format, x, h / 2 - (p.descent() + p.ascent()) / 2, p)
        }
        // Video camera glyph at the right end.
        p.color = Theme.TEXT
        val r = width - h * 0.62f
        val u = h / 24f
        c.drawRoundRect(r - 6f * u, h / 2 - 4f * u, r + 2f * u, h / 2 + 4f * u, 1.6f * u, 1.6f * u, p)
        c.drawPath(android.graphics.Path().apply { moveTo(r + 2.5f * u, h / 2 - u); lineTo(r + 6.5f * u, h / 2 - 3.5f * u); lineTo(r + 6.5f * u, h / 2 + 3.5f * u); lineTo(r + 2.5f * u, h / 2 + u); close() }, p)
        if (recording && !paused) postInvalidateDelayed(300)
    }
}

/**
 * Vertical tick ruler with a red centre mark (the zoom wheel of the reference).
 * Drag up / down to zoom; ticks scroll with the value.
 */
class ZoomRuler(ctx: Context) : View(ctx) {
    var onDrag: ((Float) -> Unit)? = null // relative steps (+ = zoom in)
    private var offset = 0f
    private var lastY = 0f
    private val p = Paint(Paint.ANTI_ALIAS_FLAG)

    override fun onMeasure(w: Int, h: Int) = setMeasuredDimension(Theme.dpi(context, 30f), Theme.dpi(context, 56f))

    @android.annotation.SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(e: MotionEvent): Boolean {
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> { lastY = e.y; parent?.requestDisallowInterceptTouchEvent(true) }
            MotionEvent.ACTION_MOVE -> {
                val dy = lastY - e.y
                lastY = e.y
                offset += dy
                onDrag?.invoke(dy / Theme.dp(context, 90f))
                invalidate()
            }
        }
        return true
    }

    override fun onDraw(c: Canvas) {
        val cx = width / 2f
        val step = Theme.dp(context, 7f)
        val mid = height / 2f
        p.strokeWidth = Theme.dp(context, 1.4f)
        p.strokeCap = Paint.Cap.ROUND
        val shift = ((offset % step) + step) % step
        var y = mid - step * 4 + shift
        while (y <= mid + step * 4) {
            val fade = 1f - abs(y - mid) / (step * 4.5f)
            p.color = Color.argb((60 + 150 * fade).toInt(), 255, 255, 255)
            val half = Theme.dp(context, 5f)
            c.drawLine(cx - half, y, cx + half, y, p)
            y += step
        }
        p.color = Theme.REC
        p.strokeWidth = Theme.dp(context, 2f)
        c.drawLine(cx - Theme.dp(context, 11f), mid, cx + Theme.dp(context, 11f), mid, p)
    }
}

/** Black rounded container (the capsules). */
fun capsule(ctx: Context, vertical: Boolean = false, radiusDp: Float = 999f): LinearLayout = LinearLayout(ctx).apply {
    orientation = if (vertical) LinearLayout.VERTICAL else LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER
    background = Theme.pill(Theme.SURFACE, Theme.dp(ctx, if (radiusDp > 200f) 40f else radiusDp))
}

/** Circular text button (photo, gallery, settings). */
class CircleButton(ctx: Context, private val label: String, desc: String, private val sizeDp: Float = 48f) : View(ctx) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    var highlight = false
        set(v) { field = v; invalidate() }

    init { contentDescription = desc; isClickable = true }

    override fun onMeasure(w: Int, h: Int) {
        val s = Theme.dpi(context, sizeDp)
        setMeasuredDimension(s, s)
    }

    override fun onDraw(c: Canvas) {
        val r = width / 2f
        paint.style = Paint.Style.FILL
        paint.color = if (highlight) Theme.ACCENT else Theme.SCRIM
        c.drawCircle(r, r, r - 1, paint)
        paint.color = if (highlight) Theme.ON_LIGHT else Theme.TEXT
        paint.textAlign = Paint.Align.CENTER
        paint.typeface = Theme.mono
        paint.textSize = Theme.dp(context, if (label.length > 3) 10f else 13f)
        c.drawText(label, r, r - (paint.descent() + paint.ascent()) / 2, paint)
    }
}

/**
 * Horizontal tape dial: a ruler of discrete values under a fixed centre mark,
 * dragged or flung like a lens ring; snaps to the nearest value.
 */
class DialView(ctx: Context) : View(ctx) {
    var labels: List<String> = emptyList()
        set(v) { field = v; index = index.coerceIn(0, (v.size - 1).coerceAtLeast(0)); invalidate() }
    var index = 0
        private set
    var onChange: ((Int) -> Unit)? = null
    private val spacing = Theme.dp(ctx, 14f)
    private var offset = 0f // px scrolled from index 0
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val scroller = OverScroller(ctx)
    private var tracker: VelocityTracker? = null
    private var lastX = 0f

    fun setIndex(i: Int) {
        index = i.coerceIn(0, (labels.size - 1).coerceAtLeast(0))
        offset = index * spacing
        invalidate()
    }

    override fun onMeasure(w: Int, h: Int) {
        setMeasuredDimension(MeasureSpec.getSize(w), Theme.dpi(context, 64f))
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(e: MotionEvent): Boolean {
        if (labels.isEmpty()) return false
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                scroller.forceFinished(true)
                tracker = VelocityTracker.obtain()
                lastX = e.x
                parent?.requestDisallowInterceptTouchEvent(true)
            }
            MotionEvent.ACTION_MOVE -> {
                offset = (offset - (e.x - lastX)).coerceIn(0f, (labels.size - 1) * spacing)
                lastX = e.x
                snapIndex(false)
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                tracker?.computeCurrentVelocity(1000)
                val vx = tracker?.xVelocity ?: 0f
                tracker?.recycle(); tracker = null
                if (abs(vx) > 600) {
                    scroller.fling(offset.toInt(), 0, -vx.toInt(), 0, 0, ((labels.size - 1) * spacing).toInt(), 0, 0)
                    postInvalidateOnAnimation()
                } else settle()
            }
        }
        tracker?.addMovement(e)
        invalidate()
        return true
    }

    private fun settle() {
        snapIndex(true)
        offset = index * spacing
        invalidate()
    }

    private fun snapIndex(final: Boolean) {
        val i = (offset / spacing).roundToInt().coerceIn(0, labels.size - 1)
        if (i != index) {
            index = i
            haptic()
            onChange?.invoke(i)
        } else if (final) onChange?.invoke(i)
    }

    override fun computeScroll() {
        if (scroller.computeScrollOffset()) {
            offset = scroller.currX.toFloat()
            snapIndex(false)
            if (scroller.isFinished) settle()
            postInvalidateOnAnimation()
        }
    }

    override fun onDraw(c: Canvas) {
        val cx = width / 2f
        val h = height.toFloat()
        paint.color = Theme.SCRIM
        c.drawRoundRect(0f, 0f, width.toFloat(), h, h / 2, h / 2, paint)
        val first = ((offset - cx) / spacing).toInt() - 1
        val last = ((offset + cx) / spacing).toInt() + 1
        paint.textAlign = Paint.Align.CENTER
        paint.typeface = Theme.mono
        for (i in first.coerceAtLeast(0)..last.coerceAtMost(labels.size - 1)) {
            val x = cx + i * spacing - offset
            val major = i % 5 == 0 || labels.size <= 24
            val fade = 1f - (abs(x - cx) / cx).coerceIn(0f, 1f)
            paint.color = Color.argb((80 + 175 * fade).toInt(), 244, 244, 245)
            paint.strokeWidth = Theme.dp(context, 1.5f)
            val top = if (major) h * 0.18f else h * 0.28f
            c.drawLine(x, top, x, h * 0.42f, paint)
            if (major && abs(x - cx) > spacing * 1.5f) {
                paint.textSize = Theme.dp(context, 10f)
                c.drawText(labels[i], x, h * 0.78f, paint)
            }
        }
        // Centre mark and value.
        paint.color = Theme.ACCENT
        paint.strokeWidth = Theme.dp(context, 3f)
        c.drawLine(cx, h * 0.1f, cx, h * 0.48f, paint)
        if (labels.isNotEmpty()) {
            paint.textSize = Theme.dp(context, 15f)
            c.drawText(labels[index], cx, h * 0.82f, paint)
        }
    }
}

/** Settings rows for the side sheet. */
object Rows {
    fun section(ctx: Context, title: String) = TextView(ctx).apply {
        text = title.uppercase(); setTextColor(Theme.FAINT); textSize = 10f; typeface = Theme.medium; letterSpacing = 0.14f
        setPadding(0, Theme.dpi(ctx, 18f), 0, Theme.dpi(ctx, 6f))
    }

    fun hint(ctx: Context, text: String) = TextView(ctx).apply {
        this.text = text; setTextColor(Theme.FAINT); textSize = 11f
        setPadding(0, 0, 0, Theme.dpi(ctx, 6f))
    }

    fun switch(ctx: Context, label: String, value: Boolean, onChange: (Boolean) -> Unit): View {
        val row = LinearLayout(ctx).apply { gravity = Gravity.CENTER_VERTICAL; minimumHeight = Theme.dpi(ctx, 44f) }
        row.addView(TextView(ctx).apply { text = label; setTextColor(Theme.TEXT); textSize = 14f }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        val sw = Switch(ctx).apply {
            isChecked = value
            thumbTintList = ColorStateList(arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf()), intArrayOf(Theme.ON_LIGHT, Theme.DIM))
            trackTintList = ColorStateList(arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf()), intArrayOf(Theme.ACCENT, Theme.SURFACE3))
            setOnCheckedChangeListener { _, b -> onChange(b) }
        }
        row.addView(sw)
        row.setOnClickListener { sw.toggle() }
        return row
    }

    /** Segmented pills; [selected] index. */
    fun segments(ctx: Context, options: List<String>, selected: Int, onChange: (Int) -> Unit): View {
        val row = LinearLayout(ctx).apply { setPadding(0, Theme.dpi(ctx, 4f), 0, Theme.dpi(ctx, 4f)) }
        val views = ArrayList<TextView>()
        fun paint(sel: Int) = views.forEachIndexed { i, v ->
            v.background = Theme.pill(if (i == sel) Theme.TEXT else Theme.SURFACE2, Theme.dp(ctx, 16f))
            v.setTextColor(if (i == sel) Color.BLACK else Theme.DIM)
        }
        options.forEachIndexed { i, o ->
            val v = TextView(ctx).apply {
                text = o; textSize = 13f; typeface = Theme.medium; gravity = Gravity.CENTER
                setPadding(Theme.dpi(ctx, 12f), 0, Theme.dpi(ctx, 12f), 0)
                minHeight = Theme.dpi(ctx, 32f)
                setOnClickListener { paint(i); onChange(i) }
            }
            views.add(v)
            row.addView(v, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, Theme.dpi(ctx, 32f)).apply { rightMargin = Theme.dpi(ctx, 6f) })
        }
        paint(selected)
        return android.widget.HorizontalScrollView(ctx).apply { isHorizontalScrollBarEnabled = false; addView(row) }
    }

    fun slider(ctx: Context, label: String, min: Int, max: Int, value: Int, fmt: (Int) -> String, onChange: (Int) -> Unit): View {
        val col = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL; setPadding(0, Theme.dpi(ctx, 6f), 0, Theme.dpi(ctx, 6f)) }
        val head = LinearLayout(ctx)
        head.addView(TextView(ctx).apply { text = label; setTextColor(Theme.TEXT); textSize = 14f }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        val v = TextView(ctx).apply { text = fmt(value); setTextColor(Theme.ACCENT); textSize = 13f; typeface = Theme.mono }
        head.addView(v)
        col.addView(head)
        col.addView(SeekBar(ctx).apply {
            this.max = max - min
            progress = value - min
            progressTintList = ColorStateList.valueOf(Theme.ACCENT)
            thumbTintList = ColorStateList.valueOf(Theme.TEXT)
            progressBackgroundTintList = ColorStateList.valueOf(Theme.SURFACE3)
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(s: SeekBar, p: Int, user: Boolean) { if (user) { v.text = fmt(p + min); onChange(p + min) } }
                override fun onStartTrackingTouch(s: SeekBar) {}
                override fun onStopTrackingTouch(s: SeekBar) {}
            })
        })
        return col
    }

    fun button(ctx: Context, label: String, primary: Boolean = false, onClick: () -> Unit) = TextView(ctx).apply {
        text = label; textSize = 13f; typeface = Theme.medium; gravity = Gravity.CENTER
        setTextColor(if (primary) Color.BLACK else Theme.TEXT)
        background = Theme.pill(if (primary) Theme.TEXT else Theme.SURFACE2, Theme.dp(ctx, 18f))
        setPadding(Theme.dpi(ctx, 16f), 0, Theme.dpi(ctx, 16f), 0)
        minHeight = Theme.dpi(ctx, 36f)
        setOnClickListener { onClick() }
    }
}
