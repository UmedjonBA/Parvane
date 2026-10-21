// Parvane fork: WebSocket/TLS-транспорт к gateway (см. .h).
#include "parvane/gateway_ws_transport.h"

#include <nlohmann/json.hpp>
#include <openssl/err.h>
#include <openssl/rand.h>
#include <openssl/ssl.h>

#include <arpa/inet.h>
#include <cerrno>
#include <cstring>
#include <dirent.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <sys/socket.h>
#include <unistd.h>

#include <chrono>
#include <cstdlib>
#include <random>

namespace parvane {

namespace {

std::string base64(const unsigned char *data, size_t len) {
    static const char *tbl = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    size_t i = 0;
    while (i + 2 < len) {
        const unsigned v = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
        out += tbl[(v >> 18) & 63]; out += tbl[(v >> 12) & 63];
        out += tbl[(v >> 6) & 63]; out += tbl[v & 63];
        i += 3;
    }
    if (i + 1 == len) {
        const unsigned v = data[i] << 16;
        out += tbl[(v >> 18) & 63]; out += tbl[(v >> 12) & 63]; out += "==";
    } else if (i + 2 == len) {
        const unsigned v = (data[i] << 16) | (data[i + 1] << 8);
        out += tbl[(v >> 18) & 63]; out += tbl[(v >> 12) & 63]; out += tbl[(v >> 6) & 63]; out += '=';
    }
    return out;
}

// Ожидание сокета в потоке чтения: столько же ждёт и close() после shutdown, пока поток не заметит конец.
constexpr int kPollMs = 200;
// Запись кадра: дольше этого сокет не принимает данные — соединение считаем мёртвым.
constexpr auto kWriteTimeout = std::chrono::seconds(30);

// SSL_read/SSL_write пишут в сокет обычным write() (у socket BIO нет MSG_NOSIGNAL): запись в сокет,
// закрытый собеседником или нашим же close() (shutdown) с другого потока, шлёт процессу SIGPIPE, и
// tdesktop, который его не игнорирует, падает. На время вызова SIGPIPE этого потока блокируется, а
// порождённый вызовом — снимается (как libpq); прочие потоки и обработчики приложения не затрагиваются.
class SigpipeGuard {
public:
    SigpipeGuard() {
        sigemptyset(&pipe_);
        sigaddset(&pipe_, SIGPIPE);
        blocked_ = pthread_sigmask(SIG_BLOCK, &pipe_, &old_) == 0;
        sigset_t pending;
        sigemptyset(&pending);
        wasPending_ = blocked_ && sigpending(&pending) == 0 && sigismember(&pending, SIGPIPE) == 1;
    }
    ~SigpipeGuard() {
        if (!blocked_) return;
        if (!wasPending_) {
            const timespec zero{0, 0};
            while (sigtimedwait(&pipe_, nullptr, &zero) == SIGPIPE) {
            }
        }
        pthread_sigmask(SIG_SETMASK, &old_, nullptr);
    }
    SigpipeGuard(const SigpipeGuard &) = delete;
    SigpipeGuard &operator=(const SigpipeGuard &) = delete;

private:
    sigset_t pipe_{};
    sigset_t old_{};
    bool blocked_ = false;
    bool wasPending_ = false;
};

std::string sslError() {
    char buf[256];
    const auto code = ERR_get_error();
    if (!code) return "TLS error";
    ERR_error_string_n(code, buf, sizeof(buf));
    return buf;
}

} // namespace

GatewayWsTransport::GatewayWsTransport() = default;

GatewayWsTransport::~GatewayWsTransport() { close(); }

GatewayWsTransport::Endpoint GatewayWsTransport::parseUrl(const std::string &url) {
    Endpoint ep;
    std::string rest = url;
    if (rest.rfind("wss://", 0) == 0) {
        ep.tls = true; ep.port = 443; rest = rest.substr(6);
    } else if (rest.rfind("ws://", 0) == 0) {
        ep.tls = false; ep.port = 80; rest = rest.substr(5);
    } else {
        throw GatewayError("gateway ws: URL должен начинаться с ws:// или wss://");
    }
    const auto slash = rest.find('/');
    std::string hostport = (slash == std::string::npos) ? rest : rest.substr(0, slash);
    if (slash != std::string::npos && slash + 1 < rest.size()) {
        ep.path = rest.substr(slash);
    }
    const auto colon = hostport.rfind(':');
    if (colon != std::string::npos && hostport.find(']') == std::string::npos) {
        ep.host = hostport.substr(0, colon);
        ep.port = std::atoi(hostport.c_str() + colon + 1);
    } else {
        ep.host = hostport;
    }
    if (ep.host.empty() || ep.port <= 0) {
        throw GatewayError("gateway ws: некорректный URL " + url);
    }
    return ep;
}

void GatewayWsTransport::connect(const std::string &host, int port) {
    connectUrl("wss://" + host + ":" + std::to_string(port) + "/ws");
}

void GatewayWsTransport::connectUrl(const std::string &url) {
    close();
    const auto ep = parseUrl(url);

    addrinfo hints{};
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    addrinfo *res = nullptr;
    const auto portStr = std::to_string(ep.port);
    if (getaddrinfo(ep.host.c_str(), portStr.c_str(), &hints, &res) != 0 || !res) {
        throw GatewayError("gateway ws: не резолвится " + ep.host);
    }
    int fd = -1;
    for (addrinfo *ai = res; ai; ai = ai->ai_next) {
        fd = ::socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
        if (fd < 0) continue;
        if (::connect(fd, ai->ai_addr, ai->ai_addrlen) == 0) break;
        ::close(fd);
        fd = -1;
    }
    freeaddrinfo(res);
    if (fd < 0) {
        throw GatewayError("gateway ws: не удалось подключиться к " + ep.host + ":" + portStr);
    }
    int one = 1;
    ::setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
    fd_ = fd;
    tls_ = ep.tls;
    try {
        if (tls_) tlsConnect(ep.host);
        handshake(ep);
        if (tls_) {
            // NAT-08: дальше SSL_read потока чтения не блокируется внутри SSL (см. sslMu_)
            const int flags = ::fcntl(fd_, F_GETFL, 0);
            if (flags < 0 || ::fcntl(fd_, F_SETFL, flags | O_NONBLOCK) < 0) {
                throw GatewayError("gateway wss: неблокирующий сокет не включён");
            }
        }
    } catch (...) {
        if (ssl_) { SSL_free(ssl_); ssl_ = nullptr; }
        if (ctx_) { SSL_CTX_free(ctx_); ctx_ = nullptr; }
        ::close(fd_);
        fd_ = -1;
        throw;
    }
    upgradeRequiredConn_ = false;
    running_ = true;
    reader_ = std::thread(&GatewayWsTransport::readerLoop, this);
    lastUrl_ = url;
    closedByUser_ = false;
}

void GatewayWsTransport::tlsConnect(const std::string &host) {
    ctx_ = SSL_CTX_new(TLS_client_method());
    if (!ctx_) throw GatewayError("gateway wss: SSL_CTX_new: " + sslError());
    SSL_CTX_set_min_proto_version(ctx_, TLS1_2_VERSION);
    SSL_CTX_set_default_verify_paths(ctx_);
    // Android: у статического OpenSSL нет пути к системным CA (пусто), а
    // сертификаты лежат в /apex/com.android.conscrypt/cacerts (14+) или
    // /system/etc/security/cacerts — имена файлов по СТАРОМУ хэшу, поэтому не
    // hash-dir, а каждый файл в стор. JNI задаёт PARVANE_CA_DIRS (через ':').
    // Без этого на телефоне «TLS handshake» → «сервер недоступен» (10 сен 2026).
    if (const char *dirs = std::getenv("PARVANE_CA_DIRS"); dirs && *dirs) {
        X509_STORE *store = SSL_CTX_get_cert_store(ctx_);
        std::string all = dirs;
        size_t start = 0;
        while (start <= all.size()) {
            const auto colon = all.find(':', start);
            const auto dir = all.substr(start, colon == std::string::npos ? std::string::npos : colon - start);
            if (!dir.empty()) {
                if (DIR *d = opendir(dir.c_str())) {
                    while (dirent *e = readdir(d)) {
                        if (e->d_name[0] == '.') continue;
                        const auto path = dir + "/" + e->d_name;
                        X509_STORE_load_locations(store, path.c_str(), nullptr); // сбой одного файла не важен
                    }
                    closedir(d);
                }
            }
            if (colon == std::string::npos) break;
            start = colon + 1;
        }
        ERR_clear_error();
    }
    // Проверка сертификата: системные CA + имя хоста. PARVANE_WSS_INSECURE=1 —
    // только для dev-стенда с самоподписанным сертификатом и ТОЛЬКО в сборке с
    // -DPARVANE_DEV=ON (P-45): в релизе переменная окружения проверку не отключит.
#ifdef PARVANE_DEV
    const char *insecure = std::getenv("PARVANE_WSS_INSECURE");
    const bool verify = !(insecure && *insecure && std::strcmp(insecure, "0") != 0);
#else
    const bool verify = true;
#endif
    SSL_CTX_set_verify(ctx_, verify ? SSL_VERIFY_PEER : SSL_VERIFY_NONE, nullptr);
    // Неблокирующий сокет: повтор SSL_write после WANT_* — с тем же хвостом буфера, частичная запись
    // продвигает смещение (writeRaw).
    SSL_CTX_set_mode(ctx_, SSL_MODE_ENABLE_PARTIAL_WRITE | SSL_MODE_ACCEPT_MOVING_WRITE_BUFFER);
    ssl_ = SSL_new(ctx_);
    if (!ssl_) throw GatewayError("gateway wss: SSL_new: " + sslError());
    SSL_set_tlsext_host_name(ssl_, host.c_str());
    if (verify) SSL_set1_host(ssl_, host.c_str());
    SSL_set_fd(ssl_, fd_);
    int connected = 0;
    {
        const SigpipeGuard noSigpipe;
        connected = SSL_connect(ssl_);
    }
    if (connected != 1) {
        throw GatewayError("gateway wss: TLS handshake с " + host + ": " + sslError());
    }
}

bool GatewayWsTransport::waitFd(short events, int timeoutMs) const {
    pollfd p{};
    p.fd = fd_;
    p.events = events;
    return ::poll(&p, 1, timeoutMs) > 0;
}

int GatewayWsTransport::readRaw(char *buf, int len) {
    if (!tls_) {
        // Голый сокет: recv и send разных потоков ядро разводит само.
        const auto n = ::recv(fd_, buf, static_cast<size_t>(len), 0);
        if (n > 0) return static_cast<int>(n);
        if (n < 0 && errno == EINTR) return 0;
        return -1;
    }
    int n = 0;
    int err = SSL_ERROR_NONE;
    {
        std::lock_guard<std::mutex> lk(sslMu_);
        if (!ssl_) return -1;
        const SigpipeGuard noSigpipe; // чтение тоже пишет (alert, ответ на KeyUpdate)
        ERR_clear_error();
        n = SSL_read(ssl_, buf, len);
        if (n <= 0) err = SSL_get_error(ssl_, n);
    }
    if (n > 0) return n;
    if (err == SSL_ERROR_WANT_READ) {
        (void)waitFd(POLLIN, kPollMs);
        return 0;
    }
    if (err == SSL_ERROR_WANT_WRITE) {
        (void)waitFd(POLLOUT, kPollMs);
        return 0;
    }
    return -1;
}

bool GatewayWsTransport::writeRaw(const std::string &data) {
    const auto deadline = std::chrono::steady_clock::now() + kWriteTimeout;
    size_t off = 0;
    while (off < data.size()) {
        if (!tls_) {
            const auto n = ::send(fd_, data.data() + off, data.size() - off, MSG_NOSIGNAL);
            if (n < 0 && errno == EINTR) continue;
            if (n <= 0) return false;
            off += static_cast<size_t>(n);
            continue;
        }
        int n = 0;
        int err = SSL_ERROR_NONE;
        {
            std::lock_guard<std::mutex> lk(sslMu_);
            if (!ssl_) return false;
            const SigpipeGuard noSigpipe;
            ERR_clear_error();
            n = SSL_write(ssl_, data.data() + off, static_cast<int>(data.size() - off));
            if (n <= 0) err = SSL_get_error(ssl_, n);
        }
        if (n > 0) {
            off += static_cast<size_t>(n);
            continue;
        }
        if ((err != SSL_ERROR_WANT_WRITE && err != SSL_ERROR_WANT_READ)
            || std::chrono::steady_clock::now() >= deadline) {
            return false;
        }
        // Замок отпущен: поток чтения тем временем разбирает входящее (в т.ч. то, чего ждёт WANT_READ)
        (void)waitFd(err == SSL_ERROR_WANT_WRITE ? POLLOUT : POLLIN, 100);
    }
    return true;
}

void GatewayWsTransport::handshake(const Endpoint &ep) {
    unsigned char nonce[16];
    if (RAND_bytes(nonce, sizeof(nonce)) != 1) {
        std::random_device rd;
        for (auto &b : nonce) b = static_cast<unsigned char>(rd());
    }
    const auto key = base64(nonce, sizeof(nonce));
    std::string req = "GET " + ep.path + " HTTP/1.1\r\n"
        "Host: " + ep.host + ((ep.tls && ep.port != 443) || (!ep.tls && ep.port != 80)
            ? ":" + std::to_string(ep.port) : "") + "\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Key: " + key + "\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "User-Agent: parvane-desktop\r\n\r\n";
    {
        std::lock_guard<std::mutex> lk(writeMu_);
        if (!writeRaw(req)) throw GatewayError("gateway ws: не удалось отправить handshake");
    }
    std::string acc;
    char buf[4096];
    while (acc.find("\r\n\r\n") == std::string::npos) {
        // Сокет здесь ещё блокирующий: 0 (повтор) — только прерванный вызов
        const int n = readRaw(buf, sizeof(buf));
        if (n == 0) continue;
        if (n < 0) throw GatewayError("gateway ws: обрыв на handshake");
        acc.append(buf, static_cast<size_t>(n));
        if (acc.size() > 65536) throw GatewayError("gateway ws: слишком длинный ответ handshake");
    }
    const auto headerEnd = acc.find("\r\n\r\n");
    const auto statusLine = acc.substr(0, acc.find("\r\n"));
    if (statusLine.find(" 101") == std::string::npos) {
        throw GatewayError("gateway ws: сервер отверг апгрейд: " + statusLine);
    }
    // Хвост после заголовков — уже WebSocket-данные; reader начнёт с пустого
    // буфера, поэтому остаток (редкий случай) кладём обратно через pending
    // буфер: для простоты требуем, чтобы сервер не слал кадры до auth — gateway
    // так и делает (первый кадр — ответ на наш auth/req).
    (void)headerEnd;
}

void GatewayWsTransport::sendFrame(unsigned char opcode, const std::string &payload) {
    std::string frame;
    frame.push_back(static_cast<char>(0x80 | (opcode & 0x0f)));
    const auto len = payload.size();
    if (len < 126) {
        frame.push_back(static_cast<char>(0x80 | len));
    } else if (len <= 0xffff) {
        frame.push_back(static_cast<char>(0x80 | 126));
        frame.push_back(static_cast<char>((len >> 8) & 0xff));
        frame.push_back(static_cast<char>(len & 0xff));
    } else {
        frame.push_back(static_cast<char>(0x80 | 127));
        for (int i = 7; i >= 0; --i) frame.push_back(static_cast<char>((len >> (8 * i)) & 0xff));
    }
    unsigned char mask[4];
    if (RAND_bytes(mask, 4) != 1) {
        std::random_device rd;
        for (auto &b : mask) b = static_cast<unsigned char>(rd());
    }
    frame.append(reinterpret_cast<const char *>(mask), 4);
    const auto start = frame.size();
    frame.resize(start + len);
    for (size_t i = 0; i < len; ++i) {
        frame[start + i] = static_cast<char>(static_cast<unsigned char>(payload[i]) ^ mask[i % 4]);
    }
    if (!writeRaw(frame)) {
        running_ = false; // мёртвое соединение → ensureConnected() переподключит
        throw GatewayError("gateway ws: не подключено (ошибка отправки)");
    }
}

void GatewayWsTransport::sendLine(const std::string &frame) {
    std::lock_guard<std::mutex> lk(writeMu_);
    if (fd_ < 0 || !running_) throw GatewayError("gateway ws: не подключено");
    sendFrame(0x1, frame);
}

void GatewayWsTransport::sendBinary(const std::string &frame) {
    std::lock_guard<std::mutex> lk(writeMu_);
    if (fd_ < 0 || !running_) throw GatewayError("gateway ws: не подключено");
    sendFrame(0x2, frame);
}

void GatewayWsTransport::readerLoop() {
    std::string acc;
    std::string message; // сборка фрагментированного сообщения
    unsigned messageOpcode = 0; // опкод первого фрагмента (1 — текст, 2 — двоичное)
    char buf[16384];
    while (running_) {
        const int n = readRaw(buf, sizeof(buf));
        if (n < 0) break;
        if (n == 0) continue; // данных пока нет — проверить running_ и ждать дальше
        acc.append(buf, static_cast<size_t>(n));
        for (;;) {
            if (acc.size() < 2) break;
            const auto b0 = static_cast<unsigned char>(acc[0]);
            const auto b1 = static_cast<unsigned char>(acc[1]);
            const bool fin = b0 & 0x80;
            const auto opcode = b0 & 0x0f;
            const bool masked = b1 & 0x80;
            std::uint64_t len = b1 & 0x7f;
            size_t pos = 2;
            if (len == 126) {
                if (acc.size() < 4) break;
                len = (static_cast<unsigned char>(acc[2]) << 8) | static_cast<unsigned char>(acc[3]);
                pos = 4;
            } else if (len == 127) {
                if (acc.size() < 10) break;
                len = 0;
                for (int i = 0; i < 8; ++i) len = (len << 8) | static_cast<unsigned char>(acc[2 + i]);
                pos = 10;
            }
            if (len > (64u << 20)) { running_ = false; break; } // защита от OOM
            unsigned char mask[4] = {0, 0, 0, 0};
            if (masked) {
                if (acc.size() < pos + 4) break;
                std::memcpy(mask, acc.data() + pos, 4);
                pos += 4;
            }
            if (acc.size() < pos + len) break;
            std::string payload = acc.substr(pos, static_cast<size_t>(len));
            if (masked) {
                for (size_t i = 0; i < payload.size(); ++i) {
                    payload[i] = static_cast<char>(static_cast<unsigned char>(payload[i]) ^ mask[i % 4]);
                }
            }
            acc.erase(0, pos + static_cast<size_t>(len));
            if (opcode == 0x8) { // close
                running_ = false;
                break;
            }
            if (opcode == 0x9) { // ping → pong
                std::lock_guard<std::mutex> lk(writeMu_);
                if (fd_ >= 0) { try { sendFrame(0xA, payload); } catch (...) {} }
                continue;
            }
            if (opcode == 0xA) continue; // pong
            if (opcode == 0x1 || opcode == 0x2 || opcode == 0x0) {
                if (opcode != 0x0) messageOpcode = opcode;
                message += payload;
                if (fin) {
                    // NAT-14: исключение обработчика (кадр сервера с полем не того типа, сбой выше по
                    // стеку) не уходит из потока чтения — иначе std::terminate роняет клиент.
                    try {
                        if (messageOpcode == 0x2 && binaryHandler_) {
                            binaryHandler_(std::move(message));
                        } else {
                            dispatch(message);
                        }
                    } catch (...) {
                    }
                    message.clear();
                }
            }
        }
    }
    running_ = false;
    abortPending("соединение с gateway потеряно"); // ждущие request не висят до таймаута
    if (closedHandler_) {
        try {
            closedHandler_();
        } catch (...) {
        }
    }
}

void GatewayWsTransport::close() {
    closedByUser_ = true;
    if (fd_ < 0) return;
    running_ = false;
    ::shutdown(fd_, SHUT_RDWR);
    if (reader_.joinable()) reader_.join();
    {
        // NAT-07: пишущий поток может стоять в writeRaw — освобождаем SSL и сокет только после него
        // (после shutdown его запись завершается ошибкой сразу).
        std::lock_guard<std::mutex> wl(writeMu_);
        std::lock_guard<std::mutex> sl(sslMu_);
        if (ssl_) { SSL_free(ssl_); ssl_ = nullptr; }
        if (ctx_) { SSL_CTX_free(ctx_); ctx_ = nullptr; }
        ::close(fd_);
        fd_ = -1;
    }
    abortPending("соединение с gateway закрыто");
}

} // namespace parvane
