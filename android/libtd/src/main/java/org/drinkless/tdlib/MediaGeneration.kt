package org.drinkless.tdlib

import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/**
 * Генерация файлов как в TDLib: шов шлёт X `UpdateFileGenerationStart(generationId, originalPath, destinationPath,
 * conversion)`, X сам рисует результат (обрезка, рисунок, вырезка видео), пишет в destinationPath и отвечает
 * `FinishFileGeneration(generationId, error)`. Пока X присылает `SetFileGenerationProgress`, срок ожидания
 * продлевается (видео кодируется долго); тишина дольше [idleTimeoutMs] — отказ. Ошибка генерации, пустой или
 * отсутствующий итоговый файл — тоже честный отказ, а не отправка неотредактированного оригинала.
 */
class MediaGeneration(
    private val idleTimeoutMs: Long = 120_000,
    private val ids: AtomicLong = AtomicLong(System.nanoTime() and 0x3fffffffffffL),
) {
    sealed class Result {
        class Ready(val path: String) : Result()
        class Failed(val reason: String) : Result()
    }

    private class Job {
        val done = CountDownLatch(1)
        @Volatile var failed = false
        @Volatile var lastActivity = System.nanoTime()
    }

    private val jobs = ConcurrentHashMap<Long, Job>()

    /** Ответ X на FinishFileGeneration: error != null — генерация не удалась. */
    fun finish(generationId: Long, error: TdApi.Error?) {
        val job = jobs[generationId] ?: return
        job.failed = error != null
        job.done.countDown()
    }

    /** SetFileGenerationProgress / WriteGeneratedFilePart: X жив, ожидание продлевается. */
    fun touch(generationId: Long) {
        jobs[generationId]?.lastActivity = System.nanoTime()
    }

    /**
     * Запустить генерацию и дождаться. [start] отдаёт UpdateFileGenerationStart в X, [stop] — UpdateFileGenerationStop
     * при отказе/таймауте. Блокирует вызывающий поток — не вызывать из потока, который обязан принять Finish.
     */
    fun generate(
        originalPath: String, conversion: String, destinationPath: String,
        start: (TdApi.UpdateFileGenerationStart) -> Unit, stop: (TdApi.UpdateFileGenerationStop) -> Unit,
    ): Result {
        val id = ids.incrementAndGet()
        val job = Job()
        jobs[id] = job
        try {
            File(destinationPath).parentFile?.mkdirs()
            File(destinationPath).delete()
            start(TdApi.UpdateFileGenerationStart(id, originalPath, destinationPath, conversion))
            while (true) {
                val idleLeft = idleTimeoutMs - TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - job.lastActivity)
                if (idleLeft <= 0) { stop(TdApi.UpdateFileGenerationStop(id)); return Result.Failed("timeout") }
                if (job.done.await(minOf(idleLeft, 200L), TimeUnit.MILLISECONDS)) break
            }
            if (job.failed) return Result.Failed("generation_error")
            val f = File(destinationPath)
            return if (f.isFile && f.length() > 0) Result.Ready(destinationPath) else Result.Failed("empty_result")
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            stop(TdApi.UpdateFileGenerationStop(id))
            return Result.Failed("interrupted")
        } finally {
            jobs.remove(id)
        }
    }

    companion object {
        /** Расширение итога по conversion X: photo… → jpg, video… → mp4, иначе — как у оригинала. */
        fun extensionFor(conversion: String?, originalPath: String): String = when {
            conversion?.startsWith("photo") == true -> "jpg"
            conversion?.startsWith("video") == true -> "mp4"
            else -> originalPath.substringAfterLast('.', "bin").ifEmpty { "bin" }
        }
    }
}
