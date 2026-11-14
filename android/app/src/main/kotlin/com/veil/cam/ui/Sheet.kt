package com.veil.cam.ui

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Outline
import android.graphics.Paint
import android.graphics.RectF
import android.view.Gravity
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import kotlin.math.abs
import kotlin.math.roundToInt

private fun Context.d(v: Float) = Theme.dpi(this, v)

/**
 * Settings presented as a sheet that slides up over the camera, with a grabber you
 * can drag down to dismiss, and pages that push in from the right.
 */
class SheetView(ctx: Context) : FrameLayout(ctx) {
    private class Page(val title: String, val build: (Form) -> Unit, val view: ScrollView)

    private val backdrop = View(ctx).apply { setBackgroundColor(Color.BLACK); alpha = 0f }
    private val panel = FrameLayout(ctx)
    private val pages = FrameLayout(ctx)
    private val title = TextView(ctx).apply { textSize = 17f; typeface = Theme.semibold; setTextColor(Theme.TEXT); gravity = Gravity.CENTER }
    private val back = TextView(ctx).apply { textSize = 17f; typeface = Theme.regular; setTextColor(Theme.YELLOW); gravity = Gravity.CENTER_VERTICAL; visibility = INVISIBLE }
    private val done = TextView(ctx).apply { text = "Done"; textSize = 17f; typeface = Theme.semibold; setTextColor(Theme.YELLOW); gravity = Gravity.CENTER_VERTICAL }
    private val stack = ArrayList<Page>()
    var onClosed: (() -> Unit)? = null
    val isOpen get() = visibility == VISIBLE
    private var dragY = 0f
    private var tracker: VelocityTracker? = null

    init {
        visibility = GONE
        addView(backdrop, LayoutParams(-1, -1))
        backdrop.setOnClickListener { close() }
        panel.setBackgroundColor(Theme.SHEET)
        panel.outlineProvider = object : ViewOutlineProvider() {
            override fun getOutline(v: View, o: Outline) { val r = ctx.d(14f).toFloat(); o.setRoundRect(0, 0, v.width, v.height + r.toInt(), r) }
        }
        panel.clipToOutline = true
        panel.isClickable = true
        val header = FrameLayout(ctx)
        val grabber = View(ctx).apply { background = Theme.pill(0xFF5A5A5E.toInt(), ctx.d(3f).toFloat()) }
        header.addView(grabber, LayoutParams(ctx.d(36f), ctx.d(5f), Gravity.CENTER_HORIZONTAL or Gravity.TOP).apply { topMargin = ctx.d(6f) })
        header.addView(title, LayoutParams(-1, -1).apply { topMargin = ctx.d(6f) })
        header.addView(back, LayoutParams(-2, -1, Gravity.START).apply { leftMargin = ctx.d(10f); topMargin = ctx.d(6f) })
        header.addView(done, LayoutParams(-2, -1, Gravity.END).apply { rightMargin = ctx.d(16f); topMargin = ctx.d(6f) })
        back.setOnClickListener { pop() }
        done.setOnClickListener { close() }
        header.setOnTouchListener { _, e -> dragHeader(e); true }
        panel.addView(header, LayoutParams(-1, ctx.d(54f)))
        panel.addView(pages, LayoutParams(-1, -1).apply { topMargin = ctx.d(54f) })
        addView(panel, LayoutParams(-1, -1, Gravity.BOTTOM))
    }

    override fun onMeasure(w: Int, h: Int) {
        (panel.layoutParams as LayoutParams).height = (MeasureSpec.getSize(h) * 0.93f).roundToInt()
        super.onMeasure(w, h)
    }

