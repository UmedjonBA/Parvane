// Parvane fork: потоки транспорта gateway (ревью безопасности 7 окт 2026, NAT-07/08/14).
// Локальный сервер TLS + WebSocket (самоподписанный сертификат на localhost, доверие — через
// PARVANE_CA_DIRS) и сервер TCP PVN2; ни gateway, ни стека не нужно.
//   NAT-08 — SSL_read потока чтения и SSL_write пишущих потоков не идут одновременно на одном SSL;
//   NAT-07 — close() с другого потока не освобождает SSL/сокет/транспорт, пока запись ещё идёт;
//   NAT-14 — исключение в обработчике кадра (или кадр сервера с полем не того типа) не роняет поток
//            чтения: следующий кадр доходит.
// SIGPIPE процесс не игнорирует (как tdesktop): запись в закрытый сокет из транспорта уронила бы тест.
// SSL_read/SSL_write/SSL_free перехвачены здесь же (определения в исполняемом файле перекрывают
// libssl для статически вложенного ядра; настоящие — через dlsym(RTLD_NEXT)): так одновременность
// вызовов на одном SSL видна без санитайзера.
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dlfcn.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <arpa/inet.h>
#include <csignal>
#include <netinet/in.h>
#include <pthread.h>
#include <sys/socket.h>
#include <unistd.h>

#include <openssl/ec.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/pem.h>
#include <openssl/ssl.h>
#include <openssl/x509v3.h>

#include "parvane/gateway_ws_transport.h"
#include "parvane/v2_link.h"

using namespace std::chrono_literals;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name, const std::string &info = "") {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s%s\n", ok ? "ok  " : "FAIL", name.c_str(), info.empty() ? "" : (" — " + info).c_str());
    std::fflush(stdout);
}

// ── перехват SSL_* ───────────────────────────────────────────────────────────
namespace {

std::mutex g_trackMu;
std::map<const SSL *, std::map<std::thread::id, int>> g_inFlight; // SSL → поток → глубина
std::atomic<int> g_overlaps{0};     // вызов на SSL, пока на нём же идёт вызов другого потока
std::atomic<int> g_freeInUse{0};    // SSL_free, пока на этом SSL идёт вызов другого потока

struct Track {
    const SSL *ssl;
    explicit Track(const SSL *s) : ssl(s) {
        std::lock_guard<std::mutex> lk(g_trackMu);
        auto &threads = g_inFlight[ssl];
        for (const auto &[tid, depth] : threads) {
            if (tid != std::this_thread::get_id() && depth > 0) {
                ++g_overlaps;
                break;
            }
        }
        ++threads[std::this_thread::get_id()];
    }
    ~Track() {
        std::lock_guard<std::mutex> lk(g_trackMu);
        auto &threads = g_inFlight[ssl];
        if (--threads[std::this_thread::get_id()] == 0) threads.erase(std::this_thread::get_id());
    }
};

template <typename F>
F realFn(const char *name) {
    return reinterpret_cast<F>(dlsym(RTLD_NEXT, name));
}

} // namespace

extern "C" int SSL_read(SSL *s, void *buf, int num) {
    static const auto real = realFn<int (*)(SSL *, void *, int)>("SSL_read");
    Track t(s);
    return real(s, buf, num);
}

extern "C" int SSL_write(SSL *s, const void *buf, int num) {
    static const auto real = realFn<int (*)(SSL *, const void *, int)>("SSL_write");
    Track t(s);
    return real(s, buf, num);
}

extern "C" void SSL_free(SSL *s) {
    static const auto real = realFn<void (*)(SSL *)>("SSL_free");
    {
        std::lock_guard<std::mutex> lk(g_trackMu);
        const auto it = g_inFlight.find(s);
        if (it != g_inFlight.end()) {
            for (const auto &[tid, depth] : it->second) {
                if (tid != std::this_thread::get_id() && depth > 0) {
                    ++g_freeInUse;
                    break;
                }
            }
            g_inFlight.erase(it);
        }
    }
    real(s);
}

