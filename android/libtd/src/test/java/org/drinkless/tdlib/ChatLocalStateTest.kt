package org.drinkless.tdlib

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

/** spec 005 / история 3: TTL по собеседнику, черновики, архив — персист и объекты TdApi. */
class ChatLocalStateTest {
    @Test
    fun ttlDraftsArchivePersist() {
        val dir = Files.createTempDirectory("pv-local").toFile()
        val s = ChatLocalState(dir)
        s.setTtl("bob@local", 15); assertEquals(15, s.ttlOf("bob@local")); assertEquals(0, s.ttlOf("x@local"))
        val draft = TdApi.DraftMessage(TdApi.InputMessageReplyToMessage(42L, null, 0, null), 100,
            TdApi.DraftMessageContentText(TdApi.FormattedText("hi", arrayOf(TdApi.TextEntity(0, 2, TdApi.TextEntityTypeBold()))), null), 0L, null)
        s.setDraft(7L, s.draftJson(draft))
        assertNull(s.draftJson(TdApi.DraftMessage(null, 0, TdApi.DraftMessageContentText(TdApi.FormattedText("", arrayOf()), null), 0L, null)))
        s.setArchived(7L, true)
        assertTrue(s.positionsFor(7L, 5L)[0].list is TdApi.ChatListArchive)
        assertTrue(s.positionsFor(8L, 5L)[0].list is TdApi.ChatListMain)
        val again = ChatLocalState(dir)
        assertEquals(15, again.ttlOf("bob@local"))
        val d = again.tdDraft(7L)!!
        assertEquals("hi", (d.content as TdApi.DraftMessageContentText).text.text)
        assertEquals(1, (d.content as TdApi.DraftMessageContentText).text.entities.size)
        assertEquals(42L, (d.replyTo as TdApi.InputMessageReplyToMessage).messageId)
        assertEquals(100, d.date)
        assertTrue(again.isArchived(7L))
        again.setArchived(7L, false); again.setTtl("bob@local", 0); again.setDraft(7L, null)
        val third = ChatLocalState(dir)
        assertFalse(third.isArchived(7L)); assertEquals(0, third.ttlOf("bob@local")); assertNull(third.tdDraft(7L))
        assertNotNull(third.positionsFor(1L, 0L))
    }
}
