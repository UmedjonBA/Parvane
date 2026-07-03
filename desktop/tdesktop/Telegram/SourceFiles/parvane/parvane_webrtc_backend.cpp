// Parvane fork: реализация parvane_webrtc_backend.h — MediaBackend поверх
// webrtc::PeerConnection (tg_owt). Audio-only. Общая фабрика/потоки/устройство —
// ленивый singleton. Сигналинг (SDP/ICE) отдаётся наружу через колбэки
// MediaBackend и маппится CallSession на нашу шину. См. desktop/CALLS-parvane.md.
#include "parvane/parvane_webrtc_backend.h"

#include "base/debug_log.h"

#include <nlohmann/json.hpp>

#include <api/peer_connection_interface.h>
#include <api/create_peerconnection_factory.h>
#include <api/audio_codecs/builtin_audio_encoder_factory.h>
#include <api/audio_codecs/builtin_audio_decoder_factory.h>
#include <api/audio_options.h>
#include <api/jsep.h>
#include <api/rtc_error.h>
#include <api/task_queue/default_task_queue_factory.h>
#include <modules/audio_device/include/audio_device.h>
#include <rtc_base/thread.h>
#include <rtc_base/ref_counted_object.h>

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
			g.adm = g.worker->BlockingCall([&] {
				return webrtc::AudioDeviceModule::Create(
					webrtc::AudioDeviceModule::kPlatformDefaultAudio,
					g.taskQueue.get());
			});
			g.factory = webrtc::CreatePeerConnectionFactory(
				g.network.get(), g.worker.get(), g.signaling.get(),
				g.adm,
				webrtc::CreateBuiltinAudioEncoderFactory(),
				webrtc::CreateBuiltinAudioDecoderFactory(),
				nullptr, nullptr, nullptr, nullptr);
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

	void close() override {
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
		// Localhost/LAN: host-кандидаты; STUN/TURN добавим позже.
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

	webrtc::scoped_refptr<webrtc::PeerConnectionInterface> _pc;
	webrtc::scoped_refptr<webrtc::AudioTrackInterface> _track;
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
