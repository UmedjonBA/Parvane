// Parvane fork: транспорт к gateway по WebSocket (ws:// и wss://). Прод
// публикует только HTTPS (Caddy → /ws → gateway:9222), TCP-порт 9223 наружу
// не смотрит — нативному клиенту нужен тот же путь, что и веб-клиенту.
// Транспорт двоичный (протокол v2): кадры уходят сообщениями WebSocket, входящие
// двоичные отдаются обработчику; поверх — TLS (OpenSSL, проверка сертификата по
// системным CA и имени хоста) и WebSocket-фрейминг (RFC 6455: маскирование
// клиентских кадров, ping/pong, close). Без внешних WebSocket-библиотек.
#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>

typedef struct ssl_ctx_st SSL_CTX;
typedef struct ssl_st SSL;

namespace parvane {

class GatewayError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

class GatewayWsTransport {
public:
    GatewayWsTransport();
    ~GatewayWsTransport();

    GatewayWsTransport(const GatewayWsTransport &) = delete;
    GatewayWsTransport &operator=(const GatewayWsTransport &) = delete;

    // URL вида wss://host[:port][/path] или ws://host[:port][/path];
    // порт по умолчанию 443/80, путь — "/ws". Бросает GatewayError.
    void connectUrl(const std::string &url);
    [[nodiscard]] bool connected() const { return fd_ >= 0 && running_; }
    void close();

    // Разбор URL (для фабрики транспорта и тестов).
    struct Endpoint {
        std::string host;
        int port = 443;
        std::string path = "/ws";
        bool tls = true;
    };
    [[nodiscard]] static Endpoint parseUrl(const std::string &url);

    // Доверенные корни из PARVANE_CA_DIRS (каталоги через ':'). Нужны Android — у статического OpenSSL нет
    // системного хранилища, JNI задаёт переменную сам (по умолчанию разрешено). Desktop читает системные CA, и
    // подложенный в окружение корень дал бы посреднику подменить сервер — tdesktop выключает это при старте
    // (ревью 21 окт 2026). На уже открытые соединения не влияет.
    static void setEnvCaDirsAllowed(bool allowed);
    [[nodiscard]] static bool envCaDirsAllowed();

    // Протокол v2 (spec 007): двоичный режим. Входящие ДВОИЧНЫЕ сообщения уходят
    // в обработчик (на потоке reader), текстовые игнорируются. Задавать до
    // connectUrl. Содержимое кадров транспорт не разбирает.
    using BinaryHandler = std::function<void(std::string frame)>;
    using ClosedHandler = std::function<void()>;
    void setBinaryHandler(BinaryHandler handler) { binaryHandler_ = std::move(handler); }
    // Зовётся на потоке reader, когда соединение закрылось (сервер/сеть).
    void setClosedHandler(ClosedHandler handler) { closedHandler_ = std::move(handler); }
    // Отправить одно двоичное WebSocket-сообщение. Бросает GatewayError.
    void sendBinary(const std::string &frame);

private:
    void readerLoop();
    void tlsConnect(const std::string &host);
    void handshake(const Endpoint &ep);
    // Сырые чтение/запись поверх TLS или голого сокета. readRaw: > 0 — байты, 0 — данных пока нет
    // (повторить), < 0 — соединение закрыто или ошибка.
    int readRaw(char *buf, int len);
    bool writeRaw(const std::string &data); // под writeMu_
    void sendFrame(unsigned char opcode, const std::string &payload); // под writeMu_
    // Дождаться готовности сокета (poll, без замков); false — таймаут.
    bool waitFd(short events, int timeoutMs) const;

    // NAT-08: объект SSL не допускает одновременных SSL_read и SSL_write из разных потоков. После
    // рукопожатия сокет TLS неблокирующий, и каждый вызов SSL_* идёт под sslMu_; ожидание данных
    // (poll) — без замка, поэтому поток чтения не держит пишущих. Порядок замков: writeMu_ → sslMu_.
    // Атомарен: connected() и пишущие потоки читают его без замка; закрытие сокета — под writeMu_ (NAT-07).
    std::atomic<int> fd_{-1};
    std::atomic<bool> running_{false};
    std::thread reader_;
    std::mutex writeMu_;
    std::mutex sslMu_;
    SSL_CTX *ctx_ = nullptr;
    SSL *ssl_ = nullptr;
    bool tls_ = false;
    BinaryHandler binaryHandler_;
    ClosedHandler closedHandler_;
};

} // namespace parvane
