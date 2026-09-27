package org.drinkless.tdlib

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

/** spec 005 / история 3: таймеры TTL (куски ≤ 24 суток, инжектированные часы) и очередь отложенных (персист, срок, id-диапазон). */
class TtlScheduledTest {
    private class FakeClock(var t: Long) { val now: () -> Long = { t } }
    private class FakeTimer {
        val pending = ArrayList<Pair<Long, () -> Unit>>()
        val schedule: (Long, () -> Unit) -> TtlScheduler.Cancellable = { d, task ->
            val entry = d to task; pending.add(entry); TtlScheduler.Cancellable { pending.remove(entry) }
        }
        fun runAll() { val copy = ArrayList(pending); pending.clear(); copy.forEach { it.second() } }
    }

    @Test
    fun ttlFiresAtDeadlineInChunks() {
        val clock = FakeClock(1_000_000); val timer = FakeTimer(); val expired = ArrayList<String>()
        val s = TtlScheduler(clock.now, timer.schedule) { expired.add(it) }
        s.arm("u1", clock.t + 10)
        assertEquals(1, timer.pending.size); assertEquals(10_000L, timer.pending[0].first)
        timer.runAll(); assertTrue(expired.isEmpty()) // время не прошло — перевзвод
        clock.t += 10; timer.runAll()
        assertEquals(listOf("u1"), expired); assertEquals(0, s.size())
        // далёкий срок → кусок ≤ MAX_TIMEOUT_MS
        s.arm("u2", clock.t + 60L * 86400)
        assertEquals(TtlScheduler.MAX_TIMEOUT_MS, timer.pending[0].first)
        s.cancel("u2"); assertTrue(timer.pending.isEmpty()); assertNull(s.deadlineOf("u2"))
        // просроченное — сразу
        s.arm("u3", clock.t - 5); assertEquals(listOf("u1", "u3"), expired)
        s.arm("u4", clock.t + 1); s.cancelAll(); assertEquals(0, s.size())
    }

    @Test
    fun scheduledQueuePersistsAndFires() {
        val dir = Files.createTempDirectory("pv-sched").toFile()
        val clock = FakeClock(2_000_000)
        val q = ScheduledQueue(dir, clock.now)
        val a = q.add("uuid-a", 42L, "bob@local", JSONObject().put("kind", "text").put("text", "later"), null, null, clock.t + 20)
        val b = q.add("uuid-b", 42L, "bob@local", JSONObject().put("kind", "photo"), "/tmp/p.jpg", "reply-1", clock.t + 5)
        assertTrue(q.isScheduledId(a.id) && a.id >= ScheduledQueue.ID_BASE && b.id == a.id + 1)
        assertEquals(listOf(b.id, a.id), q.forChat(42L).map { it.id })
        assertEquals(clock.t + 5, q.nextDue())
        assertTrue(q.takeDue().isEmpty())
        clock.t += 5
        val due = q.takeDue(); assertEquals(1, due.size); assertEquals("uuid-b", due[0].uuid); assertEquals("/tmp/p.jpg", due[0].localPath)
        assertNull(q.get(b.id))
        // персист + продолжение нумерации
        val again = ScheduledQueue(dir, clock.now)
        assertNotNull(again.get(a.id)); assertEquals("later", again.get(a.id)!!.content.getString("text"))
        val c = again.add("uuid-c", 1L, "x", JSONObject(), null, null, clock.t + 1)
        assertEquals(a.id + 2, c.id)
        assertNotNull(again.reschedule(a.id, clock.t + 1)); assertEquals(clock.t + 1, again.get(a.id)!!.due)
        assertNotNull(again.remove(a.id)); assertNull(again.get(a.id))
    }
}
