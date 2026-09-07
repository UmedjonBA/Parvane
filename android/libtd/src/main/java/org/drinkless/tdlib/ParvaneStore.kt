package org.drinkless.tdlib

import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/**
 * Parvane: локальное состояние для синтеза объектов TdApi (аналог store.ts веба):
 * адрес ↔ id (FNV-1a 64, как IdForAddress на десктопе), пользователи, чаты,
 * сообщения по чатам (uuid ↔ id сообщения). Потокобезопасно через synchronized.
 */
class ParvaneStore {
    @Volatile var self: String = ""

    private val idByAddress = ConcurrentHashMap<String, Long>()
    private val addressById = ConcurrentHashMap<Long, String>()
    private val users = ConcurrentHashMap<Long, TdApi.User>()
    private val chats = ConcurrentHashMap<Long, TdApi.Chat>()
    private val profiles = ConcurrentHashMap<String, JSONObject>()
    // сообщения чата по возрастанию id; uuid → (chatId, msgId)
    private val messages = ConcurrentHashMap<Long, ArrayList<TdApi.Message>>()
    private val msgByUuid = ConcurrentHashMap<String, TdApi.Message>()
    private val uuidByMsg = ConcurrentHashMap<Long, String>()      // (chatId<<20 ^ msgId) → uuid
    private var nextMessageId = 1L

    fun clear() {
        users.clear(); chats.clear(); messages.clear(); msgByUuid.clear(); uuidByMsg.clear()
        self = ""
    }

    /** Детерминированный положительный id по адресу (FNV-1a 64, старший бит снят). */
    fun idOf(address: String): Long = idByAddress.getOrPut(address) {
        var h = -3750763034362895579L // 0xcbf29ce484222325
        for (b in address.toByteArray(Charsets.UTF_8)) {
            h = h xor (b.toLong() and 0xff)
            h *= 1099511628211L
        }
        val id = h and Long.MAX_VALUE
        addressById[id] = address
        if (id == 0L) 1L else id
    }

    fun addressOf(chatId: Long): String? = addressById[chatId]
    fun chatIds(): List<Long> = chats.values.sortedByDescending { it.positions.firstOrNull()?.order ?: 0L }.map { it.id }
    fun chatById(id: Long): TdApi.Chat? = chats[id]
    fun chatByAddress(address: String): TdApi.Chat? = chats[idOf(address)]
    fun userById(id: Long): TdApi.User? = users[id]
    fun user(address: String): TdApi.User? = users[idOf(address)]
    fun hasProfile(address: String) = profiles.containsKey(address)

    fun setProfile(address: String, info: JSONObject) {
        profiles[address] = info
    }

    private fun displayName(address: String): String {
        val p = profiles[address]
        val name = p?.optString("display_name").orEmpty()
        return name.ifEmpty { address.substringBefore('@') }
    }

    /** Пользователь + приватный чат по адресу. created — впервые созданы. */
    @Synchronized
    fun ensurePeer(address: String): Triple<TdApi.User, TdApi.Chat, Boolean> {
        val id = idOf(address)
        val nick = address.substringBefore('@')
        val existed = chats.containsKey(id)
        val user = TdApi.User().apply {
            this.id = id
            firstName = displayName(address)
            lastName = ""
            usernames = TdApi.Usernames(arrayOf(nick), arrayOf<String>(), nick, arrayOf<String>())
            phoneNumber = profiles[address]?.optString("phone").orEmpty()
            status = TdApi.UserStatusOffline(0)
            type = TdApi.UserTypeRegular()
            haveAccess = true
            isContact = address != self
            languageCode = ""
        }
        users[id] = user
        val chat = chats[id] ?: TdApi.Chat().apply {
            this.id = id
            type = TdApi.ChatTypePrivate(id)
            permissions = TdApi.ChatPermissions(true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true)
            positions = arrayOf(TdApi.ChatPosition(TdApi.ChatListMain(), 0L, false, null))
            chatLists = arrayOf(TdApi.ChatListMain())
            notificationSettings = TdApi.ChatNotificationSettings(true, 0, true, 0, true, true, true, false, true, 0, true, true, true, false, true, false)
            availableReactions = TdApi.ChatAvailableReactionsAll(11)
            canBeDeletedOnlyForSelf = true
            canBeReported = false
            isTranslatable = false
            clientData = ""
        }
        chat.title = user.firstName
        chats[id] = chat
        return Triple(user, chat, !existed)
    }

    /** Новое сообщение (дедуп по uuid → null). Обновляет lastMessage/position/unread чата. */
    @Synchronized
    fun putMessage(uuid: String, from: String, to: String, ts: Long, text: String, out: Boolean, read: Boolean = false): TdApi.Message? {
        if (uuid.isEmpty() || msgByUuid.containsKey(uuid)) return null
        val peer = if (out) to else from
        val chat = ensurePeer(peer).second
        val msgId = nextMessageId++ shl 20 // как серверные id TDLib (кратны 2^20)
        val msg = TdApi.Message().apply {
            id = msgId
            chatId = chat.id
            senderId = TdApi.MessageSenderUser(idOf(from))
            isOutgoing = out
            date = ts.toInt()
            canBeSaved = true
            content = TdApi.MessageText(TdApi.FormattedText(text, arrayOf()), null, null)
        }
        messages.getOrPut(chat.id) { ArrayList() }.add(msg)
        msgByUuid[uuid] = msg
        uuidByMsg[key(chat.id, msgId)] = uuid
        chat.lastMessage = msg
        chat.positions = arrayOf(TdApi.ChatPosition(TdApi.ChatListMain(), ts, false, null))
        if (!out && !read) chat.unreadCount += 1
        if (out) chat.lastReadOutboxMessageId = if (read) msgId else chat.lastReadOutboxMessageId
        return msg
    }

    private fun key(chatId: Long, msgId: Long) = (chatId shl 20) xor msgId
    fun uuidOf(chatId: Long, msgId: Long): String? = uuidByMsg[key(chatId, msgId)]

    /** История чата: от fromMessageId (0 — с конца) вниз, новые первыми — как TDLib. */
    @Synchronized
    fun history(chatId: Long, fromMessageId: Long, limit: Int): TdApi.Messages {
        val all = messages[chatId] ?: return TdApi.Messages(0, arrayOf())
        val below = if (fromMessageId == 0L) all else all.filter { it.id < fromMessageId }
        val page = below.takeLast(limit).reversed()
        return TdApi.Messages(all.size, page.toTypedArray())
    }

    /** Входящие прочитаны до msgId → сброс непрочитанного; апдейт для UI. */
    @Synchronized
    fun markInboxRead(chatId: Long, msgId: Long): TdApi.Update? {
        val chat = chats[chatId] ?: return null
        if (msgId <= chat.lastReadInboxMessageId) return null
        chat.lastReadInboxMessageId = msgId
        chat.unreadCount = (messages[chatId] ?: emptyList<TdApi.Message>()).count { !it.isOutgoing && it.id > msgId }
        return TdApi.UpdateChatReadInbox(chatId, msgId, chat.unreadCount)
    }

    /** Собеседник прочитал моё сообщение (ReadNotice/read в sync). */
    @Synchronized
    fun markOutboxRead(uuid: String): TdApi.Update? {
        val msg = msgByUuid[uuid] ?: return null
        val chat = chats[msg.chatId] ?: return null
        if (msg.id <= chat.lastReadOutboxMessageId) return null
        chat.lastReadOutboxMessageId = msg.id
        return TdApi.UpdateChatReadOutbox(chat.id, msg.id)
    }
}
