package com.veil.cam.core

import kotlin.math.hypot
import kotlin.math.max

data class TrackerConfig(
    val highThreshold: Float = 0.35f,
    val matchIou: Float = 0.3f,
    val lowMatchIou: Float = 0.5f,
    val newTrackThreshold: Float = 0.35f,
    val maxLostFrames: Int = 30,
    val minHits: Int = 1,
)

enum class TrackState { NEW, TRACKED, LOST, REMOVED }

/** Constant-velocity Kalman filter over (cx, cy, aspect, h), as in ByteTrack. */
class KalmanFilter {
    private val stdPos = 1.0 / 20
    private val stdVel = 1.0 / 160

    fun initiate(m: DoubleArray): Pair<DoubleArray, DoubleArray> {
        val mean = DoubleArray(8).also { m.copyInto(it) }
        val h = m[3]
        val std = doubleArrayOf(
            2 * stdPos * h, 2 * stdPos * h, 1e-2, 2 * stdPos * h,
            10 * stdVel * h, 10 * stdVel * h, 1e-5, 10 * stdVel * h,
        )
        return mean to Mat.diag(std.map { it * it }.toDoubleArray())
    }

    fun predict(mean: DoubleArray, cov: DoubleArray): Pair<DoubleArray, DoubleArray> {
        val h = mean[3]
        val std = doubleArrayOf(
            stdPos * h, stdPos * h, 1e-2, stdPos * h,
            stdVel * h, stdVel * h, 1e-5, stdVel * h,
        )
        val nm = DoubleArray(8)
        for (i in 0 until 4) { nm[i] = mean[i] + mean[i + 4]; nm[i + 4] = mean[i + 4] }
        // F P F^T + Q with F = [I I; 0 I]
        val f = Mat.motion()
        val nc = Mat.add(Mat.mul(Mat.mul(f, cov, 8, 8, 8), Mat.transpose(f, 8, 8), 8, 8, 8), Mat.diag(std.map { it * it }.toDoubleArray()))
        return nm to nc
    }

    fun update(mean: DoubleArray, cov: DoubleArray, z: DoubleArray): Pair<DoubleArray, DoubleArray> {
        val h = mean[3]
        val std = doubleArrayOf(stdPos * h, stdPos * h, 1e-1, stdPos * h)
        // H = [I 0] (4x8): projected mean = mean[0..3], projected cov = P[0..3,0..3] + R
        val s = DoubleArray(16)
        for (i in 0 until 4) for (j in 0 until 4) s[i * 4 + j] = cov[i * 8 + j] + if (i == j) std[i] * std[i] else 0.0
        val sInv = Mat.inverse4(s) ?: return mean to cov
        // K = P H^T S^-1 (8x4); P H^T = first 4 columns of P
        val pht = DoubleArray(32)
        for (i in 0 until 8) for (j in 0 until 4) pht[i * 4 + j] = cov[i * 8 + j]
        val k = Mat.mul(pht, sInv, 8, 4, 4)
        val innov = DoubleArray(4) { z[it] - mean[it] }
        val nm = DoubleArray(8) { i -> mean[i] + (0 until 4).sumOf { j -> k[i * 4 + j] * innov[j] } }
        // P - K S K^T
        val ks = Mat.mul(k, s, 8, 4, 4)
        val kskt = Mat.mul(ks, Mat.transpose(k, 8, 4), 8, 4, 8)
        val nc = DoubleArray(64) { cov[it] - kskt[it] }
        return nm to nc
    }
}

object Mat {
    fun diag(d: DoubleArray): DoubleArray {
        val n = d.size
        return DoubleArray(n * n).also { for (i in 0 until n) it[i * n + i] = d[i] }
    }

    fun motion(): DoubleArray = DoubleArray(64).also {
        for (i in 0 until 8) it[i * 8 + i] = 1.0
        for (i in 0 until 4) it[i * 8 + i + 4] = 1.0
    }

    fun mul(a: DoubleArray, b: DoubleArray, n: Int, m: Int, p: Int): DoubleArray {
        val out = DoubleArray(n * p)
        for (i in 0 until n) for (k in 0 until m) {
            val v = a[i * m + k]
            if (v == 0.0) continue
            for (j in 0 until p) out[i * p + j] += v * b[k * p + j]
        }
        return out
    }

