package com.veil.cam.face

import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtLoggingLevel
import ai.onnxruntime.OrtSession
import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Log
import com.veil.cam.Settings
import com.veil.cam.core.Angles
import com.veil.cam.core.BlurConfig
import com.veil.cam.core.FaceResult
import com.veil.cam.core.FaceTimeline
import com.veil.cam.core.FaceTracker
import com.veil.cam.core.MultiAngleDetector
import com.veil.cam.core.PassImage
import com.veil.cam.core.PowerBudget
import com.veil.cam.core.PowerMode
import com.veil.cam.core.Scrfd
import com.veil.cam.core.FaceModel
import com.veil.cam.core.YuNet
import com.veil.cam.power.WorkHint
import java.util.concurrent.atomic.AtomicBoolean

/** Pixels of the detector passes of one camera frame. */
class DetectBatch(val timestampNs: Long, val imgW: Int, val imgH: Int, val passes: List<PassImage>, val recycle: () -> Unit)

/**
 * Runs the face model off the GL thread. One batch at a time: the renderer only
 * captures a new frame for detection when the previous one is done, so the
 * detector always works on the freshest frame and never builds a backlog.
 */
class FaceEngine(private val context: Context) {
    private val thread = HandlerThread("Faces").apply { start(); priority = Thread.MAX_PRIORITY - 1 }
    private val handler = Handler(thread.looper)
    private val env = OrtEnvironment.getEnvironment()
    private var scrfd: FaceModel? = null
    private var modelName = ""
    private var detector: MultiAngleDetector? = null
    private var anglesKey = ""
    private var tracker = FaceTracker(BlurConfig())
    private var cfg = BlurConfig()

    val timeline = FaceTimeline()
    private val busy = AtomicBoolean(false)
    @Volatile var ready = false
        private set
    @Volatile var plan: List<Int> = Angles.FULL.toList()
        private set
    @Volatile var lastMs = 0f
        private set
    @Volatile var rate = 0f
        private set
    @Volatile var lastFaces: FaceResult? = null
        private set
    var onError: ((String) -> Unit)? = null
    private var lastDone = 0L
    private var threads = 2
    @Volatile private var sweepEvery = 2
    private var hint: WorkHint? = null
    private var hintTargetNs = 20_000_000L
    private var efficient = false

    val isBusy: Boolean get() = busy.get()
    @Volatile private var accurate = false

    /**
     * Long side of the detector's base canvas. YuNet is lighter per pixel than SCRFD but
     * needs more pixels for small faces, so it runs on a larger canvas (measured: at
     * 960 px it finds more 24-48 px faces than SCRFD-500M at 640, for ~1.2x its time).
     */
    fun baseSide(accurate: Boolean = this.accurate): Int = when {
        YUNET -> if (accurate) 1280 else 960
        accurate -> 640
        else -> 480
    }

    init {
        handler.post { hint = WorkHint(context, android.os.Process.myTid(), hintTargetNs) }
    }

    /** Power budget: rotated-pass cadence, the deadline one detection should meet, efficiency bias. */
    fun setBudget(b: PowerBudget, frameNs: Long) {
        handler.post {
            sweepEvery = b.sweepEvery
            detector?.sweepEvery = b.sweepEvery
            // Full speed: finish within half a frame; otherwise within ~80 % of a frame,
            // which still keeps a frame's wait in the ring short.
            hintTargetNs = (frameNs * if (b.tier == 0) 0.5 else 0.8).toLong()
            hint?.target(hintTargetNs)
            if (b.preferEfficiency != efficient) { efficient = b.preferEfficiency; hint?.preferEfficiency(efficient) }
        }
    }

