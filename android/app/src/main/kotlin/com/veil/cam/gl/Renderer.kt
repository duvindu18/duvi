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
import com.veil.cam.core.Geom
import com.veil.cam.core.Lut3D
import com.veil.cam.core.PassImage
import com.veil.cam.core.PassPlanner
import com.veil.cam.core.PassSpec
import com.veil.cam.face.DetectBatch
import com.veil.cam.face.FaceEngine
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
class Renderer(private val context: Context, private val engine: FaceEngine, private val segmenter: com.veil.cam.face.PersonSegmenter) {
    interface Listener {
        fun onCameraSurface(surface: Surface, size: Size)
        fun onDisplayTransform(imgW: Int, imgH: Int, content: RectF, viewToImg: FloatArray)
        fun onFaces(faces: List<Geom>)
        fun onHistogram(luma: IntArray, r: IntArray, g: IntArray, b: IntArray)
        fun onStats(cameraFps: Float, detectFps: Float, detectMs: Float, delayFrames: Int)
        fun onRecording(active: Boolean, elapsedNs: Long, uri: Uri?, error: String?)
        fun onPhoto(uri: Uri?, error: String?)
        fun onDetectorReady(ready: Boolean)
    }

    private class Slot(val color: GlUtil.Target, val blur: GlUtil.Target) {
        var ts = 0L
    }

    private class Readback(val ts: Long, val specs: List<PassSpec>, val pbos: IntArray, val fence: Long)

    var listener: Listener? = null
    private val thread = HandlerThread("GL").apply { start(); priority = Thread.MAX_PRIORITY }
    private val handler = Handler(thread.looper)
    private lateinit var egl: EglCore
    private var progCopy = 0; private var progDown = 0; private var progBlur = 0; private var progPass = 0; private var progComp = 0
    private var progFilm = 0
    private val stages = HashMap<Long, GlUtil.Target>() // output size -> anonymized intermediate (mipmapped)
    private var peopleTex = 0
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
    private var displayRotation = 90

