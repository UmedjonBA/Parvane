// Parvane fork: групповой звонок как MESH из 1-на-1 CallSession (для небольших
// групп; SFU — на будущее). У звонка есть group_call_id; каждый участник строит
// P2P-соединение с каждым другим. Оффер инициирует тот, чей адрес меньше
// (защита от glare). Входящие в групповой звонок авто-принимаются. Переиспользует
// CallSession (крипто-гейтинг подписи SDP) и CallClient (сигналинг). Медиа-движок
// — фабрикой (Stub в тестах / Webrtc в бою). Потокобезопасен.
#pragma once

#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "parvane/call_client.h"
#include "parvane/call_session.h"
#include "parvane/crypto.h"

namespace parvane {

class GroupCallManager {
public:
    struct Callbacks {
        // Смена состояния соединения с конкретным участником (для UI).
        std::function<void(std::string peer, CallState)> onPeerState;
        // Публичный ключ участника (base64) для проверки подписи; "" — нет.
        std::function<std::string(std::string peer)> peerPubkey;
    };

    GroupCallManager(CallClient &calls, std::string selfAddr, std::string token,
                     const crypto::SigningKey *key,
                     std::function<std::unique_ptr<MediaBackend>()> makeBackend,
                     Callbacks cb);

    // Подписаться на инбокс call.user.<self>.
    void start();

    // Инициировать групповой звонок: разослать group_invite всем участникам и
    // самому войти в mesh. participants — полный список (включая себя).
    void startCall(const std::string &groupCallId,
                   const std::vector<std::string> &participants,
                   const std::string &media = "audio");

    // Выйти: положить все P2P-сессии.
    void leave();

    // Сколько участников в состоянии Active (P2P установлен).
    [[nodiscard]] int connectedCount();
    [[nodiscard]] std::string groupCallId();

private:
    void handleSignal(const std::string &from, const CallSignalIn &sig);
    // Войти в mesh: создать сессии ко всем участникам; оффер — тем, чей адрес
    // больше нашего. Звать под mutex_.
    void joinMesh(const std::string &gcid, const std::vector<std::string> &participants,
                  const std::string &media);
    // Создать (идемпотентно) сессию к участнику peer. Под mutex_.
    CallSession *ensureSession(const std::string &peer, const std::string &media);

    CallClient &calls_;
    std::string self_;
    std::string token_;
    const crypto::SigningKey *key_;
    std::function<std::unique_ptr<MediaBackend>()> makeBackend_;
    Callbacks cb_;

    std::mutex mutex_;
    std::string gcid_;
    std::string media_ = "audio";
    std::map<std::string, std::unique_ptr<CallSession>> peers_;
};

} // namespace parvane
