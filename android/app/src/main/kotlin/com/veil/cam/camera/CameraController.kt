package com.veil.cam.camera

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Rect
import android.graphics.SurfaceTexture
import android.hardware.camera2.CameraAccessException
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CameraMetadata
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.CaptureResult
import android.hardware.camera2.TotalCaptureResult
import android.hardware.camera2.params.MeteringRectangle
import android.hardware.camera2.params.OutputConfiguration
import android.hardware.camera2.params.SessionConfiguration
import android.hardware.camera2.params.TonemapCurve
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import android.util.Range
import android.util.Size
import android.view.Surface
import com.veil.cam.Settings
import com.veil.cam.core.FlatProfile
import java.util.concurrent.Executor
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** What one camera can do. */
data class CameraCaps(
    val id: String,
    val front: Boolean,
    val sensorOrientation: Int,
    val label: String,
    val focalMm: Float,
    val sizes: List<Size>, // SurfaceTexture output sizes, largest first
    val fpsRanges: List<Range<Int>>,
    val isoRange: Range<Int>?,
    val exposureRange: Range<Long>?,
    val manualSensor: Boolean,
    val evRange: Range<Int>,
    val evStep: Float,
    val minFocusDiopters: Float, // 0 = fixed focus
    val zoomRange: Range<Float>,
    val usesZoomRatio: Boolean,
    val activeArray: Rect,
    val ois: Boolean,
    val eis: Boolean,
    val previewStabilization: Boolean,
    val awbModes: IntArray,
    val maxAfRegions: Int,
    val maxAeRegions: Int,
    val toneCurve: Boolean,
    val bootTimeTimestamps: Boolean, // frame timestamps on CLOCK_BOOTTIME (else monotonic)
    val flash: Boolean = false, // has a torch
) {
    fun supportsFps(fps: Int) = fpsRanges.any { it.upper == fps }
}

/** Live values reported by the camera (for the status bar in auto modes). */
data class CameraReadout(val iso: Int, val exposureNs: Long, val focusDiopters: Float, val afLocked: Boolean)

class CameraController(context: Context) {
    private val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
    private val thread = HandlerThread("Camera").apply { start() }
    val handler = Handler(thread.looper)
    private val executor = Executor { handler.post(it) }

    private var device: CameraDevice? = null
    private var session: CameraCaptureSession? = null
    private var surface: Surface? = null
    var caps: CameraCaps? = null
        private set
    private var settings = Settings()
    private var focusRegion: MeteringRectangle? = null
    private var triggerAf = false
    private var streamSize = Size(1920, 1080)

    var onReadout: ((CameraReadout) -> Unit)? = null
    var onError: ((String) -> Unit)? = null
    var onOpened: (() -> Unit)? = null

    fun cameras(): List<CameraCaps> = try {
        manager.cameraIdList.mapNotNull { id -> runCatching { capsOf(id) }.getOrNull() }
            .filter { it.sizes.isNotEmpty() }
            .sortedWith(compareBy<CameraCaps> { it.front }.thenBy { it.focalMm })
    } catch (e: CameraAccessException) {
        emptyList()
    }

