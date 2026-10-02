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
        // 0 и 1 зарезервированы («все чаты», архив — как журнал состояния v2)
        assertEquals(2, work.id); assertEquals(3, people.id)
        val group = Folders.ChatFacts(isGroup = true, isChannel = false, isContact = false, isMuted = false, isRead = false, isArchived = false)
        val readGroup = Folders.ChatFacts(true, false, false, false, isRead = true, isArchived = false)
        val contact = Folders.ChatFacts(false, false, isContact = true, isMuted = false, isRead = false, isArchived = false)
        assertEquals(listOf(2), fs.foldersOf(-5L, group).map { it.id })          // группа по флагу
        assertTrue(fs.foldersOf(-6L, readGroup).isEmpty())                        // excludeRead
        assertEquals(listOf(2), fs.foldersOf(10L, contact).map { it.id })         // явно включён в Work, исключён из People
        assertEquals(listOf(3), fs.foldersOf(11L, contact).map { it.id })
        fs.reorder(intArrayOf(3, 2), 1)
        assertEquals(listOf(3, 2), fs.all().map { it.id }); assertEquals(1, fs.mainPosition)
        val again = Folders(dir)
        assertEquals(listOf(3, 2), again.all().map { it.id })
        val td = again.get(2)!!.toTd()
        assertEquals("Work", td.name.text.text); assertEquals("💼", td.icon!!.name); assertTrue(td.includeGroups && td.excludeRead); assertEquals(10L, td.includedChatIds[0])
        assertEquals(2, again.infos().size)
        assertNotNull(again.edit(2, folder("Work2"))); assertEquals("Work2", again.get(2)!!.title)
        assertNull(again.edit(99, folder("x")))
        assertTrue(again.delete(3)); assertFalse(again.delete(3))
        assertEquals(4, again.create(folder("Third")).id) // id не переиспользуются
    }

    @Test
    fun reservedFolderIdIsMovedOnLoad() {
        val dir = Files.createTempDirectory("pv-folders-old").toFile()
        java.io.File(dir, "folders.json").writeText("""{"next":2,"main":0,"folders":[{"id":1,"title":"Old"}]}""")
        val fs = Folders(dir)
        assertEquals(listOf(2), fs.all().map { it.id })
        assertEquals("Old", fs.get(2)!!.title)
        assertEquals(3, fs.create(folder("New")).id)
    }

    @Test
    fun mapGeometryMatchesDesktop() {
        // запрошенный z16 обрезается до MAX_ZOOM = 15 (P-23: preview не отдаёт выше; MAP-1 maxZoom)
        val g = MapGeometry.compute(55.7558, 37.6173, 16, 320, 240, 1.0)
        assertEquals(15, g.zoom); assertEquals(320, g.canvasWidth); assertEquals(240, g.canvasHeight)
        assertTrue(g.tiles.size in 4..9)
        // центральный тайл OSM Москвы на z15 (по формуле Web Mercator): x=19808, y=10243
        val cx = kotlin.math.floor(g.centerX / 256).toInt(); val cy = kotlin.math.floor(g.centerY / 256).toInt()
        assertEquals(19808, cx); assertEquals(10243, cy)
        assertTrue(g.tiles.any { it.x == cx && it.y == cy })
        assertEquals(g.tiles.size, g.tiles.map { it.key }.toSet().size)
        assertTrue(g.tiles[0].key.startsWith("15/"))
        val s2 = MapGeometry.compute(55.7558, 37.6173, 16, 320, 240, 2.0)
        assertEquals(640, s2.canvasWidth); assertEquals(512, s2.tiles[0].dstSize)
        // переход через дату: x обёрнуты, обёрнутый тайл правее
        val d = MapGeometry.compute(0.0, 179.999, 16, 320, 240, 1.0)
        val n = 1 shl 15
        assertTrue(d.tiles.all { it.x in 0 until n })
        val last = d.tiles.first { it.x == n - 1 }; val wrapped = d.tiles.first { it.x == 0 }
        assertTrue(wrapped.dstX > last.dstX)
        // полюс: ty вне диапазона отброшены; clamp зума/scale
        val p = MapGeometry.compute(89.9, 0.0, 2, 1000, 1000, 1.0)
        assertTrue(p.tiles.all { it.y in 0 until 4 }); assertTrue(p.tiles.size < 9)
        val c = MapGeometry.compute(1.0, 1.0, 40, 10, 10, 9.0)
        assertEquals(MapGeometry.MAX_ZOOM, c.zoom); assertEquals(3.0, c.scale, 0.0)
        assertTrue(MapGeometry.compute(1.0, 1.0, 16, 0, 10, 1.0).tiles.isEmpty())
        assertEquals("map-55.75580_37.61730_15_320x240@1.png", MapGeometry.fileName(55.7558, 37.6173, 16, 320, 240, 1.0))
    }
}
