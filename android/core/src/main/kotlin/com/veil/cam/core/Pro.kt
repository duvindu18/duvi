package com.veil.cam.core

import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

// ---- Cinema file naming ---------------------------------------------------------------------

/** Camera letter, reel and clip: A001_C001_20261114. */
data class ClipName(val camera: Char, val reel: Int, val clip: Int, val date: String) {
    val base: String get() = "%c%03d_C%03d_%s".format(camera, reel, clip, date)
    val reelName: String get() = "%c%03d".format(camera, reel)
}

/** Counter state kept between takes. [lastDate] is the date of the last clip (yyyyMMdd). */
data class NamingState(val camera: Char = 'A', val reel: Int = 1, val clip: Int = 0, val lastDate: String = "")

object ClipNaming {
    /**
     * The next clip: the clip number counts up within a reel. A new reel starts (clip back
     * to 1) on a new day when [newReelDaily], or when [forceNewReel].
     */
    fun next(s: NamingState, today: String, newReelDaily: Boolean = true, forceNewReel: Boolean = false): Pair<ClipName, NamingState> {
        val newReel = forceNewReel || (newReelDaily && s.lastDate.isNotEmpty() && s.lastDate != today)
        val reel = if (newReel) s.reel + 1 else s.reel
        val clip = if (newReel) 1 else s.clip + 1
        val r = reel.coerceIn(1, 999)
        val c = if (clip > 999) 1 else clip
        val n = ClipName(s.camera, r, c, today)
        return n to NamingState(s.camera, r, c, today)
    }
}

// ---- Easing / programmable focus pulls ---------------------------------------------------------

enum class Ease(val label: String) {
    LINEAR("Linear"), EASE_IN("Ease in"), EASE_OUT("Ease out"), EASE_IN_OUT("Ease in-out"), S_CURVE("S-curve");

    /** 0..1 -> 0..1, monotonic, exact at both ends. */
    fun at(t: Float): Float {
        val x = t.coerceIn(0f, 1f)
        return when (this) {
            LINEAR -> x
            EASE_IN -> x * x * x
            EASE_OUT -> 1f - (1f - x).pow(3)
            EASE_IN_OUT -> (0.5f - 0.5f * cos(Math.PI * x).toFloat())
            S_CURVE -> x * x * x * (x * (6f * x - 15f) + 10f) // smootherstep
        }
    }
}

/**
 * A focus mark: lens focus in diopters (1/m, linear in focus-ring travel, so pulls look
 * like a follow-focus) and, for cinematic depth, the depth value of the subject.
 */
data class FocusMark(val diopters: Float, val depth: Float, val imgX: Float, val imgY: Float)

class FocusPull(val a: FocusMark, val b: FocusMark, val durationMs: Long, val ease: Ease, val reverse: Boolean = false) {
    private fun lerp(x: Float, y: Float, t: Float) = x + (y - x) * t
    /** Mark at [elapsedMs] into the pull (clamped). */
    fun at(elapsedMs: Long): FocusMark {
        val t = ease.at(if (durationMs <= 0) 1f else elapsedMs.toFloat() / durationMs)
        val (from, to) = if (reverse) b to a else a to b
        return FocusMark(lerp(from.diopters, to.diopters, t), lerp(from.depth, to.depth, t), lerp(from.imgX, to.imgX, t), lerp(from.imgY, to.imgY, t))
    }
    fun done(elapsedMs: Long) = elapsedMs >= durationMs
}

// ---- Burst alignment --------------------------------------------------------------------------

object BurstAlign {
    private fun down(src: FloatArray, w: Int, h: Int): Triple<FloatArray, Int, Int> {
        val nw = max(1, w / 2); val nh = max(1, h / 2)
        val o = FloatArray(nw * nh)
        for (y in 0 until nh) for (x in 0 until nw) {
            val x0 = 2 * x; val y0 = 2 * y
            val x1 = min(w - 1, x0 + 1); val y1 = min(h - 1, y0 + 1)
            o[y * nw + x] = (src[y0 * w + x0] + src[y0 * w + x1] + src[y1 * w + x0] + src[y1 * w + x1]) * 0.25f
        }
        return Triple(o, nw, nh)
    }

    private fun sad(a: FloatArray, b: FloatArray, w: Int, h: Int, dx: Int, dy: Int, border: Int): Float {
        var s = 0f; var n = 0
        var y = border
        while (y < h - border) {
            val yy = y + dy
            if (yy in 0 until h) {
                var x = border
                while (x < w - border) {
                    val xx = x + dx
                    if (xx in 0 until w) { s += abs(a[y * w + x] - b[yy * w + xx]); n++ }
                    x += 1
                }
            }
            y += 1
        }
        return if (n == 0) Float.MAX_VALUE else s / n
    }

