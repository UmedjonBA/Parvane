plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    // JVM-тесты шва зовут android.util.Log (сервисы стикеров и т.п.) — заглушки вместо «not mocked»
    testOptions { unitTests.isReturnDefaultValues = true }
    namespace = "org.parvane.libtd"
    compileSdk = 34
    ndkVersion = "27.2.12479018"

    defaultConfig {
        minSdk = 24
        // Ядро собрано под arm64-v8a и x86_64 (android/build-core.sh <ABI>)
        ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
        externalNativeBuild {
            cmake {
                arguments += listOf("-DANDROID_STL=c++_static")
                cppFlags += "-std=c++17"
            }
        }
    }
    externalNativeBuild {
        cmake {
            path = file("../jni/CMakeLists.txt")
            version = "3.22.1"
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    // buildConfig — BuildConfig.DEBUG для dev-оверрайдов gateway (P-12)
    buildFeatures { buildConfig = true }
}

dependencies {
    // TdApi.java из бандла Telegram X использует androidx-аннотации (@IntDef/@Nullable)
    implementation("androidx.annotation:annotation:1.8.2")
    // JVM-юнит маппинга шва (conformance GROUP-1) — без эмулятора
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}

// Протокол v2 (spec 007, T067): JVM-тесты шва гоняют движок через хостовую
// libparvane_protocol_jni.so (тот же protocol_jni.cpp/v2_bridge.h, что в
// libparvane_jni.so) — собирается android/build-host-jni.sh перед тестами.
val hostProtocolJni = rootProject.layout.projectDirectory.file(".build/host-jni/libparvane_protocol_jni.so").asFile
val buildHostProtocolJni by tasks.registering(Exec::class) {
    description = "Хостовая JNI-библиотека движка v2 для JVM-тестов шва"
    commandLine(rootProject.layout.projectDirectory.file("build-host-jni.sh").asFile.absolutePath)
    outputs.file(hostProtocolJni)
    outputs.upToDateWhen { false } // решают cargo/ninja: без изменений — секунды
}
tasks.withType<Test>().configureEach {
    dependsOn(buildHostProtocolJni)
    systemProperty("parvane.protocol.jni", hostProtocolJni.absolutePath)
    systemProperty("parvane.vectors.dir", rootProject.layout.projectDirectory.dir("../proto/parvane/vectors").asFile.absolutePath)
}

