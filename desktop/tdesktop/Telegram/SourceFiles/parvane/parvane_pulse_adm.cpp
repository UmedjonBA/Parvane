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
#include <cstring>
#include <thread>

namespace Parvane {
namespace {

// 48 кГц, моно, 16 бит — стандарт для webrtc ADM; кадр 10 мс = 480 сэмплов.
constexpr int kRate = 48000;
constexpr int kChannels = 1;
constexpr int kSamples10ms = kRate / 100; // 480
constexpr int kBytes10ms = kSamples10ms * 2 * kChannels;

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
	void playLoop() {
		int16_t buf[kSamples10ms];
		while (_playing) {
			size_t out = 0;
			int64_t elapsed = 0, ntp = 0;
			if (_transport) {
				_transport->NeedMorePlayData(kSamples10ms, 2, kChannels,
					kRate, buf, out, &elapsed, &ntp);
			}
			if (out == 0) {
				std::memset(buf, 0, sizeof(buf));
				out = kSamples10ms;
			}
			int err = 0;
			if (_play) {
				pa_simple_write(_play, buf, out * 2 * kChannels, &err);
			}
		}
	}
	void recLoop() {
		int16_t buf[kSamples10ms];
		while (_recording) {
			int err = 0;
			if (!_rec || pa_simple_read(_rec, buf, kBytes10ms, &err) < 0) {
				continue;
			}
			uint32_t newMicLevel = 0;
			if (_transport) {
				_transport->RecordedDataIsAvailable(buf, kSamples10ms, 2,
					kChannels, kRate, 0, 0, 0, false, newMicLevel);
			}
		}
	}

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
