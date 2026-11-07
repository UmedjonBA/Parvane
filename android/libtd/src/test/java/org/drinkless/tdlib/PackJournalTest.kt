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
        /** GIF-1: «облако» — общее для устройств теста (file_id → байты); sha256 сверяется, как ядро. */
        var gifFetches = 0
        override fun gifFetch(refJson: String, wantHex: String): JSONObject {
            gifFetches++
            val ref = JSONObject(refJson)
            val fid = ref.optString("file_id")
            val bytes = cloud[fid] ?: return JSONObject().put("ok", false).put("error", "нет сети")
            val hex = sha256Hex(bytes)
            if (wantHex.isNotEmpty() && wantHex != hex) return JSONObject().put("ok", false).put("error", "sha256 не совпал")
            val f = File(root, "media-$fid").also { it.writeBytes(bytes) }
            return JSONObject().put("ok", true).put("path", f.absolutePath).put("sha256", hex).put("size", bytes.size)
        }
    }

    private companion object {
        val cloud = HashMap<String, ByteArray>()
        fun sha256Hex(b: ByteArray) = java.security.MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }

    private class Device {
        val root: File = Files.createTempDirectory("pv-pj").toFile()
        val core = FakeCore(root)
        val updates = ArrayList<TdApi.Update>()
        var flushes = 0
        val store = ParvaneStore().apply { self = "alice@local" }
        val st = Stickers(store, root, { updates.add(it) }, core) { flushes++ }
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

    /**
     * GIF-1: «Сохранить в GIF» на A — запись `g:<sha256>` ссылкой на сам файл (без повторной загрузки); на B она не
     * набор стикеров: файл скачивается по ссылке, sha256 сверяется, GIF — в сохранённых; удаление на A снимает на B.
     */
    @Test
    fun savedGifSyncsAsFileNotStickerPack() {
        val a = Device(); val b = Device()
        val bytes = "GIF89a-parvane-test".toByteArray()
        val fid = "01a0f000-0000-7000-8000-0000000000g1"
        cloud[fid] = bytes
        val hex = sha256Hex(bytes)
        // A: GIF из чата (уже скачан — рабочая копия есть)
        val local = File(a.root, "chat.gif").also { it.writeBytes(bytes) }
        val tdFile = a.store.fileFor(fid, "a2V5", "bm9uY2U=", bytes.size.toLong(), "image/gif", local.absolutePath)
        assertTrue(a.st.addSavedAnimation(TdApi.InputFileId(tdFile.id)) is TdApi.Ok)
        assertEquals(1, a.flushes)
        assertEquals(0, a.core.gifFetches) // sha256 — по рабочей копии, без сети и без загрузки
        val rec = a.st.journal.records().getJSONObject(0)
        assertEquals("g:$hex", rec.optString("set_id"))
        val r = rec.getJSONObject("ref")
        assertEquals(fid, r.optString("file_id")); assertEquals(1, r.optInt("count")); assertEquals("animation.gif", r.optString("name"))
        assertEquals("a2V5", r.optString("key"))
        assertEquals(java.util.Base64.getEncoder().encodeToString(java.security.MessageDigest.getInstance("SHA-256").digest(bytes)), r.optString("content_hash"))
        assertFalse(rec.has("emoji"))
        // повторное сохранение — журнал не трогается
        assertTrue(a.st.addSavedAnimation(TdApi.InputFileId(tdFile.id)) is TdApi.Ok)
        assertEquals(1, a.flushes)

        // B: проекция — запись не набор (наборов нет), GIF скачан и сверен
        val pr = b.st.journal.project(a.snapshot().getJSONArray("sticker_packs"))!!
        assertTrue(pr.records.isEmpty()); assertEquals(1, pr.gifs.size)
        b.st.applyJournal(pr)
        assertEquals(0, b.st.index.all().count { !it.builtin })
        assertEquals(0, b.core.fetches) // архив набора не запрашивался
        assertEquals(1, b.st.savedAnimations().animations.size)
        assertTrue(b.updates.any { it is TdApi.UpdateSavedAnimations && it.animationIds.size == 1 })
        assertEquals(0, b.flushes) // из журнала обратно в журнал не пишется

        // A убирает GIF → sticker_pack_remove (записи нет) → B убирает
        assertTrue(a.st.removeSavedAnimation(TdApi.InputFileId(tdFile.id)) is TdApi.Ok)
        assertEquals(2, a.flushes)
        assertEquals(0, a.st.journal.records().length())
        val pr2 = b.st.journal.project(a.snapshot().getJSONArray("sticker_packs"))!!
        assertEquals(listOf(hex), pr2.gifsRemoved); assertTrue(pr2.removed.isEmpty())
        b.st.applyJournal(pr2)
        assertEquals(0, b.st.savedAnimations().animations.size)
    }

    /** GIF-1: файл, не совпавший с sha256 записи, не добавляется; без сети — повтор позже. */
    @Test
    fun journalGifWithWrongHashOrOfflineIsNotAdded() {
        val b = Device()
        val fid = "01a0f000-0000-7000-8000-0000000000g2"
        val good = "GIF89a-good".toByteArray()
        val rec = { hex: String -> JSONObject().put("set_id", "g:$hex").put("added_ms", "5")
            .put("ref", JSONObject().put("file_id", fid).put("name", "cat.mp4").put("count", 1)) }
        // подменённое содержимое
        cloud[fid] = "evil".toByteArray()
        b.st.applyJournal(b.st.journal.project(JSONArray().put(rec(sha256Hex(good))))!!)
        assertEquals(0, b.st.savedAnimations().animations.size)
        assertTrue(b.st.hasPendingGifs())
        // настоящее содержимое появилось — повтор (не чаще раза в 60 с) добавляет
        cloud[fid] = good
        b.st.retryPendingGifs(nowMs = System.currentTimeMillis() + 61_000)
        val anims = b.st.savedAnimations().animations
        assertEquals(1, anims.size)
        assertEquals("video/mp4", anims[0].mimeType)
        assertFalse(b.st.hasPendingGifs())
    }

    @Test
    fun gifRecordKeyAndRefShape() {
        val pj = PackJournal(Files.createTempDirectory("pv-pj").toFile())
        assertNull(pj.recordGif(JSONObject().put("file_id", "f"), "zz")) // не sha256
        val hex = "ab".repeat(32)
        assertEquals("g:$hex", pj.recordGif(JSONObject().put("file_id", "f").put("name", "x.webm").put("capability", "Y2Fw"), hex.uppercase()))
        val r = pj.records().getJSONObject(0).getJSONObject("ref")
        assertEquals("Y2Fw", r.optString("capability")); assertEquals(1, r.optInt("count"))
        assertTrue(PackJournal.isGifKey("g:$hex")); assertFalse(PackJournal.isGifKey("h:abc"))
        assertTrue(pj.forgetGif(hex)); assertFalse(pj.forgetGif(hex))
    }
}
