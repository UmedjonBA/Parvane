// Parvane fork: C++-зеркало messenger-пейлоадов из shared/parvane-types/src/lib.rs.
// Контракт (Фаза 3):
//   msg.chat.send      — публикуется ПОЛНЫЙ ParvaneEvent<SendPayload>
//   msg.chat.delivered — messenger публикует ParvaneEvent<DeliveredPayload>
//                        (только message_id — ack отправителю; тела сообщения нет)
//   msg.sync.request   — ПОЛНЫЙ ParvaneEvent<SyncRequestPayload> (request/reply)
//   msg.sync.response  — ParvaneEvent<SyncResponsePayload> (на reply-инбокс)
//
// Модель приёма — PULL: получатель узнаёт о новых сообщениях, опрашивая
// msg.sync.request (last_seen_id + since_updated). delivered служит триггером
// "что-то изменилось, пора синкнуться". Тело гоняется как json, чтобы медиа-
// варианты MessageContent (Фаза 4) не требовали правок этого заголовка.
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace parvane {

using nlohmann::json;

// ── MessageContent (только текст для Фазы 3; медиа — Фаза 4) ──────────────────
// Сериализуется как { "kind": "text", "text": "..." } (serde tag = "kind",
// snake_case в parvane-types). Помощники не разбирают медиа-варианты, но и не
// теряют их: храним сырой json в StoredMessage::content.
inline json textContent(const std::string &text) {
    return json{{"kind", "text"}, {"text", text}};
}

// Если content — текстовый, вернуть строку; иначе nullopt (медиа/удалённое).
inline std::optional<std::string> contentText(const json &content) {
    if (!content.is_object()) return std::nullopt;
    const auto kind = content.value("kind", std::string());
    if (kind != "text") return std::nullopt;
    return content.value("text", std::string());
}

// "kind" контента ("text"/"voice"/"photo"/… или "" если неизвестно).
inline std::string contentKind(const json &content) {
    return content.is_object() ? content.value("kind", std::string()) : std::string();
}

// ── SendPayload (msg.chat.send) ──────────────────────────────────────────────
struct SendPayload {
    std::string to;
    json content;                          // обычно textContent(...)
    std::optional<std::string> reply_to;   // id сообщения-родителя

    json toJson() const {
        json j{{"to", to}, {"content", content}};
        if (reply_to) j["reply_to"] = *reply_to;
        return j;
    }
};

// ── SyncRequestPayload (msg.sync.request) ────────────────────────────────────
struct SyncRequestPayload {
    std::string last_seen_id;     // id-курсор; "" / нулевой uuid = с начала
    std::int64_t since_updated = 0; // курсор мутаций (правки/удаления/прочтения)

    json toJson() const {
        return json{{"last_seen_id", last_seen_id},
                    {"since_updated", since_updated}};
    }
};

// ── StoredMessage (элемент msg.sync.response) ────────────────────────────────
struct StoredMessage {
    std::string id;
    std::string from;
    std::string to;
    json content;
    std::int64_t ts = 0;
    std::optional<std::string> reply_to;
    bool edited = false;
    bool deleted = false;
    bool read = false;
    std::int64_t updated_at = 0;

    static StoredMessage fromJson(const json &j) {
        StoredMessage m;
        m.id = j.value("id", std::string());
        m.from = j.value("from", std::string());
        m.to = j.value("to", std::string());
        if (auto it = j.find("content"); it != j.end() && !it->is_null())
            m.content = *it;
        m.ts = j.value("ts", std::int64_t(0));
        if (auto it = j.find("reply_to"); it != j.end() && !it->is_null())
            m.reply_to = it->get<std::string>();
        m.edited = j.value("edited", false);
        m.deleted = j.value("deleted", false);
        m.read = j.value("read", false);
        m.updated_at = j.value("updated_at", std::int64_t(0));
        return m;
    }

    // Текст сообщения, если контент текстовый (для UI Фазы 3).
    std::optional<std::string> text() const { return contentText(content); }
};

// ── SyncResponsePayload (msg.sync.response) ──────────────────────────────────
struct SyncResponsePayload {
    std::vector<StoredMessage> messages;

    // Принимает либо ПОЛНЫЙ конверт ParvaneEvent<SyncResponsePayload>, либо
    // голый payload — messenger отвечает конвертом, но устойчивость не вредит.
    static SyncResponsePayload fromJson(const json &j) {
        const json *payload = &j;
        if (auto it = j.find("payload"); it != j.end() && it->is_object())
            payload = &*it;
        SyncResponsePayload r;
        if (auto it = payload->find("messages");
                it != payload->end() && it->is_array()) {
            r.messages.reserve(it->size());
            for (const auto &m : *it)
                r.messages.push_back(StoredMessage::fromJson(m));
        }
        return r;
    }
};

// ── DeliveredPayload (msg.chat.delivered) ────────────────────────────────────
struct DeliveredPayload {
    std::string message_id;

    // Принимает ПОЛНЫЙ конверт ParvaneEvent<DeliveredPayload> или голый payload.
    static DeliveredPayload fromJson(const json &j) {
        const json *payload = &j;
        if (auto it = j.find("payload"); it != j.end() && it->is_object())
            payload = &*it;
        DeliveredPayload d;
        d.message_id = payload->value("message_id", std::string());
        return d;
    }
};

} // namespace parvane
