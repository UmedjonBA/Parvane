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
     * 1/2 Telegram) применяется после запуска. Дальше файл перечитывается раз в 2 с: новый номер — смена темы на лету
     * (как ночной режим по системе), сценарий проверяет, что открытые экраны перекрашиваются.
     */
    private fun applyDevTheme() {
        if (!org.thunderdog.challegram.BuildConfig.DEBUG) return
        val file = java.io.File("/data/local/tmp/parvane-theme")
        fun read() = try { file.takeIf { it.canRead() }?.readText()?.trim()?.toIntOrNull() } catch (e: Exception) { null }
        if (read() == null) return
        // Handler, а не UI.post: класс UI X на этом шаге ещё не инициализирован
        val main = android.os.Handler(android.os.Looper.getMainLooper())
        var applied = -1
        val tick = object : Runnable {
            override fun run() {
                val id = read()
                if (id != null && id != applied) {
                    applied = id
                    try {
                        val tm = org.thunderdog.challegram.theme.ThemeManager.instance()
                        tm.changeGlobalTheme(org.thunderdog.challegram.telegram.TdlibManager.instance().current(), tm.getTheme(id), true, null)
                        android.util.Log.i("ParvaneClient", "тема (dev): $id")
                    } catch (e: Throwable) {
                        android.util.Log.w("ParvaneClient", "тема (dev): ${e.message}")
                    }
                }
                main.postDelayed(this, 2000)
            }
        }
        main.postDelayed(tick, 5000)
    }
}
