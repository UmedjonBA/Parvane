package org.drinkless.tdlib

import org.json.JSONArray
import org.json.JSONObject

/**
 * Протокол v2 (spec 007, T098, R10): папки, черновики, архив и отложенные — из
 * журнала личного состояния (`state.append`/`state.sync`, шифртекст на ключе
 * личного состояния; сведение LWW — STATE-1 в движке, ядро parvane-core).
 * Локальные файлы (`folders.json`, `drafts.json`, `chatlists.json`,
 * `scheduled.json`) остаются рабочей копией для X: правка пользователя →
 * желаемый снимок → разница с журналом (движок) → записи; записи других
 * устройств → сведённый снимок → [project] в локальные файлы и апдейты X.
 * Первый запуск переносит локальные данные в журнал (движок migrate_snapshot).
 * Блок-лист шва раньше жил только в памяти — теперь переживает рестарт через журнал.
 * Настройки уведомлений (T132, FR-039) — тоже вид журнала: открытый v1-блоб
 * `msg.chat.setnotify` списка заглушённых больше не несёт (правило STATE-2).
 * Порт web `src/api/parvane/v2/stateJournal.ts`. Чистый JVM-класс: движок и
 * адресация — через [Codec]/[Resolver].
 */
class StateJournal(private val codec: Codec, private val resolver: Resolver) {
    /** proto3-JSON ↔ байты сообщений протокола (base64) и v1 ↔ v2 содержимое. */
    interface Codec {
        fun encode(type: String, json: String): String
        fun decode(type: String, b64: String): String
        /** v1-содержимое → Content v2 ("" — вид не поддержан). */
        fun toV2(v1Json: String, replyTo: String): String
        /** Content v2 → v1-содержимое ("" — не сообщение). */
        fun fromV2(v2Json: String): String
    }

    /** Адрес собеседника/группы ↔ chatId шва; домен сервера (группы в журнале). */
    interface Resolver {
        fun addressOf(chatId: Long): String?
        fun chatIdOf(address: String): Long?
        fun domain(): String
        /** Группа v2 с этим hex id уже известна шву (адрес "v2g:<hex>"). */
        fun isKnownV2Group(hex: String): Boolean
    }

    /** Что изменилось после [project] — для апдейтов X. */
    class Changes {
        var folders = false
        val drafts = HashSet<Long>()
        val archived = HashSet<Long>()
        val scheduledAdded = ArrayList<ScheduledQueue.Item>()
        val scheduledRemoved = ArrayList<ScheduledQueue.Item>()
        /** Адреса, блокировка которых изменилась. */
        val blocked = HashSet<String>()
        /** Изменившиеся настройки уведомлений блобом веба (`{defaults, exceptions}`) — для `applyNotifyBlob`; null — без изменений. */
        var notify: JSONObject? = null
        fun any() = blocked.isNotEmpty() || folders || drafts.isNotEmpty() || archived.isNotEmpty() || scheduledAdded.isNotEmpty() || scheduledRemoved.isNotEmpty() || notify != null
    }

    /**
     * Настройки уведомлений шва (T132, FR-039) в виде блоба веба: `defaults` — `{users|groups|channels: {mutedUntil}}`,
     * `exceptions` — `{адрес: {mutedUntil}}`, время — секунды эпохи. Копия на момент вызова (`ParvaneStore.notifyView`).
     */
    class NotifyView(val defaults: JSONObject, val exceptions: JSONObject)

    /** Поля `state.v1.NotifySettings` из последнего снимка журнала: звук/превью/тихий режим шов не ведёт, но и не стирает. */
    private val journalNotify = HashMap<String, JSONObject>()
    private val journalNotifyDefaults = HashMap<String, JSONObject>()

    private fun mutedUntil(s: JSONObject?): Long = if (s == null || s.isNull("mutedUntil")) 0L else s.optLong("mutedUntil")
    private fun stateMutedUntil(st: JSONObject?): Long = (st?.optString("mute_until_ms")?.toLongOrNull() ?: 0L) / 1000
    private fun notifyToState(local: JSONObject?, journal: JSONObject?): JSONObject =
        (journal?.let { JSONObject(it.toString()) } ?: JSONObject()).put("mute_until_ms", (mutedUntil(local) * 1000).toString())

