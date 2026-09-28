package org.parvane.core

import android.util.Log
import org.json.JSONObject

/**
 * Parvane: тонкая обёртка над libparvane_jni.so (parvane-core под NDK).
 * Все native-вызовы блокирующие (сеть) — звать с фонового потока. События
 * ядра приходят в [onEvent] с нативных потоков и раздаются подписчикам как есть.
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

    /** Вызывается из JNI (любой поток). */
    @JvmStatic
    fun onEvent(json: String) {
        val event = try {
            JSONObject(json)
        } catch (e: Exception) {
            Log.w(TAG, "битое событие ядра: $json")
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

    // P-13: локальное хранилище ядра (Olm-pickle, сессии, JWT, кэш расшифровки,
    // журнал) шифруется случайным ключом, завёрнутым ключом Android Keystore.
    fun init(gatewayUrl: String, storeDir: String) =
        nativeInit(gatewayUrl, storeDir, StoreKey.load(java.io.File(storeDir)))
    fun serverDomain(): String = nativeServerDomain()
    fun login(user: String, password: String, loginToken: String = ""): JSONObject = JSONObject(nativeLogin(user, password, loginToken))
    // identity: сервер/регистрация/подтверждение (зовёт и Java-оверлей X: ParvaneRegisterController)
    @JvmStatic fun serverInfo(): JSONObject = JSONObject(nativeServerInfo())
    @JvmStatic fun register(user: String, password: String, email: String): JSONObject = JSONObject(nativeRegister(user, password, email))
    @JvmStatic fun registerStatus(user: String, token: String): Boolean = nativeRegisterStatus(user, token)
    @JvmStatic fun confirmEmail(user: String, code: String): JSONObject = JSONObject(nativeConfirmEmail(user, code))
    // устройства аккаунта
    fun listDevices(): org.json.JSONArray = org.json.JSONArray(nativeListDevices())
    /** P-07: отзыв устройства требует текущий пароль; без него сервер откажет. */
    fun revokeDevice(deviceId: String, password: String = ""): Boolean = nativeRevokeDevice(deviceId, password)
    // копия ключей под паролем (формат веба); import → число записей, −1 пароль/файл, −2 E2E не готов
    @JvmStatic fun exportKeys(password: String): String = nativeExportKeys(password)
    @JvmStatic fun importKeys(fileJson: String, password: String): Int = nativeImportKeys(fileJson, password)
    fun forward(to: String, uuid: String): String = nativeForward(to, uuid)
    fun startSession(): Boolean = nativeStartSession()
    fun sendText(to: String, text: String): String = nativeSendText(to, text)
    fun sendContent(to: String, contentJson: String, replyTo: String): String = nativeSendContent(to, contentJson, replyTo)
    fun sendMedia(to: String, path: String, contentJson: String, replyTo: String): String = nativeSendMedia(to, path, contentJson, replyTo)
    /** Блокирующая загрузка блоба из cloud (звать с io-потока); "" — ошибка. */
    fun downloadFile(fileId: String, key: String, nonce: String): String = nativeDownloadFile(fileId, key, nonce)
    fun sendTyping(to: String) = nativeSendTyping(to)
    fun edit(uuid: String, to: String, contentJson: String): Boolean = nativeEdit(uuid, to, contentJson)
    fun delete(uuid: String): Boolean = nativeDelete(uuid)
    fun react(uuid: String, emoji: String): Boolean = nativeReact(uuid, emoji)
    fun pin(uuid: String, pinned: Boolean): Boolean = nativePin(uuid, pinned)
    fun listGroups(): org.json.JSONArray = org.json.JSONArray(nativeListGroups())
    fun setNotify(blob: String): Boolean = nativeSetNotify(blob)
    fun clearMessages(uuids: List<String>): Boolean = nativeClearMessages(org.json.JSONArray(uuids).toString())
    fun replayJournal() = nativeReplayJournal()
    fun setProfile(fieldsJson: String): Boolean = nativeSetProfile(fieldsJson)
    /** Аватар в cloud + identity; вернёт file_id или "". */
    fun setAvatar(path: String): String = nativeSetAvatar(path)
    fun createGroup(name: String, kind: String, members: List<String>): String =
        nativeCreateGroup(name, kind, org.json.JSONArray(members).toString())
    /** add|remove|rename|leave|remove_group|admin|member|ban|unban; "" — ок, иначе текст ошибки. */
    fun groupAction(groupId: String, action: String, arg: String): String = nativeGroupAction(groupId, action, arg)
    // spec 004: управление группой — ответы сервера JSON {ok, error, error_code, …}
    fun groupSetInfo(groupId: String, about: String?, clearAvatar: Boolean): JSONObject = JSONObject(nativeGroupSetInfo(groupId, about, clearAvatar))
    fun groupSetPhoto(groupId: String, path: String): JSONObject = JSONObject(nativeGroupSetPhoto(groupId, path))
    fun groupSetPerms(groupId: String, permsJson: String): JSONObject = JSONObject(nativeGroupSetPerms(groupId, permsJson))
    /** rightsJson == null — снять админа. */
    fun groupSetAdmin(groupId: String, member: String, rightsJson: String?): JSONObject = JSONObject(nativeGroupSetAdmin(groupId, member, rightsJson))
    fun groupInvites(groupId: String, revoked: Boolean): JSONObject = JSONObject(nativeGroupInvites(groupId, revoked))
    fun groupInviteCreate(groupId: String, title: String, expiresAt: Long, maxUses: Int, requestNeeded: Boolean): JSONObject =
        JSONObject(nativeGroupInviteCreate(groupId, title, expiresAt, maxUses, requestNeeded))
    fun groupInviteRevoke(groupId: String, token: String): JSONObject = JSONObject(nativeGroupInviteRevoke(groupId, token))
    fun groupInviteDelete(groupId: String, token: String): JSONObject = JSONObject(nativeGroupInviteDelete(groupId, token))
    fun groupInviteCheck(token: String): JSONObject = JSONObject(nativeGroupInviteCheck(token))
    fun groupJoin(token: String): JSONObject = JSONObject(nativeGroupJoin(token))
    fun groupRequests(groupId: String): JSONObject = JSONObject(nativeGroupRequests(groupId))
    fun groupRequestDecide(groupId: String, member: String, approve: Boolean): JSONObject = JSONObject(nativeGroupRequestDecide(groupId, member, approve))
    fun resolve(addresses: List<String>): JSONObject =
        JSONObject(nativeResolve(org.json.JSONArray(addresses).toString()))
    fun search(query: String): JSONObject = JSONObject(nativeSearch(query))
    fun markRead(uuid: String) = nativeMarkRead(uuid)
    // spec 005: паки (PVPK1/PACK-1), превью ссылок, тайлы карты, забыть сообщение (TTL)
    fun packFetch(refJson: String): JSONObject = JSONObject(nativePackFetch(refJson))
    fun packRefFor(dir: String, rawName: String, recipients: List<String>): JSONObject =
        JSONObject(nativePackRefFor(dir, rawName, org.json.JSONArray(recipients).toString()))
    fun previewFetch(url: String, timeoutMs: Int): JSONObject = JSONObject(nativePreviewFetch(url, timeoutMs))
    fun mapTile(z: Int, x: Int, y: Int): ByteArray = nativeMapTile(z, x, y) ?: ByteArray(0)
    fun forget(uuid: String, fileId: String) = nativeForget(uuid, fileId)
    fun self(): String = nativeSelf()
    fun logout() = nativeLogout()
    fun sessionExpired() = nativeSessionExpired()

    @JvmStatic private external fun nativeInit(gatewayUrl: String, storeDir: String, storeKey: ByteArray)
    @JvmStatic private external fun nativeServerDomain(): String
    @JvmStatic private external fun nativeLogin(user: String, password: String, loginToken: String): String
    @JvmStatic private external fun nativeServerInfo(): String
    @JvmStatic private external fun nativeRegister(user: String, password: String, email: String): String
    @JvmStatic private external fun nativeRegisterStatus(user: String, token: String): Boolean
    @JvmStatic private external fun nativeConfirmEmail(user: String, code: String): String
    @JvmStatic private external fun nativeListDevices(): String
    @JvmStatic private external fun nativeRevokeDevice(deviceId: String, password: String): Boolean
    @JvmStatic private external fun nativeExportKeys(password: String): String
    @JvmStatic private external fun nativeImportKeys(fileJson: String, password: String): Int
    @JvmStatic private external fun nativeForward(to: String, uuid: String): String
    @JvmStatic private external fun nativeStartSession(): Boolean
    @JvmStatic private external fun nativeSendText(to: String, text: String): String
    @JvmStatic private external fun nativeSendContent(to: String, contentJson: String, replyTo: String): String
    @JvmStatic private external fun nativeSendMedia(to: String, path: String, contentJson: String, replyTo: String): String
    @JvmStatic private external fun nativeDownloadFile(fileId: String, key: String, nonce: String): String
    @JvmStatic private external fun nativeSendTyping(to: String)
    @JvmStatic private external fun nativeEdit(uuid: String, to: String, contentJson: String): Boolean
    @JvmStatic private external fun nativeDelete(uuid: String): Boolean
    @JvmStatic private external fun nativeReact(uuid: String, emoji: String): Boolean
    @JvmStatic private external fun nativePin(uuid: String, pinned: Boolean): Boolean
    @JvmStatic private external fun nativeListGroups(): String
    @JvmStatic private external fun nativeSetNotify(blob: String): Boolean
    @JvmStatic private external fun nativeClearMessages(idsJson: String): Boolean
    @JvmStatic private external fun nativeReplayJournal()
    @JvmStatic private external fun nativeSetProfile(fieldsJson: String): Boolean
    @JvmStatic private external fun nativeSetAvatar(path: String): String
    @JvmStatic private external fun nativeCreateGroup(name: String, kind: String, membersJson: String): String
    @JvmStatic private external fun nativeGroupAction(groupId: String, action: String, arg: String): String
    @JvmStatic private external fun nativeGroupSetInfo(groupId: String, about: String?, clearAvatar: Boolean): String
    @JvmStatic private external fun nativeGroupSetPhoto(groupId: String, path: String): String
    @JvmStatic private external fun nativeGroupSetPerms(groupId: String, permsJson: String): String
    @JvmStatic private external fun nativeGroupSetAdmin(groupId: String, member: String, rightsJson: String?): String
    @JvmStatic private external fun nativeGroupInvites(groupId: String, revoked: Boolean): String
    @JvmStatic private external fun nativeGroupInviteCreate(groupId: String, title: String, expiresAt: Long, maxUses: Int, requestNeeded: Boolean): String
    @JvmStatic private external fun nativeGroupInviteRevoke(groupId: String, token: String): String
    @JvmStatic private external fun nativeGroupInviteDelete(groupId: String, token: String): String
    @JvmStatic private external fun nativeGroupInviteCheck(token: String): String
    @JvmStatic private external fun nativeGroupJoin(token: String): String
    @JvmStatic private external fun nativeGroupRequests(groupId: String): String
    @JvmStatic private external fun nativeGroupRequestDecide(groupId: String, member: String, approve: Boolean): String
    @JvmStatic private external fun nativeResolve(addressesJson: String): String
    @JvmStatic private external fun nativeSearch(query: String): String
    @JvmStatic private external fun nativeMarkRead(uuid: String)
    @JvmStatic private external fun nativePackFetch(refJson: String): String
    @JvmStatic private external fun nativePackRefFor(dir: String, rawName: String, recipientsJson: String): String
    @JvmStatic private external fun nativePreviewFetch(url: String, timeoutMs: Int): String
    @JvmStatic private external fun nativeMapTile(z: Int, x: Int, y: Int): ByteArray?
    @JvmStatic private external fun nativeForget(uuid: String, fileId: String)
    @JvmStatic private external fun nativeSelf(): String
    @JvmStatic private external fun nativeLogout()
    @JvmStatic private external fun nativeSessionExpired()
}
