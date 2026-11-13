package com.veil.cam.core

import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.round
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Face geometry shared by detection, tracking and rendering.
 *
 * Coordinates are image pixels (x right, y down) of the camera frame. A face is
 * an oriented rectangle [Geom]: the detector box in the frame of the pass that
 * found it, with `angle` = that pass's rotation (degrees, positive = clockwise
 * on screen, the OpenCV ellipse convention used by the desktop app) and a
 * `margin` that scales the inscribed ellipse so a face tilted inside its box
 * is still covered.
 */
const val DEFAULT_MARGIN = 1.12f

data class Geom(
    val cx: Float,
    val cy: Float,
    val w: Float,
    val h: Float,
    val angle: Float = 0f,
    val margin: Float = DEFAULT_MARGIN,
) {
    fun shifted(dx: Float, dy: Float) = copy(cx = cx + dx, cy = cy + dy)

    /** Axis-aligned bounding box (x1, y1, x2, y2). */
    fun aabb(): FloatArray {
        val r = Math.toRadians(angle.toDouble())
        val c = abs(cos(r)).toFloat()
        val s = abs(sin(r)).toFloat()
        val hx = (w * c + h * s) / 2
        val hy = (w * s + h * c) / 2
        return floatArrayOf(cx - hx, cy - hy, cx + hx, cy + hy)
    }

    companion object {
        fun fromBox(b: FloatArray) =
            Geom((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, b[2] - b[0], b[3] - b[1], 0f, DEFAULT_MARGIN)
    }
}

/**
 * One detected face. [bbox] is axis-aligned (used for tracking), [kps] are the
 * five landmarks (left eye, right eye, nose, mouth left, mouth right) as
 * x0,y0,x1,y1,... or null.
 */
data class Detection(
    val bbox: FloatArray,
    val score: Float,
    val kps: FloatArray? = null,
    val geom: Geom? = null,
) {
    val oriented: Geom get() = geom ?: Geom.fromBox(bbox)
    val width: Float get() = bbox[2] - bbox[0]
    val height: Float get() = bbox[3] - bbox[1]
}

object FaceGeometry {
    /**
     * In-plane roll (degrees) from the five landmarks: the eye line and the
     * eyes-to-mouth axis, combined as unit vectors so either alone (a profile
     * with a hidden eye) still contributes.
     */
    fun landmarkRoll(kps: FloatArray?): Float? {
        if (kps == null || kps.size < 10) return null
        val lex = kps[0].toDouble(); val ley = kps[1].toDouble()
        val rex = kps[2].toDouble(); val rey = kps[3].toDouble()
        val mlx = kps[6].toDouble(); val mly = kps[7].toDouble()
        val mrx = kps[8].toDouble(); val mry = kps[9].toDouble()
        val ex = rex - lex; val ey = rey - ley
        val ax = (mlx + mrx) / 2 - (lex + rex) / 2
        val ay = (mly + mry) / 2 - (ley + rey) / 2
        // Rotate the "down the face" axis by -90° so it points along the eye line.
        val dx = ay; val dy = -ax
        val en = hypot(ex, ey) + 1e-6
        val dn = hypot(dx, dy) + 1e-6
        val vx = ex / en + dx / dn
        val vy = ey / en + dy / dn
        if (hypot(vx, vy) < 1e-3) return null
        return Math.toDegrees(atan2(vy, vx)).toFloat()
    }

    private fun wrap180(a: Float): Float {
        var x = (a + 180f) % 360f
        if (x < 0) x += 360f
        return x - 180f
    }

    /**
     * Set the coverage margin from how tilted the face is inside its box; a face
     * lying sideways in the box (residual near ±90°) gets the box turned by a quarter.
     */
    fun refine(det: Detection): Detection {
        val roll = landmarkRoll(det.kps) ?: return det
        var g = det.oriented
        val base = g.angle
        var residual = wrap180(roll - base)
        val quarter = round(residual / 90f).toInt()
        var angle = base
        var w = g.w
        var h = g.h
        if (quarter != 0) {
            angle = base + 90f * quarter
            residual -= 90f * quarter
            if (quarter % 2 != 0) { val t = w; w = h; h = t }
        }
        val margin = (1.08f + 0.0035f * (abs(residual) + 10f)).coerceIn(1.10f, 1.26f)
        g = g.copy(w = w, h = h, angle = angle, margin = margin)
        return det.copy(geom = g)
    }

    /**
     * Anatomical sanity check (1/2-face mode): in the face's own frame the eyes sit
     * above the nose, the nose above the mouth, with human proportions.
     */
    fun plausible(det: Detection): Boolean {
        val k = det.kps ?: return true
        if (k.size < 10) return true
        val roll = landmarkRoll(k) ?: return false
        val r = Math.toRadians(-roll.toDouble())
        val c = cos(r); val s = sin(r)
        var mx = 0.0; var my = 0.0
        for (i in 0 until 5) { mx += k[2 * i]; my += k[2 * i + 1] }
        mx /= 5; my /= 5
        val px = DoubleArray(5); val py = DoubleArray(5)
        for (i in 0 until 5) {
            val x = k[2 * i] - mx; val y = k[2 * i + 1] - my
            px[i] = c * x - s * y
            py[i] = s * x + c * y
        }
        val eyeY = (py[0] + py[1]) / 2
        val mouthY = (py[3] + py[4]) / 2
        val g = det.oriented
        val size = max(1.0, min(g.w, g.h).toDouble())
        val eyeDist = abs(px[1] - px[0])
        val faceH = mouthY - eyeY
        return faceH > 0.12 * size &&
            py[2] > eyeY - 0.05 * size && py[2] < mouthY + 0.05 * size &&
            eyeDist > 0.08 * size && eyeDist < 0.9 * size &&
            abs(px[4] - px[3]) < 1.4 * eyeDist + 0.1 * size
    }

    fun iou(a: FloatArray, b: FloatArray): Float {
        val iw = max(0f, min(a[2], b[2]) - max(a[0], b[0]))
        val ih = max(0f, min(a[3], b[3]) - max(a[1], b[1]))
        val inter = iw * ih
        val union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
        return if (union > 0) inter / union else 0f
    }

    /** Intersection over the smaller box. */
    fun ios(a: FloatArray, b: FloatArray): Float {
        val iw = max(0f, min(a[2], b[2]) - max(a[0], b[0]))
        val ih = max(0f, min(a[3], b[3]) - max(a[1], b[1]))
        val inter = iw * ih
        val sm = min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]))
        return if (sm > 0) inter / sm else 0f
    }

    /**
     * Drop near-duplicate regions of the same face (held + re-detected, upright +
     * rotated pass), keeping the larger one, so one face is never drawn as several
     * overlapping patches.
     */
    fun dedupe(regions: List<Geom>): List<Geom> {
        val sorted = regions.sortedByDescending { it.w * it.h }
        val kept = ArrayList<Geom>()
        for (g in sorted) {
            val dup = kept.any { k ->
                hypot(g.cx - k.cx, g.cy - k.cy) < 0.4f * min(k.w, k.h) && g.w * g.h >= 0.25f * k.w * k.h
            }
            if (!dup) kept.add(g)
        }
        return kept
    }
}

