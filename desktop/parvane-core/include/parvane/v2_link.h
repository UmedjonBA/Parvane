// Parvane fork: соединение протокола v2 с gateway (spec 007, T062). Отдельное
// от v1 соединение: gateway узнаёт v2 по первому кадру — двоичный WebSocket-
// кадр (ws:// / wss://, через GatewayWsTransport в двоичном режиме) или
// преамбула `PVN2` + кадры с varint-длиной (TCP host:port, dev/e2e).
//
// Кадры собирает и разбирает движок (v2_engine.h); здесь — ввод-вывод и
// корреляция: Hello/Welcome, Auth/AuthOk, Request/Response по id, события
// подписок. Обработчики событий зовутся на потоке чтения — в них нельзя
// ждать ответов этого же соединения (ставить работу в очередь).
#pragma once

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

namespace parvane::v2 {

// Ошибка метода/соединения: код протокола (ERROR_CODE_*) и пауза до повтора.
class V2Error : public std::runtime_error {
public:
    V2Error(std::string code, std::uint32_t retryAfterMs = 0)
    : std::runtime_error("v2: " + code), code_(std::move(code)), retryAfterMs_(retryAfterMs) {}
    [[nodiscard]] const std::string &code() const { return code_; }
    [[nodiscard]] std::uint32_t retryAfterMs() const { return retryAfterMs_; }

private:
    std::string code_;
    std::uint32_t retryAfterMs_ = 0;
};

struct Welcome {
    std::string serverDescriptor; // байты SignedServerDescriptor
    std::vector<std::string> features;
};

struct AuthOk {
    std::string user;
    std::string deviceId;
};

struct Event {
    std::uint64_t subscription = 0;
    std::string kind; // "inbox.record", "session.revoked", …
    std::uint64_t seq = 0;
    std::string body;
};

// Канал ввода-вывода кадров (WS или TCP).
class FrameIo {
public:
    virtual ~FrameIo() = default;
    using FrameHandler = std::function<void(std::string frame)>;
    using ClosedHandler = std::function<void()>;
    virtual void open(FrameHandler onFrame, ClosedHandler onClosed) = 0; // бросает V2Error
    virtual void send(const std::string &frame) = 0;                      // бросает V2Error
    virtual void close() = 0;
};

// url: ws://…, wss://… (WebSocket) или host:port / tcp://host:port (TCP PVN2).
[[nodiscard]] std::unique_ptr<FrameIo> makeFrameIo(const std::string &url);

class Connection {
public:
    explicit Connection(std::string url);
    ~Connection();
    Connection(const Connection &) = delete;
    Connection &operator=(const Connection &) = delete;

    // Открыть соединение и пройти Hello/Welcome. Бросает V2Error.
    Welcome open(int channel, const std::string &clientVersion, std::int64_t timeoutMs = 10000);
    // Auth JWT (claim dev обязателен). Бросает V2Error.
    AuthOk auth(const std::string &token, std::int64_t timeoutMs = 10000);
    // Метод реестра: тело запроса → тело ответа. Бросает V2Error.
    std::string request(const std::string &method, const std::string &body,
                        std::int64_t timeoutMs = 15000);

    void setEventHandler(std::function<void(const Event &)> h);
    void setClosedHandler(std::function<void()> h);
    [[nodiscard]] bool isOpen() const { return open_; }
    void close();

private:
    struct Pending {
        bool done = false;
        std::string body;
        std::string error;
        std::uint32_t retryAfterMs = 0;
    };
    void onFrame(const std::string &bytes);
    void onClosed();
    // Дождаться кадра вида kind (или ошибки с id=0).
    std::string waitFor(const std::string &kind, std::int64_t timeoutMs, std::string *out);

    void sendFrame(const std::string &frame); // под ioMu_, бросает V2Error

    std::string url_;
    std::mutex ioMu_;
    std::shared_ptr<FrameIo> io_;
    std::atomic<bool> open_{false};
    std::atomic<bool> closing_{false}; // явный close(): обрыв наверх не сообщаем
    std::atomic<std::uint64_t> nextId_{1};

    std::mutex mu_;
    std::condition_variable cv_;
    std::map<std::uint64_t, Pending> pending_;
    // Ожидание служебного кадра (welcome/authOk).
    std::string waitKind_;
    bool waitDone_ = false;
    std::string waitFrame_; // JSON разобранного кадра
    std::string waitError_;

    std::mutex handlerMu_;
    std::function<void(const Event &)> onEvent_;
    std::function<void()> onClosedCb_;
};

} // namespace parvane::v2
