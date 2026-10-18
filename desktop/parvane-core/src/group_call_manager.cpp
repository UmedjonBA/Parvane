// Parvane fork: реализация group_call_manager.h.
#include "parvane/group_call_manager.h"

#include <utility>

namespace parvane {

GroupCallManager::GroupCallManager(std::string selfAddr, const crypto::SigningKey *key,
                                   std::function<std::unique_ptr<MediaBackend>()> makeBackend,
                                   Callbacks cb)
    : self_(std::move(selfAddr)),
      key_(key),
      makeBackend_(std::move(makeBackend)),
      cb_(std::move(cb)) {}

void GroupCallManager::sendTo(const std::string &peer, const json &signal) {
    if (!cb_.sendV2) return;
    std::string gcid;
    if (signal.value("type", std::string()) != "group_invite") {
        std::lock_guard<std::mutex> lk(sendMutex_);
        gcid = sendGcid_;
    }
    (void)cb_.sendV2(peer, signal, gcid);
}

void GroupCallManager::handleV2Signal(const std::string &from, const json &signal) {
    auto sig = CallSignalIn::fromJson(signal);
    sig.authenticated = true;
    handleSignal(from, sig);
}

CallSession *GroupCallManager::ensureSession(const std::string &peer,
                                             const std::string &media) {
    auto it = peers_.find(peer);
    if (it != peers_.end()) {
        return it->second.get();
    }
    CallSession::Callbacks scb;
    scb.sendSignal = [this, peer](json sig) {
        sendTo(peer, sig);
    };
    scb.peerPubkey = [this, peer] {
        return cb_.peerPubkey ? cb_.peerPubkey(peer) : std::string();
    };
    scb.peerPubkeys = [this, peer] {
        return cb_.peerPubkeys ? cb_.peerPubkeys(peer) : std::vector<std::string>{};
    };
    if (cb_.sign) {
        scb.sign = cb_.sign;
    }
    scb.onState = [this, peer](CallState s) {
        if (cb_.onPeerState) cb_.onPeerState(peer, s);
    };
    auto sess = std::make_unique<CallSession>(
        self_, peer, key_, makeBackend_ ? makeBackend_() : nullptr, std::move(scb));
    auto *raw = sess.get();
    peers_[peer] = std::move(sess);
    (void)media;
    return raw;
}

void GroupCallManager::joinMesh(const std::string &gcid,
                                const std::vector<std::string> &participants,
                                const std::string &media) {
    gcid_ = gcid;
    {
        std::lock_guard<std::mutex> lk(sendMutex_);
        sendGcid_ = gcid;
    }
    media_ = media.empty() ? "audio" : media;
    for (const auto &peer : participants) {
        if (peer == self_) {
            continue;
        }
        auto *s = ensureSession(peer, media_);
        // Оффер инициирует тот, чей адрес МЕНЬШЕ (детерминированно, без glare).
        if (self_ < peer) {
            s->start(media_);
        }
        // Иначе ждём invite от peer (придёт в handleSignal → авто-приём).
    }
}

void GroupCallManager::startCall(const std::string &groupCallId,
                                 const std::vector<std::string> &participants,
                                 const std::string &media,
                                 const std::string &group,
                                 const std::string &title) {
    // Разослать приглашение всем другим участникам.
    for (const auto &peer : participants) {
        if (peer != self_) {
            sendTo(peer, groupInviteSignal(groupCallId, participants,
                                           media.empty() ? "audio" : media, group, title));
        }
    }
    std::lock_guard<std::mutex> lk(mutex_);
    joinMesh(groupCallId, participants, media);
}

void GroupCallManager::handleSignal(const std::string &from, const CallSignalIn &sig) {
    if (sig.type == "group_invite") {
        std::lock_guard<std::mutex> lk(mutex_);
        joinMesh(sig.group_call_id, sig.participants, sig.media);
        return;
    }
    if (sig.type == "media") {
        if (cb_.onMediaState) cb_.onMediaState(from, sig.audio_muted, sig.video_muted);
        return;
    }
    std::lock_guard<std::mutex> lk(mutex_);
    CallSession *s = nullptr;
    auto it = peers_.find(from);
    if (it != peers_.end()) {
        s = it->second.get();
    } else if (sig.type == "invite") {
        // Инвайт от участника, для которого сессии ещё нет (мы — answerer).
        s = ensureSession(from, sig.media.empty() ? "audio" : sig.media);
    }
    if (!s) {
        return;
    }
    s->onSignal(sig);
    // Групповой звонок — авто-приём входящего (нет отдельного «принять»).
    if (sig.type == "invite" && s->state() == CallState::Incoming) {
        s->accept();
    }
}

void GroupCallManager::leave() {
    std::lock_guard<std::mutex> lk(mutex_);
    for (auto &[peer, s] : peers_) {
        if (s) s->hangup();
    }
    peers_.clear();
    gcid_.clear();
    std::lock_guard<std::mutex> sl(sendMutex_);
    sendGcid_.clear();
}

int GroupCallManager::connectedCount() {
    std::lock_guard<std::mutex> lk(mutex_);
    int n = 0;
    for (auto &[peer, s] : peers_) {
        if (s && s->state() == CallState::Active) {
            ++n;
        }
    }
    return n;
}

void GroupCallManager::sendMediaState(bool audioMuted, bool videoMuted) {
    std::vector<std::pair<std::string, std::string>> targets;
    {
        std::lock_guard<std::mutex> lk(mutex_);
        for (auto &[peer, s] : peers_) {
            if (s) targets.emplace_back(peer, s->callId());
        }
    }
    for (const auto &[peer, id] : targets) sendTo(peer, mediaStateSignal(id, audioMuted, videoMuted));
}

std::string GroupCallManager::groupCallId() {
    std::lock_guard<std::mutex> lk(mutex_);
    return gcid_;
}

} // namespace parvane
