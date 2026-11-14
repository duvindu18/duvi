package com.veil.cam.license

import android.app.Activity
import android.content.Context
import com.veil.cam.core.LicenseState

/** Personal (sideloaded) build: nothing to buy. */
class StoreLicense(@Suppress("UNUSED_PARAMETER") context: Context) : License {
    override val state = LicenseState.LICENSED
    override val price: String? = null
    override val reason: String? = null
    override var onChange: (() -> Unit)? = null
    override fun start() {}
    override fun refresh() {}
    override fun buy(activity: Activity) {}
    override fun stop() {}
}