// ── самоподписанный сертификат localhost ─────────────────────────────────────
namespace {

struct Cert {
    EVP_PKEY *key = nullptr;
    X509 *x509 = nullptr;
};

Cert makeCert() {
    Cert c;
    c.key = EVP_EC_gen("P-256");
    c.x509 = X509_new();
    X509_set_version(c.x509, 2);
    ASN1_INTEGER_set(X509_get_serialNumber(c.x509), 7);
    X509_gmtime_adj(X509_getm_notBefore(c.x509), -60);
    X509_gmtime_adj(X509_getm_notAfter(c.x509), 3600);
    X509_set_pubkey(c.x509, c.key);
    X509_NAME *name = X509_get_subject_name(c.x509);
    X509_NAME_add_entry_by_txt(name, "CN", MBSTRING_ASC, reinterpret_cast<const unsigned char *>("localhost"), -1, -1, 0);
    X509_set_issuer_name(c.x509, name);
    X509V3_CTX ctx;
    X509V3_set_ctx_nodb(&ctx);
    X509V3_set_ctx(&ctx, c.x509, c.x509, nullptr, nullptr, 0);
    if (X509_EXTENSION *ext = X509V3_EXT_conf_nid(nullptr, &ctx, NID_subject_alt_name, "DNS:localhost")) {
        X509_add_ext(c.x509, ext, -1);
        X509_EXTENSION_free(ext);
    }
    X509_sign(c.x509, c.key, EVP_sha256());
    return c;
}

bool writeAllFd(int fd, const std::string &data) {
    size_t off = 0;
    while (off < data.size()) {
        const auto n = ::send(fd, data.data() + off, data.size() - off, MSG_NOSIGNAL);
        if (n <= 0) return false;
        off += static_cast<size_t>(n);
    }
    return true;
}

// Сервер: TLS + WebSocket на 127.0.0.1, по потоку на соединение (чтение и запись — в одном потоке,
// у сервера одновременности нет). Режимы задаются полями до start().
class WsServer {
public:
    explicit WsServer(const Cert &cert) {
        ctx_ = SSL_CTX_new(TLS_server_method());
        SSL_CTX_use_certificate(ctx_, cert.x509);
        SSL_CTX_use_PrivateKey(ctx_, cert.key);
        listen_ = ::socket(AF_INET, SOCK_STREAM, 0);
        int one = 1;
        ::setsockopt(listen_, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
        sockaddr_in a{};
        a.sin_family = AF_INET;
        a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        ::bind(listen_, reinterpret_cast<sockaddr *>(&a), sizeof(a));
        ::listen(listen_, 16);
        socklen_t len = sizeof(a);
        ::getsockname(listen_, reinterpret_cast<sockaddr *>(&a), &len);
        port_ = ntohs(a.sin_port);
        acceptor_ = std::thread([this] { acceptLoop(); });
    }
    ~WsServer() {
        stopping_ = true;
        ::shutdown(listen_, SHUT_RDWR);
        ::close(listen_);
        acceptor_.join();
        std::vector<std::thread> conns;
        {
            std::lock_guard<std::mutex> lk(mu_);
            for (const int fd : fds_) ::shutdown(fd, SHUT_RDWR);
            conns = std::move(conns_);
        }
        for (auto &t : conns) t.join();
        SSL_CTX_free(ctx_);
    }
    [[nodiscard]] std::string url() const { return "wss://localhost:" + std::to_string(port_) + "/ws"; }

    // Эхо двоичных сообщений клиента обратно.
    std::atomic<bool> echo{true};
    // Сразу после рукопожатия — эти кадры сервера (опкод, тело).
    std::vector<std::pair<unsigned char, std::string>> greet;

private:
    void acceptLoop() {
        while (!stopping_) {
            const int fd = ::accept(listen_, nullptr, nullptr);
            if (fd < 0) return;
            std::lock_guard<std::mutex> lk(mu_);
            fds_.push_back(fd);
            conns_.emplace_back([this, fd] { serve(fd); });
        }
    }

    static std::string frame(unsigned char opcode, const std::string &payload) {
        std::string f;
        f.push_back(static_cast<char>(0x80 | opcode));
        const auto len = payload.size();
        if (len < 126) {
            f.push_back(static_cast<char>(len));
        } else if (len <= 0xffff) {
            f.push_back(static_cast<char>(126));
            f.push_back(static_cast<char>((len >> 8) & 0xff));
            f.push_back(static_cast<char>(len & 0xff));
        } else {
            f.push_back(static_cast<char>(127));
            for (int i = 7; i >= 0; --i) f.push_back(static_cast<char>((len >> (8 * i)) & 0xff));
        }
        return f + payload;
    }

    void serve(int fd) {
        // SIGPIPE от записи сервера в закрытый клиентом сокет — только этому потоку и заблокирован:
        // потоки клиента его видят, и падение от SIGPIPE в транспорте тест ловит
        sigset_t pipe;
        sigemptyset(&pipe);
        sigaddset(&pipe, SIGPIPE);
        pthread_sigmask(SIG_BLOCK, &pipe, nullptr);
        SSL *ssl = SSL_new(ctx_);
        SSL_set_fd(ssl, fd);
        auto write = [&](const std::string &data) {
            size_t off = 0;
            while (off < data.size()) {
                const int n = SSL_write(ssl, data.data() + off, static_cast<int>(data.size() - off));
                if (n <= 0) return false;
                off += static_cast<size_t>(n);
            }
            return true;
        };
        if (SSL_accept(ssl) == 1) {
            std::string acc;
            char buf[16384];
            bool upgraded = false;
            for (;;) {
                const int n = SSL_read(ssl, buf, sizeof(buf));
                if (n <= 0) break;
                acc.append(buf, static_cast<size_t>(n));
                if (!upgraded) {
                    const auto end = acc.find("\r\n\r\n");
                    if (end == std::string::npos) continue;
                    acc.erase(0, end + 4);
                    upgraded = true;
                    if (!write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                               "Connection: Upgrade\r\nSec-WebSocket-Accept: test\r\n\r\n")) break;
                    bool ok = true;
                    for (const auto &[op, body] : greet) ok = ok && write(frame(op, body));
                    if (!ok) break;
                }
                bool broken = false;
                for (;;) { // кадры клиента (маскированные)
                    if (acc.size() < 2) break;
                    const auto op = static_cast<unsigned char>(acc[0]) & 0x0f;
                    std::uint64_t len = static_cast<unsigned char>(acc[1]) & 0x7f;
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
                    if (acc.size() < pos + 4 + len) break;
                    unsigned char mask[4];
                    std::memcpy(mask, acc.data() + pos, 4);
                    std::string payload = acc.substr(pos + 4, static_cast<size_t>(len));
                    for (size_t i = 0; i < payload.size(); ++i) payload[i] = static_cast<char>(payload[i] ^ mask[i % 4]);
                    acc.erase(0, pos + 4 + static_cast<size_t>(len));
                    if (op == 0x2 && echo && !write(frame(0x2, payload))) {
                        broken = true;
                        break;
                    }
                }
                if (broken) break;
            }
        }
        SSL_free(ssl);
        ::close(fd);
    }

