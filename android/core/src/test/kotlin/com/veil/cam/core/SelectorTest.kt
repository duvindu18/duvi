package com.veil.cam.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SelectorTest {
    private fun track(id: Int, ema: Float, hits: Int, x: Float = 0f): FaceTrack {
        val box = floatArrayOf(x, 0f, x + 50f, 50f)
        val (m, c) = KalmanFilter().initiate(ByteTracker.tlbrToXyah(box))
        return FaceTrack(id, m, c, ema, 0).apply {
            scoreEma = ema; peakEma = ema; this.hits = hits
            lastBox = box; lastGeom = Geom.fromBox(box)
            detection = Detection(box, ema)
        }
    }

    @Test fun keepsNAndIgnoresNeverQualified() {
        val sel = HashSet<Int>()
        val (keep, _) = Selector.strongest(listOf(track(1, 0.9f, 10), track(2, 0.8f, 10, 100f), track(3, 0.3f, 10, 200f)), emptyList(), 2, 0.5f, sel)
        assertEquals(setOf(1, 2), keep.map { it.trackId }.toSet())
    }

    @Test fun slotsAreSticky() {
        val sel = HashSet<Int>()
        val a = track(1, 0.62f, 10); val b = track(2, 0.70f, 3, 200f)
        Selector.strongest(listOf(a), emptyList(), 1, 0.5f, sel)
        assertEquals(listOf(1), Selector.strongest(listOf(a, b), emptyList(), 1, 0.5f, sel).first.map { it.trackId })
    }

    @Test fun clearlyStrongerFaceDisplacesWeakHolder() {
        val sel = HashSet<Int>()
        val fp = track(1, 0.55f, 3)
        Selector.strongest(listOf(fp), emptyList(), 1, 0.5f, sel)
        val face = track(2, 0.85f, 6, 200f)
        assertEquals(listOf(2), Selector.strongest(listOf(fp, face), emptyList(), 1, 0.5f, sel).first.map { it.trackId })
    }

    @Test fun reacquiredFaceInheritsSlot() {
        val sel = HashSet<Int>()
        val a = track(1, 0.8f, 10)
        Selector.strongest(listOf(a), emptyList(), 1, 0.5f, sel)
        a.detection = null
        val other = track(3, 0.9f, 10, 300f)
        val again = track(2, 0.6f, 1)
        val (keep, _) = Selector.strongest(listOf(again, other), listOf(a), 1, 0.5f, sel)
        assertEquals(listOf(2), keep.map { it.trackId })
        assertEquals(setOf(2), sel)
    }

    @Test fun plausibility() {
        val real = Detection(floatArrayOf(0f, 0f, 100f, 120f), 0.9f, floatArrayOf(30f, 45f, 70f, 45f, 50f, 70f, 35f, 95f, 65f, 95f))
        assertTrue(FaceGeometry.plausible(real))
        val scrambled = Detection(floatArrayOf(0f, 0f, 100f, 120f), 0.9f, floatArrayOf(30f, 95f, 70f, 95f, 50f, 20f, 35f, 45f, 65f, 45f))
        assertFalse(FaceGeometry.plausible(scrambled))
    }
}
