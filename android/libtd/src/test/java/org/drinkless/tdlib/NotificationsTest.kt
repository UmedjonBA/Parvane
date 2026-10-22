package org.drinkless.tdlib

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class NotificationsTest {
    private fun msg(chat: Long, id: Long, out: Boolean = false) = TdApi.Message().apply {
        chatId = chat; this.id = id; isOutgoing = out; date = 1700000000
    }

    @Test
    fun incomingNotifiesOnceAndOwnOrMutedDoNot() {
        val n = Notifications()
        val u = n.onIncoming(msg(5, 1), muted = false)
        assertNotNull(u); assertEquals(1, u!!.totalCount); assertEquals(5L, u.chatId)
        assertNull("повтор того же сообщения", n.onIncoming(msg(5, 1), muted = false))
        assertNull("своё", n.onIncoming(msg(5, 2, out = true), muted = false))
        assertNull("заглушено", n.onIncoming(msg(5, 3), muted = true))
        assertEquals(2, n.onIncoming(msg(5, 4), muted = false)!!.totalCount)
    }

    @Test
    fun readAndDeleteRemoveNotifications() {
        val n = Notifications()
        val a = n.onIncoming(msg(7, 1), false)!!.addedNotifications[0].id
        val b = n.onIncoming(msg(7, 2), false)!!.addedNotifications[0].id
        n.onIncoming(msg(7, 3), false)
        val r = n.onRead(7, 2)!!
        assertArrayEquals(intArrayOf(a, b), r.removedNotificationIds)
        assertEquals(1, r.totalCount)
        assertNull("уже снято", n.onRead(7, 2))
        assertEquals(0, n.onDeleted(7, listOf(3L))!!.totalCount)
    }

    @Test
    fun swipeRemovesUpToId() {
        val n = Notifications()
        val g = n.onIncoming(msg(9, 1), false)!!
        n.onIncoming(msg(9, 2), false)
        val r = n.remove(g.notificationGroupId, g.addedNotifications[0].id, single = false)!!
        assertEquals(1, r.removedNotificationIds.size)
        assertEquals(1, r.totalCount)
    }
}
