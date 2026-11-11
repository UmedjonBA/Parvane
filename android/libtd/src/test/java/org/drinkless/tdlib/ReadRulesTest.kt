package org.drinkless.tdlib

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** READ-2 на android: список чатов X зовёт ViewMessages для последнего сообщения строки — это не прочтение. */
class ReadRulesTest {
    @Test
    fun chatHistoryAndForcedViewsRead() {
        assertTrue(viewCountsAsRead(TdApi.MessageSourceChatHistory(), false))
        assertTrue(viewCountsAsRead(TdApi.MessageSourceMessageThreadHistory(), false))
        assertTrue(viewCountsAsRead(TdApi.MessageSourceForumTopicHistory(), false))
        assertTrue(viewCountsAsRead(null, false))
        assertTrue(viewCountsAsRead(TdApi.MessageSourceChatList(), true))
    }

    @Test
    fun chatListAndOtherViewsDoNotRead() {
        assertFalse(viewCountsAsRead(TdApi.MessageSourceChatList(), false))
        assertFalse(viewCountsAsRead(TdApi.MessageSourceSearch(), false))
        assertFalse(viewCountsAsRead(TdApi.MessageSourceNotification(), false))
        assertFalse(viewCountsAsRead(TdApi.MessageSourceHistoryPreview(), false))
        assertFalse(viewCountsAsRead(TdApi.MessageSourceChatEventLog(), false))
        assertFalse(viewCountsAsRead(TdApi.MessageSourceScreenshot(), false))
        assertFalse(viewCountsAsRead(TdApi.MessageSourceOther(), false))
    }
}
