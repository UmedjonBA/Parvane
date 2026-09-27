package org.drinkless.tdlib

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

/** spec 005 / история 4: папки (персист, членство по флагам, TdApi) и геометрия карты (порт map_tiles / web renderStaticMap). */
class FoldersMapTest {
    private fun folder(title: String, included: LongArray = LongArray(0), excluded: LongArray = LongArray(0), groups: Boolean = false, contacts: Boolean = false, excludeRead: Boolean = false) =
        TdApi.ChatFolder(TdApi.ChatFolderName(TdApi.FormattedText(title, arrayOf()), false), TdApi.ChatFolderIcon("💼"), 3, false, LongArray(0), included, excluded,
            false, excludeRead, false, contacts, false, false, groups, false)

    @Test
    fun foldersPersistAndMembership() {
        val dir = Files.createTempDirectory("pv-folders").toFile()
        val fs = Folders(dir)
        val work = fs.create(folder("Work", included = longArrayOf(10L), groups = true, excludeRead = true))
        val people = fs.create(folder("People", contacts = true, excluded = longArrayOf(10L)))
        assertEquals(1, work.id); assertEquals(2, people.id)
        val group = Folders.ChatFacts(isGroup = true, isChannel = false, isContact = false, isMuted = false, isRead = false, isArchived = false)
        val readGroup = Folders.ChatFacts(true, false, false, false, isRead = true, isArchived = false)
        val contact = Folders.ChatFacts(false, false, isContact = true, isMuted = false, isRead = false, isArchived = false)
        assertEquals(listOf(1), fs.foldersOf(-5L, group).map { it.id })          // группа по флагу
        assertTrue(fs.foldersOf(-6L, readGroup).isEmpty())                        // excludeRead
        assertEquals(listOf(1), fs.foldersOf(10L, contact).map { it.id })         // явно включён в Work, исключён из People
        assertEquals(listOf(2), fs.foldersOf(11L, contact).map { it.id })
        fs.reorder(intArrayOf(2, 1), 1)
        assertEquals(listOf(2, 1), fs.all().map { it.id }); assertEquals(1, fs.mainPosition)
        val again = Folders(dir)
        assertEquals(listOf(2, 1), again.all().map { it.id })
        val td = again.get(1)!!.toTd()
        assertEquals("Work", td.name.text.text); assertEquals("💼", td.icon!!.name); assertTrue(td.includeGroups && td.excludeRead); assertEquals(10L, td.includedChatIds[0])
        assertEquals(2, again.infos().size)
        assertNotNull(again.edit(1, folder("Work2"))); assertEquals("Work2", again.get(1)!!.title)
        assertNull(again.edit(99, folder("x")))
        assertTrue(again.delete(2)); assertFalse(again.delete(2))
        assertEquals(3, again.create(folder("Third")).id) // id не переиспользуются
    }

    @Test
    fun mapGeometryMatchesDesktop() {
        val g = MapGeometry.compute(55.7558, 37.6173, 16, 320, 240, 1.0)
        assertEquals(16, g.zoom); assertEquals(320, g.canvasWidth); assertEquals(240, g.canvasHeight)
        assertTrue(g.tiles.size in 4..9)
        // центральный тайл OSM Москвы на z16 (по формуле Web Mercator): x=39616, y=20486
        val cx = kotlin.math.floor(g.centerX / 256).toInt(); val cy = kotlin.math.floor(g.centerY / 256).toInt()
        assertEquals(39616, cx); assertEquals(20486, cy)
        assertTrue(g.tiles.any { it.x == cx && it.y == cy })
        assertEquals(g.tiles.size, g.tiles.map { it.key }.toSet().size)
        assertTrue(g.tiles[0].key.startsWith("16/"))
        val s2 = MapGeometry.compute(55.7558, 37.6173, 16, 320, 240, 2.0)
        assertEquals(640, s2.canvasWidth); assertEquals(512, s2.tiles[0].dstSize)
        // переход через дату: x обёрнуты, обёрнутый тайл правее
        val d = MapGeometry.compute(0.0, 179.999, 16, 320, 240, 1.0)
        val n = 1 shl 16
        assertTrue(d.tiles.all { it.x in 0 until n })
        val last = d.tiles.first { it.x == n - 1 }; val wrapped = d.tiles.first { it.x == 0 }
        assertTrue(wrapped.dstX > last.dstX)
        // полюс: ty вне диапазона отброшены; clamp зума/scale
        val p = MapGeometry.compute(89.9, 0.0, 2, 1000, 1000, 1.0)
        assertTrue(p.tiles.all { it.y in 0 until 4 }); assertTrue(p.tiles.size < 9)
        val c = MapGeometry.compute(1.0, 1.0, 40, 10, 10, 9.0)
        assertEquals(MapGeometry.MAX_ZOOM, c.zoom); assertEquals(3.0, c.scale, 0.0)
        assertTrue(MapGeometry.compute(1.0, 1.0, 16, 0, 10, 1.0).tiles.isEmpty())
        assertEquals("map-55.75580_37.61730_16_320x240@1.png", MapGeometry.fileName(55.7558, 37.6173, 16, 320, 240, 1.0))
    }
}
