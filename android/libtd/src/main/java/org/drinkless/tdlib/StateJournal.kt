package org.drinkless.tdlib

import org.json.JSONArray
import org.json.JSONObject

/**
 * Личное состояние в шве (spec 007 T098; spec 036 ENGINE-1): папки, черновики, архив, отложенные, блок-лист,
 * уведомления, закреп, «непрочитано», быстрая реакция, наборы (PACK-3), контакты (CONTACT-1) — объекты `state.v2`
 * модели движка. Показ — объекты модели по видам (`viewStateJson`: {objects: [{kind, key, value, marks}]}, value —
 * proto3-JSON сообщения вида) → [show] в локальные файлы X (рабочая копия: `folders.json`, `drafts.json`, …) и
 * апдейты X. Правка пользователя — локальные данные вида → объекты [{key, value}] ([objects]) → `stateSubmit` ядра
 * с показанными объектами: разницу по полям от показанного, сведение и метки считает только модель. Своего сведения,
 * желаемого снимка, лампортов и меток в шве нет. Чистый JVM-класс: движок и адресация — через [Codec]/[Resolver].
 */
class StateJournal(private val codec: Codec, private val resolver: Resolver) {
    /** proto3-JSON ↔ байты сообщений протокола (base64); содержимое — разбор движка (spec 035 T136, ENGINE-1:
     *  шов не переводит виды сам — статические вызовы движка `contentOfWire`/`contentView`, как web contentMap.ts). */
    interface Codec {
        fun encode(type: String, json: String): String
        fun decode(type: String, b64: String): String
        /** Содержимое формата экспорта (`{kind, text, …}`) → Content (proto3-JSON) движком; "" — не собрано. */
        fun contentOfWire(wireJson: String, replyTo: String): String
        /** Content (proto3-JSON) → содержимое формата экспорта (`contentView.wire` движка); "" — не сообщение. */
        fun wireOf(contentJson: String): String
    }

    /** Адрес собеседника/группы ↔ chatId шва; домен сервера (группы в журнале). */
    interface Resolver {
        fun addressOf(chatId: Long): String?
        fun chatIdOf(address: String): Long?
        fun domain(): String
        /** Группа v2 с этим hex id уже известна шву (адрес "v2g:<hex>"). */
        fun isKnownV2Group(hex: String): Boolean
    }

