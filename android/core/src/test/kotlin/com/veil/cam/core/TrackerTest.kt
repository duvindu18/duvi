package com.veil.cam.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TrackerTest {
    private fun det(x: Float, y: Float, s: Float = 0.9f, size: Float = 60f) = Detection(floatArrayOf(x, y, x + size, y + size), s)

    @Test fun idsStableAcrossMotion() {
        val tr = ByteTracker(TrackerConfig(), 0.2f)
        for (f in 0 until 30) {
            val ids = tr.update(listOf(det(10f + f * 3, 50f), det(300f - f * 2, 80f))).map { it.trackId }.sorted()
            if (f > 0) assertEquals(listOf(1, 2), ids)
        }
    }

    @Test fun lowScoreDetectionKeepsTrack() {
        val tr = ByteTracker(TrackerConfig(), 0.2f)
        repeat(5) { tr.update(listOf(det(100f + it, 100f))) }
        assertEquals(listOf(1), tr.update(listOf(det(106f, 100f, 0.3f))).map { it.trackId })
    }

    @Test fun lostTrackRecoversSameId() {
        val tr = ByteTracker(TrackerConfig(), 0.2f)
        repeat(5) { tr.update(listOf(det(100f, 100f))) }
        repeat(5) { tr.update(emptyList()) }
        assertEquals(listOf(1), tr.update(listOf(det(100f, 100f))).map { it.trackId })
    }

    @Test fun lostTrackExpires() {
        val tr = ByteTracker(TrackerConfig(maxLostFrames = 3), 0.2f)
        repeat(5) { tr.update(listOf(det(100f, 100f))) }
        repeat(5) { tr.update(emptyList()) }
        assertTrue(tr.lost.isEmpty())
    }

    @Test fun lowConfidenceSideFaceKeepsItsId() {
        val tr = ByteTracker(TrackerConfig(), 0.2f)
        repeat(5) { tr.update(listOf(det(100f, 100f))) }
        assertEquals(listOf(1), tr.update(listOf(det(120f, 100f, 0.42f))).map { it.trackId })
    }

    @Test fun fastMotionKeepsItsId() {
        val tr = ByteTracker(TrackerConfig(), 0.2f)
        val ids = HashSet<Int>()
        for (f in 0 until 15) tr.update(listOf(det(20f + 40 * f, 100f))).forEach { ids.add(it.trackId) }
        assertEquals(setOf(1), ids)
    }

    @Test fun fastMotionDoesNotSwapNeighbours() {
        val tr = ByteTracker(TrackerConfig(), 0.2f)
        var tracks = emptyList<FaceTrack>()
        for (f in 0 until 10) tracks = tr.update(listOf(det(40f + 30 * f, 100f), det(40f + 30 * f, 260f)))
        assertEquals(mapOf(100 to 1, 260 to 2), tracks.associate { it.bbox[1].toInt() to it.trackId })
    }

    @Test fun canStartBlocksNewTracksButNotContinuation() {
        val tr = ByteTracker(TrackerConfig(), 0.2f)
        assertTrue(tr.update(listOf(det(100f, 100f))) { false }.isEmpty())
        tr.update(listOf(det(100f, 100f)))
        assertEquals(listOf(1), tr.update(listOf(det(104f, 100f))) { false }.map { it.trackId })
    }

    @Test fun hungarianMatchesBruteForce() {
        val rnd = java.util.Random(4)
        repeat(200) {
            val n = 1 + rnd.nextInt(4); val m = 1 + rnd.nextInt(4)
            val c = Array(n) { DoubleArray(m) { rnd.nextDouble() } }
            val (matches, _, _) = Assignment.assign(c, n, m, 10.0)
            val got = matches.sumOf { c[it[0]][it[1]] }
            assertEquals(minOf(n, m), matches.size)
            assertEquals(brute(c, n, m), got, 1e-9)
        }
    }

    private fun brute(c: Array<DoubleArray>, n: Int, m: Int): Double {
        var best = Double.MAX_VALUE
        fun go(i: Int, used: Set<Int>, acc: Double, picked: Int) {
            if (i == n) { if (picked == minOf(n, m)) best = minOf(best, acc); return }
            if (n - i > minOf(n, m) - picked) go(i + 1, used, acc, picked)
            for (j in 0 until m) if (j !in used) go(i + 1, used + j, acc + c[i][j], picked + 1)
        }
        go(0, emptySet(), 0.0, 0)
        return best
    }
}
