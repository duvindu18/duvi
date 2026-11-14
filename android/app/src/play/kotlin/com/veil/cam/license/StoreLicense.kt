package com.veil.cam.license

import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.android.billingclient.api.AcknowledgePurchaseParams
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import com.veil.cam.BuildConfig
import com.veil.cam.core.CertFingerprint
import com.veil.cam.core.LicenseCache
import com.veil.cam.core.LicensePolicy
import com.veil.cam.core.LicenseState
import com.veil.cam.core.PlayAnswer
import com.veil.cam.core.PurchaseSignature

/**
 * One-time purchase through Google Play Billing.
 *
 * - The purchase must carry a valid signature from this app's Play licence key
 *   (BuildConfig.LICENSE_KEY), checked on the phone, and be acknowledged.
 * - Play is asked again on every start, on resume, and whenever a network comes up, so a
 *   refund or a revoked purchase locks capture again as soon as the phone is online.
 * - Offline, a purchase verified within the last 30 days keeps working.
 * - A copy re-signed with another key (a modified APK) is never licensed
 *   (BuildConfig.SIGNING_SHA256: the Play app signing certificate).
 *
 * No network permission is needed: Play Store does the talking to Google.
 */
class StoreLicense(context: Context) : License {
    private val app = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val prefs = app.getSharedPreferences("veil_license", Context.MODE_PRIVATE)
    private var answer: PlayAnswer? = null
    private var details: ProductDetails? = null
    private val signingOk: Boolean by lazy { checkSigning() }

    override var state = LicenseState.CHECKING
        private set
    override var price: String? = null
        private set
    override var reason: String? = null
        private set
    override var onChange: (() -> Unit)? = null

    private val client: BillingClient = BillingClient.newBuilder(app)
        .setListener { result, purchases -> main.post { onPurchases(result, purchases) } }
        .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
        .enableAutoServiceReconnection()
        .build()

