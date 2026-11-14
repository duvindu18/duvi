package com.veil.cam.core

import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.awt.image.BufferedImage
import java.io.File
import javax.imageio.ImageIO
import kotlin.math.abs
import kotlin.math.floor

/**
 * Runs the Kotlin SCRFD port on real photos and compares with the desktop
 * (Python) results. Needs VEIL_TEST_FIXTURES (canvases + expected.json) and
 * VEIL_TEST_MODEL (det_500m.onnx); skipped otherwise, so no photos live in the repo.
 */
class RealModelTest {
    private val fixtures = System.getenv("VEIL_TEST_FIXTURES")?.let(::File)
    private val model = System.getenv("VEIL_TEST_MODEL")?.let(::File)

    private fun session(): Pair<OrtEnvironment, OrtSession> {
        val env = OrtEnvironment.getEnvironment()
        val opts = OrtSession.SessionOptions().apply { setSessionLogLevel(ai.onnxruntime.OrtLoggingLevel.ORT_LOGGING_LEVEL_ERROR) }
        return env to env.createSession(model!!.path, opts)
    }

    private fun rgb(img: BufferedImage): ByteArray {
        val out = ByteArray(img.width * img.height * 3)
        var i = 0
        for (y in 0 until img.height) for (x in 0 until img.width) {
            val p = img.getRGB(x, y)
            out[i++] = (p shr 16).toByte(); out[i++] = (p shr 8).toByte(); out[i++] = p.toByte()
        }
        return out
    }

    @Test fun matchesDesktopDetector() {
        assumeTrue(fixtures?.isDirectory == true && model?.isFile == true)
        val (env, s) = session()
        val scrfd = Scrfd(s, env)
        val expected = File(fixtures, "expected.json").readText()
        for (name in listOf("db9976e5-image_canvas.png", "c459675f-image_canvas.png")) {
            val img = ImageIO.read(File(fixtures, name))
            val dets = scrfd.detect(rgb(img), img.width, img.height, 3, 0.35f)
            val exp = Regex("\"$name\": \\[\\[([^]]*)]").find(expected)!!.groupValues[1].split(",").map { it.trim().toFloat() }
            assertEquals(name, 1, dets.size)
            for (k in 0 until 4) assertEquals("$name coord $k", exp[k], dets[0].bbox[k], 1.5f)
            assertEquals(exp[4], dets[0].score, 0.02f)
        }
    }

    @Test fun tiltedFaceFoundByRotatedPassesWithTrueOrientation() {
        assumeTrue(fixtures?.isDirectory == true && model?.isFile == true)
        val (env, s) = session()
        val scrfd = Scrfd(s, env)
        val src = ImageIO.read(File(fixtures, "db9976e5-image_canvas.png"))
        for (tilt in listOf(0.0, 60.0, 120.0, 180.0, -100.0)) {
            val img = RealModelTestSupport.rotate(src, tilt)
            val mad = MultiAngleDetector(Angles.FULL, 2) { p, th -> scrfd.detect(p.pixels, p.spec.width, p.spec.height, p.channels, th) }
            val base = PassPlanner.base(img.width, img.height, 0.0, 480)
            val specs = listOf(base) +
                mad.nextPlan().map { PassPlanner.rotated(img.width, img.height, 0.0, it, PassPlanner.scaleOf(base)) }
            val faces = mad.run(specs.map { RealModelTestSupport.render(img, it) }, img.width, img.height, 0.35f)
                .filter { it.score > 0.5f && it.width > 25 }
            assertTrue("tilt $tilt: no face", faces.isNotEmpty())
            println("tilt $tilt: " + faces.joinToString { "s=%.2f roll=%.0f g=%.0f box=%s".format(it.score, FaceGeometry.landmarkRoll(it.kps), it.geom?.angle, it.bbox.joinToString(",") { v -> "%.0f".format(v) }) })
            val roll = FaceGeometry.landmarkRoll(faces[0].kps)!!
            // Screen-clockwise tilt shows up as the same roll of the landmarks.
            var diff = (roll - tilt.toFloat() + 540f) % 360f - 180f
            if (tilt == 0.0) diff = roll
            assertTrue("tilt $tilt: landmark roll $roll", abs(diff) < 25f)
        }
    }
}

/** CPU stand-ins for the GPU pass renderer, shared by the real-model tests. */
object RealModelTestSupport {
    /** CPU stand-in for the GPU pass renderer: bilinear warp of the frame by the pass transform. */
    fun render(img: BufferedImage, spec: PassSpec): PassImage {
        val inv = spec.toCanvas.inverse()
        val px = ByteArray(spec.width * spec.height * 3)
        for (y in 0 until spec.height) for (x in 0 until spec.width) {
            val sx = inv.mapX(x + 0.5, y + 0.5) - 0.5
            val sy = inv.mapY(x + 0.5, y + 0.5) - 0.5
            val o = (y * spec.width + x) * 3
            if (sx < 0 || sy < 0 || sx > img.width - 1 || sy > img.height - 1) continue
            val x0 = floor(sx).toInt(); val y0 = floor(sy).toInt()
            val x1 = minOf(x0 + 1, img.width - 1); val y1 = minOf(y0 + 1, img.height - 1)
            val fx = sx - x0; val fy = sy - y0
            for (c in 0 until 3) {
                val sh = 16 - 8 * c
                fun v(xx: Int, yy: Int) = (img.getRGB(xx, yy) shr sh) and 0xFF
                val top = v(x0, y0) * (1 - fx) + v(x1, y0) * fx
                val bot = v(x0, y1) * (1 - fx) + v(x1, y1) * fx
                px[o + c] = (top * (1 - fy) + bot * fy).toInt().toByte()
            }
        }
        return PassImage(spec, px, 3, false)
    }

    fun rotate(img: BufferedImage, deg: Double): BufferedImage {
        val out = BufferedImage(img.width, img.height, BufferedImage.TYPE_INT_RGB)
        val g = out.createGraphics()
        g.setRenderingHint(java.awt.RenderingHints.KEY_INTERPOLATION, java.awt.RenderingHints.VALUE_INTERPOLATION_BILINEAR)
        g.rotate(Math.toRadians(deg), img.width / 2.0, img.height / 2.0)
        g.drawImage(img, 0, 0, null)
        g.dispose()
        return out
    }

}
