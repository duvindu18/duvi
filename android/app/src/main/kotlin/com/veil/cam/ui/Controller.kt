package com.veil.cam.ui

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewConfiguration
import android.widget.OverScroller
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

data class ControlSpec(val key: String, val name: String, val glyph: Glyph)

/** Where the controller reads and writes the camera's values. */
interface ControlSource {
    fun labels(key: String): List<String>
    fun index(key: String): Int
    fun set(key: String, i: Int)
    /** null when the control has no automatic mode. */
    fun auto(key: String): Boolean?
    fun toggleAuto(key: String)
    fun value(key: String): String
}

/**
 * Camera-control overlay. A picker of controls on a gently curved row (slide to
 * choose, tap to open), then a curved ruler for the chosen control: slide to
 * adjust with a tick on every step, fling for big changes, AUTO on the left,
 * the control's icon on the right goes back to the picker. Fades away after a
 * few seconds without a touch.
 */
class ControllerView(ctx: Context, private val source: ControlSource) : View(ctx) {
    var specs: List<ControlSpec> = emptyList()
        set(v) { field = v; pickPos = pickPos.coerceIn(0f, (v.size - 1).coerceAtLeast(0).toFloat()); invalidate() }
    var onVisible: ((Boolean) -> Unit)? = null
    val key: String? get() = if (adjusting) specs.getOrNull(pickIndex())?.key else null
    val isOpen get() = visibility == VISIBLE && !closing

    private var adjusting = false
    private var morph = 0f // 0 picker, 1 ruler
    private var morphAnim: ValueAnimator? = null
    private var pickPos = 0f
    private var pos = 0f // ruler position in steps
    private var labels: List<String> = emptyList()
    private var settleAnim: ValueAnimator? = null
    private val scroller = OverScroller(ctx)
    private var tracker: VelocityTracker? = null
    private var downX = 0f
    private var lastX = 0f
    private var dragged = false
    private var closing = false
    private val slop = ViewConfiguration.get(ctx).scaledTouchSlop
    private val hide = Runnable { dismiss() }

    private val p = Paint(Paint.ANTI_ALIAS_FLAG)
    private val nameP = Theme.textPaint(ctx, 11f, Theme.semibold, Theme.SECONDARY).apply { letterSpacing = 0.08f }
    private val valueP = Theme.textPaint(ctx, 19f, Theme.semibold)
    private val titleP = Theme.textPaint(ctx, 16f, Theme.semibold)
    private val tickP = Theme.textPaint(ctx, 10f, Theme.medium, Theme.SECONDARY)
    private val autoP = Theme.textPaint(ctx, 11f, Theme.bold)
    private val r = RectF()
    private fun dp(v: Float) = Theme.dp(context, v)
    private val iconStep get() = dp(60f)
    private val tickStep get() = if (labels.size <= 16) dp(24f) else dp(12f)

    init { visibility = GONE; isClickable = true }

    override fun onMeasure(w: Int, h: Int) = setMeasuredDimension(MeasureSpec.getSize(w), dp(132f).roundToInt())

    private fun pickIndex() = pickPos.roundToInt().coerceIn(0, (specs.size - 1).coerceAtLeast(0))

    /** Open on [key]'s ruler, or on the picker when null. */
    fun open(key: String? = null) {
        if (specs.isEmpty()) return
        closing = false
        val i = specs.indexOfFirst { it.key == key }
        if (i >= 0) pickPos = i.toFloat()
        setAdjust(i >= 0, animate = visibility == VISIBLE)
        if (visibility != VISIBLE) {
            visibility = VISIBLE
            alpha = 0f; translationY = dp(14f); scaleX = 0.96f; scaleY = 0.96f
            spring(Spring.SMOOTH).alpha(1f).translationY(0f).scaleX(1f).scaleY(1f).withEndAction(null).start()
            onVisible?.invoke(true)
        }
        poke()
    }

    fun dismiss() {
        if (visibility != VISIBLE || closing) return
        closing = true
        removeCallbacks(hide)
        spring(Spring.GENTLE).alpha(0f).translationY(dp(10f)).withEndAction { visibility = GONE; closing = false; onVisible?.invoke(false) }.start()
    }

    /** Values changed elsewhere (auto readout, another control): follow them. */
    fun refresh() {
        if (!adjusting || dragged || !scroller.isFinished) { invalidate(); return }
        val k = key ?: return
        labels = source.labels(k)
        if (settleAnim?.isRunning != true) pos = source.index(k).toFloat()
        invalidate()
    }

    private fun poke() { removeCallbacks(hide); postDelayed(hide, 4500) }

    private fun setAdjust(on: Boolean, animate: Boolean) {
        adjusting = on
        if (on) {
            val k = specs[pickIndex()].key
            labels = source.labels(k)
            pos = source.index(k).toFloat()
        }
        morphAnim?.cancel()
        val target = if (on) 1f else 0f
        if (animate) morphAnim = springFloat(morph, target, Spring.SMOOTH) { morph = it; invalidate() } else { morph = target; invalidate() }
    }

