// Parvane fork: связка CallClient (сигналинг) + CallSession (оркестрация+крипто)
// в единый менеджер звонков для одного пользователя. Подписывается на инбокс
// call.user.<self>, ведёт ОДИН активный звонок 1-на-1, маршрутизирует сигналы в
// сессию, а исходящие сессии — в шину. Медиа-движок создаётся фабрикой (в форке
// и тестах Э4 — StubMediaBackend; в Э3-b — WebrtcMediaBackend). Потокобезопасен
// (onSignal приходит из потока cnats). См. desktop/CALLS-parvane.md.
#pragma once

#include <functional>
#include <memory>
#include <mutex>
#include <string>

#include "parvane/call_client.h"
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
    };

    CallManager(CallClient &calls, std::string selfAddr, std::string token,
                const crypto::SigningKey *key,
                std::function<std::unique_ptr<MediaBackend>()> makeBackend,
                Callbacks cb);

    // Подписаться на call.user.<self> (звать один раз после логина).
    void start();

    // Исходящий звонок. media: "audio"|"video".
    void placeCall(const std::string &peer, const std::string &media);
    // Принять входящий (после onIncoming).
    void accept();
    // Отбой/отклонение текущего.
    void hangup();

    [[nodiscard]] CallState state();
    [[nodiscard]] PeerAuth peerAuth();
    [[nodiscard]] std::string peer();

private:
    void handleSignal(const std::string &from, const CallSignalIn &sig);
    // Создаёт сессию с проводкой колбэков (звать под mutex_).
    void newSession(const std::string &peer);

    CallClient &calls_;
    std::string self_;
    std::string token_;
    const crypto::SigningKey *key_;
    std::function<std::unique_ptr<MediaBackend>()> makeBackend_;
    Callbacks cb_;

    std::mutex mutex_;
    std::unique_ptr<CallSession> session_;
    std::string peer_;
};

} // namespace parvane
