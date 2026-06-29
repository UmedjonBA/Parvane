// Parvane fork: реализация MessengerClient (см. messenger_client.h).
#include "parvane/messenger_client.h"

#include "parvane/events.h"
#include "parvane/topics.h"

#include <chrono>
#include <cstdint>
#include <cstdio>
#include <random>

namespace parvane {

namespace {

std::int64_t nowUnix() {
    return std::chrono::duration_cast<std::chrono::seconds>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
}

// UUID v7 (RFC 9562): 48-бит unix-millis в старших битах → строки лексикографически
// упорядочены по времени. КРИТИЧНО: messenger-шард фильтрует sync через
// `id > last_seen_id` строковым сравнением и рассчитывает именно на v7-порядок
// (как Uuid::now_v7 на Rust-стороне). v4 сломал бы инкрементальный sync.
std::string uuidv7() {
    using namespace std::chrono;
    const std::uint64_t ms =
        duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
    static thread_local std::mt19937_64 rng(std::random_device{}());
    const std::uint64_t r = rng();
    const std::uint16_t randA = static_cast<std::uint16_t>(rng() & 0x0FFF);

    std::uint8_t b[16];
    b[0] = (ms >> 40) & 0xFF;
    b[1] = (ms >> 32) & 0xFF;
    b[2] = (ms >> 24) & 0xFF;
    b[3] = (ms >> 16) & 0xFF;
    b[4] = (ms >> 8) & 0xFF;
    b[5] = ms & 0xFF;
    b[6] = 0x70 | ((randA >> 8) & 0x0F); // версия 7
    b[7] = randA & 0xFF;
    b[8] = 0x80 | ((r >> 56) & 0x3F);    // вариант 10
    b[9] = (r >> 48) & 0xFF;
    b[10] = (r >> 40) & 0xFF;
    b[11] = (r >> 32) & 0xFF;
    b[12] = (r >> 24) & 0xFF;
    b[13] = (r >> 16) & 0xFF;
    b[14] = (r >> 8) & 0xFF;
    b[15] = r & 0xFF;

    char buf[37];
    std::snprintf(buf, sizeof(buf),
        "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
        b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
        b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]);
    return std::string(buf);
}

// Единая точка генерации id события/сообщения.
std::string uuid4() { return uuidv7(); }

} // namespace

std::string MessengerClient::sendText(
        const std::string &from,
        const std::string &to,
        const std::string &text,
        const std::string &token,
        const std::optional<std::string> &replyTo) {
    SendPayload payload;
    payload.to = to;
    payload.content = textContent(text);
    payload.reply_to = replyTo;

    const std::string id = uuid4();
    const json ev = makeEvent(id, from, nowUnix(), token, payload.toJson());
    _t.publish(topics::MsgSend, ev.dump());
    return id;
}

std::vector<StoredMessage> MessengerClient::sync(
        const std::string &from,
        const std::string &token,
        const std::string &lastSeenId,
        std::int64_t sinceUpdated,
        int timeoutMs) {
    SyncRequestPayload req;
    req.last_seen_id = lastSeenId.empty() ? zeroCursor() : lastSeenId;
    req.since_updated = sinceUpdated;

    const json ev = makeEvent(uuid4(), from, nowUnix(), token, req.toJson());
    const std::string raw =
        _t.request(topics::MsgSyncRequest, ev.dump(), timeoutMs);
    return SyncResponsePayload::fromJson(json::parse(raw)).messages;
}

void MessengerClient::editText(
        const std::string &from, const std::string &messageId,
        const std::string &text, const std::string &token) {
    const json payload{{"message_id", messageId}, {"text", text}};
    _t.publish(topics::MsgEdit,
               makeEvent(uuid4(), from, nowUnix(), token, payload).dump());
}

void MessengerClient::deleteMessage(
        const std::string &from, const std::string &messageId,
        const std::string &token) {
    const json payload{{"message_id", messageId}};
    _t.publish(topics::MsgDelete,
               makeEvent(uuid4(), from, nowUnix(), token, payload).dump());
}

void MessengerClient::markRead(
        const std::string &from, const std::string &messageId,
        const std::string &token) {
    const json payload{{"message_id", messageId}};
    _t.publish(topics::MsgRead,
               makeEvent(uuid4(), from, nowUnix(), token, payload).dump());
}

void MessengerClient::onDelivered(std::function<void(std::string)> handler) {
    _t.subscribe(topics::MsgDelivered,
                 [handler = std::move(handler)](std::string, std::string payload) {
                     try {
                         const auto d = DeliveredPayload::fromJson(json::parse(payload));
                         if (!d.message_id.empty()) handler(d.message_id);
                     } catch (...) {
                         // битый delivered — игнор, это не критичный путь.
                     }
                 });
}

} // namespace parvane
