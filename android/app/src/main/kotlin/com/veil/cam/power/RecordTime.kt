package com.veil.cam.power

import android.content.Context
import android.os.BatteryManager
import android.os.Environment
import android.os.StatFs
import kotlin.math.abs

/**
 * How long the phone can keep recording: the lower of what the battery and the storage
 * allow. The battery figure uses the phone's real current draw while recording (the
 * fuel gauge), learned per format during takes and remembered; before the first take it
 * uses a conservative figure for this app's pipeline on a Pixel.
 */
class RecordTime(context: Context) {
    private val bm = context.getSystemService(BatteryManager::class.java)
    private val prefs = context.getSharedPreferences("veil_power", Context.MODE_PRIVATE)
    private var ema = Float.NaN
    private var samples = 0
    private var bucket = ""

    data class Estimate(val minutes: Long, val byBattery: Long?, val byStorage: Long, val charging: Boolean, val learned: Boolean) {
        val limitedBy get() = if (byBattery != null && byBattery < byStorage) "battery" else "storage"
    }

    private fun bucketOf(width: Int, fps: Int, depth: Boolean) = "${width}x$fps${if (depth) "d" else ""}"

    /** Typical draw (µA) when nothing has been measured yet. */
    private fun defaultDrain(width: Int, fps: Int, depth: Boolean): Float {
        var ua = 1_300_000f // 1080p 24-30 fps with face detection, screen on
        if (width >= 3840) ua *= 1.35f
        if (fps > 30) ua *= 1.25f
        if (depth) ua *= 1.2f
        return ua
    }

    /** Battery current (µA, positive = drain), or null when unknown or charging. */
    private fun drainNow(): Float? {
        if (bm == null || bm.isCharging) return null
        var v = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW).toFloat()
        if (v == 0f || v == Int.MIN_VALUE.toFloat()) return null
        if (abs(v) < 20_000f) v *= 1000f // some gauges report mA
        return abs(v)
    }

    /** Call every few seconds while recording: learns the real draw of this format. */
    fun sample(width: Int, fps: Int, depth: Boolean) {
        val b = bucketOf(width, fps, depth)
        if (b != bucket) { bucket = b; ema = prefs.getFloat(b, Float.NaN); samples = 0 }
        val now = drainNow() ?: return
        ema = if (ema.isNaN()) now else 0.92f * ema + 0.08f * now
        samples++
        if (samples % 6 == 0) prefs.edit().putFloat(b, ema).putInt("$b.n", prefs.getInt("$b.n", 0) + samples).apply()
    }

    fun estimate(width: Int, fps: Int, depth: Boolean, bitrate: Int): Estimate {
        // Storage: video + audio, keeping 500 MB free for the system.
        val free = runCatching { StatFs(Environment.getExternalStorageDirectory().path).availableBytes }.getOrDefault(0L)
        val bps = bitrate.toLong() + 256_000L
        val byStorage = ((free - 500L * 1024 * 1024).coerceAtLeast(0) * 8 / bps / 60)
        val charging = bm?.isCharging == true
        var byBattery: Long? = null
        var learned = false
        if (bm != null && !charging) {
            val b = bucketOf(width, fps, depth)
            val stored = if (b == bucket && !ema.isNaN()) ema else prefs.getFloat(b, Float.NaN)
            learned = !stored.isNaN()
            val drain = if (learned) stored else defaultDrain(width, fps, depth)
            val charge = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CHARGE_COUNTER).toLong() // µAh
            val level = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY).coerceIn(1, 100)
            if (charge > 0) {
                // The phone shuts down a few percent before empty.
                val reserve = charge * 100 / level * 3 / 100
                byBattery = ((charge - reserve).coerceAtLeast(0) * 60 / drain.toLong().coerceAtLeast(1))
            } else {
                // No fuel gauge: assume a 5000 mAh battery at this level.
                byBattery = (5_000_000L * (level - 3).coerceAtLeast(0) / 100 * 60 / drain.toLong().coerceAtLeast(1))
            }
        }
        return Estimate(minOf(byBattery ?: Long.MAX_VALUE, byStorage), byBattery, byStorage, charging, learned)
    }
}
