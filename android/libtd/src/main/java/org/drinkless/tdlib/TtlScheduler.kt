package org.drinkless.tdlib

/**
 * spec 005 / история 3: таймеры исчезающих сообщений. `ttl_secs` — секунды от
 * времени отправки (как web/desktop), срок = ts + ttl. Планировщик чистый:
 * часы и «спящий» таймер инжектируются, поэтому JVM-тесты идут без ожиданий.
 * Как web (`armTtl`): задержка режется кусками ≤ 24 суток (переполнение таймеров),
 * до срока таймер перевзводится, по сроку — [onExpire]. Сообщения с TTL не
 * журналируются ядром, поэтому после перезапуска не возвращаются сами.
 */
class TtlScheduler(
    private val now: () -> Long = { System.currentTimeMillis() / 1000 },
    private val schedule: (delayMs: Long, task: () -> Unit) -> Cancellable = ScheduledExecutor,
    private val onExpire: (uuid: String) -> Unit,
) {
    fun interface Cancellable { fun cancel() }

    private val armed = HashMap<String, Cancellable>()
    private val deadlines = HashMap<String, Long>()

    /** Взвести удаление [uuid] на [deadlineSec] (уже просроченное — сразу). Повторный вызов — переустановка. */
    @Synchronized
    fun arm(uuid: String, deadlineSec: Long) {
        armed.remove(uuid)?.cancel()
        deadlines[uuid] = deadlineSec
        tick(uuid)
    }

    private fun tick(uuid: String) {
        val deadline = deadlines[uuid] ?: return
        val left = (deadline - now()) * 1000
        if (left <= 0) { fire(uuid); return }
        val delay = minOf(left, MAX_TIMEOUT_MS)
        armed[uuid] = schedule(delay) { synchronized(this) { if (deadlines.containsKey(uuid)) tick(uuid) } }
    }

    private fun fire(uuid: String) {
        deadlines.remove(uuid); armed.remove(uuid)
        onExpire(uuid)
    }

    @Synchronized fun cancel(uuid: String) { armed.remove(uuid)?.cancel(); deadlines.remove(uuid) }
    @Synchronized fun cancelAll() { armed.values.forEach { it.cancel() }; armed.clear(); deadlines.clear() }
    @Synchronized fun deadlineOf(uuid: String): Long? = deadlines[uuid]
    @Synchronized fun size() = deadlines.size

    companion object {
        /** ~24.8 суток — как web MAX_TIMEOUT_MS (2^31−1 мс). */
        const val MAX_TIMEOUT_MS: Long = 2147483647L

        /** Общий однопоточный исполнитель для боевого режима. */
        val ScheduledExecutor: (Long, () -> Unit) -> Cancellable = run {
            val ex = java.util.concurrent.Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "parvane-ttl").apply { isDaemon = true } }
            val f: (Long, () -> Unit) -> Cancellable = { delayMs, task ->
                val future = ex.schedule({ try { task() } catch (e: Throwable) { /* лог у вызывающего */ } }, delayMs, java.util.concurrent.TimeUnit.MILLISECONDS)
                Cancellable { future.cancel(false) }
            }
            f
        }
    }
}
