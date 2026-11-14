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
import kotlin.math.max
import kotlin.math.min

/**
 * The Play build's detector (YuNet, MIT) on real photos: the same faces as the desktop
 * SCRFD reference, and tilted faces through the multi-angle pipeline. Needs
 * VEIL_TEST_FIXTURES and VEIL_TEST_YUNET (face_yunet_2023mar_dyn.onnx); skipped otherwise.
 */
class YuNetTest {
    private val fixtures = System.getenv("VEIL_TEST_FIXTURES")?.let(::File)
    private val model = System.getenv("VEIL_TEST_YUNET")?.let(::File)

    private fun yunet(): YuNet {
        val env = OrtEnvironment.getEnvironment()
        val opts = OrtSession.SessionOptions().apply { setSessionLogLevel(ai.onnxruntime.OrtLoggingLevel.ORT_LOGGING_LEVEL_ERROR) }
        return YuNet(env.createSession(model!!.path, opts), env)
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

    private fun iou(a: FloatArray, b: List<Float>): Float {
        val iw = max(0f, min(a[2], b[2]) - max(a[0], b[0])); val ih = max(0f, min(a[3], b[3]) - max(a[1], b[1]))
        val i = iw * ih
        return i / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i)
    }

    @Test fun findsTheSameFacesAsTheReference() {
        assumeTrue(fixtures?.isDirectory == true && model?.isFile == true)
        val det = yunet()
        val expected = File(fixtures, "expected.json").readText()
        for (name in listOf("db9976e5-image_canvas.png", "c459675f-image_canvas.png")) {
            val img = ImageIO.read(File(fixtures, name))
            val dets = det.detect(rgb(img), img.width, img.height, 3, 0.35f).filter { it.score >= 0.5f }
            val exp = Regex("\"$name\": \\[\\[([^]]*)]").find(expected)!!.groupValues[1].split(",").map { it.trim().toFloat() }
            println("$name: " + dets.joinToString { "s=%.2f %s".format(it.score, it.bbox.joinToString(",") { v -> "%.0f".format(v) }) })
            assertEquals(name, 1, dets.size)
            assertTrue("$name IoU ${iou(dets[0].bbox, exp)}", iou(dets[0].bbox, exp) > 0.55f)
            val k = dets[0].kps!!
            assertTrue("$name: first landmark is the image-left eye", k[0] < k[2])
        }
    }

    @Test fun tiltedFacesThroughTheMultiAnglePipeline() {
        assumeTrue(fixtures?.isDirectory == true && model?.isFile == true)
        val det = yunet()
        val src = ImageIO.read(File(fixtures, "db9976e5-image_canvas.png"))
        for (tilt in listOf(0.0, 60.0, 120.0, 180.0, -100.0)) {
            val img = RealModelTestSupport.rotate(src, tilt)
            val mad = MultiAngleDetector(Angles.FULL, 2) { p, th -> det.detect(p.pixels, p.spec.width, p.spec.height, p.channels, th) }
            // The app's canvas is downscaled from a larger camera frame; never upscale the small fixture.
            val base = PassPlanner.base(img.width, img.height, 0.0, maxOf(img.width, img.height))
            val specs = listOf(base) + mad.nextPlan().map { PassPlanner.rotated(img.width, img.height, 0.0, it, PassPlanner.scaleOf(base)) }
            val faces = mad.run(specs.map { RealModelTestSupport.render(img, it) }, img.width, img.height, 0.35f)
                .filter { it.score > 0.5f && it.width > 25 }
            assertTrue("tilt $tilt: no face", faces.isNotEmpty())
            val roll = FaceGeometry.landmarkRoll(faces[0].kps)!!
            var diff = (roll - tilt.toFloat() + 540f) % 360f - 180f
            if (tilt == 0.0) diff = roll
            println("tilt $tilt: " + faces.joinToString { "s=%.2f roll=%.0f g=%.0f box=%s".format(it.score, FaceGeometry.landmarkRoll(it.kps), it.geom?.angle, it.bbox.joinToString(",") { v -> "%.0f".format(v) }) })
            // What the blur uses: the shape's angle (from the rotated pass, turned by a quarter
            // when the landmarks say the face lies sideways). It must follow the face.
            val g = faces[0].geom!!.angle
            var gd = (g - tilt.toFloat() + 540f) % 360f - 180f
            if (tilt == 0.0) gd = g
            assertTrue("tilt $tilt: blur shape angle $g", abs(gd) <= 30f)
            assertTrue("tilt $tilt: landmark roll $roll", abs(diff) < 30f)
        }
    }

    @Test fun calibrationIsMonotonicAndKeepsTheThresholds() {
        var prev = -1f
        for (i in 0..100) { val v = YuNet.calibrate(i / 100f); assertTrue(v >= prev); prev = v }
        assertEquals(0.35f, YuNet.calibrate(0.5f), 1e-5f)
        assertEquals(0.5f, YuNet.calibrate(0.7f), 1e-5f)
        assertEquals(0.95f, YuNet.calibrate(1f), 1e-5f)
    }
}
