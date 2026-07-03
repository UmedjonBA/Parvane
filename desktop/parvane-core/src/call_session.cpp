// Parvane fork: реализация call_session.h.
#include "parvane/call_session.h"

#include "parvane/ids.h"

#include <utility>

namespace parvane {

CallSession::CallSession(std::string selfAddr, std::string peerAddr,
                         const crypto::SigningKey *key,
                         std::unique_ptr<MediaBackend> media, Callbacks cb)
    : self_(std::move(selfAddr)),
      peer_(std::move(peerAddr)),
      key_(key),
      media_engine_(std::move(media)),
      cb_(std::move(cb)) {
    wireMedia();
}

void CallSession::wireMedia() {
    if (!media_engine_) return;
    // Локальные ICE-кандидаты движка → пересылаем собеседнику.
    media_engine_->onLocalIce = [this](std::string candidate) {
        if (state_ == CallState::Ended) return;
        if (cb_.sendSignal) cb_.sendSignal(iceSignal(callId_, candidate));
    };
    // Установление/разрыв P2P.
    media_engine_->onConnectionChange = [this](bool connected) {
        if (state_ == CallState::Ended) return;
        setState(connected ? CallState::Active : CallState::Ended);
    };
}

void CallSession::setState(CallState s) {
    if (state_ == s) return;
    state_ = s;
    if (cb_.onState) cb_.onState(s);
}

std::string CallSession::signSdp(const std::string &sdp) const {
    if (!key_) return "";
    return key_->sign(callSignedData(callId_, sdp));
}

bool CallSession::authenticateSdp(const std::string &sdp, const std::string &sig) {
    const std::string pub = cb_.peerPubkey ? cb_.peerPubkey() : std::string();
    if (pub.empty()) {
        // У собеседника нет зарегистрированного ключа — проверить нечем.
        // Пропускаем, но помечаем как неаутентифицированный (UI покажет).
        peerAuth_ = PeerAuth::Unverified;
        return true;
    }
    if (sig.empty() || !crypto::verify(pub, callSignedData(callId_, sdp), sig)) {
        // Ключ известен, но подпись отсутствует/невалидна → возможный MITM.
        peerAuth_ = PeerAuth::Failed;
        return false;
    }
    peerAuth_ = PeerAuth::Verified;
    return true;
}

void CallSession::start(const std::string &media) {
    if (state_ != CallState::Idle) return;
    media_ = media.empty() ? "audio" : media;
    callId_ = newUuidV7();
    if (!media_engine_) return;
    media_engine_->createOffer([this](std::string sdp) {
        if (state_ == CallState::Ended) return;
        const std::string sig = signSdp(sdp);
        if (cb_.sendSignal) cb_.sendSignal(inviteSignal(callId_, media_, sdp, sig));
        setState(CallState::Outgoing);
    });
}

void CallSession::onSignal(const CallSignalIn &sig) {
    if (state_ == CallState::Ended) return;

    if (sig.type == "invite") {
        // Входящий звонок. Сохраняем offer, аутентифицируем, ждём accept().
        callId_ = sig.call_id;
        media_ = sig.media.empty() ? "audio" : sig.media;
        remoteOffer_ = sig.sdp;
        if (!authenticateSdp(sig.sdp, sig.sig)) {
            // MITM/невалидная подпись → сразу отклоняем.
            if (cb_.sendSignal) cb_.sendSignal(rejectSignal(callId_, "auth_failed"));
            setState(CallState::Ended);
            return;
        }
        setState(CallState::Incoming);

    } else if (sig.type == "answer") {
        // Наш исходящий приняли. Проверяем подпись answer и заводим медиа.
        if (state_ != CallState::Outgoing) return;
        if (!authenticateSdp(sig.sdp, sig.sig)) {
            if (cb_.sendSignal) cb_.sendSignal(hangupSignal(callId_));
            if (media_engine_) media_engine_->close();
            setState(CallState::Ended);
            return;
        }
        if (media_engine_) media_engine_->setRemoteAnswer(sig.sdp);
        setState(CallState::Connecting);

    } else if (sig.type == "ice") {
        if (media_engine_ && !sig.candidate.empty()) {
            media_engine_->addRemoteIce(sig.candidate);
        }

    } else if (sig.type == "reject" || sig.type == "hangup") {
        if (media_engine_) media_engine_->close();
        setState(CallState::Ended);
    }
}

void CallSession::accept() {
    if (state_ != CallState::Incoming || !media_engine_) return;
    media_engine_->acceptOffer(remoteOffer_, [this](std::string answerSdp) {
        if (state_ == CallState::Ended) return;
        const std::string sig = signSdp(answerSdp);
        if (cb_.sendSignal) cb_.sendSignal(answerSignal(callId_, answerSdp, sig));
        setState(CallState::Connecting);
    });
}

void CallSession::hangup() {
    if (state_ == CallState::Ended) return;
    // До установления — reject (мы ещё не приняли); иначе hangup.
    if (cb_.sendSignal) {
        if (state_ == CallState::Incoming) {
            cb_.sendSignal(rejectSignal(callId_, "declined"));
        } else {
            cb_.sendSignal(hangupSignal(callId_));
        }
    }
    if (media_engine_) media_engine_->close();
    setState(CallState::Ended);
}

} // namespace parvane
