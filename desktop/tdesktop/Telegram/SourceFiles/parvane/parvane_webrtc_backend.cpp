// Parvane fork: реализация parvane_webrtc_backend.h — MediaBackend поверх
// webrtc::PeerConnection (tg_owt). Audio-only. Общая фабрика/потоки/устройство —
// ленивый singleton. Сигналинг (SDP/ICE) отдаётся наружу через колбэки
// MediaBackend и маппится CallSession на нашу шину. См. desktop/CALLS-parvane.md.
#include "parvane/parvane_webrtc_backend.h"

#include "base/debug_log.h"
#include "parvane/parvane_client.h"     // FetchIceServers (шард call)
#include "parvane/parvane_call_panel.h" // нативный экран звонка (Native*)
#include "parvane/parvane_call_video.h" // сырые кадры → нативный видео-трек
#include "parvane/parvane_pulse_adm.h"  // свой ADM (PulseAudio) вместо dummy

#include <parvane/crypto.h> // parvane-core: SAS (sasEmoji)

#include <nlohmann/json.hpp>

#include <api/peer_connection_interface.h>
#include <api/create_peerconnection_factory.h>
#include <api/audio_codecs/builtin_audio_encoder_factory.h>
#include <api/audio_codecs/builtin_audio_decoder_factory.h>
#include <api/video_codecs/builtin_video_encoder_factory.h>
#include <api/video_codecs/builtin_video_decoder_factory.h>
#include <api/audio_options.h>
#include <api/jsep.h>
#include <api/rtc_error.h>
#include <api/task_queue/default_task_queue_factory.h>
#include <modules/audio_device/include/audio_device.h>
#include <rtc_base/thread.h>
#include <rtc_base/ref_counted_object.h>
#include <sstream>
#include <api/media_stream_interface.h>          // VideoTrackInterface, kVideoKind
#include <api/video/video_sink_interface.h>
#include <pc/video_track_source.h>               // webrtc::VideoTrackSource
#include <media/base/video_broadcaster.h>        // rtc::VideoBroadcaster
#include <modules/video_capture/video_capture_factory.h>
#include <atomic>

