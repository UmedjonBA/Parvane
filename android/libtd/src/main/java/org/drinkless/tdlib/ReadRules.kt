package org.drinkless.tdlib

/**
 * ViewMessages — прочтение (READ-2), как в TDLib: forceRead либо показ в ленте чата, треда, темы; без источника —
 * запрос шва (e2e «read»). Список чатов, поиск, уведомление, превью, журнал действий, скриншот — только «просмотрено»,
 * маркер «прочитано до» и отметку «непрочитано» не трогают. Вне Client.kt — чтобы JVM-тест не поднимал ядро.
 */
internal fun viewCountsAsRead(source: TdApi.MessageSource?, forceRead: Boolean): Boolean = forceRead || when (source) {
    null, is TdApi.MessageSourceChatHistory, is TdApi.MessageSourceMessageThreadHistory,
    is TdApi.MessageSourceForumTopicHistory, is TdApi.MessageSourceDirectMessagesChatTopicHistory -> true
    else -> false
}
