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

    /** Как в TDLib: лог-сообщения ядра (setLogMessageHandler). */
    fun interface LogMessageHandler {
        fun onLogMessage(verbosityLevel: Int, message: String)
    }

    /** Как в TDLib: ошибка синхронного [execute]. */
    class ExecutionException(@JvmField val error: TdApi.Error) : Exception("${error.code}: ${error.message}")

    companion object {
        private const val TAG = "ParvaneClient"
        @Volatile private var logHandler: LogMessageHandler? = null

        @JvmStatic
        fun setLogMessageHandler(@Suppress("UNUSED_PARAMETER") maxVerbosityLevel: Int, handler: LogMessageHandler?) {
            logHandler = handler
        }

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

        /**
         * Синхронные запросы TDLib (execute) — локальные функции без сети:
         * логирование, MIME, разбор текста. Ошибка — [ExecutionException], как в TDLib.
         */
        @JvmStatic
        @Throws(ExecutionException::class)
        @Suppress("UNCHECKED_CAST")
        fun <T : TdApi.Object> execute(query: TdApi.Function<T>): T {
            val result: TdApi.Object = when (query) {
                is TdApi.SetLogVerbosityLevel, is TdApi.SetLogStream, is TdApi.SetLogTagVerbosityLevel -> TdApi.Ok()
                is TdApi.AddLogMessage -> { Log.println(Log.DEBUG, "tdlib", query.text ?: ""); TdApi.Ok() }
                is TdApi.GetOption -> optionValue(query.name)
                is TdApi.GetFileMimeType -> TdApi.Text(
                    android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(
                        query.fileName.substringAfterLast('.', "").lowercase()) ?: "")
                is TdApi.GetFileExtension -> TdApi.Text(
                    android.webkit.MimeTypeMap.getSingleton().getExtensionFromMimeType(query.mimeType) ?: "")
                is TdApi.GetMarkdownText -> query.text ?: TdApi.FormattedText("", arrayOf())
                is TdApi.GetTextEntities -> TdApi.TextEntities(arrayOf())
                is TdApi.ParseTextEntities -> TdApi.FormattedText(query.text ?: "", arrayOf())
                is TdApi.GetLogVerbosityLevel -> TdApi.LogVerbosityLevel(1)
                else -> TdApi.Error(400, "Parvane execute: не поддерживается ${query.javaClass.simpleName}")
            }
            if (result is TdApi.Error) throw ExecutionException(result)
            return result as T
        }

        private const val PARVANE_VERSION = "0.1-parvane"
        private const val TDLIB_VERSION = "1.8.53"

        private fun optionValue(name: String): TdApi.OptionValue = when (name) {
            "version" -> TdApi.OptionValueString(TDLIB_VERSION)
            "commit_hash" -> TdApi.OptionValueString(PARVANE_VERSION)
            "unix_time" -> TdApi.OptionValueInteger(System.currentTimeMillis() / 1000)
            "utc_time_offset" -> TdApi.OptionValueInteger((java.util.TimeZone.getDefault().rawOffset / 1000).toLong())
            "message_text_length_max" -> TdApi.OptionValueInteger(4096)
            "message_caption_length_max" -> TdApi.OptionValueInteger(1024)
            "is_premium", "is_premium_available", "can_ignore_sensitive_content_restrictions",
            "disable_top_chats", "test_mode", "expect_blocking" -> TdApi.OptionValueBoolean(false)
            "localization_target", "language_pack_id" -> TdApi.OptionValueString("android")
            else -> TdApi.OptionValueEmpty()
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
        is TdApi.SetLogVerbosityLevel, is TdApi.SetLogStream, is TdApi.SetLogTagVerbosityLevel,
        is TdApi.AddLogMessage -> TdApi.Ok()
        is TdApi.GetOption -> optionValue(f.name)
        is TdApi.SetOption -> TdApi.Ok()
        is TdApi.GetAuthorizationState -> authState
        // runOnTdlibThread у Telegram X: Ok через timeout секунд на потоке ответов
        is TdApi.SetAlarm -> { if (f.seconds > 0) Thread.sleep((f.seconds * 1000).toLong()); TdApi.Ok() }
        is TdApi.GetProxies -> TdApi.AddedProxies(arrayOf())
        is TdApi.GetApplicationConfig -> TdApi.JsonValueObject(arrayOf())
        is TdApi.GetFileMimeType, is TdApi.GetFileExtension, is TdApi.GetMarkdownText,
        is TdApi.GetTextEntities, is TdApi.ParseTextEntities -> try { execute(f) } catch (e: ExecutionException) { e.error }

        is TdApi.SetTdlibParameters -> {
            // Дев-стенд/эмулятор: gateway из файла (adb push … /data/local/tmp/parvane-gateway),
            // когда extra запуска недоступен (Telegram X)
            java.io.File("/data/local/tmp/parvane-gateway").takeIf { it.canRead() }
                ?.readText()?.trim()?.takeIf { it.isNotEmpty() }?.let { gatewayUrl = it }
            ParvaneCore.init(gatewayUrl, f.databaseDirectory)
            // Telegram X ждёт версию/хэш опциями сразу после параметров
            postUpdate(TdApi.UpdateOption("version", TdApi.OptionValueString(TDLIB_VERSION)))
            postUpdate(TdApi.UpdateOption("commit_hash", TdApi.OptionValueString(PARVANE_VERSION)))
            postUpdate(TdApi.UpdateConnectionState(TdApi.ConnectionStateReady()))
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
            // Неизвестная функция: если TDLib отвечала бы Ok (сеттеры/уведомления
            // о состоянии) — Ok, UI не спотыкается; запросы данных — ошибка 501
            if (resultTypeOf(f) == TdApi.Ok::class.java) {
                Log.d(TAG, "ok-заглушка: ${f.javaClass.simpleName}")
                TdApi.Ok()
            } else {
                Log.d(TAG, "не реализовано: ${f.javaClass.simpleName}")
                TdApi.Error(501, "Parvane: не реализовано ${f.javaClass.simpleName}")
            }
        }
    }

    /** Тип результата функции TdApi по generic-предку (Function<R>). */
    private fun resultTypeOf(f: TdApi.Function<*>): Class<*>? {
        val t = f.javaClass.genericSuperclass as? java.lang.reflect.ParameterizedType ?: return null
        return t.actualTypeArguments.firstOrNull() as? Class<*>
    }

    private fun onSessionReady(self: String) {
        store.self = self
        ensurePeer(self, announce = true)
        postUpdate(TdApi.UpdateOption("my_id", TdApi.OptionValueInteger(store.idOf(self))))
        postUpdate(TdApi.UpdateOption("authorization_date", TdApi.OptionValueInteger(System.currentTimeMillis() / 1000)))
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
