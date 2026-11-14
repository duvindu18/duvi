package com.veil.cam.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs
import kotlin.math.sin

class ProTest {
    @Test fun clipNamesCountUpAndRollReels() {
        var s = NamingState()
        val (a, s1) = ClipNaming.next(s, "20261114"); s = s1
        assertEquals("A001_C001_20261114", a.base)
        val (b, s2) = ClipNaming.next(s, "20261114"); s = s2
        assertEquals("A001_C002_20261114", b.base)
        val (c, s3) = ClipNaming.next(s, "20261115"); s = s3
        assertEquals("A002_C001_20261115", c.base) // new day, new reel
        val (d, _) = ClipNaming.next(s, "20261115", forceNewReel = true)
        assertEquals("A003_C001_20261115", d.base)
        val (e, _) = ClipNaming.next(NamingState('B', 7, 41, "20261115"), "20261115")
        assertEquals("B007_C042_20261115", e.base)
    }

    @Test fun easingIsMonotonicAndExactAtEnds() {
        for (e in Ease.entries) {
            assertEquals(0f, e.at(0f), 1e-6f); assertEquals(1f, e.at(1f), 1e-6f)
            var prev = -1f
            for (i in 0..100) { val v = e.at(i / 100f); assertTrue("${e.name} not monotonic", v >= prev - 1e-6f); prev = v }
        }
        assertEquals(0.5f, Ease.EASE_IN_OUT.at(0.5f), 1e-5f)
        assertTrue(Ease.EASE_IN.at(0.2f) < 0.2f && Ease.EASE_OUT.at(0.2f) > 0.2f)
    }

    @Test fun focusPullInterpolatesAndReverses() {
        val a = FocusMark(0.5f, 0.3f, 100f, 100f); val b = FocusMark(4f, 0.9f, 500f, 300f)
        val p = FocusPull(a, b, 2000, Ease.LINEAR)
        assertEquals(2.25f, p.at(1000).diopters, 1e-4f)
        assertEquals(4f, p.at(5000).diopters, 1e-4f)
        assertEquals(0.5f, FocusPull(a, b, 2000, Ease.S_CURVE, reverse = true).at(2000).diopters, 1e-4f)
    }

    @Test fun burstAlignmentFindsTheShift() {
        val w = 320; val h = 180
        fun scene(ox: Float, oy: Float) = FloatArray(w * h) { i ->
            val x = i % w + ox; val y = i / w + oy
            (0.5f + 0.25f * sin(x * 0.11f) * sin(y * 0.07f) + 0.2f * sin(x * 0.031f + y * 0.05f))
        }
        val ref = scene(0f, 0f)
        for ((dx, dy) in listOf(7f to -4f, -13f to 9f, 2.5f to 1.5f)) {
            val img = scene(-dx, -dy) // img(x + dx, y + dy) == ref(x, y)
            val (ex, ey) = BurstAlign.translation(ref, img, w, h)
            assertTrue("dx $ex vs $dx", abs(ex - dx) < 0.6f); assertTrue("dy $ey vs $dy", abs(ey - dy) < 0.6f)
        }
    }

    @Test fun sceneRecognitionNeedsAFewReadings() {
        val a = SceneAnalyzer()
        val dark = IntArray(64).also { it[3] = 1000 }
        repeat(3) { assertEquals(Scene.AUTO, a.update(4000, 33_000_000, dark, 0f, 0f)) }
        assertEquals(Scene.NIGHT, a.update(4000, 33_000_000, dark, 0f, 0f))
        val backlit = IntArray(64).also { it[2] = 400; it[63] = 100; it[30] = 500 }
        assertEquals(Scene.BACKLIT, SceneAnalyzer().classify(100, 2_000_000, backlit, 0f, 0.5f))
        assertEquals(Scene.PORTRAIT, SceneAnalyzer().classify(100, 8_000_000, IntArray(64) { 10 }, 0.05f, 1f))
    }

    @Test fun framingSuggestsTheNearestThird() {
        val hints = FramingAdvisor.advise(listOf(floatArrayOf(0.5f, 0.6f, 0.15f, 0.2f)), 0f)
        assertTrue(hints.any { it.message.contains("third") })
        assertTrue(FramingAdvisor.advise(listOf(floatArrayOf(0.34f, 0.36f, 0.15f, 0.2f)), 0f).none { it.message.contains("third") })
        assertTrue(FramingAdvisor.advise(emptyList(), 4f).any { it.message.startsWith("Level") })
    }

    @Test fun prerollKeepsTheWindowFromAKeyframe() {
        val r = PacketRing(3_000_000)
        // 10 s of 30 fps video with a keyframe every second, audio every 21 ms.
        var a = 0L
        for (f in 0 until 300) {
            val t = f * 33_333L
            r.add(EncodedSample(0, t, f % 30 == 0, ByteArray(10), 0))
            while (a <= t) { r.add(EncodedSample(1, a, true, ByteArray(2), 0)); a += 21_333 }
        }
        val take = r.take()
        val first = take.first()
        assertTrue(first.track == 0 && first.key)
        val newest = 299 * 33_333L
        assertTrue("window ${(newest - first.ptsUs) / 1000} ms", newest - first.ptsUs in 3_000_000L..4_100_000L)
        assertTrue(take.filter { it.track == 1 }.all { it.ptsUs >= first.ptsUs })
    }

    @Test fun accessoryKeysLearnAndOverride() {
        val learnt = AccessoryKeys.parse("24=ZOOM_IN, 130=PHOTO,bad,99=NOPE")
        assertEquals(mapOf(24 to KeyAction.ZOOM_IN, 130 to KeyAction.PHOTO), learnt)
        assertEquals(learnt, AccessoryKeys.parse(AccessoryKeys.format(learnt)))
        assertEquals(KeyAction.ZOOM_IN, AccessoryKeys.actionFor(24, learnt, true))
        assertEquals(KeyAction.RECORD, AccessoryKeys.actionFor(25, learnt, true))
        assertEquals(null, AccessoryKeys.actionFor(25, emptyMap(), false))
        assertEquals(KeyAction.ZOOM_OUT, AccessoryKeys.actionFor(169, emptyMap(), false))
    }
}
