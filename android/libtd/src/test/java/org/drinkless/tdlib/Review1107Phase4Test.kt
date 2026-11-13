package org.drinkless.tdlib

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.parvane.core.ParvaneProtocol
import java.io.File
import java.nio.file.Files

/**
 * Ревью интерфейса Android 7 ноя 2026, этап 4: MEDIA-2 (спойлер, подпись над медиа, альбомы), QUOTE-1 (цитата в
 * ответе), CONTACT-1 (своё имя и заметка контакта), «Недавние» поиска, порядок наборов стикеров, поиск эмодзи и
 * хэштегов, уведомления чата (B10), обработчики вместо молчаливого Ok и патчи X. Чистый JVM.
 */
class Review1107Phase4Test {
    private fun tmp(): File = Files.createTempDirectory("pv-rev1107-4").toFile()
    private fun store(): ParvaneStore = ParvaneStore().apply { self = "me@local" }
    private fun bold(off: Int, len: Int) = TdApi.TextEntity(off, len, TdApi.TextEntityTypeBold())
    private fun photo(album: String? = null, caption: String = "") = JSONObject().put("kind", "photo").put("file_id", "f-" + System.nanoTime())
        .put("mime", "image/jpeg").put("width", 10).put("height", 10).put("caption", caption).also { o -> album?.let { o.put("album_id", it) } }

    // ── MEDIA-2 ───────────────────────────────────────────────────────────────
    @Test
    fun spoilerCaptionAboveAndCaptionEntitiesGoToWire() {
        val input = TdApi.InputMessagePhoto(TdApi.InputPhoto(TdApi.InputFileLocal("/x.jpg"), null, null, IntArray(0), 10, 10),
            TdApi.FormattedText("жирно", arrayOf(bold(0, 5))), true, null, true)
        val c = JSONObject().put("kind", "photo").put("caption", "жирно")
        MediaFlags.applyInput(c, input)
        assertTrue(c.getBoolean("spoiler"))
        assertTrue(c.getBoolean("invert_media"))
        assertEquals("bold", c.getJSONArray("entities").getJSONObject(0).getString("type"))
        // документ: спойлера у файла не бывает (как web MEDIA_SPOILER_KINDS)
        val doc = JSONObject().put("kind", "file")
        MediaFlags.applyInput(doc, TdApi.InputMessageDocument(TdApi.InputDocument(TdApi.InputFileLocal("/a.pdf"), null, false), TdApi.FormattedText("", arrayOf())))
        assertFalse(doc.has("spoiler"))
        // текст с карточкой ссылки над текстом
        val t = JSONObject().put("kind", "text").put("text", "https://example.org")
        MediaFlags.applyInput(t, TdApi.InputMessageText(TdApi.FormattedText("https://example.org", arrayOf()), TdApi.LinkPreviewOptions(false, "", false, false, true), false))
        assertTrue(t.getBoolean("invert_media"))
    }

    @Test
    fun receivedPhotoShowsSpoilerAndCaptionAboveWithEntities() {
        val s = store()
        val c = photo(caption = "привет").put("spoiler", true).put("invert_media", true)
            .put("entities", JSONArray().put(JSONObject().put("type", "bold").put("offset", 0).put("length", 6)))
        val m = s.putMessage("u1", "bob@local", "me@local", 100, c, out = false)!!
        val p = m.content as TdApi.MessagePhoto
        assertTrue(p.hasSpoiler)
        assertTrue(p.showCaptionAboveMedia)
        assertEquals(1, p.caption.entities.size)
        val plain = s.putMessage("u2", "bob@local", "me@local", 101, photo(), out = false)!!.content as TdApi.MessagePhoto
        assertFalse(plain.hasSpoiler)
        assertFalse(plain.showCaptionAboveMedia)
    }

