package com.veil.cam.ui

import android.animation.TimeInterpolator
import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorFilter
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.view.HapticFeedbackConstants
import android.view.View
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Dark camera design language: black, translucent "glass" controls, white type,
 * yellow for the active state, red only for recording.
 */
object Theme {
    const val BG = 0xFF000000.toInt()
    const val YELLOW = 0xFFFFD60A.toInt()
    const val RED = 0xFFFF3B30.toInt()
    const val GREEN = 0xFF30D158.toInt()
    const val ORANGE = 0xFFFF9F0A.toInt()
    const val TEXT = 0xFFFFFFFF.toInt()
    const val SECONDARY = 0x99EBEBF5.toInt() // 60 % label
    const val TERTIARY = 0x4DEBEBF5.toInt() // 30 % label
    const val SEPARATOR = 0xFF38383A.toInt()
    const val SHEET = 0xFF1C1C1E.toInt() // sheet background
    const val CARD = 0xFF2C2C2E.toInt() // grouped rows on the sheet
    const val FILL = 0x3D767680 // segmented track, slider track
    const val THUMB = 0xFF636366.toInt() // segmented selection
    const val GLASS = 0x7A1C1C1E // translucent control over video
    const val GLASS_STRONG = 0xB31C1C1E.toInt()
    const val SCRIM = 0x8C000000.toInt()

    // Kept for the editor timeline.
    const val ACCENT = YELLOW
    const val REC = RED
    const val DIM = SECONDARY
    const val FAINT = TERTIARY
    const val SURFACE2 = SHEET
    const val SURFACE3 = CARD

    fun dp(ctx: Context, v: Float) = v * ctx.resources.displayMetrics.density
    fun dpi(ctx: Context, v: Float) = dp(ctx, v).roundToInt()

    fun pill(color: Int, radius: Float) = GradientDrawable().apply { setColor(color); cornerRadius = radius }

    private fun weight(w: Int): Typeface = Typeface.create(Typeface.SANS_SERIF, w, false)
    val regular: Typeface = weight(400)
    val medium: Typeface = weight(500)
    val semibold: Typeface = weight(600)
    val bold: Typeface = weight(700)
    val mono: Typeface = semibold // numbers use tabular figures ("tnum") instead of a mono face

    /** Paint for text with tabular figures, so changing numbers never jiggle. */
    fun textPaint(ctx: Context, sizeSp: Float, face: Typeface = semibold, color: Int = TEXT) = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = face
        textSize = sizeSp * ctx.resources.displayMetrics.scaledDensity
        this.color = color
        fontFeatureSettings = "tnum"
        textAlign = Paint.Align.CENTER
    }
}

/**
 * A damped spring as an interpolator: [damping] ratio (1 = no overshoot) and
 * [response] (seconds per oscillation). Its natural length is [durationMs].
 */
class Spring(damping: Float = 0.82f, response: Float = 0.38f) : TimeInterpolator {
    private val w = (2 * PI / response).toFloat()
    private val z = damping.coerceIn(0.05f, 0.995f)
    private val wd = w * sqrt(1 - z * z)
    val durationMs: Long = (ln(1000.0) / (z * w) * 1000).toLong().coerceIn(120, 1400)

    override fun getInterpolation(x: Float): Float {
        if (x >= 1f) return 1f
        val t = x * durationMs / 1000f
        val e = exp(-z * w * t)
        return 1 - e * (cos(wd * t) + (z * w / wd) * sin(wd * t))
    }

    companion object {
        val SNAPPY = Spring(0.86f, 0.28f)
        val SMOOTH = Spring(0.92f, 0.42f)
        val BOUNCY = Spring(0.62f, 0.42f)
        val GENTLE = Spring(1f, 0.5f)
    }
}

/** Animate a float with a spring; returns the animator so callers can cancel it. */
fun springFloat(from: Float, to: Float, spring: Spring = Spring.SNAPPY, onUpdate: (Float) -> Unit): ValueAnimator =
    ValueAnimator.ofFloat(from, to).apply {
        interpolator = spring
        duration = spring.durationMs
        addUpdateListener { onUpdate(it.animatedValue as Float) }
        start()
    }

fun View.spring(spring: Spring = Spring.SNAPPY) = animate().setInterpolator(spring).setDuration(spring.durationMs)

