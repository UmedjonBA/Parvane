// Parvane fork: содержимое v2 для конвейера клиента (см. v2_content.h) — смысл решает движок.
#include "parvane/v2_content.h"

#include "parvane/call.h"
#include "parvane/poll.h"
#include "parvane/v2_engine.h"

#include <openssl/evp.h>
#include <openssl/rand.h>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <random>
#include <vector>

namespace parvane::v2 {

namespace {

std::string b64encode(const std::string &bytes) {
    if (bytes.empty()) return {};
    std::string out(4 * ((bytes.size() + 2) / 3) + 1, '\0');
    const int n = EVP_EncodeBlock(reinterpret_cast<unsigned char *>(out.data()),
                                  reinterpret_cast<const unsigned char *>(bytes.data()),
                                  static_cast<int>(bytes.size()));
    out.resize(n > 0 ? static_cast<std::size_t>(n) : 0);
    return out;
}

std::optional<std::string> b64decode(const std::string &s) {
    if (s.empty() || s.size() % 4 != 0) return std::nullopt;
    std::string out(3 * s.size() / 4 + 1, '\0');
    const int n = EVP_DecodeBlock(reinterpret_cast<unsigned char *>(out.data()),
                                  reinterpret_cast<const unsigned char *>(s.data()),
                                  static_cast<int>(s.size()));
    if (n < 0) return std::nullopt;
    std::size_t len = static_cast<std::size_t>(n);
    if (s.size() >= 1 && s[s.size() - 1] == '=') --len;
    if (s.size() >= 2 && s[s.size() - 2] == '=') --len;
    out.resize(len);
    return out;
}

std::string str(const json &o, const char *k) {
    return (o.is_object() && o.contains(k) && o[k].is_string()) ? o[k].get<std::string>() : std::string();
}

} // namespace

// ── UUID ────────────────────────────────────────────────────────────────────

std::string toBase64(const std::string &bytes) { return b64encode(bytes); }

std::optional<std::string> fromBase64Safe(const std::string &b64) { return b64decode(b64); }

std::string hexToB64(const std::string &hex) {
    std::string raw;
    for (std::size_t i = 0; i + 1 < hex.size(); i += 2) {
        const auto h = hex.substr(i, 2);
        char *end = nullptr;
        const auto v = std::strtol(h.c_str(), &end, 16);
        if (!end || *end) return {};
        raw.push_back(static_cast<char>(v));
    }
    return b64encode(raw);
}

std::string b64ToHex(const std::string &b64) {
    const auto raw = b64decode(b64);
    if (!raw) return {};
    static const char *digits = "0123456789abcdef";
    std::string out;
    for (const auto ch : *raw) {
        const auto b = static_cast<unsigned char>(ch);
        out.push_back(digits[b >> 4]);
        out.push_back(digits[b & 0x0f]);
    }
    return out;
}

bool isGroupAddress(const std::string &address) {
    return address.rfind(kGroupPrefix, 0) == 0;
}

std::string groupAddress(const std::string &hex) { return std::string(kGroupPrefix) + hex; }

std::string groupHex(const std::string &address) {
    return isGroupAddress(address) ? address.substr(std::strlen(kGroupPrefix)) : std::string();
}

std::string uuidToB64(const std::string &uuid) {
    std::string hex;
    for (const char ch : uuid) {
        if (ch != '-') hex.push_back(ch);
    }
    if (hex.size() != 32) return {};
    std::string bytes;
    for (std::size_t i = 0; i < 32; i += 2) {
        bytes.push_back(static_cast<char>(std::stoi(hex.substr(i, 2), nullptr, 16)));
    }
    return b64encode(bytes);
}

namespace {

constexpr auto kReasonNormal = "HANGUP_REASON_NORMAL";
constexpr auto kReasonDeclined = "HANGUP_REASON_DECLINED";
constexpr auto kReasonBusy = "HANGUP_REASON_BUSY";
constexpr auto kReasonMissed = "HANGUP_REASON_MISSED";
constexpr auto kReasonFailed = "HANGUP_REASON_FAILED";
constexpr const char *kReasonAnsweredElsewhere = "HANGUP_REASON_ANSWERED_ELSEWHERE";

// Поле proto3-JSON: движок отдаёт camelCase, принимает и snake_case.
const json *field(const json &j, const char *camel, const char *snake) {
    if (auto it = j.find(camel); it != j.end()) return &*it;
    if (auto it = j.find(snake); it != j.end()) return &*it;
    return nullptr;
}

} // namespace

std::string fingerprintOf(const std::string &keyB64) {
    if (keyB64.empty()) return {};
    unsigned char digest[EVP_MAX_MD_SIZE];
    unsigned int len = 0;
    if (EVP_Digest(keyB64.data(), keyB64.size(), digest, &len, EVP_sha256(), nullptr) != 1) return {};
    static const char *hex = "0123456789abcdef";
    std::string out;
    for (unsigned i = 0; i < 24 && i < len; ++i) {
        if (i && i % 2 == 0) out += ' ';
        out += hex[digest[i] >> 4];
        out += hex[digest[i] & 0xF];
    }
    return out;
}

std::string cleanGroupTitle(const std::string &title) {
    // Как web cleanGroupTitle: управляющие и bidi-символы — пробелом, пробелы схлопнуты, ≤ 255 байт UTF-8
    const auto seqLen = [](unsigned char c) -> std::size_t {
        return c < 0x80 ? 1 : (c >> 5) == 6 ? 2 : (c >> 4) == 14 ? 3 : (c >> 3) == 30 ? 4 : 1;
    };
    std::string plain;
    for (std::size_t i = 0; i < title.size();) {
        const auto c = static_cast<unsigned char>(title[i]);
        auto len = seqLen(c);
        if (i + len > title.size()) len = 1;
        const auto ch = title.substr(i, len);
        bool bad = c < 0x20 || c == 0x7f;
        if (len == 2 && c == 0xC2 && static_cast<unsigned char>(ch[1]) < 0xA0) bad = true; // U+0080..U+009F
        if (len == 3 && c == 0xE2) {
            const auto b1 = static_cast<unsigned char>(ch[1]), b2 = static_cast<unsigned char>(ch[2]);
            const int cp = ((c & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
            bad = bad || cp == 0x200e || cp == 0x200f || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);
        }
        plain += bad ? std::string(" ") : ch;
        i += len;
    }
    std::string squeezed;
    for (const char ch : plain) {
        if (ch == ' ') {
            if (!squeezed.empty() && squeezed.back() != ' ') squeezed.push_back(' ');
        } else {
            squeezed.push_back(ch);
        }
    }
    while (!squeezed.empty() && squeezed.back() == ' ') squeezed.pop_back();
    std::string out;
    for (std::size_t i = 0; i < squeezed.size();) {
        const auto len = seqLen(static_cast<unsigned char>(squeezed[i]));
        if (out.size() + len > 255) break;
        out += squeezed.substr(i, len);
        i += len;
    }
    while (!out.empty() && out.back() == ' ') out.pop_back();
    return out;
}

std::optional<json> callSignalToV2(const json &v1, const std::string &groupCallId, const std::string &domain) {
    if (!v1.is_object()) return std::nullopt;
    const auto type = v1.value("type", std::string());
    if (type == "group_invite") {
        const auto id = uuidToB64(v1.value("group_call_id", std::string()));
        if (id.empty()) return std::nullopt;
        json participants = json::array();
        if (auto it = v1.find("participants"); it != v1.end() && it->is_array()) {
            for (const auto &p : *it) {
                if (p.is_string()) participants.push_back(json{{"address", p.get<std::string>()}});
            }
        }
        json ring{{"participants", participants}, {"video", v1.value("media", std::string()) == "video"}};
        // CALL-2: группа и её название — в приглашении (у адресата во входящем звонке)
        const auto group = v1.value("group", std::string());
        if (!domain.empty() && isGroupAddress(group)) ring["group"] = {{"domain", domain}, {"id", hexToB64(groupHex(group))}};
        if (const auto title = cleanGroupTitle(v1.value("title", std::string())); !title.empty()) ring["title"] = title;
        return json{{"call_id", id}, {"group_ring", ring}};
    }
    const auto callId = uuidToB64(v1.value("call_id", std::string()));
    if (callId.empty()) return std::nullopt;
    json out{{"call_id", callId}};
    if (!groupCallId.empty()) {
        const auto group = uuidToB64(groupCallId);
        if (group.empty()) return std::nullopt;
        out["group_call_id"] = group;
    }
    if (type == "invite") {
        out["offer"] = {{"sdp", v1.value("sdp", std::string())}, {"video", v1.value("media", std::string()) == "video"}};
    } else if (type == "answer") {
        out["answer"] = {{"sdp", v1.value("sdp", std::string())}};
    } else if (type == "ice") {
        const auto cand = parseIceCandidate(v1.value("candidate", std::string()));
        if (!cand) return std::nullopt;
        out["ice"] = {{"candidate", cand->sdp}, {"sdp_mid", cand->mid}, {"sdp_mline_index", cand->mlineIndex}};
    } else if (type == "reject") {
        const auto reason = v1.contains("reason") && v1["reason"].is_string() ? v1["reason"].get<std::string>() : std::string();
        out["hangup"] = {{"reason", reason == "busy" ? kReasonBusy
            : (reason == "auth_failed" || reason == "media_failed") ? kReasonFailed
            : reason == "answered_elsewhere" ? kReasonAnsweredElsewhere : kReasonDeclined}};
    } else if (type == "hangup") {
        out["hangup"] = {{"reason", kReasonNormal}};
    } else if (type == "media") {
        // spec 024: камера/микрофон выключены — собеседнику
        out["media_state"] = {{"audio_muted", v1.value("audio_muted", false)}, {"video_muted", v1.value("video_muted", false)}};
    } else {
        return std::nullopt;
    }
    return out;
}

namespace {

// Попарный сигнал внутри группового звонка: id группового звонка — в v1-JSON.
json withGroupCall(json signal, const json &v2) {
    const auto *g = field(v2, "groupCallId", "group_call_id");
    if (g && g->is_string()) {
        if (const auto id = b64ToUuid(g->get<std::string>())) signal["group_call_id"] = *id;
    }
    return signal;
}

} // namespace

std::optional<json> callSignalFromV2(const json &v2) {
    if (!v2.is_object()) return std::nullopt;
    const auto *id = field(v2, "callId", "call_id");
    const auto callId = id && id->is_string() ? b64ToUuid(id->get<std::string>()) : std::nullopt;
    if (!callId) return std::nullopt;
    if (const auto *ring = field(v2, "groupRing", "group_ring"); ring && ring->is_object()) {
        std::vector<std::string> participants;
        if (auto it = ring->find("participants"); it != ring->end() && it->is_array()) {
            for (const auto &p : *it) {
                const auto address = p.is_object() ? p.value("address", std::string()) : std::string();
                if (!address.empty()) participants.push_back(address);
            }
        }
        json invite{{"type", "group_invite"}, {"group_call_id", *callId}, {"participants", participants},
                    {"media", ring->value("video", false) ? "video" : "audio"}};
        if (auto g = ring->find("group"); g != ring->end() && g->is_object()) {
            if (const auto id = b64decode(g->value("id", std::string())); id && !id->empty() && id->size() <= 64) {
                static const char *hexd = "0123456789abcdef";
                std::string hex;
                for (const unsigned char ch : *id) {
                    hex.push_back(hexd[ch >> 4]);
                    hex.push_back(hexd[ch & 15]);
                }
                invite["group"] = groupAddress(hex);
            }
        }
        if (const auto title = cleanGroupTitle(ring->value("title", std::string())); !title.empty()) invite["title"] = title;
        return invite;
    }
    if (auto it = v2.find("offer"); it != v2.end() && it->is_object()) {
        return withGroupCall(json{{"type", "invite"}, {"call_id", *callId}, {"sdp", it->value("sdp", std::string())},
                                  {"media", it->value("video", false) ? "video" : "audio"}}, v2);
    }
    if (auto it = v2.find("answer"); it != v2.end() && it->is_object()) {
        return withGroupCall(json{{"type", "answer"}, {"call_id", *callId}, {"sdp", it->value("sdp", std::string())}}, v2);
    }
    if (auto it = v2.find("ice"); it != v2.end() && it->is_object()) {
        IceCandidate c;
        c.sdp = it->value("candidate", std::string());
        if (c.sdp.empty()) return std::nullopt;
        if (const auto *mid = field(*it, "sdpMid", "sdp_mid"); mid && mid->is_string()) c.mid = mid->get<std::string>();
        if (const auto *idx = field(*it, "sdpMlineIndex", "sdp_mline_index"); idx && idx->is_number_integer()) c.mlineIndex = idx->get<int>();
        return withGroupCall(json{{"type", "ice"}, {"call_id", *callId}, {"candidate", iceCandidateJson(c)}}, v2);
    }
    if (const auto *media = field(v2, "mediaState", "media_state"); media && media->is_object()) {
        const auto flag = [&](const char *camel, const char *snake) {
            const auto *v = field(*media, camel, snake);
            return v && v->is_boolean() && v->get<bool>();
        };
        return withGroupCall(json{{"type", "media"}, {"call_id", *callId}, {"audio_muted", flag("audioMuted", "audio_muted")},
                                  {"video_muted", flag("videoMuted", "video_muted")}}, v2);
    }
    if (auto it = v2.find("hangup"); it != v2.end() && it->is_object()) {
        std::string reason;
        if (auto r = it->find("reason"); r != it->end()) {
            if (r->is_string()) {
                reason = r->get<std::string>();
            } else if (r->is_number_integer()) {
                static const char *const kByNumber[] = {"", kReasonNormal, kReasonDeclined, kReasonBusy, kReasonMissed, kReasonFailed,
                                                        kReasonAnsweredElsewhere};
                const auto n = r->get<int>();
                if (n >= 0 && n < 7) reason = kByNumber[n];
            }
        }
        if (reason == kReasonBusy) return withGroupCall(json{{"type", "reject"}, {"call_id", *callId}, {"reason", "busy"}}, v2);
        if (reason == kReasonDeclined || reason == kReasonMissed) {
            return withGroupCall(json{{"type", "reject"}, {"call_id", *callId}, {"reason", "declined"}}, v2);
        }
        if (reason == kReasonFailed) {
            return withGroupCall(json{{"type", "reject"}, {"call_id", *callId}, {"reason", "media_failed"}}, v2);
        }
        if (reason == kReasonAnsweredElsewhere) {
            return withGroupCall(json{{"type", "reject"}, {"call_id", *callId}, {"reason", "answered_elsewhere"}}, v2);
        }
        return withGroupCall(json{{"type", "hangup"}, {"call_id", *callId}}, v2);
    }
    return std::nullopt; // ringing и неизвестное — клиенту не нужно
}

std::optional<std::string> b64ToUuid(const std::string &b64) {
    const auto bytes = b64decode(b64);
    if (!bytes || bytes->size() != 16) return std::nullopt;
    char buf[40];
    const auto *b = reinterpret_cast<const unsigned char *>(bytes->data());
    std::snprintf(buf, sizeof(buf),
                  "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
                  b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12],
                  b[13], b[14], b[15]);
    return std::string(buf);
}

json ref(const std::string &uuid) { return json{{"op_id", uuidToB64(uuid)}}; }

std::string newUuidV7() {
    unsigned char b[16];
    if (RAND_bytes(b, sizeof(b)) != 1) {
        std::random_device rd;
        for (auto &x : b) x = static_cast<unsigned char>(rd());
    }
    const auto ms = static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count());
    for (int i = 0; i < 6; ++i) b[i] = static_cast<unsigned char>((ms >> (8 * (5 - i))) & 0xff);
    b[6] = static_cast<unsigned char>((b[6] & 0x0f) | 0x70);
    b[8] = static_cast<unsigned char>((b[8] & 0x3f) | 0x80);
    char buf[40];
    std::snprintf(buf, sizeof(buf),
                  "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
                  b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12],
                  b[13], b[14], b[15]);
    return std::string(buf);
}