    @Test
    fun albumGroupsConsecutiveSameAuthorUpToTen() {
        val s = store()
        val a = MediaFlags.newAlbumId()
        assertEquals(16, java.util.Base64.getDecoder().decode(a).size)
        assertNotEquals(a, MediaFlags.newAlbumId())
        val first = (1..3).map { s.putMessage("a$it", "bob@local", "me@local", 100L + it, photo(a), out = false)!! }
        assertNotEquals(0L, first[0].mediaAlbumId)
        assertTrue(first.all { it.mediaAlbumId == first[0].mediaAlbumId })
        // 11 элементов одного album_id — группа из 10 и новая группа
        val b = MediaFlags.newAlbumId()
        val eleven = (1..11).map { s.putMessage("b$it", "bob@local", "me@local", 200L + it, photo(b), out = false)!! }
        assertEquals(10, eleven.count { it.mediaAlbumId == eleven[0].mediaAlbumId })
        assertNotEquals(eleven[0].mediaAlbumId, eleven[10].mediaAlbumId)
        assertNotEquals(first[0].mediaAlbumId, eleven[0].mediaAlbumId)
        // другой автор между элементами разрывает группу; сообщение без album_id — вне альбома
        val c = MediaFlags.newAlbumId()
        val x1 = s.putMessage("c1", "me@local", "bob@local", 300, photo(c), out = true)!!
        val other = s.putMessage("c2", "bob@local", "me@local", 301, photo(), out = false)!!
        val x2 = s.putMessage("c3", "me@local", "bob@local", 302, photo(c), out = true)!!
        assertEquals(0L, other.mediaAlbumId)
        assertNotEquals(x1.mediaAlbumId, x2.mediaAlbumId)
        // битый album_id (не 16 байт) — не альбом
        assertEquals(0L, s.putMessage("d1", "bob@local", "me@local", 400, photo("AAAA"), out = false)!!.mediaAlbumId)
    }

    @Test
    fun captionAboveOnlyWithCaption() {
        val c = JSONObject().put("kind", "photo").put("caption", "")
        MediaFlags.applyInput(c, TdApi.InputMessagePhoto(TdApi.InputPhoto(TdApi.InputFileLocal("/x.jpg"), null, null, IntArray(0), 10, 10),
            TdApi.FormattedText("", arrayOf()), true, null, false))
        assertFalse(c.has("invert_media"))
    }

    // «Отправить, когда будет в сети»: срок-метка 0x7FFFFFFE, уходит по присутствию собеседника
    @Test
    fun sendWhenOnlineFiresOnPresence() {
        val d = tmp()
        val q = ScheduledQueue(d) { 1000L }
        q.add("u-online", 11L, "bob@local", JSONObject().put("kind", "text").put("text", "x"), null, null, ScheduledQueue.UNTIL_ONLINE)
        q.add("u-date", 11L, "bob@local", JSONObject().put("kind", "text").put("text", "y"), null, null, 900L)
        assertEquals(listOf("u-date"), q.takeDue { false }.map { it.uuid })
        assertTrue(q.takeDue { it == "carol@local" }.isEmpty())
        assertEquals(listOf("u-online"), q.takeDue { it == "bob@local" }.map { it.uuid })
        assertEquals(2147483646000L, ScheduledQueue.UNTIL_ONLINE * 1000)
    }

    // ── QUOTE-1 ───────────────────────────────────────────────────────────────
    @Test
    fun replyQuoteRoundTrip() {
        val q = MediaFlags.quoteOf(TdApi.InputMessageReplyToMessage(5, TdApi.InputTextQuote(TdApi.FormattedText("часть", arrayOf(bold(0, 5))), 7), 0, null))!!
        assertEquals("часть", q.getString("text"))
        assertEquals(7, q.getInt("offset"))
        assertEquals("bold", q.getJSONArray("entities").getJSONObject(0).getString("type"))
        assertNull(MediaFlags.quoteOf(TdApi.InputMessageReplyToMessage(5, null, 0, null)))
        val s = store()
        s.putMessage("src", "bob@local", "me@local", 100, JSONObject().put("kind", "text").put("text", "вот часть текста"), out = false)
        val reply = s.putMessage("rep", "me@local", "bob@local", 101, JSONObject().put("kind", "text").put("text", "ответ").put("reply_quote", q),
            out = true, replyUuid = "src")!!
        val r = reply.replyTo as TdApi.MessageReplyToMessage
        assertEquals("часть", r.quote!!.text.text)
        assertEquals(7, r.quote!!.position)
        assertTrue(r.quote!!.isManual)
    }

    // ── CONTACT-1 ─────────────────────────────────────────────────────────────
    @Test
    fun contactNameOverrideLikeWeb() {
        assertNull("форма с именем собеседника без правки — своего имени нет", ContactNames.override("Robin", "Robin", ""))
        assertNull(ContactNames.override("Robin", "  ", ""))
        assertEquals("Роб" to "Иванов", ContactNames.override("Robin", "Роб", "Иванов"))
        assertEquals(256, ContactNames.override("x", "я".repeat(300), "")!!.first.toByteArray().size)
        assertEquals(4096, ContactNames.clampNote("ж".repeat(5000)).toByteArray().size)
    }

