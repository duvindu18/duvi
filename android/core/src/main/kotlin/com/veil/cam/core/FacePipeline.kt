package com.veil.cam.core

import kotlin.math.hypot
import kotlin.math.max

data class BlurConfig(
    val enabled: Boolean = true,
    val maxFaces: Int = 2, // 1, 2 or 0 = any
    val strictScore: Float = 0.5f,
    val holdFrames: Int = 8,
    val detThreshold: Float = 0.35f,
    val lowThreshold: Float = 0.15f,
)

/** A face to anonymize, in image pixels, with its velocity in pixels per second. */
data class FaceView(
    val id: Int,
    val geom: Geom,
    val lost: Boolean,
    val vx: Float = 0f,
    val vy: Float = 0f,
)

/** Detection + tracking result for the camera frame captured at [timestampNs]. */
data class FaceResult(val timestampNs: Long, val faces: List<FaceView>)

/**
 * Track, select and decide, frame by frame, exactly like the desktop pipeline:
 * strict 1/2-face mode with sticky slots, implausible detections may continue a
 * known face but never start one, briefly lost faces are held.
 */
class FaceTracker(private var cfg: BlurConfig) {
    private val tracker = ByteTracker(TrackerConfig(), cfg.lowThreshold)
    private val prev = HashMap<Int, Triple<Float, Float, Long>>()

    fun configure(c: BlurConfig) { cfg = c }

    fun reset() { tracker.reset(); prev.clear() }

    fun process(detections: List<Detection>, timestampNs: Long): FaceResult {
        val strict = cfg.maxFaces > 0
        var tracks = tracker.update(detections, if (strict) FaceGeometry::plausible else null)
        var lingering = tracker.recentlyLost(cfg.holdFrames)
        if (strict) {
            val r = Selector.strongest(tracks, lingering, cfg.maxFaces, cfg.strictScore, tracker.selected)
            tracks = r.first; lingering = r.second
        }
        val out = ArrayList<FaceView>()
        val seen = HashMap<Int, Triple<Float, Float, Long>>()
        for ((t, lost) in tracks.map { it to false } + lingering.map { it to true }) {
            val g = t.geom
            var vx = 0f; var vy = 0f
            prev[t.trackId]?.let { (px, py, pt) ->
                val dt = (timestampNs - pt) / 1e9f
                if (dt > 1e-3f && dt < 1f) { vx = (g.cx - px) / dt; vy = (g.cy - py) / dt }
            }
            seen[t.trackId] = Triple(g.cx, g.cy, timestampNs)
            out.add(FaceView(t.trackId, g, lost, vx, vy))
        }
        prev.clear(); prev.putAll(seen)
        return FaceResult(timestampNs, out)
    }
}

object Selector {
    fun sameFace(new: FloatArray, old: FloatArray): Boolean {
        if (FaceGeometry.iou(new, old) > 0.3f) return true
        val nw = max(1f, new[2] - new[0]); val ow = max(1f, old[2] - old[0])
        if (nw / ow !in 0.6f..1.65f) return false
        val d = hypot(((new[0] + new[2]) - (old[0] + old[2])) / 2f, ((new[1] + new[3]) - (old[1] + old[3])) / 2f)
        return d <= 2f * max(nw, ow)
    }

