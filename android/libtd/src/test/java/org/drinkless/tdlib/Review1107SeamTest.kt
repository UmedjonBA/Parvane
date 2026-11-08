package org.drinkless.tdlib

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
import kotlin.concurrent.thread

/**
 * Ревью интерфейса Android 7 ноя 2026, этап 2 «ежедневное сломано» — чистые части шва (без эмулятора):
 * A1/A2 голосовое и «кружок» (генерация файла X, волна), A4 реакции, A5/A6 поиск людей, B5 история по дате и автору,
 * «без звука», пересылка копией.
 */
class Review1107SeamTest {
    private fun tmp(): File = Files.createTempDirectory("pv-rev1107").toFile()

    // ── A1/A2 ──────────────────────────────────────────────────────────────
    @Test
    fun waveformPacksLikeTelegramAndWireIsOneByteASample() {
        val samples = intArrayOf(0, 31, 7, 16, 1, 30, 12, 5)
        val packed = Waveform.pack(samples)
        assertEquals("8 отсчётов по 5 бит — 5 байт", 5, packed.size)
        assertArrayEquals(samples, Waveform.unpack(packed).copyOf(samples.size))
        // формат Telegram: младшие биты первыми — [1, 2] → 0x41, 0x00
        assertArrayEquals(byteArrayOf(0x41, 0x00), Waveform.pack(intArrayOf(1, 2)))
        val wire = Waveform.toWire(packed)!!
        assertEquals(31, wire.getInt(1))
        assertArrayEquals(samples, Waveform.unpack(Waveform.fromWire(wire)).copyOf(samples.size))
        assertNull("нет волны — нет поля", Waveform.toWire(ByteArray(0)))
        assertEquals(0, Waveform.fromWire(null).size)
        // предел провода (Media.waveform ≤ 256 байт)
        assertEquals(Waveform.WIRE_MAX, Waveform.toWire(Waveform.pack(IntArray(1000) { it % 32 }))!!.length())
    }

    @Test
    fun voiceFromWebCarriesWaveformIntoX() {
        val s = ParvaneStore().apply { self = "me@local" }
        val c = JSONObject().put("kind", "voice").put("file_id", "f1").put("mime", "audio/ogg").put("duration_secs", 3)
            .put("waveform", JSONArray(listOf(0, 31, 7)))
        val v = s.contentFrom(c) as TdApi.MessageVoiceNote
        assertArrayEquals(intArrayOf(0, 31, 7), Waveform.unpack(v.voiceNote.waveform).copyOf(3))
        assertEquals(3, v.voiceNote.duration)
    }

    @Test
    fun appWrittenFileIsNotReadyUntilGenerationFinishes() {
        val dir = tmp()
        val s = ParvaneStore()
        val up = PreliminaryUploads()
        val input = TdApi.InputFileGenerated(null, "voice-key", 0)
        assertTrue(PreliminaryUploads.isWrittenByApp(input))
        assertFalse("правка фото (есть исходный файл) — не сюда", PreliminaryUploads.isWrittenByApp(TdApi.InputFileGenerated("/a.jpg", "photo", 0)))
        var file: TdApi.File? = null
        val p = up.start("voice-key", dir, TdApi.FileTypeVoiceNote()) { path -> s.generatedFile(path, "audio/ogg").also { file = it }.id }
        assertTrue(p.destinationPath.endsWith(".ogg"))
        assertEquals("X сравнивает путь записи «кружка» с путём генерации", p.destinationPath, file!!.local.path)
        assertFalse("до FinishFileGeneration файл не готов", file!!.local.isDownloadingCompleted)
        assertTrue(up.isOwn(p.generationId))
        // X шлёт голосовое раньше, чем «готово»: отправка ждёт конца генерации
        var ready = false
        val sender = thread { ready = up.await(p.fileId, 5000) }
        Thread.sleep(150)
        assertTrue("отправка ждёт", sender.isAlive)
        File(p.destinationPath).writeBytes(ByteArray(100) { 1 })
        assertNotNull(up.finish(p.generationId, null))
        sender.join(2000)
        assertTrue(ready)
        val done = s.finishGenerated(p.fileId, ok = true)!!
        assertTrue(done.local.isDownloadingCompleted)
        assertEquals(100L, done.size)
        assertFalse("генерация закончена — больше не наша", up.isOwn(p.generationId))
        assertEquals(p.destinationPath, up.forget(p.fileId))
    }

