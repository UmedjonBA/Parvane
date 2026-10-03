// Parvane fork: отображение содержимого v2 ↔ v1 (см. v2_content.h).
#include "parvane/v2_content.h"

#include "parvane/call.h"
#include "parvane/poll.h"

#include <openssl/evp.h>
#include <openssl/rand.h>

#include <chrono>
#include <cmath>
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

bool has(const json &o, const char *k) {
    return o.is_object() && o.contains(k) && !o[k].is_null();
}

// ── entities ────────────────────────────────────────────────────────────────

const std::vector<std::pair<const char *, const char *>> &entityNames() {
    static const std::vector<std::pair<const char *, const char *>> names = {
        {"bold", "ENTITY_TYPE_BOLD"},
        {"italic", "ENTITY_TYPE_ITALIC"},
        {"underline", "ENTITY_TYPE_UNDERLINE"},
        {"strike", "ENTITY_TYPE_STRIKE"},
        {"spoiler", "ENTITY_TYPE_SPOILER"},
        {"code", "ENTITY_TYPE_CODE"},
        {"pre", "ENTITY_TYPE_PRE"},
        {"text_url", "ENTITY_TYPE_TEXT_URL"},
        {"url", "ENTITY_TYPE_URL"},
        {"mention", "ENTITY_TYPE_MENTION"},
        {"blockquote", "ENTITY_TYPE_BLOCKQUOTE"},
        {"custom_emoji", "ENTITY_TYPE_CUSTOM_EMOJI"},
    };
    return names;
}

json entitiesToV2(const json &list) {
    auto out = json::array();
    if (!list.is_array()) return out;
    for (const auto &e : list) {
        if (!e.is_object()) continue;
        const auto type = str(e, "type");
        const char *v2 = nullptr;
        for (const auto &[a, b] : entityNames()) {
            if (type == a) v2 = b;
        }
        if (!v2) continue;
        json o{{"type", v2}, {"offset", e.value("offset", 0)}, {"length", e.value("length", 0)}};
        const auto data = str(e, "data");
        if (type == "text_url" && !data.empty()) o["url"] = data;
        if (type == "pre" && !data.empty()) o["language"] = data;
        if (type == "custom_emoji" && !data.empty()) o["custom_emoji_id"] = data;
        out.push_back(std::move(o));
    }
    return out;
}

json entitiesFromV2(const json &list) {
    auto out = json::array();
    if (!list.is_array()) return out;
    for (const auto &e : list) {
        if (!e.is_object()) continue;
        const auto type = str(e, "type");
        const char *v1 = nullptr;
        for (const auto &[a, b] : entityNames()) {
            if (type == b) v1 = a;
        }
        if (!v1) continue;
        json o{{"type", v1}, {"offset", e.value("offset", 0)}, {"length", e.value("length", 0)}};
        auto data = str(e, "url");
        if (data.empty()) data = str(e, "language");
        if (data.empty()) data = str(e, "custom_emoji_id");
        if (!data.empty()) o["data"] = data;
        out.push_back(std::move(o));
    }
    return out;
}

json packToV2(const json &p) {
    json o = json::object();
    if (!p.is_object()) return o;
    if (has(p, "file_id")) o["file_id"] = str(p, "file_id");
    if (has(p, "name")) o["name"] = str(p, "name");
    if (p.contains("count") && p["count"].is_number()) o["count"] = p["count"];
    if (has(p, "key")) o["key"] = str(p, "key");
    if (has(p, "nonce")) o["nonce"] = str(p, "nonce");
    if (has(p, "capability")) o["capability"] = str(p, "capability");
    return o;
}

std::optional<json> packFromV2(const json &p) {
    if (str(p, "file_id").empty()) return std::nullopt;
    json out{{"file_id", str(p, "file_id")}, {"name", str(p, "name")},
             {"count", p.value("count", 0)}, {"key", str(p, "key")}, {"nonce", str(p, "nonce")}};
    if (!str(p, "capability").empty()) out["capability"] = str(p, "capability");
    return out;
}

// ── медиа ───────────────────────────────────────────────────────────────────

