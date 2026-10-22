// Parvane fork: методы управления по протоколу v2 — см. v2_control.h.
#include "parvane/v2_control.h"

#include <algorithm>
#include <stdexcept>

#include "parvane/v2_content.h"
#include "parvane/v2_engine.h"
#include "parvane/v2_link.h"

namespace parvane::v2 {

namespace {

// Обрыв соединения: вызов повторяется один раз на свежем соединении.
bool connectionLost(const V2Error &e, const Connection &c) {
    return !c.isOpen() || e.code() == "ERROR_CODE_UNAVAILABLE";
}

} // namespace

const json *field(const json &object, const char *camel, const char *snake) {
    if (!object.is_object()) return nullptr;
    if (auto it = object.find(camel); it != object.end()) return &*it;
    if (auto it = object.find(snake); it != object.end()) return &*it;
    return nullptr;
}

json preauth(const std::string &gatewayUrl, const std::string &method, const json &request,
             const std::string &clientVersion, std::int64_t timeoutMs, const std::string &dest) {
    const auto body = encodeMethodRequest(method, request);
    Connection conn(gatewayUrl);
    const auto welcome = conn.open(kChannelIdentified, clientVersion);
    (void)verifyServerDescriptor(welcome.serverDescriptor); // бросает при негодной подписи
    std::string response;
    try {
        response = conn.request(method, body, timeoutMs, dest);
    } catch (...) {
        conn.close();
        throw;
    }
    conn.close();
    return decodeMethodResponse(method, response);
}

Control::Control(ControlConfig cfg) : cfg_(std::move(cfg)) {}

Control::~Control() { close(); }

void Control::log(const std::string &m) const {
    if (cfg_.log) cfg_.log("v2 управление: " + m);
}

std::shared_ptr<Connection> Control::connection() {
    std::lock_guard<std::mutex> lk(mu_);
    if (conn_ && conn_->isOpen()) return conn_;
    if (conn_) conn_->close();
    conn_.reset();
    const auto token = cfg_.token ? cfg_.token() : std::string();
    if (token.empty()) throw std::runtime_error("v2 управление: нет JWT");
    auto fresh = std::make_shared<Connection>(cfg_.gatewayUrl);
    const auto welcome = fresh->open(kChannelIdentified, cfg_.clientVersion);
    (void)verifyServerDescriptor(welcome.serverDescriptor);
    fresh->auth(token);
    conn_ = fresh;
    return conn_;
}

void Control::drop(const std::shared_ptr<Connection> &c) {
    std::lock_guard<std::mutex> lk(mu_);
    if (conn_ == c) conn_.reset();
    if (c) c->close();
}

void Control::close() {
    std::shared_ptr<Connection> c;
    {
        std::lock_guard<std::mutex> lk(mu_);
        c = std::move(conn_);
        conn_.reset();
    }
    if (c) c->close();
}

json Control::call(const std::string &method, const json &request, std::int64_t timeoutMs,
                   const std::string &dest) {
    const auto body = encodeMethodRequest(method, request);
    for (int attempt = 0;; ++attempt) {
        auto c = connection();
        try {
            return decodeMethodResponse(method, c->request(method, body, timeoutMs, dest));
        } catch (const V2Error &e) {
            if (attempt > 0 || !connectionLost(e, *c)) throw;
            log(method + ": соединение потеряно — повтор");
            drop(c);
        }
    }
}

std::string Control::uploadBlob(const std::string &bytes, bool isPublic, std::size_t chunkBytes) {
    if (chunkBytes == 0) throw std::runtime_error("v2 управление: размер чанка");
    const auto total = std::max<std::size_t>(1, (bytes.size() + chunkBytes - 1) / chunkBytes);
    std::string uploadId;
    for (std::size_t index = 0; index < total; ++index) {
        const auto resp = call("cloud.blob.upload_chunk",
            json{{"upload_id", uploadId}, {"index", index},
                 {"data", toBase64(bytes.substr(index * chunkBytes, chunkBytes))}}, 60000);
        if (const auto *id = field(resp, "uploadId", "upload_id"); id && id->is_string() && !id->get<std::string>().empty()) {
            uploadId = id->get<std::string>();
        }
    }
    const auto done = call("cloud.blob.upload_complete",
        json{{"upload_id", uploadId}, {"chunks", total}, {"size", std::to_string(bytes.size())},
             {"visibility", isPublic ? "VISIBILITY_PUBLIC" : "VISIBILITY_PRIVATE"}}, 60000);
    const auto *id = field(done, "fileId", "file_id");
    if (!id || !id->is_string() || id->get<std::string>().empty()) throw V2Error("ERROR_CODE_INVALID");
    return id->get<std::string>();
}

std::string Control::downloadBlob(const std::string &fileId, std::size_t maxBytes) {
    // Ревью 21 окт (2.2): с потолком — отказ по заявленному размеру до приёма чанков (downloadBlobChunks)
    return downloadBlobChunks("cloud.blob.download", maxBytes,
        [&](const Connection::StreamLimits &limits) {
            const auto body = encodeMethodRequest("cloud.blob.download",
                json{{"file_id", fileId}, {"first_chunk", limits.firstChunk}, {"chunk_count", limits.chunkCount}});
            for (int attempt = 0;; ++attempt) {
                auto c = connection();
                try {
                    return c->requestStream("cloud.blob.download", body, 60000, std::string(), limits);
                } catch (const V2Error &e) {
                    if (attempt > 0 || !connectionLost(e, *c)) throw;
                    drop(c);
                }
            }
        });
}

void Control::deleteBlob(const std::string &fileId) {
    (void)call("cloud.blob.delete", json{{"file_id", fileId}});
}

} // namespace parvane::v2