/** Turn a control upright for how the phone is held, along the shortest way round. */
fun View.rotateUpright(deg: Int, animate: Boolean = true) {
    var d = ((deg - rotation) % 360f + 540f) % 360f - 180f
    if (kotlin.math.abs(d) < 0.5f) return
    val target = rotation + d
    if (animate && isAttachedToWindow) spring(Spring.SMOOTH).rotation(target).start() else rotation = target
}

fun View.tick() = performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
fun View.haptic() = tick()
fun View.thud() = performHapticFeedback(if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY)

/** Translucent rounded control surface with a light rim (drawn in code, no backdrop blur). */
object Glass {
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val rim = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }

    fun draw(c: Canvas, r: RectF, radius: Float, color: Int = Theme.GLASS, density: Float = 3f) {
        fill.color = color
        c.drawRoundRect(r, radius, radius, fill)
        rim.strokeWidth = 0.8f * density
        rim.shader = LinearGradient(0f, r.top, 0f, r.bottom, Color.argb(80, 255, 255, 255), Color.argb(14, 255, 255, 255), Shader.TileMode.CLAMP)
        val inset = rim.strokeWidth / 2
        c.drawRoundRect(r.left + inset, r.top + inset, r.right - inset, r.bottom - inset, radius - inset, radius - inset, rim)
        rim.shader = null
    }
}

/** Glass as a view background. */
class GlassDrawable(private val radius: Float, private val color: Int = Theme.GLASS, private val density: Float) : Drawable() {
    private val r = RectF()
    override fun draw(c: Canvas) {
        r.set(bounds)
        Glass.draw(c, r, minOf(radius, r.height() / 2), color, density)
    }
    override fun setAlpha(alpha: Int) {}
    override fun setColorFilter(cf: ColorFilter?) {}
    @Deprecated("Deprecated in Java")
    override fun getOpacity() = PixelFormat.TRANSLUCENT
}

/** The icon set, drawn as strokes on a 24-unit grid. */
enum class Glyph {
    BOLT, FACE, CHEVRON_UP, CHEVRON_DOWN, FLIP, PAUSE, PLAY, DIAL, SUN, ISO, SHUTTER, WB, TINT, FOCUS, ZOOM, DEPTH,
    STYLE, TONE, FILM, GEAR, GRID, ZEBRA, PEAK, FALSE, LOCK, MIC, STAB, SHARE, TRASH, EXPORT, SCISSORS, WAND, UNDO,
    BACK, CLOSE, LIBRARY, THERMO, LEVEL, HIST, FORMAT, STEP_BACK, STEP_FWD, MARK_IN, MARK_OUT, POWER, CHECK,
}

object Glyphs {
    private val path = Path()
    private val rect = RectF()

