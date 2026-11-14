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
    val fps: Int = 24, // cinema standard; 25/30/50/60 available
    val hevc: Boolean = true,
    val bitrateLevel: Int = 1, // 0 low, 1 standard, 2 high
    val audio: Boolean = true,
    // Exposure
    val autoExposure: Boolean = true,
    val iso: Int = 400,
    val shutterNs: Long = 1_000_000_000L / 48, // 180° at 24 fps (natural motion blur)
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
    val orientation: String = "Auto", // Auto (follow the phone), Landscape, Portrait
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
    // Cinematic depth: background defocus behind people (0 = off .. 1 = strongest)
    val depth: Float = 0f,
    // Film emulation (0..1 each, applied after anonymization)
    val filmPreset: String = "Off",
    val grain: Float = 0f,
    val grainSize: Float = 0.35f,
    val halation: Float = 0f,
    val bloom: Float = 0f,
    val aberration: Float = 0f,
    val leaks: Float = 0f,
    val burn: Float = 0f,
    val vignette: Float = 0f,
    val bakeFilm: Boolean = true,
    // Audio
    val noiseReduction: Int = 1, // 0 off, 1 standard, 2 strong
    val windFilter: Boolean = true,
    // Exposure helpers
    val shutterPriority: Boolean = false, // keep the shutter angle, adjust ISO automatically
    // Storage: private in-app gallery (hidden from the phone gallery) or the phone gallery
    val privateGallery: Boolean = true,
    // Power: 0 max quality, 1 balanced, 2 battery saver (see core PowerBudget)
    val powerMode: Int = 1,
    val dimWhileRecording: Boolean = true, // lower the screen after 10 s without a touch
    val autoStandby: Boolean = true, // camera off after 3 min idle in standby
    // Capture mode: CINEMATIC (video + depth), VIDEO, PHOTO, PORTRAIT (photo + depth)
    val mode: String = "VIDEO",
    val cineDepth: Float = 0.5f, // remembered depth for the depth modes: 1.4 / f-number (f/2.8)
    val bokehShape: Int = 0, // 0 circle, 1 six blades, 2 anamorphic, 3 swirl
    val bokehHighlights: Float = 0.5f, // how strongly lights open into discs
    val torch: Boolean = false,
) {
    val photoMode: Boolean get() = mode == "PHOTO" || mode == "PORTRAIT"
    val depthMode: Boolean get() = mode == "CINEMATIC" || mode == "PORTRAIT"

    val filmOn: Boolean get() = grain + halation + bloom + aberration + leaks + burn + vignette > 0.001f
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
        put("grid", grid); put("guide", guide); put("orientation", orientation); put("level", level); put("showBoxes", showBoxes)
        put("lowLatencyPreview", lowLatencyPreview); put("mirrorFront", mirrorFront); put("sounds", sounds)
        put("blurOn", blurOn); put("maxFaces", maxFaces); put("style", style.name); put("ellipse", ellipse)
        put("intensity", intensity); put("coverage", coverage.toDouble()); put("holdFrames", holdFrames)
        put("softEdges", softEdges); put("accurateModel", accurateModel); put("allAngles", allAngles); put("maskPath", maskPath)
        put("depth", depth.toDouble()); put("filmPreset", filmPreset); put("grain", grain.toDouble()); put("grainSize", grainSize.toDouble())
        put("halation", halation.toDouble()); put("bloom", bloom.toDouble()); put("aberration", aberration.toDouble())
        put("leaks", leaks.toDouble()); put("burn", burn.toDouble()); put("vignette", vignette.toDouble()); put("bakeFilm", bakeFilm)
        put("noiseReduction", noiseReduction); put("windFilter", windFilter); put("shutterPriority", shutterPriority)
        put("privateGallery", privateGallery)
        put("powerMode", powerMode); put("dimWhileRecording", dimWhileRecording); put("autoStandby", autoStandby)
        put("mode", mode); put("cineDepth", cineDepth.toDouble()); put("ui", 2); put("depthScale", 2)
        put("bokehShape", bokehShape); put("bokehHighlights", bokehHighlights.toDouble())
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
                // Layouts before 1.4 rotated the whole screen; the new one follows the phone.
                orientation = if (j.optInt("ui", 1) < 2) d.orientation else j.optString("orientation", d.orientation),
                level = j.optBoolean("level", d.level), showBoxes = j.optBoolean("showBoxes", d.showBoxes),
                lowLatencyPreview = j.optBoolean("lowLatencyPreview", d.lowLatencyPreview), mirrorFront = j.optBoolean("mirrorFront", d.mirrorFront),
                sounds = j.optBoolean("sounds", d.sounds),
                blurOn = j.optBoolean("blurOn", d.blurOn), maxFaces = j.optInt("maxFaces", d.maxFaces),
                style = runCatching { BlurStyle.valueOf(j.optString("style", d.style.name)) }.getOrDefault(d.style),
                ellipse = j.optBoolean("ellipse", d.ellipse), intensity = j.optInt("intensity", d.intensity),
                coverage = j.optDouble("coverage", 0.2).toFloat(), holdFrames = j.optInt("holdFrames", d.holdFrames),
                softEdges = j.optBoolean("softEdges", d.softEdges), accurateModel = j.optBoolean("accurateModel", d.accurateModel),
                allAngles = j.optBoolean("allAngles", d.allAngles), maskPath = j.optString("maskPath", d.maskPath),
                depth = j.optDouble("depth", 0.0).toFloat().let { if (j.optInt("depthScale", 1) < 2 && it > 0f) d.cineDepth else it }, filmPreset = j.optString("filmPreset", d.filmPreset),
                grain = j.optDouble("grain", 0.0).toFloat(), grainSize = j.optDouble("grainSize", 0.35).toFloat(),
                halation = j.optDouble("halation", 0.0).toFloat(), bloom = j.optDouble("bloom", 0.0).toFloat(),
                aberration = j.optDouble("aberration", 0.0).toFloat(), leaks = j.optDouble("leaks", 0.0).toFloat(),
                burn = j.optDouble("burn", 0.0).toFloat(), vignette = j.optDouble("vignette", 0.0).toFloat(),
                bakeFilm = j.optBoolean("bakeFilm", d.bakeFilm), noiseReduction = j.optInt("noiseReduction", d.noiseReduction),
                windFilter = j.optBoolean("windFilter", d.windFilter), shutterPriority = j.optBoolean("shutterPriority", d.shutterPriority),
                privateGallery = j.optBoolean("privateGallery", d.privateGallery),
                powerMode = j.optInt("powerMode", d.powerMode).coerceIn(0, 2),
                dimWhileRecording = j.optBoolean("dimWhileRecording", d.dimWhileRecording),
                autoStandby = j.optBoolean("autoStandby", d.autoStandby),
                mode = j.optString("mode", d.mode).takeIf { it in listOf("CINEMATIC", "VIDEO", "PHOTO", "PORTRAIT") } ?: d.mode,
                // Before 1.6 depth was an arbitrary 0.12..1 scale; it is now 1.4 / f-number.
                cineDepth = if (j.optInt("depthScale", 1) < 2) d.cineDepth else j.optDouble("cineDepth", d.cineDepth.toDouble()).toFloat().coerceIn(0f, 1f),
                bokehShape = j.optInt("bokehShape", d.bokehShape).coerceIn(0, 3),
                bokehHighlights = j.optDouble("bokehHighlights", d.bokehHighlights.toDouble()).toFloat().coerceIn(0f, 1f),
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

/** Film stock looks (strengths 0..1), tuned by eye against reference footage characteristics. */
object FilmPresets {
    val names = listOf("Off", "35mm", "16mm", "Super 8", "Dream", "Custom")

    fun apply(s: Settings, name: String): Settings = when (name) {
        "Off" -> s.copy(filmPreset = name, grain = 0f, halation = 0f, bloom = 0f, aberration = 0f, leaks = 0f, burn = 0f, vignette = 0f)
        // Fine grain, gentle halation and bloom, light vignette (modern 35mm print).
        "35mm" -> s.copy(filmPreset = name, grain = 0.3f, grainSize = 0.3f, halation = 0.35f, bloom = 0.15f, aberration = 0.1f, leaks = 0f, burn = 0f, vignette = 0.25f)
        // Coarser grain, stronger halation, softer edges and some fringing.
        "16mm" -> s.copy(filmPreset = name, grain = 0.6f, grainSize = 0.55f, halation = 0.5f, bloom = 0.2f, aberration = 0.25f, leaks = 0.1f, burn = 0f, vignette = 0.45f)
        // Heavy grain, leaks and burns, strong vignette (home-movie look).
        "Super 8" -> s.copy(filmPreset = name, grain = 0.9f, grainSize = 0.8f, halation = 0.45f, bloom = 0.25f, aberration = 0.45f, leaks = 0.45f, burn = 0.35f, vignette = 0.65f)
        // Soft highlights for music videos / romance.
        "Dream" -> s.copy(filmPreset = name, grain = 0.15f, grainSize = 0.3f, halation = 0.55f, bloom = 0.7f, aberration = 0.05f, leaks = 0.15f, burn = 0f, vignette = 0.3f)
        else -> s.copy(filmPreset = "Custom")
    }
}
