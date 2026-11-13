package com.veil.cam.core

import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.pow

/**
 * A 3D colour lookup table: [size]^3 RGB entries, red changing fastest (the
 * .cube convention and the layout of a GL 3D texture of width = red).
 */
class Lut3D(val name: String, val size: Int, val data: FloatArray) {
    init { require(data.size == size * size * size * 3) { "LUT data size mismatch" } }

    /** Trilinear lookup (used by tests and the photo path). */
    fun apply(r: Float, g: Float, b: Float): FloatArray {
        val n = size - 1
        val fr = r.coerceIn(0f, 1f) * n; val fg = g.coerceIn(0f, 1f) * n; val fb = b.coerceIn(0f, 1f) * n
        val r0 = fr.toInt().coerceAtMost(n - 1).coerceAtLeast(0); val g0 = fg.toInt().coerceAtMost(n - 1).coerceAtLeast(0)
        val b0 = fb.toInt().coerceAtMost(n - 1).coerceAtLeast(0)
        val dr = fr - r0; val dg = fg - g0; val db = fb - b0
        val out = FloatArray(3)
        for (c in 0 until 3) {
            fun v(ri: Int, gi: Int, bi: Int) = data[((bi * size + gi) * size + ri) * 3 + c]
            val c00 = v(r0, g0, b0) * (1 - dr) + v(r0 + 1, g0, b0) * dr
            val c10 = v(r0, g0 + 1, b0) * (1 - dr) + v(r0 + 1, g0 + 1, b0) * dr
            val c01 = v(r0, g0, b0 + 1) * (1 - dr) + v(r0 + 1, g0, b0 + 1) * dr
            val c11 = v(r0, g0 + 1, b0 + 1) * (1 - dr) + v(r0 + 1, g0 + 1, b0 + 1) * dr
            val c0 = c00 * (1 - dg) + c10 * dg
            val c1 = c01 * (1 - dg) + c11 * dg
            out[c] = c0 * (1 - db) + c1 * db
        }
        return out
    }

    companion object {
        fun build(name: String, size: Int = 33, f: (Float, Float, Float) -> FloatArray): Lut3D {
            val d = FloatArray(size * size * size * 3)
            var i = 0
            for (b in 0 until size) for (g in 0 until size) for (r in 0 until size) {
                val o = f(r / (size - 1f), g / (size - 1f), b / (size - 1f))
                d[i++] = o[0].coerceIn(0f, 1f); d[i++] = o[1].coerceIn(0f, 1f); d[i++] = o[2].coerceIn(0f, 1f)
            }
            return Lut3D(name, size, d)
        }
    }
}

class CubeFormatException(msg: String) : Exception(msg)

object CubeParser {
    /** Parse an Adobe/Resolve .cube 3D LUT (TITLE, LUT_3D_SIZE, DOMAIN_MIN/MAX). */
    fun parse(text: String, fallbackName: String = "LUT"): Lut3D {
        var title = fallbackName
        var size = 0
        var dmin = floatArrayOf(0f, 0f, 0f)
        var dmax = floatArrayOf(1f, 1f, 1f)
        var values: FloatArray? = null
        var count = 0
        for (raw in text.lineSequence()) {
            val line = raw.substringBefore('#').trim()
            if (line.isEmpty()) continue
            val parts = line.split(Regex("\\s+"))
            when (parts[0].uppercase()) {
                "TITLE" -> title = line.substringAfter(parts[0]).trim().trim('"').ifEmpty { fallbackName }
                "LUT_3D_SIZE" -> {
                    size = parts.getOrNull(1)?.toIntOrNull() ?: throw CubeFormatException("Bad LUT_3D_SIZE")
                    if (size !in 2..129) throw CubeFormatException("Unsupported LUT size $size")
                    values = FloatArray(size * size * size * 3)
                }
                "LUT_1D_SIZE" -> throw CubeFormatException("1D LUTs are not supported, use a 3D .cube")
                "DOMAIN_MIN" -> dmin = floats(parts)
                "DOMAIN_MAX" -> dmax = floats(parts)
                "LUT_3D_INPUT_RANGE" -> { val v = floats(parts); dmin = floatArrayOf(v[0], v[0], v[0]); dmax = floatArrayOf(v[1], v[1], v[1]) }
                else -> {
                    val v = values ?: continue
                    if (parts.size < 3) continue
                    val r = parts[0].toFloatOrNull() ?: continue
                    val g = parts[1].toFloatOrNull() ?: throw CubeFormatException("Bad entry: $line")
                    val b = parts[2].toFloatOrNull() ?: throw CubeFormatException("Bad entry: $line")
                    if (count * 3 + 2 >= v.size) throw CubeFormatException("Too many entries")
                    v[count * 3] = r; v[count * 3 + 1] = g; v[count * 3 + 2] = b
                    count++
                }
            }
        }
        val v = values ?: throw CubeFormatException("No LUT_3D_SIZE found")
        if (count != size * size * size) throw CubeFormatException("Expected ${size * size * size} entries, found $count")
        // Normalise the output range to 0..1 when the domain says so.
        for (i in v.indices) {
            val c = i % 3
            val span = dmax[c] - dmin[c]
            if (abs(span - 1f) > 1e-6f || dmin[c] != 0f) v[i] = (v[i] - dmin[c]) / span
        }
        return Lut3D(title, size, v)
    }

