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
        // spec 004: формат инвайт-ссылки — как у desktop (web открывает её legacy-веткой)
        const val INVITE_HOST = "https://parvane.invite/"
        private val HEX32 = Regex("^[0-9a-f]{32}$")
        private val HASH_TOKEN = Regex("#\\+([0-9a-f]{32})")
        /** Ссылка v2 (spec 007, T084): токен — сама ссылка https://<domain>/join/<link_id>#<seed>. */
        fun buildInviteLink(token: String) = if (V2_INVITE.matches(token)) token else INVITE_HOST + token
        /** Ссылка-приглашение v2 (D-04): https://<domain>/join/<link_id>#<seed> (base64url, 32 байта). */
        private val V2_INVITE = Regex("^https://[^/\\s]+/join/[A-Za-z0-9_-]{43}#[A-Za-z0-9_-]{43}$")
        /** Токен из ссылки любого формата: parvane.invite/<t>, …#+<t>, голый 32 hex; null — не наша. */
        fun inviteTokenOf(linkOrToken: String?): String? {
            val u = linkOrToken?.trim() ?: return null
            if (V2_INVITE.matches(u)) return u // v2 — сама ссылка (формы v1 — только как вход v1)
            if (HEX32.matches(u)) return u
            HASH_TOKEN.find(u)?.let { return it.groupValues[1] }
            for (prefix in listOf("https://parvane.invite/", "http://parvane.invite/", "parvane.invite/")) {
                if (u.startsWith(prefix, ignoreCase = true)) {
                    val t = u.substring(prefix.length).substringBefore('/').substringBefore('?')
                    return if (HEX32.matches(t)) t else null
                }
            }
            return null
        }
        /** Обратно к 8 разрешениям провода из ChatPermissions экрана «Permissions». */
        fun permissionsToWire(p: TdApi.ChatPermissions): JSONObject = JSONObject()
            .put("send_messages", p.canSendBasicMessages)
            .put("send_media", p.canSendAudios || p.canSendDocuments || p.canSendPhotos || p.canSendVideos || p.canSendVideoNotes || p.canSendVoiceNotes)
            .put("send_stickers_gifs", p.canSendOtherMessages)
            .put("send_polls", p.canSendPolls)
            .put("embed_links", p.canAddLinkPreviews)
            .put("invite_users", p.canInviteUsers)
            .put("pin_messages", p.canPinMessages)
            .put("change_info", p.canChangeInfo)
        /** Обратно к 6 правам провода из ChatAdministratorRights экрана «Edit admin». */
        fun adminRightsToWire(r: TdApi.ChatAdministratorRights): JSONObject = JSONObject()
            .put("change_info", r.canChangeInfo)
            .put("delete_messages", r.canDeleteMessages)
            .put("ban_users", r.canRestrictMembers)
            .put("invite_users", r.canInviteUsers)
            .put("pin_messages", r.canPinMessages)
            .put("add_admins", r.canPromoteMembers)
    }
    /** Группа Parvane: group_id (uuid) ↔ basic group TdApi (chatId = -basicGroupId). */
    class GroupRef(val gid: String, var name: String, var members: List<String>, var createdBy: String,
                   val basicGroupId: Long, val chatId: Long) {
        var roles: Map<String, String> = emptyMap() // address → "admin" (создатель и обычные — по createdBy/умолчанию)
        // spec 003: гранулярные права админов (address → JSON admin_rights; нет — полный набор, legacy)
        var adminRights: Map<String, JSONObject> = emptyMap()
        var about: String = ""
        var avatarFileId: String = ""
        var avatarKey: String = "" // секрет фото частной группы (GPHOTO-1), с которым скачан avatarFileId
        var permissions: JSONObject? = null // default_permissions провода; null — по умолчанию
        var version: Long = -1 // ревизия сведений (GROUP-1); -1 — не известна
        // spec 004: заявки (только менеджерам ссылок; 0 — нет/не отдано) и основная ссылка (кэш invite.list)
        var pendingRequests: Int = 0
        var primaryInviteLink: TdApi.ChatInviteLink? = null
        // PUBLIC-1 (spec 023): публичная группа и её имя в общем пространстве ников
        var isPublic: Boolean = false
        var publicName: String = ""
        var publicPreview: Boolean = true
        var publicHistory: Boolean = true
    }

    // ── spec 004: чистые маппинги для экранов управления X (JVM-тесты) ──────────
    /** Ссылка провода (13 полей) → TdApi.ChatInviteLink. */
    fun inviteLinkOf(l: JSONObject): TdApi.ChatInviteLink = TdApi.ChatInviteLink(
        buildInviteLink(l.optString("token")), l.optString("title", ""), idOf(l.optString("created_by")),
        l.optInt("created_at"), 0, l.optInt("expires_at"), null, l.optInt("max_uses"), l.optInt("uses"), 0,
        l.optInt("pending_requests"), l.optBoolean("request_needed"), l.optBoolean("is_primary"), l.optBoolean("revoked"))
    /** Превью group.invite.check → TdApi.ChatInviteLinkInfo (chatId — только если уже участник). */
    fun inviteLinkInfoOf(j: JSONObject): TdApi.ChatInviteLinkInfo {
        val gid = j.optString("group_id")
        val chatId = if (j.optBoolean("already_member")) (groupsByGid[gid]?.chatId ?: 0L) else 0L
        val type: TdApi.InviteLinkChatType = if (j.optString("kind") == "channel") TdApi.InviteLinkChatTypeChannel() else TdApi.InviteLinkChatTypeBasicGroup()
        return TdApi.ChatInviteLinkInfo(chatId, 0, type, j.optString("name", ""), null, 0, j.optString("about", ""),
            j.optInt("members_count"), LongArray(0), null, j.optBoolean("request_needed"), false, null)
    }
    /** Ответ group.join → ChatJoinResult* либо Error(400, код). */
    fun joinResultOf(j: JSONObject): TdApi.Object = when {
        j.optBoolean("ok") && j.optBoolean("pending") -> TdApi.ChatJoinResultRequestSent()
        j.optBoolean("ok") -> TdApi.ChatJoinResultSuccess(groupsByGid[j.optString("group_id")]?.chatId ?: 0L)
        j.optString("error_code") == "declined" -> TdApi.ChatJoinResultDeclined()
        else -> TdApi.Error(400, j.optString("error_code").ifEmpty { j.optString("error", "failed") })
    }
    /** Заявки group.request.list → TdApi.ChatJoinRequests. */
    fun joinRequestsOf(arr: JSONArray?): TdApi.ChatJoinRequests {
        val list = ArrayList<TdApi.ChatJoinRequest>()
        if (arr != null) for (i in 0 until arr.length()) {
            val r = arr.getJSONObject(i)
            list += TdApi.ChatJoinRequest(idOf(r.optString("member")), r.optInt("created_at"), "")
        }
        return TdApi.ChatJoinRequests(list.size, list.toTypedArray())
    }
    /** Роль участника: owner|admin|member|null (не участник / нет сведений). */
    fun roleOf(g: GroupRef?, address: String): String? = when {
        g == null -> null
        address == g.createdBy -> "owner"
        g.roles[address] == "admin" -> "admin"
        g.members.contains(address) -> "member"
        else -> null
    }

    /** Права участников по умолчанию провода → TdApi.ChatPermissions (16 полей бандла X). */
    fun chatPermissionsOf(p: JSONObject?): TdApi.ChatPermissions {
        fun b(k: String, d: Boolean) = p?.optBoolean(k, d) ?: d
        val send = b("send_messages", true)
        val media = send && b("send_media", true)
        val stickers = send && b("send_stickers_gifs", true)
        val polls = send && b("send_polls", true)
        val links = send && b("embed_links", true)
        // basic, audios, documents, photos, videos, videoNotes, voiceNotes, polls, other(стикеры/анимации), linkPreviews,
        // react, editTag, changeInfo, inviteUsers, pinMessages, createTopics
        return TdApi.ChatPermissions(send, media, media, media, media, media, media, polls, stickers, links,
            true, false, b("change_info", false), b("invite_users", true), b("pin_messages", false), false)
    }

    /** Права админа провода (нет — полный набор) → TdApi.ChatAdministratorRights (18 полей бандла X). */
    fun adminRightsOf(r: JSONObject?): TdApi.ChatAdministratorRights {
        fun b(k: String) = r?.optBoolean(k, true) ?: true
        // manage, changeInfo, post, edit, delete, invite, restrict, pin, topics, promote, video, stories×3, directMsg, tags, welcome
        return TdApi.ChatAdministratorRights(true, b("change_info"), false, false, b("delete_messages"), b("invite_users"),
            b("ban_users"), b("pin_messages"), false, b("add_admins"), false, false, false, false, false, false, false, false)
    }
    private val groupsByGid = ConcurrentHashMap<String, GroupRef>()
    private val groupsByChatId = ConcurrentHashMap<Long, GroupRef>()
    fun groups(): Collection<GroupRef> = groupsByGid.values
    fun isGroup(address: String) = groupsByGid.containsKey(address)
    fun group(gid: String): GroupRef? = groupsByGid[gid]
    fun groupByChat(chatId: Long): GroupRef? = groupsByChatId[chatId]
    /** Группа по названию (сценарии эмулятора; совпадений несколько — последняя заведённая). */
    fun groupByName(name: String): GroupRef? = groupsByGid.values.lastOrNull { it.name == name }
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
    private val uuidByMsg = ConcurrentHashMap<Pair<Long, Long>, String>() // (chatId, msgId) → uuid
    private val contentByUuid = ConcurrentHashMap<String, JSONObject>() // исходный content (для правок/пересылки)
    // spec 036 T035 (ENGINE-1): лента X — страницами модели (GetChatHistory → historyPage), в памяти шва — только
    // показанное. Id сообщения X — из места строки в ленте модели (ORDER-1, `order`): страница старых строк, пришедшая
    // позже, встаёт ниже показанного; id известен и до загрузки строки (граница «прочитано до»).
    private val reservedIds = ConcurrentHashMap<String, Long>() // uuid → id, выданный до загрузки строки
    private val orderByUuid = ConcurrentHashMap<String, Long>()  // место строки в ленте (мс)
    private val maxOrder = ConcurrentHashMap<Long, Long>()       // чат → наибольшее место показанного
    /** Строка списка чатов модели (`ChatView`, spec 036 T035): закреп, архив, отметка, мут, место. */
    data class ModelChat(val order: Long, val pinnedRank: Int, val archived: Boolean, val unreadMark: Boolean,
                         val mutedUntilMs: Long, val unread: Int)
    private val modelChats = ConcurrentHashMap<Long, ModelChat>()
    /** Страница модели: строки событиями "message" (старые первыми). */
    class Page(val rows: List<JSONObject>, val hasOlder: Boolean, val hasNewer: Boolean)
    /** Страница модели для чата (адрес, якорь-uuid или "", older|newer|around, limit); null — модели нет (ставит Client). */
    @Volatile var pager: ((String, String, String, Int) -> Page?)? = null
    /** Строка страницы → сообщение X в памяти шва (та же сборка, что у живого события; ставит Client); null — не показывается. */
    @Volatile var materialize: ((JSONObject) -> TdApi.Message?)? = null

    /** Сценарии (dev): названия чатов и тексты сообщений, известные шву, — проверить, что всё пришло сразу. */
    fun e2eDump(): JSONObject {
        val titles = org.json.JSONArray()
        chats.values.forEach { titles.put(it.title) }
        val texts = org.json.JSONArray()
        val byChat = JSONObject()
        messages.forEach { (chatId, list) ->
            val chatTexts = org.json.JSONArray()
            synchronized(list) { list.toList() }.forEach { m ->
                (m.content as? TdApi.MessageText)?.text?.text?.let { texts.put(it); chatTexts.put(it) }
            }
            byChat.put(chats[chatId]?.title ?: chatId.toString(), chatTexts)
        }
        val last = JSONObject()
        chats.values.forEach { c -> (c.lastMessage?.content as? TdApi.MessageText)?.text?.text?.let { last.put(c.title, it) } }
        return JSONObject().put("chats", titles).put("texts", texts).put("byChat", byChat).put("last", last)
    }

    /** Файл cloud: file_id (uuid) + ключ/nonce blobcrypt + локальный путь после скачивания. */
    class FileRef(val id: Int, val remoteId: String, val key: String, val nonce: String,
                  size: Long, val mime: String, @Volatile var path: String) {
        @Volatile var size: Long = size
        /** Файл пишет X (голосовое, «кружок», PreliminaryUploadFile): путь известен, но файл ещё не готов. */
        @Volatile var generating = false
    }
    private val filesByRemote = ConcurrentHashMap<String, FileRef>()
    private val filesById = ConcurrentHashMap<Int, FileRef>()
    private var nextFileId = 1

    fun clear() {
        users.clear(); chats.clear(); messages.clear(); msgByUuid.clear(); uuidByMsg.clear()
        reservedIds.clear(); orderByUuid.clear(); maxOrder.clear(); modelChats.clear()
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
        var id = (h and MAX_USER_ID).let { if (it == 0L) 1L else it }
        // Коллизия 40-битного хеша: id занят другим адресом — берём следующий свободный, чужой чат не перехватывается
        while (true) {
            val prev = addressById.putIfAbsent(id, address)
            if (prev == null || prev == address) break
            id = if (id >= MAX_USER_ID) 1L else id + 1
        }
        id
    }

    fun addressOf(chatId: Long): String? = groupsByChatId[chatId]?.gid ?: addressById[chatId]

    // ── RENAME-1: собеседник сменил ник — тот же чат (id прежнего адреса), отправка — на новый адрес ──
    /** Прежний адрес → новый (цепочки сворачиваются); переживает рестарт через [renamesFile]. */
    private val renames = ConcurrentHashMap<String, String>()
    @Volatile var renamesFile: java.io.File? = null

    /** Последний адрес цепочки смен ника. */
    fun latestAddress(address: String): String {
        var a = address
        repeat(16) { a = renames[a] ?: return a }
        return a
    }

    /** Смена ника: новый адрес получает id прежнего (сообщения встают в прежний чат). false — уже известно. */
    @Synchronized
    fun noteRename(from: String, to: String): Boolean {
        if (from.isEmpty() || to.isEmpty() || from == to || renames[from] == to) return false
        renames[from] = to
        val id = idOf(from)
        idByAddress[to] = id
        addressById[id] = to
        profiles[from]?.let { p -> if (!profiles.containsKey(to)) profiles[to] = JSONObject(p.toString()).put("username", to) }
        renamesFile?.let { f -> try { SeamFiles.write(f, JSONObject(renames as Map<*, *>).toString()) } catch (e: Exception) { } }
        return true
    }

    fun loadRenames() {
        val f = renamesFile?.takeIf { SeamFiles.exists(it) } ?: return
        val j = try { JSONObject(SeamFiles.read(f)) } catch (e: Exception) { return }
        for (k in j.keys()) noteRename(k, j.optString(k))
    }

    /** DELETE-1: аккаунт собеседника удалён — «Удалённый аккаунт» вместо имени. */
    fun markDeleted(address: String, deletedName: String): TdApi.User? {
        val u = users[idOf(address)] ?: return null
        u.firstName = deletedName; u.lastName = ""
        u.type = TdApi.UserTypeDeleted()
        return u
    }
    /** Известные пользователи (кроме себя) — «Контакты» X (телефонной книги у нас нет). */
    fun knownUserIds(): LongArray = users.keys.filter { it != idOf(self) && addressById[it] != null && !isGroup(addressById[it]!!) }.toLongArray()
    val blocked = java.util.Collections.synchronizedSet(HashSet<String>())
    /** Все uuid чата (для очистки «для меня»). */
    fun uuidsOfChat(chatId: Long): List<String> = (messages[chatId] ?: emptyList<TdApi.Message>()).mapNotNull { uuidOf(chatId, it.id) }
    /** Сообщения чата не позже момента (сек) — очистка чата с другого своего устройства (T145). */
    fun uuidsOfChatUntil(chatId: Long, untilSec: Long): List<String> =
        (messages[chatId] ?: emptyList<TdApi.Message>()).filter { it.date.toLong() <= untilSec }.mapNotNull { uuidOf(chatId, it.id) }
    /** Время самого позднего сообщения чата (сек), 0 — сообщений нет. */
    fun lastDateOfChat(chatId: Long): Long = (messages[chatId] ?: emptyList<TdApi.Message>()).maxOfOrNull { it.date.toLong() } ?: 0L
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

    /** Имя для показа: своё имя контакта (CONTACT-1), иначе заданное самим собеседником. */
    internal fun displayName(address: String): String =
        local?.contactOf(address)?.name?.takeIf { it.isNotEmpty() && address != self } ?: publicName(address)
    /** Имя, заданное самим собеседником (в провод и в форму контакта — оно, не своё). */
    fun publicName(address: String): String {
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
    /** Запись файла, который пишет X ([PreliminaryUploads]): путь назначения сразу, «загружен» — после генерации. */
    fun generatedFile(path: String, mime: String): TdApi.File {
        val ref = filesByRemote.getOrPut("gen:$path") {
            FileRef(nextFileId++, "gen:$path", "", "", 0, mime, path).also { filesById[it.id] = it }
        }
        ref.generating = true
        return tdFile(ref)
    }
    /** Генерация закончилась: файл готов (размер с диска) либо нет — запись остаётся неготовой. */
    fun finishGenerated(fileId: Int, ok: Boolean): TdApi.File? {
        val ref = filesById[fileId] ?: return null
        if (ok) { ref.size = java.io.File(ref.path).length(); ref.generating = false }
        return tdFile(ref)
    }
    fun tdFile(ref: FileRef): TdApi.File {
        val done = ref.path.isNotEmpty() && !ref.generating
        return TdApi.File(ref.id, ref.size, ref.size,
            TdApi.LocalFile(ref.path, true, false, false, done, 0, if (done) ref.size else 0, if (done) ref.size else 0),
            TdApi.RemoteFile(ref.remoteId, ref.remoteId, false, true, ref.size))
    }

    // ── содержимое: перевод готового содержимого в TdApi — MessageContents.kt ──
    /** Опросы (spec 005): агрегат локальный, uuid сообщения = id опроса. */
    val polls = PollStore()
    /** Вид группы (group|channel) по gid — из сведений сервера (для папок). */
    val groupKind = HashMap<String, String>()
    /** Локальное состояние чатов (spec 005): TTL/черновики/архив; ставится Client'ом, когда известен каталог ядра. */
    @Volatile var local: ChatLocalState? = null
    fun positionsFor(chatId: Long, order: Long): Array<TdApi.ChatPosition> {
        // spec 036 T035: архив и закреп — из списка чатов модели (`ChatView.archived/pinned_rank`); чата в нём нет —
        // по объектам личного состояния
        val mc = modelChats[chatId]
        val l = local
        if (mc == null || l == null) {
            return l?.positionsFor(chatId, order, chatFacts(chatId)) ?: arrayOf(TdApi.ChatPosition(TdApi.ChatListMain(), order, false, null))
        }
        val pinned = mc.pinnedRank > 0
        val out = ArrayList<TdApi.ChatPosition>()
        out.add(TdApi.ChatPosition(if (mc.archived) TdApi.ChatListArchive() else TdApi.ChatListMain(),
            if (pinned) ChatLocalState.PIN_ORDER_BASE - (mc.pinnedRank - 1) else order, pinned, null))
        out.addAll(l.folderPositions(chatId, order, chatFacts(chatId)))
        return out.toTypedArray()
    }
    /** Место чата в списке (с): модели, иначе последнее показанное сообщение. */
    fun orderOf(chatId: Long): Long = modelChats[chatId]?.order?.takeIf { it > 0 }?.let { it / 1000 } ?: lastDateOfChat(chatId)
    fun modelChat(chatId: Long): ModelChat? = modelChats[chatId]
    /**
     * Строка списка чатов модели (`chat_upsert`, `chatList`): закреп, архив, отметка, мут, место — в чат X. Возвращает
     * апдейты (позиции — со снятием из прежнего списка, отметка, уведомления); чата нет — пусто.
     */
    @Synchronized
    fun applyModelChat(chatId: Long, mc: ModelChat): List<TdApi.Update> {
        val chat = chats[chatId] ?: return emptyList()
        val prev = modelChats.put(chatId, mc)
        val out = ArrayList<TdApi.Update>()
        val oldMain = chat.positions.firstOrNull()?.list
        val order = maxOf(mc.order / 1000, if (mc.order > 0) 0L else lastDateOfChat(chatId))
        chat.positions = positionsFor(chatId, order)
        val newMain = chat.positions.firstOrNull()?.list
        if (oldMain != null && newMain != null && oldMain.constructor != newMain.constructor)
            out += TdApi.UpdateChatPosition(chatId, TdApi.ChatPosition(oldMain, 0L, false, null))
        if (prev == null || prev.order != mc.order || prev.pinnedRank != mc.pinnedRank || prev.archived != mc.archived || oldMain?.constructor != newMain?.constructor)
            chat.positions.forEach { out += TdApi.UpdateChatPosition(chatId, it) }
        if (chat.isMarkedAsUnread != mc.unreadMark) {
            chat.isMarkedAsUnread = mc.unreadMark
            out += TdApi.UpdateChatIsMarkedAsUnread(chatId, mc.unreadMark)
        }
        // Мут — признак модели; звук и показ текста — объекты уведомлений (notifyExceptions)
        val address = addressOf(chatId)
        if (address != null) {
            val s = chatNotifySettings(address)
            val now = System.currentTimeMillis() / 1000
            val until = mc.mutedUntilMs / 1000
            if (until > now) { s.useDefaultMuteFor = false; s.muteFor = if (until >= 2147483647L) Int.MAX_VALUE else (until - now).toInt() }
            else if (!s.useDefaultMuteFor && s.muteFor > 0) s.muteFor = 0
            val was = chat.notificationSettings
            if (was == null || was.muteFor != s.muteFor || was.useDefaultMuteFor != s.useDefaultMuteFor) {
                chat.notificationSettings = s
                out += TdApi.UpdateChatNotificationSettings(chatId, s)
            }
        }
        return out
    }
    /** Своя правка закрепа/архива (до ответа модели): вид модели чатов — с ней, чтобы позиции не откатывались. */
    @Synchronized
    fun overlayLocal(chatIds: Collection<Long>) {
        val l = local ?: return
        val pins = l.pinnedChatIds()
        for (id in chatIds) {
            val mc = modelChats[id] ?: continue
            modelChats[id] = mc.copy(archived = l.isArchived(id), pinnedRank = pins.indexOf(id) + 1)
        }
    }
    /** Чат снят моделью (`chat_remove`): пустая строка уходит из списка (с сообщениями — остаётся: своё отправляемое). */
    @Synchronized
    fun removeModelChat(chatId: Long): List<TdApi.Update> {
        modelChats.remove(chatId) ?: return emptyList()
        val chat = chats[chatId] ?: return emptyList()
        if (chat.lastMessage != null) return emptyList()
        val list = chat.positions.firstOrNull()?.list ?: TdApi.ChatListMain()
        chat.positions = arrayOf(TdApi.ChatPosition(list, 0L, false, null))
        return listOf(TdApi.UpdateChatPosition(chatId, chat.positions[0]))
    }
    /** Признаки чата для членства в папках (группа/канал/контакт/мут/прочитан/архив). */
    fun chatFacts(chatId: Long): Folders.ChatFacts {
        val chat = chats[chatId]
        val g = groupsByChatId[chatId]
        val muted = (chat?.notificationSettings?.muteFor ?: 0) > 0
        val kind = g?.let { groupKind[it.gid] } ?: ""
        return Folders.ChatFacts(isGroup = g != null && kind != "channel", isChannel = kind == "channel", isContact = g == null,
            isMuted = muted, isRead = (chat?.unreadCount ?: 0) == 0, isArchived = local?.isArchived(chatId) == true)
    }
    /** Локальное состояние появилось после создания чатов — применить его к уже созданным. */
    fun applyLocalToExisting() { chats.values.forEach { applyLocal(it) } }

    /** Применить TTL/черновик к чату из локального состояния (при создании и при восстановлении). */
    fun applyLocal(chat: TdApi.Chat) {
        val l = local ?: return
        val address = addressOf(chat.id)
        if (address != null && !isGroup(address)) chat.messageAutoDeleteTime = l.ttlOf(address)
        chat.draftMessage = l.tdDraft(chat.id)
        chat.positions = positionsFor(chat.id, chat.positions.firstOrNull()?.order ?: 0L)
    }

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
            // CONTACT-1: своё имя контакта — как у Telegram, имя и фамилия отдельно (форма «Изменить» X их и правит)
            val own = local?.contactOf(address)?.takeIf { it.name.isNotEmpty() && address != self }
            firstName = own?.let { it.first.ifEmpty { it.last } } ?: publicName(address)
            lastName = own?.takeIf { it.first.isNotEmpty() }?.last ?: ""
            usernames = TdApi.Usernames(arrayOf(nick), arrayOf<String>(), nick, arrayOf<String>())
            phoneNumber = profiles[address]?.optString("phone").orEmpty()
            accentColorId = (profiles[address]?.optInt("name_color", -1) ?: -1).let { if (it in 0..6) it else 0 } // цвет имени (web/desktop name_color)
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
            notificationSettings = chatNotifySettings(address) // мут, пришедший журналом раньше чата (STATE-2 notify)
            availableReactions = TdApi.ChatAvailableReactionsAll(11)
            isMarkedAsUnread = local?.isMarkedUnread(this.id) == true
            canBeDeletedOnlyForSelf = true
            canBeReported = true
            isTranslatable = false
            clientData = ""
        }
        if (!existed) applyLocal(chat)
        chat.title = listOf(user.firstName, user.lastName).filter { !it.isNullOrEmpty() }.joinToString(" ")
        chat.photo = user.profilePhoto?.let { TdApi.ChatPhotoInfo(it.small, it.big, it.minithumbnail, false, false) }
        chats[id] = chat
        return Triple(user, chat, !existed)
    }

    private fun memberStatus(g: GroupRef, address: String): TdApi.ChatMemberStatus = when {
        address !in g.members && g.createdBy != address -> TdApi.ChatMemberStatusLeft() // публичная группа без вступления (PUBLIC-1)
        address == g.createdBy -> TdApi.ChatMemberStatusCreator(false, true)
        g.roles[address] == "admin" -> TdApi.ChatMemberStatusAdministrator(true, adminRightsOf(g.adminRights[address]))
        else -> TdApi.ChatMemberStatusMember(0)
    }

    /** Группа с сервера → basic group + чат. created — впервые. Сведения с
     *  ревизией ниже известной не применяются (GROUP-1): возвращается null. */
    @Synchronized
    fun ensureGroup(gid: String, name: String, members: List<String>, createdBy: String, roles: Map<String, String> = emptyMap(),
                    info: JSONObject? = null): Triple<TdApi.Chat, TdApi.BasicGroup, Boolean>? {
        val existed = groupsByGid[gid]
        val version = info?.optLong("version", -1L) ?: -1L
        // Сведения без ревизии (старый сервер) при известной тоже не применяем — как web/desktop
        if (existed != null && existed.version >= 0 && info != null && version < existed.version) return null
        val g = existed ?: GroupRef(gid, name, members, createdBy, groupHash(gid), -groupHash(gid)).also {
            groupsByGid[gid] = it; groupsByChatId[it.chatId] = it
        }
        g.name = name; g.members = members; g.createdBy = createdBy; g.roles = roles
        if (info != null) {
            g.version = version
            g.about = info.optString("about", "")
            g.avatarFileId = if (info.isNull("avatar")) "" else info.optString("avatar", "")
            g.permissions = info.optJSONObject("default_permissions")
            val rights = HashMap<String, JSONObject>()
            info.optJSONArray("members")?.let { arr ->
                for (i in 0 until arr.length()) {
                    val mo = arr.getJSONObject(i)
                    mo.optJSONObject("admin_rights")?.let { rights[mo.optString("address")] = it }
                }
            }
            g.adminRights = rights
            g.pendingRequests = info.optInt("pending_requests", -1).coerceAtLeast(0)
            g.isPublic = info.optBoolean("is_public", false)
            g.publicName = if (info.isNull("public_name")) "" else info.optString("public_name", "")
            // без поля (старый мост) — прежнее умолчание «включено»; движок отдаёт флажки группы как есть
            g.publicPreview = info.optBoolean("public_preview", true)
            g.publicHistory = info.optBoolean("public_history", true)
        }
        val chat = chats[g.chatId] ?: TdApi.Chat().apply {
            id = g.chatId
            type = TdApi.ChatTypeBasicGroup(g.basicGroupId)
            permissions = TdApi.ChatPermissions(true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true)
            positions = arrayOf(TdApi.ChatPosition(TdApi.ChatListMain(), System.currentTimeMillis() / 1000, false, null))
            chatLists = arrayOf(TdApi.ChatListMain())
            notificationSettings = chatNotifySettings(gid) // мут группы, пришедший журналом раньше чата
            availableReactions = TdApi.ChatAvailableReactionsAll(11)
            isMarkedAsUnread = local?.isMarkedUnread(this.id) == true
            canBeDeletedOnlyForSelf = true
            canBeReported = true
            isTranslatable = false
            clientData = ""
        }
        chat.title = name
        // Права по умолчанию — только у групп; в канале пишут владелец и админы
        chat.permissions = if (info?.optString("kind") == "channel") TdApi.ChatPermissions(true, true, true, true, true, true, true, true, true, true, true, false, false, false, false, false)
            else chatPermissionsOf(g.permissions)
        // spec 004: счётчик заявок → строка «Join Requests» в X (только при > 0, как TDLib)
        chat.pendingJoinRequests = if (g.pendingRequests > 0) TdApi.ChatJoinRequestsInfo(g.pendingRequests, LongArray(0)) else null
        chats[g.chatId] = chat
        return Triple(chat, basicGroup(g), existed == null)
    }
    /** Фото группы из cloud (открытый объект, уже скачан в path) → фото чата. */
    @Synchronized
    fun setGroupPhoto(gid: String, fileId: String, path: String): TdApi.Chat? {
        val g = groupsByGid[gid] ?: return null
        val chat = chats[g.chatId] ?: return null
        val f = fileFor("avatar:$fileId", "", "", 0, "image/jpeg", path)
        chat.photo = TdApi.ChatPhotoInfo(f, f, null, false, false)
        return chat
    }
    @Synchronized
    fun clearGroupPhoto(gid: String): TdApi.Chat? {
        val g = groupsByGid[gid] ?: return null
        val chat = chats[g.chatId] ?: return null
        chat.photo = null
        return chat
    }
    fun basicGroup(g: GroupRef): TdApi.BasicGroup =
        TdApi.BasicGroup(g.basicGroupId, g.members.size, memberStatus(g, self), true, 0)
    fun basicGroupFullInfo(g: GroupRef): TdApi.BasicGroupFullInfo = TdApi.BasicGroupFullInfo().apply {
        description = g.about
        creatorUserId = idOf(g.createdBy)
        members = g.members.map { m -> TdApi.ChatMember(TdApi.MessageSenderUser(idOf(m)), "", 0, 0, memberStatus(g, m)) }.toTypedArray()
        botCommands = arrayOf()
        inviteLink = g.primaryInviteLink // spec 004: основная ссылка (getPrimaryChatInviteLink в X)
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
                   pinned: Boolean = false, reactions: JSONArray? = null, order: Long = 0L): TdApi.Message? {
        if (uuid.isEmpty() || msgByUuid.containsKey(uuid)) return null
        val group = groupsByGid[to]
        val chat = if (group != null) chats[group.chatId] ?: return null else ensurePeer(if (out) to else from).second
        // Место в ленте — модели (ORDER-1); своё, которого модель ещё не показала, — после всего показанного
        val place = if (order > 0L) order else maxOf(System.currentTimeMillis(), (maxOrder[chat.id] ?: 0L) + 1)
        val msgId = msgIdFor(chat.id, uuid, place)
        orderByUuid[uuid] = place
        maxOrder.merge(chat.id, place) { a, b -> maxOf(a, b) }
        val list = messages.getOrPut(chat.id) { ArrayList() }
        val at = list.binarySearch { it.id.compareTo(msgId) }.let { if (it < 0) -it - 1 else it }
        val newest = at == list.size
        if (content.optString("kind") == "poll") {
            polls.isMember = { gid, address -> roleOf(groupsByGid[gid], address) != null } // POLL-1: голос в личку принимает автор от участника
            // чат опроса — адрес группы либо собеседника (не получатель: у входящего в личном чате это свой адрес)
            polls.register(uuid, from, content, if (group != null || out) to else from, group != null, self)
        } // spec 005: до contentFrom
        val msg = TdApi.Message().apply {
            id = msgId
            chatId = chat.id
            senderId = TdApi.MessageSenderUser(idOf(from))
            isOutgoing = out
            date = ts.toInt()
            editDate = if (edited) ts.toInt() else 0
            isPinned = pinned
            canBeSaved = true
            this.content = contentFrom(content, uuid, from, out)
            interactionInfo = reactionsFrom(reactions)
            val replied = replyUuid?.let { msgByUuid[it] }
            // QUOTE-1: цитата из исходного сообщения
            this.replyTo = if (replied != null) TdApi.MessageReplyToMessage(replied.chatId, replied.id, MediaFlags.textQuote(content), 0, null, null, 0, null) else null
            // MEDIA-2: альбом — подряд идущие сообщения одного автора с одним album_id (≤ 10)
            val album = MediaFlags.albumOf(content)
            if (album.isNotEmpty()) {
                val prev = list.getOrNull(at - 1)
                val prevAlbum = prev?.let { p -> uuidByMsg[key(p.chatId, p.id)]?.let { MediaFlags.albumOf(contentByUuid[it]) } }.orEmpty()
                val prevSender = (prev?.senderId as? TdApi.MessageSenderUser)?.userId ?: 0L
                val groupSize = prev?.takeIf { it.mediaAlbumId != 0L }?.let { p -> messages[chat.id]?.count { it.mediaAlbumId == p.mediaAlbumId } } ?: 0
                mediaAlbumId = MediaFlags.mediaAlbumId(album, idOf(from), uuid, prevAlbum, prevSender, prev?.mediaAlbumId ?: 0L, groupSize)
            }
            // пересланное: forwarded_name (wire как в вебе/десктопе) → «Переслано от …»
            val fwd = if (content.isNull("forwarded_name")) "" else content.optString("forwarded_name")
            if (fwd.isNotEmpty()) forwardInfo = TdApi.MessageForwardInfo(TdApi.MessageOriginHiddenUser(fwd), ts.toInt(), null, "")
        }
        list.add(at, msg)
        msgByUuid[uuid] = msg
        reservedIds.remove(uuid)
        uuidByMsg[key(chat.id, msgId)] = uuid
        contentByUuid[uuid] = content
        // Страница старых строк (лента X листает назад) чат не трогает: последнее сообщение, место и счётчики — только
        // от новой строки (счётчик, кроме того, выставляет модель — read_state)
        if (!newest) return msg
        chat.lastMessage = msg
        // spec 036 (ENGINE-1): место чата в списке — модели (`ChatView.order` = место последней строки, ORDER-1)
        chat.positions = positionsFor(chat.id, maxOf(place / 1000, chat.positions.firstOrNull()?.order ?: 0L))
        if (!out && !read) chat.unreadCount += 1
        // Прочитанное, пришедшее позже непрочитанного (догрузка истории), границу прочтения не двигает (READ-2)
        if (!out && read && chat.unreadCount == 0 && msgId > chat.lastReadInboxMessageId) chat.lastReadInboxMessageId = msgId
        if (out && read) chat.lastReadOutboxMessageId = msgId
        return msg
    }

    /** Строка модели старше последнего показанного сообщения чата (догрузка истории): в память шва не нужна — лента
     *  возьмёт её страницей модели. */
    fun behindLast(chatId: Long, order: Long): Boolean {
        if (order <= 0L) return false
        val last = chats[chatId]?.lastMessage ?: return false
        val lastOrder = uuidByMsg[key(chatId, last.id)]?.let { orderByUuid[it] } ?: return false
        return order < lastOrder
    }

    /** Id сообщения X по месту строки модели (кратен 2^20, как серверные id TDLib): тот же для страницы и для
     *  границы прочтения, выданной раньше загрузки строки. */
    @Synchronized
    fun msgIdFor(chatId: Long, uuid: String, order: Long): Long {
        msgByUuid[uuid]?.let { return it.id }
        reservedIds[uuid]?.let { return it }
        var slot = 0
        var id: Long
        while (true) {
            id = MessageIds.of(order, uuid, slot)
            val other = uuidByMsg[key(chatId, id)]
            if (other == null || other == uuid) break
            slot++
        }
        reservedIds[uuid] = id
        uuidByMsg[key(chatId, id)] = uuid
        return id
    }

    private fun key(chatId: Long, msgId: Long) = chatId to msgId
    fun uuidOf(chatId: Long, msgId: Long): String? = uuidByMsg[key(chatId, msgId)]
    fun messageByUuid(uuid: String): TdApi.Message? = msgByUuid[uuid]
    fun contentOf(uuid: String): JSONObject? = contentByUuid[uuid]
    /** Исходный content сообщения с этим вложением (GIF-1: ссылка на файл для журнала без повторной загрузки). */
    fun contentByFileId(remoteId: String): JSONObject? =
        if (remoteId.isEmpty()) null else contentByUuid.values.firstOrNull { it.optString("file_id") == remoteId }

    /** Правка: новый контент → апдейты для UI. */
    @Synchronized
    fun applyEdit(uuid: String, content: JSONObject, editDate: Long): List<TdApi.Update> {
        val msg = msgByUuid[uuid] ?: return emptyList()
        msg.content = contentFrom(content, uuid, addressById[(msg.senderId as? TdApi.MessageSenderUser)?.userId ?: 0L] ?: "", msg.isOutgoing)
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

    /** Удаление (надгробие журнала истории, своё «у всех»/«только у меня», очистка): удалённое непрочитанное входящее
     *  снимается и со счётчика чата (бейдж не остаётся висеть на сообщении, которого нет). */
    @Synchronized
    fun removeMessages(uuids: List<String>): List<TdApi.Update> {
        val byChat = HashMap<Long, ArrayList<Long>>()
        val unreadGone = HashMap<Long, Int>()
        for (uuid in uuids) {
            val msg = msgByUuid.remove(uuid) ?: continue
            uuidByMsg.remove(key(msg.chatId, msg.id)); contentByUuid.remove(uuid)
            messages[msg.chatId]?.removeAll { it.id == msg.id }
            byChat.getOrPut(msg.chatId) { ArrayList() }.add(msg.id)
            if (!msg.isOutgoing && msg.id > (chats[msg.chatId]?.lastReadInboxMessageId ?: Long.MAX_VALUE))
                unreadGone[msg.chatId] = (unreadGone[msg.chatId] ?: 0) + 1
        }
        val out = ArrayList<TdApi.Update>()
        byChat.forEach { (chatId, ids) ->
            out += TdApi.UpdateDeleteMessages(chatId, ids.toLongArray(), true, false)
            chats[chatId]?.let { chat ->
                chat.lastMessage = messages[chatId]?.lastOrNull()
                out += TdApi.UpdateChatLastMessage(chatId, chat.lastMessage, chat.positions)
                val gone = unreadGone[chatId] ?: 0
                if (gone > 0 && chat.unreadCount > 0) {
                    chat.unreadCount = maxOf(0, chat.unreadCount - gone)
                    out += TdApi.UpdateChatReadInbox(chatId, chat.lastReadInboxMessageId, chat.unreadCount)
                }
            }
        }
        return out
    }

    /** Все известные uuid (замена истории контрольной точкой, HIST-2). */
    fun allUuids(): List<String> = msgByUuid.keys.toList()

    /** Счётчик чата от маркера «прочитано до» журнала истории (READ-2): число непрочитанных считает движок, граница
     *  прочтения — последняя прочитанная строка (не назад). null — чата нет или ничего не изменилось. */
    @Synchronized
    fun applyReadState(address: String, unread: Int, lastReadUuid: String, lastReadOrder: Long = 0L): TdApi.UpdateChatReadInbox? {
        val chatId = groupsByGid[address]?.chatId ?: idByAddress[address] ?: return null
        val chat = chats[chatId] ?: return null
        val list = messages[chatId] ?: emptyList<TdApi.Message>()
        // Строка границы может быть ещё не загружена (лента — страницами): id — по её месту в модели
        val lastRead = msgByUuid[lastReadUuid]?.takeIf { it.chatId == chatId }?.id
            ?: if (lastReadUuid.isNotEmpty() && lastReadOrder > 0L) msgIdFor(chatId, lastReadUuid, lastReadOrder) else 0L
        // Всё прочитано — граница у последнего входящего; иначе у последней прочитанной строки
        val target = if (unread <= 0) list.lastOrNull { !it.isOutgoing }?.id ?: lastRead else lastRead
        val readTill = maxOf(chat.lastReadInboxMessageId, target)
        val count = maxOf(0, unread)
        if (count == chat.unreadCount && readTill == chat.lastReadInboxMessageId) return null
        chat.unreadCount = count
        chat.lastReadInboxMessageId = readTill
        return TdApi.UpdateChatReadInbox(chatId, readTill, count)
    }

    /** «Удалить у всех» (HIST-1, как Telegram): в личном чате — любое сообщение; в группе и канале — своё либо
     *  владельцу/админу с правом удалять. Окончательно решает движок (historyCanDelete) при отправке и приёме. */
    fun canDeleteForEveryone(chatId: Long, own: Boolean): Boolean {
        val g = groupsByChatId[chatId] ?: return true
        if (own) return true
        return when (roleOf(g, self)) {
            "owner" -> true
            "admin" -> g.adminRights[self]?.optBoolean("delete_messages", true) ?: true
            else -> false
        }
    }

    /**
     * История чата как TDLib: от fromMessageId (0 — с конца) вниз, новые первыми;
     * отрицательный offset добавляет -offset более новых (X открывает чат от
     * lastReadInboxMessageId с offset=-limit/2 — без этого чат был пуст).
     */
    fun history(chatId: Long, fromMessageId: Long, offset: Int, limit: Int): TdApi.Messages {
        val address = addressOf(chatId)
        val p = pager
        val m = materialize
        if (address == null || p == null || m == null) return memoryHistory(chatId, fromMessageId, offset, limit)
        // spec 036 T035: страницами модели. Смысл аргументов — прежний (как memoryHistory): без смещения — строго старше
        // fromMessageId; отрицательное смещение — ещё -offset строк, начиная с самой fromMessageId, новее
        val want = limit.coerceAtLeast(1)
        val newerWanted = if (offset < 0 && fromMessageId != 0L) minOf(-offset, want) else 0
        val anchor = if (fromMessageId == 0L) "" else uuidOf(chatId, fromMessageId) ?: return memoryHistory(chatId, fromMessageId, offset, limit)
        val older = ArrayList<TdApi.Message>()
        var a = anchor
        var need = want - newerWanted
        var moreOlder = false
        while (need > 0) {
            val page = p(address, a, "older", minOf(need, 200)) ?: return memoryHistory(chatId, fromMessageId, offset, limit)
            older.addAll(0, page.rows.mapNotNull { m(it) })
            need -= page.rows.size
            moreOlder = page.hasOlder
            if (!page.hasOlder || page.rows.isEmpty()) break
            a = page.rows.first().optString("id")
        }
        val newer = ArrayList<TdApi.Message>()
        var moreNewer = false
        if (newerWanted > 0) {
            // сама строка-якорь и новее
            val self = msgByUuid[anchor] ?: p(address, anchor, "around", 1)?.rows?.firstOrNull { it.optString("id") == anchor }?.let { m(it) }
            if (self != null) newer += self
            if (newerWanted > 1) p(address, anchor, "newer", newerWanted - 1)?.let { pg -> pg.rows.mapNotNullTo(newer) { m(it) }; moreNewer = pg.hasNewer }
        }
        // Строки вне модели (самоуничтожение собеседника, своё отправляемое до строки модели, записи звонков, превью
        // публичной группы) — из памяти шва, в том же окне ленты: id из места ленты, порядок общий
        val anchorId = if (fromMessageId == 0L) Long.MAX_VALUE else fromMessageId
        val lowO = if (moreOlder) older.minOfOrNull { it.id } ?: Long.MIN_VALUE else Long.MIN_VALUE
        val highN = if (moreNewer) newer.maxOfOrNull { it.id } ?: anchorId else Long.MAX_VALUE
        val mem = synchronized(this) { ArrayList(messages[chatId] ?: emptyList<TdApi.Message>()) }
        val olderAll = (older + mem.filter { it.id >= lowO && it.id < anchorId }).distinctBy { it.id }.sortedBy { it.id }
            .takeLast(want - newerWanted)
        val newerAll = if (newerWanted > 0) (newer + mem.filter { it.id >= anchorId && it.id <= highN }).distinctBy { it.id }
            .sortedBy { it.id }.take(newerWanted) else emptyList()
        val page = (olderAll + newerAll).distinctBy { it.id }.sortedBy { it.id }.reversed()
        return TdApi.Messages(maxOf(page.size, messages[chatId]?.size ?: 0), page.toTypedArray())
    }

    /** Лента из памяти шва (модели нет: JVM-тесты, до открытия модели). */
    @Synchronized
    fun memoryHistory(chatId: Long, fromMessageId: Long, offset: Int, limit: Int): TdApi.Messages {
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
    /** «Кто может добавлять меня в группы» из блоба (P-34): "anyone" | "nobody" | "" — не приходило.
     *  Своего экрана в шве нет: значение с другого устройства сохраняется в исходящем блобе
     *  (иначе мут чата с Android стирал бы его на сервере) и уходит в приватность v2 (T079). */
    @Volatile var groupAddPolicy: String = ""
    private fun notifyBlob(): String = JSONObject().put("defaults", notifyDefaults).put("exceptions", notifyExceptions)
        .also { if (groupAddPolicy.isNotEmpty()) it.put("group_add", groupAddPolicy) }.toString()
    /** Копия настроек уведомлений для журнала личного состояния (T132). */
    @Synchronized
    fun notifyView(): StateJournal.NotifyView =
        StateJournal.NotifyView(JSONObject(notifyDefaults.toString()), JSONObject(notifyExceptions.toString()))
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
        // B10: «без звука» и «показывать текст» чата (state.v1 NotifySettings.silent/show_previews); нет поля — как в области
        val silent = notifyFlag(ex, "silent")
        val preview = notifyFlag(ex, "showPreviews")
        return TdApi.ChatNotificationSettings(useDefault, muted, silent == null, if (silent == true) 0L else Notifications.DEFAULT_SOUND,
            preview == null, preview ?: true, true, false, true, 0, true, true, true, false, true, false)
    }
    fun scopeSettings(scope: String): TdApi.ScopeNotificationSettings {
        val d = notifyDefaults.optJSONObject(scope)
        val silent = notifyFlag(d, "silent") == true
        return TdApi.ScopeNotificationSettings(muteFor(d), if (silent) 0L else Notifications.DEFAULT_SOUND, notifyFlag(d, "showPreviews") ?: true,
            false, false, 0, true, false, false)
    }
    /** Показывать ли текст и звук уведомления чата (исключение чата, иначе умолчание области). */
    fun notifyPreview(address: String, scope: String): Boolean =
        notifyFlag(notifyExceptions.optJSONObject(address), "showPreviews") ?: notifyFlag(notifyDefaults.optJSONObject(scope), "showPreviews") ?: true
    fun notifySilent(address: String, scope: String): Boolean =
        notifyFlag(notifyExceptions.optJSONObject(address), "silent") ?: notifyFlag(notifyDefaults.optJSONObject(scope), "silent") ?: false
    /** Поле настроек уведомлений: true/false; null — не задано либо «как в области» (JSON null). */
    private fun notifyFlag(o: JSONObject?, key: String): Boolean? = if (o != null && o.has(key) && !o.isNull(key)) o.optBoolean(key) else null
    /** B10: настройки чата из экрана «Уведомления» X — мут, звук (выключен → «без звука»), показ текста. */
    @Synchronized
    fun setChatNotify(address: String, n: TdApi.ChatNotificationSettings?) {
        setChatMute(address, if (n == null || n.useDefaultMuteFor) 0 else n.muteFor)
        val ex = notifyExceptions.optJSONObject(address) ?: JSONObject()
        // null (JSON) — «как в области»: журнал снимет поле (а не оставит прежнее значение другого устройства)
        ex.put("silent", if (n == null || n.useDefaultSound) JSONObject.NULL else n.soundId == 0L)
        ex.put("showPreviews", if (n == null || n.useDefaultShowPreview) JSONObject.NULL else n.showPreview)
        notifyExceptions.put(address, ex)
        (groupsByGid[address]?.chatId ?: idByAddress[address])?.let { chats[it]?.notificationSettings = chatNotifySettings(address) }
    }
    @Synchronized
    fun setScopeNotify(scope: String, n: TdApi.ScopeNotificationSettings?) {
        setScopeMute(scope, n?.muteFor ?: 0)
        val d = notifyDefaults.optJSONObject(scope) ?: JSONObject()
        if (n == null) { d.remove("silent"); d.remove("showPreviews") } else { d.put("silent", n.soundId == 0L); d.put("showPreviews", n.showPreview) }
        notifyDefaults.put(scope, d)
    }
    /** B10: «Сбросить все настройки уведомлений» — исключения чатов сняты, области без мута, со звуком и текстом. */
    @Synchronized
    fun resetNotify(): List<TdApi.Update> {
        val out = ArrayList<TdApi.Update>()
        notifyExceptions.keys().asSequence().toList().forEach { address ->
            notifyExceptions.put(address, JSONObject().put("mutedUntil", 0L))
            (groupsByGid[address]?.chatId ?: idByAddress[address])?.let { id ->
                chats[id]?.let { c -> c.notificationSettings = chatNotifySettings(address); out += TdApi.UpdateChatNotificationSettings(id, c.notificationSettings) }
            }
        }
        listOf("users" to TdApi.NotificationSettingsScopePrivateChats(), "groups" to TdApi.NotificationSettingsScopeGroupChats(), "channels" to TdApi.NotificationSettingsScopeChannelChats())
            .forEach { (k, scope) -> notifyDefaults.put(k, JSONObject().put("mutedUntil", 0L)); out += TdApi.UpdateScopeNotificationSettings(scope, scopeSettings(k)) }
        return out
    }
    /** Применить блоб с сервера/другого устройства → апдейты для известных чатов. */
    @Synchronized
    fun applyNotifyBlob(blob: JSONObject): List<TdApi.Update> {
        val out = ArrayList<TdApi.Update>()
        blob.optString("group_add").let { if (it == "anyone" || it == "nobody") groupAddPolicy = it }
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
        // «без звука»/«показывать текст» чата (B10) правкой мута не теряются
        val prev = notifyExceptions.optJSONObject(address)
        notifyExceptions.put(address, JSONObject().put("mutedUntil", until).also { e ->
            for (k in listOf("silent", "showPreviews")) if (prev != null && prev.has(k)) e.put(k, prev.get(k))
        })
        (groupsByGid[address]?.chatId ?: idByAddress[address])?.let { chats[it]?.notificationSettings = chatNotifySettings(address) }
        return notifyBlob()
    }
    @Synchronized
    fun setScopeMute(scope: String, muteFor: Int): String {
        val until = when { muteFor <= 0 -> 0L; muteFor >= 365 * 24 * 3600 -> 2147483647L; else -> System.currentTimeMillis() / 1000 + muteFor }
        notifyDefaults.put(scope, JSONObject().put("mutedUntil", until))
        return notifyBlob()
    }

    /** B4: своё фото профиля снято — без фото у пользователя и чата. */
    @Synchronized
    fun clearUserPhoto(address: String): Pair<TdApi.User, TdApi.Chat>? {
        val id = idOf(address)
        val user = users[id] ?: return null
        val chat = chats[id] ?: return null
        user.profilePhoto = null
        chat.photo = null
        return user to chat
    }
    /** Общие группы с собеседником (вкладка «Группы» профиля), по порядку списка чатов. */
    fun groupsInCommon(address: String): List<Long> =
        groupsByGid.values.filter { address in it.members && self in it.members }.map { it.chatId }
            .sortedByDescending { chats[it]?.positions?.firstOrNull()?.order ?: 0L }

    /** Статус онлайн пира (presence-хартбит → online до now+90). */
    @Synchronized
    fun setOnline(address: String, expires: Int): TdApi.Update? {
        val user = users[idOf(address)] ?: return null
        user.status = TdApi.UserStatusOnline(expires)
        return TdApi.UpdateUserStatus(user.id, user.status)
    }

    /** Режим L2 включён в чате с пиром: «в сети» больше не показываем (L2-1); null — и так не в сети. */
    @Synchronized
    fun setOffline(address: String): TdApi.Update? {
        val user = users[idOf(address)] ?: return null
        if (user.status !is TdApi.UserStatusOnline) return null
        user.status = TdApi.UserStatusOffline(0)
        return TdApi.UpdateUserStatus(user.id, user.status)
    }
}

/**
 * spec 036 T035 (ENGINE-1): id сообщения X из места строки в ленте модели (ORDER-1, `order`, мс). Порядок id = порядок
 * ленты, поэтому страница старых строк, загруженная позже, встаёт ниже уже показанного, а граница «прочитано до»
 * известна до загрузки своей строки. Кратен 2^20 (как серверные id TDLib); 3 бита — от uuid (строки одной миллисекунды),
 * [slot] — сдвиг при совпадении. Запас — до 2036 г.
 */
object MessageIds {
    const val EPOCH_MS = 1_000_000_000_000L
    fun of(order: Long, uuid: String, slot: Int = 0): Long {
        val o = (order - EPOCH_MS).coerceIn(1L, (1L shl 40) - 1)
        return ((o shl 3) + (uuid.hashCode() and 7) + slot) shl 20
    }
}
