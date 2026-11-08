package org.drinkless.tdlib

import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/**
 * Файлы, которые X пишет сам (голосовое, «кружок»): как в TDLib, `PreliminaryUploadFile(InputFileGenerated(null,
 * ключ))` заводит запись File, шов шлёт `UpdateFileGenerationStart(id, "", путь, ключ)`, X пишет в путь (рекордер
 * голоса, камера «кружка») и отвечает `FinishFileGeneration(id, error)`. Готовый файл X отправляет `InputFileId` —
 * отправка ждёт конца генерации ([await]): X шлёт голосовое раньше, чем сообщает «готово» (`Recorder.onSave` до
 * `finishGeneration`). Шифрование и загрузка — штатная отправка медиа ядром, «предварительной» загрузки на сервер нет.
 * Без Android — для JVM-тестов.
 */
class PreliminaryUploads(
    private val ids: AtomicLong = AtomicLong(System.nanoTime() and 0x3fffffffffffL or (1L shl 46)),
) {
    class Pending(val generationId: Long, val fileId: Int, val conversion: String, val destinationPath: String) {
        internal val done = CountDownLatch(1)
        @Volatile var failed = false
            internal set
        @Volatile var cancelled = false
            internal set
    }

    private val byGeneration = ConcurrentHashMap<Long, Pending>()
    private val byFile = ConcurrentHashMap<Int, Pending>()

    /** Новая генерация: путь назначения в [dir] (имя по ключу X — без пути ключа), запись [fileId] уже заведена. */
    fun start(conversion: String, dir: File, fileType: TdApi.FileType?, fileId: (String) -> Int): Pending {
        val gen = ids.incrementAndGet()
        dir.mkdirs()
        val dest = File(dir, "pv-$gen.${extensionFor(fileType, conversion)}").path
        File(dest).delete()
        val p = Pending(gen, fileId(dest), conversion, dest)
        byGeneration[gen] = p
        byFile[p.fileId] = p
        return p
    }

    fun isOwn(generationId: Long): Boolean = byGeneration.containsKey(generationId)

    /** FinishFileGeneration: готово (файл не пуст) — Pending с итогом; null — генерация не наша. */
    fun finish(generationId: Long, error: TdApi.Error?): Pending? {
        val p = byGeneration.remove(generationId) ?: return null
        val f = File(p.destinationPath)
        p.failed = error != null || !f.isFile || f.length() == 0L
        p.done.countDown()
        if (p.failed) byFile.remove(p.fileId)
        return p
    }

    /** CancelPreliminaryUploadFile: X больше не ждёт загрузку; файл на диске остаётся (X берёт его для обрезки). */
    fun cancel(fileId: Int): Boolean {
        val p = byFile[fileId] ?: return false
        p.cancelled = true
        return true
    }

    /** Отправка файла [fileId]: ждать конца генерации. true — файл готов, false — не наш, отказ или не дождались. */
    fun await(fileId: Int, timeoutMs: Long): Boolean {
        val p = byFile[fileId] ?: return false
        if (!p.done.await(timeoutMs, TimeUnit.MILLISECONDS)) return false
        return !p.failed
    }

    fun isGenerated(fileId: Int): Boolean = byFile.containsKey(fileId)
    fun pendingOf(fileId: Int): Pending? = byFile[fileId]

    /** Файл [fileId] отправлен или удалён (DeleteFile) — забыть. Путь файла, если он был наш. */
    fun forget(fileId: Int): String? = byFile.remove(fileId)?.also { byGeneration.remove(it.generationId) }?.destinationPath

    companion object {
        fun extensionFor(type: TdApi.FileType?, conversion: String): String = when {
            type is TdApi.FileTypeVoiceNote -> "ogg"
            type is TdApi.FileTypeVideoNote || conversion.startsWith("round") -> "mp4"
            type is TdApi.FileTypeVideo -> "mp4"
            type is TdApi.FileTypePhoto -> "jpg"
            else -> "bin"
        }
        /** Ключ X вида «round…» без исходного файла, либо любой ключ без исходного файла — файл пишет сам X. */
        fun isWrittenByApp(input: TdApi.InputFile?): Boolean =
            input is TdApi.InputFileGenerated && input.originalPath.isNullOrEmpty() && !input.conversion.isNullOrEmpty()
    }
}