    /**
     * Shift (px) that maps [ref] onto [img]: img(x + dx, y + dy) ~ ref(x, y). Coarse-to-fine
     * search on a pyramid with sub-pixel refinement; [maxShift] in full-size pixels.
     */
    fun translation(ref: FloatArray, img: FloatArray, w: Int, h: Int, maxShift: Int = 48): Pair<Float, Float> {
        val pr = arrayListOf(Triple(ref, w, h)); val pi = arrayListOf(Triple(img, w, h))
        while (pr.last().second > 48 && pr.size < 5) { val r = pr.last(); val i = pi.last(); pr += down(r.first, r.second, r.third); pi += down(i.first, i.second, i.third) }
        var dx = 0; var dy = 0
        for (lvl in pr.indices.reversed()) {
            val (a, lw, lh) = pr[lvl]; val b = pi[lvl].first
            val scale = 1 shl lvl
            val r = if (lvl == pr.size - 1) max(2, maxShift / scale) else 2
            val border = max(2, min(lw, lh) / 16)
            var best = Float.MAX_VALUE; var bx = dx; var by = dy
            for (yy in dy - r..dy + r) for (xx in dx - r..dx + r) {
                val s = sad(a, b, lw, lh, xx, yy, border)
                if (s < best) { best = s; bx = xx; by = yy }
            }
            dx = bx; dy = by
            if (lvl == 0) {
                // Sub-pixel: parabola through the neighbours.
                fun para(m: Float, c: Float, p: Float) = if (m + p - 2 * c > 1e-9f) 0.5f * (m - p) / (m + p - 2 * c) else 0f
                val c = best
                val sx = para(sad(a, b, lw, lh, bx - 1, by, border), c, sad(a, b, lw, lh, bx + 1, by, border)).coerceIn(-0.5f, 0.5f)
                val sy = para(sad(a, b, lw, lh, bx, by - 1, border), c, sad(a, b, lw, lh, bx, by + 1, border)).coerceIn(-0.5f, 0.5f)
                return (bx + sx) to (by + sy)
            }
            dx *= 2; dy *= 2
        }
        return dx.toFloat() to dy.toFloat()
    }
}

// ---- Scene recognition ------------------------------------------------------------------------

enum class Scene(val label: String) {
    AUTO("Auto"), NIGHT("Night"), LOW_LIGHT("Low light"), BACKLIT("Backlit"), PORTRAIT("Portrait"),
    MACRO("Close-up"), LANDSCAPE("Landscape"), BRIGHT("Bright"),
}

/** What the camera should do for the scene (photos; video is only advised). */
data class SceneAdvice(val scene: Scene, val mergeFrames: Int, val hdrEv: Int, val note: String)

/**
 * Scene recognition from what the camera already measures: exposure (ISO x time, i.e.
 * scene brightness), the histogram (clipping, shadows), faces and focus distance.
 * Hysteresis: a scene must hold for a few readings before the advice changes.
 */
class SceneAnalyzer {
    private var current = Scene.AUTO
    private var candidate = Scene.AUTO
    private var count = 0

    fun classify(iso: Int, exposureNs: Long, luma: IntArray?, faceArea: Float, focusDiopters: Float): Scene {
        // Light level from the exposure the camera chose: ISO 100 at 1/100 s ~ indoor light.
        val ev = if (iso > 0 && exposureNs > 0) iso.toDouble() * exposureNs / 1e9 / 100.0 * 100 else 1.0 // ~1 indoors
        var mean = 0.5; var clip = 0.0; var dark = 0.0
        if (luma != null && luma.isNotEmpty()) {
            val n = luma.sum().coerceAtLeast(1).toDouble()
            mean = luma.indices.sumOf { (it + 0.5) / luma.size * luma[it] } / n
            clip = luma.takeLast(max(1, luma.size / 32)).sum() / n
            dark = luma.take(max(1, luma.size / 6)).sum() / n
        }
        return when {
            ev > 8.0 || (iso >= 3200) -> Scene.NIGHT
            ev > 2.5 || iso >= 1250 -> Scene.LOW_LIGHT
            clip > 0.04 && dark > 0.22 -> Scene.BACKLIT
            focusDiopters > 6f -> Scene.MACRO
            faceArea > 0.02f -> Scene.PORTRAIT
            ev < 0.05 && mean > 0.55 -> Scene.BRIGHT
            focusDiopters in 0f..0.15f && ev < 0.3 -> Scene.LANDSCAPE
            else -> Scene.AUTO
        }
    }

