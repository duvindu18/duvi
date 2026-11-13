package com.veil.cam.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.sin
import kotlin.math.sqrt

class DenoiserTest {
    private val fs = 48_000

    @Test fun passthroughIsExactDelay() {
        val d = Denoiser(1, fs, strength = 0f, highPass = false)
        val x = ShortArray(20_000) { (sin(it * 0.01) * 12000).toInt().toShort() }
        val y = x.copyOf()
        for (o in y.indices step 1024) d.process(y.copyOfRange(o, minOf(y.size, o + 1024)).also { b ->
            d.hashCode(); System.arraycopy(b, 0, y, o, b.size) }, 0)
        // Process in blocks for real.
        val out = x.copyOf()
        val d2 = Denoiser(1, fs, strength = 0f, highPass = false)
        var o = 0
        while (o < out.size) {
            val n = minOf(1000, out.size - o)
            val blk = out.copyOfRange(o, o + n)
            d2.process(blk, n)
            System.arraycopy(blk, 0, out, o, n)
            o += n
        }
        val lat = d2.latencySamples
        var maxErr = 0
        for (i in 4000 until 19_000) maxErr = maxOf(maxErr, kotlin.math.abs(out[i] - x[i - lat]))
        assertTrue("passthrough error $maxErr", maxErr <= 2)
    }

    @Test fun reducesNoiseKeepsTone() {
        val rnd = java.util.Random(1)
        val n = fs * 4
        val tone = DoubleArray(n) { 0.25 * sin(2 * PI * 440 * it / fs) * (if ((it / (fs / 2)) % 2 == 0) 1.0 else 0.0) } // speech-like on/off
        val noise = DoubleArray(n) { rnd.nextGaussian() * 0.03 }
        val pcm = ShortArray(n) { ((tone[it] + noise[it]) * 32768).toInt().coerceIn(-32768, 32767).toShort() }
        val d = Denoiser(1, fs, strength = 1f, highPass = true)
        var o = 0
        while (o < n) { val k = minOf(960, n - o); val b = pcm.copyOfRange(o, o + k); d.process(b, k); System.arraycopy(b, 0, pcm, o, k); o += k }
        val lat = d.latencySamples
        fun rms(f: (Int) -> Double, from: Int, to: Int) = sqrt((from until to).sumOf { f(it) * f(it) } / (to - from))
        // Noise-only half second near the end (tone off), and a tone-on half second.
        val offFrom = fs * 3 + fs / 2 + 2000; val offTo = fs * 4 - 2000
        val onFrom = fs * 3 + 2000; val onTo = fs * 3 + fs / 2 - 2000
        val noiseBefore = rms({ noise[it] }, offFrom, offTo)
        val noiseAfter = rms({ pcm[it + lat].toDouble() / 32768 }, offFrom - lat, offTo - lat)
        val toneAfter = rms({ pcm[it + lat].toDouble() / 32768 }, onFrom - lat, onTo - lat)
        val toneBefore = rms({ tone[it] }, onFrom, onTo)
        println("noise ${"%.4f".format(noiseBefore)} -> ${"%.4f".format(noiseAfter)}, tone ${"%.4f".format(toneBefore)} -> ${"%.4f".format(toneAfter)}")
        assertTrue("noise not reduced", noiseAfter < noiseBefore * 0.35)
        assertEquals(toneBefore, toneAfter, toneBefore * 0.15)
    }
}
