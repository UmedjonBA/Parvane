plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "org.parvane.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "org.parvane.app"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "0.1"
    }
    // Отдельные APK по ABI: arm64 — телефон, x86_64 — эмулятор (дымовой тест)
    splits {
        abi {
            isEnable = true
            reset()
            include("arm64-v8a", "x86_64")
            isUniversalApk = false
        }
    }
    // P-46: релизный keystore из окружения (PARVANE_RELEASE_KEYSTORE,
    // PARVANE_RELEASE_STORE_PASSWORD, PARVANE_RELEASE_KEY_ALIAS,
    // PARVANE_RELEASE_KEY_PASSWORD). Без него release подписывается debug-ключом
    // с громким предупреждением — такой APK нельзя публиковать.
    val releaseKeystore = System.getenv("PARVANE_RELEASE_KEYSTORE")?.takeIf { it.isNotBlank() }
    signingConfigs {
        if (releaseKeystore != null) {
            create("release") {
                storeFile = file(releaseKeystore)
                storePassword = System.getenv("PARVANE_RELEASE_STORE_PASSWORD") ?: ""
                keyAlias = System.getenv("PARVANE_RELEASE_KEY_ALIAS") ?: "parvane"
                keyPassword = System.getenv("PARVANE_RELEASE_KEY_PASSWORD") ?: ""
            }
        }
    }
    buildTypes {
        release {
            // .so без отладочных символов (release-сборка CMake) — APK ~втрое меньше debug
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (releaseKeystore != null) {
                signingConfig = signingConfigs.getByName("release")
            } else {
                logger.warn("PARVANE_RELEASE_KEYSTORE не задан: release подписан debug-ключом — не для публикации")
                signingConfig = signingConfigs.getByName("debug")
            }
        }
    }
    // buildConfig — для BuildConfig.DEBUG (dev-хуки только в debug, P-12)
    buildFeatures {
        compose = true
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
}

dependencies {
    implementation(project(":libtd"))
    val bom = platform("androidx.compose:compose-bom:2024.09.03")
    implementation(bom)
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.6")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.6")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
}