    // ── адресация ────────────────────────────────────────────────────────────
    fun peerOf(address: String): JSONObject? {
        if (address.contains('@')) return JSONObject().put("user", JSONObject().put("address", address))
        val hex = if (address.startsWith(V2_GROUP_PREFIX)) address.removePrefix(V2_GROUP_PREFIX) else address.replace("-", "").lowercase()
        if (!HEX32.matches(hex)) return null
        return JSONObject().put("group", JSONObject().put("domain", resolver.domain()).put("id", hexToB64(hex)))
    }

    /** Группа v2 — известная `v2g:<hex>`; иначе UUIDv7 группы v1. */
    fun addressOf(peer: JSONObject?): String? {
        if (peer == null) return null
        peer.optJSONObject("user")?.optString("address")?.takeIf { it.isNotEmpty() }?.let { return it }
        val id = peer.optJSONObject("group")?.optString("id")?.takeIf { it.isNotEmpty() } ?: return null
        val hex = b64ToHex(id) ?: return null
        if (hex.length != 32) return null
        if (resolver.isKnownV2Group(hex)) return V2_GROUP_PREFIX + hex
        val isUuidV7 = hex[12] == '7' && hex[16] in "89ab"
        return if (isUuidV7) "${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}"
        else V2_GROUP_PREFIX + hex
    }

    private fun peers(chatIds: List<Long>): JSONArray = JSONArray().also { a ->
        chatIds.forEach { id -> resolver.addressOf(id)?.let(::peerOf)?.let { a.put(it) } }
    }
    private fun chatIds(peers: JSONArray?): List<Long> =
        if (peers == null) emptyList() else (0 until peers.length()).mapNotNull { addressOf(peers.optJSONObject(it))?.let(resolver::chatIdOf) }

