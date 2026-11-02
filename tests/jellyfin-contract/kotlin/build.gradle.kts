plugins {
    kotlin("jvm") version "2.4.20"
    application
}
repositories { mavenCentral() }
val sdkVersion = (findProperty("sdkVersion") as String?) ?: "1.9.2"
dependencies {
    implementation("org.jellyfin.sdk:jellyfin-api-jvm:$sdkVersion")
    implementation("org.jellyfin.sdk:jellyfin-model-jvm:$sdkVersion")
    // jellyfin-api-jvm declares kotlinx-serialization-json runtime-scope only.
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")
}
kotlin { jvmToolchain(21) }
application { mainClass.set("DecodeKt") }