    fun transpose(a: DoubleArray, n: Int, m: Int): DoubleArray = DoubleArray(n * m).also {
        for (i in 0 until n) for (j in 0 until m) it[j * n + i] = a[i * m + j]
    }

    fun add(a: DoubleArray, b: DoubleArray) = DoubleArray(a.size) { a[it] + b[it] }

    /** Gauss-Jordan inverse of a 4x4 matrix (null when singular). */
    fun inverse4(m: DoubleArray): DoubleArray? {
        val a = Array(4) { r -> DoubleArray(8) { c -> if (c < 4) m[r * 4 + c] else if (c - 4 == r) 1.0 else 0.0 } }
        for (col in 0 until 4) {
            var piv = col
            for (r in col + 1 until 4) if (kotlin.math.abs(a[r][col]) > kotlin.math.abs(a[piv][col])) piv = r
            if (kotlin.math.abs(a[piv][col]) < 1e-12) return null
            val t = a[col]; a[col] = a[piv]; a[piv] = t
            val d = a[col][col]
            for (c in 0 until 8) a[col][c] /= d
            for (r in 0 until 4) if (r != col) {
                val f = a[r][col]
                if (f != 0.0) for (c in 0 until 8) a[r][c] -= f * a[col][c]
            }
        }
        return DoubleArray(16) { a[it / 4][4 + it % 4] }
    }
}

/** Optimal assignment (Hungarian / Kuhn-Munkres) for an n x m cost matrix. */
object Assignment {
    /** Returns (matches, unmatchedRows, unmatchedCols) keeping only pairs with cost <= [maxCost]. */
    fun assign(cost: Array<DoubleArray>, rows: Int, cols: Int, maxCost: Double): Triple<List<IntArray>, List<Int>, List<Int>> {
        if (rows == 0 || cols == 0) return Triple(emptyList(), (0 until rows).toList(), (0 until cols).toList())
        val n = max(rows, cols)
        val big = 1e9
        val c = Array(n) { i -> DoubleArray(n) { j -> if (i < rows && j < cols) cost[i][j] else big } }
        val rowFor = solve(c, n)
        val matches = ArrayList<IntArray>()
        val mr = BooleanArray(rows); val mc = BooleanArray(cols)
        for (j in 0 until n) {
            val i = rowFor[j]
            if (i in 0 until rows && j < cols && cost[i][j] <= maxCost) {
                matches.add(intArrayOf(i, j)); mr[i] = true; mc[j] = true
            }
        }
        return Triple(matches, (0 until rows).filter { !mr[it] }, (0 until cols).filter { !mc[it] })
    }

    /** O(n^3) Hungarian algorithm (e-maxx formulation); returns row assigned to each column. */
    private fun solve(a: Array<DoubleArray>, n: Int): IntArray {
        val inf = Double.MAX_VALUE / 4
        val u = DoubleArray(n + 1); val v = DoubleArray(n + 1)
        val p = IntArray(n + 1); val way = IntArray(n + 1)
        for (i in 1..n) {
            p[0] = i
            var j0 = 0
            val minv = DoubleArray(n + 1) { inf }
            val used = BooleanArray(n + 1)
            do {
                used[j0] = true
                val i0 = p[j0]
                var delta = inf
                var j1 = 0
                for (j in 1..n) if (!used[j]) {
                    val cur = a[i0 - 1][j - 1] - u[i0] - v[j]
                    if (cur < minv[j]) { minv[j] = cur; way[j] = j0 }
                    if (minv[j] < delta) { delta = minv[j]; j1 = j }
                }
                for (j in 0..n) {
                    if (used[j]) { u[p[j]] += delta; v[j] -= delta } else minv[j] -= delta
                }
                j0 = j1
            } while (p[j0] != 0)
            do {
                val j1 = way[j0]
                p[j0] = p[j1]
                j0 = j1
            } while (j0 != 0)
        }
        return IntArray(n) { j -> p[j + 1] - 1 }
    }
}