    // ── локальные данные → желаемый снимок (виды [KINDS]) ───────────────────
    fun build(local: ChatLocalState, queue: ScheduledQueue, blockedSet: Set<String> = emptySet(), notify: NotifyView? = null): JSONObject {
        val folders = JSONArray()
        val order = JSONArray()
        local.folders.all().forEach { f ->
            folders.put(JSONObject().put("id", f.id).put("title", f.title).put("emoticon", f.icon)
                .put("include_peers", peers(f.included)).put("exclude_peers", peers(f.excluded)).put("pinned_peers", peers(f.pinned))
                .put("contacts", f.includeContacts).put("non_contacts", f.includeNonContacts).put("groups", f.includeGroups)
                .put("channels", f.includeChannels).put("bots", f.includeBots).put("exclude_muted", f.excludeMuted)
                .put("exclude_read", f.excludeRead).put("exclude_archived", f.excludeArchived).put("color", f.colorId))
            order.put(f.id)
        }
        val drafts = JSONArray()
        local.draftChatIds().forEach { chatId ->
            val d = local.draftOf(chatId) ?: return@forEach
            val peer = resolver.addressOf(chatId)?.let(::peerOf) ?: return@forEach
            val text = d.optString("text"); if (text.isEmpty()) return@forEach
            val v1 = JSONObject().put("kind", "text").put("text", text)
            d.optJSONArray("entities")?.let { v1.put("entities", it) }
            val v2Text = codec.toV2(v1.toString(), "").takeIf { it.isNotEmpty() }?.let { JSONObject(it).optJSONObject("text") } ?: return@forEach
            val bytes = codec.encode("parvane.msg.v2.Text", v2Text.toString()).takeIf { it.isNotEmpty() } ?: return@forEach
            drafts.put(JSONObject().put("peer", peer).put("text", bytes).put("date_ms", (d.optLong("date") * 1000).toString()))
        }
        val archived = JSONArray()
        local.archivedChatIds().forEach { id -> resolver.addressOf(id)?.let(::peerOf)?.let { archived.put(it) } }
        val scheduled = JSONArray()
        queue.all().forEach { item ->
            if (item.localPath != null) return@forEach // медиа отложенного — локальная копия, в журнал не переносится
            val peer = peerOf(item.to) ?: return@forEach
            val content = codec.toV2(item.content.toString(), item.replyTo ?: "").takeIf { it.isNotEmpty() } ?: return@forEach
            val bytes = codec.encode("parvane.msg.v2.Content", content).takeIf { it.isNotEmpty() } ?: return@forEach
            val op = uuidToB64(item.uuid) ?: return@forEach
            scheduled.put(JSONObject().put("op_id", op).put("peer", peer).put("send_at_ms", (item.due * 1000).toString()).put("content", bytes))
        }
        // Блок-лист: время блокировки подставляет ядро (из журнала или «сейчас»)
        val blocked = JSONArray()
        synchronized(blockedSet) { blockedSet.toList() }.sorted().forEach { a -> peerOf(a)?.let { blocked.put(JSONObject().put("peer", it)) } }
        val out = JSONObject().put("folders", folders).put("folder_order", JSONObject().put("ids", order)).put("blocked", blocked)
            .put("drafts", drafts).put("archived", archived).put("scheduled", scheduled)
        // Настройки уведомлений (FR-039): кто заглушён — только своим устройствам, сервер этого не видит
        if (notify != null) {
            val list = JSONArray()
            val defaults = JSONObject()
            synchronized(this) {
                notify.exceptions.keys().asSequence().toList().sorted().forEach { address ->
                    val peer = peerOf(address) ?: return@forEach
                    list.put(JSONObject().put("peer", peer).put("settings", notifyToState(notify.exceptions.optJSONObject(address), journalNotify[address])))
                }
                NOTIFY_SCOPES.forEach { scope ->
                    val d = notify.defaults.optJSONObject(scope)
                    if (d != null || journalNotifyDefaults.containsKey(scope)) defaults.put(scope, notifyToState(d, journalNotifyDefaults[scope]))
                }
            }
            out.put("notify", list).put("notify_defaults", defaults)
        }
        return out
    }

    // ── сведённый снимок → локальные данные ───────────────────────────────────
    fun project(snap: JSONObject, local: ChatLocalState, queue: ScheduledQueue, blockedSet: MutableSet<String> = HashSet(), notify: NotifyView? = null): Changes {
        val ch = Changes()
        if (notify != null) projectNotify(snap, notify, ch)
        val bl = snap.optJSONArray("blocked") ?: JSONArray()
        val want = (0 until bl.length()).mapNotNull { addressOf(bl.optJSONObject(it)?.optJSONObject("peer")) }.filter { it.contains('@') }.toSet()
        synchronized(blockedSet) {
            val cur = blockedSet.toSet()
            (want - cur).forEach { blockedSet.add(it); ch.blocked += it }
            (cur - want).forEach { blockedSet.remove(it); ch.blocked += it }
        }
        projectFolders(snap, local, ch)
        projectDrafts(snap, local, ch)
        projectArchived(snap, local, ch)
        projectScheduled(snap, local, queue, ch)
        return ch
    }

    /** В снимке журнала есть настройки уведомлений (вид `notify` уже вёл какой-то клиент). */
    fun hasNotify(snap: JSONObject): Boolean =
        (snap.optJSONArray("notify")?.length() ?: 0) > 0 || (snap.optJSONObject("notify_defaults")?.length() ?: 0) > 0

