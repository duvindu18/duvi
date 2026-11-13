package com.veil.cam.face

import android.graphics.Bitmap
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.segmentation.Segmentation
import com.google.mlkit.vision.segmentation.Segmenter
import com.google.mlkit.vision.segmentation.selfie.SelfieSegmenterOptions
import com.veil.cam.core.PassSpec
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean

/** Person mask in the coordinates of a detector canvas (rows top-down, 0..255 = person). */
class PersonMask(val spec: PassSpec, val width: Int, val height: Int, val data: ByteArray, val timestampNs: Long)

/**
 * Segments people for the cinematic depth effect (background defocus) on the
 * detector's base canvas, so the mask lines up with the frame it came from.
 * Runs on its own thread at whatever rate the device allows.
 */
class PersonSegmenter {
    private val thread = HandlerThread("Segment").apply { start() }
    private val handler = Handler(thread.looper)
    private var segmenter: Segmenter? = null
    private val busy = AtomicBoolean(false)
    @Volatile var latest: PersonMask? = null
        private set
    private var bitmap: Bitmap? = null

    val isBusy get() = busy.get()

    /** [rgba] rows are bottom-up (GL read-back). */
    fun submit(rgba: ByteArray, spec: PassSpec, timestampNs: Long) {
        if (!busy.compareAndSet(false, true)) return
        handler.post {
            try {
                val seg = segmenter ?: Segmentation.getClient(
                    SelfieSegmenterOptions.Builder().setDetectorMode(SelfieSegmenterOptions.STREAM_MODE).enableRawSizeMask().build()
                ).also { segmenter = it }
                val w = spec.width; val h = spec.height
                val bmp = bitmap?.takeIf { it.width == w && it.height == h } ?: Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888).also { bitmap = it }
                val flipped = ByteArray(rgba.size)
                val row = w * 4
                for (y in 0 until h) System.arraycopy(rgba, (h - 1 - y) * row, flipped, y * row, row)
                bmp.copyPixelsFromBuffer(ByteBuffer.wrap(flipped))
                val mask = Tasks.await(seg.process(InputImage.fromBitmap(bmp, 0)))
                val buf = mask.buffer.asFloatBuffer()
                val mw = mask.width; val mh = mask.height
                val out = ByteArray(mw * mh)
                for (i in 0 until mw * mh) out[i] = (buf.get(i).coerceIn(0f, 1f) * 255f).toInt().toByte()
                latest = PersonMask(spec, mw, mh, out, timestampNs)
            } catch (e: Throwable) {
                Log.w("VeilSegment", "segmentation failed", e)
            } finally {
                busy.set(false)
            }
        }
    }

    fun clear() { latest = null }

    fun release() {
        handler.post { runCatching { segmenter?.close() } }
        thread.quitSafely()
    }
}
