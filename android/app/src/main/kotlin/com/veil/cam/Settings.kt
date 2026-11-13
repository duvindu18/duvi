package com.veil.cam

import android.content.Context
import org.json.JSONObject

/** Anonymization styles, as on the desktop app. */
enum class BlurStyle { GAUSSIAN, PIXELATE, BLACK_BOX, MASK }

/** Everything the user can change. Immutable: edits produce a copy. */
data class Settings(
    // Format
    val cameraId: String = "",
    val width: Int = 1920,
    val height: Int = 1080,
    val fps: Int = 30,
    val hevc: Boolean = true,
    val bitrateLevel: Int = 1, // 0 low, 1 standard, 2 high
    val audio: Boolean = true,
    // Exposure
    val autoExposure: Boolean = true,
    val iso: Int = 400,
    val shutterNs: Long = 1_000_000_000L / 50,
    val ev: Int = 0, // exposure compensation steps
    val aeLock: Boolean = false,
    val shutterAngle: Boolean = true, // show shutter as angle (180°) instead of 1/x
    // White balance
    val autoWb: Boolean = true,
    val kelvin: Int = 5600,
    val tint: Int = 0, // -50..50
    val awbLock: Boolean = false,
    // Focus / lens
    val autoFocus: Boolean = true,
    val focusDiopters: Float = 0f,
    val zoom: Float = 1f,
    val ois: Boolean = true,
    val eis: Boolean = false,
    val flatProfile: Boolean = false,
    // Look
    val lut: String = "None",
    val lutAmount: Float = 1f,
    val lutOnMonitor: Boolean = true,
    val bakeLut: Boolean = true,
    // Monitoring (preview only, never recorded)
    val zebra: Boolean = false,
    val zebraLevel: Float = 0.95f,
    val falseColor: Boolean = false,
    val peaking: Boolean = false,
    val peakColor: Int = 0, // 0 lime, 1 red, 2 white, 3 blue
    val peakSensitivity: Float = 0.5f,
    val histogram: Boolean = true,
    val grid: Boolean = false,
    val guide: String = "Off", // Off, 2.39:1, 1.85:1, 4:5, 9:16, 1:1
    val level: Boolean = true,
    val showBoxes: Boolean = false,
    val lowLatencyPreview: Boolean = false,
    val mirrorFront: Boolean = false,
    val sounds: Boolean = true,
    // Face blur
    val blurOn: Boolean = true,
    val maxFaces: Int = 2, // 1, 2, 0 = any
    val style: BlurStyle = BlurStyle.GAUSSIAN,
    val ellipse: Boolean = true,
    val intensity: Int = 70,
    val coverage: Float = 0.2f,
    val holdFrames: Int = 8,
    val softEdges: Boolean = true,
    val accurateModel: Boolean = false,
    val allAngles: Boolean = true,
    val maskPath: String = "",
) {
    fun bitrate(): Int {
        val px = width.toLong() * height * fps
        val base = px * (if (hevc) 0.07 else 0.11) // bits per pixel
        val f = when (bitrateLevel) { 0 -> 0.55; 2 -> 1.8; else -> 1.0 }
        return (base * f).toLong().coerceIn(4_000_000L, 200_000_000L).toInt()
    }

    fun toJson(): JSONObject = JSONObject().apply {
        put("cameraId", cameraId); put("width", width); put("height", height); put("fps", fps); put("hevc", hevc)
        put("bitrateLevel", bitrateLevel); put("audio", audio)
        put("autoExposure", autoExposure); put("iso", iso); put("shutterNs", shutterNs); put("ev", ev); put("shutterAngle", shutterAngle)
        put("autoWb", autoWb); put("kelvin", kelvin); put("tint", tint)
        put("autoFocus", autoFocus); put("focusDiopters", focusDiopters.toDouble()); put("zoom", zoom.toDouble())
        put("ois", ois); put("eis", eis); put("flatProfile", flatProfile)
        put("lut", lut); put("lutAmount", lutAmount.toDouble()); put("lutOnMonitor", lutOnMonitor); put("bakeLut", bakeLut)
        put("zebra", zebra); put("zebraLevel", zebraLevel.toDouble()); put("falseColor", falseColor); put("peaking", peaking)
        put("peakColor", peakColor); put("peakSensitivity", peakSensitivity.toDouble()); put("histogram", histogram)
        put("grid", grid); put("guide", guide); put("level", level); put("showBoxes", showBoxes)
        put("lowLatencyPreview", lowLatencyPreview); put("mirrorFront", mirrorFront); put("sounds", sounds)
        put("blurOn", blurOn); put("maxFaces", maxFaces); put("style", style.name); put("ellipse", ellipse)
        put("intensity", intensity); put("coverage", coverage.toDouble()); put("holdFrames", holdFrames)
        put("softEdges", softEdges); put("accurateModel", accurateModel); put("allAngles", allAngles); put("maskPath", maskPath)
    }

    companion object {
        private const val PREFS = "veilcam"
        private const val KEY = "settings"

        fun fromJson(j: JSONObject): Settings {
            val d = Settings()
            return Settings(
                cameraId = j.optString("cameraId", d.cameraId), width = j.optInt("width", d.width), height = j.optInt("height", d.height),
                fps = j.optInt("fps", d.fps), hevc = j.optBoolean("hevc", d.hevc), bitrateLevel = j.optInt("bitrateLevel", d.bitrateLevel),
                audio = j.optBoolean("audio", d.audio),
                autoExposure = j.optBoolean("autoExposure", d.autoExposure), iso = j.optInt("iso", d.iso),
                shutterNs = j.optLong("shutterNs", d.shutterNs), ev = j.optInt("ev", d.ev), shutterAngle = j.optBoolean("shutterAngle", d.shutterAngle),
                autoWb = j.optBoolean("autoWb", d.autoWb), kelvin = j.optInt("kelvin", d.kelvin), tint = j.optInt("tint", d.tint),
                autoFocus = j.optBoolean("autoFocus", d.autoFocus), focusDiopters = j.optDouble("focusDiopters", 0.0).toFloat(),
                zoom = j.optDouble("zoom", 1.0).toFloat(), ois = j.optBoolean("ois", d.ois), eis = j.optBoolean("eis", d.eis),
                flatProfile = j.optBoolean("flatProfile", d.flatProfile),
                lut = j.optString("lut", d.lut), lutAmount = j.optDouble("lutAmount", 1.0).toFloat(),
                lutOnMonitor = j.optBoolean("lutOnMonitor", d.lutOnMonitor), bakeLut = j.optBoolean("bakeLut", d.bakeLut),
                zebra = j.optBoolean("zebra", d.zebra), zebraLevel = j.optDouble("zebraLevel", 0.95).toFloat(),
                falseColor = j.optBoolean("falseColor", d.falseColor), peaking = j.optBoolean("peaking", d.peaking),
                peakColor = j.optInt("peakColor", d.peakColor), peakSensitivity = j.optDouble("peakSensitivity", 0.5).toFloat(),
                histogram = j.optBoolean("histogram", d.histogram), grid = j.optBoolean("grid", d.grid), guide = j.optString("guide", d.guide),
                level = j.optBoolean("level", d.level), showBoxes = j.optBoolean("showBoxes", d.showBoxes),
                lowLatencyPreview = j.optBoolean("lowLatencyPreview", d.lowLatencyPreview), mirrorFront = j.optBoolean("mirrorFront", d.mirrorFront),
                sounds = j.optBoolean("sounds", d.sounds),
                blurOn = j.optBoolean("blurOn", d.blurOn), maxFaces = j.optInt("maxFaces", d.maxFaces),
                style = runCatching { BlurStyle.valueOf(j.optString("style", d.style.name)) }.getOrDefault(d.style),
                ellipse = j.optBoolean("ellipse", d.ellipse), intensity = j.optInt("intensity", d.intensity),
                coverage = j.optDouble("coverage", 0.2).toFloat(), holdFrames = j.optInt("holdFrames", d.holdFrames),
                softEdges = j.optBoolean("softEdges", d.softEdges), accurateModel = j.optBoolean("accurateModel", d.accurateModel),
                allAngles = j.optBoolean("allAngles", d.allAngles), maskPath = j.optString("maskPath", d.maskPath),
            )
        }

        fun load(ctx: Context): Settings = runCatching {
            val s = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null) ?: return Settings()
            fromJson(JSONObject(s))
        }.getOrDefault(Settings())

        fun save(ctx: Context, s: Settings) {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, s.toJson().toString()).apply()
        }
    }
}
