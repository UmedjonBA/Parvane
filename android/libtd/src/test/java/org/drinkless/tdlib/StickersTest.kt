package org.drinkless.tdlib

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * spec 005 / история 1: сервис стикеров с фейковым ядром — приём pack_ref/emoji_packs,
 * скачивание пака по первому обращению панели, отправка (InputFileId → файл пака,
 * pack_ref по PACK-1), emoji_packs ≤ 4, сохранённые GIF ≤ 50.
 */
class StickersTest {
    private class FakeCore(private val root: File) : Stickers.Core {
        var fetches = 0; var uploads = 0
        override fun packFetch(refJson: String): JSONObject {
            fetches++
            val ref = JSONObject(refJson)
            val dir = File(root, "packs/" + EmojiDocId.sanitizeName(ref.optString("name"))).also { it.mkdirs() }
            listOf("00-1f600.webp", "01-1f602.png").forEach { File(dir, it).writeBytes(byteArrayOf(1, 2, 3)) }
            return JSONObject().put("ok", true).put("dir", dir.absolutePath)
                .put("files", org.json.JSONArray().put(JSONObject().put("name", "00-1f600.webp").put("size", 3)).put(JSONObject().put("name", "01-1f602.png").put("size", 3)))
        }
        override fun packRefFor(dir: String, rawName: String, recipients: List<String>): JSONObject {
            uploads++
            return JSONObject().put("file_id", "01a0f000-0000-7000-8000-00000000ab$uploads").put("name", rawName).put("count", 2).put("key", "k").put("nonce", "n")
        }
    }

    private fun setup(): Triple<Stickers, FakeCore, ArrayList<TdApi.Update>> {
        val root = Files.createTempDirectory("pv-st").toFile()
        val core = FakeCore(root)
        val updates = ArrayList<TdApi.Update>()
        val store = ParvaneStore().apply { self = "alice@local" }
        return Triple(Stickers(store, root, { updates.add(it) }, core), core, updates)
    }

    private fun ref(name: String) = JSONObject().put("file_id", "01a0f000-0000-7000-8000-0000000000aa").put("name", name).put("count", 2).put("key", "k").put("nonce", "n")

    @Test
    fun receivedStickerRegistersPackAndPanelFetchesOnDemand() {
        val (st, core, updates) = setup()
        st.onReceived(JSONObject().put("kind", "sticker").put("file_id", "f1").put("mime", "image/webp").put("width", 512).put("height", 512).put("pack_ref", ref("Cats")))
        val p = st.index.byRawName("Cats", false)!!
        assertEquals(0, core.fetches)
        assertEquals(0, st.installedSets(TdApi.StickerTypeRegular()).totalCount) // получен, не установлен
        val set = st.stickerSet(p.setId) as TdApi.StickerSet
        assertEquals(1, core.fetches)
        assertEquals(2, set.stickers.size)
        assertTrue(set.stickers[0].format is TdApi.StickerFormatWebp)
        assertTrue(set.stickers[0].sticker.local.isDownloadingCompleted)
        assertEquals("😀", set.stickers[0].emoji)
        // установка → апдейт наборов, повторного скачивания нет
        assertTrue(st.change(p.setId, true, false) is TdApi.Ok)
        assertEquals(1, core.fetches)
        assertEquals(1, st.installedSets(TdApi.StickerTypeRegular()).totalCount)
        assertTrue(updates.any { it is TdApi.UpdateInstalledStickerSets && it.stickerSetIds.contains(p.setId) })
        // по эмодзи
        assertEquals(1, st.stickersByEmoji(TdApi.StickerTypeRegular(), "😂", 10).stickers.size)
        assertEquals(2, st.stickersByEmoji(TdApi.StickerTypeRegular(), "", 10).stickers.size)
    }