    /** Feed one reading; returns the stable scene. */
    fun update(iso: Int, exposureNs: Long, luma: IntArray?, faceArea: Float, focusDiopters: Float): Scene {
        val s = classify(iso, exposureNs, luma, faceArea, focusDiopters)
        if (s == candidate) count++ else { candidate = s; count = 1 }
        if (count >= 4) current = candidate
        return current
    }

    companion object {
        fun advice(s: Scene): SceneAdvice = when (s) {
            Scene.NIGHT -> SceneAdvice(s, 8, 0, "Night: 8 frames merged for low noise")
            Scene.LOW_LIGHT -> SceneAdvice(s, 6, 0, "Low light: 6 frames merged")
            Scene.BACKLIT -> SceneAdvice(s, 6, -1, "Backlit: HDR merge keeps the sky and lifts the shadows")
            Scene.BRIGHT -> SceneAdvice(s, 3, -1, "Bright: HDR merge protects highlights")
            Scene.PORTRAIT -> SceneAdvice(s, 3, 0, "Portrait: 3 frames merged, skin kept natural")
            Scene.MACRO -> SceneAdvice(s, 2, 0, "Close-up: hold steady")
            Scene.LANDSCAPE -> SceneAdvice(s, 4, -1, "Landscape: HDR merge")
            Scene.AUTO -> SceneAdvice(s, 3, 0, "")
        }
    }
}

// ---- Framing guidance -------------------------------------------------------------------------

/** A framing hint in normalised frame coordinates (x right, y down, 0..1). */
data class FramingHint(val fromX: Float, val fromY: Float, val toX: Float, val toY: Float, val message: String)

object FramingAdvisor {
    /**
     * Rule of thirds for the main subject: its eyes (upper part of the face box) belong on
     * a thirds line; suggest the nearest thirds intersection when it is clearly off, and
     * warn about headroom. Boxes are (cx, cy, w, h) in the recorded frame, normalised.
     */
    fun advise(faces: List<FloatArray>, rollDeg: Float): List<FramingHint> {
        val out = ArrayList<FramingHint>()
        if (abs(rollDeg) in 1.5f..10f) out += FramingHint(0.5f, 0.5f, 0.5f, 0.5f, if (rollDeg > 0) "Level: turn slightly left" else "Level: turn slightly right")
        val f = faces.maxByOrNull { it[2] * it[3] } ?: return out
        val ex = f[0]; val ey = f[1] - f[3] * 0.15f
        if (f[1] - f[3] / 2 < 0.02f) out += FramingHint(ex, ey, ex, ey + 0.06f, "Tilt down: no headroom")
        if (f[2] > 0.45f) return out // a close-up fills the frame; thirds do not apply
        val tx = if (ex < 0.5f) 1f / 3 else 2f / 3
        val ty = 1f / 3
        val d = hypot(ex - tx, ey - ty)
        if (d > 0.09f) out += FramingHint(ex, ey, tx, ty, "Place the eyes on the ${if (tx < 0.5f) "left" else "right"} third")
        return out
    }
}

// ---- Pre-record ring of encoded samples --------------------------------------------------------

/** One encoded sample kept in memory: [track] 0 video, 1 audio. */
class EncodedSample(val track: Int, val ptsUs: Long, val key: Boolean, val data: ByteArray, val flags: Int)

/**
 * The last few seconds of encoded video and audio, for retroactive capture. A take
 * starts at the newest video keyframe that is at least [windowUs] old (so the clip holds
 * the full pre-record time and starts decodable), with the audio from that moment.
 */
class PacketRing(var windowUs: Long, private val maxBytes: Long = 160L * 1024 * 1024) {
    private val items = ArrayDeque<EncodedSample>()
    private var bytes = 0L

    val size get() = items.size
    val durationUs: Long get() = if (items.isEmpty()) 0 else items.last().ptsUs - items.first().ptsUs

    @Synchronized fun add(s: EncodedSample) {
        items.addLast(s); bytes += s.data.size
        trim()
    }

    @Synchronized fun clear() { items.clear(); bytes = 0 }

    private fun newestVideoUs() = items.lastOrNull { it.track == 0 }?.ptsUs ?: Long.MIN_VALUE

    /** Drop what is no longer needed: keep from the last keyframe older than the window. */
    private fun trim() {
        val newest = newestVideoUs()
        if (newest == Long.MIN_VALUE) return
        val cutoff = newest - windowUs
        // Index of the newest video keyframe at or before the cutoff.
        var keep = -1
        for ((i, s) in items.withIndex()) {
            if (s.track == 0 && s.key && s.ptsUs <= cutoff) keep = i
            if (s.ptsUs > cutoff) break
        }
        var drop = if (keep > 0) keep else 0
        while (bytes > maxBytes && drop < items.size - 1) drop++
        repeat(drop) { bytes -= items.removeFirst().data.size }
    }

