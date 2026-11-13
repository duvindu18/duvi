package com.veil.cam.power

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PerformanceHintManager
import android.os.PowerManager
import android.util.Log

/**
 * Phone temperature as a level: 0 cool, 1 warm (throttling is near), 2 hot.
 *
 * Uses the thermal status (what the system is already doing about the heat) and the
 * thermal headroom forecast (how close the phone will be to throttling in ~10 s), so
 * the app sheds work before the SoC is throttled, not after the frame rate has dropped.
 */
class ThermalMonitor(private val context: Context, private val onChange: (level: Int, status: Int) -> Unit) {
    private val pm = context.getSystemService(PowerManager::class.java)
    private val main = Handler(Looper.getMainLooper())
    private var status = PowerManager.THERMAL_STATUS_NONE
    private var headroom = 0f
    var level = 0
        private set
    private var running = false

    private val listener = PowerManager.OnThermalStatusChangedListener { s -> status = s; evaluate() }

    private val poll = object : Runnable {
        override fun run() {
            if (!running) return
            // The headroom API is rate limited (NaN if called too often); 5 s is plenty.
            val h = runCatching { pm.getThermalHeadroom(10) }.getOrDefault(Float.NaN)
            if (!h.isNaN()) headroom = h
            evaluate()
            main.postDelayed(this, 5_000)
        }
    }

    fun start() {
        if (running || pm == null) return
        running = true
        status = pm.currentThermalStatus
        runCatching { pm.addThermalStatusListener(context.mainExecutor, listener) }
        main.post(poll)
    }

    fun stop() {
        running = false
        main.removeCallbacks(poll)
        runCatching { pm?.removeThermalStatusListener(listener) }
    }

    private fun evaluate() {
        // Hysteresis on the forecast so the level does not flicker around a threshold.
        val byHeadroom = when {
            headroom >= 0.95f -> 2
            headroom >= 0.8f -> 1
            level == 2 && headroom >= 0.88f -> 2
            level >= 1 && headroom >= 0.72f -> 1
            else -> 0
        }
        val byStatus = when {
            status >= PowerManager.THERMAL_STATUS_SEVERE -> 2
            status >= PowerManager.THERMAL_STATUS_MODERATE -> 1
            else -> 0
        }
        val l = maxOf(byHeadroom, byStatus)
        if (l != level || status != reported) {
            level = l
            reported = status
            Log.i("VeilPower", "thermal level $l (status $status, headroom $headroom)")
            onChange(l, status)
        }
    }

    private var reported = -1
}

/**
 * ADPF performance hints for one thread: the system learns how long the work really
 * takes against its deadline and runs the cores at the lowest clock that meets it,
 * instead of racing to the top frequency (the main cause of heat in camera apps).
 */
class WorkHint(context: Context, tid: Int, targetNs: Long) {
    // Typed as Any so the class loads on Android 11, where the API does not exist.
    private val session: Any? = if (Build.VERSION.SDK_INT >= 31) runCatching {
        context.getSystemService(PerformanceHintManager::class.java)?.createHintSession(intArrayOf(tid), targetNs.coerceAtLeast(1_000_000L))
    }.getOrNull() else null
    private var target = targetNs

    fun target(ns: Long) {
        val t = ns.coerceAtLeast(1_000_000L)
        if (t == target) return
        target = t
        if (Build.VERSION.SDK_INT >= 31) runCatching { (session as? PerformanceHintManager.Session)?.updateTargetWorkDuration(t) }
    }

    fun report(actualNs: Long) {
        if (actualNs > 0 && Build.VERSION.SDK_INT >= 31) runCatching { (session as? PerformanceHintManager.Session)?.reportActualWorkDuration(actualNs) }
    }

    /** Android 15+: prefer efficient cores and clocks over finishing as early as possible. */
    fun preferEfficiency(on: Boolean) {
        if (Build.VERSION.SDK_INT >= 35) runCatching { (session as? PerformanceHintManager.Session)?.setPreferPowerEfficiency(on) }
    }

    fun close() {
        if (Build.VERSION.SDK_INT >= 31) runCatching { (session as? PerformanceHintManager.Session)?.close() }
    }
}