    SSL_CTX *ctx_ = nullptr;
    int listen_ = -1;
    int port_ = 0;
    std::atomic<bool> stopping_{false};
    std::thread acceptor_;
    std::mutex mu_;
    std::vector<int> fds_;
    std::vector<std::thread> conns_;
};

// Сервер TCP PVN2: принимает и молча вычитывает всё (для TcpFrameIo).
class TcpSink {
public:
    TcpSink() {
        listen_ = ::socket(AF_INET, SOCK_STREAM, 0);
        int one = 1;
        ::setsockopt(listen_, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
        sockaddr_in a{};
        a.sin_family = AF_INET;
        a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        ::bind(listen_, reinterpret_cast<sockaddr *>(&a), sizeof(a));
        ::listen(listen_, 16);
        socklen_t len = sizeof(a);
        ::getsockname(listen_, reinterpret_cast<sockaddr *>(&a), &len);
        port_ = ntohs(a.sin_port);
        acceptor_ = std::thread([this] {
            for (;;) {
                const int fd = ::accept(listen_, nullptr, nullptr);
                if (fd < 0) return;
                std::lock_guard<std::mutex> lk(mu_);
                fds_.push_back(fd);
                conns_.emplace_back([fd] {
                    char buf[16384];
                    while (::recv(fd, buf, sizeof(buf), 0) > 0) {
                    }
                    ::close(fd);
                });
            }
        });
    }
    ~TcpSink() {
        ::shutdown(listen_, SHUT_RDWR);
        ::close(listen_);
        acceptor_.join();
        std::vector<std::thread> conns;
        {
            std::lock_guard<std::mutex> lk(mu_);
            for (const int fd : fds_) ::shutdown(fd, SHUT_RDWR);
            conns = std::move(conns_);
        }
        for (auto &t : conns) t.join();
    }
    [[nodiscard]] std::string url() const { return "127.0.0.1:" + std::to_string(port_); }

private:
    int listen_ = -1;
    int port_ = 0;
    std::thread acceptor_;
    std::mutex mu_;
    std::vector<int> fds_;
    std::vector<std::thread> conns_;
};

std::string payloadOf(int writer, int index, size_t size) {
    std::string p(size, '\0');
    for (size_t i = 0; i < size; ++i) p[i] = static_cast<char>((writer * 131 + index * 17 + i) & 0xff);
    return p;
}

} // namespace

int main() {
    std::printf("=== parvane-core transport tests (NAT-07/08/14) ===\n");
    // Хранилище доверия: сертификат тестового сервера (как CA-каталоги Android, PARVANE_CA_DIRS)
    char tmpl[] = "/tmp/parvane-transport-test-XXXXXX";
    const char *dir = mkdtemp(tmpl);
    if (!dir) {
        std::printf("mkdtemp не удался\n");
        return 2;
    }
    const auto cert = makeCert();
    {
        const auto path = std::string(dir) + "/localhost.pem";
        FILE *f = std::fopen(path.c_str(), "w");
        if (!f || PEM_write_X509(f, cert.x509) != 1) {
            std::printf("сертификат не записан\n");
            return 2;
        }
        std::fclose(f);
        ::setenv("PARVANE_CA_DIRS", dir, 1);
    }

    // ── 1. NAT-08: чтение и запись одного TLS-соединения не пересекаются ─────────────────
    {
        WsServer server(cert);
        g_overlaps = 0;
        std::mutex mu;
        std::condition_variable cv;
        std::size_t gotBytes = 0;
        int gotFrames = 0;
        parvane::GatewayWsTransport ws;
        ws.setBinaryHandler([&](std::string frame) {
            std::lock_guard<std::mutex> lk(mu);
            gotBytes += frame.size();
            ++gotFrames;
            cv.notify_all();
        });
        bool connected = false;
        try {
            ws.connectUrl(server.url());
            connected = true;
        } catch (const std::exception &e) {
            check(false, "WSS к тестовому серверу (проверка сертификата по PARVANE_CA_DIRS)", e.what());
        }
        if (connected) {
            constexpr int kWriters = 4;
            constexpr int kPerWriter = 250;
            std::atomic<std::size_t> sentBytes{0};
            std::atomic<int> sendErrors{0};
            std::vector<std::thread> writers;
            for (int w = 0; w < kWriters; ++w) {
                writers.emplace_back([&, w] {
                    for (int i = 0; i < kPerWriter; ++i) {
                        const auto p = payloadOf(w, i, 200 + static_cast<size_t>((i * 37 + w * 101) % 6000));
                        try {
                            ws.sendBinary(p);
                            sentBytes += p.size();
                        } catch (const std::exception &) {
                            ++sendErrors;
                        }
                    }
                });
            }
            for (auto &t : writers) t.join();
            {
                std::unique_lock<std::mutex> lk(mu);
                cv.wait_for(lk, 20s, [&] { return gotFrames >= kWriters * kPerWriter; });
            }
            check(sendErrors == 0, "NAT-08: 1000 сообщений из 4 потоков отправлены без ошибок",
                  std::to_string(sendErrors.load()));
            {
                std::lock_guard<std::mutex> lk(mu);
                check(gotFrames == kWriters * kPerWriter && gotBytes == sentBytes,
                      "NAT-08: эхо пришло целиком (кадры не перемешаны)",
                      std::to_string(gotFrames) + " кадров, " + std::to_string(gotBytes) + "/"
                          + std::to_string(sentBytes.load()) + " байт");
            }
            check(g_overlaps == 0, "NAT-08: SSL_read и SSL_write одного соединения не шли одновременно",
                  std::to_string(g_overlaps.load()) + " пересечений");
            ws.close();
        }
    }

    // ── 2. NAT-07: close() с другого потока, пока пишут ─────────────────────────────────
    {
        WsServer server(cert);
        g_freeInUse = 0;
        int rounds = 0;
        int crashedWriters = 0;
        for (int round = 0; round < 25; ++round) {
            parvane::GatewayWsTransport ws;
            ws.setBinaryHandler([](std::string) {});
            try {
                ws.connectUrl(server.url());
            } catch (const std::exception &) {
                continue;
            }
            ++rounds;
            std::atomic<bool> stop{false};
            std::atomic<int> finished{0};
            std::vector<std::thread> writers;
            for (int w = 0; w < 3; ++w) {
                writers.emplace_back([&, w] {
                    for (int i = 0; !stop; ++i) {
                        try {
                            ws.sendBinary(payloadOf(w, i, 16384));
                        } catch (const parvane::GatewayError &) {
                            break; // закрыто — ожидаемо
                        }
                    }
                    ++finished;
                });
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(5 + round % 7));
            ws.close();
            stop = true;
            for (auto &t : writers) t.join();
            if (finished != 3) ++crashedWriters;
        }
        check(rounds == 25, "NAT-07: 25 соединений WSS открыты", std::to_string(rounds));
        check(crashedWriters == 0, "NAT-07: пишущие потоки завершаются после close() ошибкой, а не падением");
        check(g_freeInUse == 0, "NAT-07: close() не освобождает SSL, пока на нём идёт запись",
              std::to_string(g_freeInUse.load()) + " раз");
    }

    // ── 3. NAT-07: FrameIo (WSS и TCP PVN2) — close() с другого потока во время send() ───
    {
        WsServer server(cert);
        TcpSink sink;
        g_freeInUse = 0;
        int failures = 0;
        for (int round = 0; round < 20; ++round) {
            for (const auto &url : {server.url(), sink.url()}) {
                auto io = std::shared_ptr<parvane::v2::FrameIo>(parvane::v2::makeFrameIo(url));
                try {
                    io->open([](std::string) {}, [] {});
                } catch (const std::exception &) {
                    ++failures;
                    continue;
                }
                std::atomic<bool> stop{false};
                std::vector<std::thread> writers;
                for (int w = 0; w < 3; ++w) {
                    writers.emplace_back([&, w] {
                        for (int i = 0; !stop; ++i) {
                            try {
                                io->send(payloadOf(w, i, 8192));
                            } catch (const parvane::v2::V2Error &) {
                                break;
                            }
                        }
                    });
                }
                std::this_thread::sleep_for(std::chrono::milliseconds(3 + round % 5));
                io->close(); // прежде WsFrameIo разрушал транспорт под пишущими (use-after-free)
                stop = true;
                for (auto &t : writers) t.join();
            }
        }
        check(failures == 0, "NAT-07: FrameIo WSS и TCP открываются", std::to_string(failures));
        check(g_freeInUse == 0, "NAT-07: FrameIo::close() во время send() — без освобождения SSL под записью",
              std::to_string(g_freeInUse.load()) + " раз");
    }

    // ── 4. NAT-14: исключение в потоке чтения не роняет клиент ──────────────────────────
    {
        WsServer server(cert);
        server.echo = false;
        // Текстовый кадр с полями не того типа (обработчик v1-кадров бросал nlohmann::type_error),
        // затем два двоичных: на первом обработчик бросает сам, второй обязан дойти.
        server.greet = {{0x1, R"({"op":"msg","subject":1,"payload":2})"},
                        {0x1, R"({"op":"reply","id":3,"payload":{}})"},
                        {0x2, "first"},
                        {0x2, "second"}};
        std::mutex mu;
        std::condition_variable cv;
        std::vector<std::string> got;
        parvane::GatewayWsTransport ws;
        ws.setBinaryHandler([&](std::string frame) {
            {
                std::lock_guard<std::mutex> lk(mu);
                got.push_back(frame);
                cv.notify_all();
            }
            if (frame == "first") throw std::runtime_error("сбой обработчика");
        });
        try {
            ws.connectUrl(server.url());
        } catch (const std::exception &e) {
            check(false, "NAT-14: WSS к тестовому серверу", e.what());
        }
        {
            std::unique_lock<std::mutex> lk(mu);
            cv.wait_for(lk, 5s, [&] { return got.size() >= 2; });
            check(got.size() == 2 && got[1] == "second",
                  "NAT-14: после кадра с полями не того типа и исключения обработчика поток чтения жив",
                  std::to_string(got.size()) + " кадров");
        }
        check(ws.connected(), "NAT-14: соединение осталось открытым");
        ws.close();
    }

    std::string rm = "rm -rf '" + std::string(dir) + "'";
    (void)std::system(rm.c_str());
    X509_free(cert.x509);
    EVP_PKEY_free(cert.key);
    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