    fun configure(s: Settings) {
        handler.post {
            cfg = BlurConfig(enabled = s.blurOn, maxFaces = s.maxFaces, holdFrames = s.holdFrames)
            tracker.configure(cfg)
            val want = if (YUNET) YUNET_MODEL else if (s.accurateModel) "det_10g.onnx" else "det_500m.onnx"
            accurate = s.accurateModel
            // Tensor G4: 1 prime + 3 mid + 4 little cores. Two threads land on the mid
            // cores and run the small model in a few ms; four also wake the prime core,
            // which is faster but far less efficient, so only Max quality uses them.
            val wantThreads = if (s.powerMode == PowerMode.MAX) 4 else 2
            if (want != modelName || wantThreads != threads) { threads = wantThreads; load(want) }
            val key = if (s.allAngles) "full" else "tilt"
            if (key != anglesKey || detector == null) {
                anglesKey = key
                val angles = if (s.allAngles) Angles.FULL else Angles.TILT
                val perFrame = if (s.accurateModel) 1 else 2
                detector = MultiAngleDetector(angles, perFrame) { p, th ->
                    scrfd?.detect(p.pixels, p.spec.width, p.spec.height, p.channels, th, p.bottomUp) ?: emptyList()
                }.also { it.sweepEvery = sweepEvery }
                plan = detector!!.nextPlan()
            }
        }
    }

    private fun load(name: String) {
        ready = false
        runCatching { scrfd?.close() }
        scrfd = null
        try {
            val bytes = context.assets.open(name).use { it.readBytes() }
            val opts = OrtSession.SessionOptions().apply {
                setSessionLogLevel(OrtLoggingLevel.ORT_LOGGING_LEVEL_ERROR)
                setIntraOpNumThreads(threads.coerceAtMost(Runtime.getRuntime().availableProcessors()))
                setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
                // Worker threads sleep between inferences instead of busy-spinning: with one
                // detection every few frames, spinning would keep cores at full clock for nothing.
                addConfigEntry("session.intra_op.allow_spinning", "0")
                addConfigEntry("session.inter_op.allow_spinning", "0")
            }
            val session = env.createSession(bytes, opts)
            scrfd = if (name == YUNET_MODEL) YuNet(session, env) else Scrfd(session, env)
            modelName = name
            ready = true
        } catch (e: Exception) {
            Log.e(TAG, "model load failed", e)
            if (name == "det_10g.onnx") load("det_500m.onnx") else onError?.invoke("Face model could not be loaded: ${e.message}")
        }
    }

    /** New scene (camera switch / restart): forget tracks and sweep every angle again. */
    fun reset() {
        handler.post {
            tracker.reset()
            detector?.reset()
            detector?.let { plan = it.nextPlan() }
            timeline.clear()
            lastFaces = null
        }
    }

    /** Returns false (and recycles nothing) when a batch is already running. */
    fun submit(batch: DetectBatch): Boolean {
        if (!busy.compareAndSet(false, true)) return false
        handler.post {
            try {
                val det = detector
                if (det != null && scrfd != null) {
                    val t0 = SystemClock.elapsedRealtimeNanos()
                    val faces = det.run(batch.passes, batch.imgW, batch.imgH, cfg.lowThreshold)
                    val result = tracker.process(faces, batch.timestampNs)
                    timeline.add(result)
                    lastFaces = result
                    plan = det.nextPlan()
                    val t1 = SystemClock.elapsedRealtimeNanos()
                    hint?.report(t1 - t0)
                    lastMs = (t1 - t0) / 1e6f
                    if (lastDone > 0) rate = 0.85f * rate + 0.15f * (1e9f / (t1 - lastDone).coerceAtLeast(1))
                    lastDone = t1
                }
            } catch (e: Throwable) {
                Log.e(TAG, "detection failed", e)
            } finally {
                batch.recycle()
                busy.set(false)
            }
        }
        return true
    }

    fun release() {
        handler.post {
            runCatching { scrfd?.close() }
            scrfd = null
            hint?.close(); hint = null
        }
        thread.quitSafely()
    }

    companion object {
        val YUNET = com.veil.cam.BuildConfig.FACE_MODEL == "yunet"
        const val YUNET_MODEL = "face_yunet_2023mar_dyn.onnx"
        private const val TAG = "VeilFaces"
    }
}
