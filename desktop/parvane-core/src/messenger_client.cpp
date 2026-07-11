// Parvane fork: реализация MessengerClient (см. messenger_client.h).
#include "parvane/messenger_client.h"

#include "parvane/events.h"
#include "parvane/ids.h"
#include "parvane/topics.h"

#include <cstdint>

namespace parvane {

namespace {

// Единая точка генерации id события/сообщения (см. parvane/ids.h).
std::string uuid4() { return newUuidV7(); }

} // namespace

std::string MessengerClient::sendText(
        const std::string &from,
        const std::string &to,
        const std::string &text,
        const std::string &token,
        const std::optional<std::string> &replyTo,
        const std::optional<std::string> &id,
        const json &entities,
        const json &webpage) {
    SendPayload payload;
    payload.to = to;
    payload.content = textContent(text, entities, webpage);
    payload.reply_to = replyTo;

    const std::string idStr = id.value_or(uuid4());
    const json ev = makeEvent(idStr, from, nowUnix(), token, payload.toJson());
    _t.publish(topics::MsgSend, ev.dump());
    return idStr;
}

std::string MessengerClient::sendContent(
        const std::string &from,
        const std::string &to,
        const json &contentJson,
        const std::string &token,
        const std::optional<std::string> &replyTo,
        const std::optional<std::string> &id) {
    SendPayload payload;
    payload.to = to;
    payload.content = contentJson;
    payload.reply_to = replyTo;

    const std::string idStr = id.value_or(uuid4());
    const json ev = makeEvent(idStr, from, nowUnix(), token, payload.toJson());
    _t.publish(topics::MsgSend, ev.dump());
    return idStr;
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

void MessengerClient::react(
        const std::string &from, const std::string &messageId,
        const std::string &emoji, const std::string &token) {
    const json payload{{"message_id", messageId}, {"emoji", emoji}};
    _t.publish(topics::MsgReact,
               makeEvent(uuid4(), from, nowUnix(), token, payload).dump());
}

void MessengerClient::pin(
        const std::string &from, const std::string &messageId,
        bool pinned, const std::string &token) {
    const json payload{{"message_id", messageId}, {"pin", pinned}};
    _t.publish(topics::MsgPin,
               makeEvent(uuid4(), from, nowUnix(), token, payload).dump());
}

void MessengerClient::onDelivered(const std::string &self,
                                  std::function<void(std::string)> handler) {
    _t.subscribe(topics::msgInbox(self),
                 [handler = std::move(handler)](std::string, std::string payload) {
                     try {
                         const auto ev = json::parse(payload);
                         const auto &p = ev.contains("payload") ? ev["payload"] : ev;
                         // delivered несёт message_id; InboxPush несёт message —
                         // не путать (на инбокс приходит и то, и другое).
                         if (p.contains("message_id") && p["message_id"].is_string()) {
                             const auto id = p["message_id"].get<std::string>();
                             if (!id.empty()) handler(id);
                         }
                     } catch (...) {
                         // битый кадр — игнор, не критичный путь.
                     }
                 });
}

void MessengerClient::onInbox(const std::string &self,
                              std::function<void(StoredMessage)> handler) {
    _t.subscribe(topics::msgInbox(self),
                 [handler = std::move(handler)](std::string, std::string payload) {
                     try {
                         const auto ev = json::parse(payload);
                         const auto &p = ev.contains("payload") ? ev["payload"] : ev;
                         if (p.contains("message")) {
                             handler(StoredMessage::fromJson(p["message"]));
                         }
                     } catch (...) {
                         // битый InboxPush — игнор.
                     }
                 });
}

void MessengerClient::ack(const std::string &from, const std::string &messageId,
                          const std::string &token, const std::string &sender) {
    const json payload{{"message_id", messageId}, {"sender", sender}};
    _t.publish(topics::MsgAck,
               makeEvent(uuid4(), from, nowUnix(), token, payload).dump());
}

} // namespace parvane
