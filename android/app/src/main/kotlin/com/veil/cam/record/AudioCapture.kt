package com.veil.cam.record

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTimestamp
import android.media.MediaRecorder
import android.os.SystemClock
import android.util.Log
import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.max

/**
 * Microphone reader shared by the level meters and the recorder. PCM blocks are
 * time-stamped on the camera's clock (boot time or monotonic), so audio and
 * video line up without drift.
 */
class AudioCapture(private val bootTimeClock: Boolean) {
    interface Sink { fun onPcm(data: ShortArray, frames: Int, channels: Int, ptsNs: Long) }

    val sampleRate = 48_000
    var channels = 2
        private set
    @Volatile var sink: Sink? = null
    @Volatile var levels = floatArrayOf(-90f, -90f) // peak dBFS per channel
        private set
    private var record: AudioRecord? = null
    private var thread: Thread? = null
    @Volatile private var running = false

    @SuppressLint("MissingPermission")
    fun start(): Boolean {
        if (running) return true
        for (ch in intArrayOf(AudioFormat.CHANNEL_IN_STEREO, AudioFormat.CHANNEL_IN_MONO)) {
            val min = AudioRecord.getMinBufferSize(sampleRate, ch, AudioFormat.ENCODING_PCM_16BIT)
            if (min <= 0) continue
            val r = runCatching {
                AudioRecord(MediaRecorder.AudioSource.CAMCORDER, sampleRate, ch, AudioFormat.ENCODING_PCM_16BIT, max(min * 4, 48_000))
            }.getOrNull() ?: continue
            if (r.state != AudioRecord.STATE_INITIALIZED) { r.release(); continue }
            channels = if (ch == AudioFormat.CHANNEL_IN_STEREO) 2 else 1
            record = r
            break
        }
        val r = record ?: return false
        running = true
        r.startRecording()
        thread = Thread({ loop(r) }, "Audio").apply { priority = Thread.MAX_PRIORITY; start() }
        return true
    }

    private fun now(): Long = if (bootTimeClock) SystemClock.elapsedRealtimeNanos() else System.nanoTime()

    private fun loop(r: AudioRecord) {
        val frames = 1024
        val buf = ShortArray(frames * channels)
        val ts = AudioTimestamp()
        val base = if (bootTimeClock) AudioTimestamp.TIMEBASE_BOOTTIME else AudioTimestamp.TIMEBASE_MONOTONIC
        var framesRead = 0L
        while (running) {
            val n = r.read(buf, 0, buf.size)
            if (n <= 0) { if (n < 0) Log.w("VeilAudio", "read error $n"); continue }
            val f = n / channels
            // Presentation time of the first frame of this block.
            val pts = if (r.getTimestamp(ts, base) == AudioRecord.SUCCESS) {
                ts.nanoTime + (framesRead - ts.framePosition) * 1_000_000_000L / sampleRate
            } else {
                now() - f * 1_000_000_000L / sampleRate
            }
            framesRead += f
            meter(buf, n)
            sink?.onPcm(buf, f, channels, pts)
        }
    }

    private fun meter(buf: ShortArray, n: Int) {
        val peak = FloatArray(2)
        for (i in 0 until n) {
            val c = if (channels == 2) i and 1 else 0
            val v = abs(buf[i].toInt()) / 32768f
            if (v > peak[c]) peak[c] = v
        }
        if (channels == 1) peak[1] = peak[0]
        levels = floatArrayOf(db(peak[0]), db(peak[1]))
    }

    private fun db(v: Float) = if (v <= 1e-5f) -90f else 20f * log10(v)

    fun stop() {
        running = false
        thread?.join(500)
        thread = null
        runCatching { record?.stop() }
        record?.release()
        record = null
        levels = floatArrayOf(-90f, -90f)
    }
}
