package com.veil.cam.core

import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/** What the user picked in Settings. */
object PowerMode {
    const val MAX = 0
    const val BALANCED = 1
    const val SAVER = 2
    val names = listOf("Max quality", "Balanced", "Battery saver")
}

/**
 * How much work the pipeline may do. The tier comes from the power mode, the phone's
 * temperature and whether a take is running (standby is one tier lighter).
 *
 * Privacy never depends on the tier: every frame still waits for a detection taken at
 * or after its own moment and the faces are interpolated to it exactly; a sparser
 * detector only means more interpolation between detections (see [FaceTimeline]).
 */
data class PowerBudget(
    val tier: Int,
    val idleDetectNs: Long, // no face in view: how often to look for one
    val faceDetectNs: Long, // faces in view, moving calmly
    val motionDetectNs: Long, // a face moving fast or briefly lost
    val sweepEvery: Int, // rotated (tilted-face) passes on every n-th detection
    val segmentNs: Long, // cinematic depth person mask
    val previewScale: Float, // preview render size relative to the native-resolution size
    val preferEfficiency: Boolean, // ask the CPU scheduler for efficiency over peak speed
) {
    companion object {
        private const val MS = 1_000_000L

        fun of(mode: Int, thermal: Int, recording: Boolean): PowerBudget {
            val base = mode.coerceIn(0, 2) + thermal.coerceIn(0, 2) + if (recording) 0 else 1
            // Max quality keeps full speed while recording unless the phone is hot.
            val t = if (mode == PowerMode.MAX && recording && thermal == 0) 0 else base.coerceIn(1, 4)
            return when (t) {
                0 -> PowerBudget(0, 0, 0, 0, 2, 0, 1f, false)
                1 -> PowerBudget(1, 100 * MS, 66 * MS, 0, 2, 50 * MS, 1f, true) // depth mask at 20 fps
                2 -> PowerBudget(2, 150 * MS, 100 * MS, 33 * MS, 3, 100 * MS, 0.85f, true)
                3 -> PowerBudget(3, 200 * MS, 125 * MS, 50 * MS, 3, 150 * MS, 0.7f, true)
                else -> PowerBudget(4, 250 * MS, 150 * MS, 66 * MS, 4, 200 * MS, 0.6f, true)
            }
        }
    }
}

/** When to run the next face detection. */
object DetectPacer {
    /** A face moving faster than this (face sizes per second) is followed at the motion rate. */
    const val FAST_MOTION = 1.5f

    /** Fastest face in [r], in face sizes per second. */
    fun motion(r: FaceResult?): Float {
        var m = 0f
        r?.faces?.forEach { m = max(m, hypot(it.vx, it.vy) / max(1f, max(it.geom.w, it.geom.h))) }
        return m
    }

    fun intervalNs(b: PowerBudget, r: FaceResult?): Long = when {
        r == null -> 0L
        r.faces.isEmpty() -> b.idleDetectNs
        r.faces.any { it.lost } || motion(r) > FAST_MOTION -> b.motionDetectNs
        else -> b.faceDetectNs
    }

    /**
     * Frames wait in a ring until their detection is done; the interval is capped so a
     * frame never waits longer than the ring can hold ([maxPending] frames).
     */
    fun capped(intervalNs: Long, frameNs: Long, maxPending: Int, latencyNs: Long): Long =
        min(intervalNs, max(0L, (maxPending - 1) * frameNs - latencyNs))

    fun due(sinceLastNs: Long, intervalNs: Long, frameNs: Long): Boolean = sinceLastNs >= intervalNs - frameNs / 2
}
