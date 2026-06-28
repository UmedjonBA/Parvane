// Parvane fork: реализация транспорта поверх cnats. См. transport.h.
#include "parvane/transport.h"

#include <memory>
#include <mutex>
#include <vector>

#include <nats.h>

namespace parvane {
namespace {

// Замыкание для асинхронной подписки: cnats передаёт void* closure в C-колбэк,
// мы кладём туда указатель на этот объект (владение — в Impl::subs_).
struct SubClosure {
    Transport::Handler handler;
};

void onMessage(natsConnection * /*nc*/, natsSubscription * /*sub*/,
               natsMsg *msg, void *closure) {
    auto *c = static_cast<SubClosure *>(closure);
    if (c && c->handler) {
        const char *data = natsMsg_GetData(msg);
        int len = natsMsg_GetDataLength(msg);
        const char *subj = natsMsg_GetSubject(msg);
        c->handler(subj ? std::string(subj) : std::string(),
                   std::string(data ? data : "", data ? len : 0));
    }
    natsMsg_Destroy(msg);
}

[[noreturn]] void fail(const std::string &what, natsStatus s) {
    throw TransportError(what + ": " + natsStatus_GetText(s));
}

} // namespace

struct Transport::Impl {
    natsConnection *conn = nullptr;
    std::mutex mu;
    std::vector<natsSubscription *> subscriptions;
    std::vector<std::unique_ptr<SubClosure>> closures;
};

Transport::Transport() : d_(std::make_unique<Impl>()) {}

Transport::~Transport() { close(); }

void Transport::connect(const std::string &url) {
    close();
    natsStatus s = natsConnection_ConnectTo(&d_->conn, url.c_str());
    if (s != NATS_OK) {
        d_->conn = nullptr;
        fail("nats connect to " + url, s);
    }
}

bool Transport::connected() const {
    return d_->conn != nullptr &&
           natsConnection_Status(d_->conn) == NATS_CONN_STATUS_CONNECTED;
}

void Transport::close() {
    std::lock_guard<std::mutex> lock(d_->mu);
    for (auto *sub : d_->subscriptions)
        natsSubscription_Destroy(sub);
    d_->subscriptions.clear();
    d_->closures.clear();
    if (d_->conn) {
        natsConnection_Destroy(d_->conn);
        d_->conn = nullptr;
    }
}

std::string Transport::request(const std::string &subject,
                               const std::string &payload,
                               std::int64_t timeout_ms) {
    if (!d_->conn)
        throw TransportError("request: not connected");
    natsMsg *reply = nullptr;
    natsStatus s = natsConnection_Request(
        &reply, d_->conn, subject.c_str(), payload.data(),
        static_cast<int>(payload.size()), timeout_ms);
    if (s != NATS_OK)
        fail("nats request " + subject, s);
    const char *data = natsMsg_GetData(reply);
    int len = natsMsg_GetDataLength(reply);
    std::string out(data ? data : "", data ? len : 0);
    natsMsg_Destroy(reply);
    return out;
}

void Transport::publish(const std::string &subject,
                        const std::string &payload) {
    if (!d_->conn)
        throw TransportError("publish: not connected");
    natsStatus s =
        natsConnection_Publish(d_->conn, subject.c_str(), payload.data(),
                               static_cast<int>(payload.size()));
    if (s != NATS_OK)
        fail("nats publish " + subject, s);
}

void Transport::subscribe(const std::string &subject, Handler handler) {
    if (!d_->conn)
        throw TransportError("subscribe: not connected");
    std::lock_guard<std::mutex> lock(d_->mu);
    auto closure = std::make_unique<SubClosure>(SubClosure{std::move(handler)});
    natsSubscription *sub = nullptr;
    natsStatus s = natsConnection_Subscribe(&sub, d_->conn, subject.c_str(),
                                            &onMessage, closure.get());
    if (s != NATS_OK)
        fail("nats subscribe " + subject, s);
    d_->subscriptions.push_back(sub);
    d_->closures.push_back(std::move(closure));
}

} // namespace parvane
