package org.parvane.core

import org.json.JSONArray
import org.json.JSONObject

/**
 * Parvane: звонки (spec 031) — сигналы и состояние ведут менеджеры ядра (CallManager, GroupCallManager mesh ≤ 8),
 * медиа — [MediaEngine] на org.webrtc из состава Telegram X (ставит оверлей X при старте приложения). JNI зовёт
 * `media*` по числовому дескриптору соединения; ответы движка — `onLocal*`. События звонков — `call`/`group_call`
 * через [ParvaneCore.addListener].
 */
object ParvaneCalls {
    /** Медиа одного P2P-соединения; все методы — без блокировки (ответы — через onLocal*). */
    interface MediaEngine {
        fun create(handle: Long)
        fun createOffer(handle: Long)
        fun acceptOffer(handle: Long, sdp: String)
        fun setRemoteAnswer(handle: Long, sdp: String)
        fun addIce(handle: Long, candidate: String, mid: String, index: Int)
        fun setVideo(handle: Long, on: Boolean)
        fun setMuted(handle: Long, muted: Boolean)
        fun close(handle: Long)
    }

    @Volatile var engine: MediaEngine? = null

    init {
        ParvaneCore // libparvane_jni.so загружена
        nativeInit()
    }

    /** {"servers":[{urls,username,credential}],"ttl"} — call.ice_config; блокирующий. */
    fun iceConfig(): JSONObject = JSONObject(nativeIceConfig())
    fun place(peer: String, video: Boolean) = nativePlace(peer, video)
    fun accept() = nativeAccept()
    fun hangup() = nativeHangup()
    fun setMuted(muted: Boolean, videoOff: Boolean) = nativeSetMuted(muted, videoOff)
    fun groupStart(participants: List<String>, video: Boolean, group: String, title: String) =
        nativeGroupStart(JSONArray(participants).toString(), video, group, title)
    fun groupLeave() = nativeGroupLeave()
    /** UUID текущего личного звонка ("" — нет). */
    fun callId(): String = nativeCallId()
    /** «Звонки — никто» (FR-040): входящие отклоняются без звонка. */
    fun setCallsNobody(nobody: Boolean) = nativeSetCallsNobody(nobody)

    // движок → ядро
    fun onLocalOffer(handle: Long, sdp: String) = nativeLocalOffer(handle, sdp)
    fun onLocalAnswer(handle: Long, sdp: String) = nativeLocalAnswer(handle, sdp)
    fun onLocalIce(handle: Long, candidate: String, mid: String, index: Int) = nativeLocalIce(handle, candidate, mid, index)
    fun onConnection(handle: Long, connected: Boolean) = nativeConnection(handle, connected)

    // ядро → движок (JNI, любой поток)
    @JvmStatic fun mediaCreate(handle: Long) { engine?.create(handle) }
    @JvmStatic fun mediaCreateOffer(handle: Long) { engine?.createOffer(handle) ?: nativeConnection(handle, false) }
    @JvmStatic fun mediaAcceptOffer(handle: Long, sdp: String) { engine?.acceptOffer(handle, sdp) ?: nativeConnection(handle, false) }
    @JvmStatic fun mediaSetRemoteAnswer(handle: Long, sdp: String) { engine?.setRemoteAnswer(handle, sdp) }
    @JvmStatic fun mediaAddIce(handle: Long, candidate: String, mid: String, index: Int) { engine?.addIce(handle, candidate, mid, index) }
    @JvmStatic fun mediaSetVideo(handle: Long, on: Boolean) { engine?.setVideo(handle, on) }
    @JvmStatic fun mediaSetMuted(handle: Long, muted: Boolean) { engine?.setMuted(handle, muted) }
    @JvmStatic fun mediaClose(handle: Long) { engine?.close(handle) }

    @JvmStatic private external fun nativeInit()
    @JvmStatic private external fun nativeIceConfig(): String
    @JvmStatic private external fun nativePlace(peer: String, video: Boolean)
    @JvmStatic private external fun nativeAccept()
    @JvmStatic private external fun nativeHangup()
    @JvmStatic private external fun nativeSetMuted(muted: Boolean, videoOff: Boolean)
    @JvmStatic private external fun nativeGroupStart(participantsJson: String, video: Boolean, group: String, title: String)
    @JvmStatic private external fun nativeGroupLeave()
    @JvmStatic private external fun nativeCallId(): String
    @JvmStatic private external fun nativeSetCallsNobody(nobody: Boolean)
    @JvmStatic private external fun nativeLocalOffer(handle: Long, sdp: String)
    @JvmStatic private external fun nativeLocalAnswer(handle: Long, sdp: String)
    @JvmStatic private external fun nativeLocalIce(handle: Long, sdp: String, mid: String, index: Int)
    @JvmStatic private external fun nativeConnection(handle: Long, connected: Boolean)
}
