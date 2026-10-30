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

    @Test
    fun receiveFilterAndPendingRequestsWired() {
        val src = clientSource()
        assertTrue(src.contains("ParvaneStore.isContentAllowedForMember("))
        assertTrue(src.contains("скрыто правами группы"))
        assertTrue(src.contains("UpdateChatPendingJoinRequests"))
    }
}
