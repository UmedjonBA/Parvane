package org.parvane.core

import org.json.JSONArray
import org.json.JSONObject

/**
 * Parvane: пробуждение в фоне (spec 031) — канал UnifiedPush регистрируется видом WEB_PUSH (ключи p256dh/auth —
 * от коннектора, сервер шлёт RFC 8291), будильники «Плана» — моменты пробуждения (текст — только на устройстве).
 * Блокирующие — с io-потока.
 */
object ParvanePush {
    const val KIND_WEB_PUSH = "WAKE_KIND_WEB_PUSH"
    const val KIND_UNIFIED_PUSH = "WAKE_KIND_UNIFIED_PUSH"

    init {
        ParvaneCore
    }

    /** {"vapid": base64 65 байт, "supported": [...]} | {"error_code"} */
    fun describe(): JSONObject = JSONObject(nativeDescribe())
    /** p256dh/auth — base64 (стандартный алфавит). */
    fun register(kind: String, endpoint: String, p256dh: String, auth: String): JSONObject =
        JSONObject(nativeRegister(kind, endpoint, p256dh, auth))
    /** Пустой endpoint — снять все каналы этого устройства. */
    fun unregister(endpoint: String): Boolean = nativeUnregister(endpoint)
    fun setAlarms(atMs: List<Long>): Boolean = nativeSetAlarms(JSONArray(atMs.take(64)).toString())

    @JvmStatic private external fun nativeDescribe(): String
    @JvmStatic private external fun nativeRegister(kind: String, endpoint: String, p256dh: String, auth: String): String
    @JvmStatic private external fun nativeUnregister(endpoint: String): Boolean
    @JvmStatic private external fun nativeSetAlarms(atMsJson: String): Boolean
}
