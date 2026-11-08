package org.drinkless.tdlib

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.parvane.core.ParvaneProtocol

/**
 * spec 035 T131 (NAT-06, ORDER-1, SC-009): очередь событий ядра → Kotlin через НАСТОЯЩИЙ JNI (хостовая JVM, та же
 * `jni/event_queue.h`, что у событий ядра на устройстве). 300 событий с потока ядра, не присоединённого к JVM:
 *  - в Kotlin строго по порядку, пачками (вызовов Kotlin меньше, чем событий);
 *  - AttachCurrentThread — один раз за жизнь потока очереди, а не на событие;
 *  - очередь с потолком: медленный Kotlin → поток ядра ждёт (пауза чтения), ни одно событие не теряется.
 */
class EventQueueJniTest {
    @Test
    fun threeHundredEventsInOrderInBatchesWithOneAttach() {
        val got = ArrayList<Int>()
        var calls = 0
        val stats = ParvaneProtocol.eventQueueProbe(count = 300, maxEvents = 16, slowMs = 2) { batch ->
            calls++
            val a = JSONArray(batch)
            for (i in 0 until a.length()) got += a.getJSONObject(i).getInt("n")
        }
        assertEquals("ошибка пробы: $stats", false, stats.has("error"))
        assertEquals("300 событий строго по порядку", (0 until 300).toList(), got)
        assertEquals("AttachCurrentThread — один раз за жизнь потока очереди ($stats)", 1, stats.getInt("attach"))
        assertEquals("DetachCurrentThread — один раз, при остановке потока ($stats)", 1, stats.getInt("detach"))
        assertTrue("события пачками: $calls вызовов Kotlin на 300 событий", calls in 1 until 300)
        assertTrue("потолок очереди: ${stats.getInt("max_queued")} ≤ 16", stats.getInt("max_queued") <= 16)
        assertTrue("переполнение — пауза потока ядра, а не рост очереди ($stats)", stats.getInt("waits") > 0)
        assertEquals("ничего не потеряно и потолок не обойдён ($stats)", 0, stats.getInt("overflow"))
    }
}