    private fun resolver() = object : StateJournal.Resolver {
        override fun addressOf(chatId: Long): String? = null
        override fun chatIdOf(address: String): Long? = null
        override fun domain() = "local"
        override fun isKnownV2Group(hex: String) = false
    }

    @Test
    fun contactsJournalRoundTripAndPersist() {
        val a = tmp(); val b = tmp()
        val local = ChatLocalState(a)
        local.setContact("bob@local", ChatLocalState.Contact("Боб", "Строитель", "сосед"))
        // переживает перезапуск (contacts.json читается в init — до объявления поля была потеря)
        assertEquals("сосед", ChatLocalState(a).contactOf("bob@local")?.note)
        val j = StateJournal(ParvaneProtocol.stateCodec, resolver())
        val snap = j.viewOf(local, ScheduledQueue(a) { 1000L })
        val e = valuesOf(snap, "CONTACT").getJSONObject(0)
        assertEquals("bob@local", e.getJSONObject("user").getString("address"))
        assertEquals("Боб", e.getString("first_name"))
        assertEquals("Строитель", e.getString("last_name"))
        assertEquals("сосед", e.getString("note"))
        assertTrue("contacts" in StateJournal.KINDS)
        val other = ChatLocalState(b)
        val ch = StateJournal(ParvaneProtocol.stateCodec, resolver()).show(snap, other, ScheduledQueue(b) { 1000L })
        assertEquals(setOf("bob@local"), ch.contacts)
        assertEquals("Боб Строитель", other.contactOf("bob@local")?.name)
        // удаление из контактов на одном устройстве — имя и заметка уходят и на другом
        local.removeContact("bob@local")
        val ch2 = StateJournal(ParvaneProtocol.stateCodec, resolver()).show(j.viewOf(local, ScheduledQueue(a) { 1000L }), other, ScheduledQueue(b) { 1000L })
        assertEquals(setOf("bob@local"), ch2.contacts)
        assertNull(other.contactOf("bob@local"))
        a.deleteRecursively(); b.deleteRecursively()
    }

    @Test
    fun contactNameShownOnlyLocallyAndPublicNameKept() {
        val s = store()
        s.local = ChatLocalState(tmp())
        s.setProfile("bob@local", JSONObject().put("display_name", "Robin"))
        assertEquals("Robin", s.ensurePeer("bob@local").first.firstName)
        s.local!!.setContact("bob@local", ChatLocalState.Contact("Роб", "Иванов", ""))
        val (u, chat, _) = s.ensurePeer("bob@local")
        assertEquals("Роб", u.firstName)
        assertEquals("Иванов", u.lastName)
        assertEquals("Роб Иванов", chat.title)
        assertEquals("в провод и в форму — имя собеседника", "Robin", s.publicName("bob@local"))
        // заметка без своего имени — имя собеседника
        s.local!!.setContact("bob@local", ChatLocalState.Contact("", "", "заметка"))
        assertEquals("Robin", s.ensurePeer("bob@local").first.firstName)
    }

    // ── B6: «Недавние» поиска ────────────────────────────────────────────────
    @Test
    fun recentlyFoundChatsPersistAndClear() {
        val d = tmp()
        val l = ChatLocalState(d)
        l.addRecentFound(1); l.addRecentFound(2); l.addRecentFound(1)
        assertEquals(listOf(1L, 2L), l.recentFoundChatIds())
        l.removeRecentFound(2)
        l.hideTop(7)
        val re = ChatLocalState(d)
        assertEquals(listOf(1L), re.recentFoundChatIds())
        assertTrue(re.isHiddenTop(7))
        re.clearRecentFound()
        assertTrue(ChatLocalState(d).recentFoundChatIds().isEmpty())
        repeat(60) { l.addRecentFound(100L + it) }
        assertEquals(ChatLocalState.RECENT_MAX, l.recentFoundChatIds().size)
    }

