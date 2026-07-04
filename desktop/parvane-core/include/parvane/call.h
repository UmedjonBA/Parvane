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

// Канонические байты, которые подписываются ключом идентичности отправителя в
// invite/answer: call_id и SDP склеены через '\n'. SDP несёт DTLS-отпечаток —
// подпись над ним не даёт скомпрометированному шарду подменить отпечаток (MITM).
// call_id связывает подпись с конкретным звонком (защита от replay). Signer и
// verifier ОБЯЗАНЫ строить эту строку одинаково. См. desktop/CALLS-parvane.md.
inline std::string callSignedData(const std::string &callId, const std::string &sdp) {
    return callId + "\n" + sdp;
}

// ── исходящие сигналы (билдеры json для CallSignalPayload::signal) ─────────────
// media: "audio" | "video". sig — base64 Ed25519-подпись callSignedData(callId,
// sdp) приватным ключом отправителя (пусто = без подписи, напр. в тестах/legacy).
inline json inviteSignal(const std::string &callId, const std::string &media,
                         const std::string &sdp, const std::string &sig = "") {
    json j{{"type", "invite"}, {"call_id", callId}, {"media", media}, {"sdp", sdp}};
    if (!sig.empty()) j["sig"] = sig;
    return j;
}
inline json answerSignal(const std::string &callId, const std::string &sdp,
                         const std::string &sig = "") {
    json j{{"type", "answer"}, {"call_id", callId}, {"sdp", sdp}};
    if (!sig.empty()) j["sig"] = sig;
    return j;
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

// Приглашение в ГРУППОВОЙ звонок: id звонка + полный список участников. Каждый
// участник, получив его, строит mesh — 1-на-1 соединение с каждым другим
// (оффер инициирует тот, чей адрес лексикографически меньше). media audio|video.
inline json groupInviteSignal(const std::string &groupCallId,
                              const std::vector<std::string> &participants,
                              const std::string &media = "audio") {
    return json{{"type", "group_invite"}, {"group_call_id", groupCallId},
                {"participants", participants}, {"media", media}};
}

// ── входящий сигнал (разбор relay из инбокса) ─────────────────────────────────
struct CallSignalIn {
    std::string type;      // invite|answer|reject|ice|hangup
    std::string call_id;
    std::string media;     // invite
    std::string sdp;       // invite|answer
    std::string sig;       // invite|answer — base64 Ed25519-подпись SDP (может быть пустой)
    std::string candidate; // ice
    std::optional<std::string> reason; // reject
    std::string group_call_id;              // group_invite
    std::vector<std::string> participants;  // group_invite

    static CallSignalIn fromJson(const json &j) {
        CallSignalIn s;
        s.type = j.value("type", std::string());
        s.call_id = j.value("call_id", std::string());
        s.media = j.value("media", std::string());
        s.sdp = j.value("sdp", std::string());
        s.sig = j.value("sig", std::string());
        s.candidate = j.value("candidate", std::string());
        s.group_call_id = j.value("group_call_id", std::string());
        if (auto it = j.find("participants"); it != j.end() && it->is_array()) {
            for (const auto &p : *it)
                if (p.is_string()) s.participants.push_back(p.get<std::string>());
        }
        if (auto it = j.find("reason"); it != j.end() && !it->is_null())
            s.reason = it->get<std::string>();
        return s;
    }

    // Байты, над которыми должна проверяться подпись `sig` (см. callSignedData).
    [[nodiscard]] std::string signedData() const {
        return callSignedData(call_id, sdp);
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
