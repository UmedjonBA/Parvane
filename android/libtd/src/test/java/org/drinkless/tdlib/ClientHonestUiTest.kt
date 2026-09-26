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
    private val noStub = listOf("SetChatDescription", "SetChatPhoto", "SetChatPermissions", "ProcessChatJoinRequest",
        "DeleteRevokedChatInviteLink", "DeleteAllRevokedChatInviteLinks", "EditChatInviteLink")

    private fun clientSource(): String {
        val f = listOf(File("src/main/java/org/drinkless/tdlib/Client.kt"), File("libtd/src/main/java/org/drinkless/tdlib/Client.kt"))
            .firstOrNull { it.exists() } ?: throw AssertionError("нет Client.kt рядом с модулем")
        return f.readText()
    }

    @Test
    fun everyManagementFunctionHasHandler() {
        val src = clientSource()
        for (name in managed) assertTrue("нет обработчика $name", src.contains("is TdApi.$name ->"))
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
