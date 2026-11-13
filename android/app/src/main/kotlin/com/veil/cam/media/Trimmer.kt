package com.veil.cam.media

import android.graphics.SurfaceTexture
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.opengl.GLES11Ext
import android.opengl.GLES30
import android.os.Handler
import android.os.HandlerThread
import android.view.Surface
import com.veil.cam.gl.EglCore
import com.veil.cam.gl.GlUtil
import com.veil.cam.gl.Shaders
import java.io.File
import java.nio.ByteBuffer
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import kotlin.math.max

/** A time range in microseconds, [start, end). */
data class Span(val startUs: Long, val endUs: Long) {
    val durationUs get() = endUs - startUs
}

object Spans {
    /** The parts to keep when [cuts] are removed from [0, durationUs). */
    fun keep(cuts: List<Span>, durationUs: Long): List<Span> {
        val merged = merge(cuts.map { Span(it.startUs.coerceIn(0, durationUs), it.endUs.coerceIn(0, durationUs)) }.filter { it.durationUs > 0 })
        val out = ArrayList<Span>()
        var t = 0L
        for (c in merged) { if (c.startUs > t) out.add(Span(t, c.startUs)); t = max(t, c.endUs) }
        if (t < durationUs) out.add(Span(t, durationUs))
        return out.filter { it.durationUs > 1000 }
    }

    fun merge(spans: List<Span>): List<Span> {
        val s = spans.sortedBy { it.startUs }
        val out = ArrayList<Span>()
        for (x in s) {
            val last = out.lastOrNull()
            if (last != null && x.startUs <= last.endUs) out[out.size - 1] = Span(last.startUs, max(last.endUs, x.endUs)) else out.add(x)
        }
        return out
    }
}

/**
 * Removes parts of a video. Video is decoded and re-encoded through GL so cuts are
 * frame-accurate (not limited to key frames); audio packets are copied untouched
 * (accurate to one AAC frame, ~21 ms). The result is a new file; the original is kept.
 */
class Trimmer(private val input: File, private val output: File) {
    @Volatile var cancelled = false

