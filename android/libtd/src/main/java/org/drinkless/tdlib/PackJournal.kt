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
    /**
     * Итог проекции снимка: записи наборов, которые надо поставить, и локальные наборы, снятые на другом устройстве;
     * GIF-1 — записи сохранённых GIF (`g:<sha256 hex>`, не наборы) и ключи снятых.
     */
    class Projection(val records: List<JSONObject>, val removed: List<Long>,
                     val gifs: List<JSONObject> = emptyList(), val gifsRemoved: List<String> = emptyList())

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

    /**
     * GIF-1: сохранённый GIF → запись `g:<sha256 hex>` ссылкой на сам файл (count 1, content_hash — base64 сырых 32
     * байт sha256, emoji нет). Ключ записи; null — нет `file_id` или sha256 не 64 hex. Та же ссылка — без перезаписи.
     */
    @Synchronized fun recordGif(ref: JSONObject, sha256Hex: String, nowMs: Long = System.currentTimeMillis()): String? {
        val hex = sha256Hex.lowercase()
        val raw = hexToBytes(hex)?.takeIf { it.size == 32 } ?: return null
        val r = wireRef(JSONObject(ref.toString()).put("count", 1).put("content_hash", java.util.Base64.getEncoder().encodeToString(raw))) ?: return null
        val key = GIF_PREFIX + hex
        val prev = records[key]
        if (prev != null && prev.optJSONObject("ref")?.toString() == r.toString()) return key
        records.remove(key)
        records[key] = JSONObject().put("set_id", key).put("ref", r).put("added_ms", nowMs.toString())
        save(); return key
    }

    /** GIF-1: GIF убран из сохранённых на этом устройстве → записи нет. true — запись была. */
    @Synchronized fun forgetGif(sha256Hex: String): Boolean {
        val had = records.remove(GIF_PREFIX + sha256Hex.lowercase()) != null
        if (had) save()
        return had
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
        val gone = records.keys - next.keys
        val removed = gone.filterNot { isGifKey(it) }.mapNotNull { localIds.remove(it) }
        val gifsRemoved = gone.filter { isGifKey(it) }.map { it.removePrefix(GIF_PREFIX) }
        records.clear(); records.putAll(next)
        save()
        val (gifs, packs) = next.entries.partition { isGifKey(it.key) }
        return Projection(packs.map { JSONObject(it.value.toString()) }, removed, gifs.map { JSONObject(it.value.toString()) }, gifsRemoved)
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
        /** GIF-1: ключ записи сохранённого GIF — `g:<sha256 содержимого, hex>`. */
        const val GIF_PREFIX = "g:"
        fun isGifKey(key: String) = key.startsWith(GIF_PREFIX)
        private fun hexToBytes(hex: String): ByteArray? {
            if (hex.length % 2 != 0 || hex.any { Character.digit(it, 16) < 0 }) return null
            return ByteArray(hex.length / 2) { i -> ((Character.digit(hex[2 * i], 16) shl 4) or Character.digit(hex[2 * i + 1], 16)).toByte() }
        }

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