class FaceTrack(
    val trackId: Int,
    var mean: DoubleArray,
    var cov: DoubleArray,
    var score: Float,
    var frameId: Int,
) {
    var state = TrackState.NEW
    var hits = 1
    var scoreEma = 0f
    var peakEma = 0f
    var activated = false
    var detection: Detection? = null
    var lastBox = FloatArray(4)
    var lastGeom = Geom(0f, 0f, 0f, 0f)

    /** Matched detection box, else the last box moved by the predicted motion. */
    val bbox: FloatArray
        get() {
            detection?.let { return it.bbox }
            val (dx, dy) = drift()
            return floatArrayOf(lastBox[0] + dx, lastBox[1] + dy, lastBox[2] + dx, lastBox[3] + dy)
        }

    /** Held tracks keep their last size and tilt and only move with the motion model. */
    val geom: Geom
        get() {
            detection?.let { return it.oriented }
            val (dx, dy) = drift()
            return lastGeom.shifted(dx, dy)
        }

    private fun drift(): Pair<Float, Float> {
        val p = ByteTracker.xyahToTlbr(mean)
        return ((p[0] + p[2] - lastBox[0] - lastBox[2]) / 2) to ((p[1] + p[3] - lastBox[1] - lastBox[3]) / 2)
    }
}

class ByteTracker(var cfg: TrackerConfig, private val lowThreshold: Float) {
    private val kf = KalmanFilter()
    var frameId = 0
        private set
    private var nextId = 1
    var tracked = ArrayList<FaceTrack>()
        private set
    var lost = ArrayList<FaceTrack>()
        private set
    val selected = HashSet<Int>() // faces holding a slot in 1/2-face mode

    fun reset() {
        frameId = 0; nextId = 1
        tracked.clear(); lost.clear(); selected.clear()
    }

    private fun activate(det: Detection): FaceTrack {
        val (m, c) = kf.initiate(tlbrToXyah(det.bbox))
        val t = FaceTrack(nextId++, m, c, det.score, frameId)
        t.detection = det
        t.lastBox = det.bbox.copyOf()
        t.lastGeom = det.oriented
        t.scoreEma = det.score; t.peakEma = det.score
        t.state = TrackState.TRACKED
        t.activated = frameId == 1 || cfg.minHits <= 1
        return t
    }

    private fun update(t: FaceTrack, det: Detection) {
        val (m, c) = kf.update(t.mean, t.cov, tlbrToXyah(det.bbox))
        t.mean = m; t.cov = c
        t.detection = det
        t.lastBox = det.bbox.copyOf()
        t.lastGeom = det.oriented
        t.score = det.score
        t.scoreEma = 0.8f * t.scoreEma + 0.2f * det.score
        t.peakEma = max(t.peakEma, t.scoreEma)
        t.frameId = frameId
        t.hits++
        t.state = TrackState.TRACKED
        if (t.hits >= cfg.minHits) t.activated = true
    }

    private fun predictedBox(t: FaceTrack) = xyahToTlbr(t.mean)

    private fun iouCost(tracks: List<FaceTrack>, dets: List<Detection>, fuse: Boolean, gate: Float?): Array<DoubleArray> =
        Array(tracks.size) { i ->
            val tb = predictedBox(tracks[i])
            DoubleArray(dets.size) { j ->
                val iou = FaceGeometry.iou(tb, dets[j].bbox).toDouble()
                if (gate != null && iou < gate) 1e6
                else if (fuse) 1.0 - iou * (0.5 + 0.5 * dets[j].score) else 1.0 - iou
            }
        }

    /** Centre-distance fallback (in face widths) for fast motion; sizes must agree. */
    private fun motionMatch(tracks: List<FaceTrack>, dets: List<Detection>, maxDist: Double): Triple<List<IntArray>, List<Int>, List<Int>> {
        val cost = Array(tracks.size) { i ->
            val tb = predictedBox(tracks[i])
            val tsize = max(tb[2] - tb[0], tb[3] - tb[1]).coerceAtLeast(1f)
            val ta = ((tb[2] - tb[0]) * (tb[3] - tb[1])).coerceAtLeast(1f)
            DoubleArray(dets.size) { j ->
                val d = dets[j].bbox
                val dd = hypot(((tb[0] + tb[2]) - (d[0] + d[2])) / 2.0, ((tb[1] + tb[3]) - (d[1] + d[3])) / 2.0) / tsize
                val ratio = (d[2] - d[0]) * (d[3] - d[1]) / ta
                if (ratio > 0.45f && ratio < 2.2f) dd else 1e6
            }
        }
        return Assignment.assign(cost, tracks.size, dets.size, maxDist)
    }

