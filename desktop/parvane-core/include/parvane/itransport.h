// Parvane fork: абстрактный транспорт шины. Позволяет подставлять либо прямой
// NATS (parvane::Transport, cnats), либо доступ через gateway
// (parvane::GatewayTransport, TCP). Высокоуровневые клиенты (MessengerClient,
// CloudClient, CallClient, GroupClient) держат ссылку на ITransport и не знают,
// какой транспорт под ними. Жизненный цикл (connect/authenticate/close) —
// ответственность владельца транспорта, не этого интерфейса.
#pragma once

#include <cstdint>
#include <functional>
#include <string>

namespace parvane {

class ITransport {
public:
    virtual ~ITransport() = default;

    // Ответ приходит несколькими кусками (chunked download): onReply на каждый,
    // true — ждать ещё, false — стоп.
    using ReplyHandler = std::function<bool(const std::string &reply)>;
    // Входящее сообщение подписки: (subject, payload) на потоке доставки.
    using Handler = std::function<void(std::string subject, std::string payload)>;

    // request/reply (один ответ). Бросает при таймауте/ошибке.
    virtual std::string request(const std::string &subject, const std::string &payload,
                                std::int64_t timeout_ms) = 0;

    // fire-and-forget.
    virtual void publish(const std::string &subject, const std::string &payload) = 0;

    // request с несколькими ответами (см. ReplyHandler).
    virtual void requestMany(const std::string &subject, const std::string &payload,
                             const ReplyHandler &onReply, std::int64_t timeout_ms) = 0;

    // Асинхронная подписка.
    virtual void subscribe(const std::string &subject, Handler handler) = 0;
};

} // namespace parvane
