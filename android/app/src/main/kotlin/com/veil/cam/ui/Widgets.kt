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
    const val BG = 0xFF0B0B0C.toInt()
    const val SURFACE = 0xFF141416.toInt()
    const val SURFACE2 = 0xFF1E1E21.toInt()
    const val SURFACE3 = 0xFF2A2A2E.toInt()
    const val SCRIM = 0xB30B0B0C.toInt()
    const val ACCENT = 0xFFE4F17A.toInt()
    const val TEXT = 0xFFF4F4F5.toInt()
    const val DIM = 0xFFA1A1AA.toInt()
    const val FAINT = 0xFF5F5F67.toInt()
    const val ON_LIGHT = 0xFF0B0B0C.toInt()
    const val REC = 0xFFFF3B3B.toInt()
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
        val s = Theme.dpi(context, 44f)
        setMeasuredDimension(s, s)
    }

    override fun onDraw(c: Canvas) {
        val r = width / 2f
        paint.style = Paint.Style.FILL
        paint.color = if (on) accent else Theme.SCRIM
        c.drawCircle(r, r, r - 1, paint)
        paint.color = if (on) Theme.ON_LIGHT else Theme.TEXT
        paint.textAlign = Paint.Align.CENTER
        paint.typeface = Theme.mono
        paint.textSize = Theme.dp(context, if (label.length > 2) 10f else 12f)
        c.drawText(label, r, r - (paint.descent() + paint.ascent()) / 2, paint)
    }
}

/** Large record button: white ring, red disc that morphs to a rounded square while recording. */
class RecordButton(ctx: Context) : View(ctx) {
    var recording = false
        set(v) {
            if (field == v) return
            field = v
            ValueAnimator.ofFloat(morph, if (v) 1f else 0f).apply {
                duration = 180
                addUpdateListener { morph = it.animatedValue as Float; invalidate() }
                start()
            }
        }
    var enabledLook = true
        set(v) { field = v; invalidate() }
    private var morph = 0f
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)

    init { contentDescription = "Record"; isClickable = true }

    override fun onMeasure(w: Int, h: Int) {
        val s = Theme.dpi(context, 76f)
        setMeasuredDimension(s, s)
    }

    override fun onDraw(c: Canvas) {
        val cx = width / 2f; val cy = height / 2f
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = Theme.dp(context, 4f)
        paint.color = if (enabledLook) Theme.TEXT else Theme.FAINT
        c.drawCircle(cx, cy, cx - paint.strokeWidth, paint)
        paint.style = Paint.Style.FILL
        paint.color = if (enabledLook) Theme.REC else Theme.FAINT
        val big = cx - Theme.dp(context, 11f)
        val small = cx * 0.42f
        val half = big + (small - big) * morph
        val radius = half * (1f - 0.7f * morph)
        c.drawRoundRect(RectF(cx - half, cy - half, cx + half, cy + half), radius, radius, paint)
    }
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
            v.setTextColor(if (i == sel) Theme.ON_LIGHT else Theme.DIM)
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
        setTextColor(if (primary) Theme.ON_LIGHT else Theme.TEXT)
        background = Theme.pill(if (primary) Theme.TEXT else Theme.SURFACE2, Theme.dp(ctx, 18f))
        setPadding(Theme.dpi(ctx, 16f), 0, Theme.dpi(ctx, 16f), 0)
        minHeight = Theme.dpi(ctx, 36f)
        setOnClickListener { onClick() }
    }
}