// ── содержимое: смысл решает движок (spec 035 T125, ENGINE-1) ─────────────────
// Класс, содержимое формата экспорта, ответ и разобранная мутация — `contentView` движка (`views.rs`), обратный
// перевод — `contentOfWire`; правила те же, что у web и android. Здесь — только перекладка JSON для конвейера
// клиента: имена полей опроса (`poll::normalize`) и срок опроса строкой у прежних черновиков.

namespace {

// Поля конверта Content (не вид содержимого).
bool isEnvelopeField(const std::string &k) {
    return k == "reply_to" || k == "replyTo" || k == "ttl_secs" || k == "ttlSecs" || k == "silent"
        || k == "invert_media" || k == "invertMedia" || k == "reply_quote" || k == "replyQuote" || k == "forward";
}

json pollForEngine(json w) {
    w = parvane::poll::normalize(std::move(w));
    if (auto it = w.find("close_ms"); it != w.end() && it->is_string()) {
        const auto v = std::atoll(it->get<std::string>().c_str());
        if (v > 0) *it = v;
        else w.erase(it);
    }
    return w;
}

} // namespace

json contentView(const json &content) {
    if (!content.is_object()) return json::object();
    try {
        auto v = engineCall("contentView", json{{"content", content}});
        return v.is_object() ? v : json::object();
    } catch (const std::exception &) {
        return json::object(); // схеме не соответствует — у вызывающего заглушка
    }
}