    @Test
    fun cancelledOrEmptyGenerationIsNotSent() {
        val dir = tmp()
        val up = PreliminaryUploads()
        val a = up.start("round1", dir, TdApi.FileTypeVideoNote()) { 7 }
        assertTrue(a.destinationPath.endsWith(".mp4"))
        assertTrue(up.cancel(7)) // X отменил загрузку (обрезка «кружка»): файл на диске остаётся
        up.finish(a.generationId, TdApi.Error(-1, "Canceled"))
        assertFalse("отказ X — не отправлять", up.await(7, 100))
        val b = up.start("round2", dir, TdApi.FileTypeVideoNote()) { 8 }
        up.finish(b.generationId, null) // файла нет — пустой итог
        assertFalse(up.await(8, 100))
        assertFalse("чужой файл", up.await(99, 10))
    }

    // ── A4 ─────────────────────────────────────────────────────────────────
    @Test
    fun reactionsMatchWebSetAndNeedNoPremium() {
        val web = listOf("👍", "❤️", "🔥", "😂", "👏", "🎉", "🤔") // web provider.ts BUILTIN_REACTIONS
        assertEquals(web, Reactions.ACTIVE.take(web.size))
        val av = Reactions.available()
        assertEquals(Reactions.ACTIVE.size, av.topReactions.size)
        assertTrue(av.topReactions.none { it.needsPremium })
        assertFalse(av.allowCustomEmoji)
        assertEquals("👍", (av.topReactions[0].type as TdApi.ReactionTypeEmoji).emoji)
        assertEquals(Reactions.ACTIVE.size, Reactions.ACTIVE.toSet().size)
    }

    @Test
    fun emojiReactionIconIsRenderedOnceAndUsedForAllFrames() {
        val dir = tmp()
        var renders = 0
        val fake: (String, Int, File) -> Boolean = { _, size, f -> renders++; f.writeBytes(ByteArray(size)); true }
        val icon = Reactions.iconFile(dir, "🔥", fake)!!
        assertEquals("r-1f525.png", icon.name)
        assertNotNull(Reactions.iconFile(dir, "🔥", fake))
        assertEquals("второй раз — с диска", 1, renders)
        assertNull("пустой эмодзи", Reactions.iconFile(dir, "", fake))
        val s = ParvaneStore()
        val file = s.fileFor("reaction:${icon.name}", "", "", icon.length(), "image/png", icon.absolutePath)
        val r = Reactions.emojiReaction("🔥", file)
        assertTrue(r.isActive)
        assertEquals("🔥", r.emoji)
        assertEquals(file.id.toLong(), r.staticIcon.id)
        assertEquals(r.staticIcon, r.activateAnimation)
        assertEquals(r.staticIcon, r.effectAnimation)
        assertTrue(r.staticIcon.sticker.local.isDownloadingCompleted)
        // реакция собеседника не из набора (web/desktop шлют любой эмодзи) — тоже рисуется, но не «активна»
        assertFalse(Reactions.emojiReaction("🦄", file).isActive)
    }

    // ── A5/A6 ──────────────────────────────────────────────────────────────
    private val people = listOf(
        PeopleSearch.Person(1, "Ольга", "Тестова", "olga@local"),
        PeopleSearch.Person(2, "Bob", "", "bob@local"),
        PeopleSearch.Person(3, "", "", "zeta_nick@other.test"),
        PeopleSearch.Person(4, "Иван Петрович", "Кузнецов", "ivan@local"),
    )

