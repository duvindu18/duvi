package com.veil.cam.face

import android.content.Context
import android.graphics.Bitmap
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Log
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.core.Delegate
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.gesturerecognizer.GestureRecognizer
import com.veil.cam.core.PassSpec
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Palm gesture: an open palm held towards the camera for about half a second fires
 * [onPalm] once; the hand must drop (or close) before the next one. MediaPipe gesture
 * recogniser on the detector's base canvas, a few times a second.
 */
class GestureWatcher(private val context: Context) {
    private val thread = HandlerThread("Gesture", android.os.Process.THREAD_PRIORITY_BACKGROUND).apply { start() }
    private val handler = Handler(thread.looper)
    private var recognizer: GestureRecognizer? = null
    private var failed = false
    private val busy = AtomicBoolean(false)
    private var bitmap: Bitmap? = null
    private var lastMs = 0L
    private var palmSince = 0L
    private var lastSeen = 0L
    private var armed = true
    var onPalm: (() -> Unit)? = null
    /** Progress of the current hold, 0..1 (for a ring on screen), or 0. */
    @Volatile var holding = 0f
        private set

    val isBusy get() = busy.get()
    val usable get() = !failed

    private fun recognizer(): GestureRecognizer? {
        recognizer?.let { return it }
        if (failed) return null
        fun make(d: Delegate) = GestureRecognizer.createFromOptions(context, GestureRecognizer.GestureRecognizerOptions.builder()
            .setBaseOptions(BaseOptions.builder().setModelAssetPath(MODEL).setDelegate(d).build())
            .setRunningMode(RunningMode.VIDEO).setNumHands(2)
            .setMinHandDetectionConfidence(0.5f).setMinHandPresenceConfidence(0.5f).setMinTrackingConfidence(0.5f)
            .build())
        recognizer = runCatching { make(Delegate.GPU) }.recoverCatching { make(Delegate.CPU) }
            .onFailure { Log.e(TAG, "gesture model", it); failed = true }.getOrNull()
        return recognizer
    }

    /** [rgba] rows bottom-up (GL read-back). */
    fun submit(rgba: ByteArray, spec: PassSpec, timestampNs: Long) {
        if (failed || !busy.compareAndSet(false, true)) return
        handler.post {
            try {
                val r = recognizer() ?: return@post
                val w = spec.width; val h = spec.height
                val bmp = bitmap?.takeIf { it.width == w && it.height == h } ?: Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888).also { bitmap = it }
                val flipped = ByteArray(rgba.size); val row = w * 4
                for (y in 0 until h) System.arraycopy(rgba, (h - 1 - y) * row, flipped, y * row, row)
                bmp.copyPixelsFromBuffer(ByteBuffer.wrap(flipped))
                val ms = maxOf(lastMs + 1, timestampNs / 1_000_000L); lastMs = ms
                val res = r.recognizeForVideo(BitmapImageBuilder(bmp).build(), ms)
                val palm = res.gestures().any { hand -> hand.firstOrNull()?.let { it.categoryName() == "Open_Palm" && it.score() > 0.6f } == true }
                val now = SystemClock.uptimeMillis()
                if (palm) {
                    lastSeen = now
                    if (palmSince == 0L) palmSince = now
                    holding = ((now - palmSince) / HOLD_MS.toFloat()).coerceIn(0f, 1f)
                    if (armed && now - palmSince >= HOLD_MS) { armed = false; holding = 0f; onPalm?.invoke() }
                } else if (now - lastSeen > 350) {
                    palmSince = 0L; holding = 0f
                    if (now - lastSeen > RELEASE_MS) armed = true
                }
            } catch (e: Throwable) {
                Log.w(TAG, "gesture", e)
            } finally {
                busy.set(false)
            }
        }
    }

    fun release() {
        handler.post { runCatching { recognizer?.close() }; recognizer = null }
        thread.quitSafely()
    }

    companion object {
        private const val TAG = "VeilGesture"
        const val MODEL = "gesture_recognizer.task"
        private const val HOLD_MS = 600L
        private const val RELEASE_MS = 900L
    }
}
