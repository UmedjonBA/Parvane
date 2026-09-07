// Parvane Android: :libtd — TdApi + shim Client (org.drinkless.tdlib) поверх
// parvane-core (JNI); :app — минимальный Compose-клиент для доказательства шва.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "parvane-android"
include(":libtd", ":app")
