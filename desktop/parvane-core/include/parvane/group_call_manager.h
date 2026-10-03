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
        // Ключи подписи всех устройств собеседника (см. CallSession::Callbacks)
        std::function<std::vector<std::string>(std::string peer)> peerPubkeys;
        // Своя подпись вместо key (см. CallSession::Callbacks::sign); "" → key.
        std::function<std::string(const std::string &data)> sign;
        // Протокол v2 (T141): сигнал участнику запечатанным конвертом.
        // groupCallId пуст у самого приглашения (group_invite). true — сигнал
        // ушёл по v2; false — идти v1-инбоксом gcall:<адрес>.
        std::function<bool(const std::string &peer, const json &signal,
                           const std::string &groupCallId)> sendV2;
    };

    GroupCallManager(CallClient &calls, std::string selfAddr, std::string token,
                     const crypto::SigningKey *key,
                     std::function<std::unique_ptr<MediaBackend>()> makeBackend,
                     Callbacks cb);

    // Подписаться на инбокс call.user.<self>.
    void start();

    // Сигнал группового звонка, принятый по протоколу v2 (отправитель проверен
    // движком) — тот же путь, что у сигнала с шины, без проверки подписи SDP.
    void handleV2Signal(const std::string &from, const json &signal);

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
    // Сигнал участнику: v2, если возможно, иначе инбокс gcall:<адрес>.
    void sendTo(const std::string &peer, const json &signal);
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
    // Копия gcid_ для отправки: колбэки сессий зовутся и под mutex_, и с
    // потоков медиа-движка (ICE-кандидаты) — свой замок, без рекурсии.
    std::mutex sendMutex_;
    std::string sendGcid_;
    std::string gcid_;
    std::string media_ = "audio";
    std::map<std::string, std::unique_ptr<CallSession>> peers_;
};

} // namespace parvane