    private var slots: List<Slot> = emptyList()
    private val pending = ArrayDeque<Slot>()
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
    private var encoderSurface: EGLSurface? = null
    private var recorder: Recorder? = null
    private var recordStartTs = -1L
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
            peopleTex = maskTexture(1, 1, byteArrayOf(0))
            val v = IntArray(1)
            GLES30.glGenVertexArrays(1, v, 0)
            vao = v[0]
            GLES30.glBindVertexArray(vao)
            // Neutral 2^3 LUT and 1x1 mask so the samplers are always valid.
            uploadLut(Lut3D.build("Identity", 2) { r, g, b -> floatArrayOf(r, g, b) })
            lutLoaded = null
            maskTex = texture2D(Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888))
        }
    }

    // ---- public API (any thread) ---------------------------------------------------
    /** Blocks until the GL thread has switched surfaces, so a destroyed window is never drawn to. */
    fun setPreview(surface: Surface?, w: Int, h: Int) {
        val done = java.util.concurrent.CountDownLatch(1)
        handler.post {
            try {
                preview?.let { egl.destroySurface(it) }
                preview = null
                if (surface != null && surface.isValid) {
                    preview = runCatching { egl.windowSurface(surface) }.getOrNull()
                    previewW = w; previewH = h
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

    fun setDisplayRotation(deg: Int) = handler.post {
        if (recorder != null) return@post // orientation is locked while recording
        displayRotation = deg
        publishTransform()
    }

    fun update(s: Settings) = handler.post {
        val maskChanged = s.maskPath != settings.maskPath
        settings = s
        if (maskChanged) loadMask(s.maskPath)
        publishTransform()
    }

    fun setLut(lut: Lut3D?) = handler.post {
        if (lut == null) { lutLoaded = null; return@post }
        uploadLut(lut)
        lutLoaded = lut
    }

    fun setAudio(a: AudioCapture?) = handler.post { audio = a }

    fun startRecording() = handler.post {
        if (recorder != null || !geometryKnown) return@post
        if (settings.blurOn && !hasResult) {
            listener?.onRecording(false, 0, null, "Face detection is still starting. Try again in a moment.")
            return@post
        }
        val (w, h) = outputSize()
        try {
            val r = Recorder(context, w, h, settings.fps, settings.bitrate(), settings.hevc, if (settings.audio) audio else null, settings.privateGallery)
            encoderSurface = egl.windowSurface(r.inputSurface)
            r.start()
            recorder = r
            recordStartTs = -1L
            recPaused = false; pauseStartTs = -1L; pauseOffsetNs = 0L
            listener?.onRecording(true, 0, null, null)
        } catch (e: Exception) {
            Log.e(TAG, "record start", e)
            encoderSurface?.let { egl.destroySurface(it) }
            encoderSurface = null
            listener?.onRecording(false, 0, null, e.message ?: "Cannot start recording")
        }
    }

    fun stopRecording() = handler.post { finishRecording() }

    fun takePhoto() = handler.post { photoRequested = true }

    /** Pause or resume the running recording (one file, the pause is cut out). */
    fun setRecordingPaused(paused: Boolean) = handler.post {
        val rec = recorder ?: return@post
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
            releaseCameraInput()
            preview?.let { egl.destroySurface(it) }
            preview = null
            egl.release()
        }
        thread.quitSafely()
    }

    // ---- camera input ------------------------------------------------------------------
    private fun releaseCameraInput() {
        readback?.let { GLES30.glDeleteSync(it.fence) }
        readback = null
        pending.clear(); shown = null; newest = null
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
        val n = if (imgW.toLong() * imgH > 3_000_000L) 4 else 6
        slots = List(n) { Slot(GlUtil.Target(imgW, imgH), GlUtil.Target(max(1, imgW / 4), max(1, imgH / 4), mipmaps = true)) }
        blurTmpA = GlUtil.Target(max(1, imgW / 4), max(1, imgH / 4))
        blurTmpB = GlUtil.Target(max(1, imgW / 4), max(1, imgH / 4))
        geometryKnown = true
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

        egl.makeOffscreenCurrent()
        GLES30.glBindVertexArray(vao)
        val slot = acquireSlot()
        slot.ts = ts
        copyFrame(slot)
        if (settings.blurOn || !hasResult) blurChain(slot)
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
    }

    private fun acquireSlot(): Slot {
        while (true) {
            val free = slots.firstOrNull { it !in pending && it !== shown }
            if (free != null) return free
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
    private fun baseAngle(): Double = displayRotation.toDouble()

    private fun maybeCaptureDetection(slot: Slot) {
        val wantFaces = settings.blurOn && !engine.isBusy && engine.ready
        val wantPeople = settings.depth > 0f && !segmenter.isBusy
        if (readback != null || !(wantFaces || wantPeople)) return
        val baseSide = if (settings.accurateModel) 640 else 480
        val base = PassPlanner.base(imgW, imgH, baseAngle(), baseSide)
        val scale = PassPlanner.scaleOf(base)
        val specs = listOf(base) + engine.plan.take(4).map { PassPlanner.rotated(imgW, imgH, baseAngle(), it, scale) }
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
        readback = Readback(slot.ts, specs, ids, fence)
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
        if (settings.depth > 0f && passes.isNotEmpty()) segmenter.submit(passes[0].pixels.copyOf(), passes[0].spec, rb.ts)
        val ok = settings.blurOn && engine.submit(DetectBatch(rb.ts, imgW, imgH, passes) { owned.forEach { recycleArray(it) } })
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
        if (!settings.histogram || now - lastHist < 120) return
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
        val limit = max(1, slots.size - 2)
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
            if (recordStartTs < 0) recordStartTs = s.ts
            if (!recPaused) {
                egl.makeCurrent(enc)
                GLES30.glBindVertexArray(vao)
                render(s, rec.width, rec.height, fill = true, monitor = false, lut = settings.bakeLut,
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
        if (!settings.lowLatencyPreview) shown = s
    }

    private fun drawPreview() {
        val p = preview ?: return
        val slot = (if (settings.lowLatencyPreview) newest else shown) ?: return
        egl.makeCurrent(p)
        GLES30.glBindVertexArray(vao)
        val faces = render(slot, previewW, previewH, fill = false, monitor = true, lut = settings.lutOnMonitor, mirror = false, film = true) {
            GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0)
            GLES30.glViewport(0, 0, previewW, previewH)
        }
        egl.swap(p)
        egl.makeOffscreenCurrent()
        if (settings.lowLatencyPreview) shown = slot
        val now = SystemClock.uptimeMillis()
        if (settings.showBoxes && now - lastFacesSent > 66) { lastFacesSent = now; listener?.onFaces(faces) }
        val rec = recorder
        if (rec != null && recordStartTs >= 0) {
            val pausedFor = if (recPaused && pauseStartTs >= 0) lastEmittedTs - pauseStartTs else 0L
            listener?.onRecording(true, lastEmittedTs - recordStartTs - pauseOffsetNs - pausedFor, null, null)
        }
    }

    // ---- composite ------------------------------------------------------------------------------
    private val fa = FloatArray(Shaders.MAX_FACES * 4)
    private val fb = FloatArray(Shaders.MAX_FACES * 4)

    /** Output transform: image px -> output px (column-major 3x3 of the inverse is uploaded). */
    private fun outputAffine(outW: Int, outH: Int, fill: Boolean, mirror: Boolean): DoubleArray {
        val theta = Math.toRadians(-displayRotation.toDouble()) // clockwise on screen
        val c = cos(theta); val s = sin(theta)
        val quarter = (displayRotation / 90) % 2 == 1
        val rw = if (quarter) imgH else imgW
        val rh = if (quarter) imgW else imgH
        val k = if (fill) max(outW.toDouble() / rw, outH.toDouble() / rh) else min(outW.toDouble() / rw, outH.toDouble() / rh)
        val mx = if (mirror) -1.0 else 1.0
        // out = k * R * diag(mx, 1) * (p - imgCentre) + outCentre
        val a = k * c * mx; val b = -k * s; val d = k * s * mx; val e = k * c
        val cx = imgW / 2.0; val cy = imgH / 2.0
        return doubleArrayOf(a, b, outW / 2.0 - a * cx - b * cy, d, e, outH / 2.0 - d * cx - e * cy)
    }

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
        slot: Slot, outW: Int, outH: Int, fill: Boolean, monitor: Boolean, lut: Boolean, mirror: Boolean, film: Boolean,
        bindDest: () -> Unit,
    ): List<Geom> {
        val stage = stages.getOrPut((outW.toLong() shl 32) or outH.toLong()) {
            if (stages.size > 4) { stages.values.forEach { it.release() }; stages.clear() }
            GlUtil.Target(outW, outH, mipmaps = true)
        }
        stage.bind()
        val faces = composite(slot, outW, outH, fill, lut, mirror)
        val s = settings
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

    private fun composite(slot: Slot, outW: Int, outH: Int, fill: Boolean, lut: Boolean, mirror: Boolean): List<Geom> {
        val s = settings
        val faces = if (s.blurOn) engine.timeline.at(slot.ts).sortedByDescending { it.w * it.h }.take(Shaders.MAX_FACES) else emptyList()
        val p = progComp
        GLES30.glUseProgram(p)
        bindTex(0, slot.color.tex); GLES30.glUniform1i(loc(p, "uColor"), 0)
        bindTex(1, slot.blur.tex); GLES30.glUniform1i(loc(p, "uBlur"), 1)
        GLES30.glActiveTexture(GLES30.GL_TEXTURE2)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_3D, lutTex); GLES30.glUniform1i(loc(p, "uLut"), 2)
        bindTex(3, maskTex); GLES30.glUniform1i(loc(p, "uMask"), 3)
        val inv = invert(outputAffine(outW, outH, fill, mirror))
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
        val depthOn = s.depth > 0f && pm != null
        GLES30.glActiveTexture(GLES30.GL_TEXTURE4)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, peopleTex); GLES30.glUniform1i(loc(p, "uPeople"), 4)
        GLES30.glUniform1f(loc(p, "uDepth"), if (depthOn) (0.6f + s.depth * (maxLod - 0.6f).coerceAtLeast(1f)).coerceAtMost(maxLod) else 0f)
        if (pm != null) {
            val m = pm.spec.toCanvas
            // image px -> canvas px -> mask uv (mask rows are top-down, uploaded as-is)
            val sx = 1.0 / pm.spec.width; val sy = 1.0 / pm.spec.height
            val a = floatArrayOf((m.a * sx).toFloat(), (m.b * sx).toFloat(), (m.c * sx).toFloat(), (m.d * sy).toFloat(), (m.e * sy).toFloat(), (m.f * sy).toFloat())
            GLES30.glUniformMatrix3fv(loc(p, "uImgToPeople"), 1, false, mat3(a), 0)
        }
        GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, 3)
        return faces
    }

    /** AWB presets the active camera supports (set by the activity). */
    @Volatile var availableAwb: IntArray = IntArray(0)

    private fun outputSize(): Pair<Int, Int> {
        val quarter = (displayRotation / 90) % 2 == 1
        val w = if (quarter) imgH else imgW
        val h = if (quarter) imgW else imgH
        return (w and 1.inv()) to (h and 1.inv())
    }

    private fun publishTransform() {
        if (!geometryKnown || previewW == 0) return
        val m = outputAffine(previewW, previewH, fill = false, mirror = false)
        val inv = invert(m)
        val quarter = (displayRotation / 90) % 2 == 1
        val rwImg = if (quarter) imgH else imgW
        val rhImg = if (quarter) imgW else imgH
        val k = min(previewW.toDouble() / rwImg, previewH.toDouble() / rhImg)
        val rw = rwImg * k
        val rh = rhImg * k
        val content = RectF(((previewW - rw) / 2).toFloat(), ((previewH - rh) / 2).toFloat(), ((previewW + rw) / 2).toFloat(), ((previewH + rh) / 2).toFloat())
        listener?.onDisplayTransform(imgW, imgH, content, FloatArray(6) { inv[it].toFloat() })
    }

    // ---- recording / photo ----------------------------------------------------------------------
    private var finishing = false

    private fun finishRecording(error: String? = null) {
        val rec = recorder ?: return
        finishing = true
        if (error == null) emitReady(force = true) // nothing captured is lost
        finishing = false
        recorder = null
        encoderSurface?.let { egl.destroySurface(it) }
        encoderSurface = null
        Thread {
            val uri = runCatching { rec.stop() }.getOrNull()
            listener?.onRecording(false, 0, uri, error ?: rec.failed ?: if (uri == null) "The recording could not be saved" else null)
        }.start()
    }

    private fun savePhoto() {
        val slot = shown ?: newest ?: return
        val (w, h) = outputSize()
        val target = GlUtil.Target(w, h)
        GLES30.glBindVertexArray(vao)
        render(slot, w, h, fill = true, monitor = false, lut = settings.bakeLut, mirror = front && !settings.mirrorFront, film = settings.bakeFilm) {
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
        GLES30.glTexImage2D(GLES30.GL_TEXTURE_2D, 0, GLES30.GL_R8, w, h, 0, GLES30.GL_RED, GLES30.GL_UNSIGNED_BYTE, ByteBuffer.wrap(data))
        return t[0]
    }

    private fun uploadMask(m: com.veil.cam.face.PersonMask) {
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, peopleTex)
        GLES30.glPixelStorei(GLES30.GL_UNPACK_ALIGNMENT, 1)
        GLES30.glTexImage2D(GLES30.GL_TEXTURE_2D, 0, GLES30.GL_R8, m.width, m.height, 0, GLES30.GL_RED, GLES30.GL_UNSIGNED_BYTE, ByteBuffer.wrap(m.data))
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

    companion object { private const val TAG = "VeilGL" }
}
