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

    /** Папки (spec 005 / история 4) — тот же каталог, `folders.json`. */
    val folders = Folders(dir)

    /** Позиции чата для X: главный список или архив + все папки, куда чат входит; order — время последнего сообщения. */
    fun positionsFor(chatId: Long, order: Long, facts: Folders.ChatFacts? = null): Array<TdApi.ChatPosition> {
        val out = ArrayList<TdApi.ChatPosition>()
        out.add(TdApi.ChatPosition(if (isArchived(chatId)) TdApi.ChatListArchive() else TdApi.ChatListMain(), order, false, null))
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
        try { File(dir, "ttl.json").takeIf { it.exists() }?.let { f -> val o = JSONObject(f.readText()); o.keys().forEach { k -> ttl[k] = o.optInt(k) } } } catch (e: Exception) { }
        try { File(dir, "drafts.json").takeIf { it.exists() }?.let { f -> val o = JSONObject(f.readText()); o.keys().forEach { k -> k.toLongOrNull()?.let { id -> o.optJSONObject(k)?.let { drafts[id] = it } } } } } catch (e: Exception) { }
        try { File(dir, "chatlists.json").takeIf { it.exists() }?.let { f -> val o = JSONObject(f.readText()); o.keys().forEach { k -> if (o.optString(k) == "archive") k.toLongOrNull()?.let { archived.add(it) } } } } catch (e: Exception) { }
    }
    private fun write(name: String, text: String) { try { dir.mkdirs(); File(dir, name).writeText(text) } catch (e: Exception) { } }
    private fun saveTtl() = write("ttl.json", JSONObject(ttl as Map<*, *>).toString())
    private fun saveDrafts() = write("drafts.json", JSONObject().also { o -> drafts.forEach { (k, v) -> o.put(k.toString(), v) } }.toString())
    private fun saveLists() = write("chatlists.json", JSONObject().also { o -> archived.forEach { o.put(it.toString(), "archive") } }.toString())
}
