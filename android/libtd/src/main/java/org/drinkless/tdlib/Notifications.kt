package org.drinkless.tdlib

/**
 * Parvane (spec 031): уведомления Telegram X — как их отдаёт TDLib (UpdateNotificationGroup): одна группа на чат,
 * уведомление на входящее непрочитанное сообщение, снятие при прочтении (на этом или другом своём устройстве) и при
 * смахивании (RemoveNotification/RemoveNotificationGroup). Решение «показывать ли» — здесь: заглушённый чат или
 * область, своё, прочитанное и история из журнала не уведомляют. Текст уведомления — только на устройстве.
 * Без Android — для JVM-тестов.
 */
class Notifications {
    private class Group(val id: Int, val chatId: Long) {
        val items = LinkedHashMap<Long, TdApi.Notification>() // id сообщения → уведомление
    }
    private val groups = HashMap<Long, Group>()
    private var nextGroupId = 1
    private var nextId = 1

    /** Входящее сообщение → апдейт группы; null — не уведомлять. muted — чат или область заглушены. */
    @Synchronized
    fun onIncoming(msg: TdApi.Message, muted: Boolean, showPreview: Boolean = true): TdApi.UpdateNotificationGroup? {
        if (msg.isOutgoing || muted) return null
        val g = groups.getOrPut(msg.chatId) { Group(nextGroupId++, msg.chatId) }
        if (g.items.containsKey(msg.id)) return null
        val n = TdApi.Notification(nextId++, msg.date, false, TdApi.NotificationTypeNewMessage(msg, showPreview))
        g.items[msg.id] = n
        return TdApi.UpdateNotificationGroup(g.id, TdApi.NotificationGroupTypeMessages(), g.chatId, g.chatId, 0L,
            g.items.size, arrayOf(n), IntArray(0))
    }

    /** Прочитано до сообщения upTo включительно → снять уведомления; null — снимать нечего. */
    @Synchronized
    fun onRead(chatId: Long, upTo: Long): TdApi.UpdateNotificationGroup? {
        val g = groups[chatId] ?: return null
        val gone = g.items.filterKeys { it <= upTo }
        if (gone.isEmpty()) return null
        gone.keys.forEach { g.items.remove(it) }
        return TdApi.UpdateNotificationGroup(g.id, TdApi.NotificationGroupTypeMessages(), chatId, chatId, 0L,
            g.items.size, arrayOf(), gone.values.map { it.id }.toIntArray())
    }

    /** Сообщения удалены → их уведомления тоже. */
    @Synchronized
    fun onDeleted(chatId: Long, messageIds: Collection<Long>): TdApi.UpdateNotificationGroup? {
        val g = groups[chatId] ?: return null
        val gone = messageIds.mapNotNull { g.items.remove(it) }
        if (gone.isEmpty()) return null
        return TdApi.UpdateNotificationGroup(g.id, TdApi.NotificationGroupTypeMessages(), chatId, chatId, 0L,
            g.items.size, arrayOf(), gone.map { it.id }.toIntArray())
    }

    /** Смахнули уведомление/группу в X (RemoveNotification / RemoveNotificationGroup). */
    @Synchronized
    fun remove(groupId: Int, maxNotificationId: Int, single: Boolean): TdApi.UpdateNotificationGroup? {
        val g = groups.values.firstOrNull { it.id == groupId } ?: return null
        val gone = g.items.filterValues { if (single) it.id == maxNotificationId else it.id <= maxNotificationId }
        if (gone.isEmpty()) return null
        gone.keys.forEach { g.items.remove(it) }
        return TdApi.UpdateNotificationGroup(g.id, TdApi.NotificationGroupTypeMessages(), g.chatId, g.chatId, 0L,
            g.items.size, arrayOf(), gone.values.map { it.id }.toIntArray())
    }

    @Synchronized
    fun clear() { groups.clear() }
}
