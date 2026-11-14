package com.veil.cam.core

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import java.nio.FloatBuffer
import kotlin.math.max
import kotlin.math.min

/**
 * SCRFD face detector (InsightFace `det_500m.onnx` / `det_10g.onnx`), the same
 * models and post-processing as the desktop app.
 *
 * Input: an RGB canvas already scaled and padded to a multiple of 32 in both
 * directions (the GPU renders it), as interleaved bytes. Output: detections in
 * canvas pixels.
 */
class Scrfd(private val session: OrtSession, private val env: OrtEnvironment) : FaceModel {
    private val inputName = session.inputNames.first()
    private val outputNames = session.outputNames.toList()
    private val strides: IntArray
    private val fmc: Int
    private val anchors: Int
    private val useKps: Boolean

    init {
        when (outputNames.size) {
            6 -> { fmc = 3; strides = intArrayOf(8, 16, 32); anchors = 2; useKps = false }
            9 -> { fmc = 3; strides = intArrayOf(8, 16, 32); anchors = 2; useKps = true }
            10 -> { fmc = 5; strides = intArrayOf(8, 16, 32, 64, 128); anchors = 1; useKps = false }
            15 -> { fmc = 5; strides = intArrayOf(8, 16, 32, 64, 128); anchors = 1; useKps = true }
            else -> error("Unsupported SCRFD model with ${outputNames.size} outputs")
        }
    }

    private var blob: FloatBuffer? = null
    private var blobSize = 0

    /**
     * Run on an RGBA (or RGB with [channels] = 3) canvas of [w]x[h] pixels whose rows
     * are stored top-down. Returns detections in canvas pixels with score >= [threshold].
     */
    override fun detect(pixels: ByteArray, w: Int, h: Int, channels: Int, threshold: Float, bottomUp: Boolean): List<Detection> {
        require(w % 32 == 0 && h % 32 == 0) { "canvas must be a multiple of 32" }
        val n = w * h
        if (blobSize != n) {
            blob = FloatBuffer.allocate(3 * n)
            blobSize = n
        }
        val fb = blob!!
        val arr = fb.array()
        // CHW, RGB, (x - 127.5) / 128 exactly like cv2.dnn.blobFromImage(swapRB=True) on BGR.
        var p = 0
        for (y in 0 until h) {
            val srcRow = if (bottomUp) h - 1 - y else y
            var s = srcRow * w * channels
            for (x in 0 until w) {
                arr[p] = ((pixels[s].toInt() and 0xFF) - 127.5f) / 128f
                arr[n + p] = ((pixels[s + 1].toInt() and 0xFF) - 127.5f) / 128f
                arr[2 * n + p] = ((pixels[s + 2].toInt() and 0xFF) - 127.5f) / 128f
                p++
                s += channels
            }
        }
        fb.rewind()
        OnnxTensor.createTensor(env, fb, longArrayOf(1, 3, h.toLong(), w.toLong())).use { input ->
            session.run(mapOf(inputName to input)).use { res ->
                val outs = outputNames.map { name ->
                    val t = res.get(name).get() as OnnxTensor
                    val b = t.floatBuffer
                    FloatArray(b.remaining()).also { b.get(it) }
                }
                return decode(outs, w, h, threshold)
            }
        }
    }

    /** Anchor decoding + NMS, a straight port of `insightface.model_zoo.scrfd`. */
    fun decode(outs: List<FloatArray>, w: Int, h: Int, threshold: Float): List<Detection> =
        decodeOutputs(outs, w, h, threshold, strides, fmc, anchors, useKps)

    override fun close() = session.close()

    companion object {
        const val NMS = 0.4f

        fun decodeOutputs(
            outs: List<FloatArray>, w: Int, h: Int, threshold: Float,
            strides: IntArray, fmc: Int, anchors: Int, useKps: Boolean,
        ): List<Detection> {
            val cand = ArrayList<Detection>()
            for ((idx, stride) in strides.withIndex()) {
                val scores = outs[idx]
                val boxes = outs[idx + fmc]
                val kps = if (useKps) outs[idx + fmc * 2] else null
                val fw = w / stride
                val fh = h / stride
                val count = fw * fh * anchors
                for (i in 0 until min(count, scores.size)) {
                    val sc = scores[i]
                    if (sc < threshold) continue
                    val cell = i / anchors
                    val cx = (cell % fw) * stride.toFloat()
                    val cy = (cell / fw) * stride.toFloat()
                    val b = i * 4
                    val box = floatArrayOf(
                        cx - boxes[b] * stride, cy - boxes[b + 1] * stride,
                        cx + boxes[b + 2] * stride, cy + boxes[b + 3] * stride,
                    )
                    var pts: FloatArray? = null
                    if (kps != null) {
                        pts = FloatArray(10)
                        val k = i * 10
                        for (j in 0 until 5) {
                            pts[2 * j] = cx + kps[k + 2 * j] * stride
                            pts[2 * j + 1] = cy + kps[k + 2 * j + 1] * stride
                        }
                    }
                    cand.add(Detection(box, sc, pts))
                }
            }
            return nms(cand, NMS)
        }

        /** Greedy NMS with the reference implementation's +1 pixel area convention. */
        fun nms(dets: List<Detection>, thresh: Float): List<Detection> {
            val order = dets.sortedByDescending { it.score }.toMutableList()
            val keep = ArrayList<Detection>()
            while (order.isNotEmpty()) {
                val d = order.removeAt(0)
                keep.add(d)
                val a = d.bbox
                val areaA = (a[2] - a[0] + 1) * (a[3] - a[1] + 1)
                order.removeAll { o ->
                    val b = o.bbox
                    val iw = max(0f, min(a[2], b[2]) - max(a[0], b[0]) + 1)
                    val ih = max(0f, min(a[3], b[3]) - max(a[1], b[1]) + 1)
                    val inter = iw * ih
                    val areaB = (b[2] - b[0] + 1) * (b[3] - b[1] + 1)
                    inter / (areaA + areaB - inter) > thresh
                }
            }
            return keep
        }
    }
}
