// Parvane fork: групповой звонок как MESH из 1-на-1 CallSession (для небольших
// групп; SFU — на будущее). У звонка есть group_call_id; каждый участник строит
// P2P-соединение с каждым другим. Оффер инициирует тот, чей адрес меньше
// (защита от glare). Приглашение ждёт решения пользователя (как web calls.ts): парные сигналы
// участников копятся до «Принять»; «Отклонить» и таймаут — отказ уровня звонка всем участникам;
// занятому — «занят»; принятое/отклонённое другим своим устройством замолкает молча. Переиспользует
// CallSession; сигналы — только протоколом v2 (spec 029): входящие подаёт хост, исходящие — sendV2. Медиа-движок
// — фабрикой (Stub в тестах / Webrtc в бою). Потокобезопасен.
#pragma once

#include <chrono>
#include <functional>
#include <optional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "parvane/call.h"
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
        // ушёл по v2.
        std::function<bool(const std::string &peer, const json &signal,
                           const std::string &groupCallId)> sendV2;
        // spec 024: участник выключил/включил микрофон или камеру.
        std::function<void(const std::string &peer, bool audioMuted, bool videoMuted)> onMediaState;
        // Входящее приглашение ждёт решения: показать экран «Принять / Отклонить». Зовётся без замков.
        std::function<void(const std::string &from, const std::string &groupCallId,
                           const std::vector<std::string> &participants, const std::string &media,
                           const std::string &group, const std::string &title)> onInvite;
        // Приглашение закрыто без «Принять» (отклонено, истекло, решено другим своим устройством).
        std::function<void(const std::string &groupCallId)> onInviteClosed;
        // Участник отказался от звонка ("declined" | "busy") — строку о нём закрыть.
        std::function<void(const std::string &peer, const std::string &reason)> onPeerDeclined;
        // Занят ли клиент другим (личным) звонком: тогда приглашению — «занят».
        std::function<bool()> isBusy;
    };

    GroupCallManager(std::string selfAddr, const crypto::SigningKey *key,
                     std::function<std::unique_ptr<MediaBackend>()> makeBackend,
                     Callbacks cb);

    // Сигнал группового звонка, принятый по протоколу v2 (отправитель проверен
    // движком) — тот же путь, что у сигнала с шины, без проверки подписи SDP.
    void handleV2Signal(const std::string &from, const json &signal);

    // Инициировать групповой звонок: разослать group_invite всем участникам и
    // самому войти в mesh. participants — полный список (включая себя).
    // group/title — адрес и название группы (CALL-2: у адресатов во входящем звонке).
    void startCall(const std::string &groupCallId,
                   const std::vector<std::string> &participants,
                   const std::string &media = "audio",
                   const std::string &group = std::string(),
                   const std::string &title = std::string());
    // spec 024: свой микрофон/камера выключены — всем участникам.
    void sendMediaState(bool audioMuted, bool videoMuted);

    // Ожидающее приглашение: принять (войти в mesh и разобрать накопленные сигналы) либо отклонить
    // (отказ уровня звонка всем участникам; reason — "declined"). false — приглашения нет.
    bool acceptInvite();
    bool declineInvite(const std::string &reason = "declined");
    // Таймаут звонка: отклонить, если ожидающее приглашение всё ещё `groupCallId`.
    void expireInvite(const std::string &groupCallId);
    // id ожидающего приглашения ("" — нет).
    [[nodiscard]] std::string pendingInviteId();

    // Выйти: положить все P2P-сессии.
    void leave();

    // Сколько участников в состоянии Active (P2P установлен).
    [[nodiscard]] int connectedCount();
    [[nodiscard]] std::string groupCallId();

private:
    struct Buffered {
        std::string from;
        CallSignalIn sig;
    };
    struct PendingInvite {
        std::string from;
        std::string gcid;
        std::vector<std::string> participants;
        std::string media;
        std::string group;
        std::string title;
        std::vector<Buffered> buffered;
    };
    void handleSignal(const std::string &from, const CallSignalIn &sig);
    // Парный сигнал mesh (под mutex_).
    void handleMeshSignalLocked(const std::string &from, const CallSignalIn &sig);
    // Сигнал участнику по v2. groupCallId — звонок, к которому он относится (пусто — текущий).
    void sendTo(const std::string &peer, const json &signal, const std::string &groupCallId = std::string());
    // Отказ уровня звонка (call_id = id группового звонка) — всем участникам, кроме себя.
    void declineCall(const std::string &gcid, const std::vector<std::string> &participants, const std::string &reason);
    // Звонок замолчал здесь: дальнейшие приглашения и сигналы по нему не отбиваются и не звонят.
    void silence(const std::string &gcid, bool quiet);
    [[nodiscard]] bool isSilenced(const std::string &gcid, bool *quiet = nullptr);
    // Войти в mesh: создать сессии ко всем участникам; оффер — тем, чей адрес
    // больше нашего. Звать под mutex_.
    void joinMesh(const std::string &gcid, const std::vector<std::string> &participants,
                  const std::string &media);
    // Создать (идемпотентно) сессию к участнику peer. Под mutex_.
    CallSession *ensureSession(const std::string &peer, const std::string &media);

    std::string self_;
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
    std::optional<PendingInvite> pending_;
    // Замолчавшие звонки: id → {срок, тихо (решено своим устройством)}.
    std::map<std::string, std::pair<std::chrono::steady_clock::time_point, bool>> silenced_;
};

} // namespace parvane
