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
        const val DEFAULT_GATEWAY_URL = "wss://parvane.duckdns.org:20443/ws"
        var gatewayUrl: String = DEFAULT_GATEWAY_URL

        // Кэш поля chatId по классу апдейта — в companion: postUpdate зовётся из init{} раньше
        // инициализации полей экземпляра (NPE при первом create, 27 сен 2026). ConcurrentHashMap не
        // хранит null → для классов без chatId лежит noChatId.
        private val chatIdFields = ConcurrentHashMap<Class<*>, Any>()
        private val noChatId = Any()

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
                // X зовёт и синхронно (clientExecuteT): свойства сообщения — из стора привязанного клиента
                is TdApi.GetMessageProperties -> boundClient?.messageProperties(query.chatId, query.messageId) ?: TdApi.Error(404, "message not found")
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
    // spec 005: стикеры/GIF/кастом-эмодзи (панель X) — каталог ядра известен после SetTdlibParameters
    private val stickers by lazy { Stickers(store, java.io.File(boundDir), ::postUpdate) }

    @Volatile private var authState: TdApi.AuthorizationState = TdApi.AuthorizationStateWaitTdlibParameters()
    @Volatile private var pendingNick: String = ""
    /** P-07: пароль текущей сессии только в памяти (для identity.device.revoke). */
    @Volatile private var sessionPassword: String = ""
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
        // X (Config.CRASH_CHAT_NOT_FOUND в debug) падает на апдейте по чату, которого не получал updateNewChat:
        // такие апдейты пропускаем с логом — чат придёт с реплеем журнала, а состояние он несёт в себе
        if (update !is TdApi.UpdateNewChat) chatIdOf(update)?.let { cid ->
            if (!announcedChats.contains(cid)) { Log.w(TAG, "апдейт ${update.javaClass.simpleName} для необъявленного чата $cid — пропущен"); return }
        }
        if (update is TdApi.UpdateNewChat || update is TdApi.UpdateChatLastMessage || update is TdApi.UpdateChatPosition
            // группы (spec 003/004): маркеры для tgx_group_manage_flow.sh
            || update is TdApi.UpdateChatPermissions || update is TdApi.UpdateBasicGroupFullInfo
            || update is TdApi.UpdateChatPendingJoinRequests || update is TdApi.UpdateChatPhoto
            // spec 005: опросы/TTL/отложенные/черновики/архив/папки/соединение
            || update is TdApi.UpdateMessageContent || update is TdApi.UpdateDeleteMessages || update is TdApi.UpdateChatMessageAutoDeleteTime
            || update is TdApi.UpdateChatHasScheduledMessages || update is TdApi.UpdateChatDraftMessage || update is TdApi.UpdateChatFolders
            || update is TdApi.UpdateConnectionState || update is TdApi.UpdateInstalledStickerSets)
            Log.d(TAG, "→ X ${update.javaClass.simpleName}")
        handlerThread.execute {
            try {
                h.onResult(update)
            } catch (e: Throwable) {
                exceptionHandler?.onException(e)
            }
        }
    }

    /** chatId апдейта (поле `chatId` бандла TdApi у UpdateChat… и UpdateMessage…), иначе null. */
    private fun chatIdOf(update: TdApi.Update): Long? {
        val f = chatIdFields.getOrPut(update.javaClass) { try { update.javaClass.getField("chatId") } catch (e: NoSuchFieldException) { noChatId } }
        return (f as? java.lang.reflect.Field)?.let { try { it.getLong(update) } catch (e: Throwable) { null } }
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
        is TdApi.SetOption -> { // language_pack_id — выбор языка; x_parvane_phone — телефон профиля (диалог оверлея, spec 005)
            if (f.name == "language_pack_id") languagePackId = (f.value as? TdApi.OptionValueString)?.value ?: ""
            if (f.name == "x_parvane_phone") setProfile(JSONObject().put("phone", ((f.value as? TdApi.OptionValueString)?.value ?: "").trim().take(32)))
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
                // когда extra запуска недоступен (Telegram X) — ТОЛЬКО в debug (P-12/P-46):
                // файл в /data/local/tmp доступен любому приложению с shell/adb.
                if (org.parvane.libtd.BuildConfig.DEBUG) {
                    java.io.File("/data/local/tmp/parvane-gateway").takeIf { it.canRead() }
                        ?.readText()?.trim()?.takeIf { it.isNotEmpty() }?.let { gatewayUrl = it }
                } else if (!gatewayUrl.startsWith("wss://", ignoreCase = true)) {
                    // Release: только wss:// — plaintext ws:// отдал бы JWT в открытом виде.
                    Log.w(TAG, "gateway без wss:// в release проигнорирован: $gatewayUrl")
                    gatewayUrl = DEFAULT_GATEWAY_URL
                }
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
                // P-07: пароль держим только в памяти процесса — отзыв устройства
                // (TerminateSession) требует его; на диск не пишем.
                sessionPassword = f.password ?: ""
                finishLogin(r.optString("address"))
            } else if (r.optBoolean("twofa_required") && r.optString("login_token").isNotEmpty()) {
                // Двухфакторный вход (как Stage::Telegram на десктопе): подтверждение в Telegram-боте.
                // X показывает экран WaitOtherDeviceConfirmation со ссылкой; ссылку открываем сами,
                // статус опрашиваем каждые 2 с, после подтверждения — issue с login_token.
                startTwoFactor(r.optString("address"), f.password ?: "", r.optString("login_token"))
                TdApi.Ok()
            } else {
                TdApi.Error(400, r.optString("error", "неверный логин или пароль"))
            }
        }
        is TdApi.ForwardMessages -> forwardMessages(f) // паритет: тот же content новому адресату, медиа перезаливается
        // Settings → Devices: устройства аккаунта из identity; отзыв = терминация сессии
        is TdApi.GetActiveSessions -> TdApi.Sessions(sessionsList(), 0)
        // P-07: отзыв требует текущий пароль; после рестарта (сессия из session.json)
        // пароля в памяти нет — сервер откажет, просим войти заново.
        is TdApi.TerminateSession -> deviceById[f.sessionId]?.let { dev ->
            if (sessionPassword.isEmpty()) TdApi.Error(401, "для отзыва устройства нужен повторный вход по паролю")
            else if (ParvaneCore.revokeDevice(dev, sessionPassword)) TdApi.Ok() else TdApi.Error(400, "не удалось отозвать устройство")
        } ?: TdApi.Error(404, "session not found")
        is TdApi.TerminateAllOtherSessions -> {
            if (sessionPassword.isEmpty()) TdApi.Error(401, "для отзыва устройств нужен повторный вход по паролю")
            else { sessionsList().filter { !it.isCurrent }.forEach { deviceById[it.id]?.let { ParvaneCore.revokeDevice(it, sessionPassword) } }; TdApi.Ok() }
        }
        // Privacy-экран X: чёрный список из стора; пароль/TTL аккаунта — заглушки без ошибок
        is TdApi.GetBlockedMessageSenders -> store.blocked.toList().map { TdApi.MessageSenderUser(store.idOf(it)) as TdApi.MessageSender }
            .let { TdApi.MessageSenders(it.size, it.toTypedArray()) }
        is TdApi.GetPasswordState -> TdApi.PasswordState(false, "", false, false, null, "", 0)
        is TdApi.GetAccountTtl -> TdApi.AccountTtl(365)
        // Без этого X считает, что сообщение нельзя переслать/закрепить/ответить (кнопок в панели выбора нет)
        is TdApi.GetMessageProperties -> messageProperties(f.chatId, f.messageId) ?: TdApi.Error(404, "message not found")
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
        is TdApi.SetChatMemberStatus -> { // роли/бан участника группы (owner/admin)
            val g = store.groupByChat(f.chatId) ?: return TdApi.Error(404, "group not found")
            val addr = (f.memberId as? TdApi.MessageSenderUser)?.userId?.let { store.addressOf(it) } ?: return TdApi.Error(404, "member not found")
            when (val st = f.status) {
                // spec 004: гранулярные права → group.setadmin (экран «Edit admin» X)
                is TdApi.ChatMemberStatusAdministrator -> groupResult(ParvaneCore.groupSetAdmin(g.gid, addr, ParvaneStore.adminRightsToWire(st.rights).toString()))
                is TdApi.ChatMemberStatusMember ->
                    if (store.roleOf(g, addr) == "admin") groupResult(ParvaneCore.groupSetAdmin(g.gid, addr, null)) else TdApi.Ok()
                is TdApi.ChatMemberStatusBanned -> groupAction(f.chatId, "ban", addr)?.let { TdApi.Ok() } ?: TdApi.Error(500, "не удалось изменить участника")
                is TdApi.ChatMemberStatusLeft -> groupAction(f.chatId, "remove", addr)?.let { TdApi.Ok() } ?: TdApi.Error(500, "не удалось изменить участника")
                else -> TdApi.Error(400, uiText("restrict_unsupported"))
            }
        }
        // ── spec 004: экраны управления группой Telegram X поверх шва ────────────
        is TdApi.SetChatDescription -> withGroup(f.chatId) { g -> groupResult(ParvaneCore.groupSetInfo(g.gid, f.description ?: "", false)) }
        is TdApi.SetChatPhoto -> withGroup(f.chatId) { g ->
            if (f.photo == null) groupResult(ParvaneCore.groupSetInfo(g.gid, null, true)) else {
                val path = ((f.photo as? TdApi.InputChatPhotoStatic)?.photo)?.let { localPath(it) } ?: return@withGroup TdApi.Error(400, "нет файла")
                val r = ParvaneCore.groupSetPhoto(g.gid, path)
                if (r.optBoolean("ok")) store.setGroupPhoto(g.gid, r.optString("file_id"), r.optString("path"))?.let { postUpdate(TdApi.UpdateChatPhoto(it.id, it.photo)) }
                groupResult(r)
            }
        }
        is TdApi.SetChatPermissions -> withGroup(f.chatId) { g -> groupResult(ParvaneCore.groupSetPerms(g.gid, ParvaneStore.permissionsToWire(f.permissions).toString())) }
        is TdApi.GetChatAdministrators -> withGroup(f.chatId) { g ->
            val admins = ArrayList<TdApi.ChatAdministrator>()
            admins += TdApi.ChatAdministrator(store.idOf(g.createdBy), "", true, false)
            g.roles.filterValues { it == "admin" }.keys.forEach { admins += TdApi.ChatAdministrator(store.idOf(it), "", false, true) }
            TdApi.ChatAdministrators(admins.toTypedArray())
        }
        is TdApi.GetChatInviteLinks -> withGroup(f.chatId) { g ->
            val links = inviteLinks(g, f.isRevoked) ?: return@withGroup TdApi.Error(403, uiText("forbidden"))
            val mine = if (f.creatorUserId != 0L) links.filter { it.creatorUserId == f.creatorUserId } else links
            TdApi.ChatInviteLinks(mine.size, mine.toTypedArray())
        }
        is TdApi.GetChatInviteLinkCounts -> withGroup(f.chatId) { g ->
            val active = inviteLinks(g, false) ?: return@withGroup TdApi.Error(403, uiText("forbidden"))
            val revoked = inviteLinks(g, true) ?: emptyList()
            val creators = (active + revoked).map { it.creatorUserId }.distinct()
            TdApi.ChatInviteLinkCounts(creators.map { c -> TdApi.ChatInviteLinkCount(c, active.count { it.creatorUserId == c }, revoked.count { it.creatorUserId == c }) }.toTypedArray())
        }
        is TdApi.GetChatInviteLink -> withGroup(f.chatId) { g ->
            val token = ParvaneStore.inviteTokenOf(f.inviteLink)
            ((inviteLinks(g, false) ?: emptyList()) + (inviteLinks(g, true) ?: emptyList())).firstOrNull { ParvaneStore.inviteTokenOf(it.inviteLink) == token }
                ?: TdApi.Error(404, uiText("invalid"))
        }
        is TdApi.CreateChatInviteLink -> withGroup(f.chatId) { g ->
            val r = ParvaneCore.groupInviteCreate(g.gid, f.name ?: "", f.expirationDate.toLong(), f.memberLimit, f.createsJoinRequest)
            val link = r.optJSONObject("link")
            if (!r.optBoolean("ok") || link == null) groupError(r) else store.inviteLinkOf(link).also { refreshPrimaryLink(g) }
        }
        is TdApi.EditChatInviteLink -> TdApi.Error(400, uiText("invite_edit_unsupported"))
        is TdApi.RevokeChatInviteLink -> withGroup(f.chatId) { g ->
            val token = ParvaneStore.inviteTokenOf(f.inviteLink) ?: return@withGroup TdApi.Error(400, uiText("invalid"))
            val r = ParvaneCore.groupInviteRevoke(g.gid, token)
            if (!r.optBoolean("ok")) groupError(r) else {
                refreshPrimaryLink(g)
                val revoked = (inviteLinks(g, true) ?: emptyList()).filter { ParvaneStore.inviteTokenOf(it.inviteLink) == token }
                TdApi.ChatInviteLinks(revoked.size, revoked.toTypedArray())
            }
        }
        is TdApi.DeleteRevokedChatInviteLink -> withGroup(f.chatId) { g ->
            val token = ParvaneStore.inviteTokenOf(f.inviteLink) ?: return@withGroup TdApi.Error(400, uiText("invalid"))
            groupResult(ParvaneCore.groupInviteDelete(g.gid, token))
        }
        is TdApi.DeleteAllRevokedChatInviteLinks -> withGroup(f.chatId) { g ->
            val revoked = inviteLinks(g, true) ?: return@withGroup TdApi.Error(403, uiText("forbidden"))
            revoked.filter { f.creatorUserId == 0L || it.creatorUserId == f.creatorUserId }
                .forEach { l -> ParvaneStore.inviteTokenOf(l.inviteLink)?.let { ParvaneCore.groupInviteDelete(g.gid, it) } }
            TdApi.Ok()
        }
        is TdApi.ReplacePrimaryChatInviteLink -> withGroup(f.chatId) { g ->
            // основная есть → отозвать её; создать новую без параметров (сервер сделает её основной)
            (inviteLinks(g, false) ?: return@withGroup TdApi.Error(403, uiText("forbidden"))).firstOrNull { it.isPrimary }
                ?.let { p -> ParvaneStore.inviteTokenOf(p.inviteLink)?.let { ParvaneCore.groupInviteRevoke(g.gid, it) } }
            val r = ParvaneCore.groupInviteCreate(g.gid, "", 0L, 0, false)
            val link = r.optJSONObject("link")
            if (!r.optBoolean("ok") || link == null) groupError(r) else store.inviteLinkOf(link).also { refreshPrimaryLink(g) }
        }
        is TdApi.GetChatInviteLinkMembers -> TdApi.ChatInviteLinkMembers(0, arrayOf()) // сервер хранит только счётчик
        is TdApi.GetInternalLinkType -> ParvaneStore.inviteTokenOf(f.link)?.let { TdApi.InternalLinkTypeChatInvite(ParvaneStore.buildInviteLink(it)) }
            ?: TdApi.Error(404, "Not Found")
        is TdApi.CheckChatInviteLink -> {
            val token = ParvaneStore.inviteTokenOf(f.inviteLink) ?: return TdApi.Error(400, uiText("invalid"))
            val r = ParvaneCore.groupInviteCheck(token)
            if (r.optBoolean("ok")) store.inviteLinkInfoOf(r) else groupError(r)
        }
        is TdApi.JoinChatByInviteLink -> {
            val token = ParvaneStore.inviteTokenOf(f.inviteLink) ?: return TdApi.Error(400, uiText("invalid"))
            val r = ParvaneCore.groupJoin(token)
            if (r.optBoolean("ok") && !r.optBoolean("pending")) syncGroups()
            store.joinResultOf(r).let { if (it is TdApi.Error) TdApi.Error(400, uiText(it.message)) else it }
        }
        is TdApi.GetChatJoinRequests -> withGroup(f.chatId) { g ->
            val r = ParvaneCore.groupRequests(g.gid)
            if (!r.optBoolean("ok")) groupError(r) else {
                val all = store.joinRequestsOf(r.optJSONArray("requests"))
                val token = ParvaneStore.inviteTokenOf(f.inviteLink)
                if (token == null) all else {
                    val arr = r.optJSONArray("requests")
                    val keep = HashSet<Long>()
                    if (arr != null) for (i in 0 until arr.length()) { val q = arr.getJSONObject(i); if (q.optString("invite") == token) keep += store.idOf(q.optString("member")) }
                    val filtered = all.requests.filter { it.userId in keep }
                    TdApi.ChatJoinRequests(filtered.size, filtered.toTypedArray())
                }
            }
        }
        is TdApi.ProcessChatJoinRequest -> withGroup(f.chatId) { g ->
            val member = store.addressOf(f.userId) ?: return@withGroup TdApi.Error(404, "user not found")
            groupResult(ParvaneCore.groupRequestDecide(g.gid, member, f.approve))
        }
        // Как TDLib: чат, которого X ещё не получал, сначала объявляется updateNewChat (иначе апдейты по нему отбрасываются в postUpdate)
        is TdApi.GetChat -> store.chatById(f.chatId)?.let { c -> if (announcedChats.add(c.id)) { postUpdate(TdApi.UpdateNewChat(c.copyForUi())); announceScheduled(c.id) }; c.copyForUi() } ?: TdApi.Error(404, "chat not found")
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
            val sched = f.messageIds.filter { scheduledQueue.isScheduledId(it) }
            if (sched.isNotEmpty()) { // spec 005: удаление отложенных — из очереди
                sched.forEach { scheduledQueue.remove(it); scheduledMsgs.remove(it) }
                postUpdate(TdApi.UpdateDeleteMessages(f.chatId, sched.toLongArray(), true, false))
                if (scheduledQueue.forChat(f.chatId).isEmpty()) postUpdate(TdApi.UpdateChatHasScheduledMessages(f.chatId, false))
            }
            val uuids = f.messageIds.filter { !scheduledQueue.isScheduledId(it) }.mapNotNull { id -> store.uuidOf(f.chatId, id) }
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
        is TdApi.SearchBackground, is TdApi.GetEmojiReaction -> TdApi.Error(404, "Not Found")
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
        // spec 005 / история 4: папки (локальные), глобальный поиск, превью ссылок, карта, поля профиля
        is TdApi.GetChatFolder -> store.local?.folders?.get(f.chatFolderId)?.toTd() ?: TdApi.Error(404, "folder not found")
        is TdApi.CreateChatFolder -> run {
            val l = store.local ?: return@run TdApi.Error(500, "no local state")
            val fo = l.folders.create(f.folder)
            Log.i(TAG, "папка ${fo.id} «${fo.title}»: ${refreshFolderPositions().count { it == fo.id }} чатов")
            postUpdate(TdApi.UpdateChatFolders(l.folders.infos(), l.folders.mainPosition, false))
            fo.toInfo()
        }
        is TdApi.EditChatFolder -> run {
            val l = store.local ?: return@run TdApi.Error(500, "no local state")
            val fo = l.folders.edit(f.chatFolderId, f.folder) ?: return@run TdApi.Error(404, "folder not found")
            Log.i(TAG, "папка ${fo.id} «${fo.title}»: ${refreshFolderPositions().count { it == fo.id }} чатов")
            postUpdate(TdApi.UpdateChatFolders(l.folders.infos(), l.folders.mainPosition, false))
            fo.toInfo()
        }
        is TdApi.DeleteChatFolder -> run {
            val l = store.local ?: return@run TdApi.Error(500, "no local state")
            if (!l.folders.delete(f.chatFolderId)) return@run TdApi.Error(404, "folder not found")
            for (id in store.chatIds()) postUpdate(TdApi.UpdateChatPosition(id, TdApi.ChatPosition(TdApi.ChatListFolder(f.chatFolderId), 0L, false, null)))
            refreshFolderPositions()
            Log.i(TAG, "папка ${f.chatFolderId} удалена")
            postUpdate(TdApi.UpdateChatFolders(l.folders.infos(), l.folders.mainPosition, false))
            TdApi.Ok()
        }
        is TdApi.ReorderChatFolders -> run {
            val l = store.local ?: return@run TdApi.Error(500, "no local state")
            l.folders.reorder(f.chatFolderIds ?: IntArray(0), f.mainChatListPosition)
            postUpdate(TdApi.UpdateChatFolders(l.folders.infos(), l.folders.mainPosition, false))
            TdApi.Ok()
        }
        is TdApi.GetRecommendedChatFolders -> TdApi.RecommendedChatFolders(arrayOf())
        is TdApi.SearchMessages -> { // локально по всем чатам (топика поиска нет — как web/desktop)
            val q = (f.query ?: "").trim().lowercase()
            val all = store.chatIds().flatMap { store.history(it, 0, 0, Int.MAX_VALUE).messages.toList() }
                .filter { m -> matchesFilter(m, f.filter) && (q.isEmpty() || messageText(m).lowercase().contains(q)) }
                .sortedByDescending { it.date }
            val from = (f.offset ?: "").toIntOrNull() ?: 0
            val page = all.drop(from).take(if (f.limit > 0) f.limit else 50)
            Log.i(TAG, "поиск «$q»: ${all.size} совпадений")
            TdApi.FoundMessages(all.size, page.toTypedArray(), if (from + page.size < all.size) (from + page.size).toString() else "")
        }
        is TdApi.GetLinkPreview -> run { // только через шард preview (как web/desktop); отключено → 404
            if (f.linkPreviewOptions?.isDisabled == true) return@run TdApi.Error(404, "link preview disabled")
            val url = f.linkPreviewOptions?.url?.takeIf { it.isNotEmpty() } ?: Entities.firstUrl(f.text?.text, f.text?.entities) ?: return@run TdApi.Error(404, "no url")
            val wp = ParvaneCore.previewFetch(url, 1500)
            Log.i(TAG, "превью $url → ${wp.optString("site_name")}")
            LinkPreviews.linkPreviewOf(wp) ?: TdApi.Error(404, "no preview")
        }
        is TdApi.GetMapThumbnailFile -> mapThumbnail(f.location, f.zoom, f.width, f.height, f.scale)
        is TdApi.SetBirthdate -> { // identity.user.setname birthday=YYYY-MM-DD, пусто — убрать
            val b = f.birthdate
            val iso = if (b == null || b.month == 0 || b.day == 0) "" else "%04d-%02d-%02d".format(java.util.Locale.ROOT, if (b.year > 0) b.year else 1900, b.month, b.day)
            val r = setProfile(JSONObject().put("birthday", iso))
            if (r is TdApi.Ok) postUpdate(TdApi.UpdateUserFullInfo(store.idOf(store.self), userFullInfo(store.self)))
            r
        }
        // spec 005 / история 3: TTL чата, отложенные, черновики, архив — локально (как web/desktop)
        is TdApi.SetChatMessageAutoDeleteTime -> run {
            val address = store.addressOf(f.chatId) ?: return@run TdApi.Error(404, "chat not found")
            store.local?.setTtl(address, f.messageAutoDeleteTime)
            store.chatById(f.chatId)?.messageAutoDeleteTime = f.messageAutoDeleteTime
            Log.i(TAG, "ttl $address = ${f.messageAutoDeleteTime}")
            postUpdate(TdApi.UpdateChatMessageAutoDeleteTime(f.chatId, f.messageAutoDeleteTime))
            TdApi.Ok()
        }
        is TdApi.GetChatScheduledMessages -> TdApi.Messages(scheduledQueue.forChat(f.chatId).size, scheduledQueue.forChat(f.chatId).mapNotNull { scheduledMsgs[it.id] }.toTypedArray())
        is TdApi.EditMessageSchedulingState -> run {
            val item = scheduledQueue.get(f.messageId) ?: return@run TdApi.Error(404, "scheduled message not found")
            val st = f.schedulingState
            if (st == null) { scheduledQueue.remove(item.id); fireScheduled(item) }
            else if (st is TdApi.MessageSchedulingStateSendAtDate) { scheduledQueue.reschedule(item.id, st.sendDate.toLong()); scheduledMsgs[item.id] = scheduledMessage(item) }
            else return@run TdApi.Error(400, "unsupported scheduling state")
            TdApi.Ok()
        }
        is TdApi.SetChatDraftMessage -> run {
            val l = store.local ?: return@run TdApi.Error(500, "no local state")
            val json = l.draftJson(f.draftMessage)
            l.setDraft(f.chatId, json)
            val chat = store.chatById(f.chatId)
            chat?.draftMessage = l.tdDraft(f.chatId)
            Log.i(TAG, if (json != null) "черновик ${f.chatId} сохранён" else "черновик ${f.chatId} снят")
            postUpdate(TdApi.UpdateChatDraftMessage(f.chatId, chat?.draftMessage, chat?.positions ?: arrayOf()))
            TdApi.Ok()
        }
        is TdApi.ClearAllDraftMessages -> { store.local?.clearDrafts(); TdApi.Ok() }
        is TdApi.AddChatToList -> run {
            val l = store.local ?: return@run TdApi.Error(500, "no local state")
            val toArchive = f.chatList is TdApi.ChatListArchive
            val chat = store.chatById(f.chatId) ?: return@run TdApi.Error(404, "chat not found")
            val order = chat.positions.firstOrNull()?.order ?: 0L
            val oldList: TdApi.ChatList = if (l.isArchived(f.chatId)) TdApi.ChatListArchive() else TdApi.ChatListMain()
            l.setArchived(f.chatId, toArchive)
            chat.positions = store.positionsFor(f.chatId, order)
            Log.i(TAG, "чат ${f.chatId} → ${if (toArchive) "архив" else "главный список"}")
            postUpdate(TdApi.UpdateChatPosition(f.chatId, TdApi.ChatPosition(oldList, 0L, false, null)))
            postUpdate(TdApi.UpdateChatPosition(f.chatId, chat.positions[0]))
            TdApi.Ok()
        }
        // spec 005: опросы — голос/закрытие как отдельные sealed-сообщения, агрегат локальный (PollStore)
        is TdApi.SetPollAnswer -> pollVote(f.chatId, f.messageId, f.optionIds?.toList() ?: emptyList())
        is TdApi.StopPoll -> pollStop(f.chatId, f.messageId)
        is TdApi.GetPollVoters -> {
            val uuid = store.uuidOf(f.chatId, f.messageId)
            val voters = uuid?.let { store.polls.voters(it, f.optionId) } ?: emptyList()
            val page = voters.drop(f.offset.coerceAtLeast(0)).take(if (f.limit > 0) f.limit else 50)
            TdApi.MessageSenders(voters.size, page.map { TdApi.MessageSenderUser(store.idOf(it)) as TdApi.MessageSender }.toTypedArray())
        }
        is TdApi.GetChatAdministrators -> TdApi.ChatAdministrators(arrayOf())
        is TdApi.GetUserFullInfo -> {
            val address = store.addressOf(f.userId)
            if (address == null) TdApi.Error(404, "user not found") else {
                val info = userFullInfo(address)
                // X (TdlibCache) игнорирует ответ и ждёт updateUserFullInfo, как от TDLib — иначе «Loading information…»
                postUpdate(TdApi.UpdateUserFullInfo(f.userId, info))
                info
            }
        }
        // spec 005: стикеры/GIF/кастом-эмодзи из локального индекса паков (PACK-1/EMOJI-1);
        // каталога для поиска нет (как web) — трендовые/поиск/категории пусты
        is TdApi.GetInstalledStickerSets -> stickers.installedSets(f.stickerType)
        is TdApi.GetArchivedStickerSets -> stickers.archivedSets(f.stickerType)
        is TdApi.GetStickerSet -> stickers.stickerSet(f.setId)
        is TdApi.SearchStickerSet -> stickers.searchSet(f.name)
        is TdApi.GetStickers -> stickers.stickersByEmoji(f.stickerType, f.query, f.limit)
        is TdApi.SearchStickers -> TdApi.Stickers(arrayOf())
        is TdApi.GetTrendingStickerSets -> TdApi.TrendingStickerSets(0, arrayOf(), false)
        is TdApi.GetEmojiCategories -> TdApi.EmojiCategories(arrayOf()) // иной источник категории роняет X (Td.unsupported)
        is TdApi.GetCustomEmojiStickers -> stickers.customEmoji(f.customEmojiIds)
        is TdApi.ChangeStickerSet -> stickers.change(f.setId, f.isInstalled, f.isArchived)
        is TdApi.GetFavoriteStickers -> stickers.favorites()
        is TdApi.GetRecentStickers -> stickers.recents()
        is TdApi.AddFavoriteSticker -> stickers.addFavorite(f.sticker)
        is TdApi.RemoveFavoriteSticker -> stickers.removeFavorite(f.sticker)
        is TdApi.RemoveRecentSticker -> stickers.removeRecent(f.sticker)
        is TdApi.GetSavedAnimations -> stickers.savedAnimations()
        is TdApi.AddSavedAnimation -> stickers.addSavedAnimation(f.animation)
        is TdApi.RemoveSavedAnimation -> stickers.removeSavedAnimation(f.animation)
        is TdApi.SearchEmojis -> TdApi.EmojiKeywords(arrayOf())
        is TdApi.GetKeywordEmojis -> TdApi.Emojis(arrayOf())
        is TdApi.CreateNewStickerSet, is TdApi.AddStickerToSet -> TdApi.Error(501, "Parvane: создание паков — из файлов на web/desktop")
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
            // о состоянии) — Ok, UI не спотыкается; запросы данных — ошибка 501.
            // spec 004: управляющие функции группы НЕ имеют права молча отвечать Ok —
            // иначе X показывает успех, а данные теряются (сторож — ClientHonestUiTest)
            if (resultTypeOf(f) == TdApi.Ok::class.java && f.javaClass.simpleName !in NO_OK_STUB) {
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
        // spec 005: встроенные паки ParvaneEmoji/ParvaneStickers (Canvas при первом старте)
        io.execute { if (!stickers.ensureBuiltin()) Log.w(TAG, "встроенные паки не нарисованы") }
        // spec 005 / история 3: локальное состояние чатов, очередь отложенных, e2e-хук команд
        if (store.local == null) store.local = ChatLocalState(java.io.File(boundDir))
        store.local?.folders?.let { if (it.all().isNotEmpty()) postUpdate(TdApi.UpdateChatFolders(it.infos(), it.mainPosition, false)) }
        startScheduled()
        startE2eHook()
    }

    /** Группы с сервера → basic group + чат в UI (idempotent). */
    private fun syncGroups() {
        val arr = try { ParvaneCore.listGroups() } catch (e: Throwable) { Log.w(TAG, "группы: ${e.message}"); return }
        for (i in 0 until arr.length()) {
            val g = arr.getJSONObject(i)
            val mem = g.optJSONArray("members")
            val members = ArrayList<String>()
            val roles = HashMap<String, String>()
            if (mem != null) for (j in 0 until mem.length()) {
                val mo = mem.getJSONObject(j); val addr = mo.optString("address"); members += addr
                if (mo.optString("role") == "admin") roles[addr] = "admin"
            }
            members.forEach { ensurePeer(it, announce = true) } // участники — пользователи для UI
            val gid = g.optString("group_id")
            store.groupKind[gid] = g.optString("kind", "group") // для папок (группа/канал)
            val ref = store.group(gid)
            val previousVersion = ref?.version ?: -1L
            val previousAvatar = ref?.avatarFileId ?: ""
            val previousPending = ref?.pendingRequests ?: 0
            // GROUP-1: сведения с ревизией ниже известной пропускаются
            val ensured = store.ensureGroup(gid, g.optString("name"), members, g.optString("created_by"), roles, g)
            if (ensured == null) {
                Log.i(TAG, "группа $gid: сведения v${g.optLong("version", -1)} устарели, пропущены")
                continue
            }
            val (chat, basic, created) = ensured
            postUpdate(TdApi.UpdateBasicGroup(basic))
            if (created && announcedChats.add(chat.id)) { postUpdate(TdApi.UpdateNewChat(chat.copyForUi())); announceScheduled(chat.id) }
            else postUpdate(TdApi.UpdateChatTitle(chat.id, chat.title))
            val version = g.optLong("version", -1L)
            if (!created && version >= 0 && version == previousVersion) continue
            // spec 003: права по умолчанию, описание, фото — открытые экраны X обновляются апдейтами
            postUpdate(TdApi.UpdateChatPermissions(chat.id, chat.permissions))
            store.group(gid)?.let { postUpdate(TdApi.UpdateBasicGroupFullInfo(it.basicGroupId, store.basicGroupFullInfo(it))) }
            // spec 004: счётчик заявок — строка «Join Requests» в профиле X
            if ((store.group(gid)?.pendingRequests ?: 0) != previousPending) postUpdate(TdApi.UpdateChatPendingJoinRequests(chat.id, chat.pendingJoinRequests))
            val avatar = if (g.isNull("avatar")) "" else g.optString("avatar", "")
            if (avatar.isEmpty()) {
                if (previousAvatar.isNotEmpty()) store.clearGroupPhoto(gid)?.let { postUpdate(TdApi.UpdateChatPhoto(it.id, it.photo)) }
            } else if (avatar != previousAvatar) {
                val path = ParvaneCore.downloadFile(avatar, "", "")
                if (path.isNotEmpty()) store.setGroupPhoto(gid, avatar, path)?.let { postUpdate(TdApi.UpdateChatPhoto(it.id, it.photo)) }
            }
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

    // ── spec 004: хелперы экранов управления ────────────────────────────────
    /** Функции, которым запрещена молчаливая Ok-заглушка (управление группой). */
    private val NO_OK_STUB = setOf("DeleteChatFolder", "ReorderChatFolders", "SetBirthdate", "SetAccentColor", "SetProfileAccentColor", "SetPersonalChat",
        "SetChatMessageAutoDeleteTime", "EditMessageSchedulingState", "SetChatDraftMessage", "AddChatToList",
        "SetPollAnswer", "StopPoll", "ChangeStickerSet", "AddFavoriteSticker", "RemoveFavoriteSticker", "RemoveRecentSticker", "AddSavedAnimation", "RemoveSavedAnimation",
        "SetChatDescription", "SetChatPhoto", "SetChatPermissions", "ProcessChatJoinRequest",
        "DeleteRevokedChatInviteLink", "DeleteAllRevokedChatInviteLinks", "EditChatInviteLink", "SetChatMemberStatus")

    private inline fun withGroup(chatId: Long, block: (ParvaneStore.GroupRef) -> TdApi.Object): TdApi.Object =
        store.groupByChat(chatId)?.let(block) ?: TdApi.Error(404, "group not found")

    /** Ответ сервера {ok, error_code, error} → Ok (+ синк групп) либо Error(400, текст по коду). */
    private fun groupResult(r: JSONObject): TdApi.Object =
        if (r.optBoolean("ok")) { syncGroups(); TdApi.Ok() } else groupError(r)
    private fun groupError(r: JSONObject): TdApi.Error {
        val code = r.optString("error_code").ifEmpty { "failed" }
        Log.w(TAG, "группа: отказ $code ${r.optString("error")}")
        return TdApi.Error(if (code == "forbidden") 403 else 400, uiText(code, r.optString("error")))
    }
    /** Тексты для X по коду сервера — EN и RU (принцип IX), выбор по локали. */
    private fun uiText(code: String, fallback: String = ""): String {
        val ru = java.util.Locale.getDefault().language == "ru"
        return when (code) {
            "forbidden" -> if (ru) "Нет прав" else "No permission"
            "bad_request" -> if (ru) "Неверный запрос" else "Bad request"
            "limit" -> if (ru) "Слишком много активных ссылок" else "Too many active links"
            "invalid" -> if (ru) "Пригласительная ссылка недействительна" else "This invite link is invalid"
            "revoked" -> if (ru) "Пригласительная ссылка отозвана" else "This invite link was revoked"
            "expired" -> if (ru) "Срок действия ссылки истёк" else "This invite link has expired"
            "exhausted" -> if (ru) "Лимит вступлений по ссылке исчерпан" else "This invite link has reached its usage limit"
            "banned" -> if (ru) "Вы заблокированы в этой группе" else "You are banned from this group"
            "declined" -> if (ru) "Ваша заявка отклонена. Попробуйте позже" else "Your join request was declined. Try again later"
            "invite_edit_unsupported" -> if (ru) "Правка ссылки не поддерживается — отзовите её и создайте новую" else "Editing a link is not supported — revoke it and create a new one"
            "restrict_unsupported" -> if (ru) "Частичные ограничения не поддерживаются — участника можно только удалить" else "Partial restrictions are not supported — you can only remove a member"
            "sticker_not_found" -> if (ru) "Стикер не найден в установленных паках" else "Sticker not found in installed packs"
            "rate_limited" -> if (ru) "Слишком много действий, помедленнее" else "Too many actions, slow down"
            "session_expired" -> if (ru) "Сессия истекла — войдите снова" else "Session expired — sign in again"
            else -> fallback.ifEmpty { code }
        }
    }
    /** Список ссылок (активные/отозванные) → ChatInviteLink[]; null — отказ сервера. */
    private fun inviteLinks(g: ParvaneStore.GroupRef, revoked: Boolean): List<TdApi.ChatInviteLink>? {
        val r = ParvaneCore.groupInvites(g.gid, revoked)
        if (!r.optBoolean("ok")) { Log.w(TAG, "ссылки ${g.gid}: отказ ${r.optString("error_code")}"); return null }
        val arr = r.optJSONArray("links") ?: return emptyList()
        val out = ArrayList<TdApi.ChatInviteLink>()
        for (i in 0 until arr.length()) out += store.inviteLinkOf(arr.getJSONObject(i))
        if (!revoked) {
            g.primaryInviteLink = out.firstOrNull { it.isPrimary && !it.isRevoked }
        }
        return out
    }
    /** Основная ссылка в BasicGroupFullInfo (getPrimaryChatInviteLink в X читает её оттуда). */
    private fun refreshPrimaryLink(g: ParvaneStore.GroupRef) {
        inviteLinks(g, false) ?: return
        postUpdate(TdApi.UpdateBasicGroupFullInfo(g.basicGroupId, store.basicGroupFullInfo(g)))
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

    // ── профиль / папки / карта (spec 005 / история 4) ──────────────────────
    private fun userFullInfo(address: String): TdApi.UserFullInfo = TdApi.UserFullInfo().apply {
        canBeCalled = false // звонков на Android пока нет (спек 006) — кнопка звонка в шапке не показывается
        supportsVideoCalls = false
        bio = TdApi.FormattedText(store.profileField(address, "bio"), arrayOf())
        blockList = if (store.blocked.contains(address)) TdApi.BlockListMain() else null
        giftSettings = null
        // день рождения YYYY-MM-DD и личный канал (если группа известна) — как web/desktop
        Regex("^(\\d{4})-(\\d{2})-(\\d{2})$").find(store.profileField(address, "birthday"))?.let { m ->
            val (y, mo, d) = m.destructured
            birthdate = TdApi.Birthdate(d.toInt(), mo.toInt(), y.toInt().let { if (it <= 1900) 0 else it })
        }
        store.profileField(address, "personal_channel").takeIf { it.isNotEmpty() }?.let { gid -> store.group(gid)?.let { personalChatId = it.chatId } }
    }
    /** Пересчитать позиции всех чатов по папкам; вернуть id папок, в которые попали чаты (для подсчёта). */
    private fun refreshFolderPositions(): List<Int> {
        val out = ArrayList<Int>()
        for (id in store.chatIds()) {
            val chat = store.chatById(id) ?: continue
            chat.positions = store.positionsFor(id, chat.positions.firstOrNull()?.order ?: 0L)
            chat.positions.forEach { p -> postUpdate(TdApi.UpdateChatPosition(id, p)); (p.list as? TdApi.ChatListFolder)?.let { out.add(it.chatFolderId) } }
        }
        return out
    }
    /** Карта в пузыре геолокации: тайлы только через preview.map.tile (MAP-1), склейка Canvas → media/map-*.png. */
    private fun mapThumbnail(loc: TdApi.Location?, zoom: Int, width: Int, height: Int, scale: Int): TdApi.Object {
        if (loc == null || width <= 0 || height <= 0) return TdApi.Error(400, "bad map request")
        val z = if (zoom <= 0) MapGeometry.DEFAULT_ZOOM else zoom
        val name = MapGeometry.fileName(loc.latitude, loc.longitude, z, width, height, scale.toDouble())
        val out = java.io.File(java.io.File(boundDir, "media"), name)
        if (out.exists() && out.length() > 0) return store.fileFor("map:$name", "", "", out.length(), "image/png", out.absolutePath)
        val g = MapGeometry.compute(loc.latitude, loc.longitude, z, width, height, scale.toDouble())
        if (g.tiles.isEmpty()) return TdApi.Error(404, "no tiles")
        return try {
            val bmp = android.graphics.Bitmap.createBitmap(g.canvasWidth, g.canvasHeight, android.graphics.Bitmap.Config.ARGB_8888)
            val canvas = android.graphics.Canvas(bmp); canvas.drawColor(0xFFE8E6E1.toInt())
            var okTiles = 0
            for (t in g.tiles) {
                val png = ParvaneCore.mapTile(t.z, t.x, t.y); if (png.isEmpty()) continue
                val tile = android.graphics.BitmapFactory.decodeByteArray(png, 0, png.size) ?: continue
                canvas.drawBitmap(tile, null, android.graphics.Rect(t.dstX, t.dstY, t.dstX + t.dstSize, t.dstY + t.dstSize), null); okTiles++
            }
            Log.i(TAG, "карта %.5f,%.5f z%d %dx%d тайлов=%d/%d".format(java.util.Locale.ROOT, loc.latitude, loc.longitude, z, width, height, okTiles, g.tiles.size))
            if (okTiles == 0) return TdApi.Error(404, "no tiles")
            out.parentFile?.mkdirs()
            out.outputStream().use { bmp.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
            store.fileFor("map:$name", "", "", out.length(), "image/png", out.absolutePath)
        } catch (e: Throwable) { Log.w(TAG, "карта: ${e.message}"); TdApi.Error(500, "map render failed") }
    }

    // ── сессия (spec 005 / FAIL-1) ───────────────────────────────────────────
    @Volatile private var lastSentUuid = ""
    /** Истёкший/отозванный JWT: экран входа как у X (LoggingOut → WaitPhoneNumber, без Closed — тот стирает данные), ключи и журнал на месте. */
    private fun sessionExpired() {
        Log.i(TAG, "сессия истекла → экран входа")
        try { ParvaneCore.sessionExpired() } catch (e: Throwable) { Log.w(TAG, "sessionExpired: ${e.message}") }
        store.clear(); announcedChats.clear(); journalReplayed.set(false) // как LogOut; журнал на диске цел — реплей при следующем входе
        setAuth(TdApi.AuthorizationStateLoggingOut())
        setAuth(TdApi.AuthorizationStateWaitPhoneNumber())
    }

    // ── опросы (spec 005) ────────────────────────────────────────────────────
    private fun pollUpdate(uuid: String): TdApi.Update? {
        val msg = store.messageByUuid(uuid) ?: return null
        val poll = store.polls.toTdPoll(uuid, store.self, store::idOf) ?: return null
        val content = TdApi.MessagePoll(poll, null, null, false)
        msg.content = content
        return TdApi.UpdateMessageContent(msg.chatId, msg.id, content)
    }
    private fun onPollService(content: JSONObject, from: String) {
        val uuid = content.optString("poll"); if (uuid.isEmpty()) return
        val changed = if (content.optString("kind") == "poll_close") {
            Log.i(TAG, "опрос $uuid закрыт"); store.polls.close(uuid)
        } else {
            val idx = content.optJSONArray("options")?.let { a -> (0 until a.length()).map { a.optInt(it) } } ?: emptyList()
            Log.i(TAG, "голос $from → опрос $uuid $idx"); store.polls.applyVote(uuid, from, idx)
        }
        if (changed) pollUpdate(uuid)?.let { postUpdate(it) }
    }
    private fun pollVote(chatId: Long, messageId: Long, optionIds: List<Int>): TdApi.Object {
        val uuid = store.uuidOf(chatId, messageId) ?: return TdApi.Error(404, "message not found")
        val address = store.addressOf(chatId) ?: return TdApi.Error(404, "chat not found")
        if (store.polls.get(uuid) == null) return TdApi.Error(404, "poll not found")
        if (store.polls.get(uuid)!!.closed) return TdApi.Error(400, "poll closed")
        val sent = ParvaneCore.sendContent(address, PollStore.voteContent(uuid, optionIds).toString(), "")
        if (sent.isEmpty()) return TdApi.Error(500, "не отправлено (E2E/сеть)")
        store.polls.applyVote(uuid, store.self, optionIds)
        Log.i(TAG, "голос ${store.self} → опрос $uuid $optionIds")
        pollUpdate(uuid)?.let { postUpdate(it) }
        return TdApi.Ok()
    }
    private fun pollStop(chatId: Long, messageId: Long): TdApi.Object {
        val uuid = store.uuidOf(chatId, messageId) ?: return TdApi.Error(404, "message not found")
        val address = store.addressOf(chatId) ?: return TdApi.Error(404, "chat not found")
        val e = store.polls.get(uuid) ?: return TdApi.Error(404, "poll not found")
        if (e.owner != store.self) return TdApi.Error(400, uiText("forbidden"))
        val sent = ParvaneCore.sendContent(address, PollStore.closeContent(uuid).toString(), "")
        if (sent.isEmpty()) return TdApi.Error(500, "не отправлено (E2E/сеть)")
        store.polls.close(uuid); Log.i(TAG, "опрос $uuid закрыт")
        pollUpdate(uuid)?.let { postUpdate(it) }
        return TdApi.Ok()
    }

    /** Получатели для ACL cloud (PACK-1): собеседник или участники группы без себя. */
    private fun recipientsOf(address: String): List<String> =
        store.group(address)?.members?.filter { it != store.self } ?: listOf(address)

    private fun localPath(input: TdApi.InputFile?): String? = when (input) {
        is TdApi.InputFileLocal -> input.path
        is TdApi.InputFileGenerated -> input.originalPath // X сжимает фото генерацией — берём оригинал
        else -> null
    }

    /** Подготовленный контент: JSON провода + локальный файл (медиа) или null. */
    private class Prepared(val content: JSONObject, val localPath: String?, val echo: Boolean)

    /** InputMessageContent X → контент провода (без отправки). Ошибка — TdApi.Error. */
    private fun prepareContent(c: TdApi.InputMessageContent?, address: String): Any {
        fun cap(t: TdApi.FormattedText?): String = t?.text ?: ""
        return when (c) {
            is TdApi.InputMessageText -> {
                val content = JSONObject().put("kind", "text").put("text", c.text?.text ?: "")
                // spec 005: сущности провода + emoji_packs (≤4) для кастом-эмодзи (PACK-1 по получателям)
                val wireEntities: org.json.JSONArray? = Entities.toWire(c.text?.entities)
                if (wireEntities != null) content.put("entities", wireEntities)
                val emojiIds: List<Long> = Entities.customEmojiIds(c.text?.entities)
                if (emojiIds.isNotEmpty()) {
                    val packs: org.json.JSONArray? = stickers.emojiPacksFor(emojiIds, recipientsOf(address))
                    if (packs != null) content.put("emoji_packs", packs)
                }
                // превью ссылки делает отправитель (spec 005, как web/desktop) — только через шард preview
                val url = Entities.firstUrl(c.text?.text, c.text?.entities)
                val disabled = c.linkPreviewOptions?.isDisabled == true
                if (url != null && !disabled) {
                    val wp = try { ParvaneCore.previewFetch(url, 1500) } catch (e: Throwable) { null }
                    if (wp != null && wp.has("url")) { content.put("webpage", wp); Log.i(TAG, "превью $url → ${wp.optString("site_name")}") }
                }
                Prepared(content, null, true)
            }
            is TdApi.InputMessageSticker -> { // из панели X: InputFileId → файл пака; pack_ref для не встроенного (PACK-1)
                val resolved = stickers.resolveInput(c.sticker?.sticker) ?: return TdApi.Error(404, uiText("sticker_not_found"))
                val pack = resolved.pack; val pf = resolved.file
                val content = JSONObject().put("kind", "sticker").put("filename", (c.emoji ?: "").ifEmpty { pf.emoji })
                    .put("mime", pf.mime).put("width", pf.width).put("height", pf.height)
                stickers.packRefForSend(pack, recipientsOf(address))?.let { content.put("pack_ref", it) }
                stickers.noteRecent(pack, pf)
                content.put("_pack", if (pack.builtin) "builtin" else pack.rawName)
                Prepared(content, resolved.path, false)
            }
            is TdApi.InputMessagePoll -> { // spec 005: kind=poll с обоими наборами имён (web+desktop)
                val quiz = c.type as? TdApi.InputPollTypeQuiz
                Prepared(PollStore.buildContent(c.question?.text ?: "", (c.options ?: arrayOf<TdApi.InputPollOption>()).map { it.text?.text ?: "" }.filter { it.isNotEmpty() },
                    !c.isAnonymous, c.allowsMultipleAnswers, quiz != null, quiz?.correctOptionIds?.toList() ?: emptyList(), quiz?.explanation?.text ?: ""), null, true)
            }
            is TdApi.InputMessageAnimation -> {
                val path = localPath(c.animation?.animation) ?: return TdApi.Error(400, "нет файла")
                val ext = path.substringAfterLast('.', "").lowercase()
                val mime = when (ext) { "gif" -> "image/gif"; "mp4" -> "video/mp4"; else -> "video/webm" }
                Prepared(JSONObject().put("kind", "gif").put("mime", mime).put("filename", path.substringAfterLast('/'))
                    .put("width", c.animation.width).put("height", c.animation.height).put("duration_secs", c.animation.duration).put("caption", cap(c.caption)), path, false)
            }
            is TdApi.InputMessageLocation -> // как десктоп/веб: {kind:location, lat, long}
                Prepared(JSONObject().put("kind", "location").put("lat", c.location?.latitude ?: 0.0).put("long", c.location?.longitude ?: 0.0), null, true)
            is TdApi.InputMessageContact -> { // телефонных контактов нет — делимся ником текстом
                val uidAddr = c.contact?.userId?.let { store.addressOf(it) }
                Prepared(JSONObject().put("kind", "text").put("text", uidAddr?.let { "@" + it.substringBefore('@') } ?: (c.contact?.firstName ?: "")), null, true)
            }
            is TdApi.InputMessagePhoto -> Prepared(JSONObject().put("kind", "photo").put("mime", "image/jpeg").put("width", c.photo.width).put("height", c.photo.height).put("caption", cap(c.caption)),
                localPath(c.photo?.photo) ?: return TdApi.Error(400, "нет файла"), false)
            is TdApi.InputMessageVideo -> Prepared(JSONObject().put("kind", "video").put("mime", "video/mp4").put("width", c.video.width).put("height", c.video.height).put("duration_secs", c.video.duration).put("caption", cap(c.caption)),
                localPath(c.video?.video) ?: return TdApi.Error(400, "нет файла"), false)
            is TdApi.InputMessageDocument -> {
                val path = localPath(c.document?.document) ?: return TdApi.Error(400, "нет файла")
                val name = path.substringAfterLast('/')
                val mime = android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase()) ?: "application/octet-stream"
                Prepared(JSONObject().put("kind", "file").put("mime", mime).put("filename", name).put("caption", cap(c.caption)), path, false)
            }
            is TdApi.InputMessageVoiceNote -> Prepared(JSONObject().put("kind", "voice").put("mime", "audio/ogg").put("duration_secs", c.voiceNote.duration).put("caption", cap(c.caption)),
                localPath(c.voiceNote?.voiceNote) ?: return TdApi.Error(400, "нет файла"), false)
            is TdApi.InputMessageVideoNote -> Prepared(JSONObject().put("kind", "video_note").put("mime", "video/mp4").put("duration_secs", c.videoNote.duration).put("width", c.videoNote.length),
                localPath(c.videoNote?.videoNote) ?: return TdApi.Error(400, "нет файла"), false)
            else -> TdApi.Error(400, "Parvane: тип сообщения не поддерживается ${c?.javaClass?.simpleName}")
        }
    }

    /** Отправить подготовленный контент штатным путём ядра; "" — не отправлено. */
    private fun sendPrepared(address: String, p: Prepared, replyUuid: String): String {
        val content = JSONObject(p.content.toString()).also { it.remove("_pack") }
        // TTL (spec 005): таймер чата → ttl_secs каждого исходящего (как web/desktop)
        val ttlSecs = store.local?.ttlOf(address) ?: 0
        if (ttlSecs > 0 && !PollStore.isService(content.optString("kind"))) content.put("ttl_secs", ttlSecs)
        val uuid = if (p.localPath != null) ParvaneCore.sendMedia(address, p.localPath, content.toString(), replyUuid)
                   else ParvaneCore.sendContent(address, content.toString(), replyUuid)
        if (uuid.isNotEmpty() && p.content.has("_pack")) Log.i(TAG, "стикер отправлен $uuid pack=${p.content.optString("_pack")}")
        return uuid
    }

    private fun sendMessage(f: TdApi.SendMessage): TdApi.Object {
        val address = store.addressOf(f.chatId) ?: return TdApi.Error(404, "chat not found")
        val replyUuid = (f.replyTo as? TdApi.InputMessageReplyToMessage)?.let { store.uuidOf(f.chatId, it.messageId) } ?: ""
        val prepared = when (val r = prepareContent(f.inputMessageContent, address)) { is Prepared -> r; else -> return r as TdApi.Object }
        // spec 005: отложенная отправка — локальная очередь (сервер не знает)
        val sendAt = (f.options?.schedulingState as? TdApi.MessageSchedulingStateSendAtDate)?.sendDate ?: 0
        if (sendAt > 0) return scheduleMessage(f.chatId, address, prepared, replyUuid, sendAt.toLong())
        val uuid = sendPrepared(address, prepared, replyUuid)
        if (uuid.isEmpty()) return TdApi.Error(500, "не отправлено (E2E/сеть)")
        lastSentUuid = uuid
        // Медиа: эхо со всеми полями (file_id, local_path) эмитит ядро само; текст
        // кладём здесь. При дубликате возвращаем уже сохранённое (X иначе не
        // очищал поле и показывал тост «#500: дубликат», 10 сен 2026).
        if (prepared.echo) {
            val echo = JSONObject(prepared.content.toString())
            val ttlSecs = store.local?.ttlOf(address) ?: 0
            if (ttlSecs > 0) echo.put("ttl_secs", ttlSecs)
            val msg = store.putMessage(uuid, store.self, address, System.currentTimeMillis() / 1000, echo, out = true,
                replyUuid = replyUuid.ifEmpty { null })
            if (msg != null) {
                armTtl(msg, uuid, echo)
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

    // ── TTL (spec 005 / история 3) ─────────────────────────────────────────
    private val ttlTimers by lazy { TtlScheduler(onExpire = ::onTtlExpire) }
    /** Сообщение с ttl_secs: пометить таймером для X и взвести удаление на ts+ttl. */
    private fun armTtl(msg: TdApi.Message, uuid: String, content: JSONObject) {
        val ttl = content.optInt("ttl_secs", 0); if (ttl <= 0) return
        msg.selfDestructType = TdApi.MessageSelfDestructTypeTimer(ttl)
        ttlTimers.arm(uuid, msg.date.toLong() + ttl)
        Log.i(TAG, "ttl: взведено $uuid на ${msg.date + ttl}")
    }
    private fun onTtlExpire(uuid: String) {
        val fileId = store.contentOf(uuid)?.optString("file_id") ?: ""
        store.removeMessages(listOf(uuid)).forEach { postUpdate(it) }
        try { ParvaneCore.forget(uuid, fileId) } catch (e: Throwable) { }
        Log.i(TAG, "ttl: удалено $uuid")
    }

    // ── отложенные (spec 005 / история 3) ───────────────────────────────────
    private val scheduledQueue by lazy { ScheduledQueue(java.io.File(boundDir)) }
    private val scheduledMsgs = ConcurrentHashMap<Long, TdApi.Message>()
    private val scheduledTick = java.util.concurrent.Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "parvane-scheduled").apply { isDaemon = true } }
    private fun scheduledMessage(it: ScheduledQueue.Item): TdApi.Message = TdApi.Message().apply {
        id = it.id; chatId = it.chatId; senderId = TdApi.MessageSenderUser(store.idOf(store.self)); isOutgoing = true
        date = it.createdAt.toInt(); schedulingState = TdApi.MessageSchedulingStateSendAtDate(it.due.toInt(), 0); canBeSaved = true
        content = store.contentFrom(JSONObject(it.content.toString()).also { c -> if (it.localPath != null) c.put("local_path", it.localPath) })
    }
    private fun scheduleMessage(chatId: Long, address: String, p: Prepared, replyUuid: String, due: Long): TdApi.Object {
        val item = scheduledQueue.add(java.util.UUID.randomUUID().toString(), chatId, address, JSONObject(p.content.toString()).also { it.remove("_pack") }, p.localPath, replyUuid.ifEmpty { null }, due)
        val msg = scheduledMessage(item); scheduledMsgs[item.id] = msg
        Log.i(TAG, "отложено ${item.uuid} на $due")
        postUpdate(TdApi.UpdateChatHasScheduledMessages(chatId, true))
        return msg
    }
    private fun fireScheduled(it: ScheduledQueue.Item) {
        val uuid = sendPrepared(it.to, Prepared(it.content, it.localPath, it.localPath == null), it.replyTo ?: "")
        scheduledMsgs.remove(it.id)
        postUpdate(TdApi.UpdateDeleteMessages(it.chatId, longArrayOf(it.id), true, false))
        if (scheduledQueue.forChat(it.chatId).isEmpty()) postUpdate(TdApi.UpdateChatHasScheduledMessages(it.chatId, false))
        if (uuid.isEmpty()) { Log.w(TAG, "отложенное ${it.uuid} не отправлено"); return }
        Log.i(TAG, "отложенное ${it.uuid} отправлено")
        if (it.localPath == null) {
            store.putMessage(uuid, store.self, it.to, System.currentTimeMillis() / 1000, it.content, out = true, replyUuid = it.replyTo)?.let { m -> announceMessage(m) }
        }
    }
    /** Чат объявлен X → сообщить о его отложенных (если есть). */
    private fun announceScheduled(chatId: Long) {
        if (announcedChats.contains(chatId) && scheduledQueue.forChat(chatId).isNotEmpty()) postUpdate(TdApi.UpdateChatHasScheduledMessages(chatId, true))
    }
    private fun startScheduled() {
        val restored = scheduledQueue.all()
        restored.forEach { scheduledMsgs[it.id] = scheduledMessage(it) }
        Log.i(TAG, "отложенных восстановлено: ${restored.size}")
        // Флаг «есть отложенные» уходит в X только для уже объявленного чата (announceScheduled из
        // ensurePeer/syncGroups): при подъёме сессии чаты X ещё не получил, и debug-сборка X падала
        // «updateChat not received … UpdateChatHasScheduledMessages», после чего уходила в recovery-режим
        // без SetTdlibParameters (27 сен 2026, tgx_ttl_scheduled_flow.sh)
        restored.map { it.chatId }.distinct().forEach { announceScheduled(it) }
        scheduledTick.scheduleWithFixedDelay({ try { scheduledQueue.takeDue().forEach { fireScheduled(it) } } catch (e: Throwable) { Log.w(TAG, "scheduled tick: ${e.message}") } }, 5, 5, java.util.concurrent.TimeUnit.SECONDS)
    }

    // ── e2e-хук команд (только для сценариев эмулятора: /data/local/tmp/parvane-e2e-cmd) ──
    private val e2eTick = java.util.concurrent.Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "parvane-e2e").apply { isDaemon = true } }
    @Volatile private var lastE2eCmd = ""
    private fun startE2eHook() {
        val f = java.io.File("/data/local/tmp/parvane-e2e-cmd")
        e2eTick.scheduleWithFixedDelay({
            try {
                if (!f.canRead()) return@scheduleWithFixedDelay
                // adbd эмулятора — root, файл после `adb push` принадлежит root и приложением не удаляется:
                // без дедупа по (mtime, текст) команда выполнялась каждые 3 с (повторные send/folder, 27 сен 2026)
                val text = f.readText(); val key = "${f.lastModified()}:$text"
                if (key == lastE2eCmd) return@scheduleWithFixedDelay
                lastE2eCmd = key
                val cmd = JSONObject(text); f.delete()
                val chatId = store.ensurePeer(cmd.optString("peer")).second.id
                val r: TdApi.Object = when (cmd.optString("op")) {
                    "ttl" -> handle(TdApi.SetChatMessageAutoDeleteTime(chatId, cmd.optInt("secs")))
                    "send" -> handle(TdApi.SendMessage(chatId, null, null, null, null, TdApi.InputMessageText(TdApi.FormattedText(cmd.optString("text"), arrayOf()), null, false)))
                    "schedule" -> handle(TdApi.SendMessage(chatId, null, null, TdApi.MessageSendOptions().apply { schedulingState = TdApi.MessageSchedulingStateSendAtDate(cmd.optInt("due"), 0) }, null,
                        TdApi.InputMessageText(TdApi.FormattedText(cmd.optString("text"), arrayOf()), null, false)))
                    "draft" -> handle(TdApi.SetChatDraftMessage(chatId, null, cmd.optString("text").takeIf { it.isNotEmpty() }?.let { t -> TdApi.DraftMessage(null, 0, TdApi.DraftMessageContentText(TdApi.FormattedText(t, arrayOf()), null), 0L, null) })) // пустой текст — снять черновик
                    "archive" -> handle(TdApi.AddChatToList(chatId, if (cmd.optBoolean("on")) TdApi.ChatListArchive() else TdApi.ChatListMain()))
                    "folder" -> handle(TdApi.CreateChatFolder(TdApi.ChatFolder(TdApi.ChatFolderName(TdApi.FormattedText(cmd.optString("title", "Work"), arrayOf()), false),
                        TdApi.ChatFolderIcon("💼"), 3, false, LongArray(0), longArrayOf(chatId), LongArray(0), false, false, false, false, false, false, false, false)))
                    "resolve" -> { resolvedAt.remove(cmd.optString("peer")); resolveLater(cmd.optString("peer")); TdApi.Ok() }
                    "birthday" -> handle(TdApi.SetBirthdate(TdApi.Birthdate(cmd.optInt("day"), cmd.optInt("month"), cmd.optInt("year"))))
                    "search" -> handle(TdApi.SearchMessages(null, cmd.optString("query"), "", 50, null, null, 0, 0))
                    // голос в опросе по uuid сообщения — тот же путь, что тап по варианту в X (варианты рисуются на canvas, uiautomator их не видит)
                    "vote" -> store.messageByUuid(cmd.optString("uuid"))?.let { m -> handle(TdApi.SetPollAnswer(m.chatId, m.id, intArrayOf(cmd.optInt("option")))) } ?: TdApi.Error(404, "poll not found")
                    else -> TdApi.Error(400, "unknown op")
                }
                Log.i(TAG, "e2e-cmd ${cmd.optString("op")} → ${r.javaClass.simpleName}")
            } catch (e: Throwable) { Log.w(TAG, "e2e-cmd: ${e.message}") }
        }, 3, 3, java.util.concurrent.TimeUnit.SECONDS)
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

    /** Что можно делать с сообщением (паритет TDLib): своё — править (текст) и удалять у всех; чужое — только у себя. */
    fun messageProperties(chatId: Long, messageId: Long): TdApi.MessageProperties? {
        val uuid = store.uuidOf(chatId, messageId) ?: return null
        val m = store.messageByUuid(uuid) ?: return null
        val own = m.isOutgoing
        val text = m.content is TdApi.MessageText
        return TdApi.MessageProperties(
            false, false, false, /*canBeCopied*/ true, false, false,
            /*canBeDeletedOnlyForSelf*/ true, /*canBeDeletedForAllUsers*/ own, /*canBeEdited*/ own && text,
            /*canBeForwarded*/ true, false, /*canBePinned*/ true, /*canBeReplied*/ true, false, /*canBeSaved*/ true,
            false, /*canDeleteReactions*/ false, false, false, false, false, false, false, false, false, false,
            /*canGetReadDate*/ false, false, false, false, false, false, false, false, false, false, false, false, false)
    }

    private fun forwardMessages(f: TdApi.ForwardMessages): TdApi.Object {
        val to = store.addressOf(f.chatId) ?: return TdApi.Error(404, "chat not found")
        val out = ArrayList<TdApi.Message>()
        for (mid in f.messageIds) {
            val uuid = store.uuidOf(f.fromChatId, mid) ?: continue
            val nid = ParvaneCore.forward(to, uuid) // событие message придёт синхронно → стор уже знает
            if (nid.isNotEmpty()) store.messageByUuid(nid)?.let { out += it }
        }
        return TdApi.Messages(out.size, out.toTypedArray())
    }

    private fun finishLogin(address: String): TdApi.Object =
        if (ParvaneCore.startSession()) { onSessionReady(address); TdApi.Ok() } else TdApi.Error(500, "не удалось поднять сессию")

    @Volatile private var twoFactorGeneration = 0
    private fun startTwoFactor(address: String, password: String, loginToken: String) {
        val info = try { ParvaneCore.serverInfo() } catch (e: Throwable) { JSONObject() }
        val link = "https://t.me/" + info.optString("telegram_bot") + "?start=" + loginToken
        setAuth(TdApi.AuthorizationStateWaitOtherDeviceConfirmation(link))
        openLink(link)
        val gen = ++twoFactorGeneration
        io.execute {
            val started = System.currentTimeMillis()
            while (gen == twoFactorGeneration && System.currentTimeMillis() - started < 14 * 60 * 1000L) {
                Thread.sleep(2000)
                if (!ParvaneCore.registerStatus(address, loginToken)) continue
                val r = ParvaneCore.login(address, password, loginToken)
                if (r.optBoolean("ok")) { sessionPassword = password; finishLogin(r.optString("address")) }
                else { Log.w(TAG, "2FA: ${r.optString("error")}"); setAuth(TdApi.AuthorizationStateWaitPassword("", false, false, "")) }
                return@execute
            }
            if (gen == twoFactorGeneration) setAuth(TdApi.AuthorizationStateWaitPassword("", false, false, ""))
        }
    }
    private fun openLink(url: String) {
        try {
            val ctx = Class.forName("android.app.ActivityThread").getMethod("currentApplication").invoke(null) as? android.content.Context ?: return
            ctx.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url)).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Throwable) { Log.w(TAG, "открыть ссылку: ${e.message}") }
    }

    /** Устройства identity как TdApi.Session; id сессии = FNV от device_id (для TerminateSession). */
    private val deviceById = ConcurrentHashMap<Long, String>()
    private fun sessionsList(): Array<TdApi.Session> {
        val arr = try { ParvaneCore.listDevices() } catch (e: Throwable) { org.json.JSONArray() }
        val out = ArrayList<TdApi.Session>()
        for (i in 0 until arr.length()) {
            val d = arr.getJSONObject(i)
            val dev = d.optString("device_id"); if (dev.isEmpty()) continue
            val id = store.idOf("dev:$dev"); deviceById[id] = dev
            val ts = d.optLong("updated_at").toInt()
            val current = d.optBoolean("current")
            out += TdApi.Session(id, current, false, false, false, false,
                if (current) TdApi.SessionDeviceTypeAndroid() else TdApi.SessionDeviceTypeUnknown(),
                0, "Parvane", if (current) "android" else "", true, dev.take(10), "", "", ts, ts, "", "")
        }
        return out.sortedByDescending { it.isCurrent }.toTypedArray()
    }

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
            announceScheduled(chat.id)
            if (chat.draftMessage != null) Log.i(TAG, "черновик ${chat.id} восстановлен")
            if (store.local?.isArchived(chat.id) == true) Log.i(TAG, "позиция ${chat.id}: archive")
        }
        if (!store.hasProfile(address) || profileStale(address)) resolveLater(address)
    }

    // conformance PROFILE-1 (spec 005): профиль перечитывается по TTL (10 мин; для e2e —
    // /data/local/tmp/parvane-profile-ttl в мс), а не один раз за сессию; тик раз в 60 с
    private val resolvedAt = ConcurrentHashMap<String, Long>()
    private val profileTtlMs: Long = java.io.File("/data/local/tmp/parvane-profile-ttl").takeIf { it.canRead() }
        ?.readText()?.trim()?.toLongOrNull() ?: (10L * 60 * 1000)
    private fun profileStale(address: String): Boolean = (System.currentTimeMillis() - (resolvedAt[address] ?: 0L)) > profileTtlMs
    private val profileTick = java.util.concurrent.Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "parvane-profile-ttl").apply { isDaemon = true } }.also { ex ->
        ex.scheduleWithFixedDelay({
            try {
                if (detached || store.self.isEmpty()) return@scheduleWithFixedDelay
                for (id in store.knownUserIds()) { val a = store.addressOf(id) ?: continue; if (profileStale(a)) resolveLater(a) }
                if (profileStale(store.self)) resolveLater(store.self)
            } catch (e: Throwable) { Log.w(TAG, "profile tick: ${e.message}") }
        }, 60, 60, java.util.concurrent.TimeUnit.SECONDS)
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
                    resolvedAt[a] = System.currentTimeMillis()
                    Log.i(TAG, "профиль $a: birthday=${u.optString("birthday")} color=${u.optInt("name_color", -1)} phone=${u.optString("phone")}")
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
                if (PollStore.isService(content.optString("kind"))) { onPollService(content, from); return }
                // conformance GROUP-2: запрещённый вид от участника без роли — не показываем
                // (владелец/админ/self/неизвестная роль — показываем; оценка при приёме)
                if (event.optBoolean("group") && !out) {
                    val g = store.group(to)
                    if (store.roleOf(g, from) == "member"
                        && !ParvaneStore.isContentAllowedForMember(g?.permissions, content.optString("kind", "text"), ParvaneStore.contentHasLink(content))) {
                        Log.i(TAG, "групповое ${event.optString("id")} (${content.optString("kind")}) от $from скрыто правами группы")
                        return
                    }
                }
                val msg = store.putMessage(
                    event.optString("id"), from, to, event.optLong("ts"), content, out,
                    read = event.optBoolean("read"), replyUuid = if (event.isNull("reply_to")) null else event.optString("reply_to").ifEmpty { null },
                    edited = event.optBoolean("edited"), pinned = event.optBoolean("pinned"),
                    reactions = event.optJSONArray("reactions"),
                ) ?: return
                stickers.onReceived(content) // spec 005: pack_ref/emoji_packs → индекс паков, gif → сохранённые
                if (content.optString("kind") == "poll") Log.i(TAG, "опрос ${event.optString("id")}: ${store.polls.get(event.optString("id"))?.options?.size ?: 0} вариантов")
                armTtl(msg, event.optString("id"), content) // spec 005: ttl_secs → таймер и удаление в срок
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
            // Изменение группы (spec 003, GROUP-1): перечитать группы — сведения
            // применяются по ревизии; неизвестный вид изменения — тоже перечитать
            "group" -> {
                val change = event.optString("change")
                Log.i(TAG, "группа ${event.optString("group_id")}: $change v${event.optLong("version")}")
                syncGroups()
                // spec 004: ссылки изменились — обновить основную в BasicGroupFullInfo (если уже читали)
                if (change == "invites") store.group(event.optString("group_id"))?.takeIf { it.primaryInviteLink != null }?.let { refreshPrimaryLink(it) }
            }
            "link" -> {
                // P-46: код сверки НЕ в logcat — только в UI через сервисное уведомление.
                val state = event.optString("state")
                Log.i(TAG, "линковка: $state")
                val text = when (state) {
                    "offered" -> "Перенос истории: откройте Настройки → Устройства на другом устройстве — код сверки появится на обоих."
                    "code" -> "Перенос истории. Сверьте код на другом устройстве и подтвердите там:\n${event.optString("code")}"
                    "imported" -> "История перенесена (${event.optInt("count")} сообщений)."
                    else -> null
                }
                text?.let {
                    postUpdate(TdApi.UpdateServiceNotification("parvane_link_$state",
                        TdApi.MessageText(TdApi.FormattedText(it, arrayOf()), null, null)))
                }
            }
            "session" -> if (event.optString("state") == "failed") {
                Log.w(TAG, "сессия: ${event.optString("error")}")
                if (event.optString("reason") == "auth") sessionExpired()
            }
            // spec 005 / FAIL-1: rate_limited на publish → последнее исходящее «не отправлено» (честно, без своих тостов)
            "error" -> if (event.optString("code") == "rate_limited") {
                Log.i(TAG, "gateway rate_limited (${event.optString("subject")})")
                val uuid = lastSentUuid
                val msg = if (uuid.isEmpty()) null else store.messageByUuid(uuid)
                if (msg != null) postUpdate(TdApi.UpdateMessageSendFailed(msg, msg.id, TdApi.Error(429, uiText("rate_limited"))))
            } else Log.w(TAG, "ядро: ${event.optString("text")}")
            "connection" -> postUpdate(TdApi.UpdateConnectionState(if (event.optString("state") == "ready") TdApi.ConnectionStateReady() else TdApi.ConnectionStateConnecting()))
        }
    }
}
