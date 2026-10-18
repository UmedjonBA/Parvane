// Parvane fork: реализация call_manager.h.
#include "parvane/call_manager.h"

#include <utility>

namespace parvane {

CallManager::CallManager(std::string selfAddr, const crypto::SigningKey *key,
                         std::function<std::unique_ptr<MediaBackend>()> makeBackend,
                         Callbacks cb)
    : self_(std::move(selfAddr)),
      key_(key),
      makeBackend_(std::move(makeBackend)),
      cb_(std::move(cb)) {}

void CallManager::newSession(const std::string &peer) {
    peer_ = peer;
    CallSession::Callbacks scb;
    scb.sendSignal = [this](json signal) {
        sendTo(peer_, signal);
    };
    scb.peerPubkey = [this] {
        return cb_.peerPubkey ? cb_.peerPubkey(peer_) : std::string();
    };
    scb.peerPubkeys = [this] {
        return cb_.peerPubkeys ? cb_.peerPubkeys(peer_) : std::vector<std::string>{};
    };
    if (cb_.sign) {
        scb.sign = cb_.sign;
    }
    scb.onState = [this](CallState s) {
        if (cb_.onState) cb_.onState(s);
    };
    session_ = std::make_unique<CallSession>(self_, peer, key_,
                                             makeBackend_ ? makeBackend_() : nullptr,
                                             std::move(scb));
}

void CallManager::sendTo(const std::string &peer, const json &signal) {
    // Только v2: не ушло — звонок завершится по таймауту ожидания ответа
    if (cb_.sendV2) (void)cb_.sendV2(peer, signal);
}

void CallManager::handleV2Signal(const std::string &from, const json &signal) {
    auto sig = CallSignalIn::fromJson(signal);
    sig.authenticated = true;
    handleSignal(from, sig);
}

void CallManager::placeCall(const std::string &peer, const std::string &media) {
    std::lock_guard<std::mutex> lk(mutex_);
    newSession(peer);
    session_->start(media);
}

void CallManager::handleSignal(const std::string &from, const CallSignalIn &sig) {
    std::lock_guard<std::mutex> lk(mutex_);
    if (sig.type == "invite") {
        // Тот же вызов вторым путём (v2 и v1, LEGACY-1) — уже обрабатывается.
        if (session_ && from == peer_ && sig.call_id == session_->callId()) {
            return;
        }
        // Заняты другим активным звонком → busy.
        const bool busy = session_ && session_->state() != CallState::Ended
                          && session_->state() != CallState::Idle;
        if (busy) {
            sendTo(from, rejectSignal(sig.call_id, "busy"));
            return;
        }
        newSession(from);
        session_->onSignal(sig); // → Incoming (или Ended при провале подписи)
        if (session_->state() == CallState::Incoming && cb_.onIncoming) {
            cb_.onIncoming(from, sig.media.empty() ? "audio" : sig.media);
        }
        return;
    }
    // Остальные сигналы — активной сессии, если callId совпадает.
    if (session_ && sig.call_id == session_->callId()) {
        if (sig.type == "media") {
            if (cb_.onMediaState) cb_.onMediaState(from, sig.audio_muted, sig.video_muted);
            return;
        }
        session_->onSignal(sig);
    }
}

void CallManager::sendMediaState(bool audioMuted, bool videoMuted) {
    std::lock_guard<std::mutex> lk(mutex_);
    if (session_ && !peer_.empty()) sendTo(peer_, mediaStateSignal(session_->callId(), audioMuted, videoMuted));
}

std::string CallManager::callId() {
    std::lock_guard<std::mutex> lk(mutex_);
    return session_ ? session_->callId() : std::string();
}

void CallManager::accept() {
    std::lock_guard<std::mutex> lk(mutex_);
    if (session_) session_->accept();
}

void CallManager::hangup() {
    std::lock_guard<std::mutex> lk(mutex_);
    if (session_) session_->hangup();
}

void CallManager::setMuted(bool muted) {
    std::lock_guard<std::mutex> lk(mutex_);
    if (session_) session_->setMuted(muted);
}

CallState CallManager::state() {
    std::lock_guard<std::mutex> lk(mutex_);
    return session_ ? session_->state() : CallState::Idle;
}

PeerAuth CallManager::peerAuth() {
    std::lock_guard<std::mutex> lk(mutex_);
    return session_ ? session_->peerAuth() : PeerAuth::Unknown;
}

std::string CallManager::peer() {
    std::lock_guard<std::mutex> lk(mutex_);
    return peer_;
}

} // namespace parvane
