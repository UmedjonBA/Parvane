// Parvane fork: соединение протокола v2 с gateway (см. v2_link.h).
#include "parvane/v2_link.h"

#include "parvane/gateway_ws_transport.h"
#include "parvane/v2_engine.h"

#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <unistd.h>

#include <chrono>
#include <thread>

namespace parvane::v2 {

namespace {

// Потолок кадра — как у движка (codec::MAX_FRAME).
constexpr std::size_t kMaxFrame = 4194304;

// ── WebSocket (двоичный режим GatewayWsTransport) ──────────────────────────
class WsFrameIo final : public FrameIo {
public:
    explicit WsFrameIo(std::string url) : url_(std::move(url)) {}
    ~WsFrameIo() override { close(); }

    void open(FrameHandler onFrame, ClosedHandler onClosed) override {
        ws_ = std::make_unique<GatewayWsTransport>();
        ws_->setBinaryHandler(std::move(onFrame));
        ws_->setClosedHandler(std::move(onClosed));
        try {
            ws_->connectUrl(url_);
        } catch (const std::exception &e) {
            ws_.reset();
            throw V2Error(std::string("ERROR_CODE_UNAVAILABLE: ") + e.what());
        }
    }

    void send(const std::string &frame) override {
        if (!ws_) throw V2Error("ERROR_CODE_UNAVAILABLE");
        try {
            ws_->sendBinary(frame);
        } catch (const std::exception &) {
            throw V2Error("ERROR_CODE_UNAVAILABLE");
        }
    }

    void close() override {
        if (ws_) {
            ws_->close();
            ws_.reset();
        }
    }

private:
    std::string url_;
    std::unique_ptr<GatewayWsTransport> ws_;
};

// ── TCP: преамбула PVN2, кадры с varint-длиной ─────────────────────────────
// Varint-префикс — транспортная обёртка (как TcpDecoder движка), содержимое
// кадра здесь не разбирается.
class TcpFrameIo final : public FrameIo {
public:
    TcpFrameIo(std::string host, int port) : host_(std::move(host)), port_(port) {}
    ~TcpFrameIo() override { close(); }