const char *mediaKindToV2(const std::string &kind, const std::string &mime) {
    if (kind == "file" && mime.rfind("audio/", 0) == 0) return "MEDIA_KIND_AUDIO";
    if (kind == "photo") return "MEDIA_KIND_PHOTO";
    if (kind == "video") return "MEDIA_KIND_VIDEO";
    if (kind == "voice") return "MEDIA_KIND_VOICE";
    if (kind == "video_note") return "MEDIA_KIND_VIDEO_NOTE";
    if (kind == "gif") return "MEDIA_KIND_ANIMATION";
    return "MEDIA_KIND_FILE";
}

std::string mediaKindFromV2(const std::string &kind) {
    if (kind == "MEDIA_KIND_PHOTO") return "photo";
    if (kind == "MEDIA_KIND_VIDEO") return "video";
    if (kind == "MEDIA_KIND_VOICE") return "voice";
    if (kind == "MEDIA_KIND_VIDEO_NOTE") return "video_note";
    if (kind == "MEDIA_KIND_ANIMATION") return "gif";
    return "file";
}

json mediaToV2(const json &c, const std::string &kind) {
    const auto mime = str(c, "mime");
    json m{{"kind", mediaKindToV2(kind, mime)}};
    if (has(c, "file_id")) m["file_id"] = str(c, "file_id");
    if (!mime.empty()) m["mime"] = mime;
    if (c.contains("size_bytes") && c["size_bytes"].is_number()) {
        m["size"] = std::to_string(c["size_bytes"].get<std::uint64_t>());
    }
    if (c.contains("duration_secs") && c["duration_secs"].is_number()) {
        m["duration_ms"] = static_cast<std::uint32_t>(std::llround(c["duration_secs"].get<double>() * 1000));
    }
    if (c.contains("width") && c["width"].is_number()) m["width"] = c["width"];
    if (c.contains("height") && c["height"].is_number()) m["height"] = c["height"];
    if (c.contains("waveform") && c["waveform"].is_array() && !c["waveform"].empty()) {
        std::string bytes;
        for (const auto &x : c["waveform"]) {
            const int v = x.is_number() ? x.get<int>() : 0;
            bytes.push_back(static_cast<char>(v < 0 ? 0 : (v > 255 ? 255 : v)));
        }
        m["waveform"] = b64encode(bytes);
    }
    if (has(c, "file_key")) m["file_key"] = str(c, "file_key");
    if (has(c, "file_nonce")) m["file_nonce"] = str(c, "file_nonce");
    // Секрет скачивания блоба (T131, D-08): только в E2E-содержимом v2-чата.
    if (has(c, "capability")) m["capability"] = str(c, "capability");
    if (has(c, "filename")) m["name"] = str(c, "filename");
    if (!str(c, "caption").empty()) m["caption"] = str(c, "caption");
    if (c.contains("entities") && c["entities"].is_array() && !c["entities"].empty()) {
        auto e = entitiesToV2(c["entities"]);
        if (!e.empty()) m["caption_entities"] = e;
    }
    if (!str(c, "audio_title").empty()) m["title"] = str(c, "audio_title");
    if (!str(c, "audio_performer").empty()) m["performer"] = str(c, "audio_performer");
    return m;
}