    /** Журнал → изменившиеся настройки блобом веба; исключение, которого в журнале больше нет, снимается (мут = 0). */
    private fun projectNotify(snap: JSONObject, notify: NotifyView, ch: Changes) {
        val exceptions = JSONObject()
        val defaults = JSONObject()
        synchronized(this) {
            journalNotify.clear(); journalNotifyDefaults.clear()
            val list = snap.optJSONArray("notify") ?: JSONArray()
            for (i in 0 until list.length()) {
                val entry = list.optJSONObject(i) ?: continue
                val address = addressOf(entry.optJSONObject("peer")) ?: continue
                val settings = entry.optJSONObject("settings") ?: JSONObject()
                journalNotify[address] = settings
                val until = stateMutedUntil(settings)
                if (!notify.exceptions.has(address) || mutedUntil(notify.exceptions.optJSONObject(address)) != until)
                    exceptions.put(address, JSONObject().put("mutedUntil", until))
            }
            notify.exceptions.keys().asSequence().toList().forEach { address ->
                if (!journalNotify.containsKey(address) && mutedUntil(notify.exceptions.optJSONObject(address)) != 0L)
                    exceptions.put(address, JSONObject().put("mutedUntil", 0L))
            }
            val defs = snap.optJSONObject("notify_defaults") ?: JSONObject()
            NOTIFY_SCOPES.forEach { scope ->
                val st = defs.optJSONObject(scope) ?: return@forEach
                journalNotifyDefaults[scope] = st
                val until = stateMutedUntil(st)
                if (mutedUntil(notify.defaults.optJSONObject(scope)) != until) defaults.put(scope, JSONObject().put("mutedUntil", until))
            }
        }
        if (exceptions.length() > 0 || defaults.length() > 0) ch.notify = JSONObject().put("defaults", defaults).put("exceptions", exceptions)
    }

    private fun projectFolders(snap: JSONObject, local: ChatLocalState, ch: Changes) {
        val list = snap.optJSONArray("folders") ?: JSONArray()
        val order = snap.optJSONObject("folder_order")?.optJSONArray("ids")?.let { a -> (0 until a.length()).map { a.optInt(it) } } ?: emptyList()
        val next = LinkedHashMap<Int, Folders.Folder>()
        for (i in 0 until list.length()) {
            val o = list.optJSONObject(i) ?: continue
            val id = o.optInt("id"); if (id <= 1) continue
            next[id] = Folders.Folder(id, o.optString("title"), o.optString("emoticon"), o.optInt("color", -1),
                chatIds(o.optJSONArray("pinned_peers")), chatIds(o.optJSONArray("include_peers")), chatIds(o.optJSONArray("exclude_peers")),
                o.optBoolean("exclude_muted"), o.optBoolean("exclude_read"), o.optBoolean("exclude_archived"),
                o.optBoolean("contacts"), o.optBoolean("non_contacts"), o.optBoolean("bots"), o.optBoolean("groups"), o.optBoolean("channels"))
        }
        val rank = { id: Int -> order.indexOf(id).let { if (it < 0) order.size + id else it } }
        val sorted = next.values.sortedBy { rank(it.id) }
        val before = local.folders.all().map { it.toJson().toString() }
        val after = sorted.map { it.toJson().toString() }
        if (before == after) return
        local.folders.replaceAll(sorted)
        ch.folders = true
    }

    private fun projectDrafts(snap: JSONObject, local: ChatLocalState, ch: Changes) {
        val list = snap.optJSONArray("drafts") ?: JSONArray()
        val next = HashMap<Long, JSONObject>()
        for (i in 0 until list.length()) {
            val d = list.optJSONObject(i) ?: continue
            val chatId = addressOf(d.optJSONObject("peer"))?.let(resolver::chatIdOf) ?: continue
            val t = d.optString("text").takeIf { it.isNotEmpty() } ?: continue
            val v2Text = codec.decode("parvane.msg.v2.Text", t).takeIf { it.isNotEmpty() } ?: continue
            val v1 = codec.fromV2(JSONObject().put("text", JSONObject(v2Text)).toString()).takeIf { it.isNotEmpty() }?.let(::JSONObject) ?: continue
            val text = v1.optString("text"); if (text.isEmpty()) continue
            val o = JSONObject().put("text", text).put("date", (d.optString("date_ms").toLongOrNull() ?: 0L) / 1000)
            v1.optJSONArray("entities")?.let { o.put("entities", it) }
            next[chatId] = o
        }
        val ids = HashSet(local.draftChatIds()).apply { addAll(next.keys) }
        for (id in ids) {
            val cur = local.draftOf(id)
            val want = next[id]
            if ((cur?.optString("text") ?: "") == (want?.optString("text") ?: "")) continue
            // Совпадающие по тексту — локальные как есть (дата/ответ этого устройства)
            local.setDraft(id, want)
            ch.drafts += id
        }
    }