std::optional<json> contentOfWire(const json &wire, const std::string &replyTo) {
    if (!wire.is_object()) return std::nullopt;
    json args{{"wire", str(wire, "kind") == "poll" ? pollForEngine(wire) : wire}};
    if (!replyTo.empty()) args["replyTo"] = replyTo;
    try {
        auto c = engineCall("contentOfWire", args);
        if (c.is_object() && !c.empty()) return c;
    } catch (const std::exception &) {
    }
    return std::nullopt;
}

std::optional<json> wireOfView(const json &view) {
    const auto it = view.find("wire");
    if (it == view.end() || !it->is_object()) return std::nullopt;
    return str(*it, "kind") == "poll" ? parvane::poll::normalize(*it) : *it;
}

std::optional<json> wireOfContent(const json &content) { return wireOfView(contentView(content)); }

std::string contentKindName(const json &content) {
    if (!content.is_object()) return {};
    for (auto it = content.begin(); it != content.end(); ++it) {
        if (!it->is_null() && it->is_object() && !isEnvelopeField(it.key())) return it.key();
    }
    return {};
}

Incoming interpretDirect(const json &ev, const std::string &self) {
    Incoming in;
    const auto type = ev.is_object() ? str(ev, "type") : std::string();
    if (type != "direct" && type != "group") return in;
    in.id = str(ev, "opId");
    in.from = str(ev, "from");
    in.proof = str(ev, "proof");
    if (in.id.empty() || in.from.empty()) return in;
    if (type == "group") {
        // Группа v2: сообщение — в чат группы, автор — из проверенной подписи.
        const auto &g = ev.contains("group") ? ev["group"] : json();
        const auto hex = str(g, "id");
        if (hex.empty()) return in;
        in.group = true;
        in.chat = groupAddress(hex);
        in.to = in.chat;
    } else {
        in.chat = str(ev, "chat").empty() ? in.from : str(ev, "chat");
        in.to = (in.from == self) ? in.chat : self;
    }
    const auto tsMs = ev.contains("tsMs") && ev["tsMs"].is_number() ? ev["tsMs"].get<std::int64_t>() : 0;
    in.ts = tsMs / 1000;
    in.tsMs = tsMs;
    if (str(ev, "disposition") == "stub") {
        in.kind = Incoming::Kind::Stub;
        in.content = unsupportedContent(ev.value("critical", false));
        return in;
    }
    if (str(ev, "disposition") == "skip") return in;
    // Что содержимое значит — движок: событие несёт `view` (contentView), иначе спросить его
    const auto view = ev.contains("view") && ev["view"].is_object()
        ? ev["view"]
        : contentView(ev.contains("content") ? ev["content"] : json());
    const auto cls = str(view, "class");
    if (cls == "mutation") {
        const auto m = view.value("mutation", json::object());
        const auto kind = str(m, "kind");
        const auto targets = [&](const char *k) {
            if (m.contains(k) && m[k].is_array()) {
                for (const auto &t : m[k]) {
                    if (t.is_string() && !t.get<std::string>().empty()) in.targets.push_back(t.get<std::string>());
                }
            }
        };
        if (kind == "edit") {
            if (str(m, "target").empty()) return in;
            in.kind = Incoming::Kind::Edit;
            in.targets.push_back(str(m, "target"));
            const auto patch = m.value("patch", json::object());
            if (patch.contains("fields") && patch["fields"].is_object()) {
                in.content = patch["fields"];
            } else if (patch.contains("text")) {
                in.content = json{{"kind", "text"}};
                for (const char *k : {"text", "entities", "webpage"}) {
                    if (patch.contains(k)) in.content[k] = patch[k];
                }
            }
        } else if (kind == "delete") {
            in.kind = Incoming::Kind::Delete;
            in.forEveryone = m.value("forEveryone", false);
            targets("targets");
        } else if (kind == "reaction") {
            if (str(m, "target").empty()) return in;
            in.kind = Incoming::Kind::Reaction;
            in.targets.push_back(str(m, "target"));
            in.emoji = str(m, "emoji");
            in.remove = in.emoji.empty();
        } else if (kind == "pin") {
            if (str(m, "target").empty()) return in;
            in.kind = Incoming::Kind::Pin;
            in.targets.push_back(str(m, "target"));
            in.unpin = !m.value("pinned", true);
        } else if (kind == "receipt") {
            if (!m.value("read", false)) return in; // доставлено — не показываем
            in.kind = Incoming::Kind::Read;
            targets("targets");
        }
        return in;
    }
    // Служебные виды движка (ключи групп/доставки/состояния, звонки) — не сообщения чата.
    if (cls == "service") return in;
    if (cls == "message") {
        if (auto wire = wireOfView(view)) {
            in.kind = Incoming::Kind::Message;
            in.content = std::move(*wire);
            in.replyTo = str(view, "replyTo");
            return in;
        }
    }
    // Вид, которого клиент не знает (или пустое содержимое) — нативная заглушка.
    in.kind = Incoming::Kind::Stub;
    in.content = unsupportedContent();
    return in;
}

