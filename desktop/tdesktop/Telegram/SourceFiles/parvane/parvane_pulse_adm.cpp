// Parvane fork: реализация AudioDeviceModule на PulseAudio (см. .h).
#include "parvane/parvane_pulse_adm.h"

#include "base/debug_log.h"

#include <modules/audio_device/include/audio_device.h>
#include <modules/audio_device/include/audio_device_default.h>
#include <modules/audio_device/include/audio_device_defines.h>
#include <api/make_ref_counted.h>
#include <rtc_base/ref_counted_object.h>

#include <pulse/simple.h>
#include <pulse/error.h>
#include <pulse/pulseaudio.h>

#include <parvane/client_safety.h>

#include <atomic>
#include <cstdint>
#include <chrono>
#include <cstring>
#include <mutex>
#include <thread>

namespace Parvane {
namespace {

// 48 кГц, моно, 16 бит — стандарт для webrtc ADM; кадр 10 мс = 480 сэмплов.
constexpr int kRate = 48000;
constexpr int kChannels = 1;
constexpr int kSamples10ms = kRate / 100; // 480
constexpr int kBytes10ms = kSamples10ms * 2 * kChannels;
// Ошибка чтения/записи открытого потока: пауза перед следующей попыткой (иначе цикл крутился бы на 100% ядра).
// Когда переоткрывать поток и как часто пробовать открыть его без звукового сервера — CallAudioStream ядра.
constexpr auto kRetryPause = std::chrono::milliseconds(10);
constexpr auto kFrame = std::chrono::milliseconds(10);

[[nodiscard]] std::int64_t NowMs() {
	return std::chrono::duration_cast<std::chrono::milliseconds>(
		std::chrono::steady_clock::now().time_since_epoch()).count();
}

// Без потока кадры идут в такт 10 мс сами: так webrtc получает тишину захвата и отдаёт принятый звук, как при
// настоящем устройстве. Отстали больше чем на 100 мс (сон, нагрузка) — такт с текущего момента, без догонялок.
void WaitFrame(std::chrono::steady_clock::time_point &next) {
	next += kFrame;
	const auto now = std::chrono::steady_clock::now();
	if (next + std::chrono::milliseconds(100) < now) {
		next = now;
	}
	std::this_thread::sleep_until(next);
}

std::mutex g_devicesMutex;
std::string g_playbackId;
std::string g_captureId;

// Устройства PulseAudio (имя + описание) — синхронно, своим циклом событий (до ~2 с).
std::vector<parvane::clientsafety::DeviceCandidate> ListPulseDevices(bool playback) {
	auto out = std::vector<parvane::clientsafety::DeviceCandidate>();
	auto *loop = pa_mainloop_new();
	if (!loop) {
		return out;
	}
	auto *context = pa_context_new(pa_mainloop_get_api(loop), "Parvane");
	if (!context || pa_context_connect(context, nullptr, PA_CONTEXT_NOFLAGS, nullptr) < 0) {
		if (context) {
			pa_context_unref(context);
		}
		pa_mainloop_free(loop);
		return out;
	}
	auto op = (pa_operation*)nullptr;
	auto done = false;
	const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
	while (!done && std::chrono::steady_clock::now() < deadline) {
		if (pa_mainloop_iterate(loop, 0, nullptr) < 0) {
			break;
		}
		const auto state = pa_context_get_state(context);
		if (state == PA_CONTEXT_FAILED || state == PA_CONTEXT_TERMINATED) {
			break;
		}
		if (state == PA_CONTEXT_READY && !op) {
			struct Collect {
				std::vector<parvane::clientsafety::DeviceCandidate> *list;
				bool *done;
			};
			static thread_local Collect collect;
			collect = Collect{ &out, &done };
			if (playback) {
				op = pa_context_get_sink_info_list(context, [](pa_context*, const pa_sink_info *i, int eol, void *data) {
					auto *c = static_cast<Collect*>(data);
					if (eol || !i) {
						*c->done = true;
						return;
					}
					c->list->push_back({ i->name ? i->name : "", i->description ? i->description : "" });
				}, &collect);
			} else {
				op = pa_context_get_source_info_list(context, [](pa_context*, const pa_source_info *i, int eol, void *data) {
					auto *c = static_cast<Collect*>(data);
					if (eol || !i) {
						*c->done = true;
						return;
					}
					if (i->monitor_of_sink == PA_INVALID_INDEX) { // не «монитор» динамиков
						c->list->push_back({ i->name ? i->name : "", i->description ? i->description : "" });
					}
				}, &collect);
			}
			if (!op) {
				break;
			}
		}
		std::this_thread::sleep_for(std::chrono::milliseconds(5));
	}
	if (op) {
		pa_operation_unref(op);
	}
	pa_context_disconnect(context);
	pa_context_unref(context);
	pa_mainloop_free(loop);
	return out;
}

std::string ResolveDevice(pa_stream_direction_t dir) {
	auto selected = std::string();
	{
		auto lock = std::lock_guard(g_devicesMutex);
		selected = (dir == PA_STREAM_PLAYBACK) ? g_playbackId : g_captureId;
	}
	if (selected.empty() || selected == "default") {
		return {};
	}
	const auto name = parvane::clientsafety::pickDevice(selected, ListPulseDevices(dir == PA_STREAM_PLAYBACK));
	LOG(("Parvane: PulseAudio %1 — выбрано «%2» → %3")
		.arg(dir == PA_STREAM_PLAYBACK ? "динамики" : "микрофон")
		.arg(QString::fromStdString(selected))
		.arg(name.empty() ? QString("по умолчанию") : QString::fromStdString(name)));
	return name;
}

pa_simple *openStream(pa_stream_direction_t dir, const char *name, int *error) {
	pa_sample_spec ss;
	ss.format = PA_SAMPLE_S16LE;
	ss.rate = kRate;
	ss.channels = kChannels;
	pa_buffer_attr attr;
	attr.maxlength = (uint32_t)-1;
	attr.tlength = kBytes10ms * 4;   // playback target ~40мс
	attr.prebuf = (uint32_t)-1;
	attr.minreq = (uint32_t)-1;
	attr.fragsize = kBytes10ms;      // record: отдавать по 10мс
	int err = 0;
	const auto device = ResolveDevice(dir); // «Звук и камера» (ревью UI 7 ноя, п. 22)
	auto *s = pa_simple_new(nullptr, "Parvane", dir, device.empty() ? nullptr : device.c_str(), name,
		&ss, nullptr, &attr, &err);
	if (!s && error) {
		*error = err;
	}
	return s;
}

// Открыть поток, если пора (CallAudioStream); сбой — в журнал один раз, звонок идёт дальше без устройства.
void EnsureStream(
		parvane::clientsafety::CallAudioStream &policy,
		pa_simple *&stream,
		pa_stream_direction_t dir,
		const char *name) {
	const auto now = NowMs();
	if (stream || !policy.shouldOpen(now)) {
		return;
	}
	int err = 0;
	stream = openStream(dir, name, &err);
	if (stream) {
		policy.opened(true, now);
		LOG(("Parvane: PulseAudio %1 открыт").arg(name));
	} else if (policy.opened(false, now)) {
		LOG(("Parvane: PulseAudio %1 не открылся: %2 — звонок идёт без устройства (%3), повтор раз в %4 мс")
			.arg(name)
			.arg(pa_strerror(err))
			.arg(dir == PA_STREAM_RECORD ? "собеседнику уходит тишина" : "принятый звук не слышен")
			.arg(parvane::clientsafety::CallAudioStream::kRetryMs));
	}
}

class PulseADM
	: public webrtc::webrtc_impl::AudioDeviceModuleDefault<
		webrtc::AudioDeviceModule> {
public:
	~PulseADM() override {
		StopRecording();
		StopPlayout();
	}

	int32_t RegisterAudioCallback(webrtc::AudioTransport *cb) override {
		// под замком: рабочие потоки вызывают транспорт тоже под ним, снятый транспорт уже не вызовется
		auto lock = std::lock_guard(_transportMutex);
		_transport = cb;
		return 0;
	}

	int32_t Init() override { return 0; }
	int32_t Terminate() override {
		StopRecording();
		StopPlayout();
		return 0;
	}
	bool Initialized() const override { return true; }

	int32_t PlayoutIsAvailable(bool *available) override {
		if (available) *available = true;
		return 0;
	}
	int32_t RecordingIsAvailable(bool *available) override {
		if (available) *available = true;
		return 0;
	}
	int32_t InitPlayout() override { _playInit = true; return 0; }
	bool PlayoutIsInitialized() const override { return _playInit; }
	int32_t InitRecording() override { _recInit = true; return 0; }
	bool RecordingIsInitialized() const override { return _recInit; }

	int32_t StartPlayout() override {
		if (_playing) return 0;
		// Без звукового сервера воспроизведение всё равно «идёт» (звук отбрасывается в такт), поток пробуется снова
		_playing = true;
		_playThread = std::thread([this] { playLoop(); });
		LOG(("Parvane: PulseAudio воспроизведение запущено"));
		return 0;
	}
	int32_t StopPlayout() override {
		_playing = false;
		if (_playThread.joinable()) _playThread.join();
		return 0;
	}
	bool Playing() const override { return _playing; }

	int32_t StartRecording() override {
		if (_recording) return 0;
		// Без микрофона/звукового сервера захват отдаёт тишину: webrtc шлёт RTP, звонок не «немой» на проводе
		// (прежде -1 здесь — ни одного пакета собеседнику), поток пробуется снова
		_recording = true;
		_recThread = std::thread([this] { recLoop(); });
		LOG(("Parvane: PulseAudio захват запущен"));
		return 0;
	}
	int32_t StopRecording() override {
		_recording = false;
		if (_recThread.joinable()) _recThread.join();
		return 0;
	}
	bool Recording() const override { return _recording; }

private:
	void playLoop() {
		int16_t buf[kSamples10ms];
		auto policy = parvane::clientsafety::CallAudioStream();
		auto *stream = (pa_simple*)nullptr;
		auto next = std::chrono::steady_clock::now();
		while (_playing) {
			EnsureStream(policy, stream, PA_STREAM_PLAYBACK, "call-out");
			size_t out = 0;
			int64_t elapsed = 0, ntp = 0;
			{
				auto lock = std::lock_guard(_transportMutex);
				if (_transport) {
					_transport->NeedMorePlayData(kSamples10ms, 2, kChannels,
						kRate, buf, out, &elapsed, &ntp);
				}
			}
			if (!stream) {
				WaitFrame(next); // устройства нет — звук отбрасывается в такт
				continue;
			}
			if (out == 0) {
				std::memset(buf, 0, sizeof(buf));
				out = kSamples10ms;
			}
			int err = 0;
			if (pa_simple_write(stream, buf, out * 2 * kChannels, &err) >= 0) {
				policy.ioOk();
			} else {
				if (policy.ioFailed(NowMs())) {
					pa_simple_free(stream);
					stream = nullptr;
				}
				std::this_thread::sleep_for(kRetryPause);
			}
			next = std::chrono::steady_clock::now();
		}
		if (stream) {
			pa_simple_free(stream);
		}
	}
	void recLoop() {
		int16_t buf[kSamples10ms];
		auto policy = parvane::clientsafety::CallAudioStream();
		auto *stream = (pa_simple*)nullptr;
		auto next = std::chrono::steady_clock::now();
		while (_recording) {
			EnsureStream(policy, stream, PA_STREAM_RECORD, "call-in");
			auto got = false;
			if (stream) {
				int err = 0;
				if (pa_simple_read(stream, buf, kBytes10ms, &err) >= 0) {
					policy.ioOk();
					got = true;
					next = std::chrono::steady_clock::now();
				} else if (policy.ioFailed(NowMs())) {
					pa_simple_free(stream);
					stream = nullptr;
				}
			}
			if (!got) {
				std::memset(buf, 0, sizeof(buf)); // тишина вместо микрофона — кадр в такт 10 мс
				WaitFrame(next);
			}
			uint32_t newMicLevel = 0;
			auto lock = std::lock_guard(_transportMutex);
			if (_transport) {
				_transport->RecordedDataIsAvailable(buf, kSamples10ms, 2,
					kChannels, kRate, 0, 0, 0, false, newMicLevel);
			}
		}
		if (stream) {
			pa_simple_free(stream);
		}
	}

	std::mutex _transportMutex;
	webrtc::AudioTransport *_transport = nullptr;
	std::thread _playThread;
	std::thread _recThread;
	std::atomic<bool> _playing{ false };
	std::atomic<bool> _recording{ false };
	std::atomic<bool> _playInit{ false };
	std::atomic<bool> _recInit{ false };
};

} // namespace

webrtc::scoped_refptr<webrtc::AudioDeviceModule> CreatePulseAudioDeviceModule() {
	return rtc::make_ref_counted<PulseADM>();
}

void SetCallAudioDevices(const std::string &playbackId, const std::string &captureId) {
	auto lock = std::lock_guard(g_devicesMutex);
	g_playbackId = playbackId;
	g_captureId = captureId;
}

} // namespace Parvane
