package org.drinkless.tdlib

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * spec 035 T137 (US1, contracts/migration.md): читатель старых мест профиля android для разового переноса в хранилище
 * движка — тонкий, как `migrate_legacy.cpp` ядра у desktop. Открывает файлы каталога хранилища ТОЛЬКО на чтение,
 * снимает своё шифрование хранилища (`storecrypt` ядра — через [read], на устройстве это [SeamFiles.read]) и отдаёт
 * записи как есть: `{key, value}`, где `key` — ключ по перечню `specs/035-protocol-evolution/migration-inventory.json`
 * (слой android: файлы шва — `file:<имя>`, файлы ядра — `file:/<имя>`, каталог состояния v2 — `file:/v2-<адрес>/<имя>`),
 * `value` — открытый текст. Разбор форматов — в движке (`backend/protocol/src/migrate/android.rs`,
 * `migrateStep{legacy_input}`). Файлы не меняются и не удаляются: стирание старого — вручную по решению пользователя
 * (D2), после переноса они только помечаются «перенесено».
 *
 * Берутся только записи с судьбой `migrate` (производное — `drop-derived`/`recompute` — движок пересчитывает,
 * настройки устройства — `keep` — остаются на месте). Чистый JVM.
 */
object MigrateLegacy {
    class Record(val key: String, val value: ByteArray)

    class Collected(val records: List<Record>, val unreadable: List<String>) {
        fun isEmpty() = records.isEmpty() && unreadable.isEmpty()
    }

    /** Файлы шва (без адреса в имени), судьба migrate. */
    val SEAM_FILES = listOf(
        "contacts.json", "drafts.json", "folders.json", "meta.json", "packs-journal.json", "packs.json", "pending.json",
        "pins.json", "privacy.json", "renames.json", "scheduled.json", "stickers-state.json", "ttl.json",
    )

    /** Файлы ядра без адреса в имени, судьба migrate (`/` — каталог хранилища ядра, как ключ перечня `file:/…`). */
    val CORE_FILES = listOf("/domain-keys.json", "/sections-records.json")

    /** Каталог состояния v2 `v2-<адрес>/` (тот же набор, что у ядра desktop). */
    val V2_FILES = listOf(
        "bundle-key", "bundle-seq", "device", "device-id", "groups-reshared-v1", "invites", "invites-shared", "key",
        "root", "root-backup", "root-backup-received", "root-backup-sent", "root-escrow", "state",
    ) // + записи разделов устройства — тот же файл, что [CORE_FILES]

    /** Безопасная часть адреса в именах файлов (как `accountfiles::safePart` ядра). */
    fun safePart(address: String): String = address.map { c ->
        if ((c in 'a'..'z') || (c in 'A'..'Z') || (c in '0'..'9') || c == '@' || c == '.' || c == '-') c else '_'
    }.joinToString("")

    /** Ключ записи по перечню для пути от каталога хранилища ("" — не переносится: не из перечня, производное, чужой аккаунт). */
    fun keyFor(rel: String, self: String): String {
        if (self.isEmpty()) return ""
        val safe = safePart(self)
        val slash = rel.indexOf('/')
        if (slash >= 0) {
            if (rel.substring(0, slash) != "v2-$safe") return ""
            val name = rel.substring(slash + 1)
            return if (name in V2_FILES || "/$name" in CORE_FILES) "file:/$rel" else ""
        }
        if (rel in SEAM_FILES) return "file:$rel"
        if ("/$rel" in CORE_FILES) return "file:/$rel"
        // журнал истории ядра: служебные документы и отметки — раньше строк (общий префикс `history-`)
        if (rel.startsWith("history-sync-$safe-")) return "file:/$rel"
        if (rel == "history-marks-$safe.json" || rel == "history-local-$safe.json" || rel == "history-$safe.jsonl") return "file:/$rel"
        return ""
    }

    /** Собрать записи аккаунта [self] из каталога хранилища [dir]. [read] — открытый текст файла либо null (не открылся). */
    fun collect(dir: File, self: String, read: (File) -> String?): Collected {
        if (self.isEmpty() || !dir.isDirectory) return Collected(emptyList(), emptyList())
        val rel = ArrayList<String>()
        dir.listFiles()?.forEach { f ->
            if (f.isFile) rel += f.name
            else if (f.isDirectory && f.name == "v2-${safePart(self)}") f.listFiles()?.filter { it.isFile }?.forEach { rel += "${f.name}/${it.name}" }
        }
        rel.sort()
        val records = ArrayList<Record>()
        val unreadable = ArrayList<String>()
        for (r in rel) {
            val key = keyFor(r, self)
            if (key.isEmpty()) continue
            val text = try { read(File(dir, r)) } catch (e: Exception) { null }
            if (text == null) unreadable += key else records += Record(key, text.toByteArray(Charsets.UTF_8))
        }
        return Collected(records, unreadable)
    }

    /** Граница движка: `{"records": [{"key", "value": base64}], "unreadable": [...]}` (LegacyRecord, proto3-JSON). */
    fun toJson(c: Collected): JSONObject {
        val records = JSONArray()
        c.records.forEach { r -> records.put(JSONObject().put("key", r.key).put("value", java.util.Base64.getEncoder().encodeToString(r.value))) }
        return JSONObject().put("records", records).put("unreadable", JSONArray(c.unreadable))
    }
}
