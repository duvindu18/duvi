package com.veil.cam.gl

import android.content.ContentValues
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.RectF
import android.graphics.SurfaceTexture
import android.net.Uri
import android.opengl.EGLSurface
import android.opengl.GLES11Ext
import android.opengl.GLES30
import android.opengl.GLUtils
import android.os.Environment
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.provider.MediaStore
import android.util.Log
import android.util.Size
import android.view.Surface
import com.veil.cam.BlurStyle
import com.veil.cam.Settings
import com.veil.cam.camera.WhiteBalance
import com.veil.cam.core.Coverage
import com.veil.cam.core.DetectPacer
import com.veil.cam.core.Geom
import com.veil.cam.core.Lut3D
import com.veil.cam.core.PassImage
import com.veil.cam.core.PassPlanner
import com.veil.cam.core.PassSpec
import com.veil.cam.core.PowerBudget
import com.veil.cam.core.PowerMode
import com.veil.cam.face.DetectBatch
import com.veil.cam.face.FaceEngine
import com.veil.cam.power.WorkHint
import com.veil.cam.record.AudioCapture
import com.veil.cam.record.Recorder
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.text.SimpleDateFormat
import java.util.ArrayDeque
import java.util.Date
import java.util.Locale
import java.util.concurrent.ConcurrentLinkedQueue
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * GL thread: camera frames -> ring buffer -> detector passes -> anonymized
 * composite -> preview and encoder.
 *
 * Each frame is kept in a small ring until the face detector has results for its
 * timestamp (or a later one). Only then is it composited into the recording, with
 * the faces interpolated to that exact moment, so a face entering the shot is
 * never recorded unblurred. The preview shows the same frames by default; "low
 * latency preview" shows the newest frame with faces predicted from their motion.
 */
