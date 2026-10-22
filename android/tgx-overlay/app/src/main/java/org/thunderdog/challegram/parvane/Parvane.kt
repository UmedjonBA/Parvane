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
    }
}