    // ── B8: порядок наборов ──────────────────────────────────────────────────
    @Test
    fun stickerSetOrderGoesToJournalAddedMs() {
        val d = tmp()
        val j = PackJournal(d)
        val refs = (1..3).map { JSONObject().put("file_id", "pk$it").put("file_key", "a2V5").put("file_nonce", "bm9uY2U=").put("name", "p$it") }
        val keys = refs.mapIndexed { i, r -> j.record(r, false, 10L + i, nowMs = 1000L + i * 10) }
        assertTrue(keys.all { it != null })
        assertEquals(keys[2], j.keyOfLocal(12L))
        assertTrue(j.reorder(listOf(keys[2]!!, keys[0]!!, keys[1]!!)))
        val order = (0 until j.records().length()).map { j.records().getJSONObject(it) }.sortedBy { it.getString("added_ms").toLong() }.map { it.getString("set_id") }
        assertEquals(listOf(keys[2], keys[0], keys[1]), order)
        assertFalse("тот же порядок — без записей", j.reorder(listOf(keys[2]!!, keys[0]!!, keys[1]!!)))

        val idx = PackIndex(tmp())
        val p = (1..3).map { idx.registerReceived(refs[it - 1], false) }
        p.forEach { pk -> idx.materialize(pk, "/tmp/x", listOf("a.webp"), install = true) }
        assertTrue(idx.reorder(false, listOf(p[2].setId, p[0].setId, p[1].setId)))
        assertEquals(listOf(p[2].setId, p[0].setId, p[1].setId), idx.installed(false).map { it.setId })
    }

    // ── поиск эмодзи, хэштеги, флаг ──────────────────────────────────────────
    @Test
    fun emojiSearchByWordHashtagsAndFlag() {
        assertTrue(EmojiSearch.search("grinning").any { it.emoji == "😀" })
        assertTrue(EmojiSearch.search("сердц").any { it.emoji == "❤️" })
        assertTrue(EmojiSearch.search("x").isEmpty())
        assertEquals(listOf("работа", "радость"), Hashtags.search(listOf("#работа и #радость", "снова #работа", "#отдых"), "ра", 10))
        assertEquals("🇷🇺", SeamExec.flagEmoji("ru"))
        assertEquals("", SeamExec.flagEmoji("r1"))
    }

    // ── B10: уведомления чата ────────────────────────────────────────────────
    @Test
    fun chatNotifySilentAndPreviewKeptAndJournaled() {
        val s = store()
        s.ensurePeer("bob@local")
        val n = TdApi.ChatNotificationSettings(true, 0, false, 0L, false, false, true, false, true, 0, true, true, true, false, true, false)
        s.setChatNotify("bob@local", n)
        val got = s.chatNotifySettings("bob@local")
        assertFalse(got.useDefaultSound); assertEquals(0L, got.soundId)
        assertFalse(got.useDefaultShowPreview); assertFalse(got.showPreview)
        assertTrue(s.notifySilent("bob@local", "users"))
        assertFalse(s.notifyPreview("bob@local", "users"))
        // мут чата не теряет «без звука» и «показывать текст»
        s.setChatMute("bob@local", 3600)
        assertTrue(s.notifySilent("bob@local", "users"))
        // в журнал: silent / show_previews; «как в области» — поле снимается
        val view = s.notifyView()
        val j = StateJournal(ParvaneProtocol.stateCodec, object : StateJournal.Resolver {
            override fun addressOf(chatId: Long): String? = null
            override fun chatIdOf(address: String): Long? = null
            override fun domain() = "local"
            override fun isKnownV2Group(hex: String) = false
        })
        val d = tmp()
        val st = valuesOf(j.viewOf(ChatLocalState(d), ScheduledQueue(d) { 1000L }, emptySet(), view), "PEER_NOTIFY").getJSONObject(0).getJSONObject("settings")
        assertTrue(st.getBoolean("silent"))
        assertFalse(st.getBoolean("show_previews"))
        s.setChatNotify("bob@local", TdApi.ChatNotificationSettings(true, 0, true, 1L, true, true, true, false, true, 0, true, true, true, false, true, false))
        val st2 = valuesOf(j.viewOf(ChatLocalState(d), ScheduledQueue(d) { 1000L }, emptySet(), s.notifyView()), "PEER_NOTIFY").getJSONObject(0).getJSONObject("settings")
        assertFalse(st2.has("silent")); assertFalse(st2.has("show_previews"))
        // «Сбросить все настройки»
        s.setChatMute("bob@local", 3600)
        val ups = s.resetNotify()
        assertTrue(ups.any { it is TdApi.UpdateScopeNotificationSettings })
        assertEquals(0, s.chatNotifySettings("bob@local").muteFor)
    }

    // ── сторожа кода шва и патчей X ───────────────────────────────────────────
    private fun src(rel: String): String = listOf(File(rel), File("../$rel"), File("libtd/$rel")).firstOrNull { it.exists() }?.readText()
        ?: throw AssertionError("нет $rel")

