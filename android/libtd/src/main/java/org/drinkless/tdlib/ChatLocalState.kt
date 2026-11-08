package org.drinkless.tdlib

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * spec 005 / история 3: локальное состояние чатов, которого нет на сервере (как у
 * web/desktop): таймер автоудаления по собеседнику (`ttl.json` = `{адрес: секунды}`,
 * формат desktop `parvane-ttl.json`), черновики (`drafts.json` = `{chatId: {text,
 * entities, replyTo, date}}`), архив (`chatlists.json` = `{chatId: "archive"}`).
 * Чистый JVM-класс: файлы в каталоге ядра, без Android API.
 */
class ChatLocalState(private val dir: File) {
    private val ttl = HashMap<String, Int>()
    private val drafts = HashMap<Long, JSONObject>()
    private val archived = HashSet<Long>()
    // STATE-2: закреп главного списка (порядок), отметка «непрочитано», быстрая реакция — `pins.json`
    private val pinned = ArrayList<Long>()
    private val unreadMarks = HashSet<Long>()
    private var quickReaction = ""
    // CONTACT-1 (до init: load читает файл сюда)
    private val contacts = LinkedHashMap<String, Contact>()
    // B6: «Недавние» общего поиска (как TDLib addRecentlyFoundChat) и убранные из «Часто пишете» — `recent.json`, только это устройство
    private val recentFound = ArrayList<Long>()
    private val hiddenTop = HashSet<Long>()

    init { load() }

    // ── TTL ──
    @Synchronized fun ttlOf(address: String): Int = ttl[address] ?: 0
    @Synchronized fun setTtl(address: String, secs: Int) { if (secs > 0) ttl[address] = secs else ttl.remove(address); saveTtl() }

    // ── черновики ──
    @Synchronized fun draftOf(chatId: Long): JSONObject? = drafts[chatId]
    @Synchronized fun setDraft(chatId: Long, draft: JSONObject?) { if (draft == null) drafts.remove(chatId) else drafts[chatId] = draft; saveDrafts() }
    @Synchronized fun clearDrafts() { drafts.clear(); saveDrafts() }
    @Synchronized fun draftChatIds(): List<Long> = drafts.keys.toList()

    // ── архив ──
    @Synchronized fun isArchived(chatId: Long) = chatId in archived
    @Synchronized fun setArchived(chatId: Long, on: Boolean) { if (on) archived.add(chatId) else archived.remove(chatId); saveLists() }
    @Synchronized fun archivedChatIds(): List<Long> = archived.toList()

    @Synchronized fun pinnedChatIds(): List<Long> = pinned.toList()
    @Synchronized fun isPinned(chatId: Long) = chatId in pinned
    /** Закрепить (в начало) или открепить; false — ничего не изменилось. */
    @Synchronized fun setPinned(chatId: Long, on: Boolean): Boolean {
        val changed = if (on) { if (chatId in pinned) false else { pinned.add(0, chatId); true } } else pinned.remove(chatId)
        if (changed) savePins()
        return changed
    }
    @Synchronized fun setPinnedOrder(ids: List<Long>) { pinned.clear(); pinned.addAll(ids.distinct()); savePins() }
    @Synchronized fun isMarkedUnread(chatId: Long) = chatId in unreadMarks
    @Synchronized fun setMarkedUnread(chatId: Long, on: Boolean): Boolean {
        val changed = if (on) unreadMarks.add(chatId) else unreadMarks.remove(chatId)
        if (changed) savePins()
        return changed
    }
    @Synchronized fun unreadMarkedChatIds(): List<Long> = unreadMarks.toList()
    @Synchronized fun quickReaction(): String = quickReaction
    @Synchronized fun setQuickReaction(emoji: String): Boolean {
        if (emoji == quickReaction) return false
        quickReaction = emoji
        savePins()
        return true
    }

