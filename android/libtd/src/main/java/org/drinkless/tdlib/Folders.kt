package org.drinkless.tdlib

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * spec 005 / история 4: папки чатов — локальные, как у web (`parvane:folders:<self>`)
 * и desktop (`tdata/parvane-folders.json`); сервер о папках не знает. Файл
 * `folders.json`: `{"next": id, "main": позиция, "folders": [{id, title, icon, colorId,
 * pinned[], included[], excluded[], excludeMuted, excludeRead, excludeArchived,
 * includeContacts, includeNonContacts, includeBots, includeGroups, includeChannels}]}`.
 * Членство чата — как TDLib: явно включён, либо подходит по флагам и не исключён.
 * Чистый JVM-класс.
 */
class Folders(private val dir: File) {
    class Folder(val id: Int, var title: String, var icon: String, var colorId: Int, var pinned: List<Long>, var included: List<Long>, var excluded: List<Long>,
                 var excludeMuted: Boolean, var excludeRead: Boolean, var excludeArchived: Boolean,
                 var includeContacts: Boolean, var includeNonContacts: Boolean, var includeBots: Boolean, var includeGroups: Boolean, var includeChannels: Boolean) {
        fun toJson(): JSONObject = JSONObject().put("id", id).put("title", title).put("icon", icon).put("colorId", colorId)
            .put("pinned", JSONArray(pinned)).put("included", JSONArray(included)).put("excluded", JSONArray(excluded))
            .put("excludeMuted", excludeMuted).put("excludeRead", excludeRead).put("excludeArchived", excludeArchived)
            .put("includeContacts", includeContacts).put("includeNonContacts", includeNonContacts).put("includeBots", includeBots)
            .put("includeGroups", includeGroups).put("includeChannels", includeChannels)
        fun toTd(): TdApi.ChatFolder = TdApi.ChatFolder(TdApi.ChatFolderName(TdApi.FormattedText(title, arrayOf()), false),
            if (icon.isEmpty()) null else TdApi.ChatFolderIcon(icon), colorId, false, pinned.toLongArray(), included.toLongArray(), excluded.toLongArray(),
            excludeMuted, excludeRead, excludeArchived, includeContacts, includeNonContacts, includeBots, includeGroups, includeChannels)
        fun toInfo(): TdApi.ChatFolderInfo = TdApi.ChatFolderInfo(id, TdApi.ChatFolderName(TdApi.FormattedText(title, arrayOf()), false),
            if (icon.isEmpty()) null else TdApi.ChatFolderIcon(icon), colorId, false, false)
        companion object {
            fun longs(a: JSONArray?): List<Long> = if (a == null) emptyList() else (0 until a.length()).map { a.optLong(it) }
            fun fromJson(o: JSONObject) = Folder(o.optInt("id"), o.optString("title"), o.optString("icon"), o.optInt("colorId", -1),
                longs(o.optJSONArray("pinned")), longs(o.optJSONArray("included")), longs(o.optJSONArray("excluded")),
                o.optBoolean("excludeMuted"), o.optBoolean("excludeRead"), o.optBoolean("excludeArchived"),
                o.optBoolean("includeContacts"), o.optBoolean("includeNonContacts"), o.optBoolean("includeBots"), o.optBoolean("includeGroups"), o.optBoolean("includeChannels"))
            fun fromTd(id: Int, f: TdApi.ChatFolder) = Folder(id, f.name?.text?.text ?: "", f.icon?.name ?: "", f.colorId, f.pinnedChatIds.toList(), f.includedChatIds.toList(), f.excludedChatIds.toList(),
                f.excludeMuted, f.excludeRead, f.excludeArchived, f.includeContacts, f.includeNonContacts, f.includeBots, f.includeGroups, f.includeChannels)
        }
    }

    /** Признаки чата для флагов папки. */
    class ChatFacts(val isGroup: Boolean, val isChannel: Boolean, val isContact: Boolean, val isMuted: Boolean, val isRead: Boolean, val isArchived: Boolean)