namespace Parvane {
namespace {

using nlohmann::json;

// ── общая инфраструктура webrtc (создаётся один раз) ──────────────────────────
struct WebrtcGlobal {
	std::unique_ptr<rtc::Thread> network;
	std::unique_ptr<rtc::Thread> worker;
	std::unique_ptr<rtc::Thread> signaling;
	std::unique_ptr<webrtc::TaskQueueFactory> taskQueue;
	webrtc::scoped_refptr<webrtc::AudioDeviceModule> adm;
	webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> factory;
	bool ok = false;
};

WebrtcGlobal &Global() {
	static WebrtcGlobal g = [] {
		WebrtcGlobal g;
		try {
			g.network = rtc::Thread::CreateWithSocketServer();
			g.network->SetName("pv_net", nullptr);
			g.network->Start();
			g.worker = rtc::Thread::Create();
			g.worker->SetName("pv_work", nullptr);
			g.worker->Start();
			g.signaling = rtc::Thread::Create();
			g.signaling->SetName("pv_sig", nullptr);
			g.signaling->Start();
			g.taskQueue = webrtc::CreateDefaultTaskQueueFactory();
			// Свой ADM на PulseAudio: прибилженный libtg_owt без ALSA/Pulse даёт
			// dummy-устройство (тишина в звонках). См. parvane_pulse_adm.
			g.adm = g.worker->BlockingCall([&] {
				return Parvane::CreatePulseAudioDeviceModule();
			});
			g.factory = webrtc::CreatePeerConnectionFactory(
				g.network.get(), g.worker.get(), g.signaling.get(),
				g.adm,
				webrtc::CreateBuiltinAudioEncoderFactory(),
				webrtc::CreateBuiltinAudioDecoderFactory(),
				webrtc::CreateBuiltinVideoEncoderFactory(),
				webrtc::CreateBuiltinVideoDecoderFactory(),
				nullptr, nullptr);
			g.ok = (g.factory != nullptr);
			LOG(("Parvane: webrtc-фабрика создана, ok=%1").arg(g.ok ? 1 : 0));
		} catch (...) {
			g.ok = false;
			LOG(("Parvane: ОШИБКА инициализации webrtc-фабрики"));
		}
		return g;
	}();
	return g;
}

// Observer установки local/remote описания (совмещённый, как в tgcalls).
class SetSdpObserver : public webrtc::SetLocalDescriptionObserverInterface,
                       public webrtc::SetRemoteDescriptionObserverInterface {
public:
	explicit SetSdpObserver(std::function<void(webrtc::RTCError)> cb)
		: _cb(std::move(cb)) {}
	void OnSetLocalDescriptionComplete(webrtc::RTCError e) override { _cb(e); }
	void OnSetRemoteDescriptionComplete(webrtc::RTCError e) override { _cb(e); }
private:
	std::function<void(webrtc::RTCError)> _cb;
};

// Источник видео с камеры (V4L2): VideoCaptureModule → VideoBroadcaster. Кадры от
// камеры считаются (для проверки без дисплея) и раздаются трекам/энкодеру.
class CameraSource : public webrtc::VideoTrackSource,
                     public rtc::VideoSinkInterface<webrtc::VideoFrame> {
public:
	CameraSource() : webrtc::VideoTrackSource(/*remote=*/false) {}
	~CameraSource() override { stop(); }

	// Открыть камеру и начать захват (звать на worker-потоке). Перебираем все
	// устройства: если /dev/video0 занят (второй экземпляр на той же машине) —
	// берём следующую камеру → двунаправленное видео при наличии 2 камер.
	bool startCapture() {
		std::unique_ptr<webrtc::VideoCaptureModule::DeviceInfo> info(
			webrtc::VideoCaptureFactory::CreateDeviceInfo());
		if (!info) {
			return false;
		}
		const auto count = info->NumberOfDevices();
		for (std::uint32_t idx = 0; idx < count; ++idx) {
			char id[260] = { 0 }, name[260] = { 0 };
			if (info->GetDeviceName(idx, name, sizeof(name), id, sizeof(id)) != 0) {
				continue;
			}
			auto vcm = webrtc::VideoCaptureFactory::Create(id);
			if (!vcm) {
				continue;
			}
			vcm->RegisterCaptureDataCallback(this);
			webrtc::VideoCaptureCapability cap;
			cap.width = 640;
			cap.height = 480;
			cap.maxFPS = 30;
			cap.videoType = webrtc::VideoType::kI420;
			if (vcm->StartCapture(cap) == 0) {
				_vcm = vcm;
				LOG(("Parvane: камера открыта — устройство #%1").arg(idx));
				return true;
			}
			vcm->DeRegisterCaptureDataCallback();
		}
		return false;
	}
	void stop() {
		if (_vcm) {
			_vcm->StopCapture();
			_vcm->DeRegisterCaptureDataCallback();
			_vcm = nullptr;
		}
	}
	void OnFrame(const webrtc::VideoFrame &frame) override {
		const int n = ++_frames;
		if (n == 1 || (n % 60) == 0) {
			LOG(("Parvane: камера — кадров захвачено: %1").arg(n));
		}
		_broadcaster.OnFrame(frame);
		// Своя камера → нативный видео-трек (self-preview в экране звонка).
		Parvane::PushLocalVideoFrame(frame);
	}

protected:
	rtc::VideoSourceInterface<webrtc::VideoFrame> *source() override {
		return &_broadcaster;
	}

private:
	rtc::VideoBroadcaster _broadcaster;
	webrtc::scoped_refptr<webrtc::VideoCaptureModule> _vcm;
	std::atomic<int> _frames{ 0 };
};

// Приёмник удалённого видео: считает кадры (рендер в окне — Э V2).
class RemoteVideoSink : public rtc::VideoSinkInterface<webrtc::VideoFrame> {
public:
	void OnFrame(const webrtc::VideoFrame &frame) override {
		const int n = ++_count;
		if (n == 1 || (n % 60) == 0) {
			LOG(("Parvane: удалённое видео — кадров получено: %1").arg(n));
		}
		// Сырой кадр → нативный видео-трек (Calls::VideoBubble сам рендерит).
		Parvane::PushRemoteVideoFrame(frame);
	}
	std::atomic<int> _count{ 0 };
};

// Достаёт DTLS-отпечаток (после "a=fingerprint:") из SDP. "" если нет.
std::string parseFingerprint(const std::string &sdp) {
	const auto pos = sdp.find("a=fingerprint:");
	if (pos == std::string::npos) return {};
	const auto eol = sdp.find('\n', pos);
	auto line = sdp.substr(pos, (eol == std::string::npos ? sdp.size() : eol) - pos);
	const auto sp = line.find(' ');
	if (sp == std::string::npos) return {};
	auto fp = line.substr(sp + 1);
	while (!fp.empty() && (fp.back() == '\r' || fp.back() == '\n')) fp.pop_back();
	return fp;
}

// ── сам движок одного звонка ──────────────────────────────────────────────────
class WebrtcMediaBackend final : public parvane::MediaBackend {
public:
	~WebrtcMediaBackend() override { close(); }