    // ── CONTACT-1: свои контакты — своё имя и заметка (`contacts.json` = {адрес: {first, last, note}}) ──
    /** Своя запись контакта: имя и фамилия (пусты — имя, заданное собеседником), заметка. */
    data class Contact(val first: String = "", val last: String = "", val note: String = "") {
        val name: String get() = listOf(first, last).filter { it.isNotEmpty() }.joinToString(" ")
        fun toJson(): JSONObject = JSONObject().put("first", first).put("last", last).put("note", note)
    }
    @Synchronized fun contactOf(address: String): Contact? = contacts[address]
    @Synchronized fun contactAddresses(): List<String> = contacts.keys.toList()
    /** Записать контакт; false — ничего не изменилось. */
    @Synchronized fun setContact(address: String, c: Contact): Boolean {
        if (contacts[address] == c) return false
        contacts[address] = c; saveContacts(); return true
    }
    /** Убрать из контактов (имя и заметка тоже); false — не было. */
    @Synchronized fun removeContact(address: String): Boolean {
        if (contacts.remove(address) == null) return false
        saveContacts(); return true
    }
    /** Журнал целиком → контакты; адреса, чья запись изменилась. */
    @Synchronized fun replaceContacts(next: Map<String, Contact>): Set<String> {
        val changed = (contacts.keys + next.keys).filter { contacts[it] != next[it] }.toSet()
        if (changed.isEmpty()) return changed
        contacts.clear(); contacts.putAll(next); saveContacts()
        return changed
    }
    private fun loadContacts() {
        try {
            File(dir, "contacts.json").takeIf { it.exists() }?.let { f ->
                val o = JSONObject(SeamFiles.read(f))
                o.keys().forEach { k -> o.optJSONObject(k)?.let { c -> contacts[k] = Contact(c.optString("first"), c.optString("last"), c.optString("note")) } }
            }
        } catch (e: Exception) { }
    }
    private fun saveContacts() = write("contacts.json", JSONObject().also { o -> contacts.forEach { (k, v) -> o.put(k, v.toJson()) } }.toString())

    // ── B6: недавно найденные чаты и «Часто пишете» ──
    @Synchronized fun recentFoundChatIds(): List<Long> = recentFound.toList()
    /** Чат найден и открыт из поиска — первым в «Недавних» (не больше [RECENT_MAX]). */
    @Synchronized fun addRecentFound(chatId: Long) {
        recentFound.remove(chatId); recentFound.add(0, chatId)
        while (recentFound.size > RECENT_MAX) recentFound.removeAt(recentFound.size - 1)
        saveRecent()
    }
    @Synchronized fun removeRecentFound(chatId: Long) { if (recentFound.remove(chatId)) saveRecent() }
    @Synchronized fun clearRecentFound() { if (recentFound.isNotEmpty()) { recentFound.clear(); saveRecent() } }
    @Synchronized fun isHiddenTop(chatId: Long) = chatId in hiddenTop
    @Synchronized fun hideTop(chatId: Long) { if (hiddenTop.add(chatId)) saveRecent() }
    private fun loadRecent() {
        try {
            File(dir, "recent.json").takeIf { it.exists() }?.let { f ->
                val o = JSONObject(SeamFiles.read(f))
                o.optJSONArray("found")?.let { a -> for (i in 0 until a.length()) recentFound.add(a.optLong(i)) }
                o.optJSONArray("hidden_top")?.let { a -> for (i in 0 until a.length()) hiddenTop.add(a.optLong(i)) }
            }
        } catch (e: Exception) { }
    }
    private fun saveRecent() = write("recent.json", JSONObject().put("found", org.json.JSONArray(recentFound))
        .put("hidden_top", org.json.JSONArray(hiddenTop.toList())).toString())

    /** Порядок закреплённого в списке: выше любого времени сообщения, первый закреплённый — выше всех. */
    fun pinnedOrder(chatId: Long): Long? = synchronized(this) { pinned.indexOf(chatId).takeIf { it >= 0 }?.let { PIN_ORDER_BASE - it } }

    /** Папки (spec 005 / история 4) — тот же каталог, `folders.json`. */
    val folders = Folders(dir)

    /** Позиции чата для X: главный список или архив + все папки, куда чат входит; order — время последнего сообщения. */
    fun positionsFor(chatId: Long, order: Long, facts: Folders.ChatFacts? = null): Array<TdApi.ChatPosition> {
        val out = ArrayList<TdApi.ChatPosition>()
        val pin = pinnedOrder(chatId)
        out.add(TdApi.ChatPosition(if (isArchived(chatId)) TdApi.ChatListArchive() else TdApi.ChatListMain(), pin ?: order, pin != null, null))
        if (facts != null) folders.foldersOf(chatId, facts).forEach { out.add(TdApi.ChatPosition(TdApi.ChatListFolder(it.id), order, chatId in it.pinned, null)) }
        return out.toTypedArray()
    }

