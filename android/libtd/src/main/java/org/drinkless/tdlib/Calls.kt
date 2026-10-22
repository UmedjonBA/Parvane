package org.drinkless.tdlib

import org.json.JSONObject

/**
 * Parvane (spec 031): звонки в шве — экран звонка Telegram X кормится объектами TDLib (TdApi.Call, UpdateCall), а
 * сигналы и медиа ведут ядро (CallManager) и org.webrtc (ParvaneCalls.MediaEngine). Здесь — чистое отображение
 * событий ядра `call` в состояния TDLib и запись звонка для журнала личного состояния (`callSet`, формат web
 * stateJournal.callToState). Без Android — для JVM-тестов.
 */
class Calls(private val idOf: (String) -> Long) {
    companion object {
        /** Начало разговора (мс) текущего звонка — для таймера экрана X (TGCallService, вместо tgcalls); 0 — нет. */
        @JvmStatic @Volatile var connectedAtMs = 0L
        /** Длительность разговора для экрана X; −1 — неизвестна (как VoIPInstance.DURATION_UNKNOWN). */
        @JvmStatic fun durationMs(): Long = connectedAtMs.takeIf { it > 0 }?.let { System.currentTimeMillis() - it } ?: -1L
    }

    class Active(val id: Int, val peer: String, val outgoing: Boolean, val video: Boolean, val startedMs: Long) {
        @Volatile var callUuid: String = ""
        @Volatile var connectedMs: Long = 0
        @Volatile var declined = false
        @Volatile var state: TdApi.CallState = TdApi.CallStatePending(true, false)
    }

    private var nextId = 0
    @Volatile var current: Active? = null
        private set

    private val protocol = TdApi.CallProtocol(true, true, 65, 92, arrayOf("parvane-webrtc"))

    @Synchronized
    fun begin(peer: String, outgoing: Boolean, video: Boolean, nowMs: Long): Active =
        Active(++nextId, peer, outgoing, video, nowMs).also {
            it.state = TdApi.CallStatePending(true, !outgoing)
            current = it
        }

    fun call(a: Active): TdApi.Call = TdApi.Call(a.id, a.id.toLong(), idOf(a.peer), a.outgoing, a.video, a.state)

    /** Событие ядра `call` (state: outgoing|incoming|connecting|active|ended|failed) → новое состояние TDLib; null — без смены. */
    fun apply(event: JSONObject, nowMs: Long): TdApi.CallState? {
        val a = current ?: return null
        val st: TdApi.CallState = when (event.optString("state")) {
            "outgoing" -> TdApi.CallStatePending(true, false)
            "connecting" -> TdApi.CallStateExchangingKeys()
            "active" -> { if (a.connectedMs == 0L) { a.connectedMs = nowMs; connectedAtMs = nowMs }; TdApi.CallStateReady(protocol, arrayOf(), "", ByteArray(0), arrayOf(), true, false, "") }
            "ended" -> TdApi.CallStateDiscarded(if (a.declined) TdApi.CallDiscardReasonDeclined() else if (a.connectedMs == 0L && !a.outgoing) TdApi.CallDiscardReasonMissed() else TdApi.CallDiscardReasonHungUp(), false, false, false)
            "failed" -> TdApi.CallStateError(TdApi.Error(if (event.optString("error_code") == "forbidden") 403 else 500, event.optString("error_code")))
            else -> return null
        }
        a.state = st
        if (st is TdApi.CallStateDiscarded || st is TdApi.CallStateError) { current = null; connectedAtMs = 0L }
        return st
    }

    /** Запись журнала личного состояния о завершённом звонке (`callSet`); null — id звонка неизвестен. */
    fun record(a: Active, nowMs: Long): JSONObject? {
        val callId = StateJournal.uuidToB64(a.callUuid) ?: return null
        val connected = a.connectedMs > 0
        val reason = when {
            connected -> "HANGUP_REASON_NORMAL"
            a.declined -> "HANGUP_REASON_DECLINED"
            else -> "HANGUP_REASON_MISSED"
        }
        return JSONObject()
            .put("call_id", callId)
            .put("peer", JSONObject().put("user", JSONObject().put("address", a.peer)))
            .put("outgoing", a.outgoing)
            .put("video", a.video)
            .put("reason", reason)
            .put("started_ms", a.startedMs.toString())
            .put("duration_s", if (connected) maxOf(1L, (nowMs - a.connectedMs) / 1000) else 0L)
    }
}
