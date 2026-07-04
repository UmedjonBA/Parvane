// Parvane fork: реализация call_manager.h.
#include "parvane/call_manager.h"

#include <utility>

namespace parvane {

CallManager::CallManager(CallClient &calls, std::string selfAddr, std::string token,
                         const crypto::SigningKey *key,
                         std::function<std::unique_ptr<MediaBackend>()> makeBackend,
                         Callbacks cb)
    : calls_(calls),
      self_(std::move(selfAddr)),
      token_(std::move(token)),
      key_(key),
      makeBackend_(std::move(makeBackend)),
      cb_(std::move(cb)) {}

void CallManager::start() {
    calls_.onSignal(self_, [this](std::string from, CallSignalIn sig) {
        handleSignal(from, sig);
    });
}

void CallManager::newSession(const std::string &peer) {
    peer_ = peer;
    CallSession::Callbacks scb;
    scb.sendSignal = [this](json signal) {
        calls_.send(self_, peer_, token_, signal);
    };
    scb.peerPubkey = [this] {
        return cb_.peerPubkey ? cb_.peerPubkey(peer_) : std::string();
    };
    scb.onState = [this](CallState s) {
        if (cb_.onState) cb_.onState(s);
    };
    session_ = std::make_unique<CallSession>(self_, peer, key_,
                                             makeBackend_ ? makeBackend_() : nullptr,
                                             std::move(scb));
}

void CallManager::placeCall(const std::string &peer, const std::string &media) {
    std::lock_guard<std::mutex> lk(mutex_);
    newSession(peer);
    session_->start(media);
}

void CallManager::handleSignal(const std::string &from, const CallSignalIn &sig) {
    std::lock_guard<std::mutex> lk(mutex_);
    if (sig.type == "invite") {
        // Заняты другим активным звонком → busy.
        const bool busy = session_ && session_->state() != CallState::Ended
                          && session_->state() != CallState::Idle;
        if (busy) {
            calls_.send(self_, from, token_, rejectSignal(sig.call_id, "busy"));
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
        session_->onSignal(sig);
    }
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
