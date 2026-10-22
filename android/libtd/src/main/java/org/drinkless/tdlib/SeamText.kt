package org.drinkless.tdlib

/**
 * Тексты шва для нативных экранов X — EN и RU (принцип IX): режим «усиленная приватность» (L2-1), вход и
 * отказы протокола v2 (коды ERROR_CODE_* → текст, как desktop V2ErrorText), привязка устройства, ключ
 * восстановления, служебные сообщения о собеседнике (spec 031).
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
        // вход (spec 031: отказы v2 — кодами, текст выбирает клиент)
        "bad_login" -> if (ru) "Неверный ник или пароль" else "Wrong username or password"
        "sign_in_failed" -> if (ru) "Не удалось войти. Проверьте связь и попробуйте ещё раз" else "Could not sign in. Check your connection and try again"
        "too_many_attempts" -> if (ru) "Слишком много попыток. Попробуйте позже" else "Too many attempts. Try again later"
        "device_revoked" -> if (ru) "Это устройство отключено от аккаунта. Войдите снова" else "This device was removed from the account. Sign in again"
        "confirm_required" -> if (ru) "Аккаунт ещё не подтверждён — подтвердите его по ссылке или коду из письма" else "The account is not confirmed yet — confirm it with the link or the code from the email"
        "account_restored" -> if (ru) "Аккаунт восстановлен — удаление отменено" else "Account restored — deletion cancelled"
        "failed" -> if (ru) "Не удалось. Попробуйте ещё раз" else "Something went wrong. Try again"
        "not_linked" -> if (ru) "Устройство ещё не привязано к аккаунту — подтвердите привязку на другом устройстве или войдите ключом восстановления"
            else "This device is not linked to the account yet — confirm on another device or use your recovery key"
        // привязка нового устройства (LINK-1)
        "link_offered" -> if (ru) "Привязка устройства: откройте Parvane на другом своём устройстве — там появится запрос и код сверки."
            else "Device linking: open Parvane on another device of yours — a request with a verification code will appear there."
        "link_code" -> if (ru) "Привязка устройства. Сверьте код с другим устройством и подтвердите там:\n%s"
            else "Device linking. Compare the code with your other device and confirm there:\n%s"
        "link_imported" -> if (ru) "Устройство привязано, история перенесена." else "Device linked, history transferred."
        "link_joined" -> if (ru) "Устройство подключено к аккаунту." else "Device connected to the account."
        "link_expired" -> if (ru) "Запрос привязки истёк — войдите снова, чтобы отправить новый" else "The linking request expired — sign in again to send a new one"
        "link_failed" -> if (ru) "Привязка не удалась. Попробуйте ещё раз" else "Linking failed. Try again"
        "link_request" -> if (ru) "Новое устройство просит привязку к вашему аккаунту. Код сверки:\n%s\nПодтвердите в Настройки → Устройства, если коды совпадают."
            else "A new device asks to be linked to your account. Verification code:\n%s\nConfirm in Settings → Devices if the codes match."
        // ключ восстановления через Telegram (RECOVER-2)
        "recovery_waiting" -> if (ru) "Бот Parvane в Telegram спросит ключ восстановления — ответьте ему ключом." else "The Parvane bot in Telegram will ask for your recovery key — reply with it."
        "recovery_joining" -> if (ru) "Ключ получен, устройство подключается…" else "Key received, connecting this device…"
        "recovery_done" -> if (ru) "Устройство подключено по ключу восстановления." else "Device connected with the recovery key."
        "recovery_failed" -> if (ru) "Не удалось войти по ключу восстановления" else "Could not sign in with the recovery key"
        "recovery_expired" -> if (ru) "Ответ боту не пришёл вовремя — запросите ключ ещё раз" else "No reply to the bot in time — request the key again"
        "recovery_unavailable" -> if (ru) "К аккаунту не привязан Telegram — введите ключ восстановления вручную" else "No Telegram linked to this account — enter the recovery key manually"
        "recovery_limit" -> if (ru) "Слишком много запросов ключа. Попробуйте позже" else "Too many key requests. Try again later"
        // служебные сообщения о собеседнике
        "peer_renamed" -> if (ru) "%s сменил(а) ник на %s" else "%s changed their username to %s"
        "peer_deleted" -> if (ru) "Аккаунт удалён" else "Deleted account"
        "peer_root_changed" -> if (ru) "Ключ безопасности %s изменился. Сверьте его, если это важно." else "The security key of %s has changed. Verify it if it matters."
        "ssk_rotation_needed" -> if (ru) "Устройство отозвано: смените ключ подписи устройств в настройках приватности (нужен ключ восстановления)."
            else "Device revoked: change the device signing key in Privacy settings (requires the recovery key)."
        // звонки (CALL-1, D-08): звонить можно только тому, кто уже писал
        "call_not_contact" -> if (ru) "Позвонить можно тому, с кем уже была переписка" else "You can only call someone you have already chatted with"
        "call_not_sent" -> if (ru) "Звонок не удался. Проверьте связь и попробуйте ещё раз" else "The call failed. Check your connection and try again"
        else -> null
    }

    /** Код отказа входа (ERROR_CODE_* протокола v2) → ключ текста (как desktop V2ErrorText). */
    fun loginErrorKey(code: String): String = when (code) {
        "ERROR_CODE_UPGRADE_REQUIRED" -> "upgrade_required"
        "ERROR_CODE_RATE_LIMITED" -> "too_many_attempts"
        "ERROR_CODE_REVOKED" -> "device_revoked"
        "ERROR_CODE_UNAUTHORIZED", "ERROR_CODE_FORBIDDEN", "ERROR_CODE_INVALID", "ERROR_CODE_NOT_FOUND" -> "bad_login"
        else -> "sign_in_failed"
    }
}