    private fun floats(p: List<String>): FloatArray {
        val v = p.drop(1).mapNotNull { it.toFloatOrNull() }
        if (v.isEmpty()) throw CubeFormatException("Bad ${p[0]}")
        return if (v.size >= 3) floatArrayOf(v[0], v[1], v[2]) else floatArrayOf(v[0], v.getOrElse(1) { v[0] }, v.getOrElse(1) { v[0] })
    }
}

/** Flat (log-like) picture profile used with the camera tonemap curve. */
object FlatProfile {
    private const val K = 40f
    private val norm = ln(1 + K)

    /** Linear 0..1 -> flat code value. */
    fun encode(linear: Float): Float = ln(1 + K * linear.coerceIn(0f, 1f)) / norm

    fun decode(code: Float): Float = ((exp(code.coerceIn(0f, 1f) * norm) - 1) / K)

    /** Points for CaptureRequest.TONEMAP_CURVE (in, out pairs). */
    fun curvePoints(n: Int = 64): FloatArray = FloatArray(n * 2) { i ->
        val x = (i / 2) / (n - 1f)
        if (i % 2 == 0) x else encode(x)
    }
}

object Looks {
    private fun luma(r: Float, g: Float, b: Float) = 0.2126f * r + 0.7152f * g + 0.0722f * b
    private fun sat(c: FloatArray, s: Float): FloatArray {
        val y = luma(c[0], c[1], c[2])
        return floatArrayOf(y + (c[0] - y) * s, y + (c[1] - y) * s, y + (c[2] - y) * s)
    }
    private fun sCurve(x: Float, k: Float): Float {
        // Smooth contrast around mid grey; k = 0 is identity.
        val t = x.coerceIn(0f, 1f)
        val s = t * t * (3 - 2 * t)
        return t + (s - t) * k
    }
    private fun linToSrgb(x: Float) = if (x <= 0.0031308f) x * 12.92f else 1.055f * x.coerceAtLeast(0f).pow(1 / 2.4f) - 0.055f

    val names = listOf("Natural", "Film", "Teal & Orange", "Warm", "Cool", "Vivid", "Bleach", "Mono", "Flat → Rec.709")

    fun build(name: String, size: Int = 33): Lut3D = when (name) {
        "Natural" -> Lut3D.build(name, size) { r, g, b -> sat(floatArrayOf(sCurve(r, .25f), sCurve(g, .25f), sCurve(b, .25f)), 1.05f) }
        "Film" -> Lut3D.build(name, size) { r, g, b ->
            fun tone(x: Float) = (x * (2.51f * x + 0.03f)) / (x * (2.43f * x + 0.59f) + 0.14f) // ACES-like shoulder
            val y = luma(r, g, b)
            val c = floatArrayOf(tone(r * 0.9f + 0.02f), tone(g * 0.9f + 0.02f), tone(b * 0.9f + 0.02f))
            // Cool shadows, warm highlights.
            val w = y.coerceIn(0f, 1f)
            sat(floatArrayOf(c[0] + 0.03f * (w - 0.4f), c[1], c[2] - 0.035f * (w - 0.4f)), 0.88f)
        }
        "Teal & Orange" -> Lut3D.build(name, size) { r, g, b ->
            val y = luma(r, g, b)
            val warm = ((r - b) * 2f).coerceIn(0f, 1f) // skin-ish
            val c = floatArrayOf(r + 0.06f * warm - 0.04f * (1 - y), g + 0.01f * warm, b - 0.05f * warm + 0.06f * (1 - y))
            sat(floatArrayOf(sCurve(c[0], .3f), sCurve(c[1], .3f), sCurve(c[2], .3f)), 1.1f)
        }
        "Warm" -> Lut3D.build(name, size) { r, g, b -> floatArrayOf(r * 1.06f + 0.01f, g * 1.01f, b * 0.9f) }
        "Cool" -> Lut3D.build(name, size) { r, g, b -> floatArrayOf(r * 0.92f, g * 0.99f, b * 1.07f + 0.01f) }
        "Vivid" -> Lut3D.build(name, size) { r, g, b -> sat(floatArrayOf(sCurve(r, .35f), sCurve(g, .35f), sCurve(b, .35f)), 1.3f) }
        "Bleach" -> Lut3D.build(name, size) { r, g, b ->
            val y = luma(r, g, b)
            val c = sat(floatArrayOf(r, g, b), 0.45f)
            floatArrayOf(sCurve(c[0] * 0.6f + y * 0.4f, .55f), sCurve(c[1] * 0.6f + y * 0.4f, .55f), sCurve(c[2] * 0.6f + y * 0.4f, .55f))
        }
        "Mono" -> Lut3D.build(name, size) { r, g, b -> val y = sCurve(luma(r, g, b), .3f); floatArrayOf(y, y, y) }
        "Flat → Rec.709" -> Lut3D.build(name, size) { r, g, b ->
            floatArrayOf(linToSrgb(FlatProfile.decode(r)), linToSrgb(FlatProfile.decode(g)), linToSrgb(FlatProfile.decode(b)))
        }
        else -> Lut3D.build("Identity", size) { r, g, b -> floatArrayOf(r, g, b) }
    }

}
