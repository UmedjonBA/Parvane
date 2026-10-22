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

#include "parvane/blobcrypt.h"

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

// Ревью 21 окт 2026 (2.2): пределы поточного ответа. `maxBytes` > 0 — потолок байтов чанков (больше —
// ERROR_CODE_LIMIT сразу, принятые чанки освобождаются); `chunkCount` > 0 — принимаются только индексы
// [firstChunk, firstChunk + chunkCount), иной — ERROR_CODE_INVALID; `acceptMeta` — проверка тела ответа
// (метаданных) до первого чанка: false — ERROR_CODE_LIMIT, чанки не принимаются. Зовётся на потоке чтения.
struct StreamLimits {
    std::size_t maxBytes = 0;
    std::uint32_t firstChunk = 0;
    std::uint32_t chunkCount = 0;
    std::function<bool(const std::string &meta)> acceptMeta;
};

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
    // `dest` — домен сервера объекта (spec 028, FED-1; пусто — свой сервер); `padTo` > 0 — кадр
    // дополняется до кратного этой длине (spec 025, режим L2).
    std::string request(const std::string &method, const std::string &body,
                        std::int64_t timeoutMs = 15000, const std::string &dest = std::string(),
                        std::uint32_t padTo = 0);
    // Поточный метод (скачивание блоба): тело ответа (метаданные) + чанки по
    // индексу до кадра last. Возвращается после последнего чанка. Бросает
    // V2Error (в т.ч. ошибка посреди потока).
    struct StreamResult {
        std::string body;
        std::map<std::uint32_t, std::string> chunks;
    };
    // Пределы поточного ответа — StreamLimits (уровнем пространства имён, выше).
    using StreamLimits = parvane::v2::StreamLimits;
    StreamResult requestStream(const std::string &method, const std::string &body,
                               std::int64_t timeoutMs = 60000, const std::string &dest = std::string(),
                               StreamLimits limits = {});

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
        // Поточный запрос: ответ — не конец, ждём кадр chunk с last.
        bool stream = false;
        bool responded = false;
        std::map<std::uint32_t, std::string> chunks;
        // Потолок поточного ответа (requestStream): принято байтов и предел (0 — без предела)
        StreamLimits limits;
        std::size_t bytes = 0;
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

// ── скачивание блоба целиком (cloud.blob.download / cloud.blob.download_cap) ──
// Ревью 21 окт 2026 (2.2): число чанков и размер называет сервер (а размер — загрузивший), поэтому блоб,
// собираемый в память, всегда с потолком. По умолчанию — файл облака до 2 ГиБ (spec 016) в PVB2.
inline constexpr std::size_t kMaxBlobDownloadBytes = blobcrypt::maxCipherSize(std::size_t(2) << 30);
inline constexpr std::uint32_t kBlobDownloadBatch = 256;
// Предел числа чанков файла у сервера (шард cloud, PARVANE_CLOUD_MAX_TOTAL_CHUNKS): больше — подделка.
inline constexpr std::uint32_t kMaxBlobChunks = 100000;
// Один запрос пачки чанков: пределы (окно [first, first + count), остаток потолка, проверка метаданных)
// передаются в Connection::requestStream как есть.
using BlobBatchFetch = std::function<Connection::StreamResult(const Connection::StreamLimits &limits)>;
// Склеить блоб пачками по kBlobDownloadBatch чанков. `method` — имя метода реестра (разбор метаданных
// {size, chunks}). Отказ ERROR_CODE_LIMIT, как только заявленный размер или принятые байты превышают `maxBytes`
// (0 — kMaxBlobDownloadBytes) либо чанков больше kMaxBlobChunks: до приёма чанков, без роста памяти. Нет чанка —
// ERROR_CODE_UNAVAILABLE; число чанков сменилось между пачками — ERROR_CODE_INVALID. Бросает V2Error.
[[nodiscard]] std::string downloadBlobChunks(const std::string &method, std::size_t maxBytes,
                                             const BlobBatchFetch &fetch);

} // namespace parvane::v2
