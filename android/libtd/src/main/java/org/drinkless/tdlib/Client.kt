package org.drinkless.tdlib

import android.util.Log
import org.json.JSONObject
import org.parvane.core.ParvaneCore
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

/**
 * Parvane: shim класса TDLib `org.drinkless.tdlib.Client` поверх parvane-core.
 *
 * Шов тот же, что у TDLib: [send] принимает [TdApi.Function], ответ и апдейты
 * приходят в [ResultHandler.onResult] объектами [TdApi]. Так UI TDLib-клиента
 * (Telegram X и др.) работает без правок, а сеть/E2E — наши (JNI → ядро).
 * Синтез объектов TdApi — как десктоп синтезирует MTPMessage: по событиям
 * ядра ({"type":"message"...}) строим Chat/Message/User и шлём апдейты.
 *
 * Отображение логина на авторизацию TDLib:
 *   WaitTdlibParameters → SetTdlibParameters (каталоги, gateway из
 *   [ParvaneCore.init]) → WaitPhoneNumber (поле = ник) →
 *   SetAuthenticationPhoneNumber(ник) → WaitPassword → CheckAuthenticationPassword
 *   → identity.token.issue → Ready. Сохранённая сессия → сразу Ready.
 */
class Client private constructor(
    private val updateHandler: ResultHandler?,
    private val exceptionHandler: ExceptionHandler?,
) {
    fun interface ResultHandler {
        fun onResult(obj: TdApi.Object)
    }

    fun interface ExceptionHandler {
        fun onException(e: Throwable)
    }

    companion object {
        private const val TAG = "ParvaneClient"

        /** Gateway по умолчанию — тестовый прод; приложение может переопределить. */
        @JvmStatic
        @Volatile
        var gatewayUrl: String = "wss://parvane.duckdns.org:20443/ws"

        @JvmStatic
        fun create(
            updateHandler: ResultHandler?,
            updateExceptionHandler: ExceptionHandler?,
            @Suppress("UNUSED_PARAMETER") defaultExceptionHandler: ExceptionHandler?,
        ): Client = Client(updateHandler, updateExceptionHandler)

        /** Синхронные запросы TDLib (execute) — у нас только GetOption/Log*. */
        @JvmStatic
        fun execute(function: TdApi.Function<*>): TdApi.Object = when (function) {
            is TdApi.SetLogVerbosityLevel, is TdApi.SetLogStream -> TdApi.Ok()
            is TdApi.GetOption -> TdApi.OptionValueEmpty()
            else -> TdApi.Error(400, "execute: не поддерживается ${function.javaClass.simpleName}")
        }
    }

    // Один поток на ответы/апдейты (как поток апдейтов TDLib) + IO для ядра.
    private val handlerThread = Executors.newSingleThreadExecutor { r -> Thread(r, "parvane-updates") }
    private val io = Executors.newCachedThreadPool { r -> Thread(r, "parvane-io") }
    private val store = ParvaneStore()

    @Volatile private var authState: TdApi.AuthorizationState = TdApi.AuthorizationStateWaitTdlibParameters()
    @Volatile private var pendingNick: String = ""
    @Volatile private var closed = false

    private val coreListener = ParvaneCore.Listener { event -> onCoreEvent(event) }

    init {
        ParvaneCore.addListener(coreListener)
        postUpdate(TdApi.UpdateAuthorizationState(authState))
    }

    fun send(function: TdApi.Function<*>, resultHandler: ResultHandler?) =
        send(function, resultHandler, null)

    fun send(function: TdApi.Function<*>, resultHandler: ResultHandler?, exceptionHandler: ExceptionHandler?) {
        if (closed) return
        io.execute {
            val result = try {
                handle(function)
            } catch (e: Throwable) {
                Log.e(TAG, "send ${function.javaClass.simpleName}", e)
                (exceptionHandler ?: this.exceptionHandler)?.onException(e)
                TdApi.Error(500, e.message ?: e.javaClass.simpleName)
            }
            resultHandler?.let { h -> handlerThread.execute { h.onResult(result) } }
        }
    }

    fun close() {
        closed = true
        ParvaneCore.removeListener(coreListener)
        setAuth(TdApi.AuthorizationStateClosed())
    }

    private fun postUpdate(update: TdApi.Update) {
        val h = updateHandler ?: return
        handlerThread.execute {
            try {
                h.onResult(update)
            } catch (e: Throwable) {
                exceptionHandler?.onException(e)
            }
        }
    }

    private fun setAuth(state: TdApi.AuthorizationState) {
        authState = state
        postUpdate(TdApi.UpdateAuthorizationState(state))
    }

    // ── обработка функций TDLib ─────────────────────────────────────────────
    private fun handle(f: TdApi.Function<*>): TdApi.Object = when (f) {
        is TdApi.SetLogVerbosityLevel, is TdApi.SetLogStream, is TdApi.SetLogTagVerbosityLevel -> TdApi.Ok()
        is TdApi.GetOption -> TdApi.OptionValueEmpty()
        is TdApi.SetOption -> TdApi.Ok()
        is TdApi.GetAuthorizationState -> authState

        is TdApi.SetTdlibParameters -> {
            ParvaneCore.init(gatewayUrl, f.databaseDirectory)
            if (ParvaneCore.self().isNotEmpty() && ParvaneCore.startSession()) {
                onSessionReady(ParvaneCore.self())
            } else {
                setAuth(TdApi.AuthorizationStateWaitPhoneNumber())
            }
            TdApi.Ok()
        }
        is TdApi.SetAuthenticationPhoneNumber -> {
            // Поле «номер телефона» экрана TDLib = ник Parvane
            pendingNick = f.phoneNumber.trim().removePrefix("@")
            if (pendingNick.isEmpty()) {
                TdApi.Error(400, "Введите ник")
            } else {
                setAuth(TdApi.AuthorizationStateWaitPassword("", false, false, ""))
                TdApi.Ok()
            }
        }
        is TdApi.CheckAuthenticationPassword -> {
            val r = ParvaneCore.login(pendingNick, f.password)
            if (r.optBoolean("ok")) {
                if (ParvaneCore.startSession()) {
                    onSessionReady(r.optString("address"))
                    TdApi.Ok()
                } else {
                    TdApi.Error(500, "не удалось поднять сессию")
                }
            } else {
                TdApi.Error(400, r.optString("error", "неверный логин или пароль"))
            }
        }
        is TdApi.ResendAuthenticationCode, is TdApi.CheckAuthenticationCode ->
            TdApi.Error(400, "Parvane: кодов нет — вход по нику и паролю")
        is TdApi.LogOut -> {
            ParvaneCore.logout()
            store.clear()
            setAuth(TdApi.AuthorizationStateLoggingOut())
            setAuth(TdApi.AuthorizationStateWaitPhoneNumber())
            TdApi.Ok()
        }
        is TdApi.Close -> {
            close()
            TdApi.Ok()
        }

        is TdApi.GetMe -> store.user(store.self) ?: TdApi.Error(401, "нет сессии")
        is TdApi.GetUser -> store.userById(f.userId) ?: TdApi.Error(404, "user not found")
        is TdApi.GetChat -> store.chatById(f.chatId) ?: TdApi.Error(404, "chat not found")
        is TdApi.LoadChats -> {
            // Все чаты уже объявлены апдейтами; TDLib возвращает 404, когда
            // список исчерпан — UI на это и рассчитывает
            TdApi.Error(404, "Not Found")
        }
        is TdApi.GetChats -> TdApi.Chats(store.chatIds().size, store.chatIds().take(f.limit).toLongArray())
        is TdApi.GetChatHistory -> store.history(f.chatId, f.fromMessageId, f.limit)
        is TdApi.ViewMessages -> {
            f.messageIds.forEach { id -> store.uuidOf(f.chatId, id)?.let { ParvaneCore.markRead(it) } }
            store.markInboxRead(f.chatId, f.messageIds.maxOrNull() ?: 0)?.let { postUpdate(it) }
            TdApi.Ok()
        }
        is TdApi.OpenChat, is TdApi.CloseChat -> TdApi.Ok()
        is TdApi.SendMessage -> sendMessage(f)
        is TdApi.SearchPublicChat -> openByNick(f.username)
        is TdApi.SearchChatsOnServer -> searchNicks(f.query, f.limit)
        is TdApi.SearchPublicChats -> searchNicks(f.query, 20)
        is TdApi.CreatePrivateChat -> store.chatById(f.userId) ?: TdApi.Error(404, "chat not found")
        else -> {
            Log.d(TAG, "не реализовано: ${f.javaClass.simpleName}")
            TdApi.Error(501, "Parvane: не реализовано ${f.javaClass.simpleName}")
        }
    }

    private fun onSessionReady(self: String) {
        store.self = self
        ensurePeer(self, announce = true)
        setAuth(TdApi.AuthorizationStateReady())
    }

    private fun sendMessage(f: TdApi.SendMessage): TdApi.Object {
        val content = f.inputMessageContent as? TdApi.InputMessageText
            ?: return TdApi.Error(400, "Parvane: пока только текст")
        val address = store.addressOf(f.chatId) ?: return TdApi.Error(404, "chat not found")
        val text = content.text?.text ?: ""
        val uuid = ParvaneCore.sendText(address, text)
        if (uuid.isEmpty()) return TdApi.Error(500, "не отправлено (E2E/сеть)")
        // Эхо своего сообщения придёт событием ядра (type=message, out=true) —
        // здесь возвращаем то же сообщение, которое оно создаст (дедуп по uuid).
        val msg = store.putMessage(uuid, store.self, address, System.currentTimeMillis() / 1000, text, out = true)
            ?: return TdApi.Error(500, "дубликат")
        announceMessage(msg)
        return msg
    }

    private fun openByNick(nick: String): TdApi.Object {
        val query = nick.trim().removePrefix("@")
        val users = ParvaneCore.search(query).optJSONArray("users") ?: return TdApi.Error(404, "not found")
        for (i in 0 until users.length()) {
            val u = users.getJSONObject(i)
            val address = u.optString("username")
            if (address.substringBefore('@').equals(query, ignoreCase = true) || address.equals(query, true)) {
                store.setProfile(address, u)
                ensurePeer(address, announce = true)
                return store.chatByAddress(address)!!
            }
        }
        return TdApi.Error(404, "Пользователь @$query не найден")
    }

    private fun searchNicks(query: String, limit: Int): TdApi.Object {
        val users = ParvaneCore.search(query.trim().removePrefix("@")).optJSONArray("users")
        val ids = ArrayList<Long>()
        if (users != null) {
            for (i in 0 until minOf(users.length(), limit)) {
                val u = users.getJSONObject(i)
                val address = u.optString("username")
                if (address.isEmpty() || address == store.self) continue
                store.setProfile(address, u)
                ensurePeer(address, announce = true)
                ids += store.idOf(address)
            }
        }
        return TdApi.Chats(ids.size, ids.toLongArray())
    }

    /** Пир известен → объявить User и Chat (TDLib: updateUser, updateNewChat). */
    private fun ensurePeer(address: String, announce: Boolean) {
        val (user, chat, created) = store.ensurePeer(address)
        if (announce && created) {
            postUpdate(TdApi.UpdateUser(user))
            postUpdate(TdApi.UpdateNewChat(chat))
            if (!store.hasProfile(address)) resolveLater(address)
        }
    }

    private val resolving = ConcurrentHashMap.newKeySet<String>()
    private fun resolveLater(address: String) {
        if (!resolving.add(address)) return
        io.execute {
            try {
                val users = ParvaneCore.resolve(listOf(address)).optJSONArray("users")
                if (users != null) for (i in 0 until users.length()) {
                    val u = users.getJSONObject(i)
                    val a = u.optString("username")
                    if (a.isEmpty()) continue
                    store.setProfile(a, u)
                    val (user, chat, _) = store.ensurePeer(a)
                    postUpdate(TdApi.UpdateUser(user))
                    postUpdate(TdApi.UpdateChatTitle(chat.id, chat.title))
                }
            } finally {
                resolving.remove(address)
            }
        }
    }

    private fun announceMessage(msg: TdApi.Message) {
        val chat = store.chatById(msg.chatId) ?: return
        postUpdate(TdApi.UpdateNewMessage(msg))
        postUpdate(TdApi.UpdateChatLastMessage(chat.id, chat.lastMessage, chat.positions))
        if (!msg.isOutgoing) postUpdate(TdApi.UpdateChatReadInbox(chat.id, chat.lastReadInboxMessageId, chat.unreadCount))
    }

    // ── события ядра ────────────────────────────────────────────────────────
    private fun onCoreEvent(event: JSONObject) {
        when (event.optString("type")) {
            "message" -> {
                val out = event.optBoolean("out")
                val from = event.optString("from")
                val to = event.optString("to")
                val peer = if (out) to else from
                if (peer.isEmpty()) return
                ensurePeer(peer, announce = true)
                val msg = store.putMessage(
                    event.optString("id"), from, to, event.optLong("ts"),
                    event.optString("text"), out, read = event.optBoolean("read"),
                ) ?: return
                announceMessage(msg)
            }
            "read" -> {
                val ids = event.optJSONArray("ids") ?: return
                for (i in 0 until ids.length()) {
                    store.markOutboxRead(ids.getString(i))?.let { postUpdate(it) }
                }
            }
            "session" -> if (event.optString("state") == "failed") {
                Log.w(TAG, "сессия: ${event.optString("error")}")
            }
            "error" -> Log.w(TAG, "ядро: ${event.optString("text")}")
        }
    }
}
