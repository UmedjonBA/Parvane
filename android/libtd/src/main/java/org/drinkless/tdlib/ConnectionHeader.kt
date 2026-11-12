package org.drinkless.tdlib

/**
 * Состояние шапки X («Соединение…», «Обновление…», пусто) по событиям ядра.
 *
 * Разовый перенос (spec 035) показывает «Обновление…»; событие ядра «связь готова» может прийти, пока перенос идёт,
 * и второго такого события не будет, если связь не рвалась. Поэтому по окончании переноса шапка возвращается к
 * последнему известному состоянию связи, а не к «Соединение…» (12 ноя 2026: после переноса APK висел «Соединение»,
 * хотя сообщения ходили).
 */
internal object ConnectionHeader {
    fun afterMigrationStep(done: Boolean, connectionReady: Boolean): TdApi.ConnectionState = when {
        !done -> TdApi.ConnectionStateUpdating()
        connectionReady -> TdApi.ConnectionStateReady()
        else -> TdApi.ConnectionStateConnecting()
    }

    /** null — событие связи во время переноса не перекрывает «Обновление…» (кроме «готово»). */
    fun onConnection(ready: Boolean, migrating: Boolean): TdApi.ConnectionState? = when {
        ready -> TdApi.ConnectionStateReady()
        migrating -> null
        else -> TdApi.ConnectionStateConnecting()
    }
}
