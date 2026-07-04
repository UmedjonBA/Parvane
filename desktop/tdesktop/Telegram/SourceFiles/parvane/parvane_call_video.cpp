// Parvane fork: реализация parvane_call_video.h.
#include "parvane/parvane_call_video.h"

#include "webrtc/webrtc_video_track.h"

#include <api/video/video_sink_interface.h>
#include <api/video/video_frame.h>

#include <memory>
#include <mutex>

namespace Parvane {
namespace {

std::mutex g_mutex;
std::shared_ptr<Webrtc::VideoTrack> g_remote;
std::shared_ptr<Webrtc::VideoTrack> g_local;

void push(const std::shared_ptr<Webrtc::VideoTrack> &track,
		const webrtc::VideoFrame &frame) {
	if (!track) {
		return;
	}
	const auto sink = track->sink();
	if (sink) {
		sink->OnFrame(frame);
	}
}

} // namespace

void CreateCallVideoTracks() {
	std::lock_guard<std::mutex> lk(g_mutex);
	if (!g_remote) {
		g_remote = std::make_shared<Webrtc::VideoTrack>(
			Webrtc::VideoState::Active);
	}
	if (!g_local) {
		g_local = std::make_shared<Webrtc::VideoTrack>(
			Webrtc::VideoState::Active);
	}
}

void ResetCallVideoTracks() {
	std::lock_guard<std::mutex> lk(g_mutex);
	g_remote = nullptr;
	g_local = nullptr;
}

Webrtc::VideoTrack *CallRemoteVideoTrack() {
	std::lock_guard<std::mutex> lk(g_mutex);
	return g_remote.get();
}

Webrtc::VideoTrack *CallLocalVideoTrack() {
	std::lock_guard<std::mutex> lk(g_mutex);
	return g_local.get();
}

void PushRemoteVideoFrame(const webrtc::VideoFrame &frame) {
	std::shared_ptr<Webrtc::VideoTrack> track;
	{
		std::lock_guard<std::mutex> lk(g_mutex);
		track = g_remote;
	}
	push(track, frame);
}

void PushLocalVideoFrame(const webrtc::VideoFrame &frame) {
	std::shared_ptr<Webrtc::VideoTrack> track;
	{
		std::lock_guard<std::mutex> lk(g_mutex);
		track = g_local;
	}
	push(track, frame);
}

} // namespace Parvane
