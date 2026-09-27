package org.drinkless.tdlib

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** spec 005: сущности провода ↔ TdApi (имена web entities.ts), custom_emoji с docId, поиск URL. */
class EntitiesTest {
    @Test
    fun roundTrip() {
        val wire = JSONArray("""[{"type":"bold","offset":0,"length":2},{"type":"text_url","offset":3,"length":4,"data":"https://x.y"},
            {"type":"custom_emoji","offset":8,"length":2,"data":"-1234567890123"},{"type":"pre","offset":0,"length":1,"data":"kotlin"},{"type":"weird","offset":0,"length":1}]""")
        val td = Entities.fromWire(wire)
        assertEquals(4, td.size)
        assertTrue(td[0].type is TdApi.TextEntityTypeBold)
        assertEquals("https://x.y", (td[1].type as TdApi.TextEntityTypeTextUrl).url)
        assertEquals(-1234567890123L, (td[2].type as TdApi.TextEntityTypeCustomEmoji).customEmojiId)
        assertEquals("kotlin", (td[3].type as TdApi.TextEntityTypePreCode).language)
        val back = Entities.toWire(td)!!
        assertEquals(4, back.length())
        assertEquals("-1234567890123", back.getJSONObject(2).getString("data"))
        assertEquals("pre", back.getJSONObject(3).getString("type"))
        assertEquals(listOf(-1234567890123L), Entities.customEmojiIds(td))
        assertNull(Entities.toWire(emptyArray()))
    }

    @Test
    fun firstUrl() {
        assertEquals("https://example.com/a", Entities.firstUrl("see https://example.com/a.", null))
        assertEquals("https://t.co", Entities.firstUrl("x", arrayOf(TdApi.TextEntity(0, 1, TdApi.TextEntityTypeTextUrl("https://t.co")))))
        assertNull(Entities.firstUrl("no links", null))
    }
}