	void createOffer(std::function<void(std::string)> onOffer) override {
		if (!ensurePc()) { return; }
		_pendingLocal = std::move(onOffer);
		setLocalThenReport();
	}

	void acceptOffer(const std::string &remoteSdp,
			std::function<void(std::string)> onAnswer) override {
		if (!ensurePc()) { return; }
		_pendingLocal = std::move(onAnswer);
		setRemote("offer", remoteSdp, [this] { setLocalThenReport(); });
	}

	void setRemoteAnswer(const std::string &sdp) override {
		if (_pc) setRemote("answer", sdp, nullptr);
	}

	void addRemoteIce(const std::string &candidate) override {
		if (!_pc || candidate.empty()) return;
		try {
			const auto j = json::parse(candidate);
			webrtc::SdpParseError err;
			std::unique_ptr<webrtc::IceCandidateInterface> c(
				webrtc::CreateIceCandidate(
					j.value("mid", std::string()),
					j.value("idx", 0),
					j.value("sdp", std::string()), &err));
			if (c) _pc->AddIceCandidate(c.get());
		} catch (...) {
		}
	}

	void setWantVideo(bool on) override { _wantVideo = on; }

	void close() override {
		if (_remoteVideoSink) {
			Parvane::CloseNativeCallPanel();
		}
		if (_cameraSource) {
			_cameraSource->stop();
			_cameraSource = nullptr;
		}
		if (_pc) {
			_pc->Close();
			_pc = nullptr;
		}
		_track = nullptr;
	}

private:
	// PeerConnectionObserver → наши колбэки (ICE/состояние).
	class PcObserver : public webrtc::PeerConnectionObserver {
	public:
		explicit PcObserver(WebrtcMediaBackend *b) : _b(b) {}
		// Удалённый трек (в т.ч. видео) → подключаем счётчик кадров.
		void OnTrack(
				webrtc::scoped_refptr<webrtc::RtpTransceiverInterface> t) override {
			const auto track = t->receiver()->track();
			if (track && track->kind()
					== webrtc::MediaStreamTrackInterface::kVideoKind) {
				auto *v = static_cast<webrtc::VideoTrackInterface *>(track.get());
				if (_b->_remoteVideoSink) {
					v->AddOrUpdateSink(_b->_remoteVideoSink.get(),
						rtc::VideoSinkWants());
				}
				LOG(("Parvane: удалённый ВИДЕО-трек подключён"));
			}
		}
		void OnSignalingChange(
			webrtc::PeerConnectionInterface::SignalingState) override {}
		void OnDataChannel(
			webrtc::scoped_refptr<webrtc::DataChannelInterface>) override {}
		void OnRenegotiationNeeded() override {}
		void OnIceGatheringChange(
			webrtc::PeerConnectionInterface::IceGatheringState) override {}
		void OnIceCandidate(
				const webrtc::IceCandidateInterface *c) override {
			if (!c) return;
			std::string sdp;
			c->ToString(&sdp);
			const json j{ { "sdp", sdp }, { "mid", c->sdp_mid() },
				{ "idx", c->sdp_mline_index() } };
			if (_b->onLocalIce) _b->onLocalIce(j.dump());
		}
		void OnConnectionChange(
				webrtc::PeerConnectionInterface::PeerConnectionState s) override {
			using S = webrtc::PeerConnectionInterface::PeerConnectionState;
			if (s == S::kConnected) {
				_b->computeSas(); // SAS доступен — оба SDP уже установлены
				if (_b->onConnectionChange) _b->onConnectionChange(true);
			} else if (s == S::kFailed || s == S::kClosed
					|| s == S::kDisconnected) {
				if (_b->onConnectionChange) _b->onConnectionChange(false);
			}
		}
	private:
		WebrtcMediaBackend *_b;
	};

