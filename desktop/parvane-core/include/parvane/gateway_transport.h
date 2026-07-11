// Parvane fork: клиентский транспорт ЧЕРЕЗ gateway (Фаза 0). Вместо прямого
// подключения к NATS клиент говорит с gateway по простому TCP-протоколу
// (JSON-кадры, разделитель `\n`). Так изоляция «людей» держится на gateway
// (проверка JWT), а не на общем NATS-логине. Без внешних зависимостей —
// POSIX-сокет + nlohmann/json, чтобы не тащить WebSocket-либу в сборку tdesktop.
//
// Протокол кадров (клиент→gateway):
//   {"op":"auth","token":"<JWT>"}
//   {"op":"pub","subject":..,"payload":"<json-строка>"}
//   {"op":"req","id":"<corr>","subject":..,"payload":..,"timeout_ms":..}
//   {"op":"reqmany",...}   (много ответов до reply_end)
//   {"op":"sub","subject":".."}
// gateway→клиент:
//   {"op":"auth_ok","user":..} | {"op":"auth_err","error":..}
//   {"op":"reply","id":..,"payload":..} | {"op":"reply_end","id":..}
//   {"op":"msg","subject":..,"payload":..}
//   {"op":"err","id"?:..,"error":..}
#pragma once

#include "parvane/itransport.h"

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <map>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace parvane {

class GatewayError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

// Транспорт через gateway (реализует ITransport). Плюс явный шаг authenticate().
class GatewayTransport : public ITransport {
public:
    GatewayTransport();
    ~GatewayTransport() override;

    GatewayTransport(const GatewayTransport &) = delete;
    GatewayTransport &operator=(const GatewayTransport &) = delete;

    // Подключиться к gateway по TCP (host — IP или имя, напр. "127.0.0.1").
    // Бросает GatewayError.
    void connect(const std::string &host, int port);
    bool connected() const;
    void close();

    // Авторизоваться JWT. Вызывать после connect, до защищённых операций.
    // До auth разрешены только request к identity.token.issue / .user.register
    // (bootstrap — логин/регистрация). Бросает GatewayError при отказе.
    void authenticate(const std::string &token, std::int64_t timeoutMs = 5000);

    // request/reply (один ответ). Бросает GatewayError на таймауте/ошибке.
    std::string request(const std::string &subject, const std::string &payload,
                        std::int64_t timeoutMs = 3000) override;

    // fire-and-forget.
    void publish(const std::string &subject, const std::string &payload) override;

    // Много ответов на один запрос (chunked download): onReply на каждый ответ,
    // возвращает true — ждать ещё, false — стоп. Останавливается также по
    // reply_end от gateway и по общему timeout. Бросает GatewayError.
    void requestMany(const std::string &subject, const std::string &payload,
                     const ReplyHandler &onReply, std::int64_t timeoutMs = 5000) override;

    // Асинхронная подписка. handler(subject, payload) зовётся на потоке reader.
    void subscribe(const std::string &subject, Handler handler) override;

private:
    // Состояние одного pending-запроса (single или many).
    struct Pending {
        std::mutex m;
        std::condition_variable cv;
        std::deque<std::string> replies; // payload'ы ответов
        bool ended = false;              // reply_end получен
        bool error = false;
        std::string errmsg;
    };

    void readerLoop();
    void dispatch(const std::string &line);
    void sendLine(const std::string &frame); // под writeMu_
    std::string nextId();

    int fd_ = -1;
    std::atomic<bool> running_{false};
    std::thread reader_;

    std::mutex writeMu_;

    // корреляция ответов по id
    std::mutex pendMu_;
    std::map<std::string, std::shared_ptr<Pending>> pending_;
    std::atomic<std::uint64_t> idSeq_{0};

    // подписки: subject → обработчики
    std::mutex subMu_;
    std::map<std::string, std::vector<Handler>> subs_;

    // результат auth
    std::mutex authMu_;
    std::condition_variable authCv_;
    int authState_ = 0; // 0 ждём, 1 ok, -1 err
    std::string authUser_;
    std::string authErr_;
};

} // namespace parvane