    private fun makePage(t: String, build: (Form) -> Unit): Page {
        val col = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL; setPadding(context.d(16f), context.d(4f), context.d(16f), context.d(40f)) }
        build(Form(context, col))
        val sv = ScrollView(context).apply { isVerticalScrollBarEnabled = false; setBackgroundColor(Theme.SHEET); addView(col) }
        return Page(t, build, sv)
    }

    fun open(rootTitle: String, build: (Form) -> Unit) {
        stack.forEach { pages.removeView(it.view) }
        stack.clear()
        val pg = makePage(rootTitle, build)
        stack.add(pg)
        pages.addView(pg.view, LayoutParams(-1, -1))
        updateHeader()
        if (visibility != VISIBLE) {
            visibility = VISIBLE
            panel.translationY = resources.displayMetrics.heightPixels.toFloat()
            panel.spring(Spring(0.9f, 0.42f)).translationY(0f).start()
            backdrop.animate().alpha(0.45f).setDuration(250).start()
        }
    }

    fun push(t: String, build: (Form) -> Unit) {
        val pg = makePage(t, build)
        val prev = stack.last()
        stack.add(pg)
        pages.addView(pg.view, LayoutParams(-1, -1))
        val w = pages.width.toFloat()
        pg.view.translationX = w
        pg.view.spring(Spring(0.95f, 0.38f)).translationX(0f).start()
        prev.view.spring(Spring(0.95f, 0.38f)).translationX(-w * 0.3f).alpha(0.6f).start()
        updateHeader()
    }

    fun pop(): Boolean {
        if (stack.size <= 1) return false
        val top = stack.removeAt(stack.size - 1)
        val prev = stack.last()
        val w = pages.width.toFloat()
        // The page below may show old values: rebuild it in place.
        rebuild(prev)
        top.view.spring(Spring(0.95f, 0.38f)).translationX(w).withEndAction { pages.removeView(top.view) }.start()
        prev.view.spring(Spring(0.95f, 0.38f)).translationX(0f).alpha(1f).start()
        updateHeader()
        return true
    }

    /** Re-run the top page's builder (values changed), keeping the scroll position. */
    fun refresh() { stack.lastOrNull()?.let { rebuild(it) } }

    private fun rebuild(pg: Page) {
        val y = pg.view.scrollY
        val col = pg.view.getChildAt(0) as LinearLayout
        col.removeAllViews()
        pg.build(Form(context, col))
        pg.view.post { pg.view.scrollTo(0, y) }
    }

    fun close() {
        if (visibility != VISIBLE) return
        panel.spring(Spring.GENTLE).translationY(panel.height.toFloat()).withEndAction {
            visibility = GONE
            stack.forEach { pages.removeView(it.view) }; stack.clear()
            onClosed?.invoke()
        }.start()
        backdrop.animate().alpha(0f).setDuration(220).start()
    }

    private fun updateHeader() {
        title.text = stack.last().title
        if (stack.size > 1) { back.text = "‹ " + stack[stack.size - 2].title; back.visibility = VISIBLE } else back.visibility = INVISIBLE
    }

    private fun dragHeader(e: MotionEvent) {
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> { dragY = e.rawY; tracker?.recycle(); tracker = VelocityTracker.obtain(); panel.animate().cancel() }
            MotionEvent.ACTION_MOVE -> { panel.translationY = (e.rawY - dragY).coerceAtLeast(0f) * 0.95f }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                tracker?.computeCurrentVelocity(1000)
                val v = tracker?.yVelocity ?: 0f
                tracker?.recycle(); tracker = null
                if (panel.translationY > panel.height * 0.22f || v > 1400) close() else panel.spring(Spring.SMOOTH).translationY(0f).start()
            }
        }
        tracker?.addMovement(e)
    }
}

/** Builder for grouped settings: section header, a rounded card of rows, footer. */
class Form(private val ctx: Context, private val col: LinearLayout) {
    fun section(header: String? = null, footer: String? = null, rows: Group.() -> Unit) {
        if (header != null) col.addView(TextView(ctx).apply {
            text = header.uppercase(); textSize = 12.5f; setTextColor(Theme.SECONDARY); letterSpacing = 0.02f
            setPadding(ctx.d(16f), ctx.d(22f), ctx.d(16f), ctx.d(7f))
        }) else col.addView(View(ctx), LinearLayout.LayoutParams(-1, ctx.d(18f)))
        val card = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            background = Theme.pill(Theme.CARD, ctx.d(11f).toFloat())
            clipToOutline = true
        }
        Group(ctx, card).rows()
        col.addView(card, LinearLayout.LayoutParams(-1, -2))
        if (footer != null) note(footer)
    }

    fun note(text: String) = col.addView(TextView(ctx).apply {
        this.text = text; textSize = 12.5f; setTextColor(Theme.SECONDARY); setLineSpacing(0f, 1.1f)
        setPadding(ctx.d(16f), ctx.d(7f), ctx.d(16f), 0)
    })

    fun header(big: String, sub: String?) {
        col.addView(TextView(ctx).apply { text = big; textSize = 28f; typeface = Theme.bold; setTextColor(Theme.TEXT); setPadding(ctx.d(4f), ctx.d(4f), 0, 0) })
        if (sub != null) col.addView(TextView(ctx).apply { text = sub; textSize = 13f; setTextColor(Theme.SECONDARY); setPadding(ctx.d(4f), ctx.d(2f), 0, 0) })
    }
}