	bool ensurePc() {
		if (_pc) return true;
		auto &g = Global();
		if (!g.ok) {
			LOG(("Parvane: webrtc недоступен — звонок без медиа"));
			return false;
		}
		_observer = std::make_unique<PcObserver>(this);
		webrtc::PeerConnectionInterface::RTCConfiguration config;
		config.sdp_semantics = webrtc::SdpSemantics::kUnifiedPlan;
		// ICE-серверы из окружения — обход NAT (иначе только host-кандидаты,
		// localhost/LAN). PARVANE_STUN=stun:host:port[,...]; PARVANE_TURN=
		// turn:host:port[?transport=udp] + PARVANE_TURN_USER/PARVANE_TURN_PASS.
		if (const char *stun = std::getenv("PARVANE_STUN"); stun && *stun) {
			std::stringstream ss(stun);
			std::string url;
			while (std::getline(ss, url, ',')) {
				if (url.empty()) continue;
				webrtc::PeerConnectionInterface::IceServer srv;
				srv.urls.push_back(url);
				config.servers.push_back(srv);
			}
		}
		if (const char *turn = std::getenv("PARVANE_TURN"); turn && *turn) {
			webrtc::PeerConnectionInterface::IceServer srv;
			srv.urls.push_back(std::string(turn));
			if (const char *u = std::getenv("PARVANE_TURN_USER")) srv.username = u;
			if (const char *p = std::getenv("PARVANE_TURN_PASS")) srv.password = p;
			config.servers.push_back(srv);
		}
		// Шард call: STUN/TURN с эфемерными кредами (call.ice.request, кэш).
		// Env-переменные выше — дополнение/фолбэк (dev без TURN-секрета).
		for (const auto &ice : Parvane::FetchIceServers()) {
			webrtc::PeerConnectionInterface::IceServer srv;
			srv.urls = ice.urls;
			srv.username = ice.username;
			srv.password = ice.password;
			config.servers.push_back(srv);
		}
		if (!config.servers.empty()) {
			LOG(("Parvane: ICE-серверов сконфигурировано: %1")
				.arg(int(config.servers.size())));
		}
		webrtc::PeerConnectionDependencies deps(_observer.get());
		auto pcOrError = g.factory->CreatePeerConnectionOrError(
			config, std::move(deps));
		if (!pcOrError.ok()) {
			LOG(("Parvane: CreatePeerConnection не удался"));
			return false;
		}
		_pc = pcOrError.value();
		// Исходящий аудио-трек (микрофон).
		cricket::AudioOptions opts;
		auto source = g.factory->CreateAudioSource(opts);
		_track = g.factory->CreateAudioTrack("audio0", source.get());
		webrtc::RtpTransceiverInit init;
		init.stream_ids = { "stream0" };
		_pc->AddTransceiver(_track, init);
		// Видео (по запросу): камера → видео-трек. Нет камеры → recvonly (всё равно
		// принимаем удалённое видео). _remoteVideoSink считает входящие кадры.
		if (_wantVideo) {
			_remoteVideoSink = std::make_unique<RemoteVideoSink>();
			auto cam = rtc::make_ref_counted<CameraSource>();
			const auto ok = g.worker->BlockingCall([&] {
				return cam->startCapture();
			});
			if (ok) {
				_cameraSource = cam;
				auto videoTrack = g.factory->CreateVideoTrack(cam, "video0");
				webrtc::RtpTransceiverInit vinit;
				vinit.stream_ids = { "stream0" };
				_pc->AddTransceiver(videoTrack, vinit);
				LOG(("Parvane: видео-трек добавлен (камера)"));
			} else {
				_pc->AddTransceiver(cricket::MediaType::MEDIA_TYPE_VIDEO);
				LOG(("Parvane: камера недоступна → видео recvonly"));
			}
		}
		return true;
	}

