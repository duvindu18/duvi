package com.veil.cam.face

import android.content.Context
import android.graphics.Bitmap
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.framework.image.ByteBufferExtractor
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.core.Delegate
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.imagesegmenter.ImageSegmenter
import com.veil.cam.core.PassSpec
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Person mask in the coordinates of a detector canvas (rows top-down): two bytes per
 * pixel, person and hair (0..255). [serial] changes with every new mask.
 */
class PersonMask(val spec: PassSpec, val width: Int, val height: Int, val data: ByteArray, val timestampNs: Long, val serial: Int)

/**
 * Segments people for cinematic depth on the detector's base canvas, so the mask lines
 * up with the frame it came from. MediaPipe image segmenter on the GPU with the
 * multiclass selfie model: it separates hair from the background, which the renderer
 * uses for finer edges. A light temporal blend keeps the outline from flickering;
 * the renderer then re-finds the exact edge on every frame (guided filter).
 */
class PersonSegmenter(private val context: Context) {
    private val thread = HandlerThread("Segment").apply { start() }
    private val handler = Handler(thread.looper)
    private var segmenter: ImageSegmenter? = null
    private var failed = false
    private val busy = AtomicBoolean(false)
    @Volatile var latest: PersonMask? = null
        private set
    private var bitmap: Bitmap? = null
    private var prev: FloatArray? = null
    private var prevKey = ""
    private var lastMs = 0L
    private var serial = 0
    var onError: ((String) -> Unit)? = null

    val isBusy get() = busy.get()

    private fun create(delegate: Delegate): ImageSegmenter {
        val base = BaseOptions.builder().setModelAssetPath(MODEL).setDelegate(delegate).build()
        val opts = ImageSegmenter.ImageSegmenterOptions.builder()
            .setBaseOptions(base)
            .setRunningMode(RunningMode.VIDEO)
            .setOutputConfidenceMasks(true)
            .setOutputCategoryMask(false)
            .build()
        return ImageSegmenter.createFromOptions(context, opts)
    }

    private fun segmenter(): ImageSegmenter? {
        segmenter?.let { return it }
        if (failed) return null
        segmenter = runCatching { create(Delegate.GPU) }.onFailure { Log.w(TAG, "GPU segmenter unavailable, using CPU", it) }.getOrNull()
            ?: runCatching { create(Delegate.CPU) }.onFailure {
                Log.e(TAG, "segmenter failed", it); failed = true
                onError?.invoke("Cinematic depth model is missing from this build")
            }.getOrNull()
        return segmenter
    }

    /** [rgba] rows are bottom-up (GL read-back). */
    fun submit(rgba: ByteArray, spec: PassSpec, timestampNs: Long) {
        if (!busy.compareAndSet(false, true)) return
        handler.post {
            try {
                val seg = segmenter() ?: return@post
                val w = spec.width; val h = spec.height
                val bmp = bitmap?.takeIf { it.width == w && it.height == h } ?: Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888).also { bitmap = it }
                val flipped = ByteArray(rgba.size)
                val row = w * 4
                for (y in 0 until h) System.arraycopy(rgba, (h - 1 - y) * row, flipped, y * row, row)
                bmp.copyPixelsFromBuffer(ByteBuffer.wrap(flipped))
                // Video mode needs strictly increasing timestamps (camera restarts reset them).
                val ms = maxOf(lastMs + 1, timestampNs / 1_000_000L)
                lastMs = ms
                val result = seg.segmentForVideo(BitmapImageBuilder(bmp).build(), ms)
                val masks = result.confidenceMasks().orElse(null) ?: return@post
                if (masks.size < 2) return@post
                val bgBuf = ByteBufferExtractor.extract(masks[0]).order(ByteOrder.nativeOrder()).asFloatBuffer()
                val hairBuf = ByteBufferExtractor.extract(masks[1]).order(ByteOrder.nativeOrder()).asFloatBuffer()
                val mw = masks[0].width; val mh = masks[0].height
                val n = mw * mh
                // Person = everything but background; blend with the last mask of the same canvas.
                val key = "$mw x $mh ${spec.totalAngle} ${spec.width}"
                val p = prev?.takeIf { it.size == n * 2 && key == prevKey }
                val cur = FloatArray(n * 2)
                for (i in 0 until n) {
                    var person = 1f - bgBuf.get(i)
                    var hair = hairBuf.get(i)
                    if (p != null) { person = 0.65f * person + 0.35f * p[2 * i]; hair = 0.65f * hair + 0.35f * p[2 * i + 1] }
                    cur[2 * i] = person; cur[2 * i + 1] = hair
                }
                prev = cur; prevKey = key
                val out = ByteArray(n * 2)
                for (i in 0 until n * 2) out[i] = (cur[i].coerceIn(0f, 1f) * 255f + 0.5f).toInt().toByte()
                latest = PersonMask(spec, mw, mh, out, timestampNs, ++serial)
                masks.forEach { runCatching { it.close() } }
            } catch (e: Throwable) {
                Log.w(TAG, "segmentation failed", e)
            } finally {
                busy.set(false)
            }
        }
    }

    fun clear() { latest = null; prev = null }

    fun release() {
        handler.post { runCatching { segmenter?.close() }; segmenter = null }
        thread.quitSafely()
    }

    companion object {
        private const val TAG = "VeilSegment"
        const val MODEL = "selfie_multiclass_256x256.tflite"
    }
}
