plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
    id("org.jetbrains.kotlin.jvm") version "2.0.21" apply false
    // UI screenshots on the JVM, only with -PveilSnapshots (see app/src/snapshotTest).
    id("app.cash.paparazzi") version "1.3.5" apply false
}
