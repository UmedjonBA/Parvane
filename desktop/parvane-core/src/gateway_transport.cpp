// Parvane fork: реализация клиентского транспорта через gateway (см. .h).
// POSIX TCP-сокет + reader-поток, корреляция ответов по id, подписки по subject.
#include "parvane/gateway_transport.h"

#include <nlohmann/json.hpp>

#include <arpa/inet.h>
#include <cstring>
#include <netdb.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <chrono>
#include <memory>

using nlohmann::json;
using namespace std::chrono_literals;

namespace parvane {

GatewayTransport::GatewayTransport() = default;

GatewayTransport::~GatewayTransport() { close(); }

void GatewayTransport::connect(const std::string &host, int port) {
    close();

    addrinfo hints{};
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    addrinfo *res = nullptr;
    const auto portStr = std::to_string(port);
    if (getaddrinfo(host.c_str(), portStr.c_str(), &hints, &res) != 0 || !res) {
        throw GatewayError("gateway: не резолвится " + host);
    }

    int fd = -1;
    for (addrinfo *ai = res; ai; ai = ai->ai_next) {
        fd = ::socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
        if (fd < 0) {
            continue;
        }
        if (::connect(fd, ai->ai_addr, ai->ai_addrlen) == 0) {
            break;
        }
        ::close(fd);
        fd = -1;
    }
    freeaddrinfo(res);
    if (fd < 0) {
        throw GatewayError("gateway: не удалось подключиться к " + host + ":" + portStr);
    }

    fd_ = fd;
    running_ = true;
    reader_ = std::thread(&GatewayTransport::readerLoop, this);
}

bool GatewayTransport::connected() const { return fd_ >= 0 && running_; }

void GatewayTransport::close() {
    if (fd_ < 0) {
        return;
    }
    running_ = false;
    ::shutdown(fd_, SHUT_RDWR);
    if (reader_.joinable()) {
        reader_.join();
    }
    ::close(fd_);
    fd_ = -1;

    // Разбудить всех ожидающих с ошибкой.
    {
        std::lock_guard<std::mutex> lk(pendMu_);
        for (auto &[id, p] : pending_) {
            std::lock_guard<std::mutex> pl(p->m);
            p->error = true;
            p->errmsg = "соединение с gateway закрыто";
            p->ended = true;
            p->cv.notify_all();
        }
        pending_.clear();
    }
    {
        std::lock_guard<std::mutex> lk(authMu_);
        if (authState_ == 0) {
            authState_ = -1;
            authErr_ = "соединение закрыто до auth";
            authCv_.notify_all();
        }
    }
}

void GatewayTransport::sendLine(const std::string &frame) {
    std::string data = frame;
    data.push_back('\n');
    std::lock_guard<std::mutex> lk(writeMu_);
    if (fd_ < 0) {
        throw GatewayError("gateway: не подключено");
    }
    size_t off = 0;
    while (off < data.size()) {
        ssize_t n = ::send(fd_, data.data() + off, data.size() - off, MSG_NOSIGNAL);
        if (n <= 0) {
            throw GatewayError("gateway: ошибка отправки");
        }
        off += static_cast<size_t>(n);
    }
}

std::string GatewayTransport::nextId() { return std::to_string(idSeq_++); }

void GatewayTransport::readerLoop() {
    std::string acc;
    char buf[8192];
    while (running_) {
        ssize_t n = ::recv(fd_, buf, sizeof(buf), 0);
        if (n <= 0) {
            break; // закрыто/ошибка
        }
        acc.append(buf, static_cast<size_t>(n));
        size_t pos;
        while ((pos = acc.find('\n')) != std::string::npos) {
            std::string line = acc.substr(0, pos);
            acc.erase(0, pos + 1);
            if (!line.empty()) {
                dispatch(line);
            }
        }
    }
}

void GatewayTransport::dispatch(const std::string &line) {
    json v = json::parse(line, nullptr, /*allow_exceptions=*/false);
    if (v.is_discarded() || !v.is_object()) {
        return;
    }
    const std::string op = v.value("op", "");

    if (op == "auth_ok" || op == "auth_err") {
        std::lock_guard<std::mutex> lk(authMu_);
        if (op == "auth_ok") {
            authState_ = 1;
            authUser_ = v.value("user", "");
        } else {
            authState_ = -1;
            authErr_ = v.value("error", "auth error");
        }
        authCv_.notify_all();
        return;
    }

    if (op == "msg") {
        const std::string subject = v.value("subject", "");
        const std::string payload = v.value("payload", "");
        std::vector<Handler> hs;
        {
            std::lock_guard<std::mutex> lk(subMu_);
            auto it = subs_.find(subject);
            if (it != subs_.end()) {
                hs = it->second;
            }
        }
        for (auto &h : hs) {
            h(subject, payload);
        }
        return;
    }

    if (op == "reply" || op == "reply_end" || op == "err") {
        const std::string id = v.value("id", "");
        if (id.empty()) {
            return; // безадресная ошибка — игнор (напр. запрещённый pub)
        }
        std::shared_ptr<Pending> p;
        {
            std::lock_guard<std::mutex> lk(pendMu_);
            auto it = pending_.find(id);
            if (it != pending_.end()) {
                p = it->second;
            }
        }
        if (!p) {
            return;
        }
        std::lock_guard<std::mutex> pl(p->m);
        if (op == "reply") {
            p->replies.push_back(v.value("payload", ""));
        } else if (op == "reply_end") {
            p->ended = true;
        } else { // err
            p->error = true;
            p->errmsg = v.value("error", "gateway error");
            p->ended = true;
        }
        p->cv.notify_all();
    }
}

void GatewayTransport::authenticate(const std::string &token, std::int64_t timeoutMs) {
    {
        std::lock_guard<std::mutex> lk(authMu_);
        authState_ = 0;
        authUser_.clear();
        authErr_.clear();
    }
    json f = {{"op", "auth"}, {"token", token}};
    sendLine(f.dump());

    std::unique_lock<std::mutex> lk(authMu_);
    if (!authCv_.wait_for(lk, std::chrono::milliseconds(timeoutMs),
                          [&] { return authState_ != 0; })) {
        throw GatewayError("gateway: таймаут авторизации");
    }
    if (authState_ != 1) {
        throw GatewayError("gateway: отказ авторизации: " + authErr_);
    }
}

std::string GatewayTransport::request(const std::string &subject,
                                      const std::string &payload,
                                      std::int64_t timeoutMs) {
    const auto id = nextId();
    auto p = std::make_shared<Pending>();
    {
        std::lock_guard<std::mutex> lk(pendMu_);
        pending_[id] = p;
    }
    json f = {{"op", "req"}, {"id", id}, {"subject", subject},
              {"payload", payload}, {"timeout_ms", timeoutMs}};
    sendLine(f.dump());

    std::string result;
    bool err = false;
    std::string errmsg;
    bool got = false;
    {
        std::unique_lock<std::mutex> lk(p->m);
        got = p->cv.wait_for(lk, std::chrono::milliseconds(timeoutMs + 500),
                             [&] { return !p->replies.empty() || p->error; });
        if (p->error) {
            err = true;
            errmsg = p->errmsg;
        } else if (!p->replies.empty()) {
            result = p->replies.front();
        }
    }
    {
        std::lock_guard<std::mutex> lk(pendMu_);
        pending_.erase(id);
    }
    if (err) {
        throw GatewayError(errmsg);
    }
    if (!got) {
        throw GatewayError("gateway: таймаут request " + subject);
    }
    return result;
}

void GatewayTransport::publish(const std::string &subject, const std::string &payload) {
    json f = {{"op", "pub"}, {"subject", subject}, {"payload", payload}};
    sendLine(f.dump());
}

void GatewayTransport::requestMany(const std::string &subject, const std::string &payload,
                                   const ReplyHandler &onReply, std::int64_t timeoutMs) {
    const auto id = nextId();
    auto p = std::make_shared<Pending>();
    {
        std::lock_guard<std::mutex> lk(pendMu_);
        pending_[id] = p;
    }
    json f = {{"op", "reqmany"}, {"id", id}, {"subject", subject},
              {"payload", payload}, {"timeout_ms", timeoutMs}};
    sendLine(f.dump());

    const auto deadline =
        std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs + 1000);
    bool wantMore = true;
    std::string err;
    while (wantMore) {
        std::string reply;
        bool haveReply = false;
        bool ended = false;
        {
            std::unique_lock<std::mutex> lk(p->m);
            if (!p->cv.wait_until(lk, deadline,
                                  [&] { return !p->replies.empty() || p->ended; })) {
                break; // общий таймаут
            }
            if (!p->replies.empty()) {
                reply = p->replies.front();
                p->replies.pop_front();
                haveReply = true;
            }
            if (p->error) {
                err = p->errmsg;
            }
            ended = p->ended && p->replies.empty();
        }
        if (haveReply) {
            wantMore = onReply(reply);
        }
        if (ended) {
            break;
        }
    }
    {
        std::lock_guard<std::mutex> lk(pendMu_);
        pending_.erase(id);
    }
    if (!err.empty()) {
        throw GatewayError(err);
    }
}

void GatewayTransport::subscribe(const std::string &subject, Handler handler) {
    {
        std::lock_guard<std::mutex> lk(subMu_);
        subs_[subject].push_back(std::move(handler));
    }
    json f = {{"op", "sub"}, {"subject", subject}};
    sendLine(f.dump());
}

} // namespace parvane
