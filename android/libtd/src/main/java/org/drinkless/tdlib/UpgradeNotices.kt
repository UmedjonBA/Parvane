package org.drinkless.tdlib

/**
 * Кадры перехода на протокол v2 (E6, T110) → нативные апдейты X. Ядро отдаёт событие на
 * КАЖДЫЙ кадр gateway (`upgrade_available` после каждого входа; `upgrade_required` — на каждую
 * попытку соединения, раз в 5 минут), шов показывает каждое один раз за запуск:
 *  - `upgrade_available` (gateway `PARVANE_V1_MODE=notice`) — `UpdateServiceNotification`
 *    (X показывает штатный диалог), v1 ещё работает;
 *  - `upgrade_required` (`disabled`) — `UpdateServiceNotification` с типом [TYPE_REQUIRED]
 *    (оверлей X открывает по нему штатный диалог «Update required» с кнопкой «Update»; без
 *    оверлея — обычный диалог) и `UpdateConnectionState(Connecting)`: соединения по v1 нет.
 *    Сессия при этом остаётся (учётные данные в порядке) — это не отказ авторизации.
 * Чистый JVM-класс.
 */
class UpgradeNotices {
    private var availableShown = false
    private var requiredShown = false
    /** Сервер отключил v1: повторные входы и переподключения не крутим. */
    @Volatile var required = false
        private set

    @Synchronized
    fun onAvailable(ru: Boolean = SeamText.isRu()): List<TdApi.Update> {
        if (availableShown || requiredShown) return emptyList()
        availableShown = true
        return listOf(notification(TYPE_AVAILABLE, SeamText.of("upgrade_available", ru)!!))
    }

    @Synchronized
    fun onRequired(ru: Boolean = SeamText.isRu()): List<TdApi.Update> {
        required = true
        if (requiredShown) return emptyList()
        requiredShown = true
        return listOf(
            TdApi.UpdateConnectionState(TdApi.ConnectionStateConnecting()),
            notification(TYPE_REQUIRED, SeamText.of("upgrade_required", ru)!!))
    }

    /** v1 снова принимает (оператор вернул режим): соединение восстановлено. */
    @Synchronized
    fun onConnected() { required = false }

    private fun notification(type: String, text: String) =
        TdApi.UpdateServiceNotification(type, TdApi.MessageText(TdApi.FormattedText(text, arrayOf()), null, null))

    companion object {
        const val TYPE_AVAILABLE = "PARVANE_UPGRADE_AVAILABLE"
        const val TYPE_REQUIRED = "PARVANE_UPGRADE_REQUIRED"
        /** Ошибка ядра — «сервер отключил v1» (текст транспорта `gateway: upgrade_required`). */
        fun isUpgradeError(text: String?): Boolean = text?.contains("upgrade_required") == true
    }
}
