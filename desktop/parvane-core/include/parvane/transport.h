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

    // Асинхронная подписка. Хэндлер вызывается на потоке доставки cnats с
    // (subject, payload). Подписка живёт, пока жив Transport.
    using Handler = std::function<void(std::string subject, std::string payload)>;
    void subscribe(const std::string &subject, Handler handler);

private:
    struct Impl;
    std::unique_ptr<Impl> d_;
};

} // namespace parvane
