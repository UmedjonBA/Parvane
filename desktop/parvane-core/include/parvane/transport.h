// Parvane fork: тонкая обёртка над cnats (Core NATS C-клиент). Заменяет
// сетевой слой MTProto. Без Qt — чистый C++17, чтобы либу можно было собирать
// и тестировать отдельным probe-бинарём до врезки в tdesktop.
#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <stdexcept>
#include <string>

namespace parvane {

// Бросается на ошибках соединения/запроса (вкл. таймаут request).
class TransportError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

class Transport {
public:
    Transport();
    ~Transport();

    Transport(const Transport &) = delete;
    Transport &operator=(const Transport &) = delete;

    // Подключиться к NATS (напр. "nats://127.0.0.1:4222"). Бросает TransportError.
    void connect(const std::string &url);
    bool connected() const;
    void close();

    // request/reply: публикует payload, ждёт ответ до timeout_ms, возвращает
    // тело ответа. Бросает TransportError на таймауте/ошибке. Используется для
    // identity.token.{issue,verify}, msg.sync.request, file.* и т.п.
    std::string request(const std::string &subject, const std::string &payload,
                        std::int64_t timeout_ms = 3000);

    // fire-and-forget публикация (msg.chat.send, call.signal, ...).
    void publish(const std::string &subject, const std::string &payload);

    // Как request, но собирает НЕСКОЛЬКО ответов на приватный inbox: публикует
    // запрос с reply=inbox и вызывает onReply на каждый ответ. onReply возвращает
    // true — ждать ещё, false — достаточно (остановиться). Останавливается также
    // по timeout_ms (общий бюджет). Нужен для file.download.request, где cloud-
    // шард шлёт файл N чанками на один reply-инбокс. Бросает TransportError.
    using ReplyHandler = std::function<bool(const std::string &reply)>;
    void requestMany(const std::string &subject, const std::string &payload,
                     const ReplyHandler &onReply, std::int64_t timeout_ms = 5000);

    // Асинхронная подписка. Хэндлер вызывается на потоке доставки cnats с
    // (subject, payload). Подписка живёт, пока жив Transport.
    using Handler = std::function<void(std::string subject, std::string payload)>;
    void subscribe(const std::string &subject, Handler handler);

private:
    struct Impl;
    std::unique_ptr<Impl> d_;
};

} // namespace parvane