    /** DraftMessage TdApi из сохранённого черновика; [replyMsgId] — id ответа в чате (0 — нет). */
    fun tdDraft(chatId: Long): TdApi.DraftMessage? {
        val d = draftOf(chatId) ?: return null
        val text = TdApi.FormattedText(d.optString("text"), Entities.fromWire(d.optJSONArray("entities")))
        val replyId = d.optLong("replyTo", 0L)
        val reply: TdApi.InputMessageReplyTo? = if (replyId > 0) TdApi.InputMessageReplyToMessage(replyId, null, 0, null) else null
        return TdApi.DraftMessage(reply, d.optInt("date", 0), TdApi.DraftMessageContentText(text, null), 0L, null)
    }
    /** Сохранённый вид черновика X. */
    fun draftJson(draft: TdApi.DraftMessage?): JSONObject? {
        val content = draft?.content as? TdApi.DraftMessageContentText ?: return null
        val text = content.text?.text ?: ""
        if (text.isEmpty()) return null
        val o = JSONObject().put("text", text).put("date", if (draft.date > 0) draft.date else (System.currentTimeMillis() / 1000).toInt())
        Entities.toWire(content.text?.entities)?.let { o.put("entities", it) }
        (draft.replyTo as? TdApi.InputMessageReplyToMessage)?.let { o.put("replyTo", it.messageId) }
        return o
    }

    private fun load() {
        try { File(dir, "ttl.json").takeIf { it.exists() }?.let { f -> val o = JSONObject(SeamFiles.read(f)); o.keys().forEach { k -> ttl[k] = o.optInt(k) } } } catch (e: Exception) { }
        try { File(dir, "drafts.json").takeIf { it.exists() }?.let { f -> val o = JSONObject(SeamFiles.read(f)); o.keys().forEach { k -> k.toLongOrNull()?.let { id -> o.optJSONObject(k)?.let { drafts[id] = it } } } } } catch (e: Exception) { }
        try { File(dir, "chatlists.json").takeIf { it.exists() }?.let { f -> val o = JSONObject(SeamFiles.read(f)); o.keys().forEach { k -> if (o.optString(k) == "archive") k.toLongOrNull()?.let { archived.add(it) } } } } catch (e: Exception) { }
        loadPins()
        loadContacts()
        loadRecent()
    }
    private fun loadPins() {
        try {
            File(dir, "pins.json").takeIf { it.exists() }?.let { f ->
                val o = JSONObject(SeamFiles.read(f))
                o.optJSONArray("main")?.let { a -> for (i in 0 until a.length()) pinned.add(a.optLong(i)) }
                o.optJSONArray("unread")?.let { a -> for (i in 0 until a.length()) unreadMarks.add(a.optLong(i)) }
                quickReaction = o.optString("reaction")
            }
        } catch (e: Exception) { }
    }
    private fun savePins() = write("pins.json", JSONObject().put("main", org.json.JSONArray(pinned)).put("unread", org.json.JSONArray(unreadMarks.toList()))
        .put("reaction", quickReaction).toString())
    private fun write(name: String, text: String) { try { dir.mkdirs(); SeamFiles.write(File(dir, name), text) } catch (e: Exception) { } }
    private fun saveTtl() = write("ttl.json", JSONObject(ttl as Map<*, *>).toString())
    private fun saveDrafts() = write("drafts.json", JSONObject().also { o -> drafts.forEach { (k, v) -> o.put(k.toString(), v) } }.toString())
    private fun saveLists() = write("chatlists.json", JSONObject().also { o -> archived.forEach { o.put(it.toString(), "archive") } }.toString())

    companion object {
        /** Порядок закреплённых (TDLib: выше обычных; время сообщения — секунды, много меньше). */
        const val PIN_ORDER_BASE = 9_000_000_000_000_000_000L
        /** «Недавние» поиска — как TDLib (до 50). */
        const val RECENT_MAX = 50
    }
}