    /** Draw [g] centred at (cx, cy) in a box of [size] px with [p] (colour set by the caller). */
    fun draw(c: Canvas, g: Glyph, cx: Float, cy: Float, size: Float, p: Paint) {
        val u = size / 24f
        fun X(v: Float) = cx + (v - 12f) * u
        fun Y(v: Float) = cy + (v - 12f) * u
        val oldStyle = p.style
        p.strokeWidth = 1.7f * u
        p.strokeCap = Paint.Cap.ROUND
        p.strokeJoin = Paint.Join.ROUND
        p.style = Paint.Style.STROKE
        fun line(x1: Float, y1: Float, x2: Float, y2: Float) = c.drawLine(X(x1), Y(y1), X(x2), Y(y2), p)
        fun circle(x: Float, y: Float, r: Float, fill: Boolean = false) {
            p.style = if (fill) Paint.Style.FILL else Paint.Style.STROKE
            c.drawCircle(X(x), Y(y), r * u, p); p.style = Paint.Style.STROKE
        }
        fun rrect(l: Float, t: Float, r: Float, b: Float, rad: Float, fill: Boolean = false) {
            p.style = if (fill) Paint.Style.FILL else Paint.Style.STROKE
            rect.set(X(l), Y(t), X(r), Y(b)); c.drawRoundRect(rect, rad * u, rad * u, p); p.style = Paint.Style.STROKE
        }
        fun poly(fill: Boolean, vararg pts: Float) {
            path.reset(); path.moveTo(X(pts[0]), Y(pts[1]))
            var i = 2
            while (i < pts.size) { path.lineTo(X(pts[i]), Y(pts[i + 1])); i += 2 }
            if (fill) path.close()
            p.style = if (fill) Paint.Style.FILL else Paint.Style.STROKE
            c.drawPath(path, p); p.style = Paint.Style.STROKE
        }
        fun arc(x: Float, y: Float, r: Float, start: Float, sweep: Float) {
            rect.set(X(x - r), Y(y - r), X(x + r), Y(y + r)); c.drawArc(rect, start, sweep, false, p)
        }
        fun text(t: String, sizeU: Float, y: Float = 12f) {
            val tp = Paint(p).apply { style = Paint.Style.FILL; textAlign = Paint.Align.CENTER; typeface = Theme.bold; textSize = sizeU * u }
            c.drawText(t, cx, Y(y) - (tp.descent() + tp.ascent()) / 2, tp)
        }
        when (g) {
            Glyph.BOLT -> poly(true, 13.5f, 3f, 6f, 13.5f, 11.5f, 13.5f, 10.5f, 21f, 18f, 10.5f, 12.5f, 10.5f)
            Glyph.FACE -> {
                // Face outline with a blur band over the eyes: the anonymization symbol.
                circle(12f, 12f, 8.5f)
                p.strokeWidth = 3.2f * u
                line(6.5f, 10.5f, 17.5f, 10.5f)
                p.strokeWidth = 1.7f * u
                arc(12f, 13f, 4f, 30f, 120f)
            }
            Glyph.CHEVRON_UP -> poly(false, 6f, 14.5f, 12f, 9f, 18f, 14.5f)
            Glyph.CHEVRON_DOWN -> poly(false, 6f, 9.5f, 12f, 15f, 18f, 9.5f)
            Glyph.FLIP -> {
                arc(12f, 12f, 7f, 200f, 135f)
                arc(12f, 12f, 7f, 20f, 135f)
                poly(false, 16.5f, 4.5f, 19.5f, 7.3f, 16f, 9f)
                poly(false, 7.5f, 19.5f, 4.5f, 16.7f, 8f, 15f)
            }
            Glyph.PAUSE -> { rrect(7f, 5.5f, 10.2f, 18.5f, 1.2f, true); rrect(13.8f, 5.5f, 17f, 18.5f, 1.2f, true) }
            Glyph.PLAY -> poly(true, 8f, 5f, 19f, 12f, 8f, 19f)
            Glyph.DIAL -> {
                arc(12f, 15f, 9f, 200f, 140f)
                for (k in -3..3) {
                    val a = Math.toRadians((270 + k * 20).toDouble())
                    val r1 = if (k == 0) 5.5f else 7f
                    line(12f + (r1 * cos(a)).toFloat(), 15f + (r1 * sin(a)).toFloat(), 12f + (9f * cos(a)).toFloat(), 15f + (9f * sin(a)).toFloat())
                }
                circle(12f, 15f, 1.6f, true)
            }
            Glyph.SUN -> {
                circle(12f, 12f, 4f)
                for (k in 0 until 8) {
                    val a = k * PI / 4
                    line(12f + (6.5f * cos(a)).toFloat(), 12f + (6.5f * sin(a)).toFloat(), 12f + (8.8f * cos(a)).toFloat(), 12f + (8.8f * sin(a)).toFloat())
                }
            }
            Glyph.ISO -> { rrect(3.5f, 6.5f, 20.5f, 17.5f, 2.5f); text("ISO", 6.6f) }
            Glyph.SHUTTER -> {
                circle(12f, 12f, 8.5f)
                for (k in 0 until 6) {
                    val a = k * PI / 3
                    line(12f + (8.5f * cos(a)).toFloat(), 12f + (8.5f * sin(a)).toFloat(), 12f + (3.2f * cos(a + 1.1)).toFloat(), 12f + (3.2f * sin(a + 1.1)).toFloat())
                }
            }
            Glyph.WB -> { rrect(10f, 3.5f, 14f, 15f, 2f); circle(12f, 17.5f, 3.3f); circle(12f, 17.5f, 1.6f, true); line(16.5f, 6f, 19f, 6f); line(16.5f, 9.5f, 19f, 9.5f) }
            Glyph.TINT -> { path.reset(); path.moveTo(X(12f), Y(3.5f)); path.cubicTo(X(17f), Y(10f), X(18.5f), Y(12.5f), X(18.5f), Y(14.5f)); path.cubicTo(X(18.5f), Y(18.5f), X(15.5f), Y(20.5f), X(12f), Y(20.5f)); path.cubicTo(X(8.5f), Y(20.5f), X(5.5f), Y(18.5f), X(5.5f), Y(14.5f)); path.cubicTo(X(5.5f), Y(12.5f), X(7f), Y(10f), X(12f), Y(3.5f)); c.drawPath(path, p) }
            Glyph.FOCUS -> {
                poly(false, 4f, 8.5f, 4f, 4f, 8.5f, 4f); poly(false, 15.5f, 4f, 20f, 4f, 20f, 8.5f)
                poly(false, 4f, 15.5f, 4f, 20f, 8.5f, 20f); poly(false, 15.5f, 20f, 20f, 20f, 20f, 15.5f)
                circle(12f, 12f, 2.2f, true)
            }
            Glyph.ZOOM -> { circle(10.5f, 10.5f, 6.5f); line(15.3f, 15.3f, 20f, 20f); line(8f, 10.5f, 13f, 10.5f); line(10.5f, 8f, 10.5f, 13f) }
            Glyph.DEPTH -> text("ƒ", 17f, 11.5f)
            Glyph.STYLE -> { circle(9f, 9.5f, 5f); circle(15f, 9.5f, 5f); circle(12f, 14.8f, 5f) }
            Glyph.TONE -> { circle(12f, 12f, 8.5f); path.reset(); rect.set(X(3.5f), Y(3.5f), X(20.5f), Y(20.5f)); path.arcTo(rect, 90f, 180f); path.close(); p.style = Paint.Style.FILL; c.drawPath(path, p); p.style = Paint.Style.STROKE }
            Glyph.FILM -> {
                rrect(5f, 3.5f, 19f, 20.5f, 1.5f)
                line(9f, 3.5f, 9f, 20.5f); line(15f, 3.5f, 15f, 20.5f)
                for (y in listOf(6.5f, 10.5f, 14.5f, 18f)) { line(6.4f, y, 7.6f, y); line(16.4f, y, 17.6f, y) }
            }
            Glyph.GEAR -> {
                circle(12f, 12f, 3f)
                for (k in 0 until 8) {
                    val a = k * PI / 4
                    line(12f + (6.3f * cos(a)).toFloat(), 12f + (6.3f * sin(a)).toFloat(), 12f + (8.8f * cos(a)).toFloat(), 12f + (8.8f * sin(a)).toFloat())
                }
                circle(12f, 12f, 6.3f)
            }
            Glyph.GRID -> { rrect(4f, 4f, 20f, 20f, 2f); line(9.3f, 4f, 9.3f, 20f); line(14.7f, 4f, 14.7f, 20f); line(4f, 9.3f, 20f, 9.3f); line(4f, 14.7f, 20f, 14.7f) }
            Glyph.ZEBRA -> { rrect(4f, 4f, 20f, 20f, 2f); line(4f, 12f, 12f, 4f); line(4f, 18f, 18f, 4f); line(8f, 20f, 20f, 8f); line(14f, 20f, 20f, 14f) }
            Glyph.PEAK -> { circle(12f, 12f, 8f); circle(12f, 12f, 4f); circle(12f, 12f, 1.3f, true) }
            Glyph.FALSE -> { rrect(4f, 6f, 8f, 18f, 1f, true); rrect(10f, 6f, 14f, 18f, 1f); rrect(16f, 6f, 20f, 18f, 1f, true) }
            Glyph.LOCK -> { rrect(5.5f, 10.5f, 18.5f, 20f, 2.5f, true); arc(12f, 10.5f, 4f, 180f, 180f); line(8f, 10.5f, 8f, 11f); line(16f, 10.5f, 16f, 11f) }
            Glyph.MIC -> { rrect(9f, 3.5f, 15f, 14f, 3f); arc(12f, 11f, 6f, 0f, 180f); line(12f, 17f, 12f, 20.5f); line(9f, 20.5f, 15f, 20.5f) }
            Glyph.STAB -> { rrect(8f, 5f, 16f, 19f, 2f); arc(12f, 12f, 9f, 150f, 60f); arc(12f, 12f, 9f, -30f, 60f) }
            Glyph.SHARE -> { poly(false, 8f, 9f, 5.5f, 9f, 5.5f, 20.5f, 18.5f, 20.5f, 18.5f, 9f, 16f, 9f); line(12f, 3f, 12f, 14f); poly(false, 8.5f, 6.5f, 12f, 3f, 15.5f, 6.5f) }
            Glyph.TRASH -> { line(4.5f, 6.5f, 19.5f, 6.5f); poly(false, 9f, 6.5f, 9.5f, 3.5f, 14.5f, 3.5f, 15f, 6.5f); poly(false, 6.5f, 6.5f, 7.5f, 20.5f, 16.5f, 20.5f, 17.5f, 6.5f); line(10.3f, 10f, 10.3f, 17f); line(13.7f, 10f, 13.7f, 17f) }
            Glyph.EXPORT -> { line(12f, 3.5f, 12f, 15f); poly(false, 7.5f, 10.5f, 12f, 15f, 16.5f, 10.5f); line(5f, 20f, 19f, 20f) }
            Glyph.SCISSORS -> { circle(7f, 17f, 3f); circle(17f, 17f, 3f); line(8.8f, 14.6f, 17f, 3.5f); line(15.2f, 14.6f, 7f, 3.5f) }
            Glyph.WAND -> { line(4f, 20f, 15f, 9f); poly(true, 17f, 3f, 18f, 6f, 21f, 7f, 18f, 8f, 17f, 11f, 16f, 8f, 13f, 7f, 16f, 6f) }
            Glyph.UNDO -> { arc(13f, 13f, 6.5f, 200f, 250f); poly(false, 4f, 7f, 6.8f, 11.2f, 10.8f, 8.2f) }
            Glyph.BACK -> poly(false, 15f, 4.5f, 7.5f, 12f, 15f, 19.5f)
            Glyph.CLOSE -> { line(6.5f, 6.5f, 17.5f, 17.5f); line(17.5f, 6.5f, 6.5f, 17.5f) }
            Glyph.LIBRARY -> { rrect(4f, 4f, 11f, 11f, 1.5f); rrect(13f, 4f, 20f, 11f, 1.5f); rrect(4f, 13f, 11f, 20f, 1.5f); rrect(13f, 13f, 20f, 20f, 1.5f) }
            Glyph.THERMO -> { rrect(10f, 3f, 14f, 15f, 2f); circle(12f, 17.5f, 3.5f, true); line(12f, 8f, 12f, 16f) }
            Glyph.LEVEL -> { line(3.5f, 12f, 9f, 12f); line(15f, 12f, 20.5f, 12f); circle(12f, 12f, 2.5f) }
            Glyph.HIST -> poly(true, 3.5f, 19f, 6f, 13f, 9f, 15f, 12f, 7f, 15f, 12f, 18f, 9f, 20.5f, 19f)
            Glyph.FORMAT -> { rrect(3.5f, 6f, 20.5f, 18f, 2.5f); text("4K", 7f) }
            Glyph.STEP_BACK -> { poly(true, 17f, 6f, 9f, 12f, 17f, 18f); line(7f, 6f, 7f, 18f) }
            Glyph.STEP_FWD -> { poly(true, 7f, 6f, 15f, 12f, 7f, 18f); line(17f, 6f, 17f, 18f) }
            Glyph.MARK_IN -> { poly(false, 10f, 4f, 6f, 4f, 6f, 20f, 10f, 20f); line(11f, 12f, 19f, 12f); poly(false, 15.5f, 8.5f, 19f, 12f, 15.5f, 15.5f) }
            Glyph.MARK_OUT -> { poly(false, 14f, 4f, 18f, 4f, 18f, 20f, 14f, 20f); line(5f, 12f, 13f, 12f); poly(false, 9.5f, 8.5f, 13f, 12f, 9.5f, 15.5f) }
            Glyph.POWER -> { arc(12f, 13f, 7f, -55f, 290f); line(12f, 3.5f, 12f, 11f) }
            Glyph.CHECK -> poly(false, 5f, 12.5f, 10f, 17.5f, 19f, 6.5f)
        }
        p.style = oldStyle
    }
}