    // ---- drawing --------------------------------------------------------------------------------
    override fun onDraw(c: Canvas) {
        val pad = dp(10f)
        r.set(pad, 0f, width - pad, height.toFloat())
        Glass.draw(c, r, dp(30f), Theme.GLASS_STRONG, resources.displayMetrics.density)
        c.save(); c.clipRect(r)
        if (morph < 0.99f) drawPicker(c, 1f - morph)
        if (morph > 0.01f) drawRuler(c, morph)
        c.restore()
    }

    private fun curve(dx: Float, half: Float, depth: Float) = (dx / half).let { it * it } * depth

    private fun drawPicker(c: Canvas, a: Float) {
        if (specs.isEmpty()) return
        val cx = width / 2f
        val half = width / 2f
        val sel = pickIndex()
        val s = specs[sel]
        titleP.alpha = (255 * a).toInt()
        c.drawText(s.name, cx, dp(30f), titleP)
        nameP.alpha = (255 * a).toInt()
        c.drawText(source.value(s.key), cx, dp(48f), nameP)
        val baseY = dp(90f) + dp(10f) * (1f - a)
        for (i in specs.indices) {
            val dx = (i - pickPos) * iconStep
            if (abs(dx) > half + iconStep) continue
            val x = cx + dx
            val y = baseY + curve(dx, half, dp(16f))
            val near = (1f - min(1f, abs(i - pickPos))).coerceIn(0f, 1f)
            val fade = (1f - (abs(dx) / half).coerceIn(0f, 1f) * 0.75f) * a
            val rad = dp(21f) * (0.84f + 0.16f * near)
            p.style = Paint.Style.FILL
            if (near > 0.5f) {
                p.color = Color.argb((235 * fade).toInt(), 255, 255, 255)
                c.drawCircle(x, y, rad, p)
                p.color = Color.argb((255 * fade).toInt(), 0, 0, 0)
            } else {
                p.color = Color.argb((120 * fade).toInt(), 60, 60, 64)
                c.drawCircle(x, y, rad, p)
                p.color = Color.argb((255 * fade).toInt(), 255, 255, 255)
            }
            Glyphs.draw(c, specs[i].glyph, x, y, rad * 1.05f, p)
        }
    }

    private fun majorEvery(): Int = max(1, ceil(dp(46f) / tickStep).toInt())

    private fun drawRuler(c: Canvas, a: Float) {
        val k = key ?: specs.getOrNull(pickIndex())?.key ?: return
        val spec = specs[pickIndex()]
        val cx = width / 2f
        val half = width / 2f - dp(10f)
        // Header: name and value.
        nameP.alpha = (255 * a).toInt()
        c.drawText(spec.name.uppercase(), cx, dp(24f), nameP)
        val auto = source.auto(k)
        valueP.color = if (auto == true) Theme.YELLOW else Theme.TEXT
        valueP.alpha = (255 * a).toInt()
        c.drawText(source.value(k), cx, dp(48f), valueP)
        // AUTO pill (left) and the control's icon (right, back to the picker).
        if (auto != null) {
            val pr = autoRect()
            p.style = Paint.Style.FILL
            p.color = if (auto) Theme.YELLOW else Color.argb(120, 80, 80, 84)
            p.alpha = (p.alpha * a).toInt()
            c.drawRoundRect(pr, pr.height() / 2, pr.height() / 2, p)
            autoP.color = if (auto) Color.BLACK else Theme.TEXT
            autoP.alpha = (255 * a).toInt()
            c.drawText("AUTO", pr.centerX(), pr.centerY() - (autoP.descent() + autoP.ascent()) / 2, autoP)
        }
        val br = backRect()
        p.color = Color.argb((120 * a).toInt(), 80, 80, 84)
        c.drawCircle(br.centerX(), br.centerY(), br.width() / 2, p)
        p.color = Color.argb((255 * a).toInt(), 255, 255, 255)
        Glyphs.draw(c, spec.glyph, br.centerX(), br.centerY(), br.width() * 0.55f, p)
        // Ruler.
        val baseY = dp(78f) + dp(12f) * (1f - a)
        val step = tickStep
        val every = majorEvery()
        val first = (pos - half / step - 1).toInt().coerceAtLeast(0)
        val last = (pos + half / step + 1).toInt().coerceAtMost(labels.size - 1)
        p.strokeCap = Paint.Cap.ROUND
        for (j in first..last) {
            val dx = (j - pos) * step
            if (abs(dx) > half) continue
            val x = cx + dx
            val y = baseY + curve(dx, half, dp(12f))
            val last = j == labels.size - 1
            val major = j % every == 0 || last
            // The last stop is labelled only when it is clear of the previous label.
            val labelled = j % every == 0 || (last && j % every >= maxOf(2, (every * 0.7f).roundToInt()))
            val fade = (1f - (abs(dx) / half)).coerceIn(0f, 1f).let { it * (2f - it) } * a
            p.color = Color.argb((255 * fade).toInt(), 255, 255, 255)
            p.strokeWidth = dp(if (major) 1.6f else 1f)
            c.drawLine(x, y, x, y + dp(if (major) 15f else 8f), p)
            if (labelled && abs(dx) > step * 0.6f) {
                tickP.alpha = (220 * fade).toInt()
                c.drawText(labels[j], x, y + dp(31f), tickP)
            }
        }
        // Centre mark.
        p.color = Theme.YELLOW; p.alpha = (255 * a).toInt()
        p.strokeWidth = dp(2.6f)
        c.drawLine(cx, baseY - dp(6f), cx, baseY + dp(19f), p)
    }

