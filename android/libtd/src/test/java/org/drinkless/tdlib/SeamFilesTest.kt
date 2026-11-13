package org.drinkless.tdlib

import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * spec 036 T036: файлы шва живут записями хранилища движка (ядро `HostFiles`), прежний файл после переноса
 * переименован (`<имя>.migrated`) — его на диске нет. Шов спрашивает «есть ли файл» у кодека ядра, а не у файловой
 * системы: иначе после переноса черновики, архив, папки, отложенные и наборы читались бы пустыми.
 */
class SeamFilesTest {
    /** Кодек как у ядра: записи в памяти по пути, на диске ничего. */
    private class StoreCodec : SeamFiles.Codec {
        val records = HashMap<String, String>()
        override fun read(path: String) = records[path] ?: ""
        override fun write(path: String, text: String): Boolean { records[path] = text; return true }
        override fun exists(path: String) = records.containsKey(path)
    }

    @After fun reset() { SeamFiles.codec = null }

    @Test
    fun localStateLoadsFromStoreWhenOldFileIsGone() {
        val dir = Files.createTempDirectory("pv-seam").toFile()
        val codec = StoreCodec()
        SeamFiles.codec = codec
        val a = ChatLocalState(dir)
        a.setDraft(11L, JSONObject().put("text", "набросок").put("date", 1700000000))
        a.setArchived(12L, true)
        a.setPinned(11L, true)
        a.folders.create(TdApi.ChatFolder(TdApi.ChatFolderName(TdApi.FormattedText("Дела", arrayOf()), false), null, -1, false,
            LongArray(0), longArrayOf(11L), LongArray(0), false, false, false, false, false, false, false, false))
        assertTrue("на диске файлов шва нет", dir.listFiles().orEmpty().none { it.isFile && it.name.endsWith(".json") })
        val b = ChatLocalState(dir)
        assertEquals("набросок", b.draftOf(11L)!!.getString("text"))
        assertTrue(b.isArchived(12L))
        assertEquals(listOf(11L), b.pinnedChatIds())
        assertEquals("Дела", b.folders.all().single().title)
        val q = ScheduledQueue(dir) { 1000L }
        q.add("0192f0e4-1a2b-7c3d-8e4f-001122334477", 11L, "bob@local", JSONObject().put("kind", "text").put("text", "позже"), null, null, 5000L)
        assertEquals("позже", ScheduledQueue(dir) { 1000L }.all().single().content.getString("text"))
        val idx = PackIndex(dir)
        idx.registerReceived(JSONObject().put("file_id", "01a0f000-0000-7000-8000-000000000001").put("name", "Котики").put("count", 1), false)
        assertEquals(1, PackIndex(dir).all().size)
        assertTrue(File(dir, "packs.json").let { !it.exists() })
        dir.deleteRecursively()
    }
}
