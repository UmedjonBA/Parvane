package org.parvane.core

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * Parvane: тонкая обёртка над libparvane_jni.sо (parvane-core под NDK, только протокол v2 — spec 031).
 * Все native-вызовы блокирующие (сеть) — звать с фонового потока. События ядра приходят в [onEvent] с
 * отдельного потока очереди JNI (по порядку) и раздаются подписчикам как есть.
 * Отказы — JSON с `error_code` (ERROR_CODE_* протокола или короткий код); текст на языке интерфейса подставляет шов.
 */
object ParvaneCore {
    private const val TAG = "ParvaneCore"

    init {
        System.loadLibrary("parvane_jni")
    }

    fun interface Listener {
        fun onEvent(event: JSONObject)
    }

    @Volatile
    private var listeners: List<Listener> = emptyList()

    @Synchronized
    fun addListener(listener: Listener) {
        listeners = listeners + listener
    }

    @Synchronized
    fun removeListener(listener: Listener) {
        listeners = listeners - listener
    }

    /** Вызывается из JNI (поток очереди событий). */
    @JvmStatic
    fun onEvent(json: String) {
        val event = try {
            JSONObject(json)
        } catch (e: Exception) {
            Log.w(TAG, "битое событие ядра")
            return
        }
        listeners.forEach { l ->
            try {
                l.onEvent(event)
            } catch (e: Throwable) { // и Error: JNI-каллбэк молча чистит исключение
                Log.e(TAG, "событие ${event.optString("type")}", e)
            }
        }
    }

    // P-13: локальное хранилище ядра шифруется случайным ключом, завёрнутым ключом Android Keystore.
    // debug — сборка с dev-хуками (без ключа хранилища пишет открыто только она; release без ключа — не пишет).
    fun init(gatewayUrl: String, storeDir: String, debug: Boolean) =
        nativeInit(gatewayUrl, storeDir, StoreKey.load(java.io.File(storeDir)), debug)

    // ── вход и аккаунт ───────────────────────────────────────────────────────
    /** {ok, address, error_code, twofa_required, login_token, telegram_bot, confirm_required, deletion_at_ms} */
    fun login(user: String, password: String, loginToken: String = "", cancelDeletion: Boolean = false): JSONObject =
        JSONObject(nativeLogin(user, password, loginToken, cancelDeletion))
    @JvmStatic fun serverInfo(): JSONObject = JSONObject(nativeServerInfo())
    @JvmStatic fun register(user: String, password: String, email: String): JSONObject = JSONObject(nativeRegister(user, password, email))
    @JvmStatic fun registerStatus(user: String, token: String): Boolean = nativeRegisterStatus(user, token)
    @JvmStatic fun confirmEmail(user: String, code: String): JSONObject = JSONObject(nativeConfirmEmail(user, code))
    fun startSession(): Boolean = nativeStartSession()
    fun networkAvailable() = nativeNetworkAvailable()
    /** {"ready","needsLinking","engine","self","reconnectAttempts"} */
    fun status(): JSONObject = JSONObject(nativeStatus())
    fun self(): String = nativeSelf()
    /** Выход (NAT-16): устройство уходит из журнала устройств, данные устройства стираются. Блокирующий. */
    fun logout() = nativeLogout()
    /** FAIL-1: сессия истекла/отозвана — сняты только учётные данные. */
    fun sessionExpired() = nativeSessionExpired()
    @JvmStatic fun renameAccount(nick: String, password: String, recoveryKey: String): JSONObject =
        JSONObject(nativeRenameAccount(nick, password, recoveryKey))
    @JvmStatic fun deleteAccount(password: String): JSONObject = JSONObject(nativeDeleteAccount(password))

