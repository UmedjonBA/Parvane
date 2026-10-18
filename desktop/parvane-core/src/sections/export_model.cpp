// Parvane fork (spec 029, фаза 4): порт web `components/parvane/export/exportModel.ts` и чистой части
// `exportRun.ts` (пути облака, сборка архива из источника).
#include "parvane/sections/export_model.h"

#include <charconv>
#include <cmath>
#include <cstdio>
#include <map>

#include "unicode_lite.h"

namespace parvane::sections::exportdata {

namespace u = parvane::sections::unicode_lite;
using nlohmann::json;
using ojson = nlohmann::ordered_json;

namespace {

const std::set<std::string> kMediaKinds = {"photo", "video", "video_note", "voice", "file", "gif"};
// Служебные строки протокола, которые читателю не нужны
const std::set<std::string> kSkippedKinds = {"poll_vote", "poll_close", "encrypted", "group_encrypted", "token"};
constexpr size_t kFileNameMax = 80;

const std::map<std::string, std::string> kExtByMime = {
    {"image/jpeg", ".jpg"}, {"image/png", ".png"}, {"image/webp", ".webp"}, {"image/gif", ".gif"},
    {"image/heic", ".heic"}, {"video/mp4", ".mp4"}, {"video/webm", ".webm"}, {"video/quicktime", ".mov"},
    {"audio/ogg", ".ogg"}, {"audio/mpeg", ".mp3"}, {"audio/mp4", ".m4a"}, {"audio/webm", ".webm"},
    {"audio/wav", ".wav"}, {"application/pdf", ".pdf"}, {"application/zip", ".zip"}, {"text/plain", ".txt"},
    {"text/markdown", ".md"},
};
const std::map<std::string, std::string> kDefaultExtByKind = {
    {"photo", ".jpg"}, {"video", ".mp4"}, {"video_note", ".mp4"}, {"voice", ".ogg"}, {"gif", ".webm"},
};

const char *kPageStyle = R"(
body{margin:0;font:15px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f4f4f5;color:#111}
header{position:sticky;top:0;background:#fff;border-bottom:1px solid #ddd;padding:12px 16px}
header h1{margin:0;font-size:18px}header a{color:#3a7bd5;text-decoration:none;font-size:14px}
main{max-width:760px;margin:0 auto;padding:12px 16px 40px}
.msg{background:#fff;border-radius:10px;padding:8px 12px;margin:6px 0;max-width:85%}
.msg.out{margin-left:auto;background:#e3f2fd}.msg.service{background:none;text-align:center;color:#666;max-width:none}
.meta{font-size:12px;color:#777;display:flex;gap:8px}.from{font-weight:600;color:#3a7bd5}
.reply,.fwd{font-size:13px;color:#555;border-left:3px solid #3a7bd5;padding-left:6px;margin:4px 0}
.text{white-space:pre-wrap;word-wrap:break-word}.media img,.media video{max-width:100%;border-radius:6px;margin-top:4px}
.missing{font-style:italic;color:#888}.reactions{font-size:13px;margin-top:4px}
ul{padding-left:20px}li{margin:4px 0}
@media (prefers-color-scheme:dark){body{background:#17181a;color:#eee}header,.msg{background:#232427;border-color:#333}
.msg.out{background:#1e3a52}.reply,.fwd{color:#bbb}}
)";

std::string pad(int64_t value, int size = 2) {
    std::string s = std::to_string(value);
    // String(value).padStart: знак не учитывается особо — как в JS
    while (static_cast<int>(s.size()) < size) s.insert(s.begin(), '0');
    return s;
}

// Строковое поле содержимого (есть и строка)
std::optional<std::string> field(const json &content, const char *key) {
    if (!content.is_object()) return std::nullopt;
    const auto it = content.find(key);
    if (it == content.end() || !it->is_string()) return std::nullopt;
    return it->get<std::string>();
}

// `a || b`: непустая строка
std::string orStr(std::initializer_list<std::optional<std::string>> values) {
    for (const auto &v : values) {
        if (v && !v->empty()) return *v;
    }
    return "";
}

bool has(const json &content, const char *key) {
    return content.is_object() && content.contains(key) && !content[key].is_null();
}

// JS-истинность числа/строки/флага
bool truthy(const json &v) {
    if (v.is_null()) return false;
    if (v.is_boolean()) return v.get<bool>();
    if (v.is_number()) {
        const double d = v.get<double>();
        return d != 0 && !std::isnan(d);
    }
    if (v.is_string()) return !v.get<std::string>().empty();
    return true;
}

// Number → строка как в JS (`${x}`) для обычных значений
std::string jsNumber(const json &v) {
    if (v.is_number_integer()) return v.dump();
    if (!v.is_number()) return v.is_string() ? v.get<std::string>() : v.dump();
    const double d = v.get<double>();
    if (std::isnan(d)) return "NaN";
    if (std::isinf(d)) return d > 0 ? "Infinity" : "-Infinity";
    if (d == std::floor(d) && std::fabs(d) < 1e21) {
        char buf[64];
        std::snprintf(buf, sizeof(buf), "%.0f", d);
        return std::string(buf) == "-0" ? "0" : buf;
    }
    char buf[64];
    const auto res = std::to_chars(buf, buf + sizeof(buf), d);
    return std::string(buf, res.ptr);
}

// String(x)
std::string jsString(const json &v) {
    if (v.is_string()) return v.get<std::string>();
    if (v.is_number()) return jsNumber(v);
    if (v.is_boolean()) return v.get<bool>() ? "true" : "false";
    if (v.is_null()) return "null";
    if (v.is_array()) {
        std::string out;
        for (size_t i = 0; i < v.size(); ++i) {
            if (i) out += ",";
            if (!v[i].is_null()) out += jsString(v[i]);
        }
        return out;
    }
    return "[object Object]";
}

std::string dumpJson(const ojson &j) {
    return j.dump(2, ' ', false, ojson::error_handler_t::replace);
}

CivilTime localOf(const LocalTimeFn &localTime, int64_t ts) {
    return localTime ? localTime(ts) : utcCivil(ts);
}

std::string formatTime(int64_t ts, const LocalTimeFn &localTime) {
    const auto t = localOf(localTime, ts);
    return formatDay(t) + " " + pad(t.hour) + ":" + pad(t.minute);
}

// Текст сообщения для архива: подпись к вложению, текст, вопрос опроса и т. п.
std::string textOf(const json &content) {
    const auto kind = field(content, "kind").value_or("");
    if (kind == "poll") return orStr({field(content, "question")});
    if (kind == "sticker") return orStr({field(content, "filename"), field(content, "text")});
    if (kind == "article") return orStr({field(content, "title"), field(content, "text")});
    if (kind == "task_offer" || kind == "cloud_invite") return orStr({field(content, "text"), field(content, "name")});
    // content.caption ?? content.text ?? ''
    if (const auto c = field(content, "caption")) return *c;
    if (const auto t = field(content, "text")) return *t;
    return "";
}

std::string mediaName(const json &content, int index) {
    const auto kind = field(content, "kind").value_or("");
    std::string ext = extForMime(field(content, "mime"));
    if (ext.empty()) {
        const auto it = kDefaultExtByKind.find(kind);
        if (it != kDefaultExtByKind.end()) ext = it->second;
    }
    const auto filename = field(content, "filename");
    const std::string given = filename && !filename->empty() ? sanitizeFileName(*filename, "") : "";
    const std::string base = !given.empty() ? given : kind + "-" + std::to_string(index) + ext;
    return pad(index, 5) + "-" + base;
}

std::optional<json> numberField(const json &content, const char *key) {
    if (!has(content, key)) return std::nullopt;
    return content[key];
}

std::string page(const std::string &title, const std::string &body, const std::string &back = "") {
    std::string out = "<!DOCTYPE html>\n<html><head><meta charset=\"utf-8\">";
    out += "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">";
    out += "<title>" + escapeHtml(title) + "</title><style>" + kPageStyle + "</style></head><body>";
    out += "<header>" + (back.empty() ? std::string() : "<a href=\"" + escapeHtml(back) + "\">←</a> ");
    out += "<h1>" + escapeHtml(title) + "</h1></header>";
    out += "<main>" + body + "</main></body></html>\n";
    return out;
}

bool startsWith(std::string_view s, std::string_view prefix) {
    return s.size() >= prefix.size() && s.compare(0, prefix.size(), prefix) == 0;
}

std::string renderMedia(const ExportMedia &media, const ExportLabels &labels) {
    if (media.status != ExportMediaStatus::Included) {
        const auto &label = media.status == ExportMediaStatus::Unavailable ? labels.mediaUnavailable
                                                                            : labels.mediaNotIncluded;
        const std::string name = media.fileName && !media.fileName->empty() ? ": " + escapeHtml(*media.fileName) : "";
        return "<div class=\"media missing\">" + escapeHtml(label) + name + "</div>";
    }
    const std::string href = escapeHtml(hrefOf(media.path));
    const std::string mime = media.mime.value_or("");
    if (media.kind == "photo" || startsWith(mime, "image/")) {
        return "<div class=\"media\"><a href=\"" + href + "\"><img src=\"" + href
            + "\" alt=\"\" loading=\"lazy\"></a></div>";
    }
    if (media.kind == "video" || media.kind == "video_note" || media.kind == "gif") {
        return "<div class=\"media\"><video src=\"" + href + "\" controls preload=\"none\"></video></div>";
    }
    if (media.kind == "voice" || startsWith(mime, "audio/")) {
        return "<div class=\"media\"><audio src=\"" + href + "\" controls preload=\"none\"></audio></div>";
    }
    const std::string name = media.fileName && !media.fileName->empty()
        ? *media.fileName
        : (media.path.size() >= 6 ? media.path.substr(6) : std::string());
    return "<div class=\"media\"><a href=\"" + href + "\">" + escapeHtml(name) + "</a></div>";
}

ojson reactionsJson(const std::vector<ExportReaction> &reactions) {
    ojson arr = ojson::array();
    for (const auto &r : reactions) {
        ojson o;
        o["emoji"] = r.emoji;
        o["count"] = r.count;
        arr.push_back(std::move(o));
    }
    return arr;
}

} // namespace

// --- время ---

CivilTime utcCivil(int64_t unixSeconds) {
    int64_t days = unixSeconds / 86400;
    int64_t rem = unixSeconds % 86400;
    if (rem < 0) {
        rem += 86400;
        --days;
    }
    // civil_from_days (H. Hinnant)
    const int64_t z = days + 719468;
    const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
    const int64_t doe = z - era * 146097;
    const int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    const int64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    const int64_t mp = (5 * doy + 2) / 153;
    const int64_t d = doy - (153 * mp + 2) / 5 + 1;
    const int64_t m = mp < 10 ? mp + 3 : mp - 9;
    const int64_t y = yoe + era * 400 + (m <= 2 ? 1 : 0);
    CivilTime t;
    t.year = static_cast<int>(y);
    t.month = static_cast<int>(m);
    t.day = static_cast<int>(d);
    t.hour = static_cast<int>(rem / 3600);
    t.minute = static_cast<int>((rem % 3600) / 60);
    t.second = static_cast<int>(rem % 60);
    return t;
}

std::string formatDay(const CivilTime &t) {
    return pad(t.year, 4) + "-" + pad(t.month) + "-" + pad(t.day);
}

std::string isoOf(int64_t unixSeconds) {
    const auto t = utcCivil(unixSeconds);
    return formatDay(t) + "T" + pad(t.hour) + ":" + pad(t.minute) + ":" + pad(t.second) + ".000Z";
}

const char *mediaStatusName(ExportMediaStatus status) {
    switch (status) {
    case ExportMediaStatus::Included: return "included";
    case ExportMediaStatus::NotIncluded: return "not_included";
    case ExportMediaStatus::Unavailable: return "unavailable";
    }
    return "included";
}

// --- имена и строки ---

std::string escapeHtml(std::string_view value) {
    std::string out;
    out.reserve(value.size());
    for (const char c : value) {
        switch (c) {
        case '&': out += "&amp;"; break;
        case '<': out += "&lt;"; break;
        case '>': out += "&gt;"; break;
        case '"': out += "&quot;"; break;
        case '\'': out += "&#39;"; break;
        default: out.push_back(c);
        }
    }
    return out;
}

std::string sanitizeFileName(std::string_view name, std::string_view fallback) {
    const auto src = u::decode(name);
    // 1. Запрещённые и управляющие — подчёркиванием (серия — одним)
    std::u32string s;
    for (size_t i = 0; i < src.size();) {
        auto bad = [](char32_t c) {
            return c < 0x20 || c == 0x7F || c == U'<' || c == U'>' || c == U':' || c == U'"' || c == U'/'
                || c == U'\\' || c == U'|' || c == U'?' || c == U'*';
        };
        if (bad(src[i])) {
            while (i < src.size() && bad(src[i])) ++i;
            s.push_back(U'_');
        } else {
            s.push_back(src[i++]);
        }
    }
    // 2. Части-«точки» (`..` из пути) убираются: /(^|_)\.+(?=_|$)/g → '$1'
    {
        std::u32string out;
        const size_t n = s.size();
        size_t i = 0;
        while (i < n) {
            size_t j = std::u32string::npos;
            bool keepUnderscore = false;
            if (i == 0 && s[0] == U'.') {
                j = 0;
            } else if (s[i] == U'_' && i + 1 < n && s[i + 1] == U'.') {
                j = i + 1;
                keepUnderscore = true;
            }
            if (j != std::u32string::npos) {
                size_t k = j;
                while (k < n && s[k] == U'.') ++k;
                if (k == n || s[k] == U'_') {
                    if (keepUnderscore) out.push_back(U'_');
                    i = k;
                    continue;
                }
            }
            out.push_back(s[i++]);
        }
        s = std::move(out);
    }
    // 3. Подчёркивания — одним; 4. пробелы — одним
    {
        std::u32string out;
        for (size_t i = 0; i < s.size();) {
            if (s[i] == U'_') {
                while (i < s.size() && s[i] == U'_') ++i;
                out.push_back(U'_');
            } else if (u::isJsSpace(s[i])) {
                while (i < s.size() && u::isJsSpace(s[i])) ++i;
                out.push_back(U' ');
            } else {
                out.push_back(s[i++]);
            }
        }
        s = std::move(out);
    }
    // 5. trim; 6. точки и пробелы по краям
    s = u::trim32(s);
    {
        size_t a = 0, b = s.size();
        while (a < b && (s[a] == U'.' || u::isJsSpace(s[a]))) ++a;
        while (b > a && (s[b - 1] == U'.' || u::isJsSpace(s[b - 1]))) --b;
        s = s.substr(a, b - a);
    }
    // 7. Длинное — обрезается, короткое расширение сохраняется
    if (s.size() > kFileNameMax) {
        const auto dot = s.rfind(U'.');
        const std::u32string ext = dot != std::u32string::npos && dot > 0 && s.size() - dot <= 10 ? s.substr(dot)
                                                                                                    : U"";
        s = u::trim32(s.substr(0, kFileNameMax - ext.size())) + ext;
    }
    // 8. Зарезервированные имена Windows
    const auto firstDot = s.find(U'.');
    std::string stem = u::encode(s.substr(0, firstDot == std::u32string::npos ? s.size() : firstDot));
    for (auto &c : stem) {
        if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    }
    const bool reserved = stem == "con" || stem == "prn" || stem == "aux" || stem == "nul"
        || (stem.size() == 4 && (startsWith(stem, "com") || startsWith(stem, "lpt")) && stem[3] >= '0'
            && stem[3] <= '9');
    if (s.empty() || reserved) return std::string(fallback);
    return u::encode(s);
}

std::string uniqueName(std::set<std::string> &taken, const std::string &name) {
    const auto dot = name.rfind('.');
    const bool split = dot != std::string::npos && dot > 0;
    const std::string stem = split ? name.substr(0, dot) : name;
    const std::string ext = split ? name.substr(dot) : "";
    std::string candidate = name;
    for (int n = 2; taken.count(u::toLower(candidate)); ++n) {
        candidate = stem + " (" + std::to_string(n) + ")" + ext;
    }
    taken.insert(u::toLower(candidate));
    return candidate;
}

std::string extForMime(const std::optional<std::string> &mime) {
    if (!mime || mime->empty()) return "";
    const auto semi = mime->find(';');
    const auto key = u::toLower(u::trim(std::string_view(*mime).substr(0, semi)));
    const auto it = kExtByMime.find(key);
    return it != kExtByMime.end() ? it->second : "";
}

std::string exportArchiveName(std::string_view address, const CivilTime &date) {
    const auto at = address.find('@');
    const auto nickRaw = address.substr(0, at);
    // /\s+/g → '_': серия пробелов — одним подчёркиванием
    std::string fixed;
    {
        const auto cps = u::decode(sanitizeFileName(nickRaw, "user"));
        for (size_t i = 0; i < cps.size();) {
            if (u::isJsSpace(cps[i])) {
                while (i < cps.size() && u::isJsSpace(cps[i])) ++i;
                fixed.push_back('_');
            } else {
                u::append(fixed, cps[i++]);
            }
        }
    }
    return "parvane-export-" + fixed + "-" + formatDay(date) + ".zip";
}

std::string hrefOf(std::string_view path) {
    static const char *hex = "0123456789ABCDEF";
    std::string out;
    for (const char ch : path) {
        const auto c = static_cast<unsigned char>(ch);
        const bool keep = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-'
            || c == '_' || c == '.' || c == '!' || c == '~' || c == '*' || c == '\'' || c == '(' || c == ')'
            || c == '/';
        if (keep) {
            out.push_back(ch);
        } else {
            out.push_back('%');
            out.push_back(hex[c >> 4]);
            out.push_back(hex[c & 0xF]);
        }
    }
    return out;
}

// --- модель ---

std::vector<ExportMessage> buildChatMessages(const ExportSourceChat &chat, bool includeMedia) {
    std::vector<const ExportSourceMessage *> visible;
    for (const auto &m : chat.messages) {
        if (!kSkippedKinds.count(field(m.content, "kind").value_or(""))) visible.push_back(&m);
    }
    std::map<std::string, int> idByUuid;
    for (size_t i = 0; i < visible.size(); ++i) idByUuid[visible[i]->uuid] = static_cast<int>(i + 1);
    std::set<std::string> taken;
    std::vector<ExportMessage> out;
    out.reserve(visible.size());
    for (size_t i = 0; i < visible.size(); ++i) {
        const auto &source = *visible[i];
        const auto &content = source.content;
        const std::string kind = field(content, "kind").value_or("");
        const int id = static_cast<int>(i + 1);
        ExportMessage message;
        message.id = id;
        message.uuid = source.uuid;
        message.type = kind == "chat_mode" ? "service" : "message";
        message.kind = kind;
        message.ts = source.ts;
        message.from = source.from;
        message.fromName = source.fromName;
        message.isOutgoing = source.isOutgoing;
        message.text = textOf(content);
        if (source.replyTo && !source.replyTo->empty()) {
            const auto it = idByUuid.find(*source.replyTo);
            if (it != idByUuid.end()) message.replyToId = it->second;
        }
        if (source.edited) {
            message.edited = true;
            if (source.editedAt && *source.editedAt) message.editedAt = source.editedAt;
        }
        if (source.pinned) message.pinned = true;
        if (kind == "chat_mode") message.action = has(content, "l2") && truthy(content["l2"]) ? "privacy_on" : "privacy_off";
        if (const auto fwd = field(content, "forwarded_from"); fwd && !fwd->empty()) {
            message.forwardedFrom = orStr({field(content, "forwarded_name"), fwd});
        }
        if (source.reactions && !source.reactions->empty()) message.reactions = source.reactions;
        if (kind == "poll") {
            ExportPoll poll;
            poll.question = orStr({field(content, "question")});
            if (has(content, "options") && content["options"].is_array()) {
                for (const auto &o : content["options"]) poll.options.push_back(jsString(o));
            }
            message.poll = std::move(poll);
        }
        if (kind == "location" && content.is_object() && content.contains("lat") && content.contains("long")) {
            message.location = ExportLocation{content["lat"], content["long"]};
        }
        if (kind == "article" && content.is_object() && content.contains("markdown")) {
            message.article = ExportArticle{orStr({field(content, "title")}), field(content, "markdown").value_or("")};
        }
        const auto fileId = field(content, "file_id");
        if (kMediaKinds.count(kind) && fileId && !fileId->empty()) {
            ExportMedia media;
            media.kind = kind;
            media.fileId = *fileId;
            media.path = "media/" + uniqueName(taken, mediaName(content, id));
            media.fileName = field(content, "filename");
            media.mime = field(content, "mime");
            media.size = numberField(content, "size_bytes");
            media.width = numberField(content, "width");
            media.height = numberField(content, "height");
            media.duration = numberField(content, "duration_secs");
            media.status = includeMedia ? ExportMediaStatus::Included : ExportMediaStatus::NotIncluded;
            message.media = std::move(media);
        }
        out.push_back(std::move(message));
    }
    return out;
}

std::vector<ExportChat> assignChatDirs(const std::vector<ExportSourceChat> &chats, const ExportLabels &labels,
    bool includeMedia) {
    std::set<std::string> taken;
    std::vector<ExportChat> out;
    for (size_t i = 0; i < chats.size(); ++i) {
        const auto &chat = chats[i];
        const std::string title = chat.kind == "saved" ? labels.savedMessages : chat.title;
        const std::string name = sanitizeFileName(title, chat.kind);
        ExportChat result;
        result.dir = "chats/" + uniqueName(taken, pad(static_cast<int64_t>(i + 1), 3) + "-" + name);
        result.address = chat.address;
        result.kind = chat.kind;
        result.title = title;
        result.messages = buildChatMessages(chat, includeMedia);
        out.push_back(std::move(result));
    }
    return out;
}

std::string renderChatJson(const ExportChat &chat) {
    ojson root;
    root["name"] = chat.title;
    root["type"] = chat.kind;
    root["id"] = chat.address;
    ojson messages = ojson::array();
    for (const auto &m : chat.messages) {
        ojson o;
        o["id"] = m.id;
        o["uuid"] = m.uuid;
        o["type"] = m.type;
        o["kind"] = m.kind;
        o["date"] = isoOf(m.ts);
        o["date_unixtime"] = std::to_string(m.ts);
        o["from"] = m.fromName;
        o["from_id"] = m.from;
        if (m.isOutgoing) o["outgoing"] = true;
        if (m.edited) {
            if (m.editedAt && *m.editedAt) o["edited"] = isoOf(*m.editedAt);
            else o["edited"] = true;
        }
        if (m.pinned) o["pinned"] = true;
        if (m.replyToId && *m.replyToId) o["reply_to_message_id"] = *m.replyToId;
        if (m.forwardedFrom && !m.forwardedFrom->empty()) o["forwarded_from"] = *m.forwardedFrom;
        o["text"] = m.text;
        if (m.media) {
            const auto &md = *m.media;
            ojson media;
            media["kind"] = md.kind;
            if (md.status == ExportMediaStatus::Included) media["file"] = md.path;
            media["status"] = mediaStatusName(md.status);
            if (md.fileName && !md.fileName->empty()) media["file_name"] = *md.fileName;
            if (md.mime && !md.mime->empty()) media["mime_type"] = *md.mime;
            if (md.size && truthy(*md.size)) media["size"] = ojson(*md.size);
            if (md.width && truthy(*md.width)) {
                media["width"] = ojson(*md.width);
                // JSON.stringify пропускает undefined: без высоты — только ширина
                if (md.height) media["height"] = ojson(*md.height);
            }
            if (md.duration && truthy(*md.duration)) media["duration_seconds"] = ojson(*md.duration);
            o["media"] = std::move(media);
        }
        if (m.poll) {
            ojson poll;
            poll["question"] = m.poll->question;
            poll["options"] = m.poll->options;
            o["poll"] = std::move(poll);
        }
        if (m.location) {
            ojson loc;
            loc["lat"] = ojson(m.location->lat);
            loc["long"] = ojson(m.location->lon);
            o["location"] = std::move(loc);
        }
        if (m.article) {
            ojson art;
            art["title"] = m.article->title;
            art["markdown"] = m.article->markdown;
            o["article"] = std::move(art);
        }
        if (m.reactions) o["reactions"] = reactionsJson(*m.reactions);
        if (m.action) o["action"] = *m.action;
        messages.push_back(std::move(o));
    }
    root["messages"] = std::move(messages);
    return dumpJson(root);
}

std::string renderChatHtml(const ExportChat &chat, const ExportLabels &labels, const LocalTimeFn &localTime) {
    std::map<int, const ExportMessage *> byId;
    for (const auto &m : chat.messages) byId[m.id] = &m;
    std::string items;
    for (size_t i = 0; i < chat.messages.size(); ++i) {
        const auto &m = chat.messages[i];
        if (i) items += "\n";
        const std::string mid = std::to_string(m.id);
        if (m.type == "service") {
            const std::string what = m.action == "privacy_on" ? labels.privacyOn
                : m.action == "privacy_off"                   ? labels.privacyOff
                                                              : m.kind;
            items += "<div class=\"msg service\" id=\"message-" + mid + "\">" + escapeHtml(m.fromName) + " "
                + escapeHtml(what) + " · " + escapeHtml(formatTime(m.ts, localTime)) + "</div>";
            continue;
        }
        std::string parts;
        parts += "<div class=\"meta\"><span class=\"from\">" + escapeHtml(m.fromName) + "</span>";
        parts += "<span title=\"" + escapeHtml(isoOf(m.ts)) + "\">" + escapeHtml(formatTime(m.ts, localTime))
            + "</span>";
        parts += (m.edited ? "<span>" + escapeHtml(labels.edited) + "</span>" : std::string()) + "</div>";
        if (m.forwardedFrom && !m.forwardedFrom->empty()) {
            parts += "<div class=\"fwd\">" + escapeHtml(labels.forwardedFrom) + " " + escapeHtml(*m.forwardedFrom)
                + "</div>";
        }
        if (m.replyToId && *m.replyToId) {
            const auto it = byId.find(*m.replyToId);
            std::string preview;
            if (it != byId.end()) {
                const auto cps = u::decode(it->second->text);
                preview = u::encode(std::u32string_view(cps).substr(0, 80));
                if (preview.empty()) preview = it->second->kind;
            }
            const std::string rid = std::to_string(*m.replyToId);
            parts += "<div class=\"reply\"><a href=\"#message-" + rid + "\">" + escapeHtml(labels.replyTo) + "</a>"
                + (preview.empty() ? std::string() : " " + escapeHtml(preview)) + "</div>";
        }
        if (m.media) parts += renderMedia(*m.media, labels);
        if (m.poll) {
            parts += "<div class=\"text\">" + escapeHtml(labels.poll) + ": " + escapeHtml(m.poll->question)
                + "</div><ul>";
            for (const auto &o : m.poll->options) parts += "<li>" + escapeHtml(o) + "</li>";
            parts += "</ul>";
        } else if (m.article) {
            parts += "<div class=\"text\"><b>" + escapeHtml(m.article->title) + "</b>\n"
                + escapeHtml(m.article->markdown) + "</div>";
        } else if (m.location) {
            const std::string lat = jsNumber(m.location->lat);
            const std::string lon = jsNumber(m.location->lon);
            const std::string url = "https://www.openstreetmap.org/?mlat=" + lat + "&mlon=" + lon + "#map=16/" + lat
                + "/" + lon;
            parts += "<div class=\"text\">" + escapeHtml(labels.location) + ": <a href=\"" + escapeHtml(url)
                + "\" rel=\"noreferrer\">" + lat + ", " + lon + "</a></div>";
        } else if (!m.text.empty()) {
            parts += "<div class=\"text\">" + escapeHtml(m.text) + "</div>";
        }
        if (m.reactions && !m.reactions->empty()) {
            std::string reactions;
            for (size_t k = 0; k < m.reactions->size(); ++k) {
                if (k) reactions += " · ";
                reactions += escapeHtml((*m.reactions)[k].emoji) + " " + std::to_string((*m.reactions)[k].count);
            }
            parts += "<div class=\"reactions\">" + reactions + "</div>";
        }
        items += "<div class=\"msg" + std::string(m.isOutgoing ? " out" : "") + "\" id=\"message-" + mid + "\">"
            + parts + "</div>";
    }
    return page(chat.title, items, "../../index.html");
}

std::string renderIndexHtml(const ExportOwner &owner, const std::vector<ExportChat> &chats,
    const ExportIndexSections &sections, const ExportLabels &labels, int64_t exportedAtUnixSeconds,
    const LocalTimeFn &localTime) {
    auto link = [](const std::string &path, const std::string &text) {
        return "<a href=\"" + escapeHtml(hrefOf(path)) + "\">" + escapeHtml(text) + "</a>";
    };
    std::vector<std::string> blocks;
    const auto at = owner.address.find('@');
    blocks.push_back("<p>" + escapeHtml(owner.name) + " (@" + escapeHtml(owner.address.substr(0, at)) + ") · "
        + escapeHtml(labels.exportedAt) + " " + escapeHtml(formatTime(exportedAtUnixSeconds, localTime)) + "</p>");
    std::string chatList = "<h2>" + escapeHtml(labels.chats) + "</h2><ul>";
    for (const auto &chat : chats) {
        chatList += "<li>" + link(chat.dir + "/messages.html", chat.title) + " — "
            + std::to_string(chat.messages.size()) + " " + escapeHtml(labels.messages) + " ("
            + link(chat.dir + "/messages.json", "JSON") + ")</li>";
    }
    chatList += "</ul>";
    blocks.push_back(chatList);
    auto list = [&](const std::string &title, const std::vector<std::string> &paths) {
        std::string out = "<h2>" + escapeHtml(title) + "</h2><ul>";
        for (const auto &p : paths) out += "<li>" + link(p, p) + "</li>";
        return out + "</ul>";
    };
    if (sections.planner && !sections.planner->empty()) blocks.push_back(list(labels.planner, {*sections.planner}));
    if (sections.notes) blocks.push_back(list(labels.notes, *sections.notes));
    if (sections.contacts && !sections.contacts->empty()) {
        blocks.push_back(list(labels.contacts, {*sections.contacts}));
    }
    if (sections.cloud) blocks.push_back(list(labels.cloud, *sections.cloud));
    std::string body;
    for (size_t i = 0; i < blocks.size(); ++i) {
        if (i) body += "\n";
        body += blocks[i];
    }
    return page(labels.title, body);
}

std::string renderContactsJson(const std::vector<ExportContact> &contacts) {
    ojson root;
    ojson list = ojson::array();
    for (const auto &c : contacts) {
        ojson o;
        o["name"] = c.name;
        o["address"] = c.address;
        if (c.isExplicit) o["added"] = true;
        list.push_back(std::move(o));
    }
    root["contacts"] = std::move(list);
    return dumpJson(root);
}

std::string prettyJson(const std::string &text) {
    try {
        return dumpJson(ojson::parse(text));
    } catch (const std::exception &) {
        return text;
    }
}

// --- облако ---

std::vector<ExportTreeFile> treeFilePaths(const std::vector<cloud::CloudNode> &nodes, const std::string &prefix,
    const std::optional<std::string> &root, const std::function<bool(const cloud::CloudNode &)> &accept) {
    std::vector<ExportTreeFile> out;
    std::map<std::optional<std::string>, std::vector<const cloud::CloudNode *>> byParent;
    for (const auto &node : nodes) {
        if (node.trashed || cloud::isServiceNode(node)) continue;
        std::optional<std::string> key;
        if (node.parent && !node.parent->empty()) key = node.parent;
        byParent[key].push_back(&node);
    }
    std::set<std::string> seen;
    std::function<void(const std::optional<std::string> &, const std::string &)> walk;
    walk = [&](const std::optional<std::string> &parent, const std::string &dir) {
        std::set<std::string> taken;
        const auto it = byParent.find(parent);
        if (it == byParent.end()) return;
        auto children = it->second;
        // Порядок по кодам: не зависит от языка, архив с одних данных всегда одинаков
        std::stable_sort(children.begin(), children.end(),
            [](const cloud::CloudNode *a, const cloud::CloudNode *b) { return a->name < b->name; });
        for (const auto *node : children) {
            if (seen.count(node->id)) continue;
            seen.insert(node->id);
            const std::string name = uniqueName(taken, sanitizeFileName(node->name, node->kind));
            if (node->kind == "folder") {
                walk(node->id, dir + name + "/");
            } else if (node->blob && !node->blob->is_null() && (!accept || accept(*node))) {
                out.push_back({*node, dir + name});
            }
        }
    };
    std::optional<std::string> start;
    if (root && !root->empty()) start = root;
    walk(start, prefix);
    return out;
}

std::vector<ExportCloudFile> cloudExportFiles(const std::vector<ExportCloudTree> &trees,
    const std::string &fallbackName) {
    std::set<std::string> taken;
    std::vector<ExportCloudFile> out;
    for (const auto &tree : trees) {
        const std::string dir = uniqueName(taken, sanitizeFileName(tree.name, fallbackName));
        for (const auto &[node, path] : treeFilePaths(tree.nodes, "cloud/" + dir + "/")) {
            ExportCloudFile file;
            file.container = tree.id;
            file.node = node.id;
            file.path = path;
            file.size = node.size;
            if (node.blob && node.blob->is_object() && node.blob->contains("size")
                && (*node.blob)["size"].is_number()) {
                file.size = static_cast<int64_t>((*node.blob)["size"].get<double>());
            }
            if (node.mtime) file.mtime = node.mtime;
            out.push_back(std::move(file));
        }
    }
    return out;
}

// --- сборка архива ---

namespace {

ZipTime zipTimeOf(const CivilTime &t) {
    return ZipTime{t.year, t.month, t.day, t.hour, t.minute, t.second};
}

int64_t floorDiv(int64_t a, int64_t b) {
    int64_t q = a / b;
    if ((a % b != 0) && ((a < 0) != (b < 0))) --q;
    return q;
}

} // namespace

ExportResult runDataExport(const ExportRunArgs &args) {
    const auto &source = args.source;
    const auto &labels = args.labels;
    auto isCanceled = [&] { return args.canceled && args.canceled(); };
    auto throwIfCanceled = [&] {
        if (isCanceled()) throw ExportError(ExportErrorCode::Canceled);
    };
    auto local = [&](int64_t unixSeconds) { return localOf(args.localTime, unixSeconds); };
    const int64_t nowSec = floorDiv(args.nowUnixMs, 1000);

    ExportProgress progress{"prepare", 0, 0, 0};
    ZipWriter writer(args.sink, zipTimeOf(local(nowSec)), args.canceled);
    auto report = [&](const std::optional<std::string> &stage, std::optional<int64_t> done,
                      std::optional<int64_t> total) {
        if (stage) progress.stage = *stage;
        if (done) progress.done = *done;
        if (total) progress.total = *total;
        progress.bytes = writer.bytes();
        if (args.onProgress) args.onProgress(progress);
    };
    ExportResult result;
    try {
        report("prepare", std::nullopt, std::nullopt);
        std::optional<ExportSnapshot> snapshot = source.snapshot ? source.snapshot() : std::nullopt;
        throwIfCanceled();
        if (!snapshot) throw ExportError(ExportErrorCode::Failed, "no snapshot");
        auto chats = assignChatDirs(snapshot->chats, labels, args.options.includeMedia);
        int64_t mediaTotal = 0;
        for (const auto &chat : chats) {
            for (const auto &m : chat.messages) {
                if (m.media && m.media->status == ExportMediaStatus::Included) ++mediaTotal;
            }
        }
        int64_t chatSteps = 0;
        report("chats", 0, mediaTotal + static_cast<int64_t>(chats.size()));
        for (auto &chat : chats) {
            for (auto &message : chat.messages) {
                if (!message.media || message.media->status != ExportMediaStatus::Included) continue;
                auto &media = *message.media;
                throwIfCanceled();
                std::optional<ZipWriter::ChunkSource> blob;
                try {
                    if (source.media) blob = source.media(media.fileId);
                } catch (const std::exception &) {
                    blob.reset(); // как `.catch(() => undefined)`
                }
                throwIfCanceled();
                if (blob) {
                    writer.addChunks(chat.dir + "/" + media.path, *blob, zipTimeOf(local(message.ts)));
                    ++result.media;
                } else {
                    media.status = ExportMediaStatus::Unavailable;
                    ++result.mediaFailed;
                }
                report(std::nullopt, ++chatSteps, std::nullopt);
            }
            writer.addBytes(chat.dir + "/messages.json", renderChatJson(chat));
            writer.addBytes(chat.dir + "/messages.html", renderChatHtml(chat, labels, args.localTime));
            ++result.chats;
            result.messages += static_cast<int>(chat.messages.size());
            report(std::nullopt, ++chatSteps, std::nullopt);
        }

        ExportIndexSections sections;
        report("planner", 0, 1);
        std::optional<std::string> planner;
        try {
            if (source.planner) planner = source.planner();
        } catch (const std::exception &) {
            planner.reset();
        }
        throwIfCanceled();
        if (planner && !planner->empty()) {
            sections.planner = "planner/planner.json";
            writer.addBytes(*sections.planner, prettyJson(*planner));
        }
        report(std::nullopt, 1, std::nullopt);

        report("notes", 0, 1);
        std::vector<ExportNote> notes;
        try {
            if (source.notes) notes = source.notes();
        } catch (const std::exception &) {
            notes.clear();
        }
        throwIfCanceled();
        if (!notes.empty()) {
            sections.notes = std::vector<std::string>();
            report(std::nullopt, std::nullopt, static_cast<int64_t>(notes.size()));
            for (const auto &note : notes) {
                const std::string path = "notes/" + note.path;
                std::optional<ZipTime> mtime;
                if (note.mtime && *note.mtime) mtime = zipTimeOf(local(floorDiv(*note.mtime, 1000)));
                writer.addBytes(path, note.text, mtime);
                sections.notes->push_back(path);
                ++result.notes;
                report(std::nullopt, result.notes, std::nullopt);
            }
        }

        report("contacts", 0, 1);
        sections.contacts = "contacts.json";
        writer.addBytes(*sections.contacts, renderContactsJson(snapshot->contacts));
        report(std::nullopt, 1, std::nullopt);

        if (args.options.includeCloud) {
            report("cloud", 0, 0);
            const auto files = source.cloudFiles ? source.cloudFiles() : std::vector<ExportCloudFile>();
            throwIfCanceled();
            sections.cloud = std::vector<std::string>();
            report(std::nullopt, std::nullopt, static_cast<int64_t>(files.size()));
            int64_t done = 0;
            for (const auto &file : files) {
                throwIfCanceled();
                std::optional<ZipWriter::ChunkSource> blob;
                try {
                    if (source.cloudBlob) blob = source.cloudBlob(file);
                } catch (const ExportError &) {
                    throw;
                } catch (const std::exception &) {
                    if (isCanceled()) throw ExportError(ExportErrorCode::Canceled);
                    blob.reset();
                }
                throwIfCanceled();
                if (blob) {
                    std::optional<ZipTime> mtime;
                    if (file.mtime && *file.mtime) mtime = zipTimeOf(local(floorDiv(*file.mtime, 1000)));
                    writer.addChunks(file.path, *blob, mtime);
                    sections.cloud->push_back(file.path);
                    ++result.cloudFiles;
                } else {
                    ++result.cloudFailed;
                }
                report(std::nullopt, ++done, std::nullopt);
            }
        }

        report("finishing", 0, 1);
        writer.addBytes("index.html", renderIndexHtml({snapshot->self, snapshot->selfName}, chats, sections, labels,
            nowSec, args.localTime));
        writer.finish();
        result.bytes = writer.bytes();
        report(std::nullopt, 1, std::nullopt);
        result.fileName = exportArchiveName(snapshot->self, local(nowSec));
        return result;
    } catch (const ExportError &) {
        throw;
    } catch (const std::exception &e) {
        if (isCanceled()) throw ExportError(ExportErrorCode::Canceled);
        throw ExportError(ExportErrorCode::Failed, e.what());
    }
}

} // namespace parvane::sections::exportdata