    private val network = object : ConnectivityManager.NetworkCallback() {
        override fun onCapabilitiesChanged(n: Network, caps: NetworkCapabilities) {
            if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) main.post { refresh() }
        }
    }
    private var watching = false

    override fun start() {
        update()
        connect()
        if (!watching) {
            runCatching { app.getSystemService(ConnectivityManager::class.java)?.registerDefaultNetworkCallback(network); watching = true }
        }
    }

    override fun stop() {
        if (watching) { runCatching { app.getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(network) }; watching = false }
    }

    private fun connect() {
        if (client.isReady) { query(); return }
        client.startConnection(object : BillingClientStateListener {
            override fun onBillingSetupFinished(r: BillingResult) {
                main.post {
                    if (r.responseCode == BillingClient.BillingResponseCode.OK) query()
                    else { answer = PlayAnswer.Unavailable; update(playError(r)) }
                }
            }
            override fun onBillingServiceDisconnected() {} // auto-reconnects
        })
    }

    override fun refresh() = connect()

    private fun query() {
        client.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.INAPP).build()) { r, list ->
            main.post {
                if (r.responseCode == BillingClient.BillingResponseCode.OK) handle(list) else { answer = PlayAnswer.Unavailable; update(playError(r)) }
            }
        }
        if (details == null) {
            val product = QueryProductDetailsParams.Product.newBuilder().setProductId(PRODUCT_ID).setProductType(BillingClient.ProductType.INAPP).build()
            client.queryProductDetailsAsync(QueryProductDetailsParams.newBuilder().setProductList(listOf(product)).build()) { r, res ->
                main.post {
                    if (r.responseCode == BillingClient.BillingResponseCode.OK) {
                        details = res.productDetailsList.firstOrNull()
                        price = details?.oneTimePurchaseOfferDetails?.formattedPrice
                        onChange?.invoke()
                    }
                }
            }
        }
    }

    private fun onPurchases(r: BillingResult, list: List<Purchase>?) {
        when (r.responseCode) {
            BillingClient.BillingResponseCode.OK -> handle(list ?: emptyList())
            BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED -> refresh()
            BillingClient.BillingResponseCode.USER_CANCELED -> {}
            else -> update(playError(r))
        }
    }

    /** The account's purchases of this app (the whole list Play holds, not just new ones). */
    private fun handle(purchases: List<Purchase>) {
        val mine = purchases.filter { PRODUCT_ID in it.products && it.packageName == app.packageName }
        val bought = mine.firstOrNull { it.purchaseState == Purchase.PurchaseState.PURCHASED }
        answer = when {
            bought != null -> PlayAnswer.Owned(PurchaseSignature.verify(BuildConfig.LICENSE_KEY, bought.originalJson, bought.signature))
            mine.any { it.purchaseState == Purchase.PurchaseState.PENDING } -> PlayAnswer.Pending
            else -> PlayAnswer.NotOwned
        }
        if (bought != null && (answer as PlayAnswer.Owned).signatureValid && !bought.isAcknowledged) {
            // Unacknowledged purchases are refunded by Play after three days.
            client.acknowledgePurchase(AcknowledgePurchaseParams.newBuilder().setPurchaseToken(bought.purchaseToken).build()) { ar ->
                if (ar.responseCode != BillingClient.BillingResponseCode.OK) Log.w(TAG, "acknowledge: ${ar.debugMessage}")
            }
        }
        update()
    }

    private fun update(error: String? = null) {
        val now = System.currentTimeMillis()
        val cache = if (prefs.contains("at")) LicenseCache(prefs.getBoolean("ok", false), prefs.getLong("at", 0)) else null
        val s = LicensePolicy.decide(cache, answer, signingOk, now)
        when (answer) {
            is PlayAnswer.Owned, PlayAnswer.NotOwned -> prefs.edit().putBoolean("ok", s == LicenseState.LICENSED).putLong("at", now).apply()
            else -> {}
        }
        state = s
        reason = when {
            s == LicenseState.LICENSED -> null
            !signingOk -> "This copy of the app was modified. Install Veil Cam from Google Play."
            BuildConfig.LICENSE_KEY.isBlank() -> "Purchase checking is not configured in this build."
            answer is PlayAnswer.Owned -> "The purchase could not be verified. Reinstall from Google Play."
            s == LicenseState.PENDING -> "Your payment is pending. Capture unlocks as soon as Google Play confirms it."
            s == LicenseState.CHECKING -> "Checking your purchase…"
            answer == PlayAnswer.Unavailable && cache?.licensed == true -> "Connect to the internet once so Google Play can confirm your purchase."
            error != null -> error
            else -> null
        }
        onChange?.invoke()
    }

    override fun buy(activity: Activity) {
        val d = details
        if (d == null) { refresh(); update("Google Play is not reachable. Check the connection and try again."); return }
        val params = BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(d).build()
        val r = client.launchBillingFlow(activity, BillingFlowParams.newBuilder().setProductDetailsParamsList(listOf(params)).build())
        if (r.responseCode != BillingClient.BillingResponseCode.OK) update(playError(r))
    }

    private fun playError(r: BillingResult) = when (r.responseCode) {
        BillingClient.BillingResponseCode.SERVICE_UNAVAILABLE, BillingClient.BillingResponseCode.NETWORK_ERROR -> "Google Play is not reachable right now."
        BillingClient.BillingResponseCode.BILLING_UNAVAILABLE -> "Google Play billing is not available on this phone or account."
        else -> "Google Play: ${r.debugMessage.ifBlank { "error ${r.responseCode}" }}"
    }

    @Suppress("DEPRECATION")
    private fun checkSigning(): Boolean {
        if (BuildConfig.SIGNING_SHA256.isBlank()) return true
        return try {
            val info = app.packageManager.getPackageInfo(app.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
            val si = info.signingInfo ?: return false
            val certs = (if (si.hasMultipleSigners()) si.apkContentsSigners else si.signingCertificateHistory).map { it.toByteArray() }
            CertFingerprint.matches(BuildConfig.SIGNING_SHA256, certs)
        } catch (e: Exception) {
            false
        }
    }

    companion object {
        private const val TAG = "VeilLicense"
        /** Play Console > Monetize > Products > One-time products: create it with this ID. */
        const val PRODUCT_ID = "veil_cam_unlock"
    }
}
