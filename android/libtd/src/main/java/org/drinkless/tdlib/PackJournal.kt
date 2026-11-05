package org.drinkless.tdlib

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * PACK-3 (5 ноя 2026): свои наборы стикеров и эмодзи на всех своих устройствах — вид `packs` журнала личного
 * состояния (поле снимка `sticker_packs`). Запись — ссылка на архив набора в облаке (тот же `pack_ref`, что у
 * стикера в сообщении), ключ записи `set_id` — общий для клиентов: `h:<content_hash>` либо `n:<sanitizeName(name)>`
 * (у клиентов разные локальные id наборов). Здесь — рабочая копия записей (как web `localState.saveStickerPacks`)
 * и сопоставление «ключ журнала → локальный setId» этого устройства. Файл `packs-journal.json`; чистый JVM-класс.
 */
class PackJournal(private val dir: File) {
    /** Итог проекции снимка: записи, которые надо поставить, и локальные наборы, снятые на другом устройстве. */
    class Projection(val records: List<JSONObject>, val removed: List<Long>)

    private val records = LinkedHashMap<String, JSONObject>()
    private val localIds = HashMap<String, Long>()
    private var migrated = false
    private val file get() = File(dir, "packs-journal.json")

    init { load() }

    /** Записи для желаемого снимка (`sticker_packs`). */
    @Synchronized fun records(): JSONArray = JSONArray().also { a -> records.values.forEach { a.put(JSONObject(it.toString())) } }
    @Synchronized fun keys(): Set<String> = records.keys.toSet()
    @Synchronized fun localIdOf(key: String): Long? = localIds[key]
    @Synchronized fun setLocalId(key: String, setId: Long) { if (localIds[key] != setId) { localIds[key] = setId; save() } }
    @Synchronized fun isMigrated() = migrated
    @Synchronized fun markMigrated() { if (!migrated) { migrated = true; save() } }

    /** Установленный набор → запись журнала (замена по ключу). Ключ записи; null — ссылки на архив нет. */
    @Synchronized fun record(ref: JSONObject, isEmoji: Boolean, setId: Long, nowMs: Long = System.currentTimeMillis()): String? {
        val r = wireRef(ref) ?: return null
        val key = keyOf(r) ?: return null
        val prev = records[key]
        localIds[key] = setId
        // Та же ссылка — запись не переписывается (иначе новое added_ms дало бы лишнюю запись журнала)
        if (prev != null && prev.optJSONObject("ref")?.toString() == r.toString() && prev.optBoolean("emoji") == isEmoji) { save(); return key }
        val o = JSONObject().put("set_id", key).put("ref", r).put("added_ms", nowMs.toString())
        if (isEmoji) o.put("emoji", true)
        records.remove(key); records[key] = o
        save(); return key
    }

    /** Набор снят на этом устройстве → записи нет (ключ; null — набор журнал не вёл). */
    @Synchronized fun forget(setId: Long): String? {
        val key = localIds.entries.firstOrNull { it.value == setId }?.key ?: return null
        localIds.remove(key)
        val had = records.remove(key) != null
        save()
        return if (had) key else null
    }

    /**
     * Сведённый снимок → рабочая копия. null — записи не изменились. Снятые записи (были в копии, нет в снимке)
     * отдаются локальными id, сопоставление для них забывается; записи без `ref.file_id`/`set_id` отбрасываются.
     */
    @Synchronized fun project(list: JSONArray?): Projection? {
        val next = LinkedHashMap<String, JSONObject>()
        if (list != null) for (i in 0 until list.length()) {
            val o = list.optJSONObject(i) ?: continue
            val key = o.optString("set_id")
            if (key.isEmpty() || o.optJSONObject("ref")?.optString("file_id").isNullOrEmpty()) continue
            next[key] = o
        }
        if (next.keys.toList() == records.keys.toList() && next.all { (k, v) -> records[k]?.toString() == v.toString() }) return null
        val removed = (records.keys - next.keys).mapNotNull { localIds.remove(it) }
        records.clear(); records.putAll(next)
        save()
        return Projection(next.values.map { JSONObject(it.toString()) }, removed)
    }

    private fun load() {
        if (!file.exists()) return
        try {
            val o = JSONObject(SeamFiles.read(file))
            o.optJSONArray("records")?.let { a -> for (i in 0 until a.length()) a.optJSONObject(i)?.let { r -> r.optString("set_id").takeIf { it.isNotEmpty() }?.let { records[it] = r } } }
            o.optJSONObject("ids")?.let { m -> m.keys().forEach { k -> localIds[k] = m.optLong(k) } }
            migrated = o.optBoolean("migrated")
        } catch (e: Exception) { /* испорчен — журнал вернёт записи следующей проекцией */ }
    }
    private fun save() {
        try {
            dir.mkdirs()
            val ids = JSONObject(); localIds.forEach { (k, v) -> ids.put(k, v) }
            SeamFiles.write(file, JSONObject().put("records", JSONArray(records.values.toList())).put("ids", ids).put("migrated", migrated).toString())
        } catch (e: Exception) { /* диск недоступен — копия живёт в памяти */ }
    }

    companion object {
        private val REF_FIELDS = listOf("file_id", "name", "key", "nonce", "capability", "content_hash", "blob_domain")

        /** Ключ журнала набора: `h:<content_hash>` (PACK-2), иначе `n:<sanitizeName(name)>`; null — нет `file_id`. */
        fun keyOf(ref: JSONObject): String? {
            if (ref.optString("file_id").isEmpty()) return null
            ref.optString("content_hash").takeIf { it.isNotEmpty() }?.let { return "h:$it" }
            return "n:" + EmojiDocId.sanitizeName(ref.optString("name"))
        }

        /** Ссылка набора в виде `state.v1` PackRef (поля схемы; байты — base64, как в `pack_ref` сообщения). */
        fun wireRef(ref: JSONObject): JSONObject? {
            if (ref.optString("file_id").isEmpty()) return null
            val o = JSONObject()
            REF_FIELDS.forEach { f -> ref.optString(f).takeIf { it.isNotEmpty() }?.let { o.put(f, it) } }
            ref.optInt("count").takeIf { it > 0 }?.let { o.put("count", it) }
            return o
        }
    }
}
