package org.drinkless.tdlib

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Conformance EMOJI-1 на android (spec 005): docId кастом-эмодзи считается той же
 * формулой, что web/desktop — константы читаются из conformance/sync-rules.json.
 */
class EmojiDocIdTest {
    private fun rule(): JSONObject {
        val f = listOf(File("../../conformance/sync-rules.json"), File("../../../conformance/sync-rules.json")).firstOrNull { it.exists() }
            ?: throw AssertionError("нет conformance/sync-rules.json рядом с модулем")
        val arr = JSONObject(f.readText()).getJSONArray("rules")
        for (i in 0 until arr.length()) if (arr.getJSONObject(i).getString("id") == "EMOJI-1") return arr.getJSONObject(i)
        throw AssertionError("нет правила EMOJI-1")
    }

    @Test
    fun constantsMatchConformance() {
        val r = rule()
        assertEquals(r.getString("offsetBasis"), EmojiDocId.OFFSET_BASIS.toString())
        assertEquals(r.getString("prime"), EmojiDocId.PRIME.toString())
    }

    @Test
    fun fnvIsXorThenMultiply() {
        var h = EmojiDocId.OFFSET_BASIS; h = h xor 'a'.code.toLong(); h *= EmojiDocId.PRIME
        assertEquals(h, EmojiDocId.fnv1a64Signed("a"))
        assertEquals(EmojiDocId.OFFSET_BASIS, EmojiDocId.fnv1a64Signed(""))
    }

    @Test
    fun docIdUsesRawNameAndFile() {
        val id = EmojiDocId.emojiDocId("ParvaneEmoji", "00-1f98b.png")
        assertEquals(EmojiDocId.fnv1a64Signed("pvemoji:ParvaneEmoji|00-1f98b.png"), id)
        assertNotEquals(id, EmojiDocId.emojiDocId("Other", "00-1f98b.png"))
        // пример из conformance (если правило его несёт)
        rule().optJSONObject("example")?.let { ex ->
            assertEquals(ex.getString("docId"), EmojiDocId.emojiDocId(ex.getString("rawName"), ex.getString("file")).toString())
        }
    }

    @Test
    fun setIdsFollowDesktopPrefixes() {
        assertEquals(EmojiDocId.fnv1a64Signed("pack:Cats"), EmojiDocId.packSetId("Cats"))
        assertEquals(EmojiDocId.fnv1a64Signed("pvemoji-set:ParvaneEmoji"), EmojiDocId.emojiSetId("ParvaneEmoji"))
    }

    @Test
    fun sanitizeAsWebAndDesktop() {
        assertEquals("My Pack_1-x", EmojiDocId.sanitizeName("  My Pack_1-x!@#  "))
        assertEquals("Pack", EmojiDocId.sanitizeName("!!!"))
        assertEquals("Кошки и котики", EmojiDocId.sanitizeName("Кошки и котики"))
        assertEquals(32, EmojiDocId.sanitizeName("a".repeat(40)).length)
    }

    @Test
    fun altEmojiAndBuiltinNames() {
        assertEquals("🦋", EmojiDocId.altEmojiForFileName("00-1f98b.png"))
        assertEquals("🙂", EmojiDocId.altEmojiForFileName("sticker.webp"))
        assertEquals("00-1f98b.png", EmojiDocId.builtinFileName(0, "🦋"))
        assertTrue(EmojiDocId.isAllowedName("A.WEBP") && !EmojiDocId.isAllowedName("x.jpg"))
        assertEquals("application/x-tgsticker", EmojiDocId.mimeForName("a.tgs"))
        // встроенный пак web: те же 12 имён файлов
        val names = BuiltinPacks.fileNames(BuiltinPacks.EMOJI_PACK)
        assertEquals(12, names.size)
        assertEquals("01-2728.png", names[1])
    }
}