    fun run(keep: List<Span>, onProgress: (Float) -> Unit) {
        require(keep.isNotEmpty()) { "Nothing left to keep" }
        val total = keep.sumOf { it.durationUs }.coerceAtLeast(1)
        val vEx = MediaExtractor().apply { setDataSource(input.absolutePath) }
        val vTrack = (0 until vEx.trackCount).firstOrNull { vEx.getTrackFormat(it).getString(MediaFormat.KEY_MIME)!!.startsWith("video/") }
            ?: error("No video track")
        val vFmt = vEx.getTrackFormat(vTrack)
        vEx.selectTrack(vTrack)
        val aEx = MediaExtractor().apply { setDataSource(input.absolutePath) }
        val aTrack = (0 until aEx.trackCount).firstOrNull { aEx.getTrackFormat(it).getString(MediaFormat.KEY_MIME)!!.startsWith("audio/") }
        aTrack?.let { aEx.selectTrack(it) }

        val w = vFmt.getInteger(MediaFormat.KEY_WIDTH)
        val h = vFmt.getInteger(MediaFormat.KEY_HEIGHT)
        val fps = if (vFmt.containsKey(MediaFormat.KEY_FRAME_RATE)) vFmt.getInteger(MediaFormat.KEY_FRAME_RATE) else 30
        val durUs = vFmt.getLong(MediaFormat.KEY_DURATION)
        val bitrate = if (vFmt.containsKey(MediaFormat.KEY_BIT_RATE)) vFmt.getInteger(MediaFormat.KEY_BIT_RATE)
        else (input.length() * 8 * 1_000_000L / durUs.coerceAtLeast(1)).toInt().coerceIn(4_000_000, 150_000_000)
        val srcMime = vFmt.getString(MediaFormat.KEY_MIME)!!
        val outMime = if (srcMime == MediaFormat.MIMETYPE_VIDEO_HEVC) srcMime else MediaFormat.MIMETYPE_VIDEO_AVC

        val muxer = MediaMuxer(output.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
        if (vFmt.containsKey("rotation-degrees")) muxer.setOrientationHint(vFmt.getInteger("rotation-degrees"))
        val enc = MediaCodec.createEncoderByType(outMime)
        enc.configure(MediaFormat.createVideoFormat(outMime, w, h).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
            setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
            setInteger(MediaFormat.KEY_FRAME_RATE, fps)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
        }, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        val encSurface = enc.createInputSurface()
        enc.start()

        val gl = GlBridge(encSurface, w, h)
        val dec = MediaCodec.createDecoderByType(srcMime)
        dec.configure(vFmt, gl.decoderSurface, null, 0)
        dec.start()

        var videoTrackOut = -1
        var audioTrackOut = -1
        var muxStarted = false
        val info = MediaCodec.BufferInfo()
        var doneUs = 0L

        fun drainEncoder(eos: Boolean) {
            while (true) {
                val idx = enc.dequeueOutputBuffer(info, if (eos) 10_000 else 0)
                when {
                    idx == MediaCodec.INFO_TRY_AGAIN_LATER -> if (!eos) return
                    idx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                        videoTrackOut = muxer.addTrack(enc.outputFormat)
                        if (aTrack != null) audioTrackOut = muxer.addTrack(aEx.getTrackFormat(aTrack))
                        muxer.start(); muxStarted = true
                    }
                    idx >= 0 -> {
                        val buf = enc.getOutputBuffer(idx)!!
                        if (info.size > 0 && info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0 && muxStarted) {
                            buf.position(info.offset); buf.limit(info.offset + info.size)
                            muxer.writeSampleData(videoTrackOut, buf, info)
                        }
                        enc.releaseOutputBuffer(idx, false)
                        if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return
                    }
                }
            }
        }

        // ---- video: decode each kept span, render frames inside it with closed-up timestamps
        var removedUs = 0L
        var prevEnd = 0L
        for (span in keep) {
            if (cancelled) break
            removedUs += span.startUs - prevEnd
            prevEnd = span.endUs
            vEx.seekTo(span.startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)
            dec.flush()
            var inputDone = false
            var spanDone = false
            while (!spanDone && !cancelled) {
                if (!inputDone) {
                    val ii = dec.dequeueInputBuffer(5_000)
                    if (ii >= 0) {
                        val n = vEx.readSampleData(dec.getInputBuffer(ii)!!, 0)
                        if (n < 0 || vEx.sampleTime >= span.endUs + 200_000) {
                            dec.queueInputBuffer(ii, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM); inputDone = true
                        } else {
                            dec.queueInputBuffer(ii, 0, n, vEx.sampleTime, 0); vEx.advance()
                        }
                    }
                }
                val oi = dec.dequeueOutputBuffer(info, 5_000)
                if (oi >= 0) {
                    val pts = info.presentationTimeUs
                    val eos = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
                    val inside = pts >= span.startUs && pts < span.endUs && info.size > 0
                    dec.releaseOutputBuffer(oi, inside)
                    if (inside) {
                        gl.drawFrame((pts - removedUs) * 1000)
                        doneUs = (doneUs + 0).coerceAtLeast(pts - span.startUs + keep.takeWhile { it !== span }.sumOf { it.durationUs })
                        onProgress(0.95f * doneUs / total)
                    }
                    drainEncoder(false)
                    if (eos || pts >= span.endUs) spanDone = true
                }
            }
        }
        enc.signalEndOfInputStream()
        drainEncoder(true)

        // ---- audio: copy packets inside the kept spans
        if (aTrack != null && muxStarted && !cancelled) {
            val buf = ByteBuffer.allocate(1 shl 20)
            var removed = 0L
            var last = 0L
            var lastOut = -1L
            for (span in keep) {
                removed += span.startUs - last
                last = span.endUs
                aEx.seekTo(span.startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)
                while (!cancelled) {
                    val t = aEx.sampleTime
                    if (t < 0 || t >= span.endUs) break
                    val n = aEx.readSampleData(buf, 0)
                    if (n < 0) break
                    if (t >= span.startUs) {
                        val outT = t - removed
                        if (outT > lastOut) {
                            info.set(0, n, outT, if (aEx.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC != 0) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0)
                            muxer.writeSampleData(audioTrackOut, buf, info)
                            lastOut = outT
                        }
                    }
                    aEx.advance()
                }
            }
        }
        runCatching { dec.stop() }; dec.release()
        runCatching { enc.stop() }; enc.release()
        gl.release()
        vEx.release(); aEx.release()
        if (muxStarted) runCatching { muxer.stop() }
        muxer.release()
        if (cancelled) { output.delete(); error("Cancelled") }
        onProgress(1f)
    }