std::optional<ReportCheck> validateModReport(
    const json &content,
    const std::string &reporter,
    const std::function<std::vector<std::string>(const std::string &group)> &membersOf,
    const std::function<std::optional<ReportLocalMessage>(const std::string &opId)> &lookup,
    const ProofVerifier &verifyProof) {
    constexpr std::size_t kMaxMessages = 50;
    constexpr std::size_t kMaxText = 1000;
    if (!content.is_object() || content.value("kind", std::string()) != "mod_report" || reporter.empty()) {
        return std::nullopt;
    }
    const auto group = content.contains("report_group") && content["report_group"].is_object()
        ? content["report_group"] : json::object();
    const auto id = group.contains("id") && group["id"].is_string() ? group["id"].get<std::string>() : std::string();
    const auto hex = b64ToHex(id);
    if (hex.size() != 32) {
        return std::nullopt;
    }
    ReportCheck out;
    out.group = groupAddress(hex);
    const auto members = membersOf ? membersOf(out.group) : std::vector<std::string>();
    if (std::find(members.begin(), members.end(), reporter) == members.end()) {
        return std::nullopt;
    }
    if (!content.contains("reported") || !content["reported"].is_array() || !lookup) {
        return std::nullopt;
    }
    auto texts = std::vector<std::string>();
    for (const auto &m : content["reported"]) {
        if (out.opIds.size() >= kMaxMessages) break;
        if (!m.is_object() || !m.contains("op_id") || !m["op_id"].is_string()) continue;
        const auto op = m["op_id"].get<std::string>();
        if (op.empty() || std::find(out.opIds.begin(), out.opIds.end(), op) != out.opIds.end()) continue;
        const auto local = lookup(op);
        if (!local && verifyProof && m.contains("author") && m["author"].is_string()) {
            // Нет в своей истории (A0008-2): подпись автора из жалобы; автор — участник группы
            const auto author = m["author"].get<std::string>();
            const auto text = str(m, "text");
            if (!author.empty() && std::find(members.begin(), members.end(), author) != members.end()
                && verifyProof(op, author, text == "[media]" ? std::string() : text, hex, str(m, "proof"))) {
                out.opIds.push_back(op);
                out.provenOpIds.push_back(op);
                if (std::find(out.authors.begin(), out.authors.end(), author) == out.authors.end()) {
                    out.authors.push_back(author);
                }
                texts.push_back(text.empty() ? std::string("[media]") : text);
                continue;
            }
        }
        if (!local || local->chat != out.group || local->author.empty()) continue;
        out.opIds.push_back(op);
        if (std::find(out.authors.begin(), out.authors.end(), local->author) == out.authors.end()) {
            out.authors.push_back(local->author);
        }
        texts.push_back(local->text.empty() ? std::string("[media]") : local->text);
    }
    if (out.opIds.empty()) {
        return std::nullopt;
    }
    out.text = "\xE2\x9A\xA0\xEF\xB8\x8F "; // ⚠️
    for (std::size_t i = 0; i != texts.size(); ++i) {
        if (i) out.text += " / ";
        out.text += texts[i];
    }
    if (out.text.size() > kMaxText) {
        auto cut = kMaxText;
        while (cut > 0 && (static_cast<unsigned char>(out.text[cut]) & 0xC0) == 0x80) --cut; // граница UTF-8
        out.text.resize(cut);
        out.text += "\xE2\x80\xA6"; // …
    }
    return out;
}

bool verifyMessageProof(const std::string &opId, const std::string &author, const std::string &text,
                        const std::string &groupHex, const std::string &proofB64) {
    if (proofB64.empty()) return false;
    try {
        const auto verdict = engineCall("verifyMessageProof", json{{"proof", proofB64}, {"opId", opId}, {"author", author},
                                                                    {"text", text}, {"groupHex", groupHex}});
        return verdict.is_object() && verdict.value("ok", false);
    } catch (const std::exception &) {
        return false;
    }
}

} // namespace parvane::v2
