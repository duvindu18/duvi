package com.veil.cam.record

import android.content.Context
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaFormat
import android.media.MediaMuxer
import android.net.Uri
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import android.view.Surface
import java.nio.ByteBuffer
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * MP4 recorder: a Surface-input video encoder fed by the GL renderer (frames are
 * already anonymized) plus AAC audio from [AudioCapture]. Saved to
 * Movies/VeilCam through MediaStore.
 */
class Recorder(
    private val context: Context,
    val width: Int,
    val height: Int,
    private val fps: Int,
    bitrate: Int,
    hevc: Boolean,
    private val audio: AudioCapture?,
    private val privateStorage: Boolean = true,
) : AudioCapture.Sink {
    val inputSurface: Surface
    val mime: String
    private val video: MediaCodec
    private val muxerLock = Object()
    private var muxer: MediaMuxer? = null
    private val output: com.veil.cam.media.MediaOutput
    private var videoTrack = -1
    private var audioTrack = -1
    private var muxerStarted = false
    private val pending = ArrayList<Sample>()
    @Volatile private var baseUs = -1L
    private var lastVideoUs = -1L
    private var lastAudioUs = -1L
    private val videoThread = HandlerThread("VideoEnc").apply { start() }
    private var aac: MediaCodec? = null
    private val pcm = LinkedBlockingQueue<Pcm>(64)
    private var audioThread: Thread? = null
    @Volatile private var audioRunning = false
    @Volatile private var videoDone = false
    @Volatile var failed: String? = null
        private set
    @Volatile var bytesWritten = 0L
        private set

    private class Sample(val track: Int, val data: ByteArray, val info: MediaCodec.BufferInfo)
    private class Pcm(val data: ShortArray, val frames: Int, val ptsNs: Long, val eos: Boolean = false)

    init {
        mime = pickMime(hevc)
        val fmt = MediaFormat.createVideoFormat(mime, width, height).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
            setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
            setInteger(MediaFormat.KEY_FRAME_RATE, fps)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
        }
        video = MediaCodec.createEncoderByType(mime)
        video.setCallback(object : MediaCodec.Callback() {
            override fun onInputBufferAvailable(c: MediaCodec, i: Int) {}
            override fun onOutputFormatChanged(c: MediaCodec, f: MediaFormat) {
                synchronized(muxerLock) { videoTrack = muxer!!.addTrack(f); maybeStart() }
            }
            override fun onOutputBufferAvailable(c: MediaCodec, i: Int, info: MediaCodec.BufferInfo) {
                try {
                    val buf = c.getOutputBuffer(i)
                    if (buf != null && info.size > 0 && info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) {
                        if (baseUs < 0) baseUs = info.presentationTimeUs
                        writeSample(true, buf, info)
                    }
                    c.releaseOutputBuffer(i, false)
                    if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) videoDone = true
                } catch (e: Exception) {
                    fail("video: ${e.message}")
                    videoDone = true
                }
            }
            override fun onError(c: MediaCodec, e: MediaCodec.CodecException) { fail("video codec: ${e.message}"); videoDone = true }
        }, Handler(videoThread.looper))
        video.configure(fmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        inputSurface = video.createInputSurface()

        output = com.veil.cam.media.MediaStorage.newVideo(context, privateStorage)
        muxer = MediaMuxer(output.fd, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)

        if (audio != null) {
            val af = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, audio.sampleRate, audio.channels).apply {
                setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
                setInteger(MediaFormat.KEY_BIT_RATE, if (audio.channels == 2) 256_000 else 128_000)
                setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16384)
            }
            aac = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC).apply { configure(af, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE) }
        }
    }

    private fun pickMime(hevc: Boolean): String {
        val list = MediaCodecList(MediaCodecList.REGULAR_CODECS)
        fun ok(m: String): Boolean {
            val f = MediaFormat.createVideoFormat(m, width, height).apply { setInteger(MediaFormat.KEY_FRAME_RATE, fps) }
            return list.findEncoderForFormat(f) != null
        }
        if (hevc && ok(MediaFormat.MIMETYPE_VIDEO_HEVC)) return MediaFormat.MIMETYPE_VIDEO_HEVC
        if (ok(MediaFormat.MIMETYPE_VIDEO_AVC)) return MediaFormat.MIMETYPE_VIDEO_AVC
        error("This phone cannot encode ${width}x$height at $fps fps")
    }

    fun start() {
        video.start()
        aac?.let { codec ->
            codec.start()
            audioRunning = true
            audioThread = Thread({ audioLoop(codec) }, "AudioEnc").apply { start() }
            audio?.sink = this
        }
    }

    @Volatile private var paused = false
    @Volatile private var pauseOffsetNs = 0L

    /** Pause / resume: audio is dropped while paused and later audio is shifted to close the gap. */
    fun setPaused(p: Boolean, offsetNs: Long) { pauseOffsetNs = offsetNs; paused = p }

    override fun onPcm(data: ShortArray, frames: Int, channels: Int, ptsNs: Long) {
        if (!audioRunning || paused) return
        pcm.offer(Pcm(data.copyOf(frames * channels), frames, ptsNs - pauseOffsetNs))
    }

    private fun audioLoop(codec: MediaCodec) {
        val info = MediaCodec.BufferInfo()
        var eosQueued = false
        var done = false
        while (!done) {
            if (!eosQueued) {
                val p = pcm.poll(20, TimeUnit.MILLISECONDS)
                if (p != null) {
                    val idx = codec.dequeueInputBuffer(10_000)
                    if (idx >= 0) {
                        val buf = codec.getInputBuffer(idx)!!
                        buf.clear()
                        if (p.eos) {
                            codec.queueInputBuffer(idx, 0, 0, p.ptsNs / 1000, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                            eosQueued = true
                        } else {
                            val n = minOf(p.data.size, buf.capacity() / 2)
                            buf.asShortBuffer().put(p.data, 0, n)
                            codec.queueInputBuffer(idx, 0, n * 2, p.ptsNs / 1000, 0)
                        }
                    }
                }
            }
            while (true) {
                val o = codec.dequeueOutputBuffer(info, if (eosQueued) 10_000 else 0)
                if (o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    synchronized(muxerLock) { audioTrack = muxer!!.addTrack(codec.outputFormat); maybeStart() }
                } else if (o >= 0) {
                    val buf = codec.getOutputBuffer(o)
                    if (buf != null && info.size > 0 && info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) writeSample(false, buf, info)
                    codec.releaseOutputBuffer(o, false)
                    if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) { done = true; break }
                } else break
            }
        }
    }

    private fun maybeStart() {
        val m = muxer ?: return
        if (muxerStarted || videoTrack < 0 || (aac != null && audioTrack < 0)) return
        m.start()
        muxerStarted = true
        flushPending()
    }

    private fun flushPending() {
        if (!muxerStarted || baseUs < 0 || pending.isEmpty()) return
        for (s in pending.sortedBy { it.info.presentationTimeUs }) write(s.track, ByteBuffer.wrap(s.data), s.info)
        pending.clear()
    }

    private fun writeSample(isVideo: Boolean, buf: ByteBuffer, info: MediaCodec.BufferInfo) {
        synchronized(muxerLock) {
            val track = if (isVideo) videoTrack else audioTrack
            if (track < 0) return
            val copy = MediaCodec.BufferInfo().apply { set(0, info.size, info.presentationTimeUs, info.flags) }
            if (!muxerStarted || baseUs < 0) {
                if (pending.size < 2000) {
                    val bytes = ByteArray(info.size)
                    buf.position(info.offset); buf.limit(info.offset + info.size); buf.get(bytes)
                    pending.add(Sample(track, bytes, copy))
                }
                return
            }
            flushPending()
            buf.position(info.offset); buf.limit(info.offset + info.size)
            write(track, buf.slice(), copy)
        }
    }

    /** Both tracks start at the first video frame; earlier audio is dropped. */
    private fun write(track: Int, buf: ByteBuffer, info: MediaCodec.BufferInfo) {
        val base = baseUs
        if (base < 0) return
        val rel = info.presentationTimeUs - base
        if (rel < 0) return
        val isVideo = track == videoTrack
        val last = if (isVideo) lastVideoUs else lastAudioUs
        val t = if (rel <= last) last + 1 else rel
        if (isVideo) lastVideoUs = t else lastAudioUs = t
        info.presentationTimeUs = t
        info.offset = 0
        try {
            muxer!!.writeSampleData(track, buf, info)
            bytesWritten += info.size
        } catch (e: Exception) {
            fail("mux: ${e.message}")
        }
    }

    private fun fail(msg: String) {
        Log.e("VeilRec", msg)
        if (failed == null) failed = msg
    }

    /** Finish the file (blocking up to a few seconds). Returns the saved video or null. */
    fun stop(): Uri? {
        audio?.sink = null
        if (aac != null) {
            pcm.offer(Pcm(ShortArray(0), 0, (System.nanoTime()), eos = true))
        }
        runCatching { video.signalEndOfInputStream() }
        val deadline = System.currentTimeMillis() + 5000
        while (!videoDone && System.currentTimeMillis() < deadline) Thread.sleep(10)
        audioThread?.join(3000)
        audioRunning = false
        runCatching { video.stop() }; video.release()
        aac?.let { runCatching { it.stop() }; it.release() }
        videoThread.quitSafely()
        var ok = false
        synchronized(muxerLock) {
            try {
                if (muxerStarted) { muxer?.stop(); ok = lastVideoUs >= 0 }
            } catch (e: Exception) { fail("finalize: ${e.message}") }
            runCatching { muxer?.release() }
            muxer = null
        }
        output.finish(ok)
        return if (ok) output.uri else null
    }

    companion object {
        fun durationText(ns: Long, fps: Int): String {
            val totalFrames = ns * fps / 1_000_000_000L
            val f = totalFrames % fps
            val s = totalFrames / fps
            return "%02d:%02d:%02d:%02d".format(s / 3600, s / 60 % 60, s % 60, f)
        }
    }
}