class Renderer(
    private val context: Context, private val engine: FaceEngine, private val segmenter: com.veil.cam.face.PersonSegmenter,
    private val depthNet: com.veil.cam.face.DepthEstimator,
) {
    interface Listener {
        fun onCameraSurface(surface: Surface, size: Size)
        fun onDisplayTransform(imgW: Int, imgH: Int, content: RectF, viewToImg: FloatArray)
        fun onFaces(faces: List<Geom>)
        fun onHistogram(luma: IntArray, r: IntArray, g: IntArray, b: IntArray)
        fun onStats(cameraFps: Float, detectFps: Float, detectMs: Float, delayFrames: Int)
        fun onRecording(active: Boolean, elapsedNs: Long, uri: Uri?, error: String?)
        /** A take was saved: its spec and the per-second camera metadata written into it. */
        fun onTakeSaved(spec: com.veil.cam.record.TakeSpec, meta: List<String>, startUs: Long) {}
        fun onPhoto(uri: Uri?, error: String?)
        /** A merged photo is being saved ([frames] frames went into it). */
        fun onBurstMerged(frames: Int) {}
        /** Cinematic focus is following a tapped subject, now at image point ([x], [y]). */
        fun onFocusTrack(x: Float, y: Float) {}
        fun onDetectorReady(ready: Boolean)
        /** The first frame of a (re)started camera arrived. */
        fun onFirstFrame()
    }

    private class Slot(val color: GlUtil.Target, val blur: GlUtil.Target) {
        var ts = 0L
        var blurReady = false // the 1/4-res blur is only built when a composite needs it
        var depth = 0f // background blur strength for this frame (eased, see easeDepth)
        var focus = 0.5f; var focusHalf = 0f; var far = 0f // focus plane for this frame (eased)
    }

    private class Readback(
        val ts: Long, val specs: List<PassSpec>, val pbos: IntArray, val fence: Long, val faces: Boolean, val people: Boolean,
        val depth: Boolean = false, val gesture: Boolean = false,
    )

    var listener: Listener? = null
    private val thread = HandlerThread("GL").apply { start(); priority = Thread.MAX_PRIORITY }
    private val handler = Handler(thread.looper)
    private lateinit var egl: EglCore
    private var progCopy = 0; private var progDown = 0; private var progBlur = 0; private var progPass = 0; private var progComp = 0
    private var progFilm = 0
    private val stages = HashMap<Long, GlUtil.Target>() // output size -> anonymized intermediate (mipmapped)
    private var peopleTex = 0
    private var depthNow = 0f
    private var depthTs = 0L
    // Depth map (monocular depth) and the eased focus plane.
    private var depthTex = 0
    private var depthMap: com.veil.cam.face.DepthMap? = null
    private var focusNow = Float.NaN; private var halfNow = 0f; private var farNow = 0f
    private var lastDepthCapture = Long.MIN_VALUE / 4
    @Volatile private var focusPoint: FloatArray? = null // image px, or null for automatic
    @Volatile private var manualFocus = Float.NaN // A-B focus pull: the depth to hold in focus
    /** Palm gesture recogniser (fed from the detector's base canvas), or null. */
    @Volatile var gesture: com.veil.cam.face.GestureWatcher? = null
    private var lastGestureCapture = 0L
    private var progLuma = 0; private var progMerge = 0; private var progMean = 0; private var progTone = 0
    private var burst: Burst? = null
    private val depthFx = DepthFx({ p, n -> loc(p, n) }, { u, t -> bindTex(u, t) })
    private var peopleMask: com.veil.cam.face.PersonMask? = null
    private val startNs = System.nanoTime()
    // Pause: frames are not encoded while paused; later frames are shifted to close the gap.
    private var recPaused = false
    private var pauseStartTs = -1L
    private var pauseOffsetNs = 0L
    private val u = HashMap<String, Int>()
    private var vao = 0

    private var oesTex = 0
    private var st: SurfaceTexture? = null
    private var camSurface: Surface? = null
    private var capSize = Size(1920, 1080)
    private var geometryKnown = false
    private var imgW = 0; private var imgH = 0
    private var pre = floatArrayOf(1f, 0f, 0f, 0f, 1f, 0f, 0f, 0f, 1f)
    private val stM = FloatArray(16)
    private var sensorOrientation = 90
    private var front = false
    // The screen is laid out in portrait; the recording and the face detector follow
    // how the phone is held.
    private var previewRotation = 0
    private var outputRotation = 0
    private var faceRotation = 0
    private var wantedOutputRotation = 0

    private var slots: List<Slot> = emptyList()
    private val pending = ArrayDeque<Slot>()
    // Emitted frames not yet on the preview: one is presented per camera frame, so the
    // preview stays smooth when one detection releases several frames at once.
    private val toShow = ArrayDeque<Slot>()
    private var drawnSlot: Slot? = null
    private var previewDirty = true
    private var shown: Slot? = null
    private var newest: Slot? = null
    private var blurTmpA: GlUtil.Target? = null
    private var blurTmpB: GlUtil.Target? = null
    private val passTargets = HashMap<Long, GlUtil.Target>()
    private val pbos = HashMap<Long, IntArray>() // (pass index, byte size) -> PBO id
    private var readback: Readback? = null
    private val bufferPool = ConcurrentLinkedQueue<ByteArray>()

    private var preview: EGLSurface? = null
    private var previewW = 0; private var previewH = 0
    private var viewW = 0; private var viewH = 0 // preview view size (the buffer may be smaller)

    // Power: detection pacing and scheduler hints.
    private var budget = PowerBudget.of(PowerMode.BALANCED, 0, recording = false)
    private var frameNs = 33_333_333L
    private var lastFrameTs = 0L
    private var lastFaceCapture = Long.MIN_VALUE / 4
    private var lastPeopleCapture = Long.MIN_VALUE / 4
    private var lastHistCapture = 0L
    private var glHint: WorkHint? = null
    private var hintFrameNs = 0L
    private var encoderSurface: EGLSurface? = null
    // The encoder: armed (pre-record ring) or taking. Frames go to it whenever it exists.
    private var recorder: Recorder? = null
    private var taking = false
    private var armAllowed = true
    private var currentTake: com.veil.cam.record.TakeSpec? = null
    private var lastEmittedTs = 0L
    private var audio: AudioCapture? = null

    private var settings = Settings()
    private var lutTex = 0
    private var lutSize = 0
    private var lutLoaded: Lut3D? = null
    private var maskTex = 0
    private var maskLoadedPath = ""
    private var hasResult = false
    private var sceneStartTs = -1L
    private var photoRequested = false

    private var frames = 0
    private var fpsWindowStart = 0L
    private var camFps = 0f
    private var lastFacesSent = 0L
    private var lastHist = 0L

    init {
        handler.post {
            egl = EglCore()
            progCopy = GlUtil.program(Shaders.VS, Shaders.COPY_OES)
            progDown = GlUtil.program(Shaders.VS, Shaders.DOWN)
            progBlur = GlUtil.program(Shaders.VS, Shaders.BLUR)
            progPass = GlUtil.program(Shaders.VS, Shaders.PASS)
            progComp = GlUtil.program(Shaders.VS, Shaders.COMPOSITE)
            progFilm = GlUtil.program(Shaders.VS, Shaders.FILM)
            progLuma = GlUtil.program(Shaders.VS, Shaders.BURST_LUMA)
            progMerge = GlUtil.program(Shaders.VS, Shaders.BURST_MERGE)
            progMean = GlUtil.program(Shaders.VS, Shaders.BURST_MEAN)
            progTone = GlUtil.program(Shaders.VS, Shaders.BURST_TONE)
            peopleTex = maskTexture(1, 1, byteArrayOf(0, 0))
            depthFx.init()
            val v = IntArray(1)
            GLES30.glGenVertexArrays(1, v, 0)
            vao = v[0]
            GLES30.glBindVertexArray(vao)
            // Neutral 2^3 LUT and 1x1 mask so the samplers are always valid.
            uploadLut(Lut3D.build("Identity", 2) { r, g, b -> floatArrayOf(r, g, b) })
            lutLoaded = null
            maskTex = texture2D(Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888))
            glHint = WorkHint(context, android.os.Process.myTid(), frameNs / 2)
        }
    }

    // ---- public API (any thread) ---------------------------------------------------
    /** Blocks until the GL thread has switched surfaces, so a destroyed window is never drawn to. */
    fun setPreview(surface: Surface?, w: Int, h: Int, viewW: Int = w, viewH: Int = h) {
        val done = java.util.concurrent.CountDownLatch(1)
        handler.post {
            try {
                preview?.let { egl.destroySurface(it) }
                preview = null
                drawnSlot = null
                if (surface != null && surface.isValid) {
                    preview = runCatching { egl.windowSurface(surface) }.getOrNull()
                    previewW = w; previewH = h
                    this.viewW = if (viewW > 0) viewW else w; this.viewH = if (viewH > 0) viewH else h
                    publishTransform()
                }
            } finally { done.countDown() }
        }
        done.await(2, java.util.concurrent.TimeUnit.SECONDS)
    }

    /** (Re)create the camera input for [size]; the listener receives the Surface to give the camera. */
    fun configureCamera(size: Size, sensorOrientation: Int, front: Boolean) = handler.post {
        releaseCameraInput()
        capSize = size
        this.sensorOrientation = sensorOrientation
        this.front = front
        geometryKnown = false
        hasResult = false
        sceneStartTs = -1L
        lastFrameTs = 0L
        lastFaceCapture = Long.MIN_VALUE / 4; lastPeopleCapture = Long.MIN_VALUE / 4
        engine.reset()
        oesTex = GlUtil.oesTexture()
        val t = SurfaceTexture(oesTex)
        t.setDefaultBufferSize(size.width, size.height)
        t.setOnFrameAvailableListener({ onFrame() }, handler)
        st = t
        val s = Surface(t)
        camSurface = s
        listener?.onCameraSurface(s, size)
    }

    /**
     * [preview]: screen rotation; [output]: orientation of recordings and photos (locked
     * while recording); [faces]: how the phone is held, so faces are upright for the detector.
     */
    fun setRotations(preview: Int, output: Int, faces: Int) = handler.post {
        previewRotation = preview
        wantedOutputRotation = output
        if (!taking && output != outputRotation) {
            outputRotation = output
            if (recorder != null) { disarm(); arm() } // the armed encoder has the old frame size
        }
        faceRotation = faces
        previewDirty = true
        publishTransform()
    }

    fun update(s: Settings) = handler.post {
        val maskChanged = s.maskPath != settings.maskPath
        val old = settings
        settings = s
        val encoderChanged = s.prerollS != old.prerollS || s.width != old.width || s.height != old.height || s.fps != old.fps ||
            s.bitrateLevel != old.bitrateLevel || s.hevc != old.hevc || s.audio != old.audio
        if (encoderChanged && !taking) { disarm(); arm() }
        previewDirty = true
        if (maskChanged) loadMask(s.maskPath)
        publishTransform()
    }

    /** Power budget (mode, temperature, recording); see [PowerBudget]. */
    fun setBudget(b: PowerBudget) = handler.post {
        budget = b
        previewDirty = true
        glHint?.preferEfficiency(b.preferEfficiency)
        engine.setBudget(b, frameNs)
    }

    fun setLut(lut: Lut3D?) = handler.post {
        previewDirty = true
        if (lut == null) { lutLoaded = null; return@post }
        uploadLut(lut)
        lutLoaded = lut
    }

    fun setAudio(a: AudioCapture?) = handler.post {
        val changed = a !== audio
        audio = a
        if (changed && !taking && recorder != null) { disarm(); arm() } // the armed encoder needs the new microphone
    }

    /** Create and start the encoder (armed when pre-record is on). GL thread. */
    private fun createEncoder(prerollUs: Long): Recorder {
        val (w, h) = outputSize()
        val r = Recorder(context, w, h, settings.fps, settings.bitrate(), settings.hevc, if (settings.audio) audio else null, prerollUs)
        encoderSurface = egl.windowSurface(r.inputSurface)
        r.start()
        recPaused = false; pauseStartTs = -1L; pauseOffsetNs = 0L
        return r
    }

    /** Pre-record: keep the encoder running into its RAM ring while not recording. */
    private fun arm() {
        if (recorder != null || !geometryKnown || !armAllowed || settings.prerollS <= 0) return
        try {
            recorder = createEncoder(settings.prerollS * 1_000_000L)
        } catch (e: Exception) {
            Log.e(TAG, "pre-record", e)
            encoderSurface?.let { egl.destroySurface(it) }; encoderSurface = null
        }
    }

    private fun disarm() {
        if (taking) return
        val r = recorder ?: return
        recorder = null
        encoderSurface?.let { egl.destroySurface(it) }; encoderSurface = null
        Thread { runCatching { r.stop() } }.start()
    }

    /** Allow or stop pre-recording (off while the app is in the background). */
    fun setArmAllowed(allowed: Boolean) = handler.post { armAllowed = allowed; if (allowed) arm() else disarm() }

    /** Camera settings for the take's metadata track (call about once a second while recording). */
    fun addTakeMetadata(json: String) = handler.post {
        val r = recorder ?: return@post
        if (taking) r.addMetadata(json, (lastEmittedTs - pauseOffsetNs) / 1000)
    }

    fun startRecording(take: () -> com.veil.cam.record.TakeSpec) = handler.post {
        if (taking || !geometryKnown) return@post
        if (settings.blurOn && !hasResult) {
            listener?.onRecording(false, 0, null, "Face detection is still starting. Try again in a moment.")
            return@post
        }
        try {
            val r = recorder ?: createEncoder(0).also { recorder = it }
            val spec = take()
            r.beginTake(spec)
            currentTake = spec
            taking = true
            listener?.onRecording(true, 0, null, null)
        } catch (e: Exception) {
            Log.e(TAG, "record start", e)
            if (recorder != null && settings.prerollS <= 0) { encoderSurface?.let { egl.destroySurface(it) }; encoderSurface = null; recorder = null }
            listener?.onRecording(false, 0, null, e.message ?: "Cannot start recording")
        }
    }

    fun stopRecording() = handler.post { finishRecording() }

    fun takePhoto(merge: BurstRequest? = null) = handler.post {
        if (merge != null && merge.frames > 1 && burst == null && geometryKnown) startBurst(merge) else photoRequested = true
    }

    /** Pause or resume the running recording (one file, the pause is cut out). */
    fun setRecordingPaused(paused: Boolean) = handler.post {
        val rec = recorder ?: return@post
        if (!taking) return@post
        if (paused == recPaused) return@post
        if (paused) {
            pauseStartTs = lastEmittedTs
        } else if (pauseStartTs >= 0) {
            pauseOffsetNs += (newest?.ts ?: lastEmittedTs) - pauseStartTs
            pauseStartTs = -1L
        }
        recPaused = paused
        rec.setPaused(paused, pauseOffsetNs)
    }

    fun release() {
        handler.post {
            finishRecording()
            armAllowed = false; disarm()
            releaseCameraInput()
            preview?.let { egl.destroySurface(it) }
            preview = null
            glHint?.close(); glHint = null
            depthFx.release()
            egl.release()
        }
        thread.quitSafely()
    }

    // ---- camera input ------------------------------------------------------------------
    private fun releaseCameraInput() {
        disarm()
        readback?.let { GLES30.glDeleteSync(it.fence) }
        readback = null
        burst?.let { b -> burst = null; b.ping.release(); b.pong.release(); b.luma.release(); b.ref.color.release(); b.ref.blur.release(); listener?.onPhoto(null, "The camera stopped during the merge") }
        pending.clear(); toShow.clear(); shown = null; newest = null; drawnSlot = null
        slots.forEach { it.color.release(); it.blur.release() }
        slots = emptyList()
        blurTmpA?.release(); blurTmpB?.release(); blurTmpA = null; blurTmpB = null
        passTargets.values.forEach { it.release() }; passTargets.clear()
        pbos.values.forEach { GLES30.glDeleteBuffers(it.size, it, 0) }; pbos.clear()
        camSurface?.release(); camSurface = null
        st?.release(); st = null
        if (oesTex != 0) GLES30.glDeleteTextures(1, intArrayOf(oesTex), 0)
        oesTex = 0
    }

    /** Work out the upright image size from the producer transform on the first frame. */
    private fun setupGeometry() {
        val swapped = abs(stM[0]) < abs(stM[1])
        val sensorQuarter = sensorOrientation % 180 == 90
        var rot = 0
        if (!swapped && sensorQuarter) rot = if (front) (360 - sensorOrientation) % 360 else sensorOrientation
        pre = rotateUnit(rot)
        val quarter = (swapped) xor (rot % 180 == 90)
        imgW = if (quarter) capSize.height else capSize.width
        imgH = if (quarter) capSize.width else capSize.height
        // Room for frames waiting on their detection plus the preview queue, sized for
        // 60 fps with a slow (rotated-pass) detection; the phone has memory to spare
        // (~110 MB at 1080p, ~350 MB at 4K) and a deeper ring lets detection run less often.
        val n = if (imgW.toLong() * imgH > 3_000_000L) 10 else 12
        slots = List(n) { Slot(GlUtil.Target(imgW, imgH), GlUtil.Target(max(1, imgW / 4), max(1, imgH / 4), mipmaps = true)) }
        blurTmpA = GlUtil.Target(max(1, imgW / 4), max(1, imgH / 4))
        blurTmpB = GlUtil.Target(max(1, imgW / 4), max(1, imgH / 4))
        geometryKnown = true
        depthFx.configure(imgW, imgH)
        depthFx.invalidate()
        arm()
        listener?.onFirstFrame()
        publishTransform()
        Log.i(TAG, "frames ${capSize.width}x${capSize.height} -> upright ${imgW}x$imgH (st swapped=$swapped, pre=$rot)")
    }

    /** Column-major mat3 rotating texture coordinates by [deg] about the centre. */
    private fun rotateUnit(deg: Int): FloatArray {
        val r = Math.toRadians(deg.toDouble())
        val c = cos(r).toFloat(); val s = sin(r).toFloat()
        // t' = R (t - 0.5) + 0.5
        return floatArrayOf(c, s, 0f, -s, c, 0f, 0.5f - 0.5f * c + 0.5f * s, 0.5f - 0.5f * s - 0.5f * c, 1f)
    }

    // ---- per frame ---------------------------------------------------------------------------
    private fun onFrame() {
        val tex = st ?: return
        val work0 = System.nanoTime()
        try {
            tex.updateTexImage()
        } catch (e: Exception) {
            return
        }
        tex.getTransformMatrix(stM)
        val ts = tex.timestamp
        if (!geometryKnown) setupGeometry()
        if (sceneStartTs < 0) sceneStartTs = ts
        countFps()
        if (lastFrameTs > 0) {
            val d = ts - lastFrameTs
            if (d in 2_000_000L..250_000_000L) frameNs = (frameNs * 7 + d) / 8
        }
        lastFrameTs = ts

        egl.makeOffscreenCurrent()
        GLES30.glBindVertexArray(vao)
        val slot = acquireSlot()
        slot.ts = ts
        copyFrame(slot)
        slot.blurReady = false
        slot.depth = easeDepth(ts)
        depthNet.latest?.let { m -> if (m !== depthMap) { uploadDepth(m); depthMap = m; followTap(m) } }
        easeFocus(slot)
        burst?.let { burstStep(it, slot) }
        pending.addLast(slot)
        newest = slot

        pollReadback()
        maybeCaptureDetection(slot)
        segmenter.latest?.let { m -> if (m !== peopleMask) { uploadMask(m); peopleMask = m } }
        if (!hasResult && engine.timeline.latestTimestamp() >= sceneStartTs) {
            hasResult = true
            listener?.onDetectorReady(true)
        }
        emitReady(force = false)
        drawPreview()
        if (photoRequested) { photoRequested = false; savePhoto() }
        publishStats()
        syncHints()
        glHint?.report(System.nanoTime() - work0)
    }

    /** Keep the scheduler deadlines in step with the real frame rate. */
    private fun syncHints() {
        if (abs(frameNs - hintFrameNs) * 10 < hintFrameNs) return
        hintFrameNs = frameNs
        glHint?.target(frameNs / 2)
        engine.setBudget(budget, frameNs)
    }

    private fun maxPending() = max(1, slots.size - 3)

    private fun acquireSlot(): Slot {
        while (true) {
            val free = slots.firstOrNull { it !in pending && it !== shown && it !in toShow }
            if (free != null) return free
            // Preview behind: skip a frame on the monitor (never in the recording).
            if (toShow.isNotEmpty()) { toShow.pollFirst(); continue }
            // Ring full: the detector is behind. Emit the oldest frame with the best faces known.
            emitOne()
        }
    }

    private fun copyFrame(slot: Slot) {
        slot.color.bind()
        GLES30.glUseProgram(progCopy)
        GLES30.glActiveTexture(GLES30.GL_TEXTURE0)
        GLES30.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, oesTex)
        GLES30.glUniform1i(loc(progCopy, "uOes"), 0)
        GLES30.glUniformMatrix4fv(loc(progCopy, "uSt"), 1, false, stM, 0)
        GLES30.glUniformMatrix3fv(loc(progCopy, "uPre"), 1, false, pre, 0)
        GLES30.glUniform2f(loc(progCopy, "uSize"), imgW.toFloat(), imgH.toFloat())
        GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, 3)
    }

    private fun ensureBlur(slot: Slot) {
        if (slot.blurReady) return
        blurChain(slot)
        slot.blurReady = true
    }

    private fun blurChain(slot: Slot) {
        val a = blurTmpA ?: return
        val b = blurTmpB ?: return
        // Downsample 4x.
        a.bind()
        GLES30.glUseProgram(progDown)
        bindTex(0, slot.color.tex)
        GLES30.glUniform1i(loc(progDown, "uSrc"), 0)
        GLES30.glUniform2f(loc(progDown, "uSrcTexel"), 1f / imgW, 1f / imgH)
        GLES30.glUniform2f(loc(progDown, "uDstSize"), a.width.toFloat(), a.height.toFloat())
        GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, 3)
        // Separable Gaussian, twice, into the slot's mipmapped blur texture.
        blurPass(a, b, 1f / a.width, 0f)
        blurPass(b, a, 0f, 1f / a.height)
        blurPass(a, b, 1f / a.width, 0f)
        blurPass(b, slot.blur, 0f, 1f / a.height)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, slot.blur.tex)
        GLES30.glGenerateMipmap(GLES30.GL_TEXTURE_2D)
    }

    private fun blurPass(src: GlUtil.Target, dst: GlUtil.Target, sx: Float, sy: Float) {
        dst.bind()
        GLES30.glUseProgram(progBlur)
        bindTex(0, src.tex)
        GLES30.glUniform1i(loc(progBlur, "uSrc"), 0)
        GLES30.glUniform2f(loc(progBlur, "uStep"), sx, sy)
        GLES30.glUniform2f(loc(progBlur, "uDstSize"), dst.width.toFloat(), dst.height.toFloat())
        GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, 3)
    }

    // ---- detection input ------------------------------------------------------------------------
    private fun baseAngle(): Double = faceRotation.toDouble()

    /**
     * Detection is paced by the power budget: calm or empty scenes are sampled less
     * often (frames in between are interpolated exactly), fast or lost faces at full
     * rate, and never so sparsely that a waiting frame could overflow the ring.
     */
    private fun maybeCaptureDetection(slot: Slot) {
        if (readback != null) return
        val s = settings
        val ts = slot.ts
        var faceEvery = if (!hasResult) 0L else DetectPacer.capped(
            DetectPacer.intervalNs(budget, engine.lastFaces), frameNs, maxPending(), (engine.lastMs * 1e6f).toLong() + frameNs / 2,
        )
        // One detection releases the frames since the previous one; the exact preview
        // presents them one per frame, so never release more than its queue holds.
        if (!s.lowLatencyPreview) faceEvery = min(faceEvery, MAX_STRIDE * frameNs)
        val wantFaces = s.blurOn && !engine.isBusy && engine.ready && DetectPacer.due(ts - lastFaceCapture, faceEvery, frameNs)
        val wantPeople = s.depth > 0f && !segmenter.isBusy && DetectPacer.due(ts - lastPeopleCapture, budget.segmentNs, frameNs)
        val wantDepth = s.depth > 0f && depthNet.usable && !depthNet.isBusy && DetectPacer.due(ts - lastDepthCapture, budget.depthNs, frameNs)
        val now = SystemClock.uptimeMillis()
        val wantHist = (s.histogram || s.shutterPriority || s.sceneAuto) && now - lastHistCapture >= 150
        val g = gesture
        val wantGesture = s.palmGesture && g != null && g.usable && !g.isBusy && now - lastGestureCapture >= GESTURE_EVERY_MS
        if (wantGesture) lastGestureCapture = now
        if (!(wantFaces || wantPeople || wantDepth || wantHist || wantGesture)) return
        if (wantFaces) lastFaceCapture = ts
        if (wantPeople) lastPeopleCapture = ts
        if (wantDepth) lastDepthCapture = ts
        lastHistCapture = now
        val baseSide = if (settings.accurateModel) 640 else 480
        val base = PassPlanner.base(imgW, imgH, baseAngle(), baseSide)
        val scale = PassPlanner.scaleOf(base)
        val rotated = if (wantFaces) engine.plan.take(4).map { PassPlanner.rotated(imgW, imgH, baseAngle(), it, scale) } else emptyList()
        val specs = listOf(base) + rotated
        val ids = IntArray(specs.size)
        for ((i, spec) in specs.withIndex()) {
            val target = passTargets.getOrPut((spec.width.toLong() shl 32) or spec.height.toLong()) { GlUtil.Target(spec.width, spec.height) }
            target.bind()
            GLES30.glUseProgram(progPass)
            bindTex(0, slot.color.tex)
            GLES30.glUniform1i(loc(progPass, "uSrc"), 0)
            GLES30.glUniformMatrix3fv(loc(progPass, "uCanvasToImg"), 1, false, mat3(spec.toCanvas.inverse().toFloatArray()), 0)
            GLES30.glUniform2f(loc(progPass, "uImgSize"), imgW.toFloat(), imgH.toFloat())
            GLES30.glUniform1f(loc(progPass, "uCanvasH"), spec.height.toFloat())
            GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, 3)
            val bytes = spec.width * spec.height * 4
            val pbo = takePbo(i, bytes)
            ids[i] = pbo
            GLES30.glBindBuffer(GLES30.GL_PIXEL_PACK_BUFFER, pbo)
            GLES30.glReadPixels(0, 0, spec.width, spec.height, GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE, 0)
            GLES30.glBindBuffer(GLES30.GL_PIXEL_PACK_BUFFER, 0)
        }
        val fence = GLES30.glFenceSync(GLES30.GL_SYNC_GPU_COMMANDS_COMPLETE, 0)
        GLES30.glFlush()
        readback = Readback(slot.ts, specs, ids, fence, wantFaces, wantPeople, wantDepth, wantGesture)
    }

    /** One pixel-pack buffer per pass index and size, so passes of one batch never share. */
    private fun takePbo(index: Int, bytes: Int): Int {
        val pool = pbos.getOrPut((index.toLong() shl 32) or bytes.toLong()) {
            val ids = IntArray(1)
            GLES30.glGenBuffers(1, ids, 0)
            GLES30.glBindBuffer(GLES30.GL_PIXEL_PACK_BUFFER, ids[0])
            GLES30.glBufferData(GLES30.GL_PIXEL_PACK_BUFFER, bytes, null, GLES30.GL_STREAM_READ)
            GLES30.glBindBuffer(GLES30.GL_PIXEL_PACK_BUFFER, 0)
            ids
        }
        return pool[0]
    }

    private fun pollReadback() {
        val rb = readback ?: return
        val status = GLES30.glClientWaitSync(rb.fence, 0, 0)
        if (status != GLES30.GL_ALREADY_SIGNALED && status != GLES30.GL_CONDITION_SATISFIED) return
        GLES30.glDeleteSync(rb.fence)
        readback = null
        val passes = ArrayList<PassImage>(rb.specs.size)
        val owned = ArrayList<ByteArray>()
        for ((i, spec) in rb.specs.withIndex()) {
            val n = spec.width * spec.height * 4
            GLES30.glBindBuffer(GLES30.GL_PIXEL_PACK_BUFFER, rb.pbos[i])
            val mapped = GLES30.glMapBufferRange(GLES30.GL_PIXEL_PACK_BUFFER, 0, n, GLES30.GL_MAP_READ_BIT) as? ByteBuffer
            val arr = takeArray(n)
            if (mapped != null) {
                mapped.order(ByteOrder.nativeOrder()).get(arr, 0, n)
                GLES30.glUnmapBuffer(GLES30.GL_PIXEL_PACK_BUFFER)
            }
            GLES30.glBindBuffer(GLES30.GL_PIXEL_PACK_BUFFER, 0)
            owned.add(arr)
            passes.add(PassImage(spec, arr, 4, bottomUp = true))
        }
        if (passes.isNotEmpty()) maybeHistogram(passes[0])
        if (rb.gesture && passes.isNotEmpty()) gesture?.submit(passes[0].pixels.copyOf(), passes[0].spec, rb.ts)
        if (rb.people && settings.depth > 0f && passes.isNotEmpty()) segmenter.submit(passes[0].pixels.copyOf(), passes[0].spec, rb.ts)
        if (rb.depth && settings.depth > 0f && passes.isNotEmpty()) {
            val spec = passes[0].spec
            // A tapped focus point, in canvas uv.
            val tap = focusPoint?.let { fp ->
                val m = spec.toCanvas
                floatArrayOf(((m.a * fp[0] + m.b * fp[1] + m.c) / spec.width).toFloat(), ((m.d * fp[0] + m.e * fp[1] + m.f) / spec.height).toFloat())
            }?.takeIf { it[0] in 0f..1f && it[1] in 0f..1f }
            depthNet.submit(passes[0].pixels.copyOf(), spec, rb.ts, segmenter.latest, tap)
        }
        val ok = rb.faces && settings.blurOn && engine.submit(DetectBatch(rb.ts, imgW, imgH, passes) { owned.forEach { recycleArray(it) } })
        if (!ok) owned.forEach { recycleArray(it) }
    }

    private fun takeArray(n: Int): ByteArray {
        val it = bufferPool.iterator()
        while (it.hasNext()) {
            val a = it.next()
            if (a.size == n) { it.remove(); return a }
        }
        return ByteArray(n)
    }

    private fun recycleArray(a: ByteArray) {
        if (bufferPool.size < 12) bufferPool.add(a)
    }

    private fun maybeHistogram(p: PassImage) {
        val now = SystemClock.uptimeMillis()
        if (!(settings.histogram || settings.shutterPriority || settings.sceneAuto) || now - lastHist < 120) return
        lastHist = now
        val l = IntArray(64); val r = IntArray(64); val g = IntArray(64); val b = IntArray(64)
        val px = p.pixels
        var i = 0
        while (i + 2 < px.size) {
            val rr = px[i].toInt() and 0xFF; val gg = px[i + 1].toInt() and 0xFF; val bb = px[i + 2].toInt() and 0xFF
            if (rr or gg or bb != 0) { // skip the black padding
                r[rr shr 2]++; g[gg shr 2]++; b[bb shr 2]++
                l[((rr * 54 + gg * 183 + bb * 19) shr 8) shr 2]++
            }
            i += 4 * 3 // every third pixel is plenty
        }
        listener?.onHistogram(l, r, g, b)
    }

    // ---- emission -------------------------------------------------------------------------------
    /** Frames whose faces are known go to the recording (and the exact preview). */
    private fun emitReady(force: Boolean) {
        val latest = engine.timeline.latestTimestamp()
        val limit = maxPending()
        while (pending.isNotEmpty()) {
            val s = pending.peekFirst()!!
            val covered = !settings.blurOn || latest >= s.ts
            if (covered || force || pending.size > limit) emitOne() else break
        }
    }

    private fun emitOne() {
        val s = pending.pollFirst() ?: return
        lastEmittedTs = s.ts
        val enc = encoderSurface
        val rec = recorder
        if (enc != null && rec != null) {
            if (!recPaused) {
                egl.makeCurrent(enc)
                GLES30.glBindVertexArray(vao)
                render(s, rec.width, rec.height, outputRotation, fill = true, monitor = false, lut = settings.bakeLut,
                    mirror = front && !settings.mirrorFront, film = settings.bakeFilm) {
                    GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0)
                    GLES30.glViewport(0, 0, rec.width, rec.height)
                }
                egl.setPresentationTime(enc, s.ts - pauseOffsetNs)
                egl.swap(enc)
                egl.makeOffscreenCurrent()
            }
            val err = rec.failed
            if (err != null && !finishing) handler.post { finishRecording(err) }
        }
        if (!settings.lowLatencyPreview) toShow.addLast(s)
    }

    private fun drawPreview() {
        val p = preview ?: return
        val slot = if (settings.lowLatencyPreview) {
            toShow.clear()
            newest
        } else {
            while (toShow.size > MAX_PREVIEW_BACKLOG) toShow.pollFirst()
            toShow.pollFirst()?.let { shown = it }
            shown
        } ?: return
        // Nothing new to show (waiting on a detection): leave the screen as it is.
        if (slot !== drawnSlot || previewDirty) {
            egl.makeCurrent(p)
            GLES30.glBindVertexArray(vao)
            val faces = render(slot, previewW, previewH, previewRotation, fill = settings.fullView, monitor = true, lut = settings.lutOnMonitor, mirror = false, film = true, squeeze = squeeze()) {
                GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0)
                GLES30.glViewport(0, 0, previewW, previewH)
            }
            egl.swap(p)
            egl.makeOffscreenCurrent()
            drawnSlot = slot
            previewDirty = false
            if (settings.lowLatencyPreview) shown = slot
            val now = SystemClock.uptimeMillis()
            if ((settings.showBoxes || settings.framingGuide || settings.sceneAuto) && now - lastFacesSent > 66) { lastFacesSent = now; listener?.onFaces(faces) }
        }
        val rec = recorder
        if (rec != null && taking && rec.takeStartUs >= 0) {
            // Clip length so far, pre-recorded seconds included.
            val pausedFor = if (recPaused && pauseStartTs >= 0) lastEmittedTs - pauseStartTs else 0L
            listener?.onRecording(true, (lastEmittedTs - pauseOffsetNs - pausedFor) - rec.takeStartUs * 1000, null, null)
        }
    }

    // ---- composite ------------------------------------------------------------------------------
    private val fa = FloatArray(Shaders.MAX_FACES * 4)
    private val fb = FloatArray(Shaders.MAX_FACES * 4)

    /** Output transform: image px -> output px (column-major 3x3 of the inverse is uploaded). */
    private fun outputAffine(outW: Int, outH: Int, rot: Int, fill: Boolean, mirror: Boolean, squeeze: Double = 1.0): DoubleArray {
        val m = unitAffine(rot, mirror, squeeze)
        val (bw, bh) = extent(m)
        val k = if (fill) max(outW / bw, outH / bh) else min(outW / bw, outH / bh)
        // out = k * M * (p - imgCentre) + outCentre
        val a = k * m[0]; val b = k * m[1]; val d = k * m[2]; val e = k * m[3]
        val cx = imgW / 2.0; val cy = imgH / 2.0
        return doubleArrayOf(a, b, outW / 2.0 - a * cx - b * cy, d, e, outH / 2.0 - d * cx - e * cy)
    }

    /**
     * M = R(rot) * diag(mirror, 1) * S, row-major 2x2. S stretches the image by [squeeze]
     * along the recording's horizontal axis: anamorphic de-squeeze, on the monitor only.
     */
    private fun unitAffine(rot: Int, mirror: Boolean, squeeze: Double): DoubleArray {
        val theta = Math.toRadians(-rot.toDouble()) // clockwise on screen
        val c = cos(theta); val s = sin(theta)
        val mx = if (mirror) -1.0 else 1.0
        var r = doubleArrayOf(c * mx, -s, s * mx, c)
        if (squeeze != 1.0) {
            // The recording's horizontal axis, in image space.
            val t = Math.toRadians(-outputRotation.toDouble())
            val ux = cos(t); val uy = -sin(t); val q = squeeze - 1.0
            val s00 = 1 + q * ux * ux; val s01 = q * ux * uy; val s11 = 1 + q * uy * uy
            r = doubleArrayOf(r[0] * s00 + r[1] * s01, r[0] * s01 + r[1] * s11, r[2] * s00 + r[3] * s01, r[2] * s01 + r[3] * s11)
        }
        return r
    }

    /** Size of the image's bounding box under [m]. */
    private fun extent(m: DoubleArray) = (abs(m[0]) * imgW + abs(m[1]) * imgH) to (abs(m[2]) * imgW + abs(m[3]) * imgH)

    private fun squeeze(): Double = settings.desqueeze.toDouble().coerceIn(1.0, 2.0)

    private fun invert(m: DoubleArray): DoubleArray {
        val det = m[0] * m[4] - m[1] * m[3]
        val ia = m[4] / det; val ib = -m[1] / det; val id = -m[3] / det; val ie = m[0] / det
        return doubleArrayOf(ia, ib, -(ia * m[2] + ib * m[5]), id, ie, -(id * m[2] + ie * m[5]))
    }

    /** Row-major 2x3 (a b c / d e f) -> column-major mat3. */
    private fun mat3(m: FloatArray) = floatArrayOf(m[0], m[3], 0f, m[1], m[4], 0f, m[2], m[5], 1f)

    /**
     * Anonymize + depth + grade into an intermediate at the output size, then the
     * film / monitoring pass into the destination [bindDest] binds.
     */
    private fun render(
        slot: Slot, outW: Int, outH: Int, rot: Int, fill: Boolean, monitor: Boolean, lut: Boolean, mirror: Boolean, film: Boolean,
        squeeze: Double = 1.0, bindDest: () -> Unit,
    ): List<Geom> {
        val s = settings
        val faces = if (s.blurOn) engine.timeline.at(slot.ts).sortedByDescending { it.w * it.h }.take(Shaders.MAX_FACES) else emptyList()
        // The blur pyramid is only needed by blurred faces, the privacy start and depth.
        val needBlur = (slot.depth > 0f && peopleMask != null) || (s.blurOn && !hasResult) || (faces.isNotEmpty() && s.style == BlurStyle.GAUSSIAN)
        if (needBlur) ensureBlur(slot)
        val depth = ensureDepth(slot)
        val monitoring = monitor && (s.zebra || s.falseColor || s.peaking)
        if (!(film && s.filmOn) && !monitoring) {
            // Nothing to add after the grade: draw straight into the destination
            // (saves a full-resolution pass and its memory traffic every frame).
            bindDest()
            composite(slot, outW, outH, rot, fill, lut, mirror, faces, depth, squeeze)
            return faces
        }
        val stage = stages.getOrPut((outW.toLong() shl 32) or outH.toLong()) {
            if (stages.size > 4) { stages.values.forEach { it.release() }; stages.clear() }
            GlUtil.Target(outW, outH, mipmaps = true)
        }
        stage.bind()
        composite(slot, outW, outH, rot, fill, lut, mirror, faces, depth, squeeze)
        val glow = film && (s.bloom > 0f || s.halation > 0f)
        if (glow) {
            GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, stage.tex)
            GLES30.glGenerateMipmap(GLES30.GL_TEXTURE_2D)
        }
        bindDest()
        val p = progFilm
        GLES30.glUseProgram(p)
        bindTex(0, stage.tex); GLES30.glUniform1i(loc(p, "uStage"), 0)
        GLES30.glUniform2f(loc(p, "uSize"), outW.toFloat(), outH.toFloat())
        GLES30.glUniform1f(loc(p, "uTime"), ((slot.ts / 1_000_000L) % 3_600_000L) / 1000f)
        fun f(v: Float) = if (film) v else 0f
        GLES30.glUniform1f(loc(p, "uGrain"), f(s.grain))
        // Grain size in output pixels: scale with resolution so the look matches across formats.
        GLES30.glUniform1f(loc(p, "uGrainSize"), (0.6f + 2.4f * s.grainSize) * max(1f, min(outW, outH) / 1080f))
        GLES30.glUniform1f(loc(p, "uHalation"), f(s.halation))
        GLES30.glUniform1f(loc(p, "uBloom"), f(s.bloom))
        GLES30.glUniform1f(loc(p, "uAberration"), f(s.aberration))
        GLES30.glUniform1f(loc(p, "uLeak"), f(s.leaks))
        GLES30.glUniform1f(loc(p, "uBurn"), f(s.burn))
        GLES30.glUniform1f(loc(p, "uVignette"), f(s.vignette))
        GLES30.glUniform1i(loc(p, "uZebra"), if (monitor && s.zebra) 1 else 0)
        GLES30.glUniform1f(loc(p, "uZebraLevel"), s.zebraLevel)
        GLES30.glUniform1i(loc(p, "uFalse"), if (monitor && s.falseColor) 1 else 0)
        GLES30.glUniform1i(loc(p, "uPeak"), if (monitor && s.peaking) 1 else 0)
        val pc = when (s.peakColor) { 1 -> floatArrayOf(1f, 0.2f, 0.2f); 2 -> floatArrayOf(1f, 1f, 1f); 3 -> floatArrayOf(0.3f, 0.6f, 1f); else -> floatArrayOf(0.894f, 0.945f, 0.478f) }
        GLES30.glUniform3f(loc(p, "uPeakColor"), pc[0], pc[1], pc[2])
        GLES30.glUniform1f(loc(p, "uPeakThresh"), 0.45f - 0.38f * s.peakSensitivity.coerceIn(0f, 1f))
        GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, 3)
        return faces
    }

    /** image px -> canvas px -> mask uv (mask rows are top-down, uploaded as-is), column-major mat3. */
    private fun peopleMatrix(pm: com.veil.cam.face.PersonMask): FloatArray {
        val m = pm.spec.toCanvas
        val sx = 1.0 / pm.spec.width; val sy = 1.0 / pm.spec.height
        return mat3(floatArrayOf((m.a * sx).toFloat(), (m.b * sx).toFloat(), (m.c * sx).toFloat(), (m.d * sy).toFloat(), (m.e * sy).toFloat(), (m.f * sy).toFloat()))
    }

    /**
     * Cinematic depth for this frame: refined edges and lens blur (computed once per
     * frame and mask, shared by the preview and the recording).
     */
    private fun ensureDepth(slot: Slot): DepthFx.Result? {
        val s = settings
        val pm = peopleMask ?: return null
        if (slot.depth <= 0f || !depthFx.available) return null
        val taps = when { budget.tier <= 2 -> 96; budget.tier == 3 -> 64; else -> 48 }
        val quarter = (outputRotation / 90) % 2 == 1
        val params = DepthFx.Params(MAX_BLUR * slot.depth, taps, s.bokehShape, s.bokehHighlights, quarter)
        val dm = depthMap
        // Depth of field shrinks as the aperture opens (strength = 1.4 / f-number).
        val dof = DepthFx.Dof(if (dm != null) depthTex else 0, dm?.let { depthMatrix(it) }, slot.focus, slot.focusHalf, slot.far,
            0.04f + 0.22f * (1f - slot.depth.coerceIn(0f, 1f)), 0.55f)
        val key = "${System.identityHashCode(slot)}:${slot.ts}:${pm.serial}:${dm?.serial}:${slot.depth}:${slot.focus}:$taps:${s.bokehShape}:${s.bokehHighlights}:$quarter"
        return depthFx.ensure(key, slot.color.tex, peopleTex, peopleMatrix(pm), imgW, imgH, slot.blur.tex, params, dof)
    }

    private fun composite(slot: Slot, outW: Int, outH: Int, rot: Int, fill: Boolean, lut: Boolean, mirror: Boolean, faces: List<Geom>, depth: DepthFx.Result? = null, squeeze: Double = 1.0) {
        val s = settings
        val p = progComp
        GLES30.glUseProgram(p)
        bindTex(0, slot.color.tex); GLES30.glUniform1i(loc(p, "uColor"), 0)
        bindTex(1, slot.blur.tex); GLES30.glUniform1i(loc(p, "uBlur"), 1)
        GLES30.glActiveTexture(GLES30.GL_TEXTURE2)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_3D, lutTex); GLES30.glUniform1i(loc(p, "uLut"), 2)
        bindTex(3, maskTex); GLES30.glUniform1i(loc(p, "uMask"), 3)
        val inv = invert(outputAffine(outW, outH, rot, fill, mirror, squeeze))
        GLES30.glUniformMatrix3fv(loc(p, "uOutToImg"), 1, false, mat3(FloatArray(6) { inv[it].toFloat() }), 0)
        GLES30.glUniform2f(loc(p, "uImgSize"), imgW.toFloat(), imgH.toFloat())
        GLES30.glUniform2f(loc(p, "uBlurSize"), slot.blur.width.toFloat(), slot.blur.height.toFloat())
        GLES30.glUniform1f(loc(p, "uOutH"), outH.toFloat())
        val strength = s.intensity.coerceIn(1, 100) / 100f
        val maxLod = (slot.blur.levels - 1).toFloat()
        for ((i, g) in faces.withIndex()) {
            val sh = Coverage.shape(g, s.coverage, s.ellipse)
            val r = Math.toRadians(sh.angle.toDouble())
            fa[i * 4] = sh.cx; fa[i * 4 + 1] = sh.cy; fa[i * 4 + 2] = max(1f, sh.hw); fa[i * 4 + 3] = max(1f, sh.hh)
            fb[i * 4] = cos(r).toFloat(); fb[i * 4 + 1] = sin(r).toFloat()
            fb[i * 4 + 2] = Coverage.featherBand(sh, s.softEdges)
            fb[i * 4 + 3] = when (s.style) {
                BlurStyle.GAUSSIAN -> {
                    // Blur radius grows with the face, as on the desktop (kernel relative to the face).
                    val sigma = 2f * min(sh.hw, sh.hh) * (0.2f + 0.8f * strength) * 0.57f
                    (ln(max(1f, sigma / 8f)) / ln(2f)).coerceIn(0f, maxLod)
                }
                BlurStyle.PIXELATE -> {
                    val blocks = (24f - 20f * strength).roundToInt().coerceAtLeast(2)
                    max(2f, 2f * sh.hw / blocks)
                }
                else -> 0f
            }
        }
        GLES30.glUniform1i(loc(p, "uFaceCount"), faces.size)
        GLES30.glUniform4fv(loc(p, "uFA"), Shaders.MAX_FACES, fa, 0)
        GLES30.glUniform4fv(loc(p, "uFB"), Shaders.MAX_FACES, fb, 0)
        GLES30.glUniform1i(loc(p, "uStyle"), s.style.ordinal)
        GLES30.glUniform1i(loc(p, "uEllipse"), if (s.ellipse) 1 else 0)
        GLES30.glUniform1i(loc(p, "uMaskTex"), if (maskLoadedPath.isNotEmpty()) 1 else 0)
        GLES30.glUniform1i(loc(p, "uFullBlur"), if (s.blurOn && !hasResult) 1 else 0)
        val gains = if (s.autoWb) floatArrayOf(1f, 1f, 1f) else {
            val (_, presetK) = WhiteBalance.preset(s.kelvin, availableAwb)
            WhiteBalance.gains(presetK, s.kelvin, s.tint)
        }
        GLES30.glUniform3f(loc(p, "uGains"), gains[0], gains[1], gains[2])
        val useLut = lut && lutLoaded != null && s.lut != "None"
        GLES30.glUniform1i(loc(p, "uLutOn"), if (useLut) 1 else 0)
        GLES30.glUniform1f(loc(p, "uLutAmount"), s.lutAmount)
        GLES30.glUniform1f(loc(p, "uLutSize"), lutSize.toFloat())
        // Cinematic depth: background defocus outside the person mask.
        val pm = peopleMask
        val d = slot.depth
        val depthOn = d > 0f && pm != null
        GLES30.glActiveTexture(GLES30.GL_TEXTURE4)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, peopleTex); GLES30.glUniform1i(loc(p, "uPeople"), 4)
        // Blur radius in 1/4-res px; the fallback blur uses the matching pyramid level.
        val radiusQ = MAX_BLUR * d * minOf(slot.blur.width, slot.blur.height)
        GLES30.glUniform1f(loc(p, "uDepth"), if (depthOn) (ln(max(1f, radiusQ)) / ln(2f) + 0.3f).coerceIn(0.05f, maxLod) else 0f)
        // Small blurs come from the full-resolution frame (a disc of the same radius), so the
        // blur rises from exactly zero; the 1/4-res lens blur takes over from 1.5 to 3.5 px.
        GLES30.glUniform1f(loc(p, "uDepthMix"), ((radiusQ - 1.5f) / 2f).coerceIn(0f, 1f))
        GLES30.glUniform1f(loc(p, "uFineRadius"), radiusQ * imgW / slot.blur.width.coerceAtLeast(1))
        if (pm != null) GLES30.glUniformMatrix3fv(loc(p, "uImgToPeople"), 1, false, peopleMatrix(pm), 0)
        // Refined edges + lens blur when available (the plain mask otherwise).
        val refined = depthOn && depth != null
        bindTex(5, if (refined) depth!!.coef else peopleTex); GLES30.glUniform1i(loc(p, "uCoef"), 5)
        bindTex(6, if (refined) depth!!.bokeh else peopleTex); GLES30.glUniform1i(loc(p, "uBokeh"), 6)
        GLES30.glUniform1i(loc(p, "uRefined"), if (refined) 1 else 0)
        GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, 3)
    }

    /** AWB presets the active camera supports (set by the activity). */
    @Volatile var availableAwb: IntArray = IntArray(0)

    private fun outputSize(): Pair<Int, Int> {
        val quarter = (outputRotation / 90) % 2 == 1
        val w = if (quarter) imgH else imgW
        val h = if (quarter) imgW else imgH
        return (w and 1.inv()) to (h and 1.inv())
    }

    private fun publishTransform() {
        if (!geometryKnown || previewW == 0) return
        val q = squeeze()
        val fill = settings.fullView
        val m = outputAffine(previewW, previewH, previewRotation, fill = fill, mirror = false, squeeze = q)
        val inv = invert(m)
        val (rwImg, rhImg) = extent(unitAffine(previewRotation, false, q))
        // Full screen: the picture fills the view and its sides run past the edges.
        val k = if (fill) max(previewW / rwImg, previewH / rhImg) else min(previewW / rwImg, previewH / rhImg)
        val rw = rwImg * k
        val rh = rhImg * k
        // The overlay works in view pixels; the preview buffer may be scaled down from them.
        val sx = previewW.toDouble() / viewW.coerceAtLeast(1); val sy = previewH.toDouble() / viewH.coerceAtLeast(1)
        val content = RectF(
            ((previewW - rw) / 2 / sx).toFloat(), ((previewH - rh) / 2 / sy).toFloat(),
            ((previewW + rw) / 2 / sx).toFloat(), ((previewH + rh) / 2 / sy).toFloat(),
        )
        val viewToImg = doubleArrayOf(inv[0] * sx, inv[1] * sy, inv[2], inv[3] * sx, inv[4] * sy, inv[5])
        listener?.onDisplayTransform(imgW, imgH, content, FloatArray(6) { viewToImg[it].toFloat() })
    }

    // ---- recording / photo ----------------------------------------------------------------------
    private var finishing = false

    private fun finishRecording(error: String? = null) {
        val rec = recorder ?: return
        if (!taking) return
        finishing = true
        if (error == null) emitReady(force = true) // nothing captured is lost
        finishing = false
        taking = false
        val spec = currentTake; currentTake = null
        // Keep the encoder armed for the next take when pre-record is on (and nothing failed).
        val keep = error == null && rec.failed == null && settings.prerollS > 0 && armAllowed && wantedOutputRotation == outputRotation
        if (!keep) {
            recorder = null
            encoderSurface?.let { egl.destroySurface(it) }
            encoderSurface = null
        }
        outputRotation = wantedOutputRotation
        Thread {
            val start = rec.takeStartUs
            val meta = rec.metadata()
            val uri = runCatching { if (keep) rec.endTake() else rec.stop() }.getOrNull()
            if (uri != null && spec != null) listener?.onTakeSaved(spec, meta, start)
            listener?.onRecording(false, 0, uri, error ?: rec.failed ?: if (uri == null) "The recording could not be saved" else null)
        }.start()
        if (!keep) handler.post { arm() }
    }

    private fun savePhoto(from: Slot? = null) {
        val slot = from ?: shown ?: newest ?: return
        val (w, h) = outputSize()
        val target = GlUtil.Target(w, h)
        GLES30.glBindVertexArray(vao)
        render(slot, w, h, outputRotation, fill = true, monitor = false, lut = settings.bakeLut, mirror = front && !settings.mirrorFront, film = settings.bakeFilm) {
            target.bind()
        }
        target.bind()
        val buf = ByteBuffer.allocateDirect(w * h * 4).order(ByteOrder.nativeOrder())
        GLES30.glReadPixels(0, 0, w, h, GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE, buf)
        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0)
        target.release()
        Thread {
            try {
                val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
                buf.rewind()
                bmp.copyPixelsFromBuffer(buf)
                val flipped = Bitmap.createBitmap(bmp, 0, 0, w, h, android.graphics.Matrix().apply { preScale(1f, -1f) }, false)
                val uri = com.veil.cam.media.MediaStorage.savePhoto(context, settings.privateGallery) { flipped.compress(Bitmap.CompressFormat.JPEG, 95, it) }
                listener?.onPhoto(uri, null)
            } catch (e: Exception) {
                listener?.onPhoto(null, e.message)
            }
        }.start()
    }

    // ---- burst merge ------------------------------------------------------------------------------
    /** Merge [frames] frames for one photo; [sigma]: noise level, [lift]: shadow lift for HDR / night. */
    class BurstRequest(val frames: Int, val sigma: Float, val lift: Float)

    private class Burst(
        val req: BurstRequest, val ref: Slot, val refLuma: FloatArray, val lw: Int, val lh: Int,
        var ping: GlUtil.Target, var pong: GlUtil.Target, val luma: GlUtil.Target,
    ) {
        var merged = 0
        var seen = 0
        var first = true
    }

    private fun startBurst(req: BurstRequest) {
        val src = shown ?: newest ?: run { photoRequested = true; return }
        val lw = LUMA_W; val lh = max(16, (LUMA_W.toLong() * imgH / imgW).toInt())
        val made = ArrayList<GlUtil.Target>()
        try {
            // The reference: the frame on screen when the shutter was pressed (its faces are known).
            val ref = Slot(GlUtil.Target(imgW, imgH).also { made += it }, GlUtil.Target(max(1, imgW / 4), max(1, imgH / 4), mipmaps = true).also { made += it })
            ref.ts = src.ts; ref.depth = src.depth; ref.focus = src.focus; ref.focusHalf = src.focusHalf; ref.far = src.far
            copyTex(src.color.tex, ref.color)
            val ping = GlUtil.Target(imgW, imgH, format = GLES30.GL_RGBA16F).also { made += it }
            val pong = GlUtil.Target(imgW, imgH, format = GLES30.GL_RGBA16F).also { made += it }
            val luma = GlUtil.Target(lw, lh).also { made += it }
            burst = Burst(req, ref, lumaOf(ref.color.tex, luma), lw, lh, ping, pong, luma)
        } catch (e: Throwable) {
            Log.w(TAG, "burst merge unavailable", e)
            made.forEach { it.release() }
            photoRequested = true
        }
    }

    /** Plain copy (the mean shader with weight 1). */
    private fun copyTex(tex: Int, dst: GlUtil.Target) {
        dst.bind()
        GLES30.glUseProgram(progMean)
        bindTex(0, tex); GLES30.glUniform1i(loc(progMean, "uAcc"), 0)
        GLES30.glUniform2f(loc(progMean, "uSize"), dst.width.toFloat(), dst.height.toFloat())
        GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, 3)
    }

    /** Small luma image (texture rows, bottom-up) for alignment; a synchronous read, a few kB. */
    private fun lumaOf(tex: Int, t: GlUtil.Target): FloatArray {
        t.bind()
        GLES30.glUseProgram(progLuma)
        bindTex(0, tex); GLES30.glUniform1i(loc(progLuma, "uSrc"), 0)
        GLES30.glUniform2f(loc(progLuma, "uDstSize"), t.width.toFloat(), t.height.toFloat())
        GLES30.glUniform2f(loc(progLuma, "uStep"), 0.25f / t.width, 0.25f / t.height)
        GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, 3)
        val buf = ByteBuffer.allocateDirect(t.width * t.height * 4).order(ByteOrder.nativeOrder())
        GLES30.glReadPixels(0, 0, t.width, t.height, GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE, buf)
        return FloatArray(t.width * t.height) { (buf.get(it * 4).toInt() and 0xFF) / 255f }
    }

    private fun burstStep(b: Burst, slot: Slot) {
        b.seen++
        val (dx, dy) = com.veil.cam.core.BurstAlign.translation(b.refLuma, lumaOf(slot.color.tex, b.luma), b.lw, b.lh)
        // A frame that moved too far (the phone swung) adds nothing but risk: skip it.
        if (abs(dx) < b.lw * 0.12f && abs(dy) < b.lh * 0.12f) {
            b.pong.bind()
            val p = progMerge
            GLES30.glUseProgram(p)
            bindTex(0, b.ref.color.tex); GLES30.glUniform1i(loc(p, "uRef"), 0)
            bindTex(1, slot.color.tex); GLES30.glUniform1i(loc(p, "uCur"), 1)
            bindTex(2, b.ping.tex); GLES30.glUniform1i(loc(p, "uAcc"), 2)
            GLES30.glUniform2f(loc(p, "uSize"), imgW.toFloat(), imgH.toFloat())
            GLES30.glUniform2f(loc(p, "uShift"), dx / b.lw, dy / b.lh)
            GLES30.glUniform1f(loc(p, "uSigma"), b.req.sigma)
            GLES30.glUniform1i(loc(p, "uFirst"), if (b.first) 1 else 0)
            GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, 3)
            b.first = false
            val t = b.ping; b.ping = b.pong; b.pong = t
            b.merged++
        }
        if (b.merged >= b.req.frames - 1 || b.seen >= b.req.frames * 2) finishBurst(b)
    }

    private fun finishBurst(b: Burst) {
        burst = null
        val made = ArrayList<GlUtil.Target>()
        try {
            if (!b.first) {
                val mean = GlUtil.Target(imgW, imgH, mipmaps = true, format = GLES30.GL_RGBA16F).also { made += it }
                copyTex(b.ping.tex, mean)
                GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, mean.tex)
                GLES30.glGenerateMipmap(GLES30.GL_TEXTURE_2D)
                b.ref.color.bind()
                val p = progTone
                GLES30.glUseProgram(p)
                bindTex(0, mean.tex); GLES30.glUniform1i(loc(p, "uMean"), 0)
                GLES30.glUniform2f(loc(p, "uSize"), imgW.toFloat(), imgH.toFloat())
                GLES30.glUniform1f(loc(p, "uLift"), b.req.lift)
                GLES30.glUniform1f(loc(p, "uLod"), ln(max(imgW, imgH) / 48f) / ln(2f))
                GLES30.glUniform1f(loc(p, "uSharpen"), (0.15f + b.merged * 0.03f).coerceAtMost(0.4f))
                GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, 3)
            }
            listener?.onBurstMerged(b.merged + 1)
            savePhoto(b.ref)
        } catch (e: Throwable) {
            Log.w(TAG, "burst merge failed", e)
            savePhoto(b.ref)
        } finally {
            made.forEach { it.release() }
            b.ping.release(); b.pong.release(); b.luma.release()
            b.ref.color.release(); b.ref.blur.release()
        }
    }

    // ---- textures ---------------------------------------------------------------------------------
    private fun uploadLut(l: Lut3D) {
        if (lutTex == 0) {
            val t = IntArray(1)
            GLES30.glGenTextures(1, t, 0)
            lutTex = t[0]
        }
        GLES30.glBindTexture(GLES30.GL_TEXTURE_3D, lutTex)
        val fbuf = FloatBuffer.wrap(l.data)
        GLES30.glPixelStorei(GLES30.GL_UNPACK_ALIGNMENT, 1)
        GLES30.glTexImage3D(GLES30.GL_TEXTURE_3D, 0, GLES30.GL_RGB16F, l.size, l.size, l.size, 0, GLES30.GL_RGB, GLES30.GL_FLOAT, fbuf)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_3D, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_LINEAR)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_3D, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_LINEAR)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_3D, GLES30.GL_TEXTURE_WRAP_S, GLES30.GL_CLAMP_TO_EDGE)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_3D, GLES30.GL_TEXTURE_WRAP_T, GLES30.GL_CLAMP_TO_EDGE)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_3D, GLES30.GL_TEXTURE_WRAP_R, GLES30.GL_CLAMP_TO_EDGE)
        lutSize = l.size
        GlUtil.check("lut")
    }

    private fun maskTexture(w: Int, h: Int, data: ByteArray): Int {
        val t = IntArray(1)
        GLES30.glGenTextures(1, t, 0)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, t[0])
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_LINEAR)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_LINEAR)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_S, GLES30.GL_CLAMP_TO_EDGE)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_T, GLES30.GL_CLAMP_TO_EDGE)
        GLES30.glPixelStorei(GLES30.GL_UNPACK_ALIGNMENT, 1)
        GLES30.glTexImage2D(GLES30.GL_TEXTURE_2D, 0, GLES30.GL_RG8, w, h, 0, GLES30.GL_RG, GLES30.GL_UNSIGNED_BYTE, ByteBuffer.wrap(data))
        return t[0]
    }

    private fun uploadMask(m: com.veil.cam.face.PersonMask) {
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, peopleTex)
        GLES30.glPixelStorei(GLES30.GL_UNPACK_ALIGNMENT, 1)
        // Two channels: person, hair.
        GLES30.glTexImage2D(GLES30.GL_TEXTURE_2D, 0, GLES30.GL_RG8, m.width, m.height, 0, GLES30.GL_RG, GLES30.GL_UNSIGNED_BYTE, ByteBuffer.wrap(m.data))
    }

    private fun texture2D(bmp: Bitmap): Int {
        val t = IntArray(1)
        GLES30.glGenTextures(1, t, 0)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, t[0])
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_LINEAR)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_LINEAR)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_S, GLES30.GL_CLAMP_TO_EDGE)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_T, GLES30.GL_CLAMP_TO_EDGE)
        GLUtils.texImage2D(GLES30.GL_TEXTURE_2D, 0, bmp, 0)
        return t[0]
    }

    private fun loadMask(path: String) {
        if (maskTex != 0) GLES30.glDeleteTextures(1, intArrayOf(maskTex), 0)
        val bmp = if (path.isNotEmpty()) runCatching { BitmapFactory.decodeFile(path) }.getOrNull() else null
        maskTex = texture2D(bmp ?: Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888))
        maskLoadedPath = if (bmp != null) path else ""
    }

    private fun bindTex(unit: Int, tex: Int) {
        GLES30.glActiveTexture(GLES30.GL_TEXTURE0 + unit)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, tex)
    }

    private fun loc(program: Int, name: String): Int = u.getOrPut("$program/$name") { GLES30.glGetUniformLocation(program, name) }

    private fun countFps() {
        frames++
        val now = SystemClock.elapsedRealtime()
        if (fpsWindowStart == 0L) fpsWindowStart = now
        if (now - fpsWindowStart >= 1000) {
            camFps = frames * 1000f / (now - fpsWindowStart)
            frames = 0
            fpsWindowStart = now
        }
    }

    private var lastStats = 0L
    private fun publishStats() {
        val now = SystemClock.uptimeMillis()
        if (now - lastStats < 500) return
        lastStats = now
        listener?.onStats(camFps, engine.rate, engine.lastMs, pending.size)
    }

    /**
     * Background blur eases towards its target (mode switch, new aperture, the person mask
     * arriving) like a focus pull, frame by frame on the camera clock, instead of jumping.
     */
    /** Focus point for cinematic depth (image px), or null to follow the subject. */
    fun setFocusPoint(x: Float?, y: Float?) { focusPoint = if (x == null || y == null) null else floatArrayOf(x, y) }

    /** The tapped subject moved: keep the focus point on it (and show where it is). */
    private fun followTap(m: com.veil.cam.face.DepthMap) {
        val t = m.track ?: return
        if (focusPoint == null || !manualFocus.isNaN()) return
        val inv = m.spec.toCanvas.inverse()
        val cx = t[0] * m.spec.width; val cy = t[1] * m.spec.height
        val ix = (inv.a * cx + inv.b * cy + inv.c).toFloat(); val iy = (inv.d * cx + inv.e * cy + inv.f).toFloat()
        if (ix !in 0f..imgW.toFloat() || iy !in 0f..imgH.toFloat()) return
        focusPoint = floatArrayOf(ix, iy)
        listener?.onFocusTrack(ix, iy)
    }

    /** Hold the depth of field at [depth] (0..1, the depth map's scale), or null to follow the subject. */
    fun setManualDepthFocus(depth: Float?) { manualFocus = depth ?: Float.NaN }

    /** Relative depth (0..1, 1 = nearest) at image point ([ix], [iy]), or null without a depth map. */
    fun depthAt(ix: Float, iy: Float): Float? {
        val dm = depthNet.latest ?: return null
        val m = dm.spec.toCanvas
        val u = ((m.a * ix + m.b * iy + m.c) / dm.spec.width).toFloat(); val v = ((m.d * ix + m.e * iy + m.f) / dm.spec.height).toFloat()
        if (u !in 0f..1f || v !in 0f..1f) return null
        val x = (u * dm.width).toInt().coerceIn(1, dm.width - 2); val y = (v * dm.height).toInt().coerceIn(1, dm.height - 2)
        var sum = 0
        for (yy in -1..1) for (xx in -1..1) sum += dm.data[(y + yy) * dm.width + x + xx].toInt() and 0xFF
        return sum / 9f / 255f
    }

    /** The focus plane follows the depth map's subject with a focus pull, not a jump. */
    private fun easeFocus(slot: Slot) {
        val dm = depthMap
        val manual = manualFocus
        if (!manual.isNaN()) {
            // An A-B focus pull drives the plane itself (already eased on its own curve).
            focusNow = manual; halfNow = 0.015f
            if (dm != null) farNow = dm.far
        } else if (dm != null) {
            if (focusNow.isNaN()) { focusNow = dm.focus; halfNow = dm.half; farNow = dm.far }
            val k = 1f - kotlin.math.exp(-(frameNs / 1e9f) / FOCUS_EASE_S)
            focusNow += (dm.focus - focusNow) * k
            halfNow += (dm.half - halfNow) * k
            farNow += (dm.far - farNow) * k
        }
        slot.focus = if (focusNow.isNaN()) 0.5f else focusNow
        slot.focusHalf = halfNow; slot.far = farNow
    }

    private fun depthMatrix(dm: com.veil.cam.face.DepthMap): FloatArray {
        val m = dm.spec.toCanvas
        val sx = 1.0 / dm.spec.width; val sy = 1.0 / dm.spec.height
        return mat3(floatArrayOf((m.a * sx).toFloat(), (m.b * sx).toFloat(), (m.c * sx).toFloat(), (m.d * sy).toFloat(), (m.e * sy).toFloat(), (m.f * sy).toFloat()))
    }

    private fun uploadDepth(m: com.veil.cam.face.DepthMap) {
        if (depthTex == 0) depthTex = maskTexture(1, 1, byteArrayOf(0, 0))
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, depthTex)
        GLES30.glPixelStorei(GLES30.GL_UNPACK_ALIGNMENT, 1)
        GLES30.glTexImage2D(GLES30.GL_TEXTURE_2D, 0, GLES30.GL_R8, m.width, m.height, 0, GLES30.GL_RED, GLES30.GL_UNSIGNED_BYTE, ByteBuffer.wrap(m.data))
    }

    private fun easeDepth(ts: Long): Float {
        val target = if (settings.depth > 0f && peopleMask != null) settings.depth else 0f
        val dt = if (depthTs == 0L) 0f else ((ts - depthTs) / 1e9f).coerceIn(0f, 0.1f)
        depthTs = ts
        val k = 1f - kotlin.math.exp(-dt / DEPTH_EASE_S)
        depthNow += (target - depthNow) * k
        if (abs(target - depthNow) < 0.002f) depthNow = target
        return depthNow
    }

    companion object {
        /** Blur radius at the widest aperture (fraction of the frame's short side). */
        const val MAX_BLUR = 0.07f
        private const val DEPTH_EASE_S = 0.22f // time constant: settles in ~0.7 s
        private const val FOCUS_EASE_S = 0.3f // focus pulls between subjects take ~1 s
        private const val TAG = "VeilGL"
        // Simulated over 24-60 fps, every power tier and 8-35 ms detections: with these,
        // no frame is ever emitted before its detection and the preview never drops one.
        private const val MAX_PREVIEW_BACKLOG = 6
        private const val MAX_STRIDE = 4 // frames between two detections, at most
        private const val GESTURE_EVERY_MS = 200L
        private const val LUMA_W = 320
    }
}
