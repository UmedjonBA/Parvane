package org.drinkless.tdlib

import org.json.JSONObject

/**
 * Параметры отправки X → содержимое провода (паритет с web и desktop, ревью 7 ноя 2026):
 * - «Отправить без звука» (`MessageSendOptions.disableNotification`) — `Content.silent` (поле `silent` содержимого шва,
 *   ядро кладёт его в `msg/v2/content.proto` silent = 103); получатель уведомляет без звука;
 * - альбом (`SendMessageAlbum`) — те же сообщения по одному, ответ — только у первого (у ядра альбомов нет);
 * - пересылка «без автора» / «без подписи» (`ForwardMessages.sendCopy/removeCaption`) — копия без `forwarded_*`
 *   и без подписи; разбор — в JNI `nativeForward` по [forwardOptions].
 */
object SendOptions {
    fun isSilent(options: TdApi.MessageSendOptions?): Boolean = options?.disableNotification == true

    /** Отметить содержимое «без звука» (служебным видам — опрос-голос, итоги — не нужно, но и не вредно). */
    fun applySilent(content: JSONObject, options: TdApi.MessageSendOptions?): JSONObject {
        if (isSilent(options)) content.put("silent", true) else content.remove("silent")
        return content
    }

    /** Входящее «без звука» (от web/desktop/android). */
    fun isSilent(content: JSONObject?): Boolean = content?.optBoolean("silent") == true

    /** Только предпросмотр (`onlyPreview`): X проверяет, можно ли отправить, — ничего не уходит. */
    fun isPreviewOnly(options: TdApi.MessageSendOptions?): Boolean = options?.onlyPreview == true

    fun forwardOptions(sendCopy: Boolean, removeCaption: Boolean, options: TdApi.MessageSendOptions?): JSONObject =
        JSONObject().put("hide_author", sendCopy).put("remove_caption", removeCaption).put("silent", isSilent(options))
}