class Group(private val ctx: Context, private val card: LinearLayout) {
    private fun add(v: View) {
        if (card.childCount > 0) card.addView(View(ctx).apply { setBackgroundColor(Theme.SEPARATOR) },
            LinearLayout.LayoutParams(-1, maxOf(1, ctx.d(0.4f))).apply { leftMargin = ctx.d(16f) })
        card.addView(v, LinearLayout.LayoutParams(-1, -2))
    }

    private fun row(): LinearLayout = LinearLayout(ctx).apply {
        gravity = Gravity.CENTER_VERTICAL; minimumHeight = ctx.d(46f)
        setPadding(ctx.d(16f), ctx.d(6f), ctx.d(14f), ctx.d(6f))
        background = android.graphics.drawable.RippleDrawable(android.content.res.ColorStateList.valueOf(0x33FFFFFF), null, android.graphics.drawable.ColorDrawable(Color.WHITE))
    }

    private fun label(t: String, color: Int = Theme.TEXT) = TextView(ctx).apply { text = t; textSize = 16.5f; setTextColor(color) }

    fun switch(text: String, value: Boolean, onChange: (Boolean) -> Unit) {
        val r = row()
        r.addView(label(text), LinearLayout.LayoutParams(0, -2, 1f))
        val sw = ToggleSwitch(ctx).apply { on = value; this.onChange = onChange }
        r.addView(sw)
        r.setOnClickListener { sw.toggle() }
        add(r)
    }

    fun nav(text: String, detail: String? = null, glyph: Glyph? = null, onClick: () -> Unit) {
        val r = row()
        if (glyph != null) r.addView(GlyphTile(ctx, glyph), LinearLayout.LayoutParams(ctx.d(29f), ctx.d(29f)).apply { rightMargin = ctx.d(12f) })
        r.addView(label(text), LinearLayout.LayoutParams(0, -2, 1f))
        if (detail != null) r.addView(TextView(ctx).apply { this.text = detail; textSize = 16.5f; setTextColor(Theme.SECONDARY); maxLines = 1 },
            LinearLayout.LayoutParams(-2, -2).apply { rightMargin = ctx.d(6f) })
        r.addView(TextView(ctx).apply { this.text = "›"; textSize = 22f; setTextColor(Theme.TERTIARY) })
        r.setOnClickListener { onClick() }
        add(r)
    }

    fun check(text: String, checked: Boolean, onClick: () -> Unit) {
        val r = row()
        r.addView(label(text), LinearLayout.LayoutParams(0, -2, 1f))
        r.addView(GlyphTile(ctx, Glyph.CHECK, tile = false).apply { visibility = if (checked) View.VISIBLE else View.INVISIBLE }, LinearLayout.LayoutParams(ctx.d(22f), ctx.d(22f)))
        r.setOnClickListener { onClick() }
        add(r)
    }

    fun info(text: String, detail: String) {
        val r = row().apply { background = null }
        r.addView(label(text), LinearLayout.LayoutParams(0, -2, 1f))
        r.addView(TextView(ctx).apply { this.text = detail; textSize = 16.5f; setTextColor(Theme.SECONDARY) })
        add(r)
    }

    fun action(text: String, color: Int = Theme.YELLOW, onClick: () -> Unit) {
        val r = row()
        r.addView(label(text, color), LinearLayout.LayoutParams(0, -2, 1f))
        r.setOnClickListener { onClick() }
        add(r)
    }

