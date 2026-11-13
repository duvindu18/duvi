package com.veil.cam.core

import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.sqrt

/**
 * Rotation-invariant detection, as on the desktop: the detector also runs on
 * rotated copies of the frame (the GPU renders them), every hit is mapped back
 * to the frame with its true orientation, and the passes are merged.
 *
 * A scheduler spreads the rotated passes over consecutive frames; an angle that
 * just found a face is re-run every frame while it keeps finding it, and every
 * angle runs on the first frame of a scene.
 */
object Angles {
    val FULL = intArrayOf(40, -40, 90, -90, 135, -135, 180)
    val TILT = intArrayOf(40, -40)
    const val HOT_FRAMES = 12
    const val HOT_THRESHOLD = 0.35f
}

/** One detector pass: how the GPU must draw the frame for it. */
data class PassSpec(
    val extraAngle: Int, // 0 for the upright pass
    val totalAngle: Double, // device orientation compensation + extra angle, degrees CCW
    val toCanvas: Affine, // image pixels -> canvas pixels (y down)
    val width: Int, // padded to a multiple of 32
    val height: Int,
)

object PassPlanner {
    /**
     * Upright pass: the frame turned by [baseAngle] (so faces are upright for how the
     * phone is held) and scaled so its longer side is [baseSide] pixels.
     */
    fun base(imgW: Int, imgH: Int, baseAngle: Double, baseSide: Int): PassSpec {
        val (_, size) = Affine.pass(imgW, imgH, baseAngle, 1.0)
        val scale = baseSide.toDouble() / max(size[0], size[1])
        val (m, s) = Affine.pass(imgW, imgH, baseAngle, scale)
        return PassSpec(0, baseAngle, m, roundUp32(s[0]), roundUp32(s[1]))
    }

    /**
     * Rotated pass on a square canvas that holds the whole rotated frame at the
     * same face scale as the upright pass ([scale] = image px -> canvas px of the
     * base pass, times [sizeFactor] < 1 to trade small-face recall for speed).
     */
    fun rotated(imgW: Int, imgH: Int, baseAngle: Double, extra: Int, scale: Double, sizeFactor: Double = 1.0): PassSpec {
        val total = baseAngle + extra
        val diag = hypot(imgW.toDouble(), imgH.toDouble())
        val sc = scale * sizeFactor
        val padded = roundUp32(kotlin.math.ceil(diag * sc).toInt())
        val (m, s) = Affine.pass(imgW, imgH, total, sc)
        // Centre the rotated image on the square canvas.
        val dx = (padded - s[0]) / 2.0
        val dy = (padded - s[1]) / 2.0
        return PassSpec(extra, total, m.copy(c = m.c + dx, f = m.f + dy), padded, padded)
    }

    /** Image px -> canvas px scale of a pass. */
    fun scaleOf(spec: PassSpec): Double = kotlin.math.sqrt(abs(spec.toCanvas.a * spec.toCanvas.e - spec.toCanvas.b * spec.toCanvas.d))
}

class AngleScheduler(private val angles: IntArray, private val perFrame: Int) {
    private var cursor = 0
    private val hot = LinkedHashMap<Int, Int>()

    fun plan(): List<Int> {
        if (angles.isEmpty() || perFrame == 0) return emptyList()
        val chosen = hot.entries.sortedByDescending { it.value }.map { it.key }
            .take(max(perFrame + 1, 3)).toMutableList()
        var sweep = max(1, perFrame - chosen.size)
        repeat(angles.size) {
            if (sweep == 0) return@repeat
            val a = angles[cursor % angles.size]
            cursor++
            if (a !in chosen) { chosen.add(a); sweep-- }
        }
        return chosen
    }

    fun all(): List<Int> = angles.toList()

    val hasHot: Boolean get() = hot.isNotEmpty()

    fun report(angle: Int) { hot[angle] = Angles.HOT_FRAMES }

    fun tick() {
        val it = hot.entries.iterator()
        while (it.hasNext()) {
            val e = it.next()
            e.setValue(e.value - 1)
            if (e.value <= 0) it.remove()
        }
    }

    fun reset() { hot.clear(); cursor = 0 }
}

