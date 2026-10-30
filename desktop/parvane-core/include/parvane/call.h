// Parvane fork: C++-зеркало call-пейлоадов из backend/shared/parvane-types/src/lib.rs.
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
// sdp) приватным ключом отправителя. Пустое значение допустимо только для
// построения негативных тест-векторов: call-шард такой сигнал отклонит.
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
// CALL-1: ICE-кандидат в поле `candidate` сигнала — JSON-строка. Канонические
// поля — `candidate`, `sdp_mid`, `sdp_mline_index`; для уже выпущенных клиентов
// рядом кладутся прежние имена: web (RTCIceCandidateInit: `sdpMid`,
// `sdpMLineIndex`) и desktop (`sdp`, `mid`, `idx`). До 2 окт 2026 web и desktop
// писали каждый свой формат и чужих кандидатов не понимали — звонок между ними
// не соединялся.
struct IceCandidate {
    std::string sdp; // строка кандидата ("candidate:…")
    std::string mid;
    int mlineIndex = 0;
};
inline std::string iceCandidateJson(const IceCandidate &c) {
    return json{{"candidate", c.sdp}, {"sdp_mid", c.mid}, {"sdp_mline_index", c.mlineIndex},
                {"sdpMid", c.mid}, {"sdpMLineIndex", c.mlineIndex},
                {"sdp", c.sdp}, {"mid", c.mid}, {"idx", c.mlineIndex}}.dump();
}
// Разбор любого из трёх видов; nullopt — не JSON-объект или нет строки кандидата
// (пустой кандидат «конец сбора» клиенты не шлют).
inline std::optional<IceCandidate> parseIceCandidate(const std::string &raw) {
    const auto j = json::parse(raw, nullptr, false);
    if (!j.is_object()) return std::nullopt;
    const auto str = [&](std::initializer_list<const char *> keys) {
        for (const auto *k : keys) {
            if (j.contains(k) && j[k].is_string()) return j[k].get<std::string>();
        }
        return std::string();
    };
    IceCandidate out;
    out.sdp = str({"candidate", "sdp"});
    if (out.sdp.empty()) return std::nullopt;
    out.mid = str({"sdp_mid", "sdpMid", "mid"});
    for (const auto *k : {"sdp_mline_index", "sdpMLineIndex", "idx"}) {
        if (j.contains(k) && j[k].is_number_integer()) {
            out.mlineIndex = j[k].get<int>();
            break;
        }
    }
    return out;
}
inline json hangupSignal(const std::string &callId) {
    return json{{"type", "hangup"}, {"call_id", callId}};
}

// Приглашение в ГРУППОВОЙ звонок: id звонка + полный список участников. Каждый
// участник, получив его, строит mesh — 1-на-1 соединение с каждым другим
// (оффер инициирует тот, чей адрес лексикографически меньше). media audio|video.
// group — адрес группы v2 ("v2g:<hex>"), title — её название (CALL-2: у адресата во входящем звонке).
inline json groupInviteSignal(const std::string &groupCallId,
                              const std::vector<std::string> &participants,
                              const std::string &media = "audio",
                              const std::string &group = std::string(),
                              const std::string &title = std::string()) {
    json out{{"type", "group_invite"}, {"group_call_id", groupCallId},
             {"participants", participants}, {"media", media}};
    if (!group.empty()) out["group"] = group;
    if (!title.empty()) out["title"] = title;
    return out;
}

// spec 024: камера/микрофон выключены — собеседнику (сигнал `media`).
inline json mediaStateSignal(const std::string &callId, bool audioMuted, bool videoMuted) {
    return json{{"type", "media"}, {"call_id", callId}, {"audio_muted", audioMuted}, {"video_muted", videoMuted}};
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
    std::string group;                      // group_invite: адрес группы (CALL-2)
    std::string title;                      // group_invite: название группы
    bool audio_muted = false;               // media (spec 024)
    bool video_muted = false;               // media
    // Сигнал пришёл по протоколу v2: отправителя, аудиторию и привязку к звонку
    // проверил движок — подпись SDP ключом звонков (`sig`) не требуется. Из JSON
    // НЕ читается (fromJson), выставляет только CallManager::handleV2Signal.
    bool authenticated = false;

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
        if (auto it = j.find("reason"); it != j.end() && it->is_string())
            s.reason = it->get<std::string>();
        s.group = j.value("group", std::string());
        s.title = j.value("title", std::string());
        s.audio_muted = j.value("audio_muted", false);
        s.video_muted = j.value("video_muted", false);
        return s;
    }

    // Байты, над которыми должна проверяться подпись `sig` (см. callSignedData).
    [[nodiscard]] std::string signedData() const {
        return callSignedData(call_id, sdp);
    }
};

} // namespace parvane
