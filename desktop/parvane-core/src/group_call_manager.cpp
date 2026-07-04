// Parvane fork: реализация group_call_manager.h.
#include "parvane/group_call_manager.h"

#include <utility>

namespace parvane {

// Префикс адреса для сигналинга ГРУППОВЫХ звонков — чтобы они шли в отдельный
// инбокс call.user.gcall:<addr> и НЕ пересекались с 1-на-1 CallManager (иначе
// per-pair инвайты группового звонка вызывали бы ложный «входящий звонок»).
namespace {
constexpr auto kGPrefix = "gcall:";
std::string gAddr(const std::string &a) { return std::string(kGPrefix) + a; }
} // namespace

GroupCallManager::GroupCallManager(CallClient &calls, std::string selfAddr,
                                   std::string token, const crypto::SigningKey *key,
                                   std::function<std::unique_ptr<MediaBackend>()> makeBackend,
                                   Callbacks cb)
    : calls_(calls),
      self_(std::move(selfAddr)),
      token_(std::move(token)),
      key_(key),
      makeBackend_(std::move(makeBackend)),
      cb_(std::move(cb)) {}

void GroupCallManager::start() {
    // Отдельный инбокс call.user.gcall:<self> — не пересекается с 1-на-1. `from`
    // в relayed-сигнале уже реальный (шард проверяет from == JWT), префикс — лишь
    // в `to` для маршрутизации.
    calls_.onSignal(gAddr(self_), [this](std::string from, CallSignalIn sig) {
        handleSignal(from, sig);
    });
}

CallSession *GroupCallManager::ensureSession(const std::string &peer,
                                             const std::string &media) {
    auto it = peers_.find(peer);
    if (it != peers_.end()) {
        return it->second.get();
    }
    CallSession::Callbacks scb;
    scb.sendSignal = [this, peer](json sig) {
        // from — реальный (шард сверяет с JWT); префикс только в `to` (инбокс).
        calls_.send(self_, gAddr(peer), token_, sig);
    };
    scb.peerPubkey = [this, peer] {
        return cb_.peerPubkey ? cb_.peerPubkey(peer) : std::string();
    };
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
                                 const std::string &media) {
    // Разослать приглашение всем другим участникам (в групповой инбокс).
    for (const auto &peer : participants) {
        if (peer != self_) {
            calls_.send(self_, gAddr(peer), token_,
                        groupInviteSignal(groupCallId, participants,
                                          media.empty() ? "audio" : media));
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

std::string GroupCallManager::groupCallId() {
    std::lock_guard<std::mutex> lk(mutex_);
    return gcid_;
}

} // namespace parvane
