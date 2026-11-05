package org.drinkless.tdlib

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * PACK-3: свои наборы стикеров и эмодзи на всех своих устройствах через журнал личного состояния (вид `packs`,
 * поле снимка `sticker_packs`). Два «устройства» с фейковым ядром: установка → запись → снимок журнала
 * (сведение — движок, здесь снимок = желаемое) → проекция на втором устройстве ставит набор; удаление — снимает.
 */
class PackJournalTest {
    private class FakeCore(private val root: File) : Stickers.Core {
        var fetches = 0; var uploads = 0
        override fun packFetch(refJson: String): JSONObject {
            fetches++
            val ref = JSONObject(refJson)
            val dir = File(root, "packs/" + EmojiDocId.sanitizeName(ref.optString("name"))).also { it.mkdirs() }
            File(dir, "00-1f600.webp").writeBytes(byteArrayOf(1, 2, 3))
            return JSONObject().put("ok", true).put("dir", dir.absolutePath)
                .put("files", JSONArray().put(JSONObject().put("name", "00-1f600.webp").put("size", 3)))
        }
        override fun packRefFor(dir: String, rawName: String, recipients: List<String>): JSONObject {
            uploads++
            return JSONObject().put("file_id", "01a0f000-0000-7000-8000-0000000000f$uploads").put("name", rawName).put("count", 1).put("key", "k").put("nonce", "n")
        }
    }

    private class Device {
        val root: File = Files.createTempDirectory("pv-pj").toFile()
        val core = FakeCore(root)
        val updates = ArrayList<TdApi.Update>()
        var flushes = 0
        val st = Stickers(ParvaneStore().apply { self = "alice@local" }, root, { updates.add(it) }, core) { flushes++ }
        /** Снимок журнала — так, как его отдаст движок (записи вида `packs`). */
        fun snapshot(): JSONObject = JSONObject().put("sticker_packs", st.journal.records())
    }

    private val codec = object : StateJournal.Codec {
        override fun encode(type: String, json: String) = ""
        override fun decode(type: String, b64: String) = ""
        override fun toV2(v1Json: String, replyTo: String) = ""
        override fun fromV2(v2Json: String) = ""
    }
    private val resolver = object : StateJournal.Resolver {
        override fun addressOf(chatId: Long): String? = null
        override fun chatIdOf(address: String): Long? = null
        override fun domain() = "local"
        override fun isKnownV2Group(hex: String) = false
    }

    private fun ref(name: String, hash: String? = null) = JSONObject().put("file_id", "01a0f000-0000-7000-8000-0000000000aa").put("name", name)
        .put("count", 1).put("key", "k").put("nonce", "n").also { r -> hash?.let { r.put("content_hash", it) } }

    @Test
    fun keyIsContentHashOrSanitizedName() {
        assertEquals("h:QUJD", PackJournal.keyOf(ref("Cats!", "QUJD")))
        assertEquals("n:Cats", PackJournal.keyOf(ref("Cats!")))
        assertNull(PackJournal.keyOf(JSONObject().put("name", "Cats")))
        // поля схемы PackRef, лишнее отбрасывается
        val w = PackJournal.wireRef(ref("Cats").put("dir", "/x").put("uploadedFor", JSONArray()))!!
        assertFalse(w.has("dir")); assertFalse(w.has("uploadedFor")); assertEquals(1, w.optInt("count"))
    }