    private val folders = LinkedHashMap<Int, Folder>()
    // id 0 и 1 зарезервированы («все чаты», архив) — как в журнале личного
    // состояния v2 (spec 007, T098) и у web/desktop; новые папки — с 2
    private var nextId = FIRST_ID
    var mainPosition = 0; private set
    private val file get() = File(dir, "folders.json")

    init { load() }

    @Synchronized fun all(): List<Folder> = folders.values.toList()
    @Synchronized fun get(id: Int): Folder? = folders[id]
    @Synchronized fun create(f: TdApi.ChatFolder): Folder { val fo = Folder.fromTd(nextId++, f); folders[fo.id] = fo; save(); return fo }
    @Synchronized fun edit(id: Int, f: TdApi.ChatFolder): Folder? { if (!folders.containsKey(id)) return null; val fo = Folder.fromTd(id, f); folders[id] = fo; save(); return fo }
    @Synchronized fun delete(id: Int): Boolean = (folders.remove(id) != null).also { if (it) save() }
    @Synchronized fun reorder(ids: IntArray, main: Int) {
        val re = LinkedHashMap<Int, Folder>(); ids.forEach { id -> folders[id]?.let { re[id] = it } }; folders.values.forEach { if (!re.containsKey(it.id)) re[it.id] = it }
        folders.clear(); folders.putAll(re); mainPosition = main; save()
    }
    /** Весь список из журнала состояния (spec 007, T098): порядок — как в [list]. */
    @Synchronized fun replaceAll(list: List<Folder>) {
        folders.clear(); list.forEach { folders[it.id] = it; if (it.id >= nextId) nextId = it.id + 1 }; save()
    }
    @Synchronized fun infos(): Array<TdApi.ChatFolderInfo> = folders.values.map { it.toInfo() }.toTypedArray()

    /** Папки, в которые входит чат. */
    @Synchronized fun foldersOf(chatId: Long, facts: ChatFacts): List<Folder> = folders.values.filter { contains(it, chatId, facts) }
    fun contains(f: Folder, chatId: Long, facts: ChatFacts): Boolean {
        if (chatId in f.excluded) return false
        if (chatId in f.included || chatId in f.pinned) return true
        val byFlag = (facts.isGroup && f.includeGroups) || (facts.isChannel && f.includeChannels) || (!facts.isGroup && !facts.isChannel && facts.isContact && f.includeContacts)
            || (!facts.isGroup && !facts.isChannel && !facts.isContact && f.includeNonContacts)
        if (!byFlag) return false
        if (f.excludeMuted && facts.isMuted) return false
        if (f.excludeRead && facts.isRead) return false
        if (f.excludeArchived && facts.isArchived) return false
        return true
    }

    private fun load() {
        if (!file.exists()) return
        try {
            val root = JSONObject(SeamFiles.read(file))
            nextId = root.optInt("next", 1); mainPosition = root.optInt("main", 0)
            val arr = root.optJSONArray("folders") ?: JSONArray()
            for (i in 0 until arr.length()) arr.optJSONObject(i)?.let { val f = Folder.fromJson(it); folders[f.id] = f; if (f.id >= nextId) nextId = f.id + 1 }
            nextId = maxOf(nextId, FIRST_ID)
            // Папка с зарезервированным id (старые файлы начинали с 1) — новый id, порядок тот же
            if (folders.keys.any { it < FIRST_ID }) {
                val re = LinkedHashMap<Int, Folder>()
                folders.values.forEach { f -> val id = if (f.id < FIRST_ID) nextId++ else f.id; re[id] = if (id == f.id) f else Folder.fromJson(f.toJson().put("id", id)) }
                folders.clear(); folders.putAll(re); save()
            }
        } catch (e: Exception) { }
    }
    companion object { const val FIRST_ID = 2 }

    private fun save() {
        try { dir.mkdirs(); SeamFiles.write(file, JSONObject().put("next", nextId).put("main", mainPosition).put("folders", JSONArray().also { a -> folders.values.forEach { a.put(it.toJson()) } }).toString()) } catch (e: Exception) { }
    }
}
