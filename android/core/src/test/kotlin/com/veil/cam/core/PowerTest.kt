package com.veil.cam.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PowerTest {
    private fun face(id: Int, x: Float, vx: Float = 0f, lost: Boolean = false) = FaceView(id, Geom(x, 100f, 50f, 60f), lost, vx, 0f)

    @Test fun maxQualityRecordingDetectsEveryFrame() {
        val b = PowerBudget.of(PowerMode.MAX, thermal = 0, recording = true)
        assertEquals(0L, b.idleDetectNs); assertEquals(0L, b.faceDetectNs)
    }

    @Test fun tiersGetLighterWithHeatAndMode() {
        val cool = PowerBudget.of(PowerMode.BALANCED, 0, true)
        val warm = PowerBudget.of(PowerMode.BALANCED, 1, true)
        val hot = PowerBudget.of(PowerMode.SAVER, 2, false)
        assertTrue(cool.tier < warm.tier && warm.tier < hot.tier)
        assertTrue(cool.idleDetectNs < warm.idleDetectNs && warm.idleDetectNs < hot.idleDetectNs)
        assertTrue(PowerBudget.of(PowerMode.MAX, 2, true).tier > 0) // heat overrides max quality
    }

    @Test fun fastOrLostFacesAreFollowedClosely() {
        val b = PowerBudget.of(PowerMode.BALANCED, 0, true)
        assertEquals(b.idleDetectNs, DetectPacer.intervalNs(b, FaceResult(0, emptyList())))
        assertEquals(b.faceDetectNs, DetectPacer.intervalNs(b, FaceResult(0, listOf(face(1, 100f, vx = 20f)))))
        assertEquals(b.motionDetectNs, DetectPacer.intervalNs(b, FaceResult(0, listOf(face(1, 100f, vx = 200f)))))
        assertEquals(b.motionDetectNs, DetectPacer.intervalNs(b, FaceResult(0, listOf(face(1, 100f, lost = true)))))
        assertEquals(0L, DetectPacer.intervalNs(b, null))
    }

    @Test fun intervalNeverOverflowsTheRing() {
        val frame = 33_333_333L
        assertEquals(frame * 4 - 20_000_000L, DetectPacer.capped(1_000_000_000L, frame, 5, 20_000_000L))
        assertEquals(0L, DetectPacer.capped(100_000_000L, frame, 1, 20_000_000L))
        assertTrue(DetectPacer.due(70_000_000L, 66_000_000L, frame))
        assertTrue(!DetectPacer.due(33_000_000L, 66_000_000L, frame))
    }

    @Test fun enteringFaceIsGrownForTheGap() {
        val tl = FaceTimeline()
        tl.add(FaceResult(0, emptyList()))
        tl.add(FaceResult(100_000_000L, listOf(face(1, 300f))))
        val g = tl.at(0L + 1).single()
        // 3 sizes/s over ~0.1 s on a 60 px face: ~18 px larger in both directions.
        assertTrue(g.w > 50f + 15f && g.h > 60f + 15f)
        assertEquals(60f, tl.at(100_000_000L).single().h, 1e-3f)
    }

    @Test fun rotatedSweepCadence() {
        val d = MultiAngleDetector(Angles.TILT, 2) { _, _ -> emptyList() }
        d.sweepEvery = 3
        val plans = (0 until 7).map { i -> d.nextPlan().size.also { if (i >= 0) d.run(emptyList(), 100, 100, 0.3f) } }
        assertEquals(listOf(2, 0, 0, 2, 0, 0, 2), plans)
    }
}
