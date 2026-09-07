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
            } catch (e: Exception) {
                Log.e(TAG, "listener", e)
            }
        }
    }

    fun init(gatewayUrl: String, storeDir: String) = nativeInit(gatewayUrl, storeDir)
    fun serverDomain(): String = nativeServerDomain()
    fun login(user: String, password: String): JSONObject = JSONObject(nativeLogin(user, password))
    fun startSession(): Boolean = nativeStartSession()
    fun sendText(to: String, text: String): String = nativeSendText(to, text)
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
    @JvmStatic private external fun nativeResolve(addressesJson: String): String
    @JvmStatic private external fun nativeSearch(query: String): String
    @JvmStatic private external fun nativeMarkRead(uuid: String)
    @JvmStatic private external fun nativeSelf(): String
    @JvmStatic private external fun nativeLogout()
}