    private fun autoRect() = RectF(dp(26f), dp(18f), dp(26f) + dp(54f), dp(18f) + dp(26f))
    private fun backRect() = RectF(width - dp(26f) - dp(36f), dp(13f), width - dp(26f), dp(13f) + dp(36f))

    // ---- touch ----------------------------------------------------------------------------------
    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(e: MotionEvent): Boolean {
        poke()
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                parent?.requestDisallowInterceptTouchEvent(true)
                scroller.forceFinished(true); settleAnim?.cancel()
                downX = e.x; lastX = e.x; dragged = false
                tracker?.recycle(); tracker = VelocityTracker.obtain()
            }
            MotionEvent.ACTION_MOVE -> {
                if (!dragged && abs(e.x - downX) > slop) dragged = true
                if (dragged) {
                    val dx = e.x - lastX
                    lastX = e.x
                    if (adjusting) moveRuler(-dx / tickStep) else movePicker(-dx / iconStep)
                }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                tracker?.addMovement(e)
                tracker?.computeCurrentVelocity(1000)
                val vx = tracker?.xVelocity ?: 0f
                tracker?.recycle(); tracker = null
                if (!dragged && e.actionMasked == MotionEvent.ACTION_UP) tap(e.x, e.y)
                else if (adjusting && abs(vx) > 700) fling(vx) else settle()
                dragged = false
            }
        }
        tracker?.addMovement(e)
        return true
    }

    private fun tap(x: Float, y: Float) {
        if (adjusting) {
            val k = key ?: return
            if (source.auto(k) != null && autoRect().apply { inset(-dp(10f), -dp(10f)) }.contains(x, y)) { thud(); source.toggleAuto(k); refreshAfterChange(); return }
            if (backRect().apply { inset(-dp(10f), -dp(10f)) }.contains(x, y)) { tick(); setAdjust(false, true); return }
            // Tap on the ruler: step towards that side.
            if (y > dp(60f)) { val dir = if (x > width / 2f) 1 else -1; moveRuler(dir.toFloat()); settle() }
        } else {
            val i = (pickPos + (x - width / 2f) / iconStep).roundToInt().coerceIn(0, specs.size - 1)
            settleAnim?.cancel()
            pickPos = i.toFloat()
            tick()
            setAdjust(true, true)
        }
    }

    private fun refreshAfterChange() {
        val k = key ?: return
        labels = source.labels(k)
        pos = source.index(k).toFloat()
        invalidate()
    }

    private fun movePicker(d: Float) {
        val before = pickIndex()
        pickPos = (pickPos + d).coerceIn(-0.4f, specs.size - 0.6f)
        if (pickIndex() != before) tick()
        invalidate()
    }

    private fun moveRuler(d: Float) {
        if (labels.isEmpty()) return
        val before = pos.roundToInt()
        pos = (pos + d).coerceIn(-0.3f, labels.size - 0.7f)
        val now = pos.roundToInt().coerceIn(0, labels.size - 1)
        if (now != before.coerceIn(0, labels.size - 1)) {
            tick()
            key?.let { source.set(it, now) }
        }
        invalidate()
    }

    private fun fling(vx: Float) {
        val step = tickStep
        scroller.fling((pos * step).roundToInt(), 0, -vx.roundToInt(), 0, 0, ((labels.size - 1) * step).roundToInt(), 0, 0)
        postInvalidateOnAnimation()
    }

    override fun computeScroll() {
        if (adjusting && !scroller.isFinished && scroller.computeScrollOffset()) {
            val np = scroller.currX / tickStep
            moveRuler(np - pos)
            if (scroller.isFinished) settle() else postInvalidateOnAnimation()
        }
    }

    private fun settle() {
        settleAnim?.cancel()
        if (adjusting) {
            val t = pos.roundToInt().coerceIn(0, (labels.size - 1).coerceAtLeast(0))
            key?.let { if (t != source.index(it)) source.set(it, t) }
            settleAnim = springFloat(pos, t.toFloat(), Spring.SNAPPY) { pos = it; invalidate() }
        } else {
            val t = pickIndex()
            settleAnim = springFloat(pickPos, t.toFloat(), Spring.SNAPPY) { pickPos = it; invalidate() }
        }
    }
}
