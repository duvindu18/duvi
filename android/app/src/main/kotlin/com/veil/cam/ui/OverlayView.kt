package com.veil.cam.ui

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import com.veil.cam.Settings
import com.veil.cam.core.Coverage
import com.veil.cam.core.Geom
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/**
 * Everything drawn on top of the video: frame guides, grid, horizon level, focus
 * reticle, histogram, audio meters and (optionally) the tracked face shapes.
 * Never part of the recording.
 */
class OverlayView(ctx: Context) : View(ctx) {
    var settings = Settings()
        set(v) { field = v; invalidate() }
    var content = RectF()
        set(v) { field = v; invalidate() }
    private var viewToImg = floatArrayOf(1f, 0f, 0f, 0f, 1f, 0f)
    private var imgToView = floatArrayOf(1f, 0f, 0f, 0f, 1f, 0f)
    private var faces: List<Geom> = emptyList()
    private var hist: Array<IntArray>? = null
    var levels = floatArrayOf(-90f, -90f)
        set(v) { field = v; invalidate() }
    var showAudio = true
    var roll = 0f // degrees from level
        set(v) { if (abs(v - field) > 0.2f) { field = v; if (settings.level) invalidate() } }
    private var focusPoint: Pair<Float, Float>? = null
    private var focusAt = 0L
    /** Free area between the controls (view px); histogram and meters sit in its top corners. */
    var hud = RectF()
        set(v) { field = v; invalidate() }
    var startingHint = false
        set(v) { field = v; invalidate() }

    var onTap: ((viewX: Float, viewY: Float, imgX: Float, imgY: Float) -> Unit)? = null
    var onDoubleTap: (() -> Unit)? = null
    var onZoom: ((factor: Float) -> Unit)? = null

    private val p = Paint(Paint.ANTI_ALIAS_FLAG)

    fun setTransform(viewToImage: FloatArray) {
        viewToImg = viewToImage
        val det = viewToImage[0] * viewToImage[4] - viewToImage[1] * viewToImage[3]
        if (abs(det) < 1e-9f) return
        val a = viewToImage[4] / det; val b = -viewToImage[1] / det; val d = -viewToImage[3] / det; val e = viewToImage[0] / det
        imgToView = floatArrayOf(a, b, -(a * viewToImage[2] + b * viewToImage[5]), d, e, -(d * viewToImage[2] + e * viewToImage[5]))
        invalidate()
    }

    fun setFaces(f: List<Geom>) { faces = f; invalidate() }

    fun setHistogram(l: IntArray, r: IntArray, g: IntArray, b: IntArray) { hist = arrayOf(l, r, g, b); invalidate() }

    fun showFocus(x: Float, y: Float) { focusPoint = x to y; focusAt = System.currentTimeMillis(); invalidate() }

