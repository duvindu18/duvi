package com.veil.cam.core

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Speech-friendly noise reduction for interleaved 16-bit PCM.
 *
 *  1. High-pass at 80 Hz (2nd-order Butterworth): wind, handling and HVAC rumble.
 *  2. Spectral noise gate: STFT (1024 / hop 512, sqrt-Hann, perfect reconstruction),
 *     a per-band noise floor tracked by minimum statistics (follows changing
 *     backgrounds without a "learn noise" step), Wiener-style gain with a floor so
 *     the room never sounds pumped or underwater, smoothed over time.
 *
 * Latency is [latencySamples] (one block); callers shift timestamps by it.
 */
class Denoiser(private val channels: Int, sampleRate: Int, var strength: Float = 1f, var highPass: Boolean = true) {
    private val n = 1024
    private val hop = n / 2
    val latencySamples = n
    private val window = FloatArray(n) { sqrt(0.5f - 0.5f * cos(2.0 * PI * it / n).toFloat()) }
    private val chans = Array(channels) { Channel() }
    private val biquad = Array(channels) { Biquad.highPass(80.0, sampleRate.toDouble()) }

    private inner class Channel {
        val inBuf = FloatArray(n)
        var inFill = n - hop // first frame starts half a block in, keeping latency = n
        val outAcc = FloatArray(n)
        val outQueue = ArrayDeque<Float>()
        val re = FloatArray(n); val im = FloatArray(n)
        val power = FloatArray(n / 2 + 1)
        val noise = FloatArray(n / 2 + 1) { 1e-9f }
        val gain = FloatArray(n / 2 + 1) { 1f }
        var frames = 0
        init { repeat(n - hop) { outQueue.addLast(0f) } }
    }

    fun reset() {
        for (c in chans) {
            c.inBuf.fill(0f); c.inFill = n - hop; c.outAcc.fill(0f); c.outQueue.clear(); repeat(n - hop) { c.outQueue.addLast(0f) }
            c.noise.fill(1e-9f); c.gain.fill(1f); c.frames = 0
        }
        biquad.forEach { it.reset() }
    }

    /** In place: [data] holds [frames] interleaved frames; output is delayed by [latencySamples]. */
    fun process(data: ShortArray, frames: Int) {
        for (ch in 0 until channels) {
            val c = chans[ch]
            val bq = biquad[ch]
            for (i in 0 until frames) {
                var x = data[i * channels + ch] / 32768f
                if (highPass) x = bq.process(x)
                c.inBuf[c.inFill++] = x
                if (c.inFill == n) {
                    frame(c)
                    System.arraycopy(c.inBuf, hop, c.inBuf, 0, n - hop)
                    c.inFill = n - hop
                }
                val y = if (c.outQueue.isNotEmpty()) c.outQueue.removeFirst() else 0f
                data[i * channels + ch] = (y * 32768f).coerceIn(-32768f, 32767f).toInt().toShort()
            }
        }
    }

    private fun frame(c: Channel) {
        for (i in 0 until n) { c.re[i] = c.inBuf[i] * window[i]; c.im[i] = 0f }
        Fft.transform(c.re, c.im, false)
        val bins = n / 2 + 1
        val s = strength.coerceIn(0f, 1.5f)
        val floor = 0.35f - 0.22f * min(1f, s) // -9 dB .. -19 dB
        for (k in 0 until bins) {
            val p = c.re[k] * c.re[k] + c.im[k] * c.im[k]
            c.power[k] = if (c.frames == 0) p else 0.7f * c.power[k] + 0.3f * p
            // Minimum statistics: seeded by the first frame, drops to new minima at once and
            // rises ~5 dB/s, so the floor follows a changing background but not speech.
            val nz = if (c.frames == 0) c.power[k] else c.noise[k]
            c.noise[k] = if (c.power[k] < nz) c.power[k] else nz * 1.0125f + 1e-12f
            val snr = c.power[k] / max(c.noise[k], 1e-12f)
            val g = max(floor, 1f - (1.2f + s) / max(snr, 1e-6f)) // Wiener-like gain
            c.gain[k] = 0.6f * c.gain[k] + 0.4f * g
            val gk = if (s <= 0f) 1f else c.gain[k]
            c.re[k] *= gk; c.im[k] *= gk
            if (k in 1 until n / 2) { c.re[n - k] = c.re[k]; c.im[n - k] = -c.im[k] }
        }
        c.frames++
        Fft.transform(c.re, c.im, true)
        for (i in 0 until n) c.outAcc[i] += c.re[i] * window[i]
        for (i in 0 until hop) c.outQueue.addLast(c.outAcc[i])
        System.arraycopy(c.outAcc, hop, c.outAcc, 0, n - hop)
        for (i in n - hop until n) c.outAcc[i] = 0f
    }
}

class Biquad(private val b0: Float, private val b1: Float, private val b2: Float, private val a1: Float, private val a2: Float) {
    private var x1 = 0f; private var x2 = 0f; private var y1 = 0f; private var y2 = 0f

    fun process(x: Float): Float {
        val y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        x2 = x1; x1 = x; y2 = y1; y1 = y
        return y
    }

    fun reset() { x1 = 0f; x2 = 0f; y1 = 0f; y2 = 0f }

    companion object {
        /** RBJ cookbook high-pass, Q = 1/sqrt(2) (Butterworth). */
        fun highPass(f: Double, fs: Double): Biquad {
            val w = 2 * PI * f / fs
            val alpha = sin(w) / (2 * 0.7071067811865476)
            val cw = cos(w)
            val a0 = 1 + alpha
            return Biquad(
                ((1 + cw) / 2 / a0).toFloat(), (-(1 + cw) / a0).toFloat(), ((1 + cw) / 2 / a0).toFloat(),
                (-2 * cw / a0).toFloat(), ((1 - alpha) / a0).toFloat(),
            )
        }
    }
}

object Fft {
    /** In-place iterative radix-2 FFT; [inverse] includes the 1/n scale. */
    fun transform(re: FloatArray, im: FloatArray, inverse: Boolean) {
        val n = re.size
        var j = 0
        for (i in 1 until n) {
            var bit = n shr 1
            while (j and bit != 0) { j = j xor bit; bit = bit shr 1 }
            j = j xor bit
            if (i < j) {
                var t = re[i]; re[i] = re[j]; re[j] = t
                t = im[i]; im[i] = im[j]; im[j] = t
            }
        }
        var len = 2
        while (len <= n) {
            val ang = 2 * PI / len * (if (inverse) 1 else -1)
            val wr = cos(ang).toFloat(); val wi = sin(ang).toFloat()
            var i = 0
            while (i < n) {
                var cr = 1f; var ci = 0f
                for (k in 0 until len / 2) {
                    val ur = re[i + k]; val ui = im[i + k]
                    val vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci
                    val vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr
                    re[i + k] = ur + vr; im[i + k] = ui + vi
                    re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi
                    val ncr = cr * wr - ci * wi
                    ci = cr * wi + ci * wr
                    cr = ncr
                }
                i += len
            }
            len = len shl 1
        }
        if (inverse) for (i in 0 until n) { re[i] /= n; im[i] /= n }
    }
}
