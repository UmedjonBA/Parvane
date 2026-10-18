// Parvane fork: менеджер звонков одного пользователя над CallSession (оркестрация). Ведёт ОДИН активный
// звонок 1-на-1; сигналы — только протоколом v2 (spec 029: v1-шарда звонков нет): входящие подаёт хост
// (handleV2Signal), исходящие уходят колбэком sendV2. Медиа-движок создаётся фабрикой (в форке
// и тестах Э4 — StubMediaBackend; в Э3-b — WebrtcMediaBackend). Потокобезопасен
// (onSignal приходит из потока cnats). См. desktop/CALLS-parvane.md.
#pragma once

#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "parvane/call.h"
#include "parvane/call_session.h"
#include "parvane/crypto.h"

namespace parvane {

class CallManager {
public:
    struct Callbacks {
        // Нам звонят (входящий invite прошёл аутентификацию). peer — инициатор.
        std::function<void(std::string peer, std::string media)> onIncoming;
        // Смена состояния активного звонка (для UI). НЕ звать методы менеджера
        // синхронно из этого колбэка (мьютекс не рекурсивный).
        std::function<void(CallState)> onState;
        // Публичный ключ собеседника (base64) для проверки подписи; "" — нет.
        std::function<std::string(std::string peer)> peerPubkey;
        // Ключи подписи всех устройств собеседника (см. CallSession::Callbacks)
        std::function<std::vector<std::string>(std::string peer)> peerPubkeys;
        // Своя подпись вместо key (см. CallSession::Callbacks::sign); "" → key.
        std::function<std::string(const std::string &data)> sign;
        // Протокол v2: отправить сигнал собеседнику запечатанным конвертом.
        // true — сигнал взят v2 (по v1 не дублировать), false — собеседник на v1.
        std::function<bool(const std::string &peer, const json &signal)> sendV2;
        // spec 024: собеседник выключил/включил микрофон или камеру.
        std::function<void(const std::string &peer, bool audioMuted, bool videoMuted)> onMediaState;
    };

    CallManager(std::string selfAddr, const crypto::SigningKey *key,
                std::function<std::unique_ptr<MediaBackend>()> makeBackend,
                Callbacks cb);

    // Сигнал личного звонка, принятый по протоколу v2 (отправитель проверен
    // движком) — тот же путь, что у сигнала с шины, без проверки подписи SDP.
    void handleV2Signal(const std::string &from, const json &signal);

    // Исходящий звонок. media: "audio"|"video".
    void placeCall(const std::string &peer, const std::string &media);
    // Принять входящий (после onIncoming).
    void accept();
    // Отбой/отклонение текущего.
    void hangup();
    // spec 024: свой входящий `callId` принят/отклонён другим своим устройством — закрыть молча. false — не он.
    bool dismissIncoming(const std::string &callId);
    // Заглушить/включить свой микрофон в текущем звонке.
    void setMuted(bool muted);
    // spec 024: сообщить собеседнику, что свой микрофон/камера выключены.
    void sendMediaState(bool audioMuted, bool videoMuted);
    // id текущего звонка ("" — звонка нет).
    [[nodiscard]] std::string callId();

    [[nodiscard]] CallState state();
    [[nodiscard]] PeerAuth peerAuth();
    [[nodiscard]] std::string peer();

private:
    void handleSignal(const std::string &from, const CallSignalIn &sig);
    // Сигнал собеседнику: по v2, если он на v2, иначе шардом call (под mutex_).
    void sendTo(const std::string &peer, const json &signal);
    // Создаёт сессию с проводкой колбэков (звать под mutex_).
    void newSession(const std::string &peer);

    std::string self_;
    const crypto::SigningKey *key_;
    std::function<std::unique_ptr<MediaBackend>()> makeBackend_;
    Callbacks cb_;

    std::mutex mutex_;
    std::unique_ptr<CallSession> session_;
    std::string peer_;
};

} // namespace parvane