    @Test
    fun sendResolvesInputFileIdAndAttachesPackRefByRecipients() {
        val (st, core, _) = setup()
        val p = st.index.registerReceived(ref("Cats"), false)
        val set = st.stickerSet(p.setId) as TdApi.StickerSet
        val input = TdApi.InputFileId(set.stickers[1].sticker.id)
        val r = st.resolveInput(input)!!
        val pack = r.pack; val file = r.file
        assertEquals("01-1f602.png", file.name); assertEquals(p.setId, pack.setId)
        assertTrue(r.path.endsWith("/01-1f602.png"))
        assertNull(st.resolveInput(TdApi.InputFileId(999)))
        val r1 = st.packRefForSend(pack, listOf("bob@local"))!!
        assertEquals("Cats", r1.optString("name")); assertEquals(1, core.uploads)
        // встроенный пак — без pack_ref
        val b = st.index.addBuiltin("ParvaneStickers", false, File(pack.dirPath).parent + "/b", listOf("00-1f600.png"), 512)
        assertNull(st.packRefForSend(b, listOf("bob@local")))
        // недавние
        st.noteRecent(pack, file)
        assertEquals(1, st.recents().stickers.size)
        assertTrue(st.addFavorite(input) is TdApi.Ok); assertEquals(1, st.favorites().stickers.size)
        assertTrue(st.removeFavorite(input) is TdApi.Ok); assertEquals(0, st.favorites().stickers.size)
    }

    @Test
    fun emojiPacksLimitedToFourAndResolvedByDocId() {
        val (st, _, _) = setup()
        val ids = ArrayList<Long>()
        for (i in 1..6) {
            val p = st.index.registerReceived(ref("Em$i"), true)
            st.index.materialize(p, "/tmp/em$i", listOf("00-1f98b.png"), install = true)
            ids.add(p.files[0].docId)
        }
        val packs = st.emojiPacksFor(ids, listOf("bob@local"))!!
        assertEquals(4, packs.length())
        assertNull(st.emojiPacksFor(listOf(42L), listOf("bob@local")))
        // приём текста с emoji_packs регистрирует пак; GetCustomEmojiStickers тянет его
        st.onReceived(JSONObject().put("kind", "text").put("text", "x").put("emoji_packs", org.json.JSONArray().put(ref("Remote"))))
        val remote = st.index.byRawName("Remote", true)!!
        val doc = EmojiDocId.emojiDocId("Remote", "00-1f600.webp")
        assertNull(st.index.emojiByDocId(doc)) // файлов ещё нет
        // docId неизвестен → полученный пак материализуется по emoji_packs прямо в GetCustomEmojiStickers
        // (раньше пропускалось молча, пока X не открыл набор — «эмодзи не разрешён» в tgx_stickers_flow.sh)
        val got = st.customEmoji(longArrayOf(doc)).stickers
        assertEquals(1, got.size)
        assertTrue(got[0].fullType is TdApi.StickerFullTypeCustomEmoji)
        assertTrue(st.index.byRawName("Remote", true)!!.materialized)
        assertNotNull(st.stickerSet(remote.setId) as? TdApi.StickerSet)
        assertEquals(0, st.customEmoji(longArrayOf(4242L)).stickers.size) // неизвестный docId — пусто, без исключений
    }

    @Test
    fun savedGifsCappedAtFifty() {
        val (st, _, updates) = setup()
        for (i in 1..55) st.onReceived(JSONObject().put("kind", "gif").put("file_id", "g$i").put("mime", "video/webm").put("file_key", "k").put("file_nonce", "n").put("width", 240).put("height", 240))
        assertEquals(50, st.savedAnimations().animations.size)
        assertEquals("g55", st.savedAnimations().animations[0].animation.remote.id)
        assertTrue(updates.any { it is TdApi.UpdateSavedAnimations })
        val id = st.savedAnimations().animations[0].animation.id
        assertTrue(st.removeSavedAnimation(TdApi.InputFileId(id)) is TdApi.Ok)
        assertEquals(49, st.savedAnimations().animations.size)
    }
}