    private fun capsOf(id: String): CameraCaps {
        val c = manager.getCameraCharacteristics(id)
        val facing = c.get(CameraCharacteristics.LENS_FACING)
        val map = c.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)!!
        val sizes = map.getOutputSizes(SurfaceTexture::class.java).orEmpty()
            .filter { it.width * 9 == it.height * 16 && it.width in 1280..3840 }
            .distinct().sortedByDescending { it.width * it.height }
        val capsList = c.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES) ?: IntArray(0)
        val manual = capsList.contains(CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR)
        val focal = c.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)?.firstOrNull() ?: 4f
        val zoomRange: Range<Float>
        val usesRatio: Boolean
        if (Build.VERSION.SDK_INT >= 30 && c.get(CameraCharacteristics.CONTROL_ZOOM_RATIO_RANGE) != null) {
            zoomRange = c.get(CameraCharacteristics.CONTROL_ZOOM_RATIO_RANGE)!!
            usesRatio = true
        } else {
            zoomRange = Range(1f, c.get(CameraCharacteristics.SCALER_AVAILABLE_MAX_DIGITAL_ZOOM) ?: 1f)
            usesRatio = false
        }
        val ois = c.get(CameraCharacteristics.LENS_INFO_AVAILABLE_OPTICAL_STABILIZATION)?.contains(CameraMetadata.LENS_OPTICAL_STABILIZATION_MODE_ON) == true
        val stab = c.get(CameraCharacteristics.CONTROL_AVAILABLE_VIDEO_STABILIZATION_MODES) ?: IntArray(0)
        val front = facing == CameraMetadata.LENS_FACING_FRONT
        val tone = c.get(CameraCharacteristics.TONEMAP_AVAILABLE_TONE_MAP_MODES)?.contains(CameraMetadata.TONEMAP_MODE_CONTRAST_CURVE) == true
        val label = when {
            front -> "Front"
            else -> "Back · ${"%.1f".format(focal)} mm"
        }
        val evStep = c.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_STEP)?.toFloat() ?: 0.333f
        return CameraCaps(
            id = id, front = front, sensorOrientation = c.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 90,
            label = label, focalMm = focal, sizes = sizes,
            fpsRanges = c.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES)?.toList() ?: listOf(Range(30, 30)),
            isoRange = c.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE),
            exposureRange = c.get(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE),
            manualSensor = manual,
            evRange = c.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_RANGE) ?: Range(0, 0),
            evStep = evStep,
            minFocusDiopters = c.get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE) ?: 0f,
            zoomRange = zoomRange, usesZoomRatio = usesRatio,
            activeArray = c.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE) ?: Rect(0, 0, 4000, 3000),
            ois = ois,
            eis = stab.contains(CameraMetadata.CONTROL_VIDEO_STABILIZATION_MODE_ON),
            previewStabilization = Build.VERSION.SDK_INT >= 33 && stab.contains(CameraMetadata.CONTROL_VIDEO_STABILIZATION_MODE_PREVIEW_STABILIZATION),
            awbModes = c.get(CameraCharacteristics.CONTROL_AWB_AVAILABLE_MODES) ?: intArrayOf(CameraMetadata.CONTROL_AWB_MODE_AUTO),
            maxAfRegions = c.get(CameraCharacteristics.CONTROL_MAX_REGIONS_AF) ?: 0,
            maxAeRegions = c.get(CameraCharacteristics.CONTROL_MAX_REGIONS_AE) ?: 0,
            toneCurve = tone,
            bootTimeTimestamps = c.get(CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE) == CameraMetadata.SENSOR_INFO_TIMESTAMP_SOURCE_REALTIME,
            flash = c.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true,
        )
    }

    @SuppressLint("MissingPermission")
    fun open(c: CameraCaps, target: Surface, size: Size, s: Settings) {
        handler.post {
            closeInternal()
            caps = c
            surface = target
            streamSize = size
            settings = s
            focusRegion = null
            try {
                manager.openCamera(c.id, executor, object : CameraDevice.StateCallback() {
                    override fun onOpened(d: CameraDevice) {
                        device = d
                        createSession(d)
                    }

                    override fun onDisconnected(d: CameraDevice) {
                        d.close()
                        if (device === d) device = null
                        onError?.invoke("Camera disconnected")
                    }

                    override fun onError(d: CameraDevice, error: Int) {
                        d.close()
                        if (device === d) device = null
                        onError?.invoke("Camera error $error")
                    }
                })
            } catch (e: Exception) {
                Log.e(TAG, "open failed", e)
                onError?.invoke("Cannot open camera: ${e.message}")
            }
        }
    }

    private fun createSession(d: CameraDevice) {
        val out = OutputConfiguration(surface!!)
        val cfg = SessionConfiguration(SessionConfiguration.SESSION_REGULAR, listOf(out), executor, object : CameraCaptureSession.StateCallback() {
            override fun onConfigured(s: CameraCaptureSession) {
                session = s
                submit()
                onOpened?.invoke()
            }

            override fun onConfigureFailed(s: CameraCaptureSession) {
                onError?.invoke("This resolution / frame rate is not supported by this camera")
            }
        })
        try {
            d.createCaptureSession(cfg)
        } catch (e: Exception) {
            onError?.invoke("Camera session failed: ${e.message}")
        }
    }

    fun update(s: Settings) {
        handler.post {
            settings = s
            submit()
        }
    }

    /** Tap to focus / meter at a point of the sensor's visible area (normalized, sensor orientation). */
    fun focusAt(sensorX: Float, sensorY: Float) {
        handler.post {
            val c = caps ?: return@post
            val crop = visibleArea(c)
            val cx = crop.left + sensorX.coerceIn(0f, 1f) * crop.width()
            val cy = crop.top + sensorY.coerceIn(0f, 1f) * crop.height()
            val half = (min(crop.width(), crop.height()) * 0.08f).toInt().coerceAtLeast(20)
            val r = Rect((cx - half).toInt(), (cy - half).toInt(), (cx + half).toInt(), (cy + half).toInt())
            if (!r.intersect(c.activeArray)) return@post
            focusRegion = MeteringRectangle(r, MeteringRectangle.METERING_WEIGHT_MAX - 1)
            triggerAf = true
            submit()
        }
    }

    @Volatile private var focusOverride = Float.NaN
    private val overridePending = java.util.concurrent.atomic.AtomicBoolean(false)

    /**
     * Drive the lens directly (A-B focus pulls), in diopters, or null to hand focus back
     * to the settings. Calls faster than the camera can take them collapse into one.
     */
    fun setFocusOverride(diopters: Float?) {
        focusOverride = diopters ?: Float.NaN
        if (overridePending.compareAndSet(false, true)) handler.post { overridePending.set(false); submit() }
    }

    fun resetFocus() {
        handler.post { focusRegion = null; submit() }
    }

    /**
     * Area of the active array that the stream shows: zoom crops the centre, then
     * the stream aspect crops it. Returned in active-array coordinates.
     */
    private fun visibleArea(c: CameraCaps): Rect {
        val a = c.activeArray
        val zoom = settings.zoom.coerceIn(c.zoomRange.lower, c.zoomRange.upper).coerceAtLeast(1f)
        var w = a.width() / zoom
        var h = a.height() / zoom
        val aspect = streamSize.width.toFloat() / streamSize.height
        if (w / h > aspect) w = h * aspect else h = w / aspect
        val cx = a.exactCenterX(); val cy = a.exactCenterY()
        return Rect((cx - w / 2).toInt(), (cy - h / 2).toInt(), (cx + w / 2).toInt(), (cy + h / 2).toInt())
    }

    private fun submit() {
        val d = device ?: return
        val sess = session ?: return
        val c = caps ?: return
        val s = settings
        try {
            val b = d.createCaptureRequest(CameraDevice.TEMPLATE_RECORD)
            b.addTarget(surface!!)
            // Frame rate: a fixed range when the camera offers one.
            val fixed = c.fpsRanges.firstOrNull { it.lower == s.fps && it.upper == s.fps }
            val range = fixed ?: c.fpsRanges.filter { it.upper == s.fps }.maxByOrNull { it.lower }
                ?: c.fpsRanges.minByOrNull { abs(it.upper - s.fps) }
            range?.let { b.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, it) }
            b.set(CaptureRequest.CONTROL_MODE, CameraMetadata.CONTROL_MODE_AUTO)

            // Exposure
            val frameNs = 1_000_000_000L / max(1, s.fps)
            if (!s.autoExposure && c.manualSensor && c.isoRange != null && c.exposureRange != null) {
                b.set(CaptureRequest.CONTROL_AE_MODE, CameraMetadata.CONTROL_AE_MODE_OFF)
                b.set(CaptureRequest.SENSOR_SENSITIVITY, s.iso.coerceIn(c.isoRange.lower, c.isoRange.upper))
                val exp = s.shutterNs.coerceIn(c.exposureRange.lower, min(c.exposureRange.upper, frameNs))
                b.set(CaptureRequest.SENSOR_EXPOSURE_TIME, exp)
                b.set(CaptureRequest.SENSOR_FRAME_DURATION, frameNs)
            } else {
                b.set(CaptureRequest.CONTROL_AE_MODE, CameraMetadata.CONTROL_AE_MODE_ON)
                b.set(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION, s.ev.coerceIn(c.evRange.lower, c.evRange.upper))
                b.set(CaptureRequest.CONTROL_AE_LOCK, s.aeLock)
            }
            b.set(CaptureRequest.CONTROL_AE_ANTIBANDING_MODE, CameraMetadata.CONTROL_AE_ANTIBANDING_MODE_AUTO)
            if (c.flash) b.set(CaptureRequest.FLASH_MODE, if (s.torch) CameraMetadata.FLASH_MODE_TORCH else CameraMetadata.FLASH_MODE_OFF)

            // White balance: the camera uses the nearest preset; the renderer corrects the rest.
            if (s.autoWb) {
                b.set(CaptureRequest.CONTROL_AWB_MODE, CameraMetadata.CONTROL_AWB_MODE_AUTO)
                b.set(CaptureRequest.CONTROL_AWB_LOCK, s.awbLock)
            } else {
                val (mode, _) = WhiteBalance.preset(s.kelvin, c.awbModes)
                b.set(CaptureRequest.CONTROL_AWB_MODE, mode)
            }

            // Focus
            val region = focusRegion
            val forced = focusOverride
            if (!forced.isNaN() && c.minFocusDiopters > 0f) {
                b.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_OFF)
                b.set(CaptureRequest.LENS_FOCUS_DISTANCE, forced.coerceIn(0f, c.minFocusDiopters))
            } else if (!s.autoFocus && c.minFocusDiopters > 0f) {
                b.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_OFF)
                b.set(CaptureRequest.LENS_FOCUS_DISTANCE, s.focusDiopters.coerceIn(0f, c.minFocusDiopters))
            } else if (region != null && c.maxAfRegions > 0) {
                b.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_AUTO)
                b.set(CaptureRequest.CONTROL_AF_REGIONS, arrayOf(region))
            } else {
                b.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_VIDEO)
            }
            if (region != null && c.maxAeRegions > 0 && s.autoExposure) b.set(CaptureRequest.CONTROL_AE_REGIONS, arrayOf(region))

            // Zoom
            if (c.usesZoomRatio && Build.VERSION.SDK_INT >= 30) {
                b.set(CaptureRequest.CONTROL_ZOOM_RATIO, s.zoom.coerceIn(c.zoomRange.lower, c.zoomRange.upper))
            } else {
                val z = s.zoom.coerceIn(1f, c.zoomRange.upper)
                val a = c.activeArray
                val w = (a.width() / z).roundToInt(); val h = (a.height() / z).roundToInt()
                b.set(CaptureRequest.SCALER_CROP_REGION, Rect(a.centerX() - w / 2, a.centerY() - h / 2, a.centerX() + w / 2, a.centerY() + h / 2))
            }

            // Stabilization (detection runs on the same stabilised frames, so blur stays aligned).
            if (c.ois) b.set(CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE,
                if (s.ois) CameraMetadata.LENS_OPTICAL_STABILIZATION_MODE_ON else CameraMetadata.LENS_OPTICAL_STABILIZATION_MODE_OFF)
            val eisMode = when {
                !s.eis -> CameraMetadata.CONTROL_VIDEO_STABILIZATION_MODE_OFF
                c.previewStabilization && Build.VERSION.SDK_INT >= 33 -> CameraMetadata.CONTROL_VIDEO_STABILIZATION_MODE_PREVIEW_STABILIZATION
                c.eis -> CameraMetadata.CONTROL_VIDEO_STABILIZATION_MODE_ON
                else -> CameraMetadata.CONTROL_VIDEO_STABILIZATION_MODE_OFF
            }
            b.set(CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE, eisMode)

            // Picture profile
            if (s.flatProfile && c.toneCurve) {
                val pts = FlatProfile.curvePoints()
                b.set(CaptureRequest.TONEMAP_MODE, CameraMetadata.TONEMAP_MODE_CONTRAST_CURVE)
                b.set(CaptureRequest.TONEMAP_CURVE, TonemapCurve(pts, pts, pts))
            }

            val trigger = triggerAf && region != null
            sess.setRepeatingRequest(b.build(), resultCallback, handler)
            if (trigger) {
                triggerAf = false
                b.set(CaptureRequest.CONTROL_AF_TRIGGER, CameraMetadata.CONTROL_AF_TRIGGER_START)
                sess.capture(b.build(), null, handler)
            }
        } catch (e: Exception) {
            Log.w(TAG, "request failed", e)
        }
    }

    private var lastReadout = 0L
    private val resultCallback = object : CameraCaptureSession.CaptureCallback() {
        override fun onCaptureCompleted(s: CameraCaptureSession, r: CaptureRequest, result: TotalCaptureResult) {
            val now = System.nanoTime()
            if (now - lastReadout < 150_000_000L) return
            lastReadout = now
            onReadout?.invoke(
                CameraReadout(
                    result.get(CaptureResult.SENSOR_SENSITIVITY) ?: 0,
                    result.get(CaptureResult.SENSOR_EXPOSURE_TIME) ?: 0L,
                    result.get(CaptureResult.LENS_FOCUS_DISTANCE) ?: 0f,
                    result.get(CaptureResult.CONTROL_AF_STATE) == CameraMetadata.CONTROL_AF_STATE_FOCUSED_LOCKED,
                )
            )
        }
    }

    fun close(then: (() -> Unit)? = null) {
        handler.post { closeInternal(); then?.invoke() }
    }

    private fun closeInternal() {
        runCatching { session?.close() }
        runCatching { device?.close() }
        session = null
        device = null
    }

    fun release() {
        close()
        thread.quitSafely()
    }

    companion object { private const val TAG = "VeilCamera" }
}