    void open(FrameHandler onFrame, ClosedHandler onClosed) override {
        addrinfo hints{};
        hints.ai_family = AF_UNSPEC;
        hints.ai_socktype = SOCK_STREAM;
        addrinfo *res = nullptr;
        const auto portStr = std::to_string(port_);
        if (getaddrinfo(host_.c_str(), portStr.c_str(), &hints, &res) != 0 || !res) {
            throw V2Error("ERROR_CODE_UNAVAILABLE: не резолвится " + host_);
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
        if (fd < 0) throw V2Error("ERROR_CODE_UNAVAILABLE: нет соединения с " + host_ + ":" + portStr);
        int one = 1;
        ::setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
        fd_ = fd;
        onFrame_ = std::move(onFrame);
        onClosed_ = std::move(onClosed);
        if (!writeAll("PVN2")) {
            ::close(fd_);
            fd_ = -1;
            throw V2Error("ERROR_CODE_UNAVAILABLE: преамбула не отправлена");
        }
        running_ = true;
        reader_ = std::thread(&TcpFrameIo::readerLoop, this);
    }

    void send(const std::string &frame) override {
        std::string out;
        std::uint64_t n = frame.size();
        do {
            unsigned char b = n & 0x7f;
            n >>= 7;
            if (n) b |= 0x80;
            out.push_back(static_cast<char>(b));
        } while (n);
        out += frame;
        std::lock_guard<std::mutex> lk(writeMu_);
        if (fd_ < 0 || !running_ || !writeAll(out)) throw V2Error("ERROR_CODE_UNAVAILABLE");
    }

    void close() override {
        if (fd_ < 0) return;
        running_ = false;
        ::shutdown(fd_, SHUT_RDWR);
        if (reader_.joinable()) reader_.join();
        ::close(fd_);
        fd_ = -1;
    }

private:
    bool writeAll(const std::string &data) {
        std::size_t off = 0;
        while (off < data.size()) {
            const auto n = ::send(fd_, data.data() + off, data.size() - off, MSG_NOSIGNAL);
            if (n <= 0) return false;
            off += static_cast<std::size_t>(n);
        }
        return true;
    }

    void readerLoop() {
        std::string acc;
        char buf[16384];
        while (running_) {
            const auto n = ::recv(fd_, buf, sizeof(buf), 0);
            if (n <= 0) break;
            acc.append(buf, static_cast<std::size_t>(n));
            bool bad = false;
            for (;;) {
                std::uint64_t len = 0;
                std::size_t pre = 0;
                bool complete = false;
                for (std::size_t i = 0; i < 5 && i < acc.size(); ++i) {
                    const auto b = static_cast<unsigned char>(acc[i]);
                    len |= std::uint64_t(b & 0x7f) << (7 * i);
                    if (!(b & 0x80)) {
                        pre = i + 1;
                        complete = true;
                        break;
                    }
                }
                if (!complete) {
                    if (acc.size() >= 5) bad = true; // префикс длиннее 5 байт
                    break;
                }
                if (len > kMaxFrame) {
                    bad = true;
                    break;
                }
                if (acc.size() < pre + len) break;
                std::string frame = acc.substr(pre, static_cast<std::size_t>(len));
                acc.erase(0, pre + static_cast<std::size_t>(len));
                if (onFrame_) onFrame_(std::move(frame));
            }
            if (bad) break;
        }
        running_ = false;
        if (onClosed_) onClosed_();
    }

    std::string host_;
    int port_ = 0;
    int fd_ = -1;
    std::atomic<bool> running_{false};
    std::thread reader_;
    std::mutex writeMu_;
    FrameHandler onFrame_;
    ClosedHandler onClosed_;
};

} // namespace

std::unique_ptr<FrameIo> makeFrameIo(const std::string &url) {
    if (url.rfind("ws://", 0) == 0 || url.rfind("wss://", 0) == 0) {
        return std::make_unique<WsFrameIo>(url);
    }
    auto hostport = url;
    if (hostport.rfind("tcp://", 0) == 0) hostport = hostport.substr(6);
    const auto colon = hostport.rfind(':');
    const auto host = colon == std::string::npos ? hostport : hostport.substr(0, colon);
    const int port = colon == std::string::npos ? 9223 : std::atoi(hostport.c_str() + colon + 1);
    return std::make_unique<TcpFrameIo>(host, port > 0 ? port : 9223);
}

// ── Connection ──────────────────────────────────────────────────────────────

Connection::Connection(std::string url) : url_(std::move(url)) {}

Connection::~Connection() { close(); }

void Connection::setEventHandler(std::function<void(const Event &)> h) {
    std::lock_guard<std::mutex> lk(handlerMu_);
    onEvent_ = std::move(h);
}

void Connection::setClosedHandler(std::function<void()> h) {
    std::lock_guard<std::mutex> lk(handlerMu_);
    onClosedCb_ = std::move(h);
}

std::string Connection::waitFor(const std::string &kind, std::int64_t timeoutMs, std::string *out) {
    std::unique_lock<std::mutex> lk(mu_);
    const bool got = cv_.wait_for(lk, std::chrono::milliseconds(timeoutMs), [&] { return waitDone_; });
    const auto err = waitError_;
    if (got && err.empty() && out) *out = waitFrame_;
    waitKind_.clear();
    waitDone_ = false;
    waitError_.clear();
    waitFrame_.clear();
    if (!got) return "ERROR_CODE_UNAVAILABLE";
    (void)kind;
    return err;
}

void Connection::sendFrame(const std::string &frame) {
    std::shared_ptr<FrameIo> io;
    {
        std::lock_guard<std::mutex> lk(ioMu_);
        io = io_;
    }
    if (!io || !open_) throw V2Error("ERROR_CODE_UNAVAILABLE");
    io->send(frame);
}

Welcome Connection::open(int channel, const std::string &clientVersion, std::int64_t timeoutMs) {
    close();
    auto io = std::shared_ptr<FrameIo>(makeFrameIo(url_));
    {
        std::lock_guard<std::mutex> lk(mu_);
        waitKind_ = "welcome";
        waitDone_ = false;
        waitError_.clear();
    }
    closing_ = false;
    io->open([this](std::string f) { onFrame(f); }, [this] { onClosed(); });
    {
        std::lock_guard<std::mutex> lk(ioMu_);
        io_ = io;
    }
    open_ = true;
    try {
        sendFrame(encodeHello(channel, "desktop", clientVersion));
    } catch (...) {
        close();
        throw;
    }
    std::string frame;
    const auto err = waitFor("welcome", timeoutMs, &frame);
    if (!err.empty()) {
        close();
        throw V2Error(err);
    }
    const auto f = json::parse(frame, nullptr, false);
    Welcome w;
    if (f.is_object()) {
        w.serverDescriptor = fromBase64(f.value("serverDescriptor", std::string()));
        if (f.contains("features") && f["features"].is_array()) {
            for (const auto &x : f["features"]) {
                if (x.is_string()) w.features.push_back(x.get<std::string>());
            }
        }
    }
    return w;
}

AuthOk Connection::auth(const std::string &token, std::int64_t timeoutMs) {
    {
        std::lock_guard<std::mutex> lk(mu_);
        waitKind_ = "authOk";
        waitDone_ = false;
        waitError_.clear();
    }
    sendFrame(encodeAuth(token));
    std::string frame;
    const auto err = waitFor("authOk", timeoutMs, &frame);
    if (!err.empty()) throw V2Error(err);
    const auto f = json::parse(frame, nullptr, false);
    AuthOk a;
    if (f.is_object()) {
        a.user = f.value("user", std::string());
        a.deviceId = f.value("deviceId", std::string());
    }
    return a;
}

std::string Connection::request(const std::string &method, const std::string &body, std::int64_t timeoutMs) {
    if (!open_) throw V2Error("ERROR_CODE_UNAVAILABLE");
    const auto id = nextId_++;
    {
        std::lock_guard<std::mutex> lk(mu_);
        pending_[id] = Pending{};
    }
    try {
        sendFrame(encodeRequest(id, method, body,
            static_cast<std::uint32_t>(std::min<std::int64_t>(timeoutMs, 30000))));
    } catch (...) {
        std::lock_guard<std::mutex> lk(mu_);
        pending_.erase(id);
        throw;
    }
    std::unique_lock<std::mutex> lk(mu_);
    const bool got = cv_.wait_for(lk, std::chrono::milliseconds(timeoutMs + 500), [&] {
        const auto it = pending_.find(id);
        return it == pending_.end() || it->second.done;
    });
    auto it = pending_.find(id);
    if (it == pending_.end()) throw V2Error("ERROR_CODE_UNAVAILABLE");
    Pending p = std::move(it->second);
    pending_.erase(it);
    if (!got || !p.done) throw V2Error("ERROR_CODE_UNAVAILABLE");
    if (!p.error.empty()) throw V2Error(p.error, p.retryAfterMs);
    return p.body;
}

void Connection::onFrame(const std::string &bytes) {
    json f;
    try {
        f = decodeFrame(bytes);
    } catch (const std::exception &) {
        return; // неизвестный/битый кадр сервера — пропуск (класс 10)
    }
    const auto kind = f.value("kind", std::string());
    {
        std::lock_guard<std::mutex> lk(mu_);
        if (!waitKind_.empty() && !waitDone_) {
            if (kind == waitKind_) {
                waitFrame_ = f.dump();
                waitDone_ = true;
                cv_.notify_all();
                return;
            }
            if (kind == "response" && f.value("id", std::uint64_t(0)) == 0) {
                waitError_ = f.value("error", std::string("ERROR_CODE_UNSPECIFIED"));
                waitDone_ = true;
                cv_.notify_all();
                return;
            }
        }
        if (kind == "response") {
            const auto id = f.value("id", std::uint64_t(0));
            auto it = pending_.find(id);
            if (it == pending_.end()) return;
            if (f.contains("error") && f["error"].is_string()) {
                it->second.error = f["error"].get<std::string>();
                it->second.retryAfterMs = f.value("retryAfterMs", std::uint32_t(0));
            } else {
                try {
                    it->second.body = fromBase64(f.value("ok", std::string()));
                } catch (const std::exception &) {
                    it->second.error = "ERROR_CODE_UNSPECIFIED";
                }
            }
            it->second.done = true;
            cv_.notify_all();
            return;
        }
    }
    if (kind == "event") {
        Event e;
        e.subscription = f.value("subscription", std::uint64_t(0));
        e.kind = f.value("eventKind", std::string());
        e.seq = f.value("seq", std::uint64_t(0));
        try {
            e.body = fromBase64(f.value("body", std::string()));
        } catch (const std::exception &) {
            return;
        }
        std::function<void(const Event &)> h;
        {
            std::lock_guard<std::mutex> lk(handlerMu_);
            h = onEvent_;
        }
        if (h) h(e);
    }
    // ping/pong/chunk — сервер пингует редко, ответ не обязателен.
}

void Connection::onClosed() {
    open_ = false;
    {
        std::lock_guard<std::mutex> lk(mu_);
        for (auto &[id, p] : pending_) {
            if (!p.done) {
                p.done = true;
                p.error = "ERROR_CODE_UNAVAILABLE";
            }
        }
        if (!waitKind_.empty() && !waitDone_) {
            waitError_ = "ERROR_CODE_UNAVAILABLE";
            waitDone_ = true;
        }
        cv_.notify_all();
    }
    if (closing_) return;
    std::function<void()> h;
    {
        std::lock_guard<std::mutex> lk(handlerMu_);
        h = onClosedCb_;
    }
    if (h) h();
}

void Connection::close() {
    std::shared_ptr<FrameIo> io;
    {
        std::lock_guard<std::mutex> lk(ioMu_);
        io = std::move(io_);
    }
    closing_ = true;
    open_ = false;
    if (io) io->close();
}

} // namespace parvane::v2
