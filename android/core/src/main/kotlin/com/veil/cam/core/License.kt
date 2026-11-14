package com.veil.cam.core

import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.Base64

/** Whether this copy may capture: the one-time purchase is verified, pending, or missing. */
enum class LicenseState { CHECKING, LICENSED, PENDING, UNLICENSED }

/** The last purchase this install verified (kept on the phone for offline use). */
data class LicenseCache(val licensed: Boolean, val verifiedAtMs: Long)

/** What Google Play said about the purchase just now. */
sealed class PlayAnswer {
    /** Play returned the purchase; [signatureValid] says if it is signed with this app's key. */
    data class Owned(val signatureValid: Boolean) : PlayAnswer()
    /** Play answered and the account does not own it (never bought, refunded or revoked). */
    object NotOwned : PlayAnswer()
    /** Bought, payment not settled yet (e.g. cash at a shop). */
    object Pending : PlayAnswer()
    /** Play could not be asked (no Play Store, service down, blocked). */
    object Unavailable : PlayAnswer()
}

object LicensePolicy {
    /** Without any answer from Play, a verified purchase keeps working this long. */
    const val OFFLINE_GRACE_MS = 30L * 24 * 3600 * 1000
    private const val CLOCK_SLACK_MS = 24L * 3600 * 1000

    /**
     * [answer] null: Play has not answered yet this session. [signingOk]: this APK is
     * signed with the app's Play signing certificate (false for a re-signed copy).
     */
    fun decide(cache: LicenseCache?, answer: PlayAnswer?, signingOk: Boolean, nowMs: Long): LicenseState {
        if (!signingOk) return LicenseState.UNLICENSED
        return when (answer) {
            is PlayAnswer.Owned -> if (answer.signatureValid) LicenseState.LICENSED else LicenseState.UNLICENSED
            PlayAnswer.NotOwned -> LicenseState.UNLICENSED
            PlayAnswer.Pending -> LicenseState.PENDING
            PlayAnswer.Unavailable, null -> {
                val fresh = cache != null && cache.licensed && cacheValid(cache, nowMs)
                when {
                    fresh -> LicenseState.LICENSED
                    answer == null -> LicenseState.CHECKING
                    else -> LicenseState.UNLICENSED
                }
            }
        }
    }

    /** Within the offline grace, and not "verified in the future" (a clock set back). */
    fun cacheValid(c: LicenseCache, nowMs: Long): Boolean =
        c.verifiedAtMs <= nowMs + CLOCK_SLACK_MS && nowMs - c.verifiedAtMs < OFFLINE_GRACE_MS
}

/** Google Play purchase signatures: SHA1withRSA over the purchase JSON, with the app's public key. */
object PurchaseSignature {
    fun verify(base64PublicKey: String, signedData: String, base64Signature: String): Boolean = try {
        if (base64PublicKey.isBlank() || base64Signature.isBlank()) false else {
            val key = KeyFactory.getInstance("RSA").generatePublic(X509EncodedKeySpec(Base64.getDecoder().decode(base64PublicKey.trim())))
            Signature.getInstance("SHA1withRSA").run {
                initVerify(key)
                update(signedData.toByteArray(Charsets.UTF_8))
                verify(Base64.getDecoder().decode(base64Signature.trim()))
            }
        }
    } catch (e: Exception) {
        false
    }
}

/** Signing certificate fingerprints as Play Console shows them ("AB:CD:..." or plain hex). */
object CertFingerprint {
    fun normalize(s: String) = s.filter { it.isLetterOrDigit() }.uppercase()
    fun sha256(cert: ByteArray): String = java.security.MessageDigest.getInstance("SHA-256").digest(cert).joinToString("") { "%02X".format(it) }
    fun matches(expected: String, certs: List<ByteArray>): Boolean {
        val want = normalize(expected)
        return want.isEmpty() || certs.any { sha256(it) == want }
    }
}
