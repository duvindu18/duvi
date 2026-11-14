package com.veil.cam.record

import android.content.Context
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaFormat
import android.media.MediaMuxer
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import android.view.Surface
import com.veil.cam.core.EncodedSample
import com.veil.cam.core.PacketRing
import com.veil.cam.media.MediaOutput
import java.nio.ByteBuffer
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/** What a take is called and where it goes. */
class TakeSpec(val output: MediaOutput, val baseName: String, val location: DoubleArray?)

/**
 * Video (Surface input, fed by the GL renderer with frames that are already anonymized)
 * and AAC audio encoders, muxed into takes.
 *
 * With a pre-record time the encoders run continuously ("armed") into a RAM ring of
 * encoded samples; a take then starts from a keyframe that many seconds back, so
 * unscripted action before the button press is in the clip. Each take also carries a
 * timed metadata track (camera settings once a second) next to video and audio.
 */
class Recorder(
    private val context: Context,
    val width: Int,
    val height: Int,
    private val fps: Int,
    bitrate: Int,
    hevc: Boolean,
    private val audio: AudioCapture?,
    prerollUs: Long = 0,
) : AudioCapture.Sink {
    val inputSurface: Surface
    val mime: String
    private val video: MediaCodec
    private val lock = Object()
    private val ring = PacketRing(prerollUs)
    private val preroll = prerollUs > 0
    private var videoFormat: MediaFormat? = null
    private var audioFormat: MediaFormat? = null
    private val videoThread = HandlerThread("VideoEnc").apply { start() }
    private var aac: MediaCodec? = null
    private val pcm = LinkedBlockingQueue<Pcm>(64)
    private var audioThread: Thread? = null
    @Volatile private var audioRunning = false
    @Volatile private var videoDone = false
    @Volatile var failed: String? = null
        private set

    // ---- the current take
    private var muxer: MediaMuxer? = null
    private var take: TakeSpec? = null
    private var videoTrack = -1
    private var audioTrack = -1
    private var metaTrack = -1
    private var muxerStarted = false
    private var baseUs = -1L
    private var lastUs = LongArray(3) { -1L }
    private val metaSamples = ArrayList<String>()
    /** Presentation time (encoder clock, µs) of the first frame of the current take. */
    @Volatile var takeStartUs = -1L
        private set
    @Volatile var bytesWritten = 0L
        private set
    val taking: Boolean get() = synchronized(lock) { take != null }

    private class Pcm(val data: ShortArray, val frames: Int, val ptsNs: Long, val eos: Boolean = false)

    init {
        mime = pickMime(hevc)
        val fmt = MediaFormat.createVideoFormat(mime, width, height).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
            setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
            setInteger(MediaFormat.KEY_FRAME_RATE, fps)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1) // a take can start at any second of the ring
            setInteger(MediaFormat.KEY_BITRATE_MODE, MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_VBR)
        }
        video = MediaCodec.createEncoderByType(mime)
        video.setCallback(object : MediaCodec.Callback() {
            override fun onInputBufferAvailable(c: MediaCodec, i: Int) {}
            override fun onOutputFormatChanged(c: MediaCodec, f: MediaFormat) {
                synchronized(lock) { videoFormat = f; maybeStartMuxer() }
            }
            override fun onOutputBufferAvailable(c: MediaCodec, i: Int, info: MediaCodec.BufferInfo) {
                try {
                    val buf = c.getOutputBuffer(i)
                    if (buf != null && info.size > 0 && info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) {
                        onSample(0, buf, info)
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

    /** Start the encoders (armed: samples go to the pre-record ring until [beginTake]). */
    fun start() {
        video.start()
        aac?.let { codec ->
            codec.start()
            audioRunning = true
            audioThread = Thread({ audioLoop(codec) }, "AudioEnc").apply { start() }
            audio?.sink = this
        }
    }

    /** Begin a take: the pre-record ring (if any) first, then live samples. */
    fun beginTake(spec: TakeSpec) {
        synchronized(lock) {
            if (take != null) return
            take = spec
            muxer = MediaMuxer(spec.output.fd, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4).also { m ->
                spec.location?.let { runCatching { m.setLocation(it[0].toFloat(), it[1].toFloat()) } }
            }
            videoTrack = -1; audioTrack = -1; metaTrack = -1; muxerStarted = false
            baseUs = -1L; lastUs.fill(-1L); takeStartUs = -1L; metaSamples.clear(); bytesWritten = 0
            if (!preroll) runCatching { video.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0) }) }
            maybeStartMuxer()
        }
    }

    private fun maybeStartMuxer() {
        val m = muxer ?: return
        if (muxerStarted || take == null) return
        val vf = videoFormat ?: return
        if (aac != null && audioFormat == null) return
        videoTrack = m.addTrack(vf)
        audioFormat?.let { audioTrack = m.addTrack(it) }
        // Timed metadata: camera settings once a second (ISO, shutter angle, WB, focus...).
        metaTrack = runCatching { m.addTrack(MediaFormat().apply { setString(MediaFormat.KEY_MIME, META_MIME) }) }.getOrDefault(-1)
        m.start()
        muxerStarted = true
        // The pre-recorded seconds (or, without pre-record, what arrived while the formats
        // were settling), from a keyframe.
        for (x in ring.take()) write(x.track, ByteBuffer.wrap(x.data), x.ptsUs, x.flags)
        if (!preroll) ring.clear()
    }

    private fun onSample(track: Int, buf: ByteBuffer, info: MediaCodec.BufferInfo) {
        val key = track == 1 || info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0
        val needCopy = preroll || !muxerStartedUnsafe()
        if (needCopy) {
            val bytes = ByteArray(info.size)
            buf.position(info.offset); buf.limit(info.offset + info.size); buf.get(bytes)
            val s = EncodedSample(track, info.presentationTimeUs, key, bytes, info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM.inv())
            // Ring and muxer under one lock: a starting take writes the ring, so a sample
            // added outside it could be written twice.
            synchronized(lock) {
                if (preroll) ring.add(s)
                if (muxerStarted) write(track, ByteBuffer.wrap(bytes), info.presentationTimeUs, s.flags)
                else if (!preroll && take != null) ring.add(s) // waiting for the formats: hold briefly
            }
        } else synchronized(lock) {
            buf.position(info.offset); buf.limit(info.offset + info.size)
            write(track, buf.slice(), info.presentationTimeUs, info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM.inv())
        }
    }

    private fun muxerStartedUnsafe() = muxerStarted

    /** Write one sample to the take; every track starts at the take's first video frame. */
    private fun write(track: Int, buf: ByteBuffer, ptsUs: Long, flags: Int) {
        val m = muxer ?: return
        if (!muxerStarted) return
        val t = when (track) { 0 -> videoTrack; 1 -> audioTrack; else -> metaTrack }
        if (t < 0) return
        if (baseUs < 0) {
            if (track != 0 || flags and MediaCodec.BUFFER_FLAG_KEY_FRAME == 0) return // start on a video keyframe
            baseUs = ptsUs; takeStartUs = ptsUs
        }
        val rel = ptsUs - baseUs
        if (rel < 0) return
        val us = if (rel <= lastUs[track]) lastUs[track] + 1 else rel
        lastUs[track] = us
        val info = MediaCodec.BufferInfo().apply { set(0, buf.remaining(), us, flags) }
        try {
            m.writeSampleData(t, buf, info)
            bytesWritten += info.size
        } catch (e: Exception) {
            fail("mux: ${e.message}")
        }
    }

    /** Camera settings at [ptsUs] (encoder clock) for the metadata track and the sidecar. */
    fun addMetadata(json: String, ptsUs: Long) {
        synchronized(lock) {
            if (take == null) return
            metaSamples += json
            if (muxerStarted && metaTrack >= 0) write(2, ByteBuffer.wrap(json.toByteArray()), ptsUs, 0)
        }
    }

    /** Metadata lines written in the current take. */
    fun metadata(): List<String> = synchronized(lock) { metaSamples.toList() }

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
                    synchronized(lock) { audioFormat = codec.outputFormat; maybeStartMuxer() }
                } else if (o >= 0) {
                    val buf = codec.getOutputBuffer(o)
                    if (buf != null && info.size > 0 && info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) onSample(1, buf, info)
                    codec.releaseOutputBuffer(o, false)
                    if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) { done = true; break }
                } else break
            }
        }
    }

    private fun fail(msg: String) {
        Log.e("VeilRec", msg)
        if (failed == null) failed = msg
    }

    /** Close the current take (the encoders keep running when armed). Returns the clip. */
    fun endTake(): Uri? {
        val spec: TakeSpec
        var ok = false
        synchronized(lock) {
            spec = take ?: return null
            try {
                if (muxerStarted) { muxer?.stop(); ok = lastUs[0] >= 0 }
            } catch (e: Exception) { fail("finalize: ${e.message}") }
            runCatching { muxer?.release() }
            muxer = null; take = null; muxerStarted = false
            if (!preroll) ring.clear()
        }
        spec.output.finish(ok)
        return if (ok) spec.output.uri else null
    }

    /** Finish any take and release the encoders (blocking up to a few seconds). */
    fun stop(): Uri? {
        audio?.sink = null
        if (aac != null) pcm.offer(Pcm(ShortArray(0), 0, System.nanoTime(), eos = true))
        runCatching { video.signalEndOfInputStream() }
        val deadline = System.currentTimeMillis() + 5000
        while (!videoDone && System.currentTimeMillis() < deadline) Thread.sleep(10)
        audioThread?.join(3000)
        audioRunning = false
        val uri = endTake()
        runCatching { video.stop() }; video.release()
        aac?.let { runCatching { it.stop() }; it.release() }
        videoThread.quitSafely()
        ring.clear()
        return uri
    }

    companion object {
        const val META_MIME = "application/x-veilcam-camera+json"

        fun durationText(ns: Long, fps: Int): String {
            val totalFrames = ns * fps / 1_000_000_000L
            val f = totalFrames % fps
            val s = totalFrames / fps
            return "%02d:%02d:%02d:%02d".format(s / 3600, s / 60 % 60, s % 60, f)
        }
    }
}
