// Parvane fork: высокоуровневый call-клиент поверх Transport. Инкапсулирует
// сборку конверта ParvaneEvent<CallSignalPayload>, отправку сигналов и подписку
// на персональный инбокс call.user.<addr>. Медиа (WebRTC) — вне parvane-core;
// этот клиент только сигналинг (Фаза 4).
//
// Потокобезопасность: sendSignal/history блокирующие (звать из worker-потока).
// onSignal-хэндлер зовётся из NATS-потока cnats — переноси на main сам.
#pragma once

#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <vector>

#include "parvane/call.h"
#include "parvane/transport.h"

namespace parvane {

class CallClient {
public:
    explicit CallClient(Transport &transport) : _t(transport) {}

    // Сигналы вызова. callId — общий uuid звонка (генерирует инициатор для
    // invite, остальные повторяют его). media: "audio"|"video".
    void invite(const std::string &from, const std::string &to, const std::string &token,
                const std::string &callId, const std::string &media, const std::string &sdp);
    void answer(const std::string &from, const std::string &to, const std::string &token,
                const std::string &callId, const std::string &sdp);
    void reject(const std::string &from, const std::string &to, const std::string &token,
                const std::string &callId, const std::optional<std::string> &reason = std::nullopt);
    void ice(const std::string &from, const std::string &to, const std::string &token,
             const std::string &callId, const std::string &candidate);
    void hangup(const std::string &from, const std::string &to, const std::string &token,
                const std::string &callId);

    // Отправить ПРОИЗВОЛЬНЫЙ сигнал (например, уже подписанный CallSession JSON)
    // собеседнику to. Инкапсулирует конверт + топик call.signal.
    void send(const std::string &from, const std::string &to,
              const std::string &token, const json &signal);

    // Подписка на инбокс call.user.<me>. handler(from, signal) на каждый
    // входящий relay-сигнал. me — свой полный адрес (например "bob@local").
    void onSignal(const std::string &me,
                  std::function<void(std::string from, CallSignalIn signal)> handler);

    // История звонков пользователя (request/reply, полный конверт).
    std::vector<CallRecord> history(const std::string &from, const std::string &token,
                                    int timeoutMs = 3000);

private:
    Transport &_t;
};

} // namespace parvane