object WhiteBalance {
    private val presets = listOf(
        2850 to CameraMetadata.CONTROL_AWB_MODE_INCANDESCENT,
        3800 to CameraMetadata.CONTROL_AWB_MODE_WARM_FLUORESCENT,
        4200 to CameraMetadata.CONTROL_AWB_MODE_FLUORESCENT,
        5500 to CameraMetadata.CONTROL_AWB_MODE_DAYLIGHT,
        6500 to CameraMetadata.CONTROL_AWB_MODE_CLOUDY_DAYLIGHT,
        7500 to CameraMetadata.CONTROL_AWB_MODE_SHADE,
    )

    /** Nearest supported camera preset for [kelvin] and its colour temperature. */
    fun preset(kelvin: Int, available: IntArray): Pair<Int, Int> {
        val usable = presets.filter { available.contains(it.second) }
        if (usable.isEmpty()) return CameraMetadata.CONTROL_AWB_MODE_AUTO to kelvin
        val best = usable.minByOrNull { abs(1e6 / it.first - 1e6 / kelvin) }!! // compare in mireds
        return best.second to best.first
    }

    /**
     * RGB gains that move an image balanced for [fromK] to look balanced for [toK],
     * plus a green-magenta [tint]. Approximated in mireds on a Planckian locus.
     */
    fun gains(fromK: Int, toK: Int, tint: Int): FloatArray {
        // A lower Kelvin setting (as for tungsten light) renders the scene bluer.
        val d = (1e6f / toK - 1e6f / fromK) / 100f
        val r = 1f - 0.16f * d
        val b = 1f + 0.20f * d
        val g = 1f - tint / 250f
        val n = maxOf(r, g, b)
        return floatArrayOf(r / n, g / n, b / n)
    }
}
