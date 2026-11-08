package org.drinkless.tdlib

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * spec 035 T137 (US1): читатель старых мест профиля android ([MigrateLegacy]) — только записи с судьбой `migrate`
 * перечня, ключи перечня, открытый текст через кодек хранилища, файлы не трогаются; что не открылось — в отчёт.
 */
class MigrateLegacyTest {
    private val self = "alice@local"
    private val safe = MigrateLegacy.safePart(self)

    @Test
    fun collectsOnlyMigrateRecordsWithInventoryKeys() {
        val dir = Files.createTempDirectory("pv-migrate").toFile()
        try {
            val write = { rel: String, text: String -> File(dir, rel).also { it.parentFile.mkdirs() }.writeText("enc:$text") }
            write("folders.json", """{"folders":[]}""")
            write("contacts.json", "{}")
            write("domain-keys.json", "{}")
            write("history-$safe.jsonl", "{\"row\":1}\n")
            write("history-marks-$safe.json", "{}")
            write("history-sync-$safe-meta.json", "{}")
            write("v2-$safe/state", "blob")
            write("v2-$safe/key", "k")
            write("v2-$safe/cache-tmp", "x")          // не из перечня
            write("v2-bob@local/state", "чужое")       // чужой аккаунт
            write("journal.jsonl", "{}")               // drop-derived
            write("cursors.json", "{}")                // drop-derived
            write("l2-chats.json", "{}")               // recompute
            write("session.json", "{}")                // keep
            write("pins.json", "битое")                 // не открылось
            val before = dir.walkTopDown().filter { it.isFile }.associate { it.path to it.readText() }
            val c = MigrateLegacy.collect(dir, self) { f ->
                val t = f.readText()
                if (f.name == "pins.json") null else t.removePrefix("enc:")
            }
            assertEquals(
                listOf("file:contacts.json", "file:/domain-keys.json", "file:folders.json", "file:/history-marks-$safe.json",
                    "file:/history-sync-$safe-meta.json", "file:/history-$safe.jsonl", "file:/v2-$safe/key", "file:/v2-$safe/state").sorted(),
                c.records.map { it.key }.sorted())
            assertEquals(listOf("file:pins.json"), c.unreadable)
            assertEquals("""{"folders":[]}""", String(c.records.first { it.key == "file:folders.json" }.value))
            val j = MigrateLegacy.toJson(c)
            assertEquals(8, j.getJSONArray("records").length())
            assertEquals("blob", String(java.util.Base64.getDecoder().decode(
                (0 until 8).map { j.getJSONArray("records").getJSONObject(it) }.first { it.getString("key") == "file:/v2-$safe/state" }.getString("value"))))
            // только чтение: файлы на месте и не изменены
            assertEquals(before, dir.walkTopDown().filter { it.isFile }.associate { it.path to it.readText() })
        } finally {
            dir.deleteRecursively()
        }
    }

    /** Перечень хранимого (локальный, вне git): каждый файл слоя android с судьбой migrate читается, прочие — нет. */
    @Test
    fun matchesInventoryFates() {
        val inv = listOf("../../specs/035-protocol-evolution/migration-inventory.json", "../specs/035-protocol-evolution/migration-inventory.json")
            .map { File(it) }.firstOrNull { it.isFile }
        assumeTrue("перечня хранимого нет (локальный файл)", inv != null)
        val entries = JSONObject(inv!!.readText()).getJSONArray("entries")
        var checked = 0
        for (i in 0 until entries.length()) {
            val e = entries.getJSONObject(i)
            if (e.optString("layer") != "android") continue
            val key = e.getString("key")
            if (!key.startsWith("file:") || key.endsWith("/")) continue
            val name = key.removePrefix("file:").removePrefix("/")
            val rel = when {
                name == "v2-" -> "v2-$safe/state"
                name == "history-" -> "history-$safe.jsonl"
                name == "history-sync-" -> "history-sync-$safe-meta.json"
                name.endsWith("-") -> "$name$safe.json"
                else -> name
            }
            val got = MigrateLegacy.keyFor(rel, self)
            if (e.optString("fate") == "migrate") {
                assertTrue("$key (${e.optString("kind")}): судьба migrate, а читатель не берёт $rel", got.isNotEmpty())
                assertEquals("$key: место (ядро — `file:/`, шов — `file:`)", key.startsWith("file:/"), got.startsWith("file:/"))
            } else {
                assertEquals("$key: судьба ${e.optString("fate")}, а читатель берёт $rel", "", got)
            }
            checked++
        }
        assertTrue("записей android в перечне: $checked", checked > 30)
    }
}
