package org.drinkless.tdlib

/**
 * Тексты шва для нативных экранов X — EN и RU (принцип IX), spec 007:
 * режим «усиленная приватность» (L2, правило L2-1), кадры перехода на v2 (E6, T110).
 * Чистый JVM: язык — параметром (тесты), по умолчанию — локаль устройства.
 * %s — имя участника.
 */
internal object SeamText {
    fun isRu(): Boolean = java.util.Locale.getDefault().language == "ru"

    /** Текст по коду; null — код не из этого набора. */
    fun of(code: String, ru: Boolean = isRu()): String? = when (code) {
        // служебное сообщение чата о смене режима L2
        "l2_enabled" -> if (ru) "%s включил(а) усиленную приватность" else "%s enabled enhanced privacy"
        "l2_disabled" -> if (ru) "%s выключил(а) усиленную приватность" else "%s disabled enhanced privacy"
        "l2_enabled_you" -> if (ru) "Вы включили усиленную приватность" else "You enabled enhanced privacy"
        "l2_disabled_you" -> if (ru) "Вы выключили усиленную приватность" else "You disabled enhanced privacy"
        // автор записи неизвестен (вошли в группу с уже включённым режимом)
        "l2_enabled_anon" -> if (ru) "Усиленная приватность включена" else "Enhanced privacy is enabled"
        "l2_disabled_anon" -> if (ru) "Усиленная приватность выключена" else "Enhanced privacy is disabled"
        "l2_unavailable" -> if (ru) "Усиленная приватность недоступна в этом чате" else "Enhanced privacy is not available in this chat"
        "l2_failed" -> if (ru) "Не удалось изменить режим. Попробуйте позже" else "Could not change the mode. Try again later"
        // E6 (T110): сервер переводит клиентов на протокол v2
        "upgrade_available" -> if (ru) "Доступна новая версия Parvane. Обновите приложение — эта версия скоро перестанет работать."
            else "A new version of Parvane is available. Please update the app — this version will stop working soon."
        "upgrade_required" -> if (ru) "Эта версия Parvane больше не поддерживается. Обновите приложение, чтобы продолжить."
            else "This version of Parvane is no longer supported. Update the app to continue."
        // платные сообщения (Telegram Stars) вне скоупа — пункт экрана X скрыт оверлеем, отказ честный
        "paid_messages_unsupported" -> if (ru) "Платные сообщения не поддерживаются" else "Paid messages are not supported"
        else -> null
    }
}