    /** Decoder -> SurfaceTexture -> GL copy -> encoder surface (robust across devices). */
    private class GlBridge(encoderSurface: Surface, private val w: Int, private val h: Int) {
        private val thread = HandlerThread("TrimGL").apply { start() }
        private val handler = Handler(thread.looper)
        private lateinit var egl: EglCore
        private lateinit var target: android.opengl.EGLSurface
        private var prog = 0
        private var tex = 0
        private lateinit var st: SurfaceTexture
        lateinit var decoderSurface: Surface
        private val frameReady = Semaphore(0)
        private val m = FloatArray(16)

        init {
            val ready = Semaphore(0)
            handler.post {
                egl = EglCore()
                target = egl.windowSurface(encoderSurface)
                egl.makeCurrent(target)
                prog = GlUtil.program(Shaders.VS, COPY)
                tex = GlUtil.oesTexture()
                st = SurfaceTexture(tex)
                st.setOnFrameAvailableListener({ frameReady.release() }, handler)
                decoderSurface = Surface(st)
                val vao = IntArray(1); GLES30.glGenVertexArrays(1, vao, 0); GLES30.glBindVertexArray(vao[0])
                ready.release()
            }
            ready.acquire()
        }

        fun drawFrame(ptsNs: Long) {
            if (!frameReady.tryAcquire(2, TimeUnit.SECONDS)) return
            val done = Semaphore(0)
            handler.post {
                st.updateTexImage()
                st.getTransformMatrix(m)
                GLES30.glViewport(0, 0, w, h)
                GLES30.glUseProgram(prog)
                GLES30.glActiveTexture(GLES30.GL_TEXTURE0)
                GLES30.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, tex)
                GLES30.glUniform1i(GLES30.glGetUniformLocation(prog, "uOes"), 0)
                GLES30.glUniformMatrix4fv(GLES30.glGetUniformLocation(prog, "uSt"), 1, false, m, 0)
                GLES30.glUniform2f(GLES30.glGetUniformLocation(prog, "uSize"), w.toFloat(), h.toFloat())
                GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, 3)
                egl.setPresentationTime(target, ptsNs)
                egl.swap(target)
                done.release()
            }
            done.acquire()
        }

        fun release() {
            val done = Semaphore(0)
            handler.post {
                runCatching { decoderSurface.release(); st.release() }
                runCatching { egl.destroySurface(target); egl.release() }
                done.release()
            }
            done.tryAcquire(2, TimeUnit.SECONDS)
            thread.quitSafely()
        }

        companion object {
            const val COPY = """#version 300 es
#extension GL_OES_EGL_image_external_essl3 : require
precision highp float;
uniform samplerExternalOES uOes;
uniform mat4 uSt;
uniform vec2 uSize;
out vec4 frag;
void main() { frag = vec4(texture(uOes, (uSt * vec4(gl_FragCoord.xy / uSize, 0.0, 1.0)).xy).rgb, 1.0); }
"""
        }
    }
}

