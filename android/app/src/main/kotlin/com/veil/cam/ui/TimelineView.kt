package com.veil.cam.ui

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.view.MotionEvent
import android.view.View
import com.veil.cam.media.Span
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * Clip timeline: thumbnail strip, cut regions (red, removed on export), playhead.
 * Drag on the strip to scrub; in cut mode, drag to mark a part to remove and tap a
 * cut to bring it back.
 */
class TimelineView(ctx: Context) : View(ctx) {
    var durationUs = 1L
    var positionUs = 0L
        set(v) { field = v.coerceIn(0, durationUs); invalidate() }
    var thumbs: List<Bitmap> = emptyList()
        set(v) { field = v; invalidate() }
    val cuts = ArrayList<Span>()
    var cutMode = false
        set(v) { field = v; invalidate() }
    var editing = false
        set(v) { field = v; invalidate() }
    var onScrub: ((Long, Boolean) -> Unit)? = null // position, finished
    var onCutsChanged: (() -> Unit)? = null
    private val p = Paint(Paint.ANTI_ALIAS_FLAG)
    private var dragFrom = -1L
    private var dragTo = -1L
    private var downX = 0f

    private val strip: RectF get() {
        val pad = Theme.dp(context, 6f)
        return RectF(pad, Theme.dp(context, 9f), width - pad, height - Theme.dp(context, 9f))
    }

    private fun xOf(us: Long) = strip.left + strip.width() * us / durationUs.coerceAtLeast(1)
    private fun usOf(x: Float) = ((x - strip.left) / strip.width() * durationUs).toLong().coerceIn(0, durationUs)

    override fun onMeasure(w: Int, h: Int) = setMeasuredDimension(MeasureSpec.getSize(w), Theme.dpi(context, 60f))

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(e: MotionEvent): Boolean {
        val us = usOf(e.x)
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                parent?.requestDisallowInterceptTouchEvent(true)
                downX = e.x
                if (cutMode) { dragFrom = us; dragTo = us } else { positionUs = us; onScrub?.invoke(us, false) }
            }
            MotionEvent.ACTION_MOVE -> if (cutMode) { dragTo = us; invalidate() } else { positionUs = us; onScrub?.invoke(us, false) }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                if (cutMode) {
                    val tap = abs(e.x - downX) < Theme.dp(context, 6f)
                    if (tap) {
                        // Tap a cut to restore that part.
                        val hit = cuts.firstOrNull { us in it.startUs..it.endUs }
                        if (hit != null) { cuts.remove(hit); onCutsChanged?.invoke() }
                    } else if (dragFrom >= 0) {
                        val s = Span(min(dragFrom, dragTo), max(dragFrom, dragTo))
                        if (s.durationUs > 40_000) { cuts.add(s); onCutsChanged?.invoke() }
                    }
                    dragFrom = -1; dragTo = -1
                    invalidate()
                } else onScrub?.invoke(us, true)
            }
        }
        return true
    }

    override fun onDraw(c: Canvas) {
        val r = strip
        val rad = Theme.dp(context, 7f)
        p.style = Paint.Style.FILL
        p.color = Theme.SHEET
        c.drawRoundRect(r, rad, rad, p)
        c.save()
        val clip = android.graphics.Path().apply { addRoundRect(r, rad, rad, android.graphics.Path.Direction.CW) }
        c.clipPath(clip)
        if (thumbs.isNotEmpty()) {
            val tw = r.width() / thumbs.size
            for ((i, b) in thumbs.withIndex()) {
                val dst = RectF(r.left + i * tw, r.top, r.left + (i + 1) * tw, r.bottom)
                val sAspect = b.width.toFloat() / b.height; val dAspect = dst.width() / dst.height()
                val src = if (sAspect > dAspect) {
                    val w = b.height * dAspect; android.graphics.Rect(((b.width - w) / 2).toInt(), 0, ((b.width + w) / 2).toInt(), b.height)
                } else {
                    val h = b.width / dAspect; android.graphics.Rect(0, ((b.height - h) / 2).toInt(), b.width, ((b.height + h) / 2).toInt())
                }
                c.drawBitmap(b, src, dst, null)
            }
        }
        // Removed parts: dimmed and hatched.
        fun removed(a: Float, b: Float, alpha: Int) {
            p.style = Paint.Style.FILL
            p.color = Color.argb(alpha, 0, 0, 0)
            c.drawRect(a, r.top, b, r.bottom, p)
            p.color = Color.argb(70, 255, 255, 255)
            p.strokeWidth = Theme.dp(context, 1f)
            val step = Theme.dp(context, 7f)
            var x = a - r.height()
            c.save(); c.clipRect(a, r.top, b, r.bottom)
            while (x < b) { c.drawLine(x, r.bottom, x + r.height(), r.top, p); x += step }
            c.restore()
        }
        for (sp in cuts) removed(xOf(sp.startUs), xOf(sp.endUs), 185)
        if (dragFrom >= 0) removed(xOf(min(dragFrom, dragTo)), xOf(max(dragFrom, dragTo)), 130)
        c.restore()
        if (editing) {
            // Edit frame: yellow border with grips at both ends.
            p.style = Paint.Style.STROKE
            p.strokeWidth = Theme.dp(context, 3f)
            p.color = Theme.YELLOW
            c.drawRoundRect(r, rad, rad, p)
            p.style = Paint.Style.FILL
            val g = Theme.dp(context, 10f)
            c.drawRoundRect(r.left - 1, r.top, r.left + g, r.bottom, rad, rad, p)
            c.drawRoundRect(r.right - g, r.top, r.right + 1, r.bottom, rad, rad, p)
            p.color = Color.argb(160, 0, 0, 0)
            p.strokeWidth = Theme.dp(context, 2f)
            val cy = r.centerY(); val h = Theme.dp(context, 6f)
            c.drawLine(r.left + g / 2, cy - h, r.left + g / 2, cy + h, p)
            c.drawLine(r.right - g / 2, cy - h, r.right - g / 2, cy + h, p)
        }
        // Playhead.
        p.style = Paint.Style.FILL
        p.color = Color.WHITE
        p.setShadowLayer(Theme.dp(context, 2f), 0f, 0f, 0x80000000.toInt())
        val x = xOf(positionUs)
        val w = Theme.dp(context, 1.8f)
        c.drawRoundRect(x - w, r.top - Theme.dp(context, 5f), x + w, r.bottom + Theme.dp(context, 5f), w, w, p)
        p.clearShadowLayer()
    }
}
