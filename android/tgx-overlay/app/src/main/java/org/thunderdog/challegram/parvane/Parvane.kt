package org.thunderdog.challegram.parvane

import android.content.Context

/** Parvane (spec 031): точка подключения оверлея к приложению Telegram X — зовётся из BaseApplication.onCreate. */
object Parvane {
    @JvmStatic
    fun onAppCreate(context: Context) {
        ParvaneWebrtc.install(context) // медиа звонков: ядро зовёт его через ParvaneCalls
        ParvaneBackground.init(context) // работа в фоне: UnifiedPush либо служба связи
        org.thunderdog.challegram.parvane.sections.PlannerReminders.init(context) // напоминания «Плана»
        org.thunderdog.challegram.parvane.sections.AccountUi.init() // привязка нового устройства, ключ восстановления
        org.thunderdog.challegram.parvane.sections.GroupCallController.init() // приглашения в групповой звонок
        applyDevTheme()
    }

    /**
     * Снимки тем для проверки глазами (T074): только debug-сборка — номер встроенной темы X из
     * /data/local/tmp/parvane-theme (ThemeId: 11 Gruvbox, 10 Gruvbox тёмная, 9/4 Nord, 7/3 Catppuccin, 6/5 Solarized,
     * 1/2 Telegram) применяется после запуска.
     */
    private fun applyDevTheme() {
        if (!org.thunderdog.challegram.BuildConfig.DEBUG) return
        val id = try { java.io.File("/data/local/tmp/parvane-theme").takeIf { it.canRead() }?.readText()?.trim()?.toIntOrNull() } catch (e: Exception) { null } ?: return
        // Handler, а не UI.post: класс UI X на этом шаге ещё не инициализирован
        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
            try {
                val tm = org.thunderdog.challegram.theme.ThemeManager.instance()
                tm.changeGlobalTheme(org.thunderdog.challegram.telegram.TdlibManager.instance().current(), tm.getTheme(id), true, null)
                android.util.Log.i("ParvaneClient", "тема (dev): $id")
            } catch (e: Throwable) {
                android.util.Log.w("ParvaneClient", "тема (dev): ${e.message}")
            }
        }, 5000)
    }
}
