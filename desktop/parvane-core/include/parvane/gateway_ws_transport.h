// Parvane fork: транспорт к gateway по WebSocket (ws:// и wss://). Прод
// публикует только HTTPS (Caddy → /ws → gateway:9222), TCP-порт 9223 наружу
// не смотрит — нативному клиенту нужен тот же путь, что и веб-клиенту.
// Кадры и корреляция — как у GatewayTransport (JSON-объект = один текстовый
// WebSocket-фрейм), поверх — TLS (OpenSSL, проверка сертификата по системным
// CA и имени хоста) и WebSocket-фрейминг (RFC 6455: маскирование клиентских
// кадров, ping/pong, close). Без внешних WebSocket-библиотек.
#pragma once

#include "parvane/gateway_transport.h"

#include <functional>
#include <memory>
#include <string>

typedef struct ssl_ctx_st SSL_CTX;
typedef struct ssl_st SSL;

namespace parvane {

class GatewayWsTransport : public GatewayTransport {
public:
    GatewayWsTransport();
    ~GatewayWsTransport() override;

    // URL вида wss://host[:port][/path] или ws://host[:port][/path];
    // порт по умолчанию 443/80, путь — "/ws". Бросает GatewayError.
    void connectUrl(const std::string &url);
    // Совместимость с базовым API: host:port → wss://host:port/ws.
    void connect(const std::string &host, int port) override;
    void close() override;

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

    // Протокол v2 (spec 007): двоичный режим. Соединение v2 gateway узнаёт по
    // первому двоичному кадру (Hello); такое соединение живёт отдельно от v1.
    // С обработчиком входящие ДВОИЧНЫЕ сообщения уходят в него (на потоке
    // reader), текстовые по-прежнему разбираются как JSON-кадры v1. Задавать
    // до connectUrl. Содержимое кадров транспорт не разбирает.
    using BinaryHandler = std::function<void(std::string frame)>;
    using ClosedHandler = std::function<void()>;
    void setBinaryHandler(BinaryHandler handler) { binaryHandler_ = std::move(handler); }
    // Зовётся на потоке reader, когда соединение закрылось (сервер/сеть).
    void setClosedHandler(ClosedHandler handler) { closedHandler_ = std::move(handler); }
    // Отправить одно двоичное WebSocket-сообщение. Бросает GatewayError.
    void sendBinary(const std::string &frame);

protected:
    void readerLoop() override;
    void sendLine(const std::string &frame) override;
    void reopen() override { connectUrl(lastUrl_); }

private:
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
    std::mutex sslMu_;
    SSL_CTX *ctx_ = nullptr;
    SSL *ssl_ = nullptr;
    bool tls_ = false;
    std::string lastUrl_; // для reopen()
    BinaryHandler binaryHandler_;
    ClosedHandler closedHandler_;
};

} // namespace parvane
