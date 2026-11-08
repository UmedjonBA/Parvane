package org.drinkless.tdlib

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * spec 004: сторож «честного UI» шва. Client.kt нельзя поднять в JVM (ядро
 * грузит нативную библиотеку), поэтому проверяем исходник: у каждой
 * управляющей функции группы есть обработчик `is TdApi.X ->`, и эти функции
 * перечислены в NO_OK_STUB — молчаливая Ok-заглушка для них запрещена.
 */
class ClientHonestUiTest {
    private val managed = listOf(
        "SetChatDescription", "SetChatPhoto", "SetChatPermissions", "SetChatMemberStatus",
        "GetChatAdministrators", "GetChatInviteLinks", "GetChatInviteLinkCounts", "GetChatInviteLink",
        "CreateChatInviteLink", "EditChatInviteLink", "RevokeChatInviteLink", "DeleteRevokedChatInviteLink",
        "DeleteAllRevokedChatInviteLinks", "ReplacePrimaryChatInviteLink", "GetChatInviteLinkMembers",
        "GetInternalLinkType", "CheckChatInviteLink", "JoinChatByInviteLink", "GetChatJoinRequests", "ProcessChatJoinRequest",
    )
    private val noStub = listOf("DeleteAccount", "SetChatDescription", "SetChatPhoto", "SetChatPermissions", "ProcessChatJoinRequest",
        "DeleteRevokedChatInviteLink", "DeleteAllRevokedChatInviteLinks", "EditChatInviteLink",
        // spec 005
        "ChangeStickerSet", "AddFavoriteSticker", "RemoveFavoriteSticker", "RemoveRecentSticker", "AddSavedAnimation", "RemoveSavedAnimation",
        "SetPollAnswer", "StopPoll", "SetChatMessageAutoDeleteTime", "EditMessageSchedulingState", "SetChatDraftMessage", "AddChatToList",
        "DeleteChatFolder", "ReorderChatFolders", "SetBirthdate", "SetAccentColor", "SetProfileAccentColor", "SetPersonalChat")
    private val managed005 = listOf("GetInstalledStickerSets", "GetStickerSet", "GetCustomEmojiStickers", "GetEmojiCategories", "ChangeStickerSet",
        "GetSavedAnimations", "AddSavedAnimation", "InputMessageSticker", "InputMessageAnimation", "InputMessagePoll", "SetPollAnswer", "StopPoll", "GetPollVoters",
        "SetChatMessageAutoDeleteTime", "GetChatScheduledMessages", "EditMessageSchedulingState", "SetChatDraftMessage", "AddChatToList",
        "GetChatFolder", "CreateChatFolder", "EditChatFolder", "DeleteChatFolder", "ReorderChatFolders", "SearchMessages", "GetLinkPreview", "GetMapThumbnailFile", "SetBirthdate")

    private fun clientSource(): String {
        val f = listOf(File("src/main/java/org/drinkless/tdlib/Client.kt"), File("libtd/src/main/java/org/drinkless/tdlib/Client.kt"))
            .firstOrNull { it.exists() } ?: throw AssertionError("нет Client.kt рядом с модулем")
        return f.readText()
    }

    // P-07: завершение сеансов с экрана устройств X — только с паролем, введённым сейчас, при любом способе выхода
    @Test
    fun sessionTerminationAsksPassword() {
        val src = clientSource()
        val handlers = src.substringAfter("is TdApi.TerminateSession ->").substringBefore("is TdApi.GetBlockedMessageSenders")
        assertTrue("TerminateSession/TerminateAllOtherSessions — через terminateDevices", handlers.contains("terminateDevices(") &&
            handlers.contains("is TdApi.TerminateAllOtherSessions -> terminateDevices("))
        assertTrue("пароль процесса для завершения сеансов не используется", !handlers.contains("sessionPassword"))
        val fn = src.substringAfter("private fun terminateDevices(").substringBefore("private fun deletionDate")
        assertTrue("пароль и способ спрашивает окно", fn.contains("askTerminate(") && fn.contains("a.password") && fn.contains("a.rotate"))
        val jni = listOf(File("../jni/jni_account.cpp"), File("jni/jni_account.cpp")).firstOrNull { it.exists() }
            ?: throw AssertionError("нет jni_account.cpp")
        val revoke = jni.readText().substringAfter("Java_org_parvane_core_ParvaneCore_nativeRevokeDevice").substringBefore("JNIEXPORT")
        assertTrue("пароль проверяется до выхода любым способом",
            revoke.indexOf("account::revokeDevice(") in 0 until revoke.indexOf("signOutDevice("))
    }

    @Test
    fun everyManagementFunctionHasHandler() {
        val src = clientSource()
        for (name in managed) assertTrue("нет обработчика $name", src.contains("is TdApi.$name ->"))
    }

    @Test
    fun spec005FunctionsHaveHandlers() {
        val src = clientSource()
        for (name in managed005) assertTrue("нет обработчика $name", src.contains("is TdApi.$name ->"))
    }

