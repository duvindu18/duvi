package com.veil.cam.face

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtLoggingLevel
import ai.onnxruntime.OrtSession
import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import com.veil.cam.core.PassSpec
import java.nio.FloatBuffer
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.roundToInt

/**
 * Relative depth of a detector canvas (rows top-down, 0..255, 255 = nearest) with the
 * focus plane worked out for it: [focus] is the subject's depth, [half] half its own
 * depth extent, [far] the far background (all 0..1 on the same scale).
 */
class DepthMap(
    val spec: PassSpec, val width: Int, val height: Int, val data: ByteArray,
    val focus: Float, val half: Float, val far: Float, val timestampNs: Long, val serial: Int,
    /** Where the tapped subject is now (canvas uv), when following a tap; else null. */
    val track: FloatArray? = null,
)

/**
 * Monocular depth (Depth Anything V2 Small, int8) for cinematic depth: what is at the
 * subject's distance stays sharp, things in front and behind blur with their distance
 * from it. Runs on its own thread a few times a second; the renderer re-traces the
 * exact edges on every frame, so the slower rate does not show at the outlines.
 *
 * The focus subject is the tapped point when there is one, else the people in frame,
 * else the centre of the frame.
 */
class DepthEstimator(private val context: Context) {
    // Background priority: face detection (privacy) always wins the CPU over depth.
    private val thread = HandlerThread("Depth", android.os.Process.THREAD_PRIORITY_BACKGROUND).apply { start() }
    private val handler = Handler(thread.looper)
    private val env = OrtEnvironment.getEnvironment()
    private var session: OrtSession? = null
    private var failed = false
    private val busy = AtomicBoolean(false)
    @Volatile var latest: DepthMap? = null
        private set
    private var prev: FloatArray? = null
    private var prevKey = ""
    private var lo = Float.NaN
    private var hi = Float.NaN
    private var serial = 0
    var onError: ((String) -> Unit)? = null

    val isBusy get() = busy.get()
    val usable get() = !failed

    private fun session(): OrtSession? {
        session?.let { return it }
        if (failed) return null
        return try {
            val bytes = context.assets.open(MODEL).use { it.readBytes() }
            val opts = OrtSession.SessionOptions().apply {
                setSessionLogLevel(OrtLoggingLevel.ORT_LOGGING_LEVEL_ERROR)
                setIntraOpNumThreads(2) // mid cores; the face detector keeps priority
                setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
                addConfigEntry("session.intra_op.allow_spinning", "0")
            }
            env.createSession(bytes, opts).also { session = it }
        } catch (e: Throwable) {
            Log.e(TAG, "depth model failed", e)
            failed = true
            onError?.invoke("Depth model is missing from this build: cinematic depth uses people only")
            null
        }
    }