/** Shape actually anonymized for a face: centre, half sizes and rotation (degrees). */
data class FaceShape(val cx: Float, val cy: Float, val hw: Float, val hh: Float, val angle: Float)

object Coverage {
    /**
     * Coverage 0 is the face oval itself: the ellipse inscribed in the detector box
     * enlarged by the face's margin, so eyes, brows, nose, mouth, cheeks and chin are
     * always inside. Coverage grows it toward the whole head. Detector boxes stop
     * near the brows, so the shape is biased toward the forehead.
     */
    fun shape(g: Geom, coverage: Float, ellipse: Boolean): FaceShape {
        val cov = coverage.coerceIn(0f, 1f)
        val k = if (ellipse) g.margin + cov else 1f + (g.margin - 1f) * 0.6f + cov
        val hw = g.w / 2 * k
        val hh = g.h / 2 * k
        val shift = g.h * (0.03f + 0.08f * cov)
        val rad = Math.toRadians(g.angle.toDouble())
        val cx = g.cx + (sin(rad) * shift).toFloat()
        val cy = g.cy - (cos(rad) * shift).toFloat()
        return FaceShape(cx, cy, hw, hh, g.angle)
    }

    fun featherBand(s: FaceShape, soft: Boolean): Float = if (soft) 0.12f * min(s.hw, s.hh) else 0f
}

/** 2x3 affine transform: [x', y'] = [a b c; d e f] [x y 1]. */
data class Affine(val a: Double, val b: Double, val c: Double, val d: Double, val e: Double, val f: Double) {
    fun mapX(x: Double, y: Double) = a * x + b * y + c
    fun mapY(x: Double, y: Double) = d * x + e * y + f

    fun inverse(): Affine {
        val det = a * e - b * d
        require(abs(det) > 1e-12) { "singular affine" }
        val ia = e / det
        val ib = -b / det
        val id = -d / det
        val ie = a / det
        return Affine(ia, ib, -(ia * c + ib * f), id, ie, -(id * c + ie * f))
    }

    fun toFloatArray() = floatArrayOf(a.toFloat(), b.toFloat(), c.toFloat(), d.toFloat(), e.toFloat(), f.toFloat())

    companion object {
        /**
         * The detector pass that sees the image rotated by [angleDeg] (counter-
         * clockwise, as OpenCV's getRotationMatrix2D) and scaled by [scale], on a
         * canvas that holds the whole rotated image. Returns the transform from image
         * pixels to canvas pixels and the canvas size before padding.
         */
        fun pass(imgW: Int, imgH: Int, angleDeg: Double, scale: Double): Pair<Affine, IntArray> {
            val r = Math.toRadians(angleDeg)
            val cs = cos(r) * scale
            val sn = sin(r) * scale
            // OpenCV: M = [[cos, sin, (1-cos)cx - sin cy], [-sin, cos, sin cx + (1-cos) cy]] (scaled).
            val cx = imgW / 2.0
            val cy = imgH / 2.0
            val acs = abs(cos(r)); val asn = abs(sin(r))
            val nw = round((imgH * asn + imgW * acs) * scale).toInt().coerceAtLeast(1)
            val nh = round((imgH * acs + imgW * asn) * scale).toInt().coerceAtLeast(1)
            val m = Affine(
                cs, sn, cx - cs * cx - sn * cy + nw / 2.0 - cx,
                -sn, cs, cy + sn * cx - cs * cy + nh / 2.0 - cy,
            )
            // The translation above centres the rotated image on the canvas.
            return m to intArrayOf(nw, nh)
        }
    }
}

fun roundUp32(v: Int) = ((v + 31) / 32) * 32

fun sqr(x: Float) = x * x
fun dist(ax: Float, ay: Float, bx: Float, by: Float) = sqrt(sqr(ax - bx) + sqr(ay - by))
