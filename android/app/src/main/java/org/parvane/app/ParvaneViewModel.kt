package org.parvane.app

import android.app.Application
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.lifecycle.AndroidViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.withContext
import org.drinkless.tdlib.Client
import org.drinkless.tdlib.TdApi
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine

/**
 * Parvane: состояние экрана поверх шва TDLib — только [Client.send] и апдейты
 * [TdApi], как у любого TDLib-клиента. Ядро (сеть/E2E) за шимом.
 */
class ParvaneViewModel(app: Application) : AndroidViewModel(app) {
    enum class Auth { LOADING, NICK, PASSWORD, READY }

    val auth = mutableStateOf(Auth.LOADING)
    val error = mutableStateOf<String?>(null)
    val busy = mutableStateOf(false)
    val chats = mutableStateMapOf<Long, TdApi.Chat>()
    val users = mutableStateMapOf<Long, TdApi.User>()
    val messages = mutableStateMapOf<Long, List<TdApi.Message>>()
    val openChatId = mutableStateOf<Long?>(null)
    val self = mutableStateOf<TdApi.User?>(null)

    private val client: Client = Client.create({ obj -> onUpdate(obj) }, null, null)

    init {
        val dir = app.filesDir.resolve("parvane").apply { mkdirs() }
        client.send(
            TdApi.SetTdlibParameters(
                false, dir.absolutePath, dir.absolutePath, ByteArray(0),
                false, false, false, false, 0, "", "ru", android.os.Build.MODEL,
                android.os.Build.VERSION.RELEASE, "0.1",
            ),
        ) { }
    }

    private fun onUpdate(obj: TdApi.Object) {
        when (obj) {
            is TdApi.UpdateAuthorizationState -> when (obj.authorizationState) {
                is TdApi.AuthorizationStateWaitPhoneNumber -> auth.value = Auth.NICK
                is TdApi.AuthorizationStateWaitPassword -> auth.value = Auth.PASSWORD
                is TdApi.AuthorizationStateReady -> {
                    auth.value = Auth.READY
                    client.send(TdApi.GetMe()) { me -> (me as? TdApi.User)?.let { self.value = it } }
                    client.send(TdApi.LoadChats(TdApi.ChatListMain(), 100)) { }
                }
                is TdApi.AuthorizationStateLoggingOut, is TdApi.AuthorizationStateClosed -> {
                    chats.clear(); messages.clear(); openChatId.value = null
                }
                else -> {}
            }
            is TdApi.UpdateNewChat -> chats[obj.chat.id] = obj.chat
            is TdApi.UpdateUser -> users[obj.user.id] = obj.user
            is TdApi.UpdateChatTitle -> chats[obj.chatId]?.let { c -> chats[obj.chatId] = c.also { it.title = obj.title } }
            is TdApi.UpdateChatLastMessage -> chats[obj.chatId]?.let { c ->
                c.lastMessage = obj.lastMessage
                c.positions = obj.positions
                chats[obj.chatId] = c
            }
            is TdApi.UpdateChatReadInbox -> chats[obj.chatId]?.let { c ->
                c.unreadCount = obj.unreadCount
                chats[obj.chatId] = c
            }
            is TdApi.UpdateNewMessage -> {
                val m = obj.message
                val list = messages[m.chatId].orEmpty()
                if (list.none { it.id == m.id }) messages[m.chatId] = list + m
                if (openChatId.value == m.chatId && !m.isOutgoing) {
                    client.send(TdApi.ViewMessages(m.chatId, longArrayOf(m.id), null, true)) { }
                }
            }
            else -> {}
        }
    }

    private suspend fun call(f: TdApi.Function<*>): TdApi.Object =
        suspendCoroutine { cont -> client.send(f) { cont.resume(it) } }

    fun submitNick(nick: String) = viewModelScope.launch {
        error.value = null
        val r = call(TdApi.SetAuthenticationPhoneNumber(nick, null))
        if (r is TdApi.Error) error.value = r.message
    }

    fun submitPassword(password: String) = viewModelScope.launch {
        error.value = null; busy.value = true
        val r = withContext(Dispatchers.IO) { call(TdApi.CheckAuthenticationPassword(password)) }
        busy.value = false
        if (r is TdApi.Error) error.value = r.message
    }

    fun openChat(chatId: Long) = viewModelScope.launch {
        openChatId.value = chatId
        val r = call(TdApi.GetChatHistory(chatId, 0, 0, 100, false))
        if (r is TdApi.Messages) {
            messages[chatId] = r.messages.reversed().toList()
            r.messages.maxOfOrNull { it.id }?.let { client.send(TdApi.ViewMessages(chatId, longArrayOf(it), null, true)) { } }
        }
    }

    fun closeChat() { openChatId.value = null }

    fun sendText(chatId: Long, text: String) = viewModelScope.launch {
        val r = call(TdApi.SendMessage(chatId, null, null, null, null,
            TdApi.InputMessageText(TdApi.FormattedText(text, arrayOf()), null, false)))
        if (r is TdApi.Error) error.value = r.message
    }

    fun openByNick(nick: String) = viewModelScope.launch {
        error.value = null; busy.value = true
        val r = withContext(Dispatchers.IO) { call(TdApi.SearchPublicChat(nick)) }
        busy.value = false
        when (r) {
            is TdApi.Chat -> { chats[r.id] = r; openChat(r.id) }
            is TdApi.Error -> error.value = r.message
            else -> {}
        }
    }

    fun logout() = viewModelScope.launch { call(TdApi.LogOut()) }

    fun titleOf(chatId: Long): String = chats[chatId]?.title ?: users[chatId]?.firstName ?: "…"
}