    @Test
    fun peopleSearchByNameWordAndNickPrefix() {
        assertEquals("пустой запрос — все, по имени", listOf(2L, 3L, 4L, 1L), PeopleSearch.search(null, people, 0).map { it.id })
        assertEquals(listOf(1L), PeopleSearch.search("тес", people, 0).map { it.id })
        assertEquals(listOf(4L), PeopleSearch.search("петр", people, 0).map { it.id })
        assertEquals(listOf(3L), PeopleSearch.search("@zeta", people, 0).map { it.id })
        assertEquals(listOf(2L), PeopleSearch.search("BOB", people, 0).map { it.id })
        assertEquals("середина слова — не совпадение", emptyList<Long>(), PeopleSearch.search("ета", people, 0).map { it.id })
        assertEquals("два слова — оба", listOf(4L), PeopleSearch.search("иван куз", people, 0).map { it.id })
        assertEquals("предел", 2, PeopleSearch.search("", people, 2).size)
    }

    // ── B5 ─────────────────────────────────────────────────────────────────
    private fun m(id: Long, date: Int, user: Long) = TdApi.Message().apply { this.id = id; this.date = date; senderId = TdApi.MessageSenderUser(user) }

    @Test
    fun jumpToDateAndSearchBySender() {
        val msgs = arrayOf(m(5, 500, 1), m(4, 400, 2), m(3, 300, 1), m(2, 200, 2))
        assertEquals(4L, HistoryQueries.atOrBefore(msgs, 450)!!.id)
        assertEquals(5L, HistoryQueries.atOrBefore(msgs, 10_000)!!.id)
        assertEquals(2L, HistoryQueries.atOrBefore(msgs, 200)!!.id)
        assertNull("до первой даты сообщений нет", HistoryQueries.atOrBefore(msgs, 100))
        assertEquals(listOf(5L, 3L), msgs.filter { HistoryQueries.fromSender(it, TdApi.MessageSenderUser(1)) }.map { it.id })
        assertEquals(4, msgs.count { HistoryQueries.fromSender(it, null) })
    }

    // ── «без звука», пересылка копией ──────────────────────────────────────
    @Test
    fun silentSendAndSilentNotification() {
        val opts = TdApi.MessageSendOptions().apply { disableNotification = true }
        val c = SendOptions.applySilent(JSONObject().put("kind", "text").put("text", "t"), opts)
        assertTrue(c.getBoolean("silent"))
        assertTrue(SendOptions.isSilent(c))
        assertFalse(SendOptions.applySilent(c, TdApi.MessageSendOptions()).has("silent"))
        val n = Notifications()
        val msg = TdApi.Message().apply { chatId = 5; id = 1; date = 1 }
        val loud = n.onIncoming(msg, muted = false)!!
        assertTrue("обычное — со звуком (X звенит при soundId != 0)", loud.notificationSoundId != 0L)
        assertFalse(loud.addedNotifications[0].isSilent)
        val quiet = n.onIncoming(TdApi.Message().apply { chatId = 5; id = 2; date = 2 }, muted = false, silent = true)!!
        assertEquals(0L, quiet.notificationSoundId)
        assertTrue(quiet.addedNotifications[0].isSilent)
    }

    @Test
    fun forwardCopyOptions() {
        val o = SendOptions.forwardOptions(sendCopy = true, removeCaption = true, TdApi.MessageSendOptions().apply { disableNotification = true })
        assertTrue(o.getBoolean("hide_author")); assertTrue(o.getBoolean("remove_caption")); assertTrue(o.getBoolean("silent"))
        val plain = SendOptions.forwardOptions(false, false, null)
        assertFalse(plain.getBoolean("hide_author")); assertFalse(plain.getBoolean("silent"))
        assertTrue(SendOptions.isPreviewOnly(TdApi.MessageSendOptions().apply { onlyPreview = true }))
    }
}
