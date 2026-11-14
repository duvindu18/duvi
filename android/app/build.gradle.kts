plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val snapshots = providers.gradleProperty("veilSnapshots").isPresent
if (snapshots) apply(plugin = "app.cash.paparazzi")

// Models are not kept in git (licences, size). Point -PveilModels (or VEIL_MODELS) at a
// folder with them (see README). The "personal" flavor bundles the whole folder; the
// "play" flavor bundles only models whose licences allow a paid app (allow-list below).
val modelsDir = (findProperty("veilModels") as String?) ?: System.getenv("VEIL_MODELS") ?: "${rootDir}/models"
val playModels = listOf(
    "face_yunet_2023mar_dyn.onnx",       // YuNet, MIT (OpenCV Zoo)
    "depth_anything_v2_small.onnx",      // Depth Anything V2 Small, Apache 2.0
    "selfie_multiclass_256x256.tflite",  // MediaPipe, Apache 2.0
    "gesture_recognizer.task",           // MediaPipe, Apache 2.0
)
/** Copies only the allow-listed models; fails the build if one is missing. */
abstract class PlayModelsTask : DefaultTask() {
    @get:InputFiles abstract val models: ConfigurableFileCollection
    @get:Input abstract val names: ListProperty<String>
    @get:OutputDirectory abstract val out: DirectoryProperty

    @TaskAction fun copy() {
        val dir = out.get().asFile
        dir.deleteRecursively(); dir.mkdirs()
        val byName = models.files.associateBy { it.name }
        val missing = names.get().filter { byName[it]?.isFile != true }
        check(missing.isEmpty()) { "Missing models for the play build: $missing" }
        for (n in names.get()) byName.getValue(n).copyTo(File(dir, n))
    }
}
val preparePlayModels = tasks.register<PlayModelsTask>("preparePlayModels") {
    names.set(playModels)
    models.from(playModels.map { File(modelsDir, it) })
}
fun prop(name: String, env: String) = (findProperty(name) as String?) ?: System.getenv(env) ?: ""

android {
    namespace = "com.veil.cam"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.veil.cam"
        minSdk = 30
        targetSdk = 36
        versionCode = 12
        versionName = "1.9.0"
        // 64-bit ARM: every current phone. (No x86_64: MediaPipe ships no x86 library, and
        // x86 Chromebooks run arm64 apps through translation when no x86 code is bundled.)
        ndk { abiFilters += listOf("arm64-v8a") }
    }

    buildFeatures { buildConfig = true }
    flavorDimensions += "store"
    productFlavors {
        // Your own sideloaded build: every model in the folder (InsightFace SCRFD for faces).
        create("personal") {
            dimension = "store"
            buildConfigField("String", "FACE_MODEL", "\"scrfd\"")
            buildConfigField("boolean", "STORE", "false")
            buildConfigField("String", "LICENSE_KEY", "\"\"")
            buildConfigField("String", "SIGNING_SHA256", "\"\"")
        }
        // Google Play: commercially licensed models only, one-time purchase.
        create("play") {
            dimension = "store"
            buildConfigField("String", "FACE_MODEL", "\"yunet\"")
            buildConfigField("boolean", "STORE", "true")
            // Play Console > Monetize > Monetization setup > Licensing: the Base64 RSA public key.
            buildConfigField("String", "LICENSE_KEY", "\"${prop("veilPlayLicenseKey", "VEIL_PLAY_LICENSE_KEY")}\"")
            // Play Console > Test and release > App integrity > App signing: SHA-256 of the
            // app signing certificate (hex, colons optional). Empty: the check is skipped.
            buildConfigField("String", "SIGNING_SHA256", "\"${prop("veilPlaySigningSha256", "VEIL_PLAY_SIGNING_SHA256")}\"")
        }
    }

    signingConfigs {
        create("release") {
            val ks = (findProperty("veilKeystore") as String?) ?: System.getenv("VEIL_KEYSTORE")
            if (ks != null) {
                storeFile = file(ks)
                storePassword = (findProperty("veilKeystorePassword") as String?) ?: System.getenv("VEIL_KEYSTORE_PASSWORD")
                keyAlias = (findProperty("veilKeyAlias") as String?) ?: System.getenv("VEIL_KEY_ALIAS") ?: "veilcam"
                keyPassword = (findProperty("veilKeyPassword") as String?) ?: System.getenv("VEIL_KEY_PASSWORD") ?: storePassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            val rel = signingConfigs.getByName("release")
            signingConfig = if (rel.storeFile != null) rel else signingConfigs.getByName("debug")
        }
    }

    sourceSets["main"].assets.srcDirs("src/main/assets")
    sourceSets["personal"].assets.srcDirs(modelsDir)

    androidResources { noCompress += listOf("onnx", "tflite", "task") }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }
    packaging { jniLibs { useLegacyPackaging = true } } // compressed native libs: smaller download
    // UI screenshots (Paparazzi): gradle -PveilSnapshots :app:recordPaparazziRelease
    if (snapshots) sourceSets["test"].kotlin.srcDir("src/snapshotTest/kotlin")
}

dependencies {
    implementation(project(":core"))
    implementation("com.microsoft.onnxruntime:onnxruntime-android:1.32.0")
    // Person segmentation for cinematic depth: MediaPipe image segmenter (GPU) with the
    // multiclass selfie model (hair / skin / clothes), models/selfie_multiclass_256x256.tflite.
    implementation("com.google.mediapipe:tasks-vision:0.10.26")
    // One-time purchase (play flavor only).
    "playImplementation"("com.android.billingclient:billing:8.3.0")
}

// The play assets come from the allow-list copy, never from the full models folder.
androidComponents {
    onVariants(selector().withFlavor("store" to "play")) { v ->
        v.sources.assets?.addGeneratedSourceDirectory(preparePlayModels, PlayModelsTask::out)
    }
}

if (gradle.startParameter.taskNames.any { it.contains("PlayRelease", ignoreCase = true) } && prop("veilPlayLicenseKey", "VEIL_PLAY_LICENSE_KEY").isBlank()) {
    logger.warn("Veil Cam: no -PveilPlayLicenseKey: this play build cannot verify purchases, so capture stays locked (see store/PLAY_RELEASE.md).")
}