    // ── устройства, привязка, ключ восстановления ────────────────────────────
    /** {"devices":[{device_id, client_kind, last_seen_ms, current, in_log}], rotation_needed, escrow_missing, …} */
    @JvmStatic fun listDevices(): JSONObject = JSONObject(nativeListDevices())
    /** rotate=false — обычный выход на том устройстве; true — со сменой ключей (пароль). */
    @JvmStatic fun revokeDevice(deviceId: String, password: String, rotate: Boolean): JSONObject =
        JSONObject(nativeRevokeDevice(deviceId, password, rotate))
    @JvmStatic fun reportDeviceStolen(deviceId: String): Boolean = nativeReportDeviceStolen(deviceId)
    @JvmStatic fun linkGrant(deviceId: String): Boolean = nativeLinkGrant(deviceId)
    /** «Отклонить» запрос нового устройства: выдать ему грант больше нельзя. */
    @JvmStatic fun linkDecline(deviceId: String) = nativeLinkDecline(deviceId)
    @JvmStatic fun telegramRecovery(again: Boolean) = nativeTelegramRecovery(again)
    @JvmStatic fun recoverWithKey(key: String): String = nativeRecoverWithKey(key)
    @JvmStatic fun rotateSsk(key: String): String = nativeRotateSsk(key)
    // копия ключей формата 2 (как web): import → 1 ок, −1 пароль/файл, −2 не формат 2
    @JvmStatic fun exportKeys(password: String): String = nativeExportKeys(password)
    @JvmStatic fun importKeys(fileJson: String, password: String): Int = nativeImportKeys(fileJson, password)

    // ── переписка ────────────────────────────────────────────────────────────
    fun sendContent(to: String, contentJson: String, replyTo: String): String = nativeSendContent(to, contentJson, replyTo)
    fun sendMedia(to: String, path: String, contentJson: String, replyTo: String): String = nativeSendMedia(to, path, contentJson, replyTo)
    /** Пересылка в несколько чатов → {адрес: новый id | ""}. */
    fun forward(targets: List<String>, uuid: String): JSONObject = JSONObject(nativeForward(JSONArray(targets).toString(), uuid))
    fun forward(to: String, uuid: String): String = forward(listOf(to), uuid).optString(to)
    /** Вложение: кэш устройства или сеть → путь открытой копии ("" — ошибка). Блокирующий. */
    fun downloadFile(fileId: String, key: String, nonce: String, kind: String = "", sizeBytes: Long = 0): String =
        nativeDownloadFile(fileId, key, nonce, kind, sizeBytes)
    fun sendTyping(to: String) = nativeSendTyping(to)
    fun watchPeers(peers: List<String>) = nativeWatchPeers(JSONArray(peers).toString())
    fun edit(uuid: String, contentJson: String): Boolean = nativeEdit(uuid, contentJson)
    fun delete(uuid: String, forEveryone: Boolean = true): Boolean = nativeDelete(uuid, forEveryone)
    fun react(uuid: String, emoji: String): Boolean = nativeReact(uuid, emoji)
    fun pin(uuid: String, pinned: Boolean): Boolean = nativePin(uuid, pinned)
    fun markRead(uuid: String) = nativeMarkRead(uuid)
    fun forget(uuid: String, fileId: String) = nativeForget(uuid, fileId)
    /** «Удалить чат у себя»: граница в журнал состояния, сообщения чата — прочь локально. */
    fun clearChat(address: String, untilMs: Long, uuids: List<String>) = nativeClearChat(address, untilMs, JSONArray(uuids).toString())
    fun replayJournal() = nativeReplayJournal()