    /**
     * [rgba]: the canvas, rows bottom-up (GL read-back). [person]: the latest person mask
     * (any canvas of the same size), [tap]: a focus point in canvas uv (0..1), or null.
     */
    fun submit(rgba: ByteArray, spec: PassSpec, timestampNs: Long, person: PersonMask?, tap: FloatArray?) {
        if (failed || !busy.compareAndSet(false, true)) return
        handler.post {
            try {
                val s = session() ?: return@post
                val cw = spec.width; val ch = spec.height
                val k = INPUT / maxOf(cw, ch).toFloat()
                val w = maxOf(14, (cw * k / 14f).roundToInt() * 14)
                val h = maxOf(14, (ch * k / 14f).roundToInt() * 14)
                val input = FloatArray(3 * w * h)
                val plane = w * h
                for (y in 0 until h) {
                    // Bilinear sample of the canvas (top-down row y of the model input).
                    val sy = ((y + 0.5f) * ch / h - 0.5f).coerceIn(0f, ch - 1f)
                    val y0 = sy.toInt(); val y1 = minOf(ch - 1, y0 + 1); val fy = sy - y0
                    val r0 = (ch - 1 - y0) * cw * 4; val r1 = (ch - 1 - y1) * cw * 4 // bottom-up source
                    for (x in 0 until w) {
                        val sx = ((x + 0.5f) * cw / w - 0.5f).coerceIn(0f, cw - 1f)
                        val x0 = sx.toInt(); val x1 = minOf(cw - 1, x0 + 1); val fx = sx - x0
                        for (c in 0 until 3) {
                            fun px(r: Int, xx: Int) = (rgba[r + xx * 4 + c].toInt() and 0xFF) / 255f
                            val v = (px(r0, x0) * (1 - fx) + px(r0, x1) * fx) * (1 - fy) + (px(r1, x0) * (1 - fx) + px(r1, x1) * fx) * fy
                            input[c * plane + y * w + x] = (v - MEAN[c]) / STD[c]
                        }
                    }
                }
                val raw = OnnxTensor.createTensor(env, FloatBuffer.wrap(input), longArrayOf(1, 3, h.toLong(), w.toLong())).use { t ->
                    s.run(mapOf(s.inputNames.first() to t)).use { r ->
                        @Suppress("UNCHECKED_CAST")
                        val out = (r[0].value as Array<Array<FloatArray>>)[0]
                        FloatArray(plane) { out[it / w][it % w] }
                    }
                }
                // Normalise (2nd..98th percentile, range smoothed over time so it does not pump).
                val sorted = raw.copyOf().also { it.sort() }
                val nlo = sorted[(plane * 0.02f).toInt()]; val nhi = sorted[(plane * 0.98f).toInt().coerceAtMost(plane - 1)]
                if (lo.isNaN()) { lo = nlo; hi = nhi } else { lo = 0.7f * lo + 0.3f * nlo; hi = 0.7f * hi + 0.3f * nhi }
                val span = maxOf(hi - lo, 1e-6f)
                val key = "$w x $h ${spec.totalAngle}"
                val p = prev?.takeIf { it.size == plane && key == prevKey }
                val d = FloatArray(plane) { i ->
                    val v = ((raw[i] - lo) / span).coerceIn(0f, 1f)
                    if (p != null) 0.6f * v + 0.4f * p[i] else v
                }
                prev = d; prevKey = key
                // Focus plane.
                val ds = d.copyOf().also { it.sort() }
                val far = ds[(plane * 0.05f).toInt()]
                var focus: Float; var half: Float
                var track: FloatArray? = null
                if (tap != null) {
                    val tx = (tap[0] * w).toInt().coerceIn(1, w - 2); val ty = (tap[1] * h).toInt().coerceIn(1, h - 2)
                    var sum = 0f
                    for (yy in -1..1) for (xx in -1..1) sum += d[(ty + yy) * w + tx + xx]
                    val here = sum / 9f
                    // Follow the tapped subject: the centroid, near the last point, of what is
                    // part of the same person (person mask) or at the same depth (an object).
                    fun personAt(x: Int, y: Int): Boolean {
                        val pm = person ?: return false
                        val mx = x * pm.width / w; val my = y * pm.height / h
                        return (pm.data[2 * (my * pm.width + mx)].toInt() and 0xFF) > 128
                    }
                    val onPerson = personAt(tx, ty)
                    val rad = (maxOf(w, h) * 0.12f).toInt()
                    var cx = 0f; var cy = 0f; var n = 0; val vals = ArrayList<Float>()
                    for (y in maxOf(0, ty - rad) until minOf(h, ty + rad + 1)) for (x in maxOf(0, tx - rad) until minOf(w, tx + rad + 1)) {
                        val v = d[y * w + x]
                        val same = if (onPerson) personAt(x, y) else kotlin.math.abs(v - here) < 0.05f
                        if (same) { cx += x; cy += y; n++; vals.add(v) }
                    }
                    if (n > 12) {
                        vals.sort()
                        focus = vals[vals.size / 2]
                        // Move the point only part of the way: steady on a still subject.
                        val nx = tx + (cx / n - tx) * 0.5f; val ny = ty + (cy / n - ty) * 0.5f
                        track = floatArrayOf((nx + 0.5f) / w, (ny + 0.5f) / h)
                    } else focus = here
                    half = if (onPerson) minOf(0.05f, (vals.getOrNull(vals.size * 3 / 4) ?: focus) - (vals.getOrNull(vals.size / 4) ?: focus)).coerceAtLeast(0.02f) else 0.02f
                } else {
                    val sel = ArrayList<Float>()
                    if (person != null) {
                        for (y in 0 until h) for (x in 0 until w) {
                            val mx = x * person.width / w; val my = y * person.height / h
                            if ((person.data[2 * (my * person.width + mx)].toInt() and 0xFF) > 128) sel.add(d[y * w + x])
                        }
                    }
                    if (sel.size < plane / 200) {
                        // Nobody in frame: the centre of the picture.
                        sel.clear()
                        for (y in h / 3 until 2 * h / 3) for (x in w / 3 until 2 * w / 3) sel.add(d[y * w + x])
                    }
                    sel.sort()
                    val q1 = sel[sel.size / 4]; val q3 = sel[(sel.size * 3) / 4]
                    focus = (q1 + q3) / 2f
                    half = minOf((q3 - q1) / 2f, 0.3f * maxOf(focus - far, 0.08f))
                }
                latest = DepthMap(spec, w, h, ByteArray(plane) { (d[it] * 255f + 0.5f).toInt().toByte() }, focus, half, far, timestampNs, ++serial, track)
            } catch (e: Throwable) {
                Log.w(TAG, "depth failed", e)
            } finally {
                busy.set(false)
            }
        }
    }

    fun clear() { latest = null; prev = null; lo = Float.NaN; hi = Float.NaN }

    fun release() {
        handler.post { runCatching { session?.close() }; session = null }
        thread.quitSafely()
    }

    companion object {
        private const val TAG = "VeilDepthNet"
        const val MODEL = "depth_anything_v2_small.onnx"
        private const val INPUT = 336f // long side; below ~300 the model loses people's shape
        private val MEAN = floatArrayOf(0.485f, 0.456f, 0.406f)
        private val STD = floatArrayOf(0.229f, 0.224f, 0.225f)
    }
}
