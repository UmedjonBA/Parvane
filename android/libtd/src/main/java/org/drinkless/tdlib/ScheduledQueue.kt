package org.drinkless.tdlib

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * spec 005 / история 3: локальная очередь отложенных сообщений (`scheduled.json`
 * в каталоге ядра) — как web `parvane:scheduled:<self>` и desktop
 * `tdata/parvane-scheduled.json`, но с медиа (путь локальной копии). Сервер
 * ничего не знает; срабатывание — отправка штатным путём. Id для X — из
 * отдельного диапазона [ID_BASE], чтобы не пересекаться с историей.
 * Чистый JVM-класс: часы инжектируются.
 */
class ScheduledQueue(private val dir: File, private val now: () -> Long = { System.currentTimeMillis() / 1000 }) {
    class Item(val id: Long, val uuid: String, val chatId: Long, val to: String, val content: JSONObject,
               val localPath: String?, val replyTo: String?, var due: Long, val createdAt: Long) {
        fun toJson(): JSONObject = JSONObject().put("id", id).put("uuid", uuid).put("chatId", chatId).put("to", to).put("content", content)
            .put("localPath", localPath ?: JSONObject.NULL).put("replyTo", replyTo ?: JSONObject.NULL).put("due", due).put("createdAt", createdAt)
        companion object {
            fun fromJson(o: JSONObject) = Item(o.optLong("id"), o.optString("uuid"), o.optLong("chatId"), o.optString("to"), o.optJSONObject("content") ?: JSONObject(),
                if (o.isNull("localPath")) null else o.optString("localPath"), if (o.isNull("replyTo")) null else o.optString("replyTo"), o.optLong("due"), o.optLong("createdAt"))
        }
    }

    private val items = LinkedHashMap<Long, Item>()
    private var nextId = ID_BASE
    private val file get() = File(dir, "scheduled.json")

    init { load() }

    @Synchronized fun all(): List<Item> = items.values.sortedBy { it.due }
    @Synchronized fun forChat(chatId: Long): List<Item> = all().filter { it.chatId == chatId }
    @Synchronized fun get(id: Long): Item? = items[id]
    fun isScheduledId(id: Long) = id >= ID_BASE

    @Synchronized
    fun add(uuid: String, chatId: Long, to: String, content: JSONObject, localPath: String?, replyTo: String?, due: Long): Item {
        val it = Item(nextId++, uuid, chatId, to, content, localPath, replyTo, due, now())
        items[it.id] = it; save(); return it
    }
    @Synchronized fun remove(id: Long): Item? = items.remove(id)?.also { save() }
    @Synchronized fun reschedule(id: Long, due: Long): Item? = items[id]?.also { it.due = due; save() }
    /** Просроченные (due ≤ now) — в порядке срока; удаляются из очереди (отправка — у вызывающего). */
    @Synchronized fun takeDue(): List<Item> {
        val t = now()
        val due = items.values.filter { it.due <= t }.sortedBy { it.due }
        due.forEach { items.remove(it.id) }
        if (due.isNotEmpty()) save()
        return due
    }
    /** Ближайший срок (сек) или null. */
    @Synchronized fun nextDue(): Long? = items.values.minOfOrNull { it.due }

    // Файл: {"next": <следующий id>, "items": [...]} — id не переиспользуются после
    // удаления (X может ещё держать удалённый отложенный по id).
    private fun load() {
        if (!file.exists()) return
        try {
            val root = JSONObject(file.readText())
            nextId = maxOf(ID_BASE, root.optLong("next", ID_BASE))
            val arr = root.optJSONArray("items") ?: JSONArray()
            for (i in 0 until arr.length()) arr.optJSONObject(i)?.let { val it = Item.fromJson(it); items[it.id] = it; if (it.id >= nextId) nextId = it.id + 1 }
        } catch (e: Exception) { /* битый файл — пустая очередь */ }
    }
    private fun save() {
        try {
            dir.mkdirs()
            file.writeText(JSONObject().put("next", nextId).put("items", JSONArray().also { a -> items.values.forEach { a.put(it.toJson()) } }).toString())
        } catch (e: Exception) { }
    }

    companion object {
        /** Диапазон id отложенных (кратны 2^20 как серверные, но с высоким смещением). */
        const val ID_BASE: Long = 1L shl 40
    }
}