    /** Samples for a take starting now: from a keyframe, audio from that moment on. */
    @Synchronized fun take(): List<EncodedSample> {
        val firstKey = items.indexOfFirst { it.track == 0 && it.key }
        if (firstKey < 0) return emptyList()
        val start = items[firstKey].ptsUs
        return items.drop(firstKey).filter { it.track == 0 || it.ptsUs >= start }
    }
}

// ---- Accessory buttons (gimbals, Bluetooth remotes) ----------------------------------------------

/** What a hardware button does. */
enum class KeyAction(val label: String) {
    RECORD("Record / stop"), PHOTO("Shutter"), ZOOM_IN("Zoom in"), ZOOM_OUT("Zoom out"),
    SWITCH_LENS("Front / back"), PULL("Run A-B focus pull"), PAUSE("Pause recording"),
    MODE_NEXT("Next mode"), MODE_PREV("Previous mode"), NONE("Nothing"),
}

/**
 * Key code -> action for Bluetooth accessories. A gimbal such as the Osmo Mobile 7 in
 * Bluetooth camera-control mode sends standard HID keys (shutter as volume / camera keys,
 * zoom as volume or zoom keys); remotes send media keys. Anything else can be learnt.
 * Key codes are Android's (KeyEvent.KEYCODE_*), kept as numbers so this stays pure Kotlin.
 */
object AccessoryKeys {
    const val VOLUME_UP = 24; const val VOLUME_DOWN = 25; const val CAMERA = 27; const val FOCUS = 80
    const val ENTER = 66; const val SPACE = 62; const val DPAD_UP = 19; const val DPAD_DOWN = 20
    const val DPAD_LEFT = 21; const val DPAD_RIGHT = 22; const val DPAD_CENTER = 23
    const val MEDIA_PLAY_PAUSE = 85; const val MEDIA_NEXT = 87; const val MEDIA_PREVIOUS = 88
    const val MEDIA_PLAY = 126; const val MEDIA_PAUSE = 127; const val MEDIA_RECORD = 130
    const val ZOOM_IN = 168; const val ZOOM_OUT = 169; const val HEADSETHOOK = 79
    const val PAGE_UP = 92; const val PAGE_DOWN = 93

    val defaults: Map<Int, KeyAction> = mapOf(
        VOLUME_UP to KeyAction.RECORD, VOLUME_DOWN to KeyAction.RECORD, CAMERA to KeyAction.RECORD,
        MEDIA_RECORD to KeyAction.RECORD, MEDIA_PLAY_PAUSE to KeyAction.RECORD, HEADSETHOOK to KeyAction.RECORD,
        ENTER to KeyAction.RECORD, SPACE to KeyAction.RECORD, DPAD_CENTER to KeyAction.RECORD,
        MEDIA_PLAY to KeyAction.RECORD, MEDIA_PAUSE to KeyAction.PAUSE,
        ZOOM_IN to KeyAction.ZOOM_IN, ZOOM_OUT to KeyAction.ZOOM_OUT,
        DPAD_UP to KeyAction.ZOOM_IN, DPAD_DOWN to KeyAction.ZOOM_OUT, PAGE_UP to KeyAction.ZOOM_IN, PAGE_DOWN to KeyAction.ZOOM_OUT,
        DPAD_LEFT to KeyAction.MODE_PREV, DPAD_RIGHT to KeyAction.MODE_NEXT,
        MEDIA_NEXT to KeyAction.MODE_NEXT, MEDIA_PREVIOUS to KeyAction.MODE_PREV,
        FOCUS to KeyAction.PULL,
    )

    /** Learnt keys override the defaults; "24=ZOOM_IN,130=RECORD". */
    fun parse(s: String): Map<Int, KeyAction> = s.split(',').mapNotNull { e ->
        val kv = e.split('='); if (kv.size != 2) return@mapNotNull null
        val k = kv[0].trim().toIntOrNull() ?: return@mapNotNull null
        val a = KeyAction.entries.firstOrNull { it.name == kv[1].trim() } ?: return@mapNotNull null
        k to a
    }.toMap()

    fun format(m: Map<Int, KeyAction>): String = m.entries.sortedBy { it.key }.joinToString(",") { "${it.key}=${it.value.name}" }

    fun actionFor(keyCode: Int, learnt: Map<Int, KeyAction>, volumeAsShutter: Boolean): KeyAction? {
        learnt[keyCode]?.let { return it }
        if (!volumeAsShutter && (keyCode == VOLUME_UP || keyCode == VOLUME_DOWN)) return null
        return defaults[keyCode]
    }

    /** Zoom buttons repeat while held; everything else fires once per press. */
    fun repeats(a: KeyAction) = a == KeyAction.ZOOM_IN || a == KeyAction.ZOOM_OUT
}
