package org.drinkless.tdlib

import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/**
 * Parvane: локальное состояние для синтеза объектов TdApi (аналог store.ts веба):
 * адрес ↔ id (FNV-1a, обрезка до 40 бит — диапазон TDLib для пользователей),
 * пользователи, чаты, сообщения по чатам (uuid ↔ id сообщения), файлы cloud
 * (file_id ↔ int id TdApi.File с локальным путём). Потокобезопасно через synchronized.
 */
class ParvaneStore {
    companion object {
        const val MAX_USER_ID = (1L shl 40) - 1 // TDLib: id пользователя < 2^40
        const val MAX_GROUP_HASH = (1L shl 39) - 1 // basic group id ≤ 999999999999 (X: ChatId.MAX_GROUP_ID)
    }
    /** Группа Parvane: group_id (uuid) ↔ basic group TdApi (chatId = -basicGroupId). */
    class GroupRef(val gid: String, var name: String, var members: List<String>, var createdBy: String,
                   val basicGroupId: Long, val chatId: Long) {
        var roles: Map<String, String> = emptyMap() // address → "admin" (создатель и обычные — по createdBy/умолчанию)
    }
    private val groupsByGid = ConcurrentHashMap<String, GroupRef>()
    private val groupsByChatId = ConcurrentHashMap<Long, GroupRef>()
    fun isGroup(address: String) = groupsByGid.containsKey(address)
    fun group(gid: String): GroupRef? = groupsByGid[gid]
    fun groupByChat(chatId: Long): GroupRef? = groupsByChatId[chatId]
    fun groupByBasicId(basicGroupId: Long): GroupRef? = groupsByChatId[-basicGroupId]
    private fun groupHash(gid: String): Long {
        var h = -3750763034362895579L
        for (b in gid.toByteArray(Charsets.UTF_8)) { h = h xor (b.toLong() and 0xff); h *= 1099511628211L }
        return (h and MAX_GROUP_HASH).let { if (it == 0L) 1L else it }
    }
    @Volatile var self: String = ""

    private val idByAddress = ConcurrentHashMap<String, Long>()
    private val addressById = ConcurrentHashMap<Long, String>()
    private val users = ConcurrentHashMap<Long, TdApi.User>()
    private val chats = ConcurrentHashMap<Long, TdApi.Chat>()
    private val profiles = ConcurrentHashMap<String, JSONObject>()
    // сообщения чата по возрастанию id; uuid → сообщение; (chatId,msgId) → uuid
    private val messages = ConcurrentHashMap<Long, ArrayList<TdApi.Message>>()
    private val msgByUuid = ConcurrentHashMap<String, TdApi.Message>()
    private val uuidByMsg = ConcurrentHashMap<Long, String>()      // (chatId<<20 ^ msgId) → uuid
    private val contentByUuid = ConcurrentHashMap<String, JSONObject>() // исходный content (для правок/пересылки)
    private var nextMessageId = 1L

    /** Файл cloud: file_id (uuid) + ключ/nonce blobcrypt + локальный путь после скачивания. */
    class FileRef(val id: Int, val remoteId: String, val key: String, val nonce: String,
                  val size: Long, val mime: String, @Volatile var path: String)
    private val filesByRemote = ConcurrentHashMap<String, FileRef>()
    private val filesById = ConcurrentHashMap<Int, FileRef>()
    private var nextFileId = 1

    fun clear() {
        users.clear(); chats.clear(); messages.clear(); msgByUuid.clear(); uuidByMsg.clear()
        contentByUuid.clear(); filesByRemote.clear(); filesById.clear()
        self = ""
    }

    /** Детерминированный id пользователя по адресу (FNV-1a 64 → 40 бит; локальный, на провод не уходит). */
    fun idOf(address: String): Long = idByAddress.getOrPut(address) {
        var h = -3750763034362895579L // 0xcbf29ce484222325
        for (b in address.toByteArray(Charsets.UTF_8)) {
            h = h xor (b.toLong() and 0xff)
            h *= 1099511628211L
        }
        val id = (h and MAX_USER_ID).let { if (it == 0L) 1L else it }
        addressById[id] = address
        id
    }

