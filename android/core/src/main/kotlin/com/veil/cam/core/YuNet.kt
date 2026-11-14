package com.veil.cam.core

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import java.nio.FloatBuffer
import kotlin.math.exp
import kotlin.math.sqrt

/** A face detector on a canvas whose sides are multiples of 32 (SCRFD or YuNet). */
interface FaceModel : AutoCloseable {
    /** Detections in canvas pixels with score >= [threshold]; rows top-down unless [bottomUp]. */
    fun detect(pixels: ByteArray, w: Int, h: Int, channels: Int, threshold: Float, bottomUp: Boolean = false): List<Detection>
}

/**
 * YuNet face detector (OpenCV Zoo `face_detection_yunet_2023mar`, MIT licence), with
 * its input made size-agnostic so it runs on the same canvases as SCRFD. Five
 * landmarks in the same order as SCRFD (right eye, left eye, nose, mouth corners), so
 * the multi-angle pipeline, roll estimate and tracker work unchanged.
 *
 * Scores are mapped onto SCRFD's scale ([calibrate]) so every threshold in the
 * pipeline keeps its meaning.
 */
class YuNet(private val session: OrtSession, private val env: OrtEnvironment) : FaceModel {
    private val inputName = session.inputNames.first()
    private val names = listOf(8, 16, 32).flatMap { s -> listOf("cls_$s", "obj_$s", "bbox_$s", "kps_$s") }
    private var blob: FloatBuffer? = null
    private var blobSize = 0

    override fun detect(pixels: ByteArray, w: Int, h: Int, channels: Int, threshold: Float, bottomUp: Boolean): List<Detection> {
        require(w % 32 == 0 && h % 32 == 0) { "canvas must be a multiple of 32" }
        val n = w * h
        if (blobSize != n) { blob = FloatBuffer.allocate(3 * n); blobSize = n }
        val fb = blob!!
        val arr = fb.array()
        // CHW, BGR, 0..255 (YuNet's training input, as cv2.dnn.blobFromImage on a BGR image).
        var p = 0
        for (y in 0 until h) {
            var s = (if (bottomUp) h - 1 - y else y) * w * channels
            for (x in 0 until w) {
                arr[p] = (pixels[s + 2].toInt() and 0xFF).toFloat()
                arr[n + p] = (pixels[s + 1].toInt() and 0xFF).toFloat()
                arr[2 * n + p] = (pixels[s].toInt() and 0xFF).toFloat()
                p++; s += channels
            }
        }
        fb.rewind()
        OnnxTensor.createTensor(env, fb, longArrayOf(1, 3, h.toLong(), w.toLong())).use { input ->
            session.run(mapOf(inputName to input)).use { res ->
                val outs = names.map { name ->
                    val b = (res.get(name).get() as OnnxTensor).floatBuffer
                    FloatArray(b.remaining()).also { b.get(it) }
                }
                return decodeOutputs(outs, w, h, threshold)
            }
        }
    }

    override fun close() = session.close()

    companion object {
        const val NMS = 0.3f
        const val BOX_W = 1.10f
        const val BOX_H = 1.15f
        const val BOX_DY = 0.07f

        /**
         * YuNet score -> SCRFD-like score. Measured on the same faces: YuNet is more
         * confident on clear faces and drops faster on hard ones; this piecewise-linear
         * map keeps the pipeline's 0.35 (candidate) and 0.5 (confirmed) thresholds.
         */
        fun calibrate(s: Float): Float = when {
            s < 0.5f -> s * 0.7f                       // 0.5 -> 0.35
            s < 0.7f -> 0.35f + (s - 0.5f) * 0.75f     // 0.7 -> 0.5
            else -> 0.5f + (s - 0.7f) * (0.45f / 0.3f) // 1.0 -> 0.95
        }

        /** OpenCV FaceDetectorYN post-processing (2023mar heads), then NMS. */
        fun decodeOutputs(outs: List<FloatArray>, w: Int, h: Int, threshold: Float): List<Detection> {
            val cand = ArrayList<Detection>()
            for ((k, stride) in intArrayOf(8, 16, 32).withIndex()) {
                val cls = outs[4 * k]; val obj = outs[4 * k + 1]; val box = outs[4 * k + 2]; val kps = outs[4 * k + 3]
                val cols = w / stride; val rows = h / stride
                for (i in 0 until minOf(cols * rows, cls.size)) {
                    val raw = sqrt(cls[i].coerceIn(0f, 1f) * obj[i].coerceIn(0f, 1f))
                    val sc = calibrate(raw)
                    if (sc < threshold) continue
                    val c = i % cols; val r = i / cols
                    val cx = (c + box[4 * i]) * stride; val cy = (r + box[4 * i + 1]) * stride
                    // YuNet's boxes are tighter than SCRFD's (which every coverage default is
                    // tuned on). Measured on 33 faces: SCRFD is 1.075x wider, 1.11x taller and
                    // 0.075 of the height lower; map a little past the mean, towards covering more.
                    val yw = exp(box[4 * i + 2]) * stride; val yh = exp(box[4 * i + 3]) * stride
                    val bw = yw * BOX_W; val bh = yh * BOX_H
                    val cyAdj = cy + yh * BOX_DY
                    val pts = FloatArray(10)
                    for (j in 0 until 5) {
                        pts[2 * j] = (kps[10 * i + 2 * j] + c) * stride
                        pts[2 * j + 1] = (kps[10 * i + 2 * j + 1] + r) * stride
                    }
                    cand.add(Detection(floatArrayOf(cx - bw / 2, cyAdj - bh / 2, cx + bw / 2, cyAdj + bh / 2), sc, pts))
                }
            }
            return Scrfd.nms(cand, NMS)
        }
    }
}
