package org.drinkless.tdlib

import android.util.Log
import org.json.JSONArray
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

        // Ядро (ParvaneCore) — глобальный синглтон, а Telegram X заводит НЕСКОЛЬКО
        // Client'ов: основной аккаунт и служебный (Tdlib.Mode.SERVICE, свой
        // каталог tdlib1) для SaveApplicationLogEvent/крашей. Раньше каждый
        // SetTdlibParameters переинициализировал ядро на новый каталог и ломал
        // сессию основного аккаунта (10 сен 2026). Ядро привязано к первому
        // Client'у; остальные — «отсоединённые»: Ok на параметры, соединение
        // готово, авторизации нет, ядро не трогают.
        @Volatile private var boundClient: Client? = null
        @Volatile private var boundDir: String = ""

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
                // Языковой пак «ru» — это наши ресурсы values-ru (см. tgx-overlay/gen-ru.py);
                // встроенный пак X (language_code из ресурсов) сюда не приходит. Иначе 404 → встроенная строка.
                is TdApi.GetLanguagePackString -> packString(query.languagePackId, query.key) ?: TdApi.Error(404, "Not Found")
                else -> TdApi.Error(400, "Parvane execute: не поддерживается ${query.javaClass.simpleName}")
            }
            if (result is TdApi.Error) throw ExecutionException(result)
            return result as T
        }

        // ── языковые паки: единственный «облачный» пак — ru из ресурсов приложения ──
        private const val RU_PACK = "ru"
        @Volatile private var languagePackId = ""
        private fun appContext(): android.content.Context? = try {
            val at = Class.forName("android.app.ActivityThread")
            at.getMethod("currentApplication").invoke(null) as? android.content.Context
        } catch (e: Throwable) { null }
        private fun localized(lang: String): android.content.res.Resources? {
            val ctx = appContext() ?: return null
            val conf = android.content.res.Configuration(ctx.resources.configuration)
            conf.setLocale(java.util.Locale(lang))
            return ctx.createConfigurationContext(conf).resources
        }
        private fun resString(res: android.content.res.Resources, key: String): String? {
            val id = res.getIdentifier(key, "string", appContext()?.packageName ?: return null)
            return if (id == 0) null else res.getString(id)
        }
        /** Строка пака: обычная или плюрал (X спрашивает по базовому ключу → one/few/many/other). */
        fun packString(packId: String, key: String): TdApi.LanguagePackStringValue? {
            if (packId != RU_PACK) return null
            val res = localized(RU_PACK) ?: return null
            // Сначала плюрал: у X базовый ключ плюрала существует и как обычный ресурс
            // (R.string.xChats для Lang.plural), а ответ Ordinary на плюрал-запрос роняет
            // debug-сборку («Expected stringPluralized», 11 сен 2026).
            resString(res, key + "_other")?.let { other ->
                return TdApi.LanguagePackStringValuePluralized(
                    "", resString(res, key + "_one") ?: other, "", resString(res, key + "_few") ?: other,
                    resString(res, key + "_many") ?: other, other)
            }
            return resString(res, key)?.let { TdApi.LanguagePackStringValueOrdinary(it) }
        }
        fun ruPackInfo(): TdApi.LanguagePackInfo = TdApi.LanguagePackInfo(
            RU_PACK, "", "Russian", "Русский", "ru", true, false, false, true, 5322, 1900, 1900, "")
        /** Все ключи, у которых есть русское значение (для «просмотра строк» и синхронизации пака). */
        fun ruPackStrings(keys: Array<String>?): TdApi.LanguagePackStrings {
            val ctx = appContext() ?: return TdApi.LanguagePackStrings(arrayOf())
            val names: List<String> = if (keys != null && keys.isNotEmpty()) keys.toList() else try {
                Class.forName(ctx.packageName.let { "org.thunderdog.challegram.R\$string" }).fields.map { it.name }
            } catch (e: Throwable) { emptyList() }
            val out = ArrayList<TdApi.LanguagePackString>()
            for (n in names) packString(RU_PACK, n)?.let { out += TdApi.LanguagePackString(n, it) }
            return TdApi.LanguagePackStrings(out.toTypedArray())
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
            "localization_target" -> TdApi.OptionValueString("android")
            "language_pack_id" -> TdApi.OptionValueString(languagePackId)
            else -> TdApi.OptionValueEmpty()
        }
    }

    // Один поток на ответы/апдейты (как поток апдейтов TDLib) + IO для ядра.
    private val handlerThread = Executors.newSingleThreadExecutor { r -> Thread(r, "parvane-updates") }
    // Фиксированный пул: cached-пул плодил по потоку на каждый резолв/скачивание (память на 16 ГБ-эмуляторе и телефоне)
    private val io = Executors.newFixedThreadPool(4) { r -> Thread(r, "parvane-io") }
    private val store = ParvaneStore()

    @Volatile private var authState: TdApi.AuthorizationState = TdApi.AuthorizationStateWaitTdlibParameters()
    @Volatile private var pendingNick: String = ""
    @Volatile private var closed = false
    @Volatile private var detached = false // второй Client X (служебный аккаунт) — без ядра

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
        if (boundClient === this) boundClient = null
        setAuth(TdApi.AuthorizationStateClosed())
    }

    private fun postUpdate(update: TdApi.Update) {
        val h = updateHandler ?: run { Log.w(TAG, "апдейт ${update.javaClass.simpleName} до подписки X — потерян"); return }
        if (update is TdApi.UpdateNewChat || update is TdApi.UpdateChatLastMessage || update is TdApi.UpdateChatPosition)
            Log.d(TAG, "→ X ${update.javaClass.simpleName}")
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
        is TdApi.SetOption -> { // language_pack_id — единственная опция с состоянием (выбор языка в Settings → Language)
            if (f.name == "language_pack_id") languagePackId = (f.value as? TdApi.OptionValueString)?.value ?: ""
            TdApi.Ok()
        }
        is TdApi.GetLocalizationTargetInfo -> TdApi.LocalizationTargetInfo(arrayOf(ruPackInfo()))
        is TdApi.GetLanguagePackInfo -> if (f.languagePackId == RU_PACK) ruPackInfo() else TdApi.Error(404, "Not Found")
        is TdApi.GetLanguagePackStrings -> if (f.languagePackId == RU_PACK) ruPackStrings(f.keys) else TdApi.LanguagePackStrings(arrayOf())
        is TdApi.SynchronizeLanguagePack, is TdApi.SetCustomLanguagePack, is TdApi.SetCustomLanguagePackString,
        is TdApi.EditCustomLanguagePackInfo, is TdApi.AddCustomServerLanguagePack, is TdApi.DeleteLanguagePack -> TdApi.Ok()
        is TdApi.GetAuthorizationState -> authState
        // runOnTdlibThread у Telegram X: Ok через timeout секунд на потоке ответов
        is TdApi.SetAlarm -> { if (f.seconds > 0) Thread.sleep((f.seconds * 1000).toLong()); TdApi.Ok() }
        is TdApi.GetProxies -> TdApi.AddedProxies(arrayOf())
        is TdApi.GetApplicationConfig -> TdApi.JsonValueObject(arrayOf())
        is TdApi.GetFileMimeType, is TdApi.GetFileExtension, is TdApi.GetMarkdownText,
        is TdApi.GetTextEntities, is TdApi.ParseTextEntities -> try { execute(f) } catch (e: ExecutionException) { e.error }

        is TdApi.SetTdlibParameters -> {
            // Telegram X ждёт версию/хэш опциями сразу после параметров
            postUpdate(TdApi.UpdateOption("version", TdApi.OptionValueString(TDLIB_VERSION)))
            postUpdate(TdApi.UpdateOption("commit_hash", TdApi.OptionValueString(PARVANE_VERSION)))
            postUpdate(TdApi.UpdateConnectionState(TdApi.ConnectionStateReady()))
            val owner = boundClient
            if (owner != null && owner !== this && boundDir != f.databaseDirectory) {
                detached = true
                ParvaneCore.removeListener(coreListener)
                Log.i(TAG, "второй Client (${f.databaseDirectory}) — отсоединён от ядра")
                setAuth(TdApi.AuthorizationStateWaitPhoneNumber())
            } else {
                boundClient = this
                boundDir = f.databaseDirectory
                // Дев-стенд/эмулятор: gateway из файла (adb push … /data/local/tmp/parvane-gateway),
                // когда extra запуска недоступен (Telegram X)
                java.io.File("/data/local/tmp/parvane-gateway").takeIf { it.canRead() }
                    ?.readText()?.trim()?.takeIf { it.isNotEmpty() }?.let { gatewayUrl = it }
                ParvaneCore.init(gatewayUrl, f.databaseDirectory)
                if (ParvaneCore.self().isNotEmpty() && ParvaneCore.startSession()) {
                    onSessionReady(ParvaneCore.self())
                } else {
                    setAuth(TdApi.AuthorizationStateWaitPhoneNumber())
                }
            }
            TdApi.Ok()
        }
        is TdApi.SetAuthenticationPhoneNumber -> if (detached) TdApi.Error(400, "Parvane: второй аккаунт не поддерживается") else {
            // Поле «номер телефона» экрана TDLib = ник Parvane
            pendingNick = (f.phoneNumber ?: "").trim().removePrefix("@")
            if (pendingNick.isEmpty()) {
                TdApi.Error(400, "Введите ник")
            } else {
                setAuth(TdApi.AuthorizationStateWaitPassword("", false, false, ""))
                TdApi.Ok()
            }
        }
        is TdApi.CheckAuthenticationPassword -> {
            val r = ParvaneCore.login(pendingNick, f.password ?: "")
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
            if (!detached) ParvaneCore.logout()
            store.clear()
            announcedChats.clear()
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
        is TdApi.GetBasicGroup -> store.groupByBasicId(f.basicGroupId)?.let { store.basicGroup(it) } ?: TdApi.Error(404, "group not found")
        is TdApi.GetBasicGroupFullInfo -> store.groupByBasicId(f.basicGroupId)?.let { store.basicGroupFullInfo(it) } ?: TdApi.Error(404, "group not found")
        is TdApi.GetChatMember -> {
            val g = store.groupByChat(f.chatId)
            val uid = (f.memberId as? TdApi.MessageSenderUser)?.userId
            val addr = uid?.let { store.addressOf(it) }
            if (g != null && addr != null) store.chatMember(g, addr) else TdApi.Error(404, "member not found")
        }
        is TdApi.CreateNewBasicGroupChat -> createGroup(f)
        is TdApi.AddChatMember -> groupAction(f.chatId, "add", store.addressOf(f.userId) ?: "")?.let { TdApi.FailedToAddMembers(arrayOf()) } ?: TdApi.Error(500, "не добавлен")
        is TdApi.SetChatTitle -> if (store.groupByChat(f.chatId) != null) (groupAction(f.chatId, "rename", f.title ?: "")?.let { TdApi.Ok() } ?: TdApi.Error(500, "не переименована")) else TdApi.Ok()
        is TdApi.LeaveChat -> if (store.groupByChat(f.chatId) != null) (groupAction(f.chatId, "leave", "")?.let { TdApi.Ok() } ?: TdApi.Error(500, "не вышли")) else TdApi.Ok()
        is TdApi.GetChat -> store.chatById(f.chatId)?.copyForUi() ?: TdApi.Error(404, "chat not found")
        is TdApi.LoadChats -> {
            // Первый запрос списка = X готов принимать чаты: реплей журнала истории
            // (апдейты встанут в очередь ДО ответа 404). Все чаты объявляются
            // апдейтами; TDLib возвращает 404, когда список исчерпан — UI на это и рассчитывает
            replayJournalOnce()
            TdApi.Error(404, "Not Found")
        }
        is TdApi.GetChats -> { replayJournalOnce(); TdApi.Chats(store.chatIds().size, store.chatIds().take(f.limit).toLongArray()) }
        is TdApi.GetChatHistory -> store.history(f.chatId, f.fromMessageId, f.offset, f.limit)
        is TdApi.ViewMessages -> {
            f.messageIds.forEach { id -> store.uuidOf(f.chatId, id)?.let { ParvaneCore.markRead(it) } }
            store.markInboxRead(f.chatId, f.messageIds.maxOrNull() ?: 0)?.let { postUpdate(it) }
            TdApi.Ok()
        }
        is TdApi.OpenChat, is TdApi.CloseChat -> TdApi.Ok()
        is TdApi.SendMessage -> sendMessage(f)
        is TdApi.GetMessage -> messageOf(f.chatId, f.messageId)
        is TdApi.GetMessageLocally -> messageOf(f.chatId, f.messageId)
        is TdApi.GetFile -> store.fileRef(f.fileId)?.let { store.tdFile(it) } ?: TdApi.Error(404, "file not found")
        is TdApi.DownloadFile -> downloadFile(f.fileId, f.synchronous)
        is TdApi.SendChatAction -> {
            if (f.action is TdApi.ChatActionTyping) store.addressOf(f.chatId)?.let { ParvaneCore.sendTyping(it) }
            TdApi.Ok()
        }
        is TdApi.EditMessageText -> editMessage(f)
        is TdApi.DeleteMessages -> {
            val uuids = f.messageIds.toList().mapNotNull { id -> store.uuidOf(f.chatId, id) }
            uuids.forEach { ParvaneCore.delete(it) }
            store.removeMessages(uuids).forEach { postUpdate(it) }
            TdApi.Ok()
        }
        // повтор той же реакции = снять (как на десктопе/вебе)
        is TdApi.AddMessageReaction -> react(f.chatId, f.messageId, f.reactionType)
        is TdApi.RemoveMessageReaction -> react(f.chatId, f.messageId, f.reactionType)
        is TdApi.PinChatMessage -> { store.uuidOf(f.chatId, f.messageId)?.let { ParvaneCore.pin(it, true) }; TdApi.Ok() }
        // уведомления: локально + блоб на сервер (кросс-девайс, как веб/десктоп)
        is TdApi.SetChatNotificationSettings -> {
            val address = store.addressOf(f.chatId)
            if (address == null) TdApi.Error(404, "chat not found") else {
                val n = f.notificationSettings
                val blob = store.setChatMute(address, if (n == null || n.useDefaultMuteFor) 0 else n.muteFor)
                postUpdate(TdApi.UpdateChatNotificationSettings(f.chatId, store.chatNotifySettings(address)))
                io.execute { ParvaneCore.setNotify(blob) }
                TdApi.Ok()
            }
        }
        is TdApi.GetScopeNotificationSettings -> store.scopeSettings(scopeKey(f.scope))
        is TdApi.SetScopeNotificationSettings -> {
            val blob = store.setScopeMute(scopeKey(f.scope), f.notificationSettings?.muteFor ?: 0)
            postUpdate(TdApi.UpdateScopeNotificationSettings(f.scope, store.scopeSettings(scopeKey(f.scope))))
            io.execute { ParvaneCore.setNotify(blob) }
            TdApi.Ok()
        }
        // профиль → identity (display_name обязателен; остальное — что прислали)
        is TdApi.SetName -> setProfile(JSONObject().put("display_name", listOf(f.firstName ?: "", f.lastName ?: "").joinToString(" ").trim()))
        is TdApi.SetBio -> setProfile(JSONObject().put("bio", f.bio ?: ""))
        is TdApi.SetProfilePhoto -> {
            val path = ((f.photo as? TdApi.InputChatPhotoStatic)?.photo)?.let { localPath(it) }
            if (path == null) TdApi.Error(400, "нет файла") else {
                val fid = ParvaneCore.setAvatar(path)
                if (fid.isEmpty()) TdApi.Error(500, "аватар не загружен") else {
                    store.setUserPhoto(store.self, fid, path)?.let { (u, _) -> postUpdate(TdApi.UpdateUser(u)) }
                    TdApi.Ok()
                }
            }
        }
        is TdApi.UnpinChatMessage -> { store.uuidOf(f.chatId, f.messageId)?.let { ParvaneCore.pin(it, false) }; TdApi.Ok() }
        is TdApi.SearchPublicChat -> openByNick(f.username ?: "")
        is TdApi.SearchChatsOnServer -> searchNicks(f.query ?: "", f.limit)
        is TdApi.SearchPublicChats -> searchNicks(f.query ?: "", 20)
        is TdApi.CreatePrivateChat -> store.chatById(f.userId) ?: TdApi.Error(404, "chat not found")
        // Telegram X спрашивает при старте — честные пустые ответы вместо 501,
        // чтобы не плодить ошибки в логе и не ломать экраны
        is TdApi.GetTopChats -> TdApi.Chats(0, LongArray(0))
        is TdApi.SearchChats -> { // локальный поиск по названию (как TDLib по кэшу)
            val q = (f.query ?: "").trim().removePrefix("@").lowercase()
            val ids = store.chatIds().filter { id ->
                q.isEmpty() || (store.chatById(id)?.title ?: "").lowercase().contains(q)
                    || (store.addressOf(id) ?: "").lowercase().contains(q)
            }.take(if (f.limit > 0) f.limit else 20)
            TdApi.Chats(ids.size, ids.toLongArray())
        }
        is TdApi.SearchContacts -> TdApi.Users(0, LongArray(0))
        is TdApi.SearchCallMessages -> TdApi.FoundMessages(0, arrayOf(), "")
        is TdApi.GetCountryCode -> TdApi.Text("")
        is TdApi.GetActiveSessions -> TdApi.Sessions(arrayOf(), 0)
        is TdApi.SearchBackground, is TdApi.SearchStickerSet, is TdApi.GetEmojiReaction,
        is TdApi.GetMapThumbnailFile -> TdApi.Error(404, "Not Found") // карта в пузыре гео — как на десктопе, нет
        // Открытый чат: X спрашивает счётчики/локации/админов/полный профиль
        is TdApi.GetChatMessageCount -> TdApi.Count(store.history(f.chatId, 0, 0, Int.MAX_VALUE).messages.count { matchesFilter(it, f.filter) })
        is TdApi.SearchChatMessages -> { // локальный поиск по истории чата: текст + фильтр (медиа/файлы/ссылки/закреп — вкладки профиля)
            val q = (f.query ?: "").trim().lowercase() // X шлёт null (Java)
            val all = store.history(f.chatId, 0, 0, Int.MAX_VALUE).messages
                .filter { m -> matchesFilter(m, f.filter) && (q.isEmpty() || messageText(m).lowercase().contains(q)) }
            val from = if (f.fromMessageId == 0L) all else all.filter { it.id < f.fromMessageId } // страницы: от новых к старым
            val found = from.take(if (f.limit > 0) f.limit else 50).toTypedArray()
            TdApi.FoundChatMessages(all.size, found, found.lastOrNull()?.id ?: 0L)
        }
        is TdApi.SearchChatRecentLocationMessages -> TdApi.Messages(0, arrayOf())
        is TdApi.GetChatAdministrators -> TdApi.ChatAdministrators(arrayOf())
        is TdApi.GetUserFullInfo -> {
            val address = store.addressOf(f.userId)
            if (address == null) TdApi.Error(404, "user not found") else {
                val info = TdApi.UserFullInfo().apply {
                    canBeCalled = false // звонков на Android пока нет — кнопка звонка в шапке не показывается
                    supportsVideoCalls = false
                    bio = TdApi.FormattedText(store.profileField(address, "bio"), arrayOf())
                    blockList = if (store.blocked.contains(address)) TdApi.BlockListMain() else null
                    giftSettings = null
                }
                // X (TdlibCache) игнорирует ответ и ждёт updateUserFullInfo, как от TDLib — иначе «Loading information…»
                postUpdate(TdApi.UpdateUserFullInfo(f.userId, info))
                info
            }
        }
        // стикеры/GIF/эмодзи-статусы: пустые наборы вместо ошибки 501 (X показывал тост «не реализовано»)
        is TdApi.GetInstalledStickerSets, is TdApi.GetArchivedStickerSets -> TdApi.StickerSets(0, arrayOf())
        is TdApi.GetTrendingStickerSets -> TdApi.TrendingStickerSets(0, arrayOf(), false)
        is TdApi.GetRecentStickers, is TdApi.GetFavoriteStickers, is TdApi.GetStickers -> TdApi.Stickers(arrayOf())
        is TdApi.GetSavedAnimations -> TdApi.Animations(arrayOf())
        is TdApi.GetInstalledBackgrounds -> TdApi.Backgrounds(arrayOf()) // фоны чата: только встроенные в X
        // Settings → Data and Storage: честные цифры по каталогу медиа/кэша ядра; сетевой статистики ядро не ведёт
        is TdApi.GetStorageStatisticsFast -> storageFast()
        is TdApi.GetStorageStatistics -> storageFast().let { TdApi.StorageStatistics(it.filesSize, it.fileCount, arrayOf()) }
        is TdApi.OptimizeStorage -> { clearMediaCache(); storageFast().let { TdApi.StorageStatistics(it.filesSize, it.fileCount, arrayOf()) } }
        is TdApi.GetDatabaseStatistics -> TdApi.DatabaseStatistics("")
        is TdApi.GetNetworkStatistics -> TdApi.NetworkStatistics((System.currentTimeMillis() / 1000).toInt(), arrayOf())
        is TdApi.ResetNetworkStatistics, is TdApi.AddNetworkStatistics -> TdApi.Ok()
        is TdApi.GetBotSimilarBotCount, is TdApi.GetChatSimilarChatCount -> TdApi.Count(0) // «похожие боты/каналы» — вне скоупа
        is TdApi.GetRecentEmojiStatuses -> TdApi.EmojiStatuses(arrayOf())
        is TdApi.GetContacts -> TdApi.Users(store.knownUserIds().size, store.knownUserIds())
        is TdApi.SetMessageSenderBlockList -> { // локальный чёрный список (как в вебе): входящие от него не показываем
            val uid = (f.senderId as? TdApi.MessageSenderUser)?.userId
            val address = uid?.let { store.addressOf(it) }
            if (address != null) { if (f.blockList == null) store.blocked.remove(address) else store.blocked.add(address) }
            TdApi.Ok()
        }
        is TdApi.DeleteChatHistory -> { // «для меня»: скрыть на сервере (msg.chat.clear) и убрать локально
            val uuids = store.uuidsOfChat(f.chatId)
            if (uuids.isNotEmpty()) io.execute { ParvaneCore.clearMessages(uuids) }
            (if (f.removeFromChatList) store.removeChat(f.chatId) else store.removeMessages(uuids)).forEach { postUpdate(it) }
            TdApi.Ok()
        }
        is TdApi.DeleteChat -> {
            val uuids = store.uuidsOfChat(f.chatId)
            if (uuids.isNotEmpty()) io.execute { ParvaneCore.clearMessages(uuids) }
            store.removeChat(f.chatId).forEach { postUpdate(it) }
            TdApi.Ok()
        }
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
        // Порядок как у TDLib: my_id → Ready → и только потом updateNewChat/
        // updateUser. Telegram X на переходе в Ready сбрасывает состояние, и
        // объявленный раньше чат терялся: следующий updateChatTitle падал с
        // «updateChat not received for id» (10 сен 2026). Пользователь в сторе
        // нужен до my_id — X сразу спрашивает GetUser(my_id).
        store.ensurePeer(self)
        postUpdate(TdApi.UpdateOption("my_id", TdApi.OptionValueInteger(store.idOf(self))))
        postUpdate(TdApi.UpdateOption("authorization_date", TdApi.OptionValueInteger(System.currentTimeMillis() / 1000)))
        setAuth(TdApi.AuthorizationStateReady())
        ensurePeer(self, announce = true)
        // X ждёт updateScopeNotificationSettings, как от TDLib, — иначе в Settings → Notifications
        // у «Личные чаты/Группы/Каналы» вечное «Загрузка…» (11 сен 2026)
        for (scope in listOf<TdApi.NotificationSettingsScope>(TdApi.NotificationSettingsScopePrivateChats(),
                TdApi.NotificationSettingsScopeGroupChats(), TdApi.NotificationSettingsScopeChannelChats()))
            postUpdate(TdApi.UpdateScopeNotificationSettings(scope, store.scopeSettings(scopeKey(scope))))
        io.execute { syncGroups() }
    }

    /** Группы с сервера → basic group + чат в UI (idempotent). */
    private fun syncGroups() {
        val arr = try { ParvaneCore.listGroups() } catch (e: Throwable) { Log.w(TAG, "группы: ${e.message}"); return }
        for (i in 0 until arr.length()) {
            val g = arr.getJSONObject(i)
            val mem = g.optJSONArray("members")
            val members = ArrayList<String>()
            if (mem != null) for (j in 0 until mem.length()) members += mem.getJSONObject(j).optString("address")
            members.forEach { ensurePeer(it, announce = true) } // участники — пользователи для UI
            val (chat, basic, created) = store.ensureGroup(g.optString("group_id"), g.optString("name"), members, g.optString("created_by"))
            postUpdate(TdApi.UpdateBasicGroup(basic))
            if (created && announcedChats.add(chat.id)) postUpdate(TdApi.UpdateNewChat(chat.copyForUi()))
            else postUpdate(TdApi.UpdateChatTitle(chat.id, chat.title))
        }
    }

    private fun createGroup(f: TdApi.CreateNewBasicGroupChat): TdApi.Object {
        val members = f.userIds.toList().mapNotNull { store.addressOf(it) }
        val gid = ParvaneCore.createGroup(f.title ?: "", "group", members)
        if (gid.isEmpty()) return TdApi.Error(500, "группа не создана")
        syncGroups()
        val g = store.group(gid) ?: return TdApi.Error(500, "группа не найдена после создания")
        return TdApi.CreatedBasicGroupChat(g.chatId, TdApi.FailedToAddMembers(arrayOf()))
    }

    /** null — ошибка (в логе), иначе "" */
    private fun groupAction(chatId: Long, action: String, arg: String): String? {
        val g = store.groupByChat(chatId) ?: return null
        val err = ParvaneCore.groupAction(g.gid, action, arg)
        if (err.isNotEmpty()) { Log.w(TAG, "группа $action: $err"); return null }
        syncGroups()
        return ""
    }

    private fun scopeKey(scope: TdApi.NotificationSettingsScope?): String = when (scope) {
        is TdApi.NotificationSettingsScopeGroupChats -> "groups"
        is TdApi.NotificationSettingsScopeChannelChats -> "channels"
        else -> "users"
    }

    private fun setProfile(fields: JSONObject): TdApi.Object {
        if (!fields.has("display_name")) {
            val me = store.user(store.self)
            fields.put("display_name", me?.firstName ?: store.self.substringBefore('@'))
        }
        if (!ParvaneCore.setProfile(fields.toString())) return TdApi.Error(500, "профиль не сохранён")
        val p = store.profileJson(store.self)
        fields.keys().forEach { k -> p.put(k, fields.get(k)) }
        p.put("username", store.self)
        store.setProfile(store.self, p)
        val (user, chat, _) = store.ensurePeer(store.self)
        postUpdate(TdApi.UpdateUser(user)); postUpdate(TdApi.UpdateChatTitle(chat.id, chat.title))
        return TdApi.Ok()
    }

    private fun messageOf(chatId: Long, msgId: Long): TdApi.Object =
        store.uuidOf(chatId, msgId)?.let { store.messageByUuid(it) } ?: TdApi.Error(404, "message not found")

    private fun react(chatId: Long, msgId: Long, type: TdApi.ReactionType?): TdApi.Object {
        val uuid = store.uuidOf(chatId, msgId) ?: return TdApi.Error(404, "message not found")
        val emoji = (type as? TdApi.ReactionTypeEmoji)?.emoji ?: return TdApi.Error(400, "только эмодзи")
        ParvaneCore.react(uuid, emoji)
        return TdApi.Ok()
    }

    private fun editMessage(f: TdApi.EditMessageText): TdApi.Object {
        val uuid = store.uuidOf(f.chatId, f.messageId) ?: return TdApi.Error(404, "message not found")
        val address = store.addressOf(f.chatId) ?: return TdApi.Error(404, "chat not found")
        val text = (f.inputMessageContent as? TdApi.InputMessageText)?.text?.text ?: ""
        val content = JSONObject().put("kind", "text").put("text", text)
        if (!ParvaneCore.edit(uuid, address, content.toString())) return TdApi.Error(500, "правка не удалась")
        store.applyEdit(uuid, content, System.currentTimeMillis() / 1000).forEach { postUpdate(it) }
        return store.messageByUuid(uuid) ?: TdApi.Error(404, "message not found")
    }

    private fun localPath(input: TdApi.InputFile?): String? = when (input) {
        is TdApi.InputFileLocal -> input.path
        is TdApi.InputFileGenerated -> input.originalPath // X сжимает фото генерацией — берём оригинал
        else -> null
    }

    private fun sendMessage(f: TdApi.SendMessage): TdApi.Object {
        val address = store.addressOf(f.chatId) ?: return TdApi.Error(404, "chat not found")
        val replyUuid = (f.replyTo as? TdApi.InputMessageReplyToMessage)?.let { store.uuidOf(f.chatId, it.messageId) } ?: ""
        val c = f.inputMessageContent
        fun cap(t: TdApi.FormattedText?): String = t?.text ?: ""
        val uuid: String
        var echoContent: JSONObject? = null
        when (c) {
            is TdApi.InputMessageText -> {
                val content = JSONObject().put("kind", "text").put("text", c.text?.text ?: "")
                echoContent = content
                uuid = ParvaneCore.sendContent(address, content.toString(), replyUuid)
            }
            is TdApi.InputMessageLocation -> { // как десктоп/веб: {kind:location, lat, long}
                val content = JSONObject().put("kind", "location").put("lat", c.location?.latitude ?: 0.0).put("long", c.location?.longitude ?: 0.0)
                echoContent = content
                uuid = ParvaneCore.sendContent(address, content.toString(), replyUuid)
            }
            is TdApi.InputMessageContact -> { // телефонных контактов нет — делимся ником текстом
                val uidAddr = c.contact?.userId?.let { store.addressOf(it) }
                val content = JSONObject().put("kind", "text").put("text", uidAddr?.let { "@" + it.substringBefore('@') } ?: (c.contact?.firstName ?: ""))
                echoContent = content
                uuid = ParvaneCore.sendContent(address, content.toString(), replyUuid)
            }
            is TdApi.InputMessagePhoto -> uuid = ParvaneCore.sendMedia(address, localPath(c.photo?.photo) ?: return TdApi.Error(400, "нет файла"),
                JSONObject().put("kind", "photo").put("mime", "image/jpeg").put("width", c.photo.width).put("height", c.photo.height).put("caption", cap(c.caption)).toString(), replyUuid)
            is TdApi.InputMessageVideo -> uuid = ParvaneCore.sendMedia(address, localPath(c.video?.video) ?: return TdApi.Error(400, "нет файла"),
                JSONObject().put("kind", "video").put("mime", "video/mp4").put("width", c.video.width).put("height", c.video.height).put("duration_secs", c.video.duration).put("caption", cap(c.caption)).toString(), replyUuid)
            is TdApi.InputMessageDocument -> {
                val path = localPath(c.document?.document) ?: return TdApi.Error(400, "нет файла")
                val name = path.substringAfterLast('/')
                val mime = android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase()) ?: "application/octet-stream"
                uuid = ParvaneCore.sendMedia(address, path, JSONObject().put("kind", "file").put("mime", mime).put("filename", name).put("caption", cap(c.caption)).toString(), replyUuid)
            }
            is TdApi.InputMessageVoiceNote -> uuid = ParvaneCore.sendMedia(address, localPath(c.voiceNote?.voiceNote) ?: return TdApi.Error(400, "нет файла"),
                JSONObject().put("kind", "voice").put("mime", "audio/ogg").put("duration_secs", c.voiceNote.duration).put("caption", cap(c.caption)).toString(), replyUuid)
            is TdApi.InputMessageVideoNote -> uuid = ParvaneCore.sendMedia(address, localPath(c.videoNote?.videoNote) ?: return TdApi.Error(400, "нет файла"),
                JSONObject().put("kind", "video_note").put("mime", "video/mp4").put("duration_secs", c.videoNote.duration).put("width", c.videoNote.length).toString(), replyUuid)
            else -> return TdApi.Error(400, "Parvane: тип сообщения не поддерживается ${c?.javaClass?.simpleName}")
        }
        if (uuid.isEmpty()) return TdApi.Error(500, "не отправлено (E2E/сеть)")
        // Медиа: эхо со всеми полями (file_id, local_path) эмитит ядро само; текст
        // кладём здесь. При дубликате возвращаем уже сохранённое (X иначе не
        // очищал поле и показывал тост «#500: дубликат», 10 сен 2026).
        if (echoContent != null) {
            val msg = store.putMessage(uuid, store.self, address, System.currentTimeMillis() / 1000, echoContent, out = true,
                replyUuid = replyUuid.ifEmpty { null })
            if (msg != null) {
                announceMessage(msg)
                return msg
            }
        }
        // эхо ядра могло ещё не прийти (медиа) — ждём немного
        for (i in 0 until 50) {
            store.messageByUuid(uuid)?.let { return it }
            Thread.sleep(100)
        }
        return TdApi.Error(500, "сообщение не сохранено")
    }

    /** DownloadFile: блоб из cloud (io), UpdateFile по готовности. */
    private val downloading = ConcurrentHashMap.newKeySet<Int>()
    private fun downloadFile(fileId: Int, synchronous: Boolean): TdApi.Object {
        val ref = store.fileRef(fileId) ?: return TdApi.Error(404, "file not found")
        if (ref.path.isNotEmpty()) return store.tdFile(ref)
        val job = Runnable {
            try {
                val path = ParvaneCore.downloadFile(ref.remoteId, ref.key, ref.nonce)
                if (path.isNotEmpty()) store.setFilePath(fileId, path)?.let { postUpdate(TdApi.UpdateFile(it)) }
            } finally {
                downloading.remove(fileId)
            }
        }
        if (synchronous) {
            if (downloading.add(fileId)) job.run()
            return store.tdFile(ref)
        }
        if (downloading.add(fileId)) io.execute(job)
        return store.tdFile(ref)
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

    /** Чаты, о которых UI уже получил updateNewChat (апдейты по чату — только после него). */
    private val announcedChats = ConcurrentHashMap.newKeySet<Long>()
    private val journalReplayed = java.util.concurrent.atomic.AtomicBoolean(false)

    private fun messageText(m: TdApi.Message): String = when (val c = m.content) {
        is TdApi.MessageText -> c.text.text
        is TdApi.MessagePhoto -> c.caption.text
        is TdApi.MessageVideo -> c.caption.text
        is TdApi.MessageDocument -> c.caption.text + " " + c.document.fileName
        is TdApi.MessageVoiceNote -> c.caption.text
        else -> ""
    }
    /** Фильтры SearchChatMessages/GetChatMessageCount как у TDLib: по типу контента из стора. */
    private fun matchesFilter(m: TdApi.Message, filter: TdApi.SearchMessagesFilter?): Boolean = when (filter) {
        null, is TdApi.SearchMessagesFilterEmpty -> true
        is TdApi.SearchMessagesFilterPhoto -> m.content is TdApi.MessagePhoto
        is TdApi.SearchMessagesFilterVideo -> m.content is TdApi.MessageVideo
        is TdApi.SearchMessagesFilterPhotoAndVideo -> m.content is TdApi.MessagePhoto || m.content is TdApi.MessageVideo
        is TdApi.SearchMessagesFilterDocument -> m.content is TdApi.MessageDocument
        is TdApi.SearchMessagesFilterVoiceNote -> m.content is TdApi.MessageVoiceNote
        is TdApi.SearchMessagesFilterVideoNote -> m.content is TdApi.MessageVideoNote
        is TdApi.SearchMessagesFilterVoiceAndVideoNote -> m.content is TdApi.MessageVoiceNote || m.content is TdApi.MessageVideoNote
        is TdApi.SearchMessagesFilterUrl -> messageText(m).contains(Regex("https?://|www\\.", RegexOption.IGNORE_CASE))
        is TdApi.SearchMessagesFilterPinned -> m.isPinned
        is TdApi.SearchMessagesFilterUnreadMention, is TdApi.SearchMessagesFilterMention,
        is TdApi.SearchMessagesFilterUnreadReaction -> false
        else -> false // audio, animation, chat photo, failed to send — таких у нас нет
    }

    /** Каталог ядра (`boundDir`): медиа — подкаталог media, база — dec-cache/journal/cursors. */
    private fun storageFast(): TdApi.StorageStatisticsFast {
        val root = java.io.File(boundDir)
        var files = 0L; var count = 0; var db = 0L
        root.walkTopDown().filter { it.isFile }.forEach {
            if (it.parentFile?.name == "media") { files += it.length(); count++ } else db += it.length()
        }
        return TdApi.StorageStatisticsFast(files, count, db, 0, 0)
    }
    private fun clearMediaCache() {
        java.io.File(boundDir, "media").listFiles()?.forEach { it.delete() }
    }
    private fun replayJournalOnce() {
        if (!detached && journalReplayed.compareAndSet(false, true)) ParvaneCore.replayJournal()
    }

    /** X хранит объект из updateNewChat/getChat и СРАВНИВАЕТ с ним позиции из updateChatLastMessage.
     *  Стор мутирует свой chat (positions/lastMessage) раньше, чем X обработает апдейт (поток
     *  апдейтов асинхронный) — X видел «позиция не изменилась» и не добавлял чат в список
     *  (10 сен 2026). Отдаём копию, как делает JNI настоящего TDLib. */
    private fun TdApi.Chat.copyForUi(): TdApi.Chat {
        val c = TdApi.Chat()
        for (fld in TdApi.Chat::class.java.fields) {
            if (java.lang.reflect.Modifier.isStatic(fld.modifiers)) continue
            fld.set(c, fld.get(this))
        }
        c.positions = positions.map { TdApi.ChatPosition(it.list, it.order, it.isPinned, it.source) }.toTypedArray()
        return c
    }

    /** Пир известен → объявить User и Chat (TDLib: updateUser, updateNewChat). */
    private fun ensurePeer(address: String, announce: Boolean) {
        val (user, chat, _) = store.ensurePeer(address)
        if (announce && announcedChats.add(chat.id)) {
            postUpdate(TdApi.UpdateUser(user))
            postUpdate(TdApi.UpdateNewChat(chat.copyForUi()))
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
                    if (announcedChats.contains(chat.id)) postUpdate(TdApi.UpdateChatTitle(chat.id, chat.title))
                    // Аватар: блоб cloud (без шифрования) → файл → фото профиля и чата
                    val avatar = if (u.isNull("avatar")) "" else u.optString("avatar") // optString даёт "null" для JSON null
                    if (avatar.isNotEmpty()) {
                        val path = ParvaneCore.downloadFile(avatar, "", "")
                        if (path.isNotEmpty()) store.setUserPhoto(a, avatar, path)?.let { (usr, ch) ->
                            postUpdate(TdApi.UpdateUser(usr))
                            if (announcedChats.contains(ch.id)) postUpdate(TdApi.UpdateChatPhoto(ch.id, ch.photo))
                        }
                    }
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
        if (detached) return
        when (event.optString("type")) {
            "message" -> {
                val out = event.optBoolean("out")
                val from = event.optString("from")
                val to = event.optString("to")
                val peer = if (out) to else from
                if (peer.isEmpty()) return
                if (!out && store.blocked.contains(from)) return // заблокирован — не показываем
                if (event.optBoolean("group")) {
                    if (store.group(to) == null) syncGroups() // группа завелась на другом устройстве
                    ensurePeer(from, announce = true) // отправитель — пользователь для UI
                } else {
                    ensurePeer(peer, announce = true)
                }
                val content = event.optJSONObject("content")
                    ?: JSONObject().put("kind", "text").put("text", event.optString("text"))
                val msg = store.putMessage(
                    event.optString("id"), from, to, event.optLong("ts"), content, out,
                    read = event.optBoolean("read"), replyUuid = if (event.isNull("reply_to")) null else event.optString("reply_to").ifEmpty { null },
                    edited = event.optBoolean("edited"), pinned = event.optBoolean("pinned"),
                    reactions = event.optJSONArray("reactions"),
                ) ?: return
                Log.i(TAG, "сообщение ${event.optString("id")} → чат ${msg.chatId} (${if (out) "исх" else "вх"})")
                announceMessage(msg)
            }
            // ReadNotice / read_message_ids: Я прочитал на другом устройстве → входящие
            "read" -> {
                val ids = event.optJSONArray("ids") ?: return
                store.markInboxReadUuids((0 until ids.length()).map { ids.getString(it) }).forEach { postUpdate(it) }
            }
            "outbox_read" -> store.markOutboxRead(event.optString("id"))?.let { postUpdate(it) }
            "edited" -> event.optJSONObject("content")?.let { c ->
                store.applyEdit(event.optString("id"), c, event.optLong("edit_date")).forEach { postUpdate(it) }
            }
            "meta" -> store.applyMeta(event.optString("id"), event.optJSONArray("reactions"), event.optBoolean("pinned")).forEach { postUpdate(it) }
            "deleted" -> store.removeMessages(listOf(event.optString("id"))).forEach { postUpdate(it) }
            "cleared" -> {
                val ids = event.optJSONArray("ids") ?: return
                store.removeMessages((0 until ids.length()).map { ids.getString(it) }).forEach { postUpdate(it) }
            }
            "typing" -> {
                val from = event.optString("from"); if (from.isEmpty()) return
                ensurePeer(from, announce = true)
                val to = event.optString("to")
                val chatId = store.group(to)?.chatId ?: store.idOf(from)
                postUpdate(TdApi.UpdateChatAction(chatId, null, TdApi.MessageSenderUser(store.idOf(from)), TdApi.ChatActionTyping()))
            }
            "presence" -> {
                val from = event.optString("from"); if (from.isEmpty()) return
                store.setOnline(from, (System.currentTimeMillis() / 1000 + 90).toInt())?.let { postUpdate(it) }
            }
            "notify" -> try {
                store.applyNotifyBlob(JSONObject(event.optString("blob"))).forEach { postUpdate(it) }
            } catch (e: Exception) { Log.w(TAG, "notify blob: ${e.message}") }
            "link" -> Log.i(TAG, "линковка: ${event.optString("state")} ${event.optString("code")} ${event.optInt("count")}")
            "session" -> if (event.optString("state") == "failed") {
                Log.w(TAG, "сессия: ${event.optString("error")}")
            }
            "error" -> Log.w(TAG, "ядро: ${event.optString("text")}")
        }
    }
}
