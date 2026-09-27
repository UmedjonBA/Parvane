package org.drinkless.tdlib

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/** spec 005: индекс паков — регистрация из pack_ref, материализация, установка/архив, персист, объекты TdApi. */
class PackIndexTest {
    private fun tmp(): File = Files.createTempDirectory("pv-packs").toFile()
    private fun ref(name: String, fid: String = "01a0f000-0000-7000-8000-000000000001") =
        JSONObject().put("file_id", fid).put("name", name).put("count", 2).put("key", "k").put("nonce", "n")

    @Test
    fun registerReceivedAndMaterialize() {
        val dir = tmp()
        val idx = PackIndex(dir)
        val p = idx.registerReceived(ref("Cats & Dogs"), isEmoji = false)
        assertEquals("Cats  Dogs", p.name)
        assertEquals("Cats & Dogs", p.rawName)
        assertEquals(EmojiDocId.packSetId("Cats  Dogs"), p.setId)
        assertFalse(p.installed); assertFalse(p.materialized)
        assertTrue(idx.installed(false).isEmpty())
        val packDir = File(dir, "packs/Cats  Dogs").also { it.mkdirs() }
        idx.materialize(p, packDir.absolutePath, listOf("00-1f600.webp", "01-1f602.png", "readme.txt"), install = true)
        assertTrue(p.installed && p.materialized)
        assertEquals(2, p.files.size)
        assertEquals("😀", p.files[0].emoji)
        assertEquals("image/webp", p.files[0].mime)
        assertEquals(0L, p.files[0].docId) // стикеры без docId
        assertEquals(1, idx.installed(false).size)
        // повторная регистрация того же сырого имени — тот же пак
        assertSame(p, idx.registerReceived(ref("Cats & Dogs", "другой"), false))
        // персист
        val again = PackIndex(dir)
        assertEquals(p.setId, again.bySetId(p.setId)?.setId)
        assertEquals(2, again.bySetId(p.setId)?.files?.size)
        assertEquals("Cats & Dogs", again.byFileId("01a0f000-0000-7000-8000-000000000001")?.rawName)
    }

    private fun assertSame(a: Any, b: Any) = assertTrue(a === b)

    @Test
    fun emojiPackDocIdsAndLookup() {
        val idx = PackIndex(tmp())
        val p = idx.registerReceived(ref("ParvaneEmoji"), isEmoji = true)
        assertEquals(EmojiDocId.emojiSetId("ParvaneEmoji"), p.setId)
        idx.materialize(p, "/tmp/x", listOf("00-1f98b.png", "01-2728.png"), install = false)
        val doc = EmojiDocId.emojiDocId("ParvaneEmoji", "00-1f98b.png")
        val (pack, file) = idx.emojiByDocId(doc)!!
        assertEquals("00-1f98b.png", file.name); assertEquals("🦋", file.emoji); assertEquals(pack, idx.emojiPackOf(doc))
        assertNull(idx.emojiByDocId(12345L))
        assertTrue(idx.installed(true).isEmpty()) // получен, но не установлен
    }

    @Test
    fun builtinCannotBeRemovedAndComesFirst() {
        val idx = PackIndex(tmp())
        val custom = idx.registerReceived(ref("Zeta"), false)
        idx.materialize(custom, "/tmp/z", listOf("a.png"), install = true)
        val b = idx.addBuiltin("ParvaneStickers", false, "/tmp/b", listOf("00-1f600.png"), 512)
        assertTrue(b.builtin && b.installed)
        assertEquals(b.setId, idx.installed(false).first().setId)
        assertFalse(idx.change(b.setId, false, false))
        assertTrue(idx.change(custom.setId, true, true))
        assertEquals(1, idx.archived(false).size)
        assertEquals(1, idx.installed(false).size)
        assertTrue(idx.change(custom.setId, false, false))
        assertEquals(0, idx.archived(false).size)
    }

    @Test
    fun tdApiObjectsCarryFormatAndType() {
        val idx = PackIndex(tmp())
        val p = idx.registerReceived(ref("Anim"), false)
        idx.materialize(p, "/tmp/a", listOf("00-1f600.tgs", "01-1f602.webm", "02-1f60d.webp"), install = true)
        val file = TdApi.File(7, 10, 10, TdApi.LocalFile("", true, false, false, false, 0, 0, 0), TdApi.RemoteFile("r", "r", false, true, 10))
        val s0 = PackIndex.toSticker(p, p.files[0], file)
        assertTrue(s0.format is TdApi.StickerFormatTgs)
        assertTrue(PackIndex.toSticker(p, p.files[1], file).format is TdApi.StickerFormatWebm)
        assertTrue(PackIndex.toSticker(p, p.files[2], file).format is TdApi.StickerFormatWebp)
        assertTrue(s0.fullType is TdApi.StickerFullTypeRegular)
        assertEquals(p.setId, s0.setId); assertEquals(7L, s0.id); assertNotNull(s0.thumbnail)
        val set = PackIndex.toStickerSet(p, arrayOf(s0))
        assertTrue(set.stickerType is TdApi.StickerTypeRegular); assertTrue(set.isInstalled); assertEquals("Anim", set.title)
        val info = PackIndex.toInfo(p, arrayOf(s0))
        assertEquals(3, info.size)
        val e = idx.registerReceived(ref("Em"), true)
        idx.materialize(e, "/tmp/e", listOf("00-1f98b.png"), install = true)
        val es = PackIndex.toSticker(e, e.files[0], file)
        assertTrue(es.fullType is TdApi.StickerFullTypeCustomEmoji)
        assertEquals(e.files[0].docId, (es.fullType as TdApi.StickerFullTypeCustomEmoji).customEmojiId)
        assertTrue(PackIndex.toStickerSet(e, arrayOf(es)).stickerType is TdApi.StickerTypeCustomEmoji)
    }
}