    fun addressOf(chatId: Long): String? = groupsByChatId[chatId]?.gid ?: addressById[chatId]
    /** Известные пользователи (кроме себя) — «Контакты» X (телефонной книги у нас нет). */
    fun knownUserIds(): LongArray = users.keys.filter { it != idOf(self) && addressById[it] != null && !isGroup(addressById[it]!!) }.toLongArray()
    val blocked = java.util.Collections.synchronizedSet(HashSet<String>())
    /** Все uuid чата (для очистки «для меня»). */
    fun uuidsOfChat(chatId: Long): List<String> = (messages[chatId] ?: emptyList<TdApi.Message>()).mapNotNull { uuidOf(chatId, it.id) }
    /** Убрать чат из списка (удаление чата): позиция order=0 → X скрывает. */
    @Synchronized
    fun removeChat(chatId: Long): List<TdApi.Update> {
        val chat = chats[chatId] ?: return emptyList()
        val uuids = uuidsOfChat(chatId)
        val out = ArrayList<TdApi.Update>(removeMessages(uuids))
        chat.positions = arrayOf(TdApi.ChatPosition(TdApi.ChatListMain(), 0L, false, null))
        out += TdApi.UpdateChatPosition(chatId, chat.positions[0])
        return out
    }
    fun chatIds(): List<Long> = chats.values.sortedByDescending { it.positions.firstOrNull()?.order ?: 0L }.map { it.id }
    fun chatById(id: Long): TdApi.Chat? = chats[id]
    fun chatByAddress(address: String): TdApi.Chat? = chats[idOf(address)]
    fun userById(id: Long): TdApi.User? = users[id]
    fun user(address: String): TdApi.User? = users[idOf(address)]
    fun hasProfile(address: String) = profiles.containsKey(address)
    fun profileField(address: String, key: String): String = profiles[address]?.optString(key).orEmpty()
    fun profileJson(address: String): JSONObject = profiles[address]?.let { JSONObject(it.toString()) } ?: JSONObject()
    fun setProfile(address: String, info: JSONObject) { profiles[address] = info }

    private fun displayName(address: String): String {
        val name = profiles[address]?.optString("display_name").orEmpty()
        return name.ifEmpty { address.substringBefore('@') }
    }

    // ── файлы ───────────────────────────────────────────────────────────────
    /** TdApi.File для блоба cloud; локальный путь известен → «скачан». */
    @Synchronized
    fun fileFor(remoteId: String, key: String, nonce: String, size: Long, mime: String, localPath: String = ""): TdApi.File {
        val ref = filesByRemote.getOrPut(remoteId) {
            FileRef(nextFileId++, remoteId, key, nonce, size, mime, localPath).also { filesById[it.id] = it }
        }
        if (localPath.isNotEmpty()) ref.path = localPath
        return tdFile(ref)
    }
    fun fileRef(fileId: Int): FileRef? = filesById[fileId]
    fun setFilePath(fileId: Int, path: String): TdApi.File? {
        val ref = filesById[fileId] ?: return null
        ref.path = path
        return tdFile(ref)
    }
    fun tdFile(ref: FileRef): TdApi.File {
        val done = ref.path.isNotEmpty()
        return TdApi.File(ref.id, ref.size, ref.size,
            TdApi.LocalFile(ref.path, true, false, false, done, 0, if (done) ref.size else 0, if (done) ref.size else 0),
            TdApi.RemoteFile(ref.remoteId, ref.remoteId, false, true, ref.size))
    }

    // ── содержимое ──────────────────────────────────────────────────────────
    // optString отдаёт строку "null" для JSON null — в списке чатов светилось «null» (10 сен 2026)
    private fun caption(c: JSONObject) = TdApi.FormattedText(if (c.isNull("caption")) "" else c.optString("caption"), arrayOf())

