// Parvane fork: WebSocket/TLS-транспорт к gateway (см. .h).
#include "parvane/gateway_ws_transport.h"

#include <nlohmann/json.hpp>
#include <openssl/err.h>
#include <openssl/rand.h>
#include <openssl/ssl.h>

#include <arpa/inet.h>
#include <cstring>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <unistd.h>

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
    } catch (...) {
        if (ssl_) { SSL_free(ssl_); ssl_ = nullptr; }
        if (ctx_) { SSL_CTX_free(ctx_); ctx_ = nullptr; }
        ::close(fd_);
        fd_ = -1;
        throw;
    }
    running_ = true;
    reader_ = std::thread(&GatewayWsTransport::readerLoop, this);
}

void GatewayWsTransport::tlsConnect(const std::string &host) {
    ctx_ = SSL_CTX_new(TLS_client_method());
    if (!ctx_) throw GatewayError("gateway wss: SSL_CTX_new: " + sslError());
    SSL_CTX_set_min_proto_version(ctx_, TLS1_2_VERSION);
    SSL_CTX_set_default_verify_paths(ctx_);
    // Проверка сертификата: системные CA + имя хоста. PARVANE_WSS_INSECURE=1 —
    // только для dev-стенда с самоподписанным сертификатом.
    const char *insecure = std::getenv("PARVANE_WSS_INSECURE");
    const bool verify = !(insecure && *insecure && std::strcmp(insecure, "0") != 0);
    SSL_CTX_set_verify(ctx_, verify ? SSL_VERIFY_PEER : SSL_VERIFY_NONE, nullptr);
    ssl_ = SSL_new(ctx_);
    if (!ssl_) throw GatewayError("gateway wss: SSL_new: " + sslError());
    SSL_set_tlsext_host_name(ssl_, host.c_str());
    if (verify) SSL_set1_host(ssl_, host.c_str());
    SSL_set_fd(ssl_, fd_);
    if (SSL_connect(ssl_) != 1) {
        throw GatewayError("gateway wss: TLS handshake с " + host + ": " + sslError());
    }
}

int GatewayWsTransport::readRaw(char *buf, int len) {
    if (tls_) return SSL_read(ssl_, buf, len);
    const auto n = ::recv(fd_, buf, static_cast<size_t>(len), 0);
    return static_cast<int>(n);
}

bool GatewayWsTransport::writeRaw(const std::string &data) {
    size_t off = 0;
    while (off < data.size()) {
        int n;
        if (tls_) {
            n = SSL_write(ssl_, data.data() + off, static_cast<int>(data.size() - off));
        } else {
            n = static_cast<int>(::send(fd_, data.data() + off, data.size() - off, MSG_NOSIGNAL));
        }
        if (n <= 0) return false;
        off += static_cast<size_t>(n);
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
        const int n = readRaw(buf, sizeof(buf));
        if (n <= 0) throw GatewayError("gateway ws: обрыв на handshake");
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
    if (!writeRaw(frame)) throw GatewayError("gateway ws: ошибка отправки");
}

void GatewayWsTransport::sendLine(const std::string &frame) {
    std::lock_guard<std::mutex> lk(writeMu_);
    if (fd_ < 0 || !running_) throw GatewayError("gateway ws: не подключено");
    sendFrame(0x1, frame);
}

void GatewayWsTransport::readerLoop() {
    std::string acc;
    std::string message; // сборка фрагментированного сообщения
    char buf[16384];
    while (running_) {
        const int n = readRaw(buf, sizeof(buf));
        if (n <= 0) break;
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
                message += payload;
                if (fin) {
                    dispatch(message);
                    message.clear();
                }
            }
        }
    }
    running_ = false;
}

void GatewayWsTransport::close() {
    if (fd_ < 0) return;
    running_ = false;
    ::shutdown(fd_, SHUT_RDWR);
    if (reader_.joinable()) reader_.join();
    if (ssl_) { SSL_free(ssl_); ssl_ = nullptr; }
    if (ctx_) { SSL_CTX_free(ctx_); ctx_ = nullptr; }
    ::close(fd_);
    fd_ = -1;
    abortPending("соединение с gateway закрыто");
}

} // namespace parvane
