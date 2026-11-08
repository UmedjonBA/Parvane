package org.drinkless.tdlib

/**
 * Запросы X к локальной истории чата (B5 ревью 7 ноя 2026; поиск у Parvane — на устройстве, как web/desktop):
 * «перейти к дате» (`GetChatMessageByDate`) и поиск по автору (`SearchChatMessages.senderId`).
 */
object HistoryQueries {
    /** Последнее сообщение не позже [date] (сек), как TDLib; null — до этой даты сообщений нет. */
    fun atOrBefore(messages: Array<TdApi.Message>, date: Int): TdApi.Message? =
        messages.filter { it.date <= date && it.schedulingState == null }.maxWithOrNull(compareBy({ it.date }, { it.id }))

    /** Автор сообщения совпадает с [sender] (null — любой автор). */
    fun fromSender(m: TdApi.Message, sender: TdApi.MessageSender?): Boolean = when (sender) {
        null -> true
        is TdApi.MessageSenderUser -> (m.senderId as? TdApi.MessageSenderUser)?.userId == sender.userId
        is TdApi.MessageSenderChat -> (m.senderId as? TdApi.MessageSenderChat)?.chatId == sender.chatId
        else -> false
    }
}