    // ── группы ───────────────────────────────────────────────────────────────
    fun listGroups(): JSONArray = JSONArray(nativeListGroups())
    fun createGroup(name: String, kind: String, members: List<String>): String =
        nativeCreateGroup(name, kind, JSONArray(members).toString())
    /** add|remove|rename|leave|remove_group|admin|member|ban|unban → {ok, error_code}. */
    fun groupAction(groupId: String, action: String, arg: String): JSONObject = JSONObject(nativeGroupAction(groupId, action, arg))
    fun groupSetInfo(groupId: String, name: String?, about: String?, clearAvatar: Boolean): JSONObject =
        JSONObject(nativeGroupSetInfo(groupId, name, about, clearAvatar))
    fun groupSetPhoto(groupId: String, path: String): JSONObject = JSONObject(nativeGroupSetPhoto(groupId, path))
    fun groupSetPerms(groupId: String, permsJson: String): JSONObject = JSONObject(nativeGroupSetPerms(groupId, permsJson))
    /** rightsJson == null — снять админа. */
    fun groupSetAdmin(groupId: String, member: String, rightsJson: String?): JSONObject = JSONObject(nativeGroupSetAdmin(groupId, member, rightsJson))
    fun groupInvites(groupId: String, revoked: Boolean): JSONObject = JSONObject(nativeGroupInvites(groupId, revoked))
    fun groupInviteCreate(groupId: String, title: String, expiresAt: Long, maxUses: Int, requestNeeded: Boolean): JSONObject =
        JSONObject(nativeGroupInviteCreate(groupId, title, expiresAt, maxUses, requestNeeded))
    fun groupInviteEdit(groupId: String, url: String, title: String, expiresAt: Long, maxUses: Int): JSONObject =
        JSONObject(nativeGroupInviteEdit(groupId, url, title, expiresAt, maxUses))
    fun groupInviteJoins(groupId: String, linkId: String): JSONObject = JSONObject(nativeGroupInviteJoins(groupId, linkId))
    fun groupInviteRevoke(groupId: String, url: String): JSONObject = JSONObject(nativeGroupInviteRevoke(groupId, url))
    fun groupInviteDelete(groupId: String, linkId: String): JSONObject = JSONObject(nativeGroupInviteDelete(groupId, linkId))
    fun groupInviteCheck(url: String): JSONObject = JSONObject(nativeGroupInviteCheck(url))
    fun groupJoin(url: String): JSONObject = JSONObject(nativeGroupJoin(url))
    fun groupRequests(groupId: String): JSONObject = JSONObject(nativeGroupRequests(groupId))
    fun groupRequestDecide(groupId: String, member: String, approve: Boolean, linkId: String = ""): JSONObject =
        JSONObject(nativeGroupRequestDecide(groupId, member, approve, linkId))
    // публичные группы и каналы (PUBLIC-1)
    fun publicCheckName(name: String): JSONObject = JSONObject(nativePublicCheckName(name))
    fun publicSearch(query: String): JSONArray = JSONArray(nativePublicSearch(query))
    fun publicResolve(name: String): JSONObject? = nativePublicResolve(name).takeIf { it != "null" }?.let { JSONObject(it) }
    /** "ok" | "taken" | "invalid" | "failed" */
    fun publicSet(groupId: String, isPublic: Boolean, name: String, preview: Boolean, history: Boolean): String =
        nativePublicSet(groupId, isPublic, name, preview, history)
    fun publicLoad(hex: String): JSONObject? = nativePublicLoad(hex).takeIf { it != "null" }?.let { JSONObject(it) }
    fun publicJoin(hex: String, secretHex: String): JSONObject? = nativePublicJoin(hex, secretHex).takeIf { it != "null" }?.let { JSONObject(it) }
    fun publicHistory(groupId: String, beforeSeq: Long): JSONObject? =
        nativePublicHistory(groupId, beforeSeq).takeIf { it != "null" }?.let { JSONObject(it) }
    // жалобы (REPORT-1)
    /** "sent" | "unavailable" | "failed" */
    fun submitReport(reportJson: String): String = nativeSubmitReport(reportJson)
    fun checkModReport(contentJson: String, reporter: String): JSONObject? =
        nativeCheckModReport(contentJson, reporter).takeIf { it != "null" }?.let { JSONObject(it) }

    // ── профили, поиск (FED-1) ───────────────────────────────────────────────
    fun resolve(addresses: List<String>): JSONObject = JSONObject(nativeResolve(JSONArray(addresses).toString()))
    fun search(query: String): JSONObject = JSONObject(nativeSearch(query))
    fun setProfile(fieldsJson: String): Boolean = nativeSetProfile(fieldsJson)
    /** Аватар (открытый блоб) + identity; вернёт file_id или "". */
    fun setAvatar(path: String): String = nativeSetAvatar(path)
    fun fingerprint(user: String): String = nativeFingerprint(user)

    // ── журнал личного состояния (STATE-1/2) ─────────────────────────────────
    fun stateAttach(localJson: String): JSONObject? = nativeStateAttach(localJson).takeIf { it.isNotEmpty() }?.let { JSONObject(it) }
    fun stateSync(desiredJson: String, kinds: List<String>): JSONObject? =
        nativeStateSync(desiredJson, JSONArray(kinds).toString()).takeIf { it.isNotEmpty() }?.let { JSONObject(it) }
    fun stateScheduledSent(opIdB64: String): Boolean = nativeStateScheduledSent(opIdB64)
    fun stateMarkSent(opIdB64: String) = nativeStateMarkSent(opIdB64)
    /** Запись журнала по имени (`callSet` — история звонков и т.п.). */
    fun stateCall(name: String, argsJson: String): Boolean = nativeStateCall(name, argsJson)
    /** Блокировка → отзыв доступа к доставке у собеседника (ACCESS-1). Блокирующий. */
    fun revokeContactAccess(peer: String): Boolean = nativeRevokeContactAccess(peer)
    fun setPrivacy(groupAddNobody: Boolean, strangersAllowed: Boolean): Boolean = nativeSetPrivacy(groupAddNobody, strangersAllowed)
    fun setCallsPresencePrivacy(callsNobody: Boolean, presenceNobody: Boolean): Boolean = nativeSetCallsPresencePrivacy(callsNobody, presenceNobody)
    fun l2Available(chat: String): Boolean = nativeL2Available(chat)
    fun setL2(chat: String, enabled: Boolean): JSONObject = JSONObject(nativeSetL2(chat, enabled))