    private fun projectArchived(snap: JSONObject, local: ChatLocalState, ch: Changes) {
        val list = snap.optJSONArray("archived") ?: JSONArray()
        val next = (0 until list.length()).mapNotNull { addressOf(list.optJSONObject(it))?.let(resolver::chatIdOf) }.toSet()
        val cur = local.archivedChatIds().toSet()
        (next - cur).forEach { local.setArchived(it, true); ch.archived += it }
        (cur - next).forEach { local.setArchived(it, false); ch.archived += it }
    }

    private fun projectScheduled(snap: JSONObject, local: ChatLocalState, queue: ScheduledQueue, ch: Changes) {
        val sent = snap.optJSONArray("scheduled_sent")?.let { a -> (0 until a.length()).map { a.optString(it) }.toSet() } ?: emptySet()
        val list = snap.optJSONArray("scheduled") ?: JSONArray()
        val want = LinkedHashMap<String, JSONObject>()
        for (i in 0 until list.length()) {
            val s = list.optJSONObject(i) ?: continue
            val op = s.optString("op_id"); if (op in sent) continue
            val uuid = b64ToUuid(op) ?: continue
            want[uuid] = s
        }
        // Снятые журналом (удалены/отправлены другим устройством) — из очереди; медиа не трогаем
        queue.all().filter { it.localPath == null && it.uuid !in want }.forEach { queue.remove(it.id)?.let { r -> ch.scheduledRemoved += r } }
        val have = queue.all().map { it.uuid }.toSet()
        for ((uuid, s) in want) {
            if (uuid in have) continue
            val address = addressOf(s.optJSONObject("peer")) ?: continue
            val chatId = resolver.chatIdOf(address) ?: continue
            val v2 = codec.decode("parvane.msg.v2.Content", s.optString("content")).takeIf { it.isNotEmpty() } ?: continue
            val v1 = codec.fromV2(v2).takeIf { it.isNotEmpty() }?.let(::JSONObject) ?: continue
            val replyTo = JSONObject(v2).optJSONObject("reply_to")?.optString("op_id")?.let(::b64ToUuid)
            val due = (s.optString("send_at_ms").toLongOrNull() ?: 0L) / 1000
            ch.scheduledAdded += queue.add(uuid, chatId, address, v1, null, replyTo, due)
        }
    }

    companion object {
        /** Виды, которые ведёт шов (остальные виды журнала не трогаются). */
        val KINDS = listOf("folders", "blocked", "drafts", "archived", "scheduled", "notify")
        private val NOTIFY_SCOPES = listOf("users", "groups", "channels")
        const val V2_GROUP_PREFIX = "v2g:"
        private val HEX32 = Regex("^[0-9a-f]{32}$")

        fun hexToB64(hex: String): String =
            java.util.Base64.getEncoder().encodeToString(ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() })
        fun b64ToHex(b64: String): String? = try {
            java.util.Base64.getDecoder().decode(b64).joinToString("") { "%02x".format(it.toInt() and 0xff) }
        } catch (e: IllegalArgumentException) { null }
        fun uuidToB64(uuid: String): String? = uuid.replace("-", "").lowercase().takeIf { HEX32.matches(it) }?.let(::hexToB64)
        fun b64ToUuid(b64: String): String? = b64ToHex(b64)?.takeIf { it.length == 32 }?.let {
            "${it.substring(0, 8)}-${it.substring(8, 12)}-${it.substring(12, 16)}-${it.substring(16, 20)}-${it.substring(20)}"
        }
    }
}
