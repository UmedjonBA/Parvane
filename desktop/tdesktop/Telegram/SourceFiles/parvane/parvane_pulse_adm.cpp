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

#include <atomic>
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
// Сбой звукового сервера: пауза между попытками, число подряд идущих ошибок до переоткрытия потока и число
// неудачных переоткрытий до выхода из цикла (иначе поток крутился бы вхолостую на 100% ядра)
constexpr auto kRetryPause = std::chrono::milliseconds(10);
constexpr int kErrorsBeforeReopen = 20;
constexpr int kMaxReopenFailures = 5;

pa_simple *openStream(pa_stream_direction_t dir, const char *name) {
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
	auto *s = pa_simple_new(nullptr, "Parvane", dir, nullptr, name,
		&ss, nullptr, &attr, &err);
	if (!s) {
		LOG(("Parvane: PulseAudio %1 не открылся: %2")
			.arg(name).arg(pa_strerror(err)));
	}
	return s;
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
		_play = openStream(PA_STREAM_PLAYBACK, "call-out");
		if (!_play) return -1;
		_playing = true;
		_playThread = std::thread([this] { playLoop(); });
		LOG(("Parvane: PulseAudio воспроизведение запущено"));
		return 0;
	}
	int32_t StopPlayout() override {
		_playing = false;
		if (_playThread.joinable()) _playThread.join();
		if (_play) { pa_simple_free(_play); _play = nullptr; }
		return 0;
	}
	bool Playing() const override { return _playing; }

	int32_t StartRecording() override {
		if (_recording) return 0;
		_rec = openStream(PA_STREAM_RECORD, "call-in");
		if (!_rec) return -1;
		_recording = true;
		_recThread = std::thread([this] { recLoop(); });
		LOG(("Parvane: PulseAudio захват запущен"));
		return 0;
	}
	int32_t StopRecording() override {
		_recording = false;
		if (_recThread.joinable()) _recThread.join();
		if (_rec) { pa_simple_free(_rec); _rec = nullptr; }
		return 0;
	}
	bool Recording() const override { return _recording; }

private:
	// Ошибка потока: пауза, а после серии ошибок — переоткрытие; true — продолжать, false — сдаться
	bool recover(pa_simple *&stream, pa_stream_direction_t dir, const char *name, int &errors, int &failures) {
		std::this_thread::sleep_for(kRetryPause);
		if (++errors < kErrorsBeforeReopen) {
			return true;
		}
		errors = 0;
		if (stream) {
			pa_simple_free(stream);
			stream = nullptr;
		}
		stream = openStream(dir, name);
		if (stream) {
			failures = 0;
			return true;
		}
		if (++failures >= kMaxReopenFailures) {
			LOG(("Parvane: PulseAudio %1 недоступен, поток остановлен").arg(name));
			return false;
		}
		return true;
	}

	void playLoop() {
		int16_t buf[kSamples10ms];
		auto errors = 0, failures = 0;
		while (_playing) {
			size_t out = 0;
			int64_t elapsed = 0, ntp = 0;
			{
				auto lock = std::lock_guard(_transportMutex);
				if (_transport) {
					_transport->NeedMorePlayData(kSamples10ms, 2, kChannels,
						kRate, buf, out, &elapsed, &ntp);
				}
			}
			if (out == 0) {
				std::memset(buf, 0, sizeof(buf));
				out = kSamples10ms;
			}
			int err = 0;
			if (_play && pa_simple_write(_play, buf, out * 2 * kChannels, &err) >= 0) {
				errors = 0;
			} else if (!recover(_play, PA_STREAM_PLAYBACK, "call-out", errors, failures)) {
				break;
			}
		}
	}
	void recLoop() {
		int16_t buf[kSamples10ms];
		auto errors = 0, failures = 0;
		while (_recording) {
			int err = 0;
			if (!_rec || pa_simple_read(_rec, buf, kBytes10ms, &err) < 0) {
				if (!recover(_rec, PA_STREAM_RECORD, "call-in", errors, failures)) {
					break;
				}
				continue;
			}
			errors = 0;
			uint32_t newMicLevel = 0;
			auto lock = std::lock_guard(_transportMutex);
			if (_transport) {
				_transport->RecordedDataIsAvailable(buf, kSamples10ms, 2,
					kChannels, kRate, 0, 0, 0, false, newMicLevel);
			}
		}
	}

	std::mutex _transportMutex;
	webrtc::AudioTransport *_transport = nullptr;
	pa_simple *_play = nullptr;
	pa_simple *_rec = nullptr;
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

} // namespace Parvane