    // ── хранилище, паки, превью, карта ───────────────────────────────────────
    fun storeRead(path: String): String = nativeStoreRead(path)
    fun storeWrite(path: String, text: String): Boolean = nativeStoreWrite(path, text)
    fun packFetch(refJson: String): JSONObject = JSONObject(nativePackFetch(refJson))
    fun packRefFor(dir: String, rawName: String): JSONObject = JSONObject(nativePackRefFor(dir, rawName))
    fun previewFetch(url: String, timeoutMs: Int): JSONObject = JSONObject(nativePreviewFetch(url, timeoutMs))
    fun mapTile(z: Int, x: Int, y: Int): ByteArray = nativeMapTile(z, x, y) ?: ByteArray(0)

    @JvmStatic private external fun nativeInit(gatewayUrl: String, storeDir: String, storeKey: ByteArray, debug: Boolean)
    @JvmStatic private external fun nativeLogin(user: String, password: String, loginToken: String, cancelDeletion: Boolean): String
    @JvmStatic private external fun nativeServerInfo(): String
    @JvmStatic private external fun nativeRegister(user: String, password: String, email: String): String
    @JvmStatic private external fun nativeRegisterStatus(user: String, token: String): Boolean
    @JvmStatic private external fun nativeConfirmEmail(user: String, code: String): String
    @JvmStatic private external fun nativeStartSession(): Boolean
    @JvmStatic private external fun nativeNetworkAvailable()
    @JvmStatic private external fun nativeStatus(): String
    @JvmStatic private external fun nativeSelf(): String
    @JvmStatic private external fun nativeLogout()
    @JvmStatic private external fun nativeSessionExpired()
    @JvmStatic private external fun nativeRenameAccount(nick: String, password: String, recoveryKey: String): String
    @JvmStatic private external fun nativeDeleteAccount(password: String): String
    @JvmStatic private external fun nativeListDevices(): String
    @JvmStatic private external fun nativeRevokeDevice(deviceId: String, password: String, rotate: Boolean): String
    @JvmStatic private external fun nativeReportDeviceStolen(deviceId: String): Boolean
    @JvmStatic private external fun nativeLinkGrant(deviceId: String): Boolean
    @JvmStatic private external fun nativeLinkDecline(deviceId: String)
    @JvmStatic private external fun nativeTelegramRecovery(again: Boolean)
    @JvmStatic private external fun nativeRecoverWithKey(key: String): String
    @JvmStatic private external fun nativeRotateSsk(key: String): String
    @JvmStatic private external fun nativeExportKeys(password: String): String
    @JvmStatic private external fun nativeImportKeys(fileJson: String, password: String): Int
    @JvmStatic private external fun nativeSendContent(to: String, contentJson: String, replyTo: String): String
    @JvmStatic private external fun nativeSendMedia(to: String, path: String, contentJson: String, replyTo: String): String
    @JvmStatic private external fun nativeForward(toJson: String, uuid: String): String
    @JvmStatic private external fun nativeDownloadFile(fileId: String, key: String, nonce: String, kind: String, sizeBytes: Long): String
    @JvmStatic private external fun nativeSendTyping(to: String)
    @JvmStatic private external fun nativeWatchPeers(peersJson: String)
    @JvmStatic private external fun nativeEdit(uuid: String, contentJson: String): Boolean
    @JvmStatic private external fun nativeDelete(uuid: String, forEveryone: Boolean): Boolean
    @JvmStatic private external fun nativeReact(uuid: String, emoji: String): Boolean
    @JvmStatic private external fun nativePin(uuid: String, pinned: Boolean): Boolean
    @JvmStatic private external fun nativeMarkRead(uuid: String)
    @JvmStatic private external fun nativeForget(uuid: String, fileId: String)
    @JvmStatic private external fun nativeClearChat(address: String, untilMs: Long, idsJson: String)
    @JvmStatic private external fun nativeReplayJournal()
    @JvmStatic private external fun nativeListGroups(): String
    @JvmStatic private external fun nativeCreateGroup(name: String, kind: String, membersJson: String): String
    @JvmStatic private external fun nativeGroupAction(groupId: String, action: String, arg: String): String
    @JvmStatic private external fun nativeGroupSetInfo(groupId: String, name: String?, about: String?, clearAvatar: Boolean): String
    @JvmStatic private external fun nativeGroupSetPhoto(groupId: String, path: String): String
    @JvmStatic private external fun nativeGroupSetPerms(groupId: String, permsJson: String): String
    @JvmStatic private external fun nativeGroupSetAdmin(groupId: String, member: String, rightsJson: String?): String
    @JvmStatic private external fun nativeGroupInvites(groupId: String, revoked: Boolean): String
    @JvmStatic private external fun nativeGroupInviteCreate(groupId: String, title: String, expiresAt: Long, maxUses: Int, requestNeeded: Boolean): String
    @JvmStatic private external fun nativeGroupInviteEdit(groupId: String, url: String, title: String, expiresAt: Long, maxUses: Int): String
    @JvmStatic private external fun nativeGroupInviteJoins(groupId: String, linkId: String): String
    @JvmStatic private external fun nativeGroupInviteRevoke(groupId: String, url: String): String
    @JvmStatic private external fun nativeGroupInviteDelete(groupId: String, linkId: String): String
    @JvmStatic private external fun nativeGroupInviteCheck(url: String): String
    @JvmStatic private external fun nativeGroupJoin(url: String): String
    @JvmStatic private external fun nativeGroupRequests(groupId: String): String
    @JvmStatic private external fun nativeGroupRequestDecide(groupId: String, member: String, approve: Boolean, linkId: String): String
    @JvmStatic private external fun nativePublicCheckName(name: String): String
    @JvmStatic private external fun nativePublicSearch(query: String): String
    @JvmStatic private external fun nativePublicResolve(name: String): String
    @JvmStatic private external fun nativePublicSet(groupId: String, isPublic: Boolean, name: String, preview: Boolean, history: Boolean): String
    @JvmStatic private external fun nativePublicLoad(hex: String): String
    @JvmStatic private external fun nativePublicJoin(hex: String, secretHex: String): String
    @JvmStatic private external fun nativePublicHistory(groupId: String, beforeSeq: Long): String
    @JvmStatic private external fun nativeSubmitReport(reportJson: String): String
    @JvmStatic private external fun nativeCheckModReport(contentJson: String, reporter: String): String
    @JvmStatic private external fun nativeResolve(addressesJson: String): String
    @JvmStatic private external fun nativeSearch(query: String): String
    @JvmStatic private external fun nativeSetProfile(fieldsJson: String): Boolean
    @JvmStatic private external fun nativeSetAvatar(path: String): String
    @JvmStatic private external fun nativeFingerprint(user: String): String
    @JvmStatic private external fun nativeStateAttach(localJson: String): String
    @JvmStatic private external fun nativeStateSync(desiredJson: String, kindsJson: String): String
    @JvmStatic private external fun nativeStateScheduledSent(opIdB64: String): Boolean
    @JvmStatic private external fun nativeStateMarkSent(opIdB64: String)
    @JvmStatic private external fun nativeStateCall(name: String, argsJson: String): Boolean
    @JvmStatic private external fun nativeRevokeContactAccess(peer: String): Boolean
    @JvmStatic private external fun nativeSetPrivacy(groupAddNobody: Boolean, strangersAllowed: Boolean): Boolean
    @JvmStatic private external fun nativeL2Available(chat: String): Boolean
    @JvmStatic private external fun nativeSetL2(chat: String, enabled: Boolean): String
    @JvmStatic private external fun nativeStoreRead(path: String): String
    @JvmStatic private external fun nativeStoreWrite(path: String, text: String): Boolean
    @JvmStatic private external fun nativePackFetch(refJson: String): String
    @JvmStatic private external fun nativeSetCallsPresencePrivacy(callsNobody: Boolean, presenceNobody: Boolean): Boolean
    @JvmStatic fun resetIdentity(password: String): String = nativeResetIdentity(password)
    fun packHash(dir: String): String = nativePackHash(dir)
    @JvmStatic private external fun nativeResetIdentity(password: String): String
    @JvmStatic private external fun nativePackHash(dir: String): String
    @JvmStatic private external fun nativePackRefFor(dir: String, rawName: String): String
    @JvmStatic private external fun nativePreviewFetch(url: String, timeoutMs: Int): String
    @JvmStatic private external fun nativeMapTile(z: Int, x: Int, y: Int): ByteArray?
}