    fun segmented(options: List<String>, selected: Int, title: String? = null, onChange: (Int) -> Unit) {
        val c = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL; setPadding(ctx.d(16f), ctx.d(10f), ctx.d(16f), ctx.d(10f)) }
        if (title != null) c.addView(TextView(ctx).apply { text = title; textSize = 16.5f; setTextColor(Theme.TEXT); setPadding(0, 0, 0, ctx.d(8f)) })
        c.addView(SegmentedControl(ctx, options, selected, onChange), LinearLayout.LayoutParams(-1, ctx.d(32f)))
        add(c)
    }

    fun slider(text: String, min: Int, max: Int, value: Int, fmt: (Int) -> String, onChange: (Int) -> Unit) {
        val c = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL; setPadding(ctx.d(16f), ctx.d(10f), ctx.d(16f), ctx.d(4f)) }
        val head = LinearLayout(ctx)
        head.addView(label(text), LinearLayout.LayoutParams(0, -2, 1f))
        val v = TextView(ctx).apply { this.text = fmt(value); textSize = 16.5f; setTextColor(Theme.SECONDARY); fontFeatureSettings = "tnum" }
        head.addView(v)
        c.addView(head)
        c.addView(ValueSlider(ctx, min, max, value) { x -> v.text = fmt(x); onChange(x) }, LinearLayout.LayoutParams(-1, ctx.d(40f)))
        add(c)
    }
}

/** Rounded coloured tile with a glyph (row icons), or a bare yellow glyph (check marks). */
class GlyphTile(ctx: Context, private val glyph: Glyph, private val tile: Boolean = true) : View(ctx) {
    private val p = Paint(Paint.ANTI_ALIAS_FLAG)
    override fun onDraw(c: Canvas) {
        if (tile) {
            p.color = 0xFF3A3A3C.toInt(); p.style = Paint.Style.FILL
            c.drawRoundRect(0f, 0f, width.toFloat(), height.toFloat(), width * 0.24f, width * 0.24f, p)
            p.color = Theme.TEXT
            Glyphs.draw(c, glyph, width / 2f, height / 2f, width * 0.66f, p)
        } else {
            p.color = Theme.YELLOW
            p.strokeWidth = width / 10f
            Glyphs.draw(c, glyph, width / 2f, height / 2f, width.toFloat(), p)
        }
    }
}

/** On/off switch: green track, white knob that slides with a spring. */
class ToggleSwitch(ctx: Context) : View(ctx) {
    var on = false
        set(v) { field = v; pos = if (v) 1f else 0f; invalidate() }
    var onChange: ((Boolean) -> Unit)? = null
    private var pos = 0f
    private var anim: ValueAnimator? = null
    private val p = Paint(Paint.ANTI_ALIAS_FLAG)

    init { isClickable = true; setLayerType(LAYER_TYPE_SOFTWARE, null) }

    fun toggle() {
        val v = !on
        anim?.cancel()
        on = v
        pos = if (v) 0f else 1f
        anim = springFloat(pos, if (v) 1f else 0f, Spring(0.8f, 0.32f)) { pos = it; invalidate() }
        tick()
        onChange?.invoke(v)
    }

    override fun onMeasure(w: Int, h: Int) = setMeasuredDimension(context.d(51f), context.d(31f))

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(e: MotionEvent): Boolean {
        if (e.actionMasked == MotionEvent.ACTION_UP) toggle()
        return true
    }

    override fun onDraw(c: Canvas) {
        val h = height.toFloat(); val w = width.toFloat()
        val t = pos.coerceIn(0f, 1f)
        val off = 0xFF39393D.toInt(); val g = Theme.GREEN
        p.style = Paint.Style.FILL
        p.color = Color.rgb(
            (Color.red(off) + (Color.red(g) - Color.red(off)) * t).roundToInt(),
            (Color.green(off) + (Color.green(g) - Color.green(off)) * t).roundToInt(),
            (Color.blue(off) + (Color.blue(g) - Color.blue(off)) * t).roundToInt(),
        )
        c.drawRoundRect(0f, 0f, w, h, h / 2, h / 2, p)
        val k = h / 2 - context.d(2f)
        val x = h / 2 + (w - h) * pos
        p.color = Color.WHITE
        p.setShadowLayer(context.d(2f).toFloat(), 0f, context.d(1f).toFloat(), 0x40000000)
        c.drawCircle(x, h / 2, k, p)
        p.clearShadowLayer()
    }
}