    /**
     * Keep the [n] most credible faces with sticky slots: a held face keeps its
     * slot while visible or briefly lost; a re-found face inherits its slot; a
     * confident visible face outranks a holder that is not seen; only a clearly
     * stronger established face displaces a visible holder.
     */
    fun strongest(
        tracks: List<FaceTrack>, lingering: List<FaceTrack>, n: Int, minScore: Float, selected: MutableSet<Int>,
    ): Pair<List<FaceTrack>, List<FaceTrack>> {
        fun qualifies(t: FaceTrack) = t.scoreEma >= minScore || (t.peakEma >= minScore && t.scoreEma >= 0.6f * minScore)
        val pool = tracks.map { it to false } + lingering.map { it to true }
        val alive = pool.map { it.first.trackId }.toSet()
        val held = pool.map { it.first }.filter { it.trackId in selected }
        for ((t, lost) in pool) {
            if (lost || t.trackId in selected) continue
            for (h in held) {
                if (h.detection == null && sameFace(t.bbox, h.bbox)) {
                    selected.remove(h.trackId); selected.add(t.trackId)
                    t.hits = max(t.hits, h.hits)
                    t.peakEma = max(t.peakEma, h.peakEma)
                    t.scoreEma = max(t.scoreEma, h.scoreEma)
                    break
                }
            }
        }
        val rank = compareByDescending<Pair<FaceTrack, Boolean>> { minOf(it.first.hits, 10) }
            .thenByDescending { it.first.scoreEma }
            .thenByDescending { it.first.lastGeom.w * it.first.lastGeom.h }
        val incumbent = pool.filter { it.first.trackId in selected && (qualifies(it.first) || it.second) }.sortedWith(rank)
        val challengers = pool.filter { it.first.trackId !in selected && qualifies(it.first) }.sortedWith(rank).toMutableList()
        val strong = max(minScore + 0.15f, 0.7f)
        val liveInc = incumbent.filter { !it.second }.take(n).toMutableList()
        val lostInc = incumbent.filter { it.second }
        while (challengers.isNotEmpty() && liveInc.size >= n) {
            val best = challengers[0]
            val weakest = liveInc.last().first
            if (!best.second && best.first.hits >= 5 && best.first.scoreEma > weakest.scoreEma + 0.15f) {
                liveInc[liveInc.size - 1] = challengers.removeAt(0)
                liveInc.sortWith(rank)
            } else break
        }
        val strongLive = challengers.filter { !it.second && it.first.scoreEma >= strong }
        val others = challengers.filter { it !in strongLive }
        val keep = (liveInc + strongLive + lostInc + others).take(n)
        selected.clear()
        keep.forEach { if (it.first.trackId in alive) selected.add(it.first.trackId) }
        return keep.filter { !it.second }.map { it.first } to keep.filter { it.second }.map { it.first }
    }
}

/**
 * Recent results on the camera clock. [at] gives the faces for any frame time:
 * interpolated between the results around it, a face seen only in the next
 * result is included (privacy first: it is about to be visible), and only
 * results at most [maxExtrapolateNs] old are carried forward by velocity.
 */
class FaceTimeline(private val capacity: Int = 32, private val maxExtrapolateNs: Long = 400_000_000L) {
    private val items = ArrayDeque<FaceResult>()

    @Synchronized fun add(r: FaceResult) {
        while (items.isNotEmpty() && items.last().timestampNs >= r.timestampNs) items.removeLast()
        items.addLast(r)
        while (items.size > capacity) items.removeFirst()
    }

    @Synchronized fun clear() = items.clear()

    @Synchronized fun latestTimestamp(): Long = items.lastOrNull()?.timestampNs ?: Long.MIN_VALUE

    @Synchronized fun at(t: Long, lookAheadNs: Long = 250_000_000L): List<Geom> {
        if (items.isEmpty()) return emptyList()
        var before: FaceResult? = null
        var after: FaceResult? = null
        for (r in items) {
            if (r.timestampNs <= t) before = r else { after = r; break }
        }
        val out = ArrayList<Geom>()
        if (before == null) {
            val a = after ?: return emptyList()
            if (a.timestampNs - t <= lookAheadNs) a.faces.forEach { out.add(it.geom) }
            return FaceGeometry.dedupe(out)
        }
        if (after == null) {
            val age = t - before.timestampNs
            if (age > maxExtrapolateNs) {
                // Stale: keep the faces where they were (never drop a blur on a stall).
                before.faces.forEach { out.add(it.geom) }
            } else {
                val dt = age / 1e9f
                before.faces.forEach { out.add(it.geom.shifted(it.vx * dt, it.vy * dt)) }
            }
            return FaceGeometry.dedupe(out)
        }
        val span = (after.timestampNs - before.timestampNs).toFloat()
        val f = if (span > 0) ((t - before.timestampNs) / span).coerceIn(0f, 1f) else 0f
        val next = after.faces.associateBy { it.id }
        for (a in before.faces) {
            val b = next[a.id]
            if (b != null) out.add(lerp(a.geom, b.geom, f)) else out.add(a.geom)
        }
        val known = before.faces.map { it.id }.toSet()
        if (after.timestampNs - t <= lookAheadNs) {
            for (b in after.faces) if (b.id !in known) out.add(b.geom)
        }
        return FaceGeometry.dedupe(out)
    }

    private fun lerp(a: Geom, b: Geom, f: Float): Geom {
        var da = (b.angle - a.angle + 180f) % 360f
        if (da < 0) da += 360f
        da -= 180f
        return Geom(
            a.cx + (b.cx - a.cx) * f, a.cy + (b.cy - a.cy) * f,
            a.w + (b.w - a.w) * f, a.h + (b.h - a.h) * f,
            a.angle + da * f, a.margin + (b.margin - a.margin) * f,
        )
    }
}