    /** TdApi-контент по нашему JSON (kind: text | photo | video | file | voice | video_note). */
    fun contentFrom(c: JSONObject): TdApi.MessageContent {
        val kind = c.optString("kind")
        val fid = c.optString("file_id")
        val size = c.optLong("size_bytes")
        val mime = c.optString("mime")
        val local = c.optString("local_path")
        val file = { if (fid.isEmpty()) null else fileFor(fid, c.optString("file_key"), c.optString("file_nonce"), size, mime, local) }
        return when (kind) {
            "photo" -> {
                val w = c.optInt("width", 800); val h = c.optInt("height", 600)
                val f = file() ?: return textContent(c)
                TdApi.MessagePhoto(TdApi.Photo(false, null, arrayOf(TdApi.PhotoSize("y", f, w, h, IntArray(0)))), null, caption(c), false, false, false)
            }
            "video" -> {
                val f = file() ?: return textContent(c)
                TdApi.MessageVideo(TdApi.Video(c.optInt("duration_secs"), c.optInt("width", 640), c.optInt("height", 480),
                    c.optString("filename", "video.mp4"), mime, false, true, null, null, f),
                    arrayOf(), arrayOf(), null, 0, caption(c), false, false, false)
            }
            "file" -> {
                val f = file() ?: return textContent(c)
                TdApi.MessageDocument(TdApi.Document(c.optString("filename", "file"), mime, null, null, f), caption(c))
            }
            "voice" -> {
                val f = file() ?: return textContent(c)
                TdApi.MessageVoiceNote(TdApi.VoiceNote(c.optInt("duration_secs"), ByteArray(0), mime, null, f), caption(c), false)
            }
            "video_note" -> {
                val f = file() ?: return textContent(c)
                TdApi.MessageVideoNote(TdApi.VideoNote(c.optInt("duration_secs"), ByteArray(0), c.optInt("width", 240), null, null, null, f), false, false)
            }
            "location" -> TdApi.MessageLocation(TdApi.Location(c.optDouble("lat"), c.optDouble("long"), 0.0))
            else -> textContent(c)
        }
    }

    private fun textContent(c: JSONObject): TdApi.MessageText =
        TdApi.MessageText(TdApi.FormattedText(if (c.isNull("text")) "" else c.optString("text"), arrayOf()), null, null)

    private fun reactionsFrom(arr: JSONArray?): TdApi.MessageInteractionInfo? {
        if (arr == null || arr.length() == 0) return null
        val list = ArrayList<TdApi.MessageReaction>()
        for (i in 0 until arr.length()) {
            val r = arr.getJSONObject(i)
            list += TdApi.MessageReaction(TdApi.ReactionTypeEmoji(r.optString("emoji")), r.optInt("count"), r.optBoolean("mine"), null, arrayOf())
        }
        return TdApi.MessageInteractionInfo(0, 0, null, TdApi.MessageReactions(list.toTypedArray(), false, arrayOf(), false))
    }

