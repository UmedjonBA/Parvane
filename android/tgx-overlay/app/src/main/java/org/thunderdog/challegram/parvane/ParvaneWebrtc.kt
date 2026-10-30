package org.thunderdog.challegram.parvane

import android.content.Context
import android.media.AudioManager
import android.util.Log
import org.parvane.core.ParvaneCalls
import org.webrtc.AudioTrack
import org.webrtc.Camera2Enumerator
import org.webrtc.CameraVideoCapturer
import org.webrtc.DataChannel
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoTrack
import org.webrtc.audio.JavaAudioDeviceModule
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * Parvane (spec 031): медиа звонков на org.webrtc из состава Telegram X (нативная часть — libtgcallsjni.so).
 * Сигналы ведут менеджеры ядра (ParvaneCalls): здесь только P2P-соединение по дескриптору — SDP, ICE (CALL-1),
 * микрофон и камера. Уроки desktop: отвечающая сторона добавляет дорожки `addTrack` (не addTransceiver); ICE-серверы
 * берутся заранее (call.ice_config), запрос из потока ядра — нельзя; «только через сервер» — RELAY.
 */
object ParvaneWebrtc : ParvaneCalls.MediaEngine {
    private const val TAG = "ParvaneWebrtc"
    private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "parvane-webrtc") }

    /** Удалённое видео и локальная камера — экрану звонка. */
    interface VideoListener {
        fun onRemoteVideo(handle: Long, track: VideoTrack?)
        fun onLocalVideo(track: VideoTrack?)
    }
    @Volatile var videoListener: VideoListener? = null
    /** «Звонки только через сервер» (настройка приватности; как desktop CallsRelayOnly). */
    @Volatile var relayOnly = false

    private lateinit var appContext: Context
    private var eglBase: EglBase? = null
    private var factory: PeerConnectionFactory? = null
    @Volatile private var iceServers: List<PeerConnection.IceServer> = emptyList()
    @Volatile private var iceUntilMs = 0L

    private class Conn(val handle: Long) {
        var pc: PeerConnection? = null
        var audio: AudioTrack? = null
        var video: VideoTrack? = null
        var capturer: CameraVideoCapturer? = null
        var helper: SurfaceTextureHelper? = null
        var wantVideo = false
        var remoteSet = false
        val pendingIce = ArrayList<IceCandidate>()
    }
    private val conns = ConcurrentHashMap<Long, Conn>()

    /** Поставить движок (один раз при старте приложения). */
    fun install(context: Context) {
        appContext = context.applicationContext
        ParvaneCalls.engine = this
    }

    private fun refreshIce() {
        if (System.currentTimeMillis() < iceUntilMs && iceServers.isNotEmpty()) return
        try {
            val cfg = ParvaneCalls.iceConfig()
            val arr = cfg.optJSONArray("servers") ?: return
            val out = ArrayList<PeerConnection.IceServer>()
            for (i in 0 until arr.length()) {
                val s = arr.getJSONObject(i)
                val urls = s.optJSONArray("urls") ?: continue
                val list = (0 until urls.length()).map { urls.getString(it) }
                out += PeerConnection.IceServer.builder(list).setUsername(s.optString("username")).setPassword(s.optString("credential")).createIceServer()
            }
            iceServers = out
            iceUntilMs = System.currentTimeMillis() + (cfg.optLong("ttl", 600) * 1000 / 2).coerceAtLeast(60_000)
            Log.i(TAG, "ICE-серверов: ${out.size}")
        } catch (e: Throwable) {
            Log.w(TAG, "ICE: ${e.message}")
        }
    }

    private fun factory(): PeerConnectionFactory {
        factory?.let { return it }
        // Нативная часть WebRTC — в libtgcallsjni.so X, глобальные JVM-переменные она заводит сама (N.getTgCallsVersions
        // при старте вызывает tgcalls::initialize; вызов идемпотентный). PeerConnectionFactory.initialize повторил бы
        // JVM::Initialize и уронил процесс — только контекст и отметка загрузки.
        org.thunderdog.challegram.N.getTgCallsVersions()
        org.webrtc.ParvaneWebrtcInit.prepare(appContext)
        val egl = EglBase.create().also { eglBase = it }
        val adm = JavaAudioDeviceModule.builder(appContext).setUseHardwareAcousticEchoCanceler(true)
            .setUseHardwareNoiseSuppressor(true).createAudioDeviceModule()
        // Монитор сети WebRTC общий с tgcalls X: при закрытии нашего соединения он снимал чужой приёмник
        // («Receiver not registered») и Java-исключение роняло network_thread (Check failed: !env->ExceptionCheck())
        val options = PeerConnectionFactory.Options().apply { disableNetworkMonitor = true }
        return PeerConnectionFactory.builder()
            .setOptions(options)
            .setAudioDeviceModule(adm)
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
            .createPeerConnectionFactory().also { factory = it }
    }

    override fun create(handle: Long) {
        conns[handle] = Conn(handle)
    }

    private fun ensurePc(c: Conn): PeerConnection? {
        c.pc?.let { return it }
        refreshIce()
        val f = factory()
        val rtc = PeerConnection.RTCConfiguration(iceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            iceTransportsType = if (relayOnly) PeerConnection.IceTransportsType.RELAY else PeerConnection.IceTransportsType.ALL
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        }
        val pc = f.createPeerConnection(rtc, observer(c)) ?: return null
        c.pc = pc
        val audioSource = f.createAudioSource(MediaConstraints())
        c.audio = f.createAudioTrack("pv-audio-${c.handle}", audioSource).also { pc.addTrack(it, listOf("pv")) }
        if (c.wantVideo) startCamera(c, f, pc)
        (appContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager)?.mode = AudioManager.MODE_IN_COMMUNICATION
        return pc
    }

    private fun startCamera(c: Conn, f: PeerConnectionFactory, pc: PeerConnection) {
        try {
            val enumerator = Camera2Enumerator(appContext)
            val name = enumerator.deviceNames.firstOrNull { enumerator.isFrontFacing(it) } ?: enumerator.deviceNames.firstOrNull() ?: return
            val capturer = enumerator.createCapturer(name, null)
            val source = f.createVideoSource(false)
            val helper = SurfaceTextureHelper.create("pv-camera", eglBase?.eglBaseContext)
            capturer.initialize(helper, appContext, source.capturerObserver)
            capturer.startCapture(1280, 720, 30)
            c.capturer = capturer; c.helper = helper
            c.video = f.createVideoTrack("pv-video-${c.handle}", source).also { pc.addTrack(it, listOf("pv")) }
            videoListener?.onLocalVideo(c.video)
        } catch (e: Throwable) {
            Log.w(TAG, "камера: ${e.message}")
        }
    }

    private fun observer(c: Conn) = object : PeerConnection.Observer {
        override fun onIceCandidate(candidate: IceCandidate) =
            ParvaneCalls.onLocalIce(c.handle, candidate.sdp, candidate.sdpMid ?: "", candidate.sdpMLineIndex)
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
            Log.i(TAG, "соединение ${c.handle}: $state")
            when (state) {
                PeerConnection.IceConnectionState.CONNECTED, PeerConnection.IceConnectionState.COMPLETED -> ParvaneCalls.onConnection(c.handle, true)
                PeerConnection.IceConnectionState.FAILED -> ParvaneCalls.onConnection(c.handle, false)
                else -> {}
            }
        }
        override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) {
            (receiver.track() as? VideoTrack)?.let { videoListener?.onRemoteVideo(c.handle, it) }
        }
        override fun onSignalingChange(state: PeerConnection.SignalingState) {}
        override fun onIceConnectionReceivingChange(receiving: Boolean) {}
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {}
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}
        override fun onAddStream(stream: MediaStream) {}
        override fun onRemoveStream(stream: MediaStream) {}
        override fun onDataChannel(channel: DataChannel) {}
        override fun onRenegotiationNeeded() {}
    }

    private abstract class Sdp : SdpObserver {
        override fun onCreateSuccess(sdp: SessionDescription) {}
        override fun onSetSuccess() {}
        override fun onCreateFailure(error: String?) { Log.w(TAG, "SDP: $error") }
        override fun onSetFailure(error: String?) { Log.w(TAG, "SDP set: $error") }
    }

    private fun flushIce(c: Conn) {
        c.remoteSet = true
        c.pendingIce.forEach { c.pc?.addIceCandidate(it) }
        c.pendingIce.clear()
    }

    override fun createOffer(handle: Long) = worker.execute {
        val c = conns[handle] ?: return@execute
        val pc = ensurePc(c) ?: return@execute ParvaneCalls.onConnection(handle, false)
        pc.createOffer(object : Sdp() {
            override fun onCreateSuccess(sdp: SessionDescription) {
                pc.setLocalDescription(object : Sdp() {
                    override fun onSetSuccess() = ParvaneCalls.onLocalOffer(handle, sdp.description)
                }, sdp)
            }
        }, MediaConstraints())
    }

    override fun acceptOffer(handle: Long, sdp: String) = worker.execute {
        val c = conns[handle] ?: return@execute
        val pc = ensurePc(c) ?: return@execute ParvaneCalls.onConnection(handle, false)
        pc.setRemoteDescription(object : Sdp() {
            override fun onSetSuccess() {
                worker.execute { flushIce(c) }
                pc.createAnswer(object : Sdp() {
                    override fun onCreateSuccess(answer: SessionDescription) {
                        pc.setLocalDescription(object : Sdp() {
                            override fun onSetSuccess() = ParvaneCalls.onLocalAnswer(handle, answer.description)
                        }, answer)
                    }
                }, MediaConstraints())
            }
        }, SessionDescription(SessionDescription.Type.OFFER, sdp))
    }

    override fun setRemoteAnswer(handle: Long, sdp: String) = worker.execute {
        val c = conns[handle] ?: return@execute
        c.pc?.setRemoteDescription(object : Sdp() {
            override fun onSetSuccess() = worker.execute { flushIce(c) }
        }, SessionDescription(SessionDescription.Type.ANSWER, sdp))
    }

    override fun addIce(handle: Long, candidate: String, mid: String, index: Int) = worker.execute {
        val c = conns[handle] ?: return@execute
        val ice = IceCandidate(mid, index, candidate)
        if (c.remoteSet) c.pc?.addIceCandidate(ice) else c.pendingIce += ice
    }

    override fun setVideo(handle: Long, on: Boolean) {
        conns[handle]?.wantVideo = on
    }

    override fun setMuted(handle: Long, muted: Boolean) = worker.execute {
        conns[handle]?.audio?.setEnabled(!muted)
    }

    override fun setAllMuted(muted: Boolean) = worker.execute {
        conns.values.forEach { it.audio?.setEnabled(!muted) }
    }

    override fun close(handle: Long) = worker.execute {
        val c = conns.remove(handle) ?: return@execute
        try { c.capturer?.stopCapture() } catch (e: Throwable) {}
        c.capturer?.dispose(); c.helper?.dispose()
        c.pc?.dispose()
        if (c.video != null) videoListener?.onLocalVideo(null)
        videoListener?.onRemoteVideo(handle, null)
        if (conns.isEmpty()) (appContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager)?.mode = AudioManager.MODE_NORMAL
    }
}
