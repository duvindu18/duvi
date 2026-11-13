package com.veil.cam.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TimelineLutTest {
    private fun r(t: Long, vararg faces: Pair<Int, Float>) =
        FaceResult(t, faces.map { (id, x) -> FaceView(id, Geom(x, 100f, 50f, 60f), false) })

    @Test fun interpolatesBetweenResults() {
        val tl = FaceTimeline()
        tl.add(r(0, 1 to 100f)); tl.add(r(100, 1 to 200f))
        assertEquals(150f, tl.at(50).single().cx, 1e-3f)
    }

    @Test fun faceAboutToAppearIsIncluded() {
        val tl = FaceTimeline()
        tl.add(r(0)); tl.add(r(100_000_000L, 1 to 300f))
        assertEquals(1, tl.at(50_000_000L).size) // privacy first
    }

    @Test fun staleResultsStillCover() {
        val tl = FaceTimeline()
        tl.add(r(0, 1 to 100f))
        assertEquals(100f, tl.at(5_000_000_000L).single().cx, 1e-3f)
    }

    @Test fun cubeRoundTrip() {
        val sb = StringBuilder("TITLE \"Test\"\nLUT_3D_SIZE 2\n")
        for (b in 0..1) for (g in 0..1) for (rr in 0..1) sb.append("${1 - rr} $g $b\n")
        val lut = CubeParser.parse(sb.toString())
        assertEquals("Test", lut.name)
        val o = lut.apply(0.25f, 0.5f, 1f)
        assertEquals(0.75f, o[0], 1e-5f); assertEquals(0.5f, o[1], 1e-5f); assertEquals(1f, o[2], 1e-5f)
    }

    @Test fun builtInLooksAreValid() {
        for (n in Looks.names) {
            val l = Looks.build(n, 17)
            assertTrue(l.data.all { it in 0f..1f })
        }
        // Flat -> Rec.709 undoes the flat curve (mid grey ends near sRGB 0.46 for linear 0.18).
        val o = Looks.build("Flat → Rec.709").apply(FlatProfile.encode(0.18f), FlatProfile.encode(0.18f), FlatProfile.encode(0.18f))
        assertEquals(0.46f, o[0], 0.02f)
    }

    @Test fun affineInverse() {
        val (m, _) = Affine.pass(640, 360, 37.0, 0.5)
        val inv = m.inverse()
        val x = m.mapX(100.0, 50.0); val y = m.mapY(100.0, 50.0)
        assertEquals(100.0, inv.mapX(x, y), 1e-9); assertEquals(50.0, inv.mapY(x, y), 1e-9)
    }
}
