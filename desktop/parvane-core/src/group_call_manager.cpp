// Parvane fork: реализация group_call_manager.h.
#include "parvane/group_call_manager.h"

#include <algorithm>
#include <utility>

namespace parvane {
namespace {

// Сколько помнить замолчавший звонок (как web getRingTimeoutMs — время звонка) и сколько их держать.
constexpr auto kSilenceFor = std::chrono::seconds(45);
constexpr std::size_t kSilenceLimit = 64;

} // namespace

GroupCallManager::GroupCallManager(std::string selfAddr, const crypto::SigningKey *key,
                                   std::function<std::unique_ptr<MediaBackend>()> makeBackend,
                                   Callbacks cb)
    : self_(std::move(selfAddr)),
      key_(key),
      makeBackend_(std::move(makeBackend)),
      cb_(std::move(cb)) {}

void GroupCallManager::sendTo(const std::string &peer, const json &signal, const std::string &groupCallId) {
    if (!cb_.sendV2) return;
    std::string gcid = groupCallId;
    if (gcid.empty() && signal.value("type", std::string()) != "group_invite") {
        std::lock_guard<std::mutex> lk(sendMutex_);
        gcid = sendGcid_;
    }
    (void)cb_.sendV2(peer, signal, gcid);
}

void GroupCallManager::declineCall(const std::string &gcid, const std::vector<std::string> &participants,
                                   const std::string &reason) {
    for (const auto &peer : participants) {
        if (peer != self_) sendTo(peer, rejectSignal(gcid, reason), gcid);
    }
}

void GroupCallManager::silence(const std::string &gcid, bool quiet) {
    const auto now = std::chrono::steady_clock::now();
    for (auto it = silenced_.begin(); it != silenced_.end();) {
        it = (it->second.first < now) ? silenced_.erase(it) : std::next(it);
    }
    while (silenced_.size() >= kSilenceLimit) silenced_.erase(silenced_.begin());
    silenced_[gcid] = {now + kSilenceFor, quiet};
}

bool GroupCallManager::isSilenced(const std::string &gcid, bool *quiet) {
    const auto it = silenced_.find(gcid);
    if (it == silenced_.end()) return false;
    if (it->second.first < std::chrono::steady_clock::now()) {
        silenced_.erase(it);
        return false;
    }
    if (quiet) *quiet = it->second.second;
    return true;
}

void GroupCallManager::handleV2Signal(const std::string &from, const json &signal) {
    auto sig = CallSignalIn::fromJson(signal);
    sig.authenticated = true;
    if (from == self_) {
        // Своё другое устройство приняло или отклонило приглашение (spec 024): здесь оно замолкает
        if (sig.type != "reject") return;
        std::string closed;
        {
            std::lock_guard<std::mutex> lk(mutex_);
            silence(sig.call_id, true);
            if (pending_ && pending_->gcid == sig.call_id) {
                closed = pending_->gcid;
                pending_.reset();
            }
        }
        if (!closed.empty() && cb_.onInviteClosed) cb_.onInviteClosed(closed);
        return;
    }
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
    if (sig.type == "media") {
        if (cb_.onMediaState) cb_.onMediaState(from, sig.audio_muted, sig.video_muted);
        return;
    }
    if (sig.type == "group_invite") {
        const auto busyElsewhere = cb_.isBusy && cb_.isBusy();
        std::optional<PendingInvite> started;
        {
            std::lock_guard<std::mutex> lk(mutex_);
            if (!gcid_.empty() && gcid_ == sig.group_call_id) return; // уже в этом звонке
            if (pending_ && pending_->gcid == sig.group_call_id) return; // уже ждёт решения
            if (busyElsewhere || !gcid_.empty() || pending_) {
                // «Занят» — всем участникам сразу, один раз на звонок; замолчавший — не отвечаем вовсе
                if (!isSilenced(sig.group_call_id)) declineCall(sig.group_call_id, sig.participants, "busy");
                silence(sig.group_call_id, false);
                return;
            }
            if (isSilenced(sig.group_call_id)) return;
            pending_ = PendingInvite{from, sig.group_call_id, sig.participants,
                                     sig.media.empty() ? "audio" : sig.media, sig.group, sig.title, {}};
            started = pending_;
        }
        if (started && cb_.onInvite) {
            cb_.onInvite(started->from, started->gcid, started->participants, started->media, started->group,
                         started->title);
        }
        return;
    }
    std::string declinedReason;
    {
        std::lock_guard<std::mutex> lk(mutex_);
        // Парные сигналы участников до решения пользователя — в буфер
        if (pending_ && std::find(pending_->participants.begin(), pending_->participants.end(), from)
                            != pending_->participants.end()) {
            auto &buf = pending_->buffered;
            if (sig.type == "hangup") {
                buf.erase(std::remove_if(buf.begin(), buf.end(), [&](const Buffered &b) {
                    return b.from == from && b.sig.call_id == sig.call_id;
                }), buf.end());
                return;
            }
            if (sig.type == "reject" && sig.call_id == pending_->gcid) {
                // Отказ уровня звонка от участника — его строка в будущем mesh не нужна
                buf.erase(std::remove_if(buf.begin(), buf.end(), [&](const Buffered &b) {
                    return b.from == from;
                }), buf.end());
                return;
            }
            buf.push_back({from, sig});
            return;
        }
        bool quiet = false;
        if (!sig.group_call_id.empty() && sig.group_call_id != gcid_ && isSilenced(sig.group_call_id, &quiet)) {
            return; // звонок, замолчавший здесь, — пары молча
        }
        if (sig.type == "reject" && !gcid_.empty() && sig.call_id == gcid_) {
            // Участник отклонил звонок или занят — его строку закрыть сразу
            if (auto it = peers_.find(from); it != peers_.end()) {
                if (it->second) it->second->dismiss();
                peers_.erase(it);
            }
            declinedReason = sig.reason.value_or("declined");
        } else {
            handleMeshSignalLocked(from, sig);
        }
    }
    if (!declinedReason.empty() && cb_.onPeerDeclined) cb_.onPeerDeclined(from, declinedReason);
}

void GroupCallManager::handleMeshSignalLocked(const std::string &from, const CallSignalIn &sig) {
    // Сигнал прошлого звонка (опоздавший отбой) — не трогать сессию текущего с тем же участником
    if (!sig.group_call_id.empty() && sig.group_call_id != gcid_) return;
    CallSession *s = nullptr;
    auto it = peers_.find(from);
    if (it != peers_.end()) {
        s = it->second.get();
        if (s && sig.type != "invite" && !s->callId().empty() && sig.call_id != s->callId()) return;
    } else if (sig.type == "invite") {
        if (gcid_.empty()) return; // не в звонке — парный invite некуда принять
        // Инвайт от участника, для которого сессии ещё нет (мы — answerer).
        s = ensureSession(from, sig.media.empty() ? "audio" : sig.media);
    }
    if (!s) {
        return;
    }
    s->onSignal(sig);
    // Внутри принятого звонка парный invite участника принимается сам
    if (sig.type == "invite" && s->state() == CallState::Incoming) {
        s->accept();
    }
}

bool GroupCallManager::acceptInvite() {
    std::lock_guard<std::mutex> lk(mutex_);
    if (!pending_) return false;
    auto pending = std::move(*pending_);
    pending_.reset();
    silence(pending.gcid, true); // повторное приглашение того же звонка не звонит
    joinMesh(pending.gcid, pending.participants, pending.media);
    for (const auto &b : pending.buffered) handleMeshSignalLocked(b.from, b.sig);
    return true;
}

bool GroupCallManager::declineInvite(const std::string &reason) {
    std::string closed;
    {
        std::lock_guard<std::mutex> lk(mutex_);
        if (!pending_) return false;
        auto pending = std::move(*pending_);
        pending_.reset();
        // Парный invite от участника — попарный отказ; отказ уровня звонка — всем (и инициатору с бóльшим
        // адресом, от которого парного invite нет)
        for (const auto &b : pending.buffered) {
            if (b.sig.type == "invite") sendTo(b.from, rejectSignal(b.sig.call_id, reason), pending.gcid);
        }
        declineCall(pending.gcid, pending.participants, reason);
        silence(pending.gcid, false);
        closed = pending.gcid;
    }
    if (cb_.onInviteClosed) cb_.onInviteClosed(closed);
    return true;
}

void GroupCallManager::expireInvite(const std::string &groupCallId) {
    {
        std::lock_guard<std::mutex> lk(mutex_);
        if (!pending_ || pending_->gcid != groupCallId) return;
    }
    (void)declineInvite("declined");
}

std::string GroupCallManager::pendingInviteId() {
    std::lock_guard<std::mutex> lk(mutex_);
    return pending_ ? pending_->gcid : std::string();
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