json mediaFromV2(const json &m) {
    json c{{"kind", mediaKindFromV2(str(m, "kind"))}};
    if (!str(m, "file_id").empty()) c["file_id"] = str(m, "file_id");
    if (!str(m, "mime").empty()) c["mime"] = str(m, "mime");
    if (m.contains("size")) {
        const auto &s = m["size"];
        if (s.is_string()) {
            try {
                c["size_bytes"] = std::stoull(s.get<std::string>());
            } catch (const std::exception &) {
            }
        } else if (s.is_number()) {
            c["size_bytes"] = s.get<std::uint64_t>();
        }
    }
    if (m.contains("duration_ms") && m["duration_ms"].is_number()) {
        const auto ms = m["duration_ms"].get<std::uint64_t>();
        if (ms > 0) c["duration_secs"] = std::max<std::uint64_t>(1, (ms + 500) / 1000);
    }
    if (m.contains("width") && m["width"].is_number()) c["width"] = m["width"];
    if (m.contains("height") && m["height"].is_number()) c["height"] = m["height"];
    if (const auto w = str(m, "waveform"); !w.empty()) {
        if (const auto bytes = b64decode(w)) {
            auto arr = json::array();
            for (const unsigned char b : *bytes) arr.push_back(int(b));
            c["waveform"] = arr;
        }
    }
    if (!str(m, "file_key").empty()) c["file_key"] = str(m, "file_key");
    if (!str(m, "file_nonce").empty()) c["file_nonce"] = str(m, "file_nonce");
    if (!str(m, "capability").empty()) c["capability"] = str(m, "capability");
    if (!str(m, "name").empty()) c["filename"] = str(m, "name");
    if (!str(m, "caption").empty()) c["caption"] = str(m, "caption");
    if (m.contains("caption_entities")) {
        auto e = entitiesFromV2(m["caption_entities"]);
        if (!e.empty()) c["entities"] = e;
    }
    if (!str(m, "title").empty()) c["audio_title"] = str(m, "title");
    if (!str(m, "performer").empty()) c["audio_performer"] = str(m, "performer");
    return c;
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

// Поле proto3-JSON: движок отдаёт camelCase, принимает и snake_case.
const json *field(const json &j, const char *camel, const char *snake) {
    if (auto it = j.find(camel); it != j.end()) return &*it;
    if (auto it = j.find(snake); it != j.end()) return &*it;
    return nullptr;
}

} // namespace