    private val gestures = GestureDetector(ctx, object : GestureDetector.SimpleOnGestureListener() {
        override fun onSingleTapConfirmed(e: MotionEvent): Boolean {
            if (!content.contains(e.x, e.y)) return false
            val ix = viewToImg[0] * e.x + viewToImg[1] * e.y + viewToImg[2]
            val iy = viewToImg[3] * e.x + viewToImg[4] * e.y + viewToImg[5]
            showFocus(e.x, e.y)
            onTap?.invoke(e.x, e.y, ix, iy)
            return true
        }

        override fun onDoubleTap(e: MotionEvent): Boolean { focusPoint = null; onDoubleTap?.invoke(); invalidate(); return true }
    })
    private val scale = ScaleGestureDetector(ctx, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScale(d: ScaleGestureDetector): Boolean { onZoom?.invoke(d.scaleFactor); return true }
    })

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(e: MotionEvent): Boolean {
        scale.onTouchEvent(e)
        if (!scale.isInProgress) gestures.onTouchEvent(e)
        return true
    }

    override fun onDraw(c: Canvas) {
        val r = content
        if (r.width() <= 0) return
        drawGuides(c, r)
        if (settings.grid) drawGrid(c, r)
        if (settings.showBoxes) drawFaces(c)
        if (settings.level) drawLevel(c, r)
        drawFocus(c)
        if (settings.histogram) drawHistogram(c, r)
        if (showAudio && settings.audio) drawMeters(c, r)
        if (startingHint) drawStarting(c, r)
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
        p.strokeWidth = Theme.dp(context, 1f)
        p.color = Color.argb(160, 244, 244, 245)
        c.drawRect(inner, p)
    }

    private fun drawGrid(c: Canvas, r: RectF) {
        p.style = Paint.Style.STROKE
        p.strokeWidth = Theme.dp(context, 0.8f)
        p.color = Color.argb(110, 244, 244, 245)
        for (i in 1..2) {
            val x = r.left + r.width() * i / 3; val y = r.top + r.height() * i / 3
            c.drawLine(x, r.top, x, r.bottom, p)
            c.drawLine(r.left, y, r.right, y, p)
        }
        val s = Theme.dp(context, 8f)
        c.drawLine(r.centerX() - s, r.centerY(), r.centerX() + s, r.centerY(), p)
        c.drawLine(r.centerX(), r.centerY() - s, r.centerX(), r.centerY() + s, p)
    }

    private fun mapX(x: Float, y: Float) = imgToView[0] * x + imgToView[1] * y + imgToView[2]
    private fun mapY(x: Float, y: Float) = imgToView[3] * x + imgToView[4] * y + imgToView[5]

    private fun drawFaces(c: Canvas) {
        p.style = Paint.Style.STROKE
        p.strokeWidth = Theme.dp(context, 1.6f)
        p.color = Theme.ACCENT
        p.pathEffect = null
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

    private fun drawLevel(c: Canvas, r: RectF) {
        val len = min(r.width(), r.height()) * 0.18f
        val ok = abs(roll) < 1f
        p.style = Paint.Style.STROKE
        p.strokeWidth = Theme.dp(context, 2f)
        p.color = if (ok) Theme.ACCENT else Color.argb(200, 244, 244, 245)
        val rad = Math.toRadians(-roll.toDouble())
        val dx = (cos(rad) * len).toFloat(); val dy = (sin(rad) * len).toFloat()
        c.drawLine(r.centerX() - dx, r.centerY() - dy, r.centerX() - dx * 0.25f, r.centerY() - dy * 0.25f, p)
        c.drawLine(r.centerX() + dx * 0.25f, r.centerY() + dy * 0.25f, r.centerX() + dx, r.centerY() + dy, p)
    }

    private fun drawFocus(c: Canvas) {
        val fp = focusPoint ?: return
        val age = System.currentTimeMillis() - focusAt
        if (age > 2500) { focusPoint = null; return }
        val s = Theme.dp(context, 34f)
        p.style = Paint.Style.STROKE
        p.strokeWidth = Theme.dp(context, 1.6f)
        p.color = Theme.ACCENT
        p.alpha = (255 * (1f - max(0f, (age - 1800) / 700f))).toInt().coerceIn(0, 255)
        c.drawRect(fp.first - s, fp.second - s, fp.first + s, fp.second + s, p)
        p.alpha = 255
        postInvalidateDelayed(50)
    }

    private fun drawHistogram(c: Canvas, r: RectF) {
        val h = hist ?: return
        val w = Theme.dp(context, 132f); val hh = Theme.dp(context, 56f)
        val area = if (hud.width() > 0) hud else r
        val x0 = maxOf(r.left, area.left) + Theme.dp(context, 8f)
        val y0 = maxOf(r.top, area.top) + Theme.dp(context, 8f)
        p.style = Paint.Style.FILL
        p.color = Theme.SCRIM
        c.drawRoundRect(x0, y0, x0 + w, y0 + hh, Theme.dp(context, 10f), Theme.dp(context, 10f), p)
        val colors = intArrayOf(Color.argb(200, 244, 244, 245), Color.argb(110, 255, 80, 80), Color.argb(110, 80, 255, 120), Color.argb(110, 90, 140, 255))
        val maxV = h[0].maxOrNull()?.coerceAtLeast(1) ?: 1
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
        val w = Theme.dp(context, 8f); val hh = Theme.dp(context, 80f)
        val area = if (hud.width() > 0) hud else r
        val x0 = minOf(r.right, area.right) - Theme.dp(context, 28f)
        val y0 = maxOf(r.top, area.top) + Theme.dp(context, 8f)
        p.style = Paint.Style.FILL
        for (ch in 0..1) {
            val x = x0 + ch * (w + Theme.dp(context, 4f))
            p.color = Theme.SCRIM
            c.drawRoundRect(x, y0, x + w, y0 + hh, w / 2, w / 2, p)
            val db = levels[ch].coerceIn(-60f, 0f)
            val f = (db + 60f) / 60f
            p.color = when { db > -3f -> Theme.REC; db > -12f -> Theme.WARN; else -> Theme.ACCENT }
            c.drawRoundRect(x, y0 + hh * (1 - f), x + w, y0 + hh, w / 2, w / 2, p)
        }
    }

    private fun drawStarting(c: Canvas, r: RectF) {
        val text = "Starting face detection…"
        p.typeface = Theme.medium
        p.textSize = Theme.dp(context, 13f)
        p.textAlign = Paint.Align.CENTER
        val tw = p.measureText(text) + Theme.dp(context, 28f)
        val th = Theme.dp(context, 34f)
        p.style = Paint.Style.FILL
        p.color = Theme.SCRIM
        c.drawRoundRect(r.centerX() - tw / 2, r.centerY() - th / 2, r.centerX() + tw / 2, r.centerY() + th / 2, th / 2, th / 2, p)
        p.color = Theme.TEXT
        c.drawText(text, r.centerX(), r.centerY() - (p.descent() + p.ascent()) / 2, p)
    }
}