    /** Пользователь + приватный чат по адресу. created — впервые созданы. */
    @Synchronized
    fun ensurePeer(address: String): Triple<TdApi.User, TdApi.Chat, Boolean> {
        val id = idOf(address)
        val nick = address.substringBefore('@')
        val existed = chats.containsKey(id)
        val old = users[id]
        val user = TdApi.User().apply {
            this.id = id
            firstName = displayName(address)
            lastName = ""
            usernames = TdApi.Usernames(arrayOf(nick), arrayOf<String>(), nick, arrayOf<String>())
            phoneNumber = profiles[address]?.optString("phone").orEmpty()
            status = old?.status ?: TdApi.UserStatusOffline(0)
            profilePhoto = old?.profilePhoto
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
        chat.photo = user.profilePhoto?.let { TdApi.ChatPhotoInfo(it.small, it.big, it.minithumbnail, false, false) }
        chats[id] = chat
        return Triple(user, chat, !existed)
    }

    private fun memberStatus(g: GroupRef, address: String): TdApi.ChatMemberStatus = when {
        address == g.createdBy -> TdApi.ChatMemberStatusCreator(false, true)
        g.roles[address] == "admin" -> TdApi.ChatMemberStatusAdministrator(true,
            // manage, changeInfo, post, edit, delete, invite, restrict, pin, topics, promote, video, stories×3, directMsg, tags, welcome
            TdApi.ChatAdministratorRights(true, true, true, true, true, true, true, true, false, false, false, false, false, false, false, false, false, false))
        else -> TdApi.ChatMemberStatusMember(0)
    }

    /** Группа с сервера → basic group + чат. created — впервые. */
    @Synchronized
    fun ensureGroup(gid: String, name: String, members: List<String>, createdBy: String, roles: Map<String, String> = emptyMap()): Triple<TdApi.Chat, TdApi.BasicGroup, Boolean> {
        val existed = groupsByGid[gid]
        val g = existed ?: GroupRef(gid, name, members, createdBy, groupHash(gid), -groupHash(gid)).also {
            groupsByGid[gid] = it; groupsByChatId[it.chatId] = it
        }
        g.name = name; g.members = members; g.createdBy = createdBy
        val chat = chats[g.chatId] ?: TdApi.Chat().apply {
            id = g.chatId
            type = TdApi.ChatTypeBasicGroup(g.basicGroupId)
            permissions = TdApi.ChatPermissions(true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true)
            positions = arrayOf(TdApi.ChatPosition(TdApi.ChatListMain(), System.currentTimeMillis() / 1000, false, null))
            chatLists = arrayOf(TdApi.ChatListMain())
            notificationSettings = TdApi.ChatNotificationSettings(true, 0, true, 0, true, true, true, false, true, 0, true, true, true, false, true, false)
            availableReactions = TdApi.ChatAvailableReactionsAll(11)
            canBeDeletedOnlyForSelf = true
            canBeReported = false
            isTranslatable = false
            clientData = ""
        }
        chat.title = name
        chats[g.chatId] = chat
        return Triple(chat, basicGroup(g), existed == null)
    }
    fun basicGroup(g: GroupRef): TdApi.BasicGroup =
        TdApi.BasicGroup(g.basicGroupId, g.members.size, memberStatus(g, self), true, 0)
    fun basicGroupFullInfo(g: GroupRef): TdApi.BasicGroupFullInfo = TdApi.BasicGroupFullInfo().apply {
        description = ""
        creatorUserId = idOf(g.createdBy)
        members = g.members.map { m -> TdApi.ChatMember(TdApi.MessageSenderUser(idOf(m)), "", 0, 0, memberStatus(g, m)) }.toTypedArray()
        botCommands = arrayOf()
    }
    fun chatMember(g: GroupRef, address: String): TdApi.ChatMember =
        TdApi.ChatMember(TdApi.MessageSenderUser(idOf(address)), "", 0, 0, memberStatus(g, address))

    /** Аватар из cloud (уже скачан в path) → профиль пользователя и фото чата. */
    @Synchronized
    fun setUserPhoto(address: String, fileId: String, path: String): Pair<TdApi.User, TdApi.Chat>? {
        val id = idOf(address)
        val user = users[id] ?: return null
        val chat = chats[id] ?: return null
        val f = fileFor("avatar:$fileId", "", "", 0, "image/jpeg", path)
        user.profilePhoto = TdApi.ProfilePhoto(f.id.toLong(), f, f, null, false, false)
        chat.photo = TdApi.ChatPhotoInfo(f, f, null, false, false)
        return user to chat
    }

    /** Новое сообщение (дедуп по uuid → null). Обновляет lastMessage/position/unread чата. */
    @Synchronized
    fun putMessage(uuid: String, from: String, to: String, ts: Long, content: JSONObject, out: Boolean,
                   read: Boolean = false, replyUuid: String? = null, edited: Boolean = false,
                   pinned: Boolean = false, reactions: JSONArray? = null): TdApi.Message? {
        if (uuid.isEmpty() || msgByUuid.containsKey(uuid)) return null
        val group = groupsByGid[to]
        val chat = if (group != null) chats[group.chatId] ?: return null else ensurePeer(if (out) to else from).second
        val msgId = nextMessageId++ shl 20 // как серверные id TDLib (кратны 2^20)
        val msg = TdApi.Message().apply {
            id = msgId
            chatId = chat.id
            senderId = TdApi.MessageSenderUser(idOf(from))
            isOutgoing = out
            date = ts.toInt()
            editDate = if (edited) ts.toInt() else 0
            isPinned = pinned
            canBeSaved = true
            this.content = contentFrom(content)
            interactionInfo = reactionsFrom(reactions)
            val replied = replyUuid?.let { msgByUuid[it] }
            this.replyTo = if (replied != null) TdApi.MessageReplyToMessage(replied.chatId, replied.id, null, 0, null, null, 0, null) else null
            // пересланное: forwarded_name (wire как в вебе/десктопе) → «Переслано от …»
            val fwd = if (content.isNull("forwarded_name")) "" else content.optString("forwarded_name")
            if (fwd.isNotEmpty()) forwardInfo = TdApi.MessageForwardInfo(TdApi.MessageOriginHiddenUser(fwd), ts.toInt(), null, "")
        }
        messages.getOrPut(chat.id) { ArrayList() }.add(msg)
        msgByUuid[uuid] = msg
        uuidByMsg[key(chat.id, msgId)] = uuid
        contentByUuid[uuid] = content
        chat.lastMessage = msg
        chat.positions = arrayOf(TdApi.ChatPosition(TdApi.ChatListMain(), ts, false, null))
        if (!out && !read) chat.unreadCount += 1
        if (!out && read && msgId > chat.lastReadInboxMessageId) chat.lastReadInboxMessageId = msgId
        if (out && read) chat.lastReadOutboxMessageId = msgId
        return msg
    }

    private fun key(chatId: Long, msgId: Long) = (chatId shl 20) xor msgId
    fun uuidOf(chatId: Long, msgId: Long): String? = uuidByMsg[key(chatId, msgId)]
    fun messageByUuid(uuid: String): TdApi.Message? = msgByUuid[uuid]
    fun contentOf(uuid: String): JSONObject? = contentByUuid[uuid]

    /** Правка: новый контент → апдейты для UI. */
    @Synchronized
    fun applyEdit(uuid: String, content: JSONObject, editDate: Long): List<TdApi.Update> {
        val msg = msgByUuid[uuid] ?: return emptyList()
        msg.content = contentFrom(content)
        msg.editDate = editDate.toInt()
        contentByUuid[uuid] = content
        return listOf(TdApi.UpdateMessageContent(msg.chatId, msg.id, msg.content),
            TdApi.UpdateMessageEdited(msg.chatId, msg.id, msg.editDate, null))
    }

    /** Реакции/закреп изменились. */
    @Synchronized
    fun applyMeta(uuid: String, reactions: JSONArray?, pinned: Boolean): List<TdApi.Update> {
        val msg = msgByUuid[uuid] ?: return emptyList()
        val out = ArrayList<TdApi.Update>()
        msg.interactionInfo = reactionsFrom(reactions)
        out += TdApi.UpdateMessageInteractionInfo(msg.chatId, msg.id, msg.interactionInfo)
        if (msg.isPinned != pinned) {
            msg.isPinned = pinned
            out += TdApi.UpdateMessageIsPinned(msg.chatId, msg.id, pinned)
        }
        return out
    }

    /** Удаление (tombstone с сервера или своё). */
    @Synchronized
    fun removeMessages(uuids: List<String>): List<TdApi.Update> {
        val byChat = HashMap<Long, ArrayList<Long>>()
        for (uuid in uuids) {
            val msg = msgByUuid.remove(uuid) ?: continue
            uuidByMsg.remove(key(msg.chatId, msg.id)); contentByUuid.remove(uuid)
            messages[msg.chatId]?.removeAll { it.id == msg.id }
            byChat.getOrPut(msg.chatId) { ArrayList() }.add(msg.id)
        }
        val out = ArrayList<TdApi.Update>()
        byChat.forEach { (chatId, ids) ->
            out += TdApi.UpdateDeleteMessages(chatId, ids.toLongArray(), true, false)
            chats[chatId]?.let { chat ->
                chat.lastMessage = messages[chatId]?.lastOrNull()
                out += TdApi.UpdateChatLastMessage(chatId, chat.lastMessage, chat.positions)
            }
        }
        return out
    }

    /**
     * История чата как TDLib: от fromMessageId (0 — с конца) вниз, новые первыми;
     * отрицательный offset добавляет -offset более новых (X открывает чат от
     * lastReadInboxMessageId с offset=-limit/2 — без этого чат был пуст).
     */
    @Synchronized
    fun history(chatId: Long, fromMessageId: Long, offset: Int, limit: Int): TdApi.Messages {
        val all = messages[chatId] ?: return TdApi.Messages(0, arrayOf())
        if (all.isEmpty()) return TdApi.Messages(0, arrayOf())
        val endIdx = if (fromMessageId == 0L) all.size else all.indexOfFirst { it.id >= fromMessageId }.let { if (it < 0) all.size else it }
        var last = endIdx - 1 - offset // offset ≤ 0 → захватываем новее from
        if (last > all.size - 1) last = all.size - 1
        if (last < 0) return TdApi.Messages(all.size, arrayOf())
        val first = maxOf(0, last - limit + 1)
        val page = all.subList(first, last + 1).reversed()
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

    /** Прочитано на другом устройстве (ReadNotice / read_message_ids): по uuid → по чатам. */
    @Synchronized
    fun markInboxReadUuids(uuids: List<String>): List<TdApi.Update> {
        val maxByChat = HashMap<Long, Long>()
        for (uuid in uuids) {
            val msg = msgByUuid[uuid] ?: continue
            if (msg.isOutgoing) continue
            if ((maxByChat[msg.chatId] ?: 0L) < msg.id) maxByChat[msg.chatId] = msg.id
        }
        return maxByChat.mapNotNull { (chatId, msgId) -> markInboxRead(chatId, msgId) }
    }

    /** Собеседник прочитал моё сообщение (read=true у своего в sync). */
    @Synchronized
    fun markOutboxRead(uuid: String): TdApi.Update? {
        val msg = msgByUuid[uuid] ?: return null
        val chat = chats[msg.chatId] ?: return null
        if (msg.id <= chat.lastReadOutboxMessageId) return null
        chat.lastReadOutboxMessageId = msg.id
        return TdApi.UpdateChatReadOutbox(chat.id, msg.id)
    }

    // ── уведомления (блоб веба: {defaults:{users|groups|channels:{mutedUntil,hasSound}}, exceptions:{address:{…}}}) ──
    val notifyDefaults = JSONObject()
    val notifyExceptions = JSONObject()
    private fun muteFor(s: JSONObject?): Int {
        if (s == null || !s.has("mutedUntil") || s.isNull("mutedUntil")) return 0
        val until = s.optLong("mutedUntil")
        val now = System.currentTimeMillis() / 1000
        return when {
            until <= 0 || until <= now -> 0
            until >= 2147483647L -> Int.MAX_VALUE // навсегда
            else -> (until - now).toInt()
        }
    }
    fun chatNotifySettings(address: String): TdApi.ChatNotificationSettings {
        val ex = notifyExceptions.optJSONObject(address)
        val muted = muteFor(ex)
        val useDefault = ex == null || !ex.has("mutedUntil")
        return TdApi.ChatNotificationSettings(useDefault, muted, true, 0, true, true, true, false, true, 0, true, true, true, false, true, false)
    }
    fun scopeSettings(scope: String): TdApi.ScopeNotificationSettings {
        val d = notifyDefaults.optJSONObject(scope)
        return TdApi.ScopeNotificationSettings(muteFor(d), 0, true, false, false, 0, true, false, false)
    }
    /** Применить блоб с сервера/другого устройства → апдейты для известных чатов. */
    @Synchronized
    fun applyNotifyBlob(blob: JSONObject): List<TdApi.Update> {
        val out = ArrayList<TdApi.Update>()
        blob.optJSONObject("defaults")?.let { d -> d.keys().forEach { k -> notifyDefaults.put(k, d.optJSONObject(k)) } }
        blob.optJSONObject("exceptions")?.let { ex ->
            ex.keys().forEach { address ->
                notifyExceptions.put(address, ex.optJSONObject(address))
                val chatId = groupsByGid[address]?.chatId ?: idByAddress[address] ?: return@forEach
                chats[chatId]?.let { chat ->
                    chat.notificationSettings = chatNotifySettings(address)
                    out += TdApi.UpdateChatNotificationSettings(chatId, chat.notificationSettings)
                }
            }
        }
        listOf("users" to TdApi.NotificationSettingsScopePrivateChats(), "groups" to TdApi.NotificationSettingsScopeGroupChats(), "channels" to TdApi.NotificationSettingsScopeChannelChats())
            .forEach { (k, scope) -> if (notifyDefaults.has(k)) out += TdApi.UpdateScopeNotificationSettings(scope, scopeSettings(k)) }
        return out
    }
    /** Локальное изменение мута чата → запись в exceptions + блоб для сервера. */
    @Synchronized
    fun setChatMute(address: String, muteFor: Int): String {
        val until = when { muteFor <= 0 -> 0L; muteFor >= 365 * 24 * 3600 -> 2147483647L; else -> System.currentTimeMillis() / 1000 + muteFor }
        notifyExceptions.put(address, JSONObject().put("mutedUntil", until))
        (groupsByGid[address]?.chatId ?: idByAddress[address])?.let { chats[it]?.notificationSettings = chatNotifySettings(address) }
        return JSONObject().put("defaults", notifyDefaults).put("exceptions", notifyExceptions).toString()
    }
    @Synchronized
    fun setScopeMute(scope: String, muteFor: Int): String {
        val until = when { muteFor <= 0 -> 0L; muteFor >= 365 * 24 * 3600 -> 2147483647L; else -> System.currentTimeMillis() / 1000 + muteFor }
        notifyDefaults.put(scope, JSONObject().put("mutedUntil", until))
        return JSONObject().put("defaults", notifyDefaults).put("exceptions", notifyExceptions).toString()
    }

    /** Статус онлайн пира (presence-хартбит → online до now+90). */
    @Synchronized
    fun setOnline(address: String, expires: Int): TdApi.Update? {
        val user = users[idOf(address)] ?: return null
        user.status = TdApi.UserStatusOnline(expires)
        return TdApi.UpdateUserStatus(user.id, user.status)
    }
}