std::optional<json> callSignalToV2(const json &v1, const std::string &groupCallId) {
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
        return json{{"call_id", id},
                    {"group_ring", {{"participants", participants},
                                    {"video", v1.value("media", std::string()) == "video"}}}};
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
            : (reason == "auth_failed" || reason == "media_failed") ? kReasonFailed : kReasonDeclined}};
    } else if (type == "hangup") {
        out["hangup"] = {{"reason", kReasonNormal}};
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
        return json{{"type", "group_invite"}, {"group_call_id", *callId}, {"participants", participants},
                    {"media", ring->value("video", false) ? "video" : "audio"}};
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
    if (auto it = v2.find("hangup"); it != v2.end() && it->is_object()) {
        std::string reason;
        if (auto r = it->find("reason"); r != it->end()) {
            if (r->is_string()) {
                reason = r->get<std::string>();
            } else if (r->is_number_integer()) {
                static const char *const kByNumber[] = {"", kReasonNormal, kReasonDeclined, kReasonBusy, kReasonMissed, kReasonFailed};
                const auto n = r->get<int>();
                if (n >= 0 && n < 6) reason = kByNumber[n];
            }
        }
        if (reason == kReasonBusy) return withGroupCall(json{{"type", "reject"}, {"call_id", *callId}, {"reason", "busy"}}, v2);
        if (reason == kReasonDeclined || reason == kReasonMissed) {
            return withGroupCall(json{{"type", "reject"}, {"call_id", *callId}, {"reason", "declined"}}, v2);
        }
        if (reason == kReasonFailed) {
            return withGroupCall(json{{"type", "reject"}, {"call_id", *callId}, {"reason", "media_failed"}}, v2);
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

std::string v2Kind(const json &v2) {
    static const char *kinds[] = {"text", "media", "sticker", "location", "poll", "poll_vote",
                                  "poll_close", "receipt", "edit", "delete", "reaction", "pin",
                                  "call", "group_key", "delivery_key", "contact", "container_key",
                                  "state_key", "chat_mode"};
    if (!v2.is_object()) return {};
    for (const char *k : kinds) {
        if (v2.contains(k) && !v2[k].is_null()) return k;
    }
    return {};
}

// ── содержимое ─────────────────────────────────────────────────────────────

std::optional<json> toV2(const json &v1In, const std::string &replyTo) {
    if (!v1In.is_object()) return std::nullopt;
    const auto kind = str(v1In, "kind");
    const auto c = (kind == "poll") ? parvane::poll::normalize(v1In) : v1In;
    json out = json::object();
    if (kind == "text") {
        json t{{"text", str(c, "text")}};
        if (c.contains("entities")) {
            auto e = entitiesToV2(c["entities"]);
            if (!e.empty()) t["entities"] = e;
        }
        if (c.contains("webpage") && c["webpage"].is_object() && has(c["webpage"], "url")) {
            const auto &w = c["webpage"];
            json p{{"url", str(w, "url")}};
            if (!str(w, "site_name").empty()) p["site_name"] = str(w, "site_name");
            if (!str(w, "title").empty()) p["title"] = str(w, "title");
            if (!str(w, "description").empty()) p["description"] = str(w, "description");
            t["preview"] = p;
        }
        if (c.contains("emoji_packs") && c["emoji_packs"].is_array() && !c["emoji_packs"].empty()) {
            auto packs = json::array();
            for (const auto &p : c["emoji_packs"]) packs.push_back(packToV2(p));
            t["emoji_packs"] = packs;
        }
        out["text"] = t;
    } else if (kind == "photo" || kind == "video" || kind == "voice" || kind == "video_note"
               || kind == "gif" || kind == "file") {
        out["media"] = mediaToV2(c, kind);
    } else if (kind == "sticker") {
        auto media = mediaToV2(c, "photo");
        media.erase("caption");
        json s{{"media", media}};
        if (c.contains("pack_ref") && c["pack_ref"].is_object()) {
            s["pack_ref"] = packToV2(c["pack_ref"]);
            if (!str(c["pack_ref"], "name").empty()) s["pack"] = str(c["pack_ref"], "name");
        }
        if (has(c, "file_id")) s["sticker_id"] = str(c, "file_id");
        if (!str(c, "filename").empty()) s["emoji"] = str(c, "filename");
        out["sticker"] = s;
    } else if (kind == "location") {
        json l = json::object();
        if (c.contains("lat") && c["lat"].is_number()) l["latitude"] = c["lat"];
        if (c.contains("long") && c["long"].is_number()) l["longitude"] = c["long"];
        if (c.contains("live_period") && c["live_period"].is_number()) l["live_period_s"] = c["live_period"];
        if (c.contains("heading") && c["heading"].is_number()) l["heading"] = c["heading"];
        if (c.contains("accuracy") && c["accuracy"].is_number()) l["accuracy_m"] = c["accuracy"];
        out["location"] = l;
    } else if (kind == "poll") {
        json p{{"question", str(c, "question")}};
        auto options = json::array();
        if (c.contains("options") && c["options"].is_array()) {
            for (const auto &o : c["options"]) {
                if (o.is_string()) options.push_back(json{{"text", o.get<std::string>()}});
                else if (o.is_object()) options.push_back(json{{"text", str(o, "text")}});
            }
        }
        p["options"] = options;
        if (c.value("is_public", false)) p["is_public"] = true;
        if (c.value("is_multiple", false)) p["is_multiple"] = true;
        if (c.value("is_quiz", false)) p["is_quiz"] = true;
        if (c.contains("correct") && c["correct"].is_array()) p["correct"] = c["correct"];
        if (!str(c, "solution").empty()) p["solution"] = str(c, "solution");
        out["poll"] = p;
    } else if (kind == "poll_vote") {
        json v{{"option_indexes", c.contains("options") && c["options"].is_array() ? c["options"] : json::array()}};
        if (!str(c, "poll").empty()) v["poll"] = ::parvane::v2::ref(str(c, "poll"));
        out["poll_vote"] = v;
    } else if (kind == "poll_close") {
        json v = json::object();
        if (!str(c, "poll").empty()) v["poll"] = ::parvane::v2::ref(str(c, "poll"));
        out["poll_close"] = v;
    } else {
        return std::nullopt;
    }
    if (c.contains("ttl_secs") && c["ttl_secs"].is_number() && c["ttl_secs"].get<int>() > 0) {
        out["ttl_secs"] = c["ttl_secs"];
    }
    if (!replyTo.empty()) out["reply_to"] = ref(replyTo);
    if (!str(c, "forwarded_from").empty() || !str(c, "forwarded_name").empty()) {
        json f = json::object();
        if (!str(c, "forwarded_from").empty()) f["from_user"] = json{{"address", str(c, "forwarded_from")}};
        if (!str(c, "forwarded_name").empty()) f["from_name"] = str(c, "forwarded_name");
        out["forward"] = f;
    }
    return out;
}

std::optional<json> fromV2(const json &c) {
    if (!c.is_object()) return std::nullopt;
    json out;
    if (c.contains("text") && c["text"].is_object()) {
        const auto &t = c["text"];
        out = json{{"kind", "text"}, {"text", str(t, "text")}};
        if (t.contains("entities")) {
            auto e = entitiesFromV2(t["entities"]);
            if (!e.empty()) out["entities"] = e;
        }
        if (t.contains("preview") && t["preview"].is_object() && !str(t["preview"], "url").empty()) {
            const auto &p = t["preview"];
            json w{{"url", str(p, "url")}};
            for (const char *k : {"site_name", "title", "description"}) {
                if (!str(p, k).empty()) w[k] = str(p, k);
            }
            out["webpage"] = w;
        }
        if (t.contains("emoji_packs") && t["emoji_packs"].is_array()) {
            auto packs = json::array();
            for (const auto &p : t["emoji_packs"]) {
                if (auto v = packFromV2(p)) packs.push_back(*v);
            }
            if (!packs.empty()) out["emoji_packs"] = packs;
        }
    } else if (c.contains("media") && c["media"].is_object()) {
        out = mediaFromV2(c["media"]);
    } else if (c.contains("sticker") && c["sticker"].is_object()) {
        const auto &s = c["sticker"];
        out = s.contains("media") && s["media"].is_object() ? mediaFromV2(s["media"]) : json{{"kind", "photo"}};
        out["kind"] = "sticker";
        if (!str(s, "emoji").empty()) out["filename"] = str(s, "emoji");
        if (s.contains("pack_ref")) {
            if (auto p = packFromV2(s["pack_ref"])) out["pack_ref"] = *p;
        }
    } else if (c.contains("location") && c["location"].is_object()) {
        const auto &l = c["location"];
        out = json{{"kind", "location"}, {"lat", l.value("latitude", 0.0)}, {"long", l.value("longitude", 0.0)}};
        if (l.value("live_period_s", 0) > 0) out["live_period"] = l["live_period_s"];
        if (l.value("heading", 0) > 0) out["heading"] = l["heading"];
        if (l.value("accuracy_m", 0) > 0) out["accuracy"] = l["accuracy_m"];
    } else if (c.contains("poll") && c["poll"].is_object()) {
        const auto &p = c["poll"];
        auto options = json::array();
        if (p.contains("options") && p["options"].is_array()) {
            for (const auto &o : p["options"]) options.push_back(str(o, "text"));
        }
        out = json{{"kind", "poll"}, {"question", str(p, "question")}, {"options", options}};
        if (p.value("is_public", false)) out["is_public"] = true;
        if (p.value("is_multiple", false)) out["is_multiple"] = true;
        if (p.value("is_quiz", false)) out["is_quiz"] = true;
        if (p.contains("correct") && p["correct"].is_array()) out["correct"] = p["correct"];
        if (!str(p, "solution").empty()) out["solution"] = str(p, "solution");
        out = parvane::poll::normalize(out);
    } else if (c.contains("poll_vote") && c["poll_vote"].is_object()) {
        const auto &v = c["poll_vote"];
        out = json{{"kind", "poll_vote"},
                   {"options", v.contains("option_indexes") && v["option_indexes"].is_array()
                                   ? v["option_indexes"] : json::array()}};
        if (v.contains("poll")) {
            if (auto u = b64ToUuid(str(v["poll"], "op_id"))) out["poll"] = *u;
        }
    } else if (c.contains("poll_close") && c["poll_close"].is_object()) {
        out = json{{"kind", "poll_close"}};
        if (c["poll_close"].contains("poll")) {
            if (auto u = b64ToUuid(str(c["poll_close"]["poll"], "op_id"))) out["poll"] = *u;
        }
    } else if (c.contains("chat_mode") && c["chat_mode"].is_object()) {
        // Режим L2 личного чата: видимое служебное сообщение (без ttl/пересылки).
        return chatModeContent(c["chat_mode"].value("l2", false));
    } else {
        return std::nullopt;
    }
    if (c.contains("ttl_secs") && c["ttl_secs"].is_number() && c["ttl_secs"].get<int>() > 0) {
        out["ttl_secs"] = c["ttl_secs"];
    }
    if (c.contains("forward") && c["forward"].is_object()) {
        const auto &f = c["forward"];
        if (f.contains("from_user") && !str(f["from_user"], "address").empty()) {
            out["forwarded_from"] = str(f["from_user"], "address");
        }
        if (!str(f, "from_name").empty()) out["forwarded_name"] = str(f, "from_name");
    }
    return out;
}

Incoming interpretDirect(const json &ev, const std::string &self) {
    Incoming in;
    const auto type = ev.is_object() ? str(ev, "type") : std::string();
    if (type != "direct" && type != "group") return in;
    in.id = str(ev, "opId");
    in.from = str(ev, "from");
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
    if (str(ev, "disposition") == "stub") {
        in.kind = Incoming::Kind::Stub;
        in.content = unsupportedContent();
        return in;
    }
    if (str(ev, "disposition") == "skip") return in;
    const auto &c = ev.contains("content") ? ev["content"] : json();
    const auto kind = v2Kind(c);
    const auto target = [&](const json &r) -> std::string {
        return r.is_object() ? b64ToUuid(str(r, "op_id")).value_or(std::string()) : std::string();
    };
    if (kind == "edit") {
        const auto &e = c["edit"];
        const auto t = target(e.contains("target") ? e["target"] : json());
        if (t.empty()) return in;
        in.kind = Incoming::Kind::Edit;
        in.targets.push_back(t);
        if (e.contains("location") && e["location"].is_object()) {
            in.content = fromV2(json{{"location", e["location"]}}).value_or(json());
        } else if (e.contains("text") && e["text"].is_object()) {
            in.content = fromV2(json{{"text", e["text"]}}).value_or(json());
        }
        return in;
    }
    if (kind == "delete") {
        in.kind = Incoming::Kind::Delete;
        if (c["delete"].contains("targets") && c["delete"]["targets"].is_array()) {
            for (const auto &r : c["delete"]["targets"]) {
                if (auto t = target(r); !t.empty()) in.targets.push_back(t);
            }
        }
        return in;
    }
    if (kind == "reaction") {
        const auto &r = c["reaction"];
        const auto t = target(r.contains("target") ? r["target"] : json());
        if (t.empty()) return in;
        in.kind = Incoming::Kind::Reaction;
        in.targets.push_back(t);
        in.emoji = str(r, "emoji");
        in.remove = r.value("remove", false) || in.emoji.empty();
        return in;
    }
    if (kind == "pin") {
        const auto &r = c["pin"];
        const auto t = target(r.contains("target") ? r["target"] : json());
        if (t.empty()) return in;
        in.kind = Incoming::Kind::Pin;
        in.targets.push_back(t);
        in.unpin = r.value("unpin", false);
        return in;
    }
    if (kind == "receipt") {
        const auto &r = c["receipt"];
        if (str(r, "kind") != "RECEIPT_KIND_READ") return in; // доставлено — не показываем
        in.kind = Incoming::Kind::Read;
        if (r.contains("messages") && r["messages"].is_array()) {
            for (const auto &m : r["messages"]) {
                if (auto t = target(m); !t.empty()) in.targets.push_back(t);
            }
        }
        return in;
    }
    // Служебные виды движка (ключи групп/доставки/состояния, звонки) — не
    // сообщения чата.
    if (kind == "group_key" || kind == "delivery_key" || kind == "container_key"
        || kind == "state_key" || kind == "call") {
        return in;
    }
    if (auto v1 = fromV2(c)) {
        in.kind = Incoming::Kind::Message;
        in.content = std::move(*v1);
        if (c.contains("reply_to")) in.replyTo = target(c["reply_to"]);
        return in;
    }
    // Вид, которого клиент не знает (или пустое содержимое) — нативная заглушка.
    in.kind = Incoming::Kind::Stub;
    in.content = unsupportedContent();
    return in;
}

} // namespace parvane::v2
