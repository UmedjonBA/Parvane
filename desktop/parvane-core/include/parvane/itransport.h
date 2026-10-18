// Parvane fork: абстрактный транспорт запросов «subject + JSON» — в spec 029 его реализует только мост
// v2 (v2_bridge.h): вход, профили, поиск и прочие методы аккаунта. Переписка, группы и звонки идут v2-сессией.
#pragma once

#include <cstdint>
#include <functional>
#include <stdexcept>
#include <string>

namespace parvane {

// Бросается на ошибках соединения/запроса (вкл. таймаут request).
class TransportError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};


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
