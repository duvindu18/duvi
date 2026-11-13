plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Face models are not kept in git (InsightFace licence, size). Point -PveilModels
// (or VEIL_MODELS) at a folder with det_500m.onnx and optionally det_10g.onnx.
val modelsDir = (findProperty("veilModels") as String?) ?: System.getenv("VEIL_MODELS") ?: "${rootDir}/models"

android {
    namespace = "com.veil.cam"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.veil.cam"
        minSdk = 30
        targetSdk = 35
        versionCode = 4
        versionName = "1.3.0"
        ndk { abiFilters += listOf("arm64-v8a") } // 64-bit phones (all current devices)
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
            isMinifyEnabled = false
            val rel = signingConfigs.getByName("release")
            signingConfig = if (rel.storeFile != null) rel else signingConfigs.getByName("debug")
        }
    }

    sourceSets["main"].assets.srcDirs("src/main/assets", modelsDir)

    androidResources { noCompress += listOf("onnx") }

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
}

dependencies {
    implementation(project(":core"))
    implementation("com.microsoft.onnxruntime:onnxruntime-android:1.20.0")
    // On-device person segmentation for the cinematic depth effect (model bundled in the APK).
    implementation("com.google.mlkit:segmentation-selfie:16.0.0-beta6")
}