    @Test
    fun formerSilentOkFunctionsHaveRealHandlers() {
        val c = src("src/main/java/org/drinkless/tdlib/Client.kt")
        for (name in listOf("CreateNewSupergroupChat", "AddChatMembers", "GetUserProfilePhotos", "DeleteProfilePhoto", "ResetAllNotificationSettings",
                "AddRecentlyFoundChat", "RemoveRecentlyFoundChat", "ClearRecentlyFoundChats", "RemoveTopChat", "ReorderInstalledStickerSets",
                "ClearRecentStickers", "SearchInstalledStickerSets", "SearchStickerSets", "AddContact", "RemoveContacts", "SetUserNote",
                "DeleteChatMessagesBySender", "UnpinAllChatMessages", "EditMessageCaption", "GetMessages", "GetRepliedMessage",
                "CanSendMessageToUser", "GetGroupsInCommon", "SearchHashtags", "ReportChatPhoto", "GetArchiveChatListSettings",
                "SetArchiveChatListSettings", "GetChatFolderInviteLinks", "ToggleSessionCanAcceptCalls"))
            assertTrue("нет обработчика $name", c.contains("is TdApi.$name ->") || c.contains("is TdApi.$name,"))
        assertFalse("SearchStickers не пуст", c.contains("is TdApi.SearchStickers -> TdApi.Stickers(arrayOf())"))
        assertFalse("SearchEmojis не пуст", c.contains("is TdApi.SearchEmojis -> TdApi.EmojiKeywords(arrayOf())"))
        // MEDIA-2/QUOTE-1 при отправке, альбом — одно album_id
        assertTrue(c.contains("MediaFlags.applyInput(prepared.content, f.inputMessageContent)"))
        assertTrue(c.contains("MediaFlags.quoteOf(f.replyTo)"))
        assertTrue(c.substringAfter("private fun sendAlbum(").contains("MediaFlags.newAlbumId()"))
        assertTrue(c.contains("is TdApi.MessageSchedulingStateSendWhenOnline)\n            return scheduleMessage(f.chatId, address, prepared, replyUuid, ScheduledQueue.UNTIL_ONLINE)"))
        // execute: синхронные функции X вне прежнего списка
        for (name in listOf("GetCountryFlagEmoji", "GetSuggestedFileName", "GetPushReceiverId", "GetLogTags"))
            assertTrue("execute: $name", c.substringAfter("fun <T : TdApi.Object> execute(").substringBefore("if (result is TdApi.Error)").contains("is TdApi.$name ->"))
        // CONTACT-1: правка контакта — под замком синка журнала (иначе проекция идущего синка стирала имя, rev4c)
        assertTrue(c.substringAfter("private fun addContact(").substringBefore("private fun removeContact(").contains("synchronized(stateLock)"))
        assertTrue(c.substringAfter("private fun setContactNote(").substringBefore("private fun contactChanged(").contains("synchronized(stateLock)"))
        val jni = src("jni/jni_account.cpp")
        assertTrue(jni.contains("Java_org_parvane_core_ParvaneCore_nativeClearAvatar"))
    }

    @Test
    fun phase4TgxPatches() {
        val t = src("setup-tgx.sh").substringAfter("<<'PYREV4'").substringBefore("\nPYREV4")
        for (m in listOf("своё имя и заметка контакта (CONTACT-1)", "поле заметки (CONTACT-1)", "SetUserNote", "без «Прокси»",
                "без блока «Обновления приложения»", "без пригласительных ссылок папки", "без вкладки «Тренды»",
                "ссылка группы — «Тип группы» (PUBLIC-1)", "канал без шага ссылки", "передачи владения в группе v2 нет"))
            assertTrue("нет патча «$m»", t.contains(m))
        val sh = src("setup-tgx.sh")
        assertTrue("C7-8: ffmpeg закреплён", sh.contains("pv_pin_submodule app/jni/third_party/ffmpeg 30e346c7"))
        assertTrue("C7-8: rlottie закреплён", sh.contains("pv_pin_submodule app/jni/third_party/rlottie 75614796"))
        val ru = src("tgx-overlay/app/src/main/res/values-ru/parvane.xml")
        val en = src("tgx-overlay/app/src/main/res/values/parvane.xml")
        for (k in listOf("ParvaneContactNote", "ParvaneContactNoteInfo")) { assertTrue("ru $k", ru.contains("name=\"$k\"")); assertTrue("en $k", en.contains("name=\"$k\"")) }
        assertTrue(en.contains("name=\"edit_parvaneContactNote\""))
    }
}