/**
 * Finds pauses (silence) in a clip's audio for auto-trim: windows below a level
 * set from the clip's own noise floor, at least [minPauseUs] long. Returns the
 * spans to cut, each shrunk by [padUs] so words are never clipped.
 */
object SilenceDetector {
    fun find(file: File, minPauseUs: Long = 700_000, padUs: Long = 180_000): List<Span> {
        val ex = MediaExtractor().apply { setDataSource(file.absolutePath) }
        val track = (0 until ex.trackCount).firstOrNull { ex.getTrackFormat(it).getString(MediaFormat.KEY_MIME)!!.startsWith("audio/") }
            ?: run { ex.release(); return emptyList() }
        val fmt = ex.getTrackFormat(track)
        ex.selectTrack(track)
        val durUs = fmt.getLong(MediaFormat.KEY_DURATION)
        val dec = MediaCodec.createDecoderByType(fmt.getString(MediaFormat.KEY_MIME)!!)
        dec.configure(fmt, null, null, 0)
        dec.start()
        val win = 20_000L // 20 ms analysis windows
        val levels = ArrayList<Float>()
        var acc = 0.0; var cnt = 0; var winEnd = win
        val info = MediaCodec.BufferInfo()
        var inDone = false; var outDone = false
        var rate = fmt.getInteger(MediaFormat.KEY_SAMPLE_RATE)
        var ch = fmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
        while (!outDone) {
            if (!inDone) {
                val ii = dec.dequeueInputBuffer(5_000)
                if (ii >= 0) {
                    val n = ex.readSampleData(dec.getInputBuffer(ii)!!, 0)
                    if (n < 0) { dec.queueInputBuffer(ii, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM); inDone = true }
                    else { dec.queueInputBuffer(ii, 0, n, ex.sampleTime, 0); ex.advance() }
                }
            }
            val oi = dec.dequeueOutputBuffer(info, 5_000)
            if (oi == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                rate = dec.outputFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE); ch = dec.outputFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
            } else if (oi >= 0) {
                val sb = dec.getOutputBuffer(oi)!!.order(java.nio.ByteOrder.LITTLE_ENDIAN).asShortBuffer()
                val frames = info.size / 2 / ch
                var t = info.presentationTimeUs
                for (f in 0 until frames) {
                    var v = 0.0
                    for (c in 0 until ch) { val s = sb.get(f * ch + c) / 32768.0; v += s * s }
                    acc += v / ch; cnt++
                    t = info.presentationTimeUs + f * 1_000_000L / rate
                    if (t >= winEnd) {
                        levels.add((10 * kotlin.math.log10(acc / cnt.coerceAtLeast(1) + 1e-12)).toFloat())
                        acc = 0.0; cnt = 0; winEnd += win
                    }
                }
                dec.releaseOutputBuffer(oi, false)
                if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) outDone = true
            }
        }
        dec.stop(); dec.release(); ex.release()
        if (levels.isEmpty()) return emptyList()
        // Threshold from the clip itself: 10th-percentile level (room tone) + 9 dB, at most -30 dBFS.
        val floor = levels.sorted()[levels.size / 10]
        val thr = minOf(-30f, floor + 9f).coerceAtLeast(-70f)
        val cuts = ArrayList<Span>()
        var i = 0
        while (i < levels.size) {
            if (levels[i] < thr) {
                var j = i
                while (j < levels.size && levels[j] < thr) j++
                val s = i * win; val e = minOf(durUs, j * win)
                val lead = s == 0L; val tail = j >= levels.size
                val cs = if (lead) 0L else s + padUs
                val ce = if (tail) durUs else e - padUs
                if (ce - cs >= minPauseUs - 2 * padUs && ce > cs) cuts.add(Span(cs, ce))
                i = j
            } else i++
        }
        return cuts
    }
}