object PassMapper {
    /** Map a detection from a pass canvas back to image pixels, keeping its orientation. */
    fun toImage(det: Detection, inv: Affine, imgW: Int, imgH: Int): Detection? {
        val b = det.bbox
        val mx = (b[0] + b[2]) / 2.0
        val my = (b[1] + b[3]) / 2.0
        val cx = inv.mapX(mx, my)
        val cy = inv.mapY(mx, my)
        val angle = Math.toDegrees(atan2(inv.d, inv.a))
        val s = sqrt(abs(inv.a * inv.e - inv.b * inv.d)) // canvas px -> image px
        val g = Geom(cx.toFloat(), cy.toFloat(), (b[2] - b[0]) * s.toFloat(), (b[3] - b[1]) * s.toFloat(), angle.toFloat())
        val box = g.aabb()
        box[0] = max(0f, box[0]); box[1] = max(0f, box[1])
        box[2] = kotlin.math.min(imgW.toFloat(), box[2]); box[3] = kotlin.math.min(imgH.toFloat(), box[3])
        if (box[2] - box[0] < 2 || box[3] - box[1] < 2) return null
        val kps = det.kps?.let { k ->
            FloatArray(10) { i ->
                val x = k[i and 1.inv()].toDouble()
                val y = k[i or 1].toDouble()
                (if (i % 2 == 0) inv.mapX(x, y) else inv.mapY(x, y)).toFloat()
            }
        }
        return Detection(box, det.score, kps, g)
    }

    private fun orientationAgreement(det: Detection): Float {
        val roll = FaceGeometry.landmarkRoll(det.kps) ?: return 0.5f
        val base = det.geom?.angle ?: 0f
        var diff = (roll - base + 180f) % 360f
        if (diff < 0) diff += 360f
        diff = abs(diff - 180f)
        return max(0f, 1f - diff / 90f)
    }

    private fun sameFace(a: FloatArray, b: FloatArray) = FaceGeometry.iou(a, b) > 0.35f || FaceGeometry.ios(a, b) > 0.6f

    /** Overlapping hits are one face, represented by the best hit (score + orientation match). */
    fun merge(all: List<Detection>): List<Detection> {
        val merged = ArrayList<Detection>()
        for (d in all.sortedByDescending { it.score + 0.3f * orientationAgreement(it) }) {
            if (merged.none { sameFace(it.bbox, d.bbox) }) merged.add(d)
        }
        return merged
    }
}

/** The pixels of one rendered pass, rows top-down unless [bottomUp]. */
class PassImage(val spec: PassSpec, val pixels: ByteArray, val channels: Int, val bottomUp: Boolean)

/**
 * Upright + scheduled rotated passes. [detect] runs the network on one canvas and
 * returns detections in canvas pixels.
 */
class MultiAngleDetector(
    angles: IntArray,
    perFrame: Int,
    private val detect: (PassImage, Float) -> List<Detection>,
) {
    val scheduler = AngleScheduler(angles, perFrame)
    private var frames = 0

    fun reset() { frames = 0; scheduler.reset() }

    /** Extra angles the GPU should render for the next detection. */
    fun nextPlan(): List<Int> {
        // Every angle on a new scene; otherwise, while no tilted face is being followed,
        // rotated passes run on every other detection so the upright pass (most faces)
        // runs at up to twice the rate and fast movement is sampled more densely.
        return when {
            frames == 0 -> scheduler.all()
            !scheduler.hasHot && frames % 2 == 1 -> emptyList()
            else -> scheduler.plan()
        }
    }

    fun run(passes: List<PassImage>, imgW: Int, imgH: Int, threshold: Float): List<Detection> {
        frames++
        scheduler.tick()
        val all = ArrayList<Detection>()
        val origin = java.util.IdentityHashMap<Detection, Int>()
        for (p in passes) {
            val inv = p.spec.toCanvas.inverse()
            for (d in detect(p, threshold)) {
                if (p.spec.extraAngle != 0 && d.score < Angles.HOT_THRESHOLD) continue
                val m = PassMapper.toImage(d, inv, imgW, imgH) ?: continue
                all.add(m)
                if (p.spec.extraAngle != 0) origin[m] = p.spec.extraAngle
            }
        }
        val merged = PassMapper.merge(all)
        for (d in merged) {
            val a = origin[d]
            if (a != null && d.score >= Angles.HOT_THRESHOLD) scheduler.report(a)
        }
        return merged.map { FaceGeometry.refine(it) }
    }
}