	void setRemote(const std::string &type, const std::string &sdp,
			std::function<void()> done) {
		webrtc::SdpParseError err;
		auto desc = webrtc::CreateSessionDescription(
			type == "offer" ? webrtc::SdpType::kOffer : webrtc::SdpType::kAnswer,
			sdp, &err);
		if (!desc) {
			LOG(("Parvane: разбор SDP (%1) не удался: %2")
				.arg(QString::fromStdString(type))
				.arg(QString::fromStdString(err.description)));
			return;
		}
		webrtc::scoped_refptr<webrtc::SetRemoteDescriptionObserverInterface> obs(
			new rtc::RefCountedObject<SetSdpObserver>(
				[done = std::move(done)](webrtc::RTCError) {
					if (done) done();
				}));
		_pc->SetRemoteDescription(std::move(desc), obs);
	}

	// SetLocalDescription (неявно создаёт offer/answer), затем отдаёт SDP наружу.
	void setLocalThenReport() {
		webrtc::scoped_refptr<webrtc::SetLocalDescriptionObserverInterface> obs(
			new rtc::RefCountedObject<SetSdpObserver>(
				[this](webrtc::RTCError) { reportLocal(); }));
		_pc->SetLocalDescription(obs);
	}

	void reportLocal() {
		if (!_pc || !_pc->local_description()) return;
		std::string sdp;
		_pc->local_description()->ToString(&sdp);
		auto cb = _pendingLocal;
		_pendingLocal = nullptr;
		if (cb) cb(sdp);
	}

	// SAS для сверки голосом: из ОТСОРТИРОВАННОЙ пары DTLS-отпечатков (local+remote).
	void computeSas() {
		if (!_pc || !_pc->local_description() || !_pc->remote_description()) {
			return;
		}
		std::string localSdp, remoteSdp;
		_pc->local_description()->ToString(&localSdp);
		_pc->remote_description()->ToString(&remoteSdp);
		const auto lf = parseFingerprint(localSdp);
		const auto rf = parseFingerprint(remoteSdp);
		if (lf.empty() || rf.empty()) {
			return;
		}
		const auto sas = parvane::crypto::sasEmoji(lf, rf);
		LOG(("Parvane: SAS звонка: %1").arg(QString::fromStdString(sas)));
		Parvane::NativeCallSas(sas);
	}

	webrtc::scoped_refptr<webrtc::PeerConnectionInterface> _pc;
	webrtc::scoped_refptr<webrtc::AudioTrackInterface> _track;
	webrtc::scoped_refptr<CameraSource> _cameraSource;
	std::unique_ptr<RemoteVideoSink> _remoteVideoSink;
	bool _wantVideo = false;
	std::unique_ptr<PcObserver> _observer;
	std::function<void(std::string)> _pendingLocal;
};

} // namespace

std::unique_ptr<parvane::MediaBackend> MakeWebrtcBackend() {
	if (!Global().ok) {
		return nullptr;
	}
	return std::make_unique<WebrtcMediaBackend>();
}

} // namespace Parvane