/** Segmented control with a sliding selection. */
class SegmentedControl(ctx: Context, private val options: List<String>, selected: Int, private val onChange: (Int) -> Unit) : View(ctx) {
    private var sel = selected.coerceIn(-1, options.size - 1)
    private var pos = sel.coerceAtLeast(0).toFloat()
    private var anim: ValueAnimator? = null
    private val p = Paint(Paint.ANTI_ALIAS_FLAG)
    private val tp = Theme.textPaint(ctx, 13f, Theme.semibold)
    private val r = RectF()

    init { isClickable = true }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(e: MotionEvent): Boolean {
        if (e.actionMasked == MotionEvent.ACTION_UP && options.isNotEmpty()) {
            val i = (e.x / width * options.size).toInt().coerceIn(0, options.size - 1)
            if (i != sel) {
                if (sel < 0) pos = i.toFloat()
                sel = i
                anim?.cancel()
                anim = springFloat(pos, i.toFloat(), Spring(0.86f, 0.32f)) { pos = it; invalidate() }
                tick()
                onChange(i)
            }
        }
        return true
    }

    override fun onDraw(c: Canvas) {
        val h = height.toFloat()
        p.color = Theme.FILL
        c.drawRoundRect(0f, 0f, width.toFloat(), h, context.d(9f).toFloat(), context.d(9f).toFloat(), p)
        if (options.isEmpty()) return
        val sw = width.toFloat() / options.size
        val inset = context.d(2f).toFloat()
        if (sel >= 0) {
            p.color = Theme.THUMB
            r.set(pos * sw + inset, inset, (pos + 1) * sw - inset, h - inset)
            c.drawRoundRect(r, context.d(7f).toFloat(), context.d(7f).toFloat(), p)
        }
        for (i in options.indices) {
            var t = options[i]
            while (tp.measureText(t) > sw - context.d(6f) && t.length > 2) t = t.dropLast(2) + "…"
            c.drawText(t, i * sw + sw / 2, h / 2 - (tp.descent() + tp.ascent()) / 2, tp)
            if (i > 0 && sel != i && sel != i - 1) {
                p.color = Theme.SEPARATOR
                c.drawRect(i * sw - 0.5f, h * 0.25f, i * sw + 0.5f, h * 0.75f, p)
            }
        }
    }
}

/** Slider: thin track, white fill and knob. */
class ValueSlider(ctx: Context, private val min: Int, private val max: Int, value: Int, private val onChange: (Int) -> Unit) : View(ctx) {
    private var v = value.coerceIn(min, max)
    private val p = Paint(Paint.ANTI_ALIAS_FLAG)

    init { isClickable = true; setLayerType(LAYER_TYPE_SOFTWARE, null) }

    private val knob get() = context.d(13f).toFloat()

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(e: MotionEvent): Boolean {
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN, MotionEvent.ACTION_MOVE -> {
                parent?.requestDisallowInterceptTouchEvent(true)
                val f = ((e.x - knob) / (width - 2 * knob)).coerceIn(0f, 1f)
                val nv = (min + f * (max - min)).roundToInt()
                if (nv != v) {
                    if (nv == min || nv == max) tick()
                    v = nv; invalidate(); onChange(nv)
                }
            }
        }
        return true
    }

    override fun onDraw(c: Canvas) {
        val cy = height / 2f
        val f = if (max > min) (v - min).toFloat() / (max - min) else 0f
        val x = knob + f * (width - 2 * knob)
        val th = context.d(2f).toFloat()
        p.color = Theme.FILL
        c.drawRoundRect(knob, cy - th, width - knob, cy + th, th, th, p)
        p.color = Color.WHITE
        c.drawRoundRect(knob, cy - th, x, cy + th, th, th, p)
        p.setShadowLayer(context.d(3f).toFloat(), 0f, context.d(1f).toFloat(), 0x55000000)
        c.drawCircle(x, cy, knob, p)
        p.clearShadowLayer()
    }
}
