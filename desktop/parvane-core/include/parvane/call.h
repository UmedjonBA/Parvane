// Parvane fork: C++-зеркало call-пейлоадов из shared/parvane-types/src/lib.rs.
// Контракт (Фаза 4, звонки):
//   call.signal          — клиент шлёт ParvaneEvent<CallSignalPayload{to,signal}>
//   call.user.<addr>     — call-шард релеит ParvaneEvent<CallSignal> в инбокс
//                          получателя (payload = сам сигнал, from = инициатор)
//   call.history.request — ParvaneEvent<{}> → ParvaneEvent<CallHistoryResponse>
//
// CallSignal сериализуется с внутренним тегом: {"type":"invite","call_id":...}.
// Медиа-поток (SDP/ICE ниже) — P2P WebRTC, мимо шины; шард лишь релеит сигналинг.
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace parvane {

using nlohmann::json;

// ── исходящие сигналы (билдеры json для CallSignalPayload::signal) ─────────────
// media: "audio" | "video".
inline json inviteSignal(const std::string &callId, const std::string &media,
                         const std::string &sdp) {
    return json{{"type", "invite"}, {"call_id", callId}, {"media", media}, {"sdp", sdp}};
}
inline json answerSignal(const std::string &callId, const std::string &sdp) {
    return json{{"type", "answer"}, {"call_id", callId}, {"sdp", sdp}};
}
inline json rejectSignal(const std::string &callId,
                         const std::optional<std::string> &reason) {
    json j{{"type", "reject"}, {"call_id", callId}};
    j["reason"] = reason ? json(*reason) : json(nullptr);
    return j;
}
inline json iceSignal(const std::string &callId, const std::string &candidate) {
    return json{{"type", "ice"}, {"call_id", callId}, {"candidate", candidate}};
}
inline json hangupSignal(const std::string &callId) {
    return json{{"type", "hangup"}, {"call_id", callId}};
}

// ── входящий сигнал (разбор relay из инбокса) ─────────────────────────────────
struct CallSignalIn {
    std::string type;      // invite|answer|reject|ice|hangup
    std::string call_id;
    std::string media;     // invite
    std::string sdp;       // invite|answer
    std::string candidate; // ice
    std::optional<std::string> reason; // reject

    static CallSignalIn fromJson(const json &j) {
        CallSignalIn s;
        s.type = j.value("type", std::string());
        s.call_id = j.value("call_id", std::string());
        s.media = j.value("media", std::string());
        s.sdp = j.value("sdp", std::string());
        s.candidate = j.value("candidate", std::string());
        if (auto it = j.find("reason"); it != j.end() && !it->is_null())
            s.reason = it->get<std::string>();
        return s;
    }
};

// ── CallRecord (элемент истории) ──────────────────────────────────────────────
struct CallRecord {
    std::string call_id;
    std::string caller;
    std::string callee;
    std::string media;  // audio|video
    std::string status; // ringing|answered|ended|missed|rejected
    std::int64_t started_at = 0;
    std::optional<std::int64_t> ended_at;

    static CallRecord fromJson(const json &j) {
        CallRecord r;
        r.call_id = j.value("call_id", std::string());
        r.caller = j.value("caller", std::string());
        r.callee = j.value("callee", std::string());
        r.media = j.value("media", std::string());
        r.status = j.value("status", std::string());
        r.started_at = j.value("started_at", std::int64_t(0));
        if (auto it = j.find("ended_at"); it != j.end() && !it->is_null())
            r.ended_at = it->get<std::int64_t>();
        return r;
    }
};

// ── CallHistoryResponse (payload ответа call.history) ─────────────────────────
struct CallHistoryResponse {
    std::vector<CallRecord> calls;

    // Принимает полный конверт ParvaneEvent<CallHistoryResponse> или голый payload.
    static CallHistoryResponse fromJson(const json &j) {
        const json *payload = &j;
        if (auto it = j.find("payload"); it != j.end() && it->is_object())
            payload = &*it;
        CallHistoryResponse r;
        if (auto it = payload->find("calls"); it != payload->end() && it->is_array()) {
            r.calls.reserve(it->size());
            for (const auto &c : *it)
                r.calls.push_back(CallRecord::fromJson(c));
        }
        return r;
    }
};

} // namespace parvane