    @Test
    fun okStubGuardListsManagementSetters() {
        val src = clientSource()
        val guard = Regex("NO_OK_STUB = setOf\\(([^)]*)\\)").find(src)?.groupValues?.get(1) ?: throw AssertionError("нет NO_OK_STUB")
        for (name in noStub) assertTrue("$name не в NO_OK_STUB", guard.contains("\"$name\""))
        assertTrue(src.contains("f.javaClass.simpleName !in NO_OK_STUB"))
    }

    /** Ревью 7 ноя 2026, этап 2: у каждой функции «ежедневного» есть обработчик, и он не заглушка. */
    @Test
    fun review1107DailyFunctionsHaveHandlers() {
        val src = clientSource()
        for (name in listOf("PreliminaryUploadFile", "CancelPreliminaryUploadFile", "SendMessageAlbum", "GetMessageAvailableReactions",
                "GetEmojiReaction", "SearchContacts", "SearchChatMembers", "GetChatMessageByDate", "DeleteFile"))
            assertTrue("нет обработчика $name", src.contains("is TdApi.$name ->"))
        assertTrue("GetEmojiReaction не 404", !Regex("GetEmojiReaction\\s*->\\s*TdApi.Error").containsMatchIn(src) && !src.contains("is TdApi.GetEmojiReaction -> TdApi.Error"))
        assertTrue("SearchContacts не пуст", !src.contains("is TdApi.SearchContacts -> TdApi.Users(0"))
        // A1/A2: своя генерация — FinishFileGeneration доходит до PreliminaryUploads, голосовое/«кружок» — через resolveMedia
        assertTrue(src.contains("prelim.isOwn(function.generationId)) finishPreliminary("))
        assertTrue(src.contains("UpdateFileGenerationStart(p.generationId, \"\", p.destinationPath, g.conversion)"))
        val voice = src.substringAfter("is TdApi.InputMessageVoiceNote ->").substringBefore("is TdApi.InputMessageVideoNote ->")
        assertTrue("голосовое — resolveMedia (InputFileId записи X)", voice.contains("resolveMedia(c.voiceNote?.voiceNote)") && voice.contains("Waveform.toWire("))
        assertTrue(src.contains("is TdApi.InputFileId -> fileIdPath(input.id)"))
        // A3: ответ только у первого сообщения альбома
        assertTrue(src.substringAfter("private fun sendAlbum(").contains("if (i == 0) f.replyTo else null"))
        // A4: набор реакций — после Ready
        val ready = src.substringAfter("setAuth(TdApi.AuthorizationStateReady())").take(400)
        assertTrue("UpdateActiveEmojiReactions после Ready", ready.contains("UpdateActiveEmojiReactions(Reactions.ACTIVE)"))
        // B5: поиск по автору
        assertTrue(src.contains("HistoryQueries.fromSender(m, f.senderId)"))
        // «без звука»: и отправка, и приём
        assertTrue(src.contains("SendOptions.applySilent(prepared.content, f.options)"))
        assertTrue(src.contains("silent = (SendOptions.isSilent(content) || store.notifySilent(chatAddr, scope))"))
        // пересылка копией — параметры в JNI
        assertTrue(src.contains("ParvaneCore.forward(to, uuid, opts)"))
        val jni = listOf(File("../jni/jni_messages.cpp"), File("jni/jni_messages.cpp")).firstOrNull { it.exists() } ?: throw AssertionError("нет jni_messages.cpp")
        val fwd = jni.readText().substringAfter("ParvaneCore_nativeForward(").substringBefore("JNIEXPORT")
        assertTrue("без автора — без forwarded_*", fwd.contains("\"hide_author\"") && fwd.contains("content.erase(\"forwarded_name\")"))
        assertTrue("без подписи", fwd.contains("\"remove_caption\"") && fwd.contains("content.erase(\"caption\")"))
        assertTrue("без звука", fwd.contains("content[\"silent\"] = true"))
    }

    /** Патчи X ревью 7 ноя (этап 2): «Все чаты» без Premium (B1), перевода нет (A7), без «Добавить контакт» (C4). */
    @Test
    fun review1107TgxPatches() {
        val sh = listOf(File("../setup-tgx.sh"), File("setup-tgx.sh")).firstOrNull { it.exists() } ?: throw AssertionError("нет setup-tgx.sh")
        val t = sh.readText().substringAfter("PYREV2").substringBefore("PYREV2")
        for (m in listOf("«Все чаты» тянется без Premium", "«Все чаты» двигается без Premium", "без замка Premium на «Все чаты»",
                "перевода нет", "без строки «Перевод»", "телефонных контактов нет", "статичная реакция"))
            assertTrue("нет патча «$m»", t.contains(m))
        assertTrue(t.contains("TRANSLATE_MODE_NONE"))
    }

    @Test
    fun receiveFilterAndPendingRequestsWired() {
        val src = clientSource()
        assertTrue(src.contains("ParvaneStore.isContentAllowedForMember("))
        assertTrue(src.contains("скрыто правами группы"))
        assertTrue(src.contains("UpdateChatPendingJoinRequests"))
    }
}
