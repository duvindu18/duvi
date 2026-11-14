package com.veil.cam.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.KeyPairGenerator
import java.security.Signature
import java.util.Base64

class LicenseTest {
    private val day = 24L * 3600 * 1000
    private val now = 1_800_000_000_000L

    @Test fun playAnswerWins() {
        val cached = LicenseCache(true, now - day)
        assertEquals(LicenseState.LICENSED, LicensePolicy.decide(null, PlayAnswer.Owned(true), true, now))
        assertEquals(LicenseState.UNLICENSED, LicensePolicy.decide(cached, PlayAnswer.Owned(false), true, now)) // forged
        assertEquals(LicenseState.UNLICENSED, LicensePolicy.decide(cached, PlayAnswer.NotOwned, true, now))     // refunded
        assertEquals(LicenseState.PENDING, LicensePolicy.decide(null, PlayAnswer.Pending, true, now))
    }

    @Test fun offlineUsesTheVerifiedPurchaseForAMonth() {
        assertEquals(LicenseState.LICENSED, LicensePolicy.decide(LicenseCache(true, now - 29 * day), PlayAnswer.Unavailable, true, now))
        assertEquals(LicenseState.UNLICENSED, LicensePolicy.decide(LicenseCache(true, now - 31 * day), PlayAnswer.Unavailable, true, now))
        assertEquals(LicenseState.UNLICENSED, LicensePolicy.decide(null, PlayAnswer.Unavailable, true, now))
        assertEquals(LicenseState.CHECKING, LicensePolicy.decide(null, null, true, now))
        assertEquals(LicenseState.LICENSED, LicensePolicy.decide(LicenseCache(true, now - day), null, true, now))
        // A clock set back does not stretch the grace.
        assertEquals(LicenseState.UNLICENSED, LicensePolicy.decide(LicenseCache(true, now + 40 * day), PlayAnswer.Unavailable, true, now))
    }

    @Test fun resignedCopyIsNeverLicensed() {
        assertEquals(LicenseState.UNLICENSED, LicensePolicy.decide(LicenseCache(true, now), PlayAnswer.Owned(true), false, now))
    }

    @Test fun purchaseSignature() {
        val kp = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.genKeyPair()
        val pub = Base64.getEncoder().encodeToString(kp.public.encoded)
        val json = """{"orderId":"GPA.1234","packageName":"com.veil.cam","productId":"veil_cam_unlock","purchaseState":0}"""
        val sig = Base64.getEncoder().encodeToString(Signature.getInstance("SHA1withRSA").run { initSign(kp.private); update(json.toByteArray()); sign() })
        assertTrue(PurchaseSignature.verify(pub, json, sig))
        assertFalse(PurchaseSignature.verify(pub, json.replace("0}", "1}"), sig))
        assertFalse(PurchaseSignature.verify("", json, sig))
        assertFalse(PurchaseSignature.verify(pub, json, "bm90IGEgc2lnbmF0dXJl"))
        val other = Base64.getEncoder().encodeToString(KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.genKeyPair().public.encoded)
        assertFalse(PurchaseSignature.verify(other, json, sig))
    }

    @Test fun certificateFingerprints() {
        val cert = "certificate".toByteArray()
        val hex = CertFingerprint.sha256(cert)
        val colons = hex.chunked(2).joinToString(":").lowercase()
        assertTrue(CertFingerprint.matches(colons, listOf(cert)))
        assertTrue(CertFingerprint.matches("", listOf(cert))) // not configured: skipped
        assertFalse(CertFingerprint.matches(colons, listOf("other".toByteArray())))
    }
}
