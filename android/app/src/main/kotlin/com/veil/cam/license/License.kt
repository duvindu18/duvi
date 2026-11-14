package com.veil.cam.license

import android.app.Activity
import com.veil.cam.core.LicenseState

/** The one-time purchase (store builds) or nothing to check (personal builds). */
interface License {
    val state: LicenseState
    /** Localised price of the unlock, once Play has sent it. */
    val price: String?
    /** Why capture is locked, for the paywall (null when it is not). */
    val reason: String?
    /** Called on the main thread whenever [state], [price] or [reason] change. */
    var onChange: (() -> Unit)?
    val canCapture: Boolean get() = state == LicenseState.LICENSED
    fun start()
    /** Ask Play again (on resume, when the network comes back, "Restore purchase"). */
    fun refresh()
    fun buy(activity: Activity)
    fun stop()
}