    /**
     * Advance one frame; returns confirmed tracks visible in it. [canStart] limits
     * which detections may open a NEW track (any detection may continue one).
     */
    fun update(detections: List<Detection>, canStart: ((Detection) -> Boolean)? = null): List<FaceTrack> {
        frameId++
        val high = detections.filter { it.score >= cfg.highThreshold }
        val low = detections.filter { it.score >= lowThreshold && it.score < cfg.highThreshold }
        for (t in tracked + lost) {
            t.detection = null
            val (m, c) = kf.predict(t.mean, t.cov)
            t.mean = m; t.cov = c
        }
        val confirmed = tracked.filter { it.activated }
        val unconfirmed = tracked.filter { !it.activated }
        val pool = confirmed + lost

        // Stage 1: overlap gates the match, confidence only breaks ties.
        var (m1, uPool, uHigh) = Assignment.assign(iouCost(pool, high, true, cfg.matchIou), pool.size, high.size, 1.0)
        for (p in m1) update(pool[p[0]], high[p[1]])
        // Stage 1b: fast motion.
        run {
            val rt = uPool.map { pool[it] }
            val rd = uHigh.map { high[it] }
            val (mm, ut, ud) = motionMatch(rt, rd, 1.0)
            for (p in mm) update(rt[p[0]], rd[p[1]])
            uPool = ut.map { uPool[it] }
            uHigh = ud.map { uHigh[it] }
        }

        // Stage 2: low-score detections vs still-unmatched tracked tracks.
        val remain = uPool.map { pool[it] }.filter { it.state == TrackState.TRACKED }
        val (m2, uRemain0, uLow) = Assignment.assign(iouCost(remain, low, false, null), remain.size, low.size, 1.0 - cfg.lowMatchIou)
        for (p in m2) update(remain[p[0]], low[p[1]])
        val rt = uRemain0.map { remain[it] }
        val rd = uLow.map { low[it] }
        val (mm2, ut2, _) = motionMatch(rt, rd, 0.6)
        for (p in mm2) update(rt[p[0]], rd[p[1]])
        for (i in ut2) rt[i].state = TrackState.LOST

        // Stage 3: unconfirmed tracks vs leftover high detections.
        val leftHigh = uHigh.map { high[it] }
        val (m3, uUnconf, uNew) = Assignment.assign(iouCost(unconfirmed, leftHigh, false, null), unconfirmed.size, leftHigh.size, 1.0 - cfg.matchIou)
        for (p in m3) update(unconfirmed[p[0]], leftHigh[p[1]])
        for (i in uUnconf) unconfirmed[i].state = TrackState.REMOVED

        // Stage 4: new tracks.
        val newTracks = uNew.map { leftHigh[it] }
            .filter { it.score >= cfg.newTrackThreshold && (canStart == null || canStart(it)) }
            .map { activate(it) }

        val everyone = pool + unconfirmed + newTracks
        for (t in everyone) {
            if (t.state == TrackState.LOST && frameId - t.frameId > cfg.maxLostFrames) t.state = TrackState.REMOVED
        }
        tracked = ArrayList(everyone.filter { it.state == TrackState.TRACKED })
        lost = ArrayList(everyone.filter { it.state == TrackState.LOST })
        dedupe()
        return tracked.filter { it.activated }
    }

    private fun dedupe() {
        if (tracked.isEmpty() || lost.isEmpty()) return
        lost = ArrayList(lost.filter { lt ->
            val lb = predictedBox(lt)
            tracked.none { FaceGeometry.iou(lb, predictedBox(it)) > 0.85f }
        })
    }

    /** Established tracks that disappeared within [maxFrames] (anti-flicker hold). */
    fun recentlyLost(maxFrames: Int, minHits: Int = 2): List<FaceTrack> =
        lost.filter { it.activated && it.hits >= minHits && frameId - it.frameId <= maxFrames }

    companion object {
        fun tlbrToXyah(b: FloatArray): DoubleArray {
            val w = (b[2] - b[0]).toDouble(); val h = (b[3] - b[1]).toDouble()
            return doubleArrayOf(b[0] + w / 2, b[1] + h / 2, w / max(h, 1e-6), h)
        }

        fun xyahToTlbr(m: DoubleArray): FloatArray {
            val w = m[2] * m[3]; val h = m[3]
            return floatArrayOf((m[0] - w / 2).toFloat(), (m[1] - h / 2).toFloat(), (m[0] + w / 2).toFloat(), (m[1] + h / 2).toFloat())
        }
    }
}
