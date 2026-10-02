// Parvane Android: чистое отображение события движка v2 → событие ядра для
// Kotlin (spec 007, T066). Общее для parvane_jni.cpp (устройство) и
// protocol_jni.cpp (JVM-тесты шва на хосте): тест проверяет ровно тот код,
// которым телефон перекладывает v2-входящие в структуры v1-входящих.
#pragma once

#include <parvane/messenger.h>
#include <parvane/v2_content.h>

#include <nlohmann/json.hpp>

#include <cstdint>
#include <string>

namespace parvane::android_v2 {

using nlohmann::json;
using Incoming = parvane::v2::Incoming;

inline const char *kindName(Incoming::Kind k) {
    switch (k) {
    case Incoming::Kind::Message: return "message";
    case Incoming::Kind::Stub: return "stub";
    case Incoming::Kind::Edit: return "edit";
    case Incoming::Kind::Delete: return "delete";
    case Incoming::Kind::Reaction: return "reaction";
    case Incoming::Kind::Pin: return "pin";
    case Incoming::Kind::Read: return "read";
    case Incoming::Kind::None: break;
    }
    return "none";
}

// Разобранное событие (диагностика и тесты).
inline json incomingJson(const Incoming &in) {
    return json{{"kind", kindName(in.kind)}, {"id", in.id}, {"from", in.from}, {"chat", in.chat},
                {"to", in.to}, {"group", in.group}, {"ts", in.ts}, {"content", in.content},
                {"reply_to", in.replyTo}, {"targets", in.targets}, {"emoji", in.emoji},
                {"remove", in.remove}, {"unpin", in.unpin}};
}

// Сообщение/заглушка v2 → событие "message" в том же виде, что и у v1
// (deliverStored): Kotlin-шов не различает протоколы; групповое v2 — в чат
// группы "v2g:<hex>" (to), group=true; вид, которого клиент не
// знает, приходит с content {"kind":"unsupported"} → TdApi.MessageUnsupported.
inline json messageEvent(const Incoming &in, const std::string &self, std::int64_t nowSec) {
    const bool out = in.from == self;
    return json{{"type", "message"}, {"id", in.id}, {"from", in.from}, {"to", in.to},
                {"ts", in.ts ? in.ts : nowSec},
                {"text", in.content.value("text", in.content.value("caption", std::string()))},
                {"out", out}, {"kind", parvane::contentKind(in.content)}, {"read", false},
                {"content", in.content},
                {"reply_to", in.replyTo.empty() ? json() : json(in.replyTo)},
                {"edited", false}, {"pinned", false}, {"reactions", json::array()},
                {"group", in.group}, {"proto", 2}};
}

// ── режим «усиленная приватность» (L2, правило L2-1; spec 007, T079) ─────────
// Смена режима — ВИДИМОЕ служебное сообщение чата с содержимым
// {"kind":"chat_mode","l2":bool} (CONTENT-1). В личном чате чужое включение
// приходит обычным событием движка "direct" (messageEvent выше); здесь — два
// случая, которых в потоке движка нет.

// Событие сессии "groupL2" (политика группы изменилась по журналу или мы вошли
// в L2-группу) → событие "message" в чат группы от имени `by`. Квитанции о
// прочтении такому сообщению слать некому — оно сразу «прочитано».
inline json groupL2Event(const json &ev, const std::string &self, std::int64_t nowSec) {
    const auto by = ev.value("by", std::string());
    const auto tsMs = ev.value("tsMs", std::int64_t(0));
    return json{{"type", "message"}, {"id", ev.value("id", std::string())}, {"from", by},
                {"to", ev.value("address", std::string())}, {"ts", tsMs > 0 ? tsMs / 1000 : nowSec},
                {"text", ""}, {"out", !by.empty() && by == self}, {"kind", parvane::v2::kChatModeKind},
                {"read", true}, {"content", parvane::v2::chatModeContent(ev.value("enabled", false))},
                {"reply_to", json()}, {"edited", false}, {"pinned", false}, {"reactions", json::array()},
                {"group", true}, {"proto", 2}};
}

// Своё включение/выключение в личном чате: эхо от движка не приходит — клиент
// показывает служебное сообщение сам, с id операции (opId), и журналирует его
// как обычное сообщение (переживает рестарт).
inline json ownChatModeEvent(const std::string &self, const std::string &peer, bool enabled,
                             const std::string &opId, std::int64_t nowSec) {
    return json{{"type", "message"}, {"id", opId}, {"from", self}, {"to", peer}, {"ts", nowSec},
                {"text", ""}, {"out", true}, {"kind", parvane::v2::kChatModeKind}, {"read", true},
                {"content", parvane::v2::chatModeContent(enabled)}, {"reply_to", json()},
                {"edited", false}, {"pinned", false}, {"reactions", json::array()},
                {"group", false}, {"proto", 2}};
}

// Событие сессии "l2State" → событие ядра "l2_state": чаты с активным режимом
// (собеседник или "v2g:<hex>"), из них включённые мной, и «можно ли публиковать
// присутствие». По нему JNI и шов держат кэш для горячих путей typing/presence.
inline json l2StateEvent(const json &ev) {
    const auto list = [&ev](const char *key) {
        auto out = json::array();
        const auto it = ev.find(key);
        if (it != ev.end() && it->is_array()) {
            for (const auto &c : *it) if (c.is_string()) out.push_back(c);
        }
        return out;
    };
    return json{{"type", "l2_state"}, {"chats", list("chats")}, {"mine", list("mine")},
                {"presence_allowed", ev.value("presenceAllowed", true)}};
}

// События v2-сессии с чистым отображением в событие ядра (остальные требуют
// состояния JNI и живут в parvane_jni.cpp). null — не из этого набора.
inline json sessionEvent(const json &ev, const std::string &self, std::int64_t nowSec) {
    const auto type = ev.value("type", std::string());
    if (type == "groupL2") return groupL2Event(ev, self, nowSec);
    if (type == "l2State") return l2StateEvent(ev);
    return nullptr;
}

} // namespace parvane::android_v2