    @Test
    fun installOnOneDeviceAppearsAndDisappearsOnAnother() {
        val a = Device(); val b = Device()
        // A: набор пришёл в сообщении и установлен → запись журнала (ключ по имени), вид `packs` досылается
        a.st.onReceived(JSONObject().put("kind", "sticker").put("file_id", "f1").put("pack_ref", ref("Cats")))
        val pa = a.st.index.byRawName("Cats", false)!!
        assertTrue(a.st.change(pa.setId, true, false) is TdApi.Ok)
        assertEquals(1, a.flushes)
        val rec = a.st.journal.records().getJSONObject(0)
        assertEquals("n:Cats", rec.optString("set_id"))
        assertEquals("01a0f000-0000-7000-8000-0000000000aa", rec.getJSONObject("ref").optString("file_id"))
        assertNotNull(rec.optString("added_ms").toLongOrNull())
        // повторная установка той же ссылкой — журнал не трогается
        assertTrue(a.st.change(pa.setId, true, false) is TdApi.Ok)
        assertEquals(1, a.flushes)

        // B: снимок журнала → проекция → набор скачан по ссылке и установлен без подтверждения
        val j = StateJournal(codec, resolver)
        val lb = ChatLocalState(b.root)
        val ch = j.project(a.snapshot(), lb, ScheduledQueue(b.root) { 1000L }, packs = b.st.journal)
        val pr = ch.packs!!
        assertTrue(ch.any())
        b.st.applyJournal(pr)
        val pb = b.st.index.byRawName("Cats", false)!!
        assertTrue(pb.installed); assertEquals(1, b.core.fetches)
        assertEquals(pb.setId, b.st.journal.localIdOf("n:Cats"))
        assertTrue(b.updates.any { it is TdApi.UpdateInstalledStickerSets && it.stickerSetIds.contains(pb.setId) })
        assertEquals(0, b.flushes) // установка из журнала обратно в журнал не пишется
        // желаемое B несёт ту же запись — синк B ничего не снимет
        val desired = j.build(lb, ScheduledQueue(b.root) { 1000L }, packs = b.st.journal)
        assertEquals("n:Cats", desired.getJSONArray("sticker_packs").getJSONObject(0).optString("set_id"))
        // тот же снимок ещё раз — без изменений
        assertNull(j.project(a.snapshot(), lb, ScheduledQueue(b.root) { 1000L }, packs = b.st.journal).packs)

        // A удаляет набор → записи нет → B снимает его
        assertTrue(a.st.change(pa.setId, false, false) is TdApi.Ok)
        assertEquals(2, a.flushes)
        assertEquals(0, a.st.journal.records().length())
        val ch2 = j.project(a.snapshot(), lb, ScheduledQueue(b.root) { 1000L }, packs = b.st.journal)
        assertEquals(listOf(pb.setId), ch2.packs!!.removed)
        b.st.applyJournal(ch2.packs!!)
        assertFalse(b.st.index.bySetId(pb.setId)!!.installed)
    }

    @Test
    fun sameContentHashMapsToExistingLocalPack() {
        val a = Device(); val b = Device()
        val pa = a.st.index.registerReceived(ref("Dogs", "SEFTSA=="), false)
        assertTrue(a.st.change(pa.setId, true, false) is TdApi.Ok)
        assertEquals("h:SEFTSA==", a.st.journal.records().getJSONObject(0).optString("set_id"))
        // B уже ставил этот набор сам (до журнала) — второй раз не скачивается, сопоставление запоминается
        val pb = b.st.index.registerReceived(ref("Dogs", "SEFTSA=="), false)
        assertTrue(b.st.change(pb.setId, true, false) is TdApi.Ok)
        val fetched = b.core.fetches
        b.st.applyJournal(b.st.journal.project(a.snapshot().getJSONArray("sticker_packs"))!!)
        assertEquals(fetched, b.core.fetches)
        assertEquals(pb.setId, b.st.journal.localIdOf("h:SEFTSA=="))
    }

    @Test
    fun migrationRecordsInstalledPacksWithRefOnce() {
        val d = Device()
        d.st.index.addBuiltin("ParvaneStickers", false, File(d.root, "builtin/s").absolutePath, listOf("00-1f600.png"), 512)
        val withRef = d.st.index.registerReceived(ref("Cats"), false)
        d.st.index.materialize(withRef, File(d.root, "packs/Cats").absolutePath, listOf("00-1f600.webp"), install = true)
        val noRef = d.st.index.registerReceived(ref("Bare"), true)
        d.st.index.materialize(noRef, File(d.root, "packs/Bare").absolutePath, listOf("00-1f600.webp"), install = true)
        noRef.ref = null
        val notInstalled = d.st.index.registerReceived(ref("Later"), false)
        assertTrue(d.st.migrateToJournal())
        val keys = d.st.journal.keys()
        assertEquals(setOf("n:Cats"), keys) // встроенные, без ссылки и не установленные — не пишутся
        assertEquals(withRef.setId, d.st.journal.localIdOf("n:Cats"))
        assertNull(d.st.journal.localIdOf("n:Later")); assertFalse(notInstalled.installed)
        assertFalse(d.st.migrateToJournal()) // один раз на устройство
        // копия переживает перезапуск
        assertTrue(PackJournal(d.root).isMigrated())
        assertEquals(setOf("n:Cats"), PackJournal(d.root).keys())
    }

    @Test
    fun recordsWithoutFileIdOrKeyAreDropped() {
        val pj = PackJournal(Files.createTempDirectory("pv-pj").toFile())
        val list = JSONArray()
            .put(JSONObject().put("set_id", "").put("ref", ref("A")))
            .put(JSONObject().put("set_id", "n:B").put("ref", JSONObject().put("name", "B")))
            .put(JSONObject().put("set_id", "n:C").put("ref", ref("C")))
        val pr = pj.project(list)!!
        assertEquals(listOf("n:C"), pr.records.map { it.optString("set_id") })
    }
}
