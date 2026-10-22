package org.thunderdog.challegram.parvane

import android.content.Context

/** Parvane (spec 031): точка подключения оверлея к приложению Telegram X — зовётся из BaseApplication.onCreate. */
object Parvane {
    @JvmStatic
    fun onAppCreate(context: Context) {
        ParvaneWebrtc.install(context) // медиа звонков: ядро зовёт его через ParvaneCalls
    }
}
