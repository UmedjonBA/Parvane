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

    fun init(gatewayUrl: String, storeDir: String) = nativeInit(gatewayUrl, storeDir)
    fun serverDomain(): String = nativeServerDomain()
    fun login(user: String, password: String): JSONObject = JSONObject(nativeLogin(user, password))
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
    /** add|remove|rename|leave|remove_group; "" — ок, иначе текст ошибки. */
    fun groupAction(groupId: String, action: String, arg: String): String = nativeGroupAction(groupId, action, arg)
    fun resolve(addresses: List<String>): JSONObject =
        JSONObject(nativeResolve(org.json.JSONArray(addresses).toString()))
    fun search(query: String): JSONObject = JSONObject(nativeSearch(query))
    fun markRead(uuid: String) = nativeMarkRead(uuid)
    fun self(): String = nativeSelf()
    fun logout() = nativeLogout()

    @JvmStatic private external fun nativeInit(gatewayUrl: String, storeDir: String)
    @JvmStatic private external fun nativeServerDomain(): String
    @JvmStatic private external fun nativeLogin(user: String, password: String): String
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
    @JvmStatic private external fun nativeResolve(addressesJson: String): String
    @JvmStatic private external fun nativeSearch(query: String): String
    @JvmStatic private external fun nativeMarkRead(uuid: String)
    @JvmStatic private external fun nativeSelf(): String
    @JvmStatic private external fun nativeLogout()
}