    /** Что изменилось после [show] — для апдейтов X. */
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
        /** STATE-2: закреп главного списка изменился (чаты, чья позиция сменилась). */
        val pinned = HashSet<Long>()
        /** STATE-2: чаты, у которых сменилась отметка «непрочитано». */
        val unread = HashSet<Long>()
        /** STATE-2: сменилась быстрая реакция. */
        var reaction = false
        /** PACK-3: записи наборов стикеров изменились (поставить недостающие, снять убранные). */
        var packs: PackJournal.Projection? = null
        /** CONTACT-1: адреса, чьё своё имя или заметка изменились. */
        val contacts = HashSet<String>()
        fun any() = blocked.isNotEmpty() || folders || drafts.isNotEmpty() || archived.isNotEmpty() || scheduledAdded.isNotEmpty() ||
            scheduledRemoved.isNotEmpty() || notify != null || pinned.isNotEmpty() || unread.isNotEmpty() || reaction || packs != null ||
            contacts.isNotEmpty()
    }

    /**
     * Настройки уведомлений шва (T132, FR-039) в виде блоба веба: `defaults` — `{users|groups|channels: {mutedUntil}}`,
     * `exceptions` — `{адрес: {mutedUntil}}`, время — секунды эпохи. Копия на момент вызова (`ParvaneStore.notifyView`).
     */
    class NotifyView(val defaults: JSONObject, val exceptions: JSONObject)

    private fun mutedUntil(s: JSONObject?): Long = if (s == null || s.isNull("mutedUntil")) 0L else s.optLong("mutedUntil")
    private fun stateMutedUntil(st: JSONObject?): Long = (st?.optString("mute_until_ms")?.toLongOrNull() ?: 0L) / 1000
    /** Локальное (блоб веба) → NotifySettings: мут, «без звука» и «показывать текст» (B10); прочие поля показанного (звук) — как есть. */
    private fun notifyToState(local: JSONObject?, journal: JSONObject?): JSONObject {
        val o = (journal?.let { JSONObject(it.toString()) } ?: JSONObject()).put("mute_until_ms", (mutedUntil(local) * 1000).toString())
        // Поле, которого шов не знает (не правили на этом устройстве), остаётся как в журнале; JSON null — снять
        for ((lk, sk) in listOf("silent" to "silent", "showPreviews" to "show_previews")) {
            if (local == null || !local.has(lk)) continue
            if (local.isNull(lk)) o.remove(sk) else o.put(sk, local.optBoolean(lk))
        }
        return o
    }
    /** state.v1.NotifySettings → локальное (блоб веба). */
    private fun notifyFromState(st: JSONObject): JSONObject {
        val o = JSONObject().put("mutedUntil", stateMutedUntil(st))
        if (st.has("silent")) o.put("silent", st.optBoolean("silent"))
        if (st.has("show_previews")) o.put("showPreviews", st.optBoolean("show_previews"))
        return o
    }
    private fun flag(o: JSONObject?, k: String): Boolean? = if (o != null && o.has(k) && !o.isNull(k)) o.optBoolean(k) else null
    private fun sameNotify(a: JSONObject?, b: JSONObject): Boolean =
        a != null && mutedUntil(a) == mutedUntil(b) && flag(a, "silent") == flag(b, "silent") && flag(a, "showPreviews") == flag(b, "showPreviews")

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

    private fun peers(chatIds: List<Long>, key: String? = null): JSONArray = JSONArray().also { a ->
        chatIds.forEach { id -> resolver.addressOf(id)?.let(::peerOf)?.let { a.put(it) } }
        // Отложенный чат, который уже есть в chatIds (шов узнал группу, и её успели добавить), дважды не класть
        key?.let { k -> synchronized(unresolved) { unresolved[k]?.toList() } }
            ?.filter { addressOf(it)?.let(resolver::chatIdOf)?.let(chatIds::contains) != true }?.forEach { a.put(it) }
    }
    /** Чаты записей журнала; не известные шву (группа ещё не подключена) с [key] запоминаются для [objects]. */
    private fun chatIds(peers: JSONArray?, key: String? = null): List<Long> {
        val ids = ArrayList<Long>()
        val missing = ArrayList<JSONObject>()
        if (peers != null) for (i in 0 until peers.length()) {
            val peer = peers.optJSONObject(i) ?: continue
            val id = addressOf(peer)?.let(resolver::chatIdOf)
            if (id != null) ids += id else missing += peer
        }
        if (key != null) synchronized(unresolved) {
            if (missing.isEmpty()) unresolved.remove(key) else unresolved[key] = missing
            hasUnresolved = unresolved.isNotEmpty()
        }
        return ids
    }

    /**
     * Чаты из журнала, которых шов ещё не знает (группа не подключена — устройство только вошло): ключ — место в
     * модели (папка, закреп, архив, «непрочитано»). Проекция их пропускает, а [objects] возвращает на место: иначе
     * синк этого устройства стёр бы их из папок на всех устройствах. Шов заново проецирует снимок, когда узнаёт
     * новые группы ([hasUnresolved]).
     */
    private val unresolved = HashMap<String, List<JSONObject>>()
    @Volatile var hasUnresolved = false
        private set

    /**
     * Место «Все чаты» среди папок по модели (0 — первыми). Проекция кладёт его в `Folders.mainPosition` — X ставит
     * страницу «Все чаты» (и чип полосы папок) на это место; своя перестановка в X — [noteAllFolderAt].
     */
    @Volatile var allFolderAt = 0
        private set

    /** Перестановка папок на этом устройстве (ReorderChatFolders): место «Все чаты» — в следующий снимок. */
    fun noteAllFolderAt(pos: Int) { allFolderAt = pos.coerceAtLeast(0) }

    // ── объекты модели ───────────────────────────────────────────────────────
    /** Ключ объекта собеседника, как у модели (`state::peer_key`): `u:<адрес>` | `g:<домен>:<hex id>`; null — не собеседник. */
    fun peerKeyOf(peer: JSONObject?): String? {
        if (peer == null) return null
        peer.optJSONObject("user")?.optString("address")?.takeIf { it.isNotEmpty() }?.let { return "u:$it" }
        val g = peer.optJSONObject("group") ?: return null
        val hex = b64ToHex(g.optString("id"))?.takeIf { it.isNotEmpty() } ?: return null
        return "g:${g.optString("domain")}:$hex"
    }
    /** Собеседник из ключа объекта; null — не ключ собеседника. */
    fun peerOfKey(key: String): JSONObject? {
        if (key.startsWith("u:") && key.length > 2) return JSONObject().put("user", JSONObject().put("address", key.substring(2)))
        if (!key.startsWith("g:")) return null
        val colon = key.lastIndexOf(':')
        if (colon <= 1) return null
        val hex = key.substring(colon + 1).takeIf { HEX32.matches(it) } ?: return null
        return JSONObject().put("group", JSONObject().put("domain", key.substring(2, colon)).put("id", hexToB64(hex)))
    }
    private fun keyOfAddress(address: String): String? = peerKeyOf(peerOf(address))

    /** Объект показан шву, но собеседник ему не известен (группа ещё не подключена) — правка его не трогает. */
    private fun unknownPeer(peer: JSONObject?): Boolean = addressOf(peer)?.let(resolver::chatIdOf) == null

    // ── локальные данные → объекты вида (правка) ─────────────────────────────
    /**
     * Объекты вида [kind] (имя state.v2 без префикса: `FOLDER`, `DRAFT`, …) из локальных данных шва: [{key, value}]
     * (value — proto3-JSON сообщения вида). [shown] — объекты вида из последнего показа модели: поля, которых шов не
     * ведёт (звук уведомления, время блокировки), берутся оттуда; показанное, чего шов не знает (группа ещё не
     * подключена, отложенное уже отправлено, служебные папки), остаётся как показано — иначе правка этого устройства
     * стёрла бы его у всех. null — вид шов не ведёт (нет данных уведомлений/наборов) — не отдавать модели.
     */
    fun objects(kind: String, shown: JSONArray, local: ChatLocalState, queue: ScheduledQueue, blockedSet: Set<String> = emptySet(),
                notify: NotifyView? = null, packs: PackJournal? = null, nowMs: Long = System.currentTimeMillis()): JSONArray? {
        val out = JSONArray()
        val keys = HashSet<String>()
        val put = { key: String, value: JSONObject -> if (keys.add(key)) out.put(JSONObject().put("key", key).put("value", value)) }
        val shownByKey = LinkedHashMap<String, JSONObject>()
        for (i in 0 until shown.length()) shown.optJSONObject(i)?.let { o -> shownByKey[o.optString("key")] = o.optJSONObject("value") ?: JSONObject() }
        val keep = { pred: (String, JSONObject) -> Boolean -> shownByKey.forEach { (k, v) -> if (k !in keys && pred(k, v)) put(k, v) } }
        val peerSet = { chatIds: List<Long>, unresolvedKey: String ->
            peers(chatIds, unresolvedKey).let { a -> for (i in 0 until a.length()) peerKeyOf(a.optJSONObject(i))?.let { put(it, JSONObject()) } }
        }
        when (kind) {
            "FOLDER" -> {
                local.folders.all().forEach { f ->
                    put(f.id.toString(), JSONObject().put("id", f.id).put("title", f.title).put("emoticon", f.icon)
                        .put("include_peers", peers(f.included, "folder:${f.id}:in")).put("exclude_peers", peers(f.excluded, "folder:${f.id}:ex"))
                        .put("pinned_peers", peers(f.pinned, "folder:${f.id}:pin"))
                        .put("contacts", f.includeContacts).put("non_contacts", f.includeNonContacts).put("groups", f.includeGroups)
                        .put("channels", f.includeChannels).put("bots", f.includeBots).put("exclude_muted", f.excludeMuted)
                        .put("exclude_read", f.excludeRead).put("exclude_archived", f.excludeArchived).put("color", f.colorId))
                }
                keep { k, _ -> k == "0" || k == "1" } // «все чаты» и архив — зарезервированы, шов их не ведёт
            }
            "FOLDER_ORDER" -> {
                // «Все чаты» (id 0): место выбирают web/desktop (без Premium) — сохраняем его, чтобы правка папок здесь
                // не сбрасывала. Папок стало меньше, чем место «Все чаты», — они последними (B1 ревью 7 ноя 2026)
                val ids = local.folders.all().map { it.id }.toMutableList<Int>()
                ids.add(minOf(allFolderAt, ids.size), 0)
                put("", JSONObject().put("ids", JSONArray(ids)))
            }
            "BLOCK" -> {
                synchronized(blockedSet) { blockedSet.toList() }.sorted().forEach { a ->
                    val peer = peerOf(a) ?: return@forEach
                    val key = peerKeyOf(peer) ?: return@forEach
                    // Время блокировки — показанное (правкой не меняется), новое — сейчас
                    put(key, shownByKey[key]?.takeIf { it.has("blocked_at_ms") }
                        ?: JSONObject().put("peer", peer).put("blocked_at_ms", nowMs.toString()))
                }
            }
            "PEER_NOTIFY" -> {
                if (notify == null) return null
                synchronized(notify) { notify.exceptions.keys().asSequence().toList() }.sorted().forEach { address ->
                    val peer = peerOf(address) ?: return@forEach
                    val key = peerKeyOf(peer) ?: return@forEach
                    put(key, JSONObject().put("peer", peer)
                        .put("settings", notifyToState(notify.exceptions.optJSONObject(address), shownByKey[key]?.optJSONObject("settings"))))
                }
                keep { _, v -> unknownPeer(v.optJSONObject("peer")) }
            }
            "NOTIFY_DEFAULTS" -> {
                if (notify == null) return null
                val was = shownByKey[""]
                val defaults = JSONObject()
                NOTIFY_SCOPES.forEach { scope ->
                    val d = notify.defaults.optJSONObject(scope)
                    val journal = was?.optJSONObject(scope)
                    if (d != null || journal != null) defaults.put(scope, notifyToState(d, journal))
                }
                if (defaults.length() > 0 || was != null) put("", defaults)
            }
            "DRAFT" -> {
                local.draftChatIds().forEach { chatId ->
                    val d = local.draftOf(chatId) ?: return@forEach
                    val peer = resolver.addressOf(chatId)?.let(::peerOf) ?: return@forEach
                    val key = peerKeyOf(peer) ?: return@forEach
                    val text = d.optString("text"); if (text.isEmpty()) return@forEach
                    val wire = JSONObject().put("kind", "text").put("text", text)
                    d.optJSONArray("entities")?.let { wire.put("entities", it) }
                    val v2Text = codec.contentOfWire(wire.toString(), "").takeIf { it.isNotEmpty() }?.let { JSONObject(it).optJSONObject("text") } ?: return@forEach
                    val bytes = codec.encode("parvane.msg.v2.Text", v2Text.toString()).takeIf { it.isNotEmpty() } ?: return@forEach
                    put(key, JSONObject().put("peer", peer).put("text", bytes).put("date_ms", (d.optLong("date") * 1000).toString()))
                }
                keep { _, v -> unknownPeer(v.optJSONObject("peer")) }
            }
            "SCHEDULED" -> {
                queue.all().forEach { item ->
                    if (item.localPath != null) return@forEach // медиа отложенного — локальная копия, в журнал не переносится
                    val peer = peerOf(item.to) ?: return@forEach
                    val content = codec.contentOfWire(item.content.toString(), item.replyTo ?: "").takeIf { it.isNotEmpty() } ?: return@forEach
                    val bytes = codec.encode("parvane.msg.v2.Content", content).takeIf { it.isNotEmpty() } ?: return@forEach
                    val op = uuidToB64(item.uuid) ?: return@forEach
                    val key = b64ToHex(op) ?: return@forEach
                    // Отметка «отправлено» — у объекта модели; значение отправленного шов не переписывает
                    if (sentKeys.contains(key)) return@forEach
                    put(key, JSONObject().put("op_id", op).put("peer", peer).put("send_at_ms", (item.due * 1000).toString()).put("content", bytes))
                }
                // Отправленные (отметка) и отложенные в чаты, которых шов ещё не знает, — как показаны
                keep { k, v -> sentKeys.contains(k) || v.length() == 0 || unknownPeer(v.optJSONObject("peer")) }
            }
            "ARCHIVE" -> {
                peerSet(local.archivedChatIds(), "archived")
                keep { k, _ -> unknownPeer(peerOfKey(k)) }
            }
            "UNREAD_MARK" -> {
                peerSet(local.unreadMarkedChatIds(), "unread")
                keep { k, _ -> unknownPeer(peerOfKey(k)) }
            }
            "PIN_LIST" -> {
                // Шов ведёт только основной список закрепа (ключ 1); архивный — не его
                val pinned = peers(local.pinnedChatIds(), "pins")
                if (pinned.length() > 0 || shownByKey.containsKey("1")) put("1", JSONObject().put("list", "PIN_LIST_MAIN").put("peers", pinned))
            }
            "QUICK_REACTION" -> {
                val emoji = local.quickReaction()
                if (emoji.isNotEmpty() || shownByKey.containsKey("")) put("", if (emoji.isEmpty()) JSONObject() else JSONObject().put("emoji", emoji))
            }
            "STICKER_PACK", "SAVED_GIF" -> {
                // PACK-3: свои наборы стикеров и эмодзи — рабочая копия записей; GIF (`g:`) — свой вид
                if (packs == null) return null
                val gif = kind == "SAVED_GIF"
                val records = packs.records()
                for (i in 0 until records.length()) {
                    val r = records.optJSONObject(i) ?: continue
                    val key = r.optString("set_id")
                    if (key.isNotEmpty() && key.startsWith("g:") == gif) put(key, r)
                }
            }
            "CONTACT" -> {
                // CONTACT-1: своё имя и заметка (только своим устройствам; сервер видит шифртекст); ключ — адрес
                local.contactAddresses().sorted().forEach { address ->
                    if (!address.contains('@')) return@forEach
                    val c = local.contactOf(address) ?: return@forEach
                    val o = JSONObject().put("user", JSONObject().put("address", address))
                    if (c.first.isNotEmpty()) o.put("first_name", c.first.take(256))
                    if (c.last.isNotEmpty()) o.put("last_name", c.last.take(256))
                    if (c.note.isNotEmpty()) o.put("note", c.note)
                    put(address, o)
                }
            }
            else -> return null
        }
        return out
    }

    /** Ключи отложенных с отметкой «отправлено» по последнему показу ([show]). */
    private val sentKeys: MutableSet<String> = java.util.Collections.synchronizedSet(HashSet())

    // ── объекты модели → локальные данные (показ) ────────────────────────────
    /**
     * Показ объектов модели (`viewStateJson`) в локальные файлы шва. [notify] null — настройки уведомлений не
     * трогать; [packs] null — наборы не трогать. Пустой вид — «в модели нет»: показ снимает пропавшее.
     */
    fun show(view: JSONObject, local: ChatLocalState, queue: ScheduledQueue, blockedSet: MutableSet<String> = HashSet(), notify: NotifyView? = null,
             packs: PackJournal? = null): Changes {
        val ch = Changes()
        val values = { kind: String -> JSONArray().also { a -> objectsOf(view, kind).let { o -> for (i in 0 until o.length()) a.put(o.getJSONObject(i).optJSONObject("value") ?: JSONObject()) } } }
        val keys = { kind: String -> objectsOf(view, kind).let { o -> (0 until o.length()).map { o.getJSONObject(it).optString("key") } } }
        if (packs != null) ch.packs = packs.project(JSONArray().also { a ->
            listOf("STICKER_PACK", "SAVED_GIF").forEach { k -> values(k).let { v -> for (i in 0 until v.length()) a.put(v.get(i)) } }
        })
        if (notify != null) projectNotify(values("PEER_NOTIFY"), values("NOTIFY_DEFAULTS").optJSONObject(0), notify, ch)
        val bl = values("BLOCK")
        val want = (0 until bl.length()).mapNotNull { addressOf(bl.optJSONObject(it)?.optJSONObject("peer")) }.filter { it.contains('@') }.toSet()
        synchronized(blockedSet) {
            val cur = blockedSet.toSet()
            (want - cur).forEach { blockedSet.add(it); ch.blocked += it }
            (cur - want).forEach { blockedSet.remove(it); ch.blocked += it }
        }
        projectFolders(values("FOLDER"), values("FOLDER_ORDER").optJSONObject(0), local, ch)
        projectDrafts(values("DRAFT"), local, ch)
        projectArchived(JSONArray(keys("ARCHIVE").mapNotNull(::peerOfKey)), local, ch)
        val scheduled = objectsOf(view, "SCHEDULED")
        val sent = (0 until scheduled.length()).map { scheduled.getJSONObject(it) }.filter { markValue(it, MARK_SCHEDULED_SENT) != 0L }.map { it.optString("key") }.toSet()
        synchronized(sentKeys) { sentKeys.clear(); sentKeys.addAll(sent) }
        projectScheduled(values("SCHEDULED"), sent, local, queue, ch)
        val pins = objectsOf(view, "PIN_LIST").let { o -> (0 until o.length()).map { o.getJSONObject(it) }.firstOrNull { it.optString("key") == "1" } }
        projectPins(pins?.optJSONObject("value"), JSONArray(keys("UNREAD_MARK").mapNotNull(::peerOfKey)), values("QUICK_REACTION").optJSONObject(0), local, ch)
        projectContacts(values("CONTACT"), local, ch)
        return ch
    }

    /** Граница очистки «удалить у себя» (T145): адрес → мс (отметка 2 объекта CHAT_CLEARED). */
    fun clearedOf(view: JSONObject): Map<String, Long> {
        val out = HashMap<String, Long>()
        val list = objectsOf(view, "CHAT_CLEARED")
        for (i in 0 until list.length()) {
            val o = list.getJSONObject(i)
            val until = markValue(o, MARK_CHAT_CLEARED)
            val address = addressOf(peerOfKey(o.optString("key"))) ?: continue
            if (until > 0) out[address] = until
        }
        return out
    }

    /** CONTACT-1: журнал — главный; запись без имён — контакт с именем, заданным собеседником. */
    private fun projectContacts(list: JSONArray, local: ChatLocalState, ch: Changes) {
        val next = LinkedHashMap<String, ChatLocalState.Contact>()
        for (i in 0 until list.length()) {
            val o = list.optJSONObject(i) ?: continue
            val address = o.optJSONObject("user")?.optString("address").orEmpty()
            if (!address.contains('@') || next.containsKey(address)) continue
            next[address] = ChatLocalState.Contact(o.optString("first_name"), o.optString("last_name"), o.optString("note"))
        }
        ch.contacts += local.replaceContacts(next)
    }

    /** Модель → изменившиеся настройки блобом веба; исключение, которого в модели больше нет, снимается (мут = 0). */
    private fun projectNotify(list: JSONArray, defs: JSONObject?, notify: NotifyView, ch: Changes) {
        val exceptions = JSONObject()
        val defaults = JSONObject()
        synchronized(notify) {
            val seen = HashSet<String>()
            for (i in 0 until list.length()) {
                val entry = list.optJSONObject(i) ?: continue
                val address = addressOf(entry.optJSONObject("peer")) ?: continue
                seen += address
                val want = notifyFromState(entry.optJSONObject("settings") ?: JSONObject())
                if (!sameNotify(notify.exceptions.optJSONObject(address), want)) exceptions.put(address, want)
            }
            notify.exceptions.keys().asSequence().toList().forEach { address ->
                val cur = notify.exceptions.optJSONObject(address)
                if (address !in seen && (mutedUntil(cur) != 0L || flag(cur, "silent") != null || flag(cur, "showPreviews") != null))
                    exceptions.put(address, JSONObject().put("mutedUntil", 0L))
            }
            NOTIFY_SCOPES.forEach { scope ->
                val st = defs?.optJSONObject(scope) ?: return@forEach
                val want = notifyFromState(st)
                if (!sameNotify(notify.defaults.optJSONObject(scope), want)) defaults.put(scope, want)
            }
        }
        if (exceptions.length() > 0 || defaults.length() > 0) ch.notify = JSONObject().put("defaults", defaults).put("exceptions", exceptions)
    }

    private fun projectFolders(list: JSONArray, orderObj: JSONObject?, local: ChatLocalState, ch: Changes) {
        val order = orderObj?.optJSONArray("ids")?.let { a -> (0 until a.length()).map { a.optInt(it) } } ?: emptyList()
        // Место «Все чаты»: сколько папок перед id 0 (нет 0 — первыми)
        allFolderAt = order.indexOf(0).let { at -> if (at < 0) 0 else order.take(at).count { it > 1 } }
        val next = LinkedHashMap<Int, Folders.Folder>()
        synchronized(unresolved) { unresolved.keys.removeAll { it.startsWith("folder:") }; hasUnresolved = unresolved.isNotEmpty() }
        for (i in 0 until list.length()) {
            val o = list.optJSONObject(i) ?: continue
            val id = o.optInt("id"); if (id <= 1) continue
            next[id] = Folders.Folder(id, o.optString("title"), o.optString("emoticon"), o.optInt("color", -1),
                chatIds(o.optJSONArray("pinned_peers"), "folder:$id:pin"), chatIds(o.optJSONArray("include_peers"), "folder:$id:in"),
                chatIds(o.optJSONArray("exclude_peers"), "folder:$id:ex"),
                o.optBoolean("exclude_muted"), o.optBoolean("exclude_read"), o.optBoolean("exclude_archived"),
                o.optBoolean("contacts"), o.optBoolean("non_contacts"), o.optBoolean("bots"), o.optBoolean("groups"), o.optBoolean("channels"))
        }
        val rank = { id: Int -> order.indexOf(id).let { if (it < 0) order.size + id else it } }
        val sorted = next.values.sortedBy { rank(it.id) }
        val before = local.folders.all().map { it.toJson().toString() }
        val after = sorted.map { it.toJson().toString() }
        val mainMoved = local.folders.setMainPosition(minOf(allFolderAt, sorted.size))
        if (before == after && !mainMoved) return
        if (before != after) local.folders.replaceAll(sorted)
        ch.folders = true
    }

    private fun projectDrafts(list: JSONArray, local: ChatLocalState, ch: Changes) {
        val next = HashMap<Long, JSONObject>()
        for (i in 0 until list.length()) {
            val d = list.optJSONObject(i) ?: continue
            val chatId = addressOf(d.optJSONObject("peer"))?.let(resolver::chatIdOf) ?: continue
            val t = d.optString("text").takeIf { it.isNotEmpty() } ?: continue
            val v2Text = codec.decode("parvane.msg.v2.Text", t).takeIf { it.isNotEmpty() } ?: continue
            val wire = codec.wireOf(JSONObject().put("text", JSONObject(v2Text)).toString()).takeIf { it.isNotEmpty() }?.let(::JSONObject) ?: continue
            val text = wire.optString("text"); if (text.isEmpty()) continue
            val o = JSONObject().put("text", text).put("date", (d.optString("date_ms").toLongOrNull() ?: 0L) / 1000)
            wire.optJSONArray("entities")?.let { o.put("entities", it) }
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

    private fun projectArchived(peers: JSONArray, local: ChatLocalState, ch: Changes) {
        val next = chatIds(peers, "archived").toSet()
        val cur = local.archivedChatIds().toSet()
        (next - cur).forEach { local.setArchived(it, true); ch.archived += it }
        (cur - next).forEach { local.setArchived(it, false); ch.archived += it }
    }

    /** STATE-2: закреп основного списка (объект PIN_LIST «1»), отметки «непрочитано», быстрая реакция. */
    private fun projectPins(main: JSONObject?, unreadPeers: JSONArray, reaction: JSONObject?, local: ChatLocalState, ch: Changes) {
        val next = chatIds(main?.optJSONArray("peers"), "pins")
        val cur = local.pinnedChatIds()
        if (next != cur) {
            ch.pinned += (next + cur).toSet()
            local.setPinnedOrder(next)
        }
        val marked = chatIds(unreadPeers, "unread").toSet()
        val was = local.unreadMarkedChatIds().toSet()
        (marked - was).forEach { local.setMarkedUnread(it, true); ch.unread += it }
        (was - marked).forEach { local.setMarkedUnread(it, false); ch.unread += it }
        if (local.setQuickReaction(reaction?.optString("emoji").orEmpty())) ch.reaction = true
    }

    private fun projectScheduled(list: JSONArray, sent: Set<String>, local: ChatLocalState, queue: ScheduledQueue, ch: Changes) {
        val want = LinkedHashMap<String, JSONObject>()
        for (i in 0 until list.length()) {
            val s = list.optJSONObject(i) ?: continue
            val op = s.optString("op_id").takeIf { it.isNotEmpty() } ?: continue
            if (b64ToHex(op) in sent) continue
            val uuid = b64ToUuid(op) ?: continue
            want[uuid] = s
        }
        // Снятые моделью (удалены/отправлены другим устройством) — из очереди; медиа не трогаем
        queue.all().filter { it.localPath == null && it.uuid !in want }.forEach { queue.remove(it.id)?.let { r -> ch.scheduledRemoved += r } }
        val have = queue.all().map { it.uuid }.toSet()
        for ((uuid, s) in want) {
            if (uuid in have) continue
            val address = addressOf(s.optJSONObject("peer")) ?: continue
            val chatId = resolver.chatIdOf(address) ?: continue
            val v2 = codec.decode("parvane.msg.v2.Content", s.optString("content")).takeIf { it.isNotEmpty() } ?: continue
            val wire = codec.wireOf(v2).takeIf { it.isNotEmpty() }?.let(::JSONObject) ?: continue
            val replyTo = JSONObject(v2).optJSONObject("reply_to")?.optString("op_id")?.let(::b64ToUuid)
            val due = (s.optString("send_at_ms").toLongOrNull() ?: 0L) / 1000
            ch.scheduledAdded += queue.add(uuid, chatId, address, wire, null, replyTo, due)
        }
    }

    companion object {
        /** Виды правок шва (имена прежних видов журнала) — по ним шов помечает «правка не отдана модели». */
        val KINDS = listOf("folders", "blocked", "drafts", "archived", "scheduled", "notify", "pinned", "unread", "reaction", "packs", "contacts")
        /** Вид правки шва → виды state.v2 (как desktop `StateKindsOf`). */
        fun kindsOf(edited: String): List<String> = when (edited) {
            "folders" -> listOf("FOLDER", "FOLDER_ORDER")
            "blocked" -> listOf("BLOCK")
            "drafts" -> listOf("DRAFT")
            "archived" -> listOf("ARCHIVE", "PIN_LIST") // архив снимает закреп
            "scheduled" -> listOf("SCHEDULED")
            "notify" -> listOf("PEER_NOTIFY", "NOTIFY_DEFAULTS")
            "pinned" -> listOf("PIN_LIST")
            "unread" -> listOf("UNREAD_MARK")
            "reaction" -> listOf("QUICK_REACTION")
            "packs" -> listOf("STICKER_PACK", "SAVED_GIF")
            "contacts" -> listOf("CONTACT")
            else -> emptyList()
        }
        /** Отметки объектов модели: отложенное отправлено (SCHEDULED), граница очистки чата (CHAT_CLEARED). */
        const val MARK_SCHEDULED_SENT = 1
        const val MARK_CHAT_CLEARED = 2
        private const val KIND_PREFIX = "OBJECT_KIND_"
        private val NOTIFY_SCOPES = listOf("users", "groups", "channels")
        const val V2_GROUP_PREFIX = "v2g:"
        private val HEX32 = Regex("^[0-9a-f]{32}$")

        /** Объекты вида [kind] (`FOLDER` либо `OBJECT_KIND_FOLDER`) из ответа `viewStateJson`: [{key, value, marks}]. */
        fun objectsOf(view: JSONObject?, kind: String): JSONArray {
            val want = if (kind.startsWith(KIND_PREFIX)) kind else KIND_PREFIX + kind
            val out = JSONArray()
            val list = view?.optJSONArray("objects") ?: return out
            for (i in 0 until list.length()) {
                val o = list.optJSONObject(i) ?: continue
                if (o.optString("kind") == want) out.put(o)
            }
            return out
        }
        /** Значение отметки поля [field] объекта (base64 big-endian) числом; нет — 0. */
        fun markValue(obj: JSONObject, field: Int): Long {
            val marks = obj.optJSONArray("marks") ?: return 0L
            for (i in 0 until marks.length()) {
                val m = marks.optJSONObject(i) ?: continue
                if (m.optInt("field") != field) continue
                val bytes = try { java.util.Base64.getDecoder().decode(m.optString("value")) } catch (e: IllegalArgumentException) { return 0L }
                return bytes.fold(0L) { acc, b -> (acc shl 8) or (b.toLong() and 0xff) }
            }
            return 0L
        }

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
