// Parvane fork (spec 029, фаза 4): вид заметки в списках — порт web `notes/notesLook.ts` (без форматов дат Intl).
#include "parvane/sections/notes_look.h"

#include "notes_preview_text.h"
#include "parvane/sections/notes_canvas.h"
#include "parvane/sections/notes_model.h"

namespace parvane::sections::notes {

namespace {

using text::U32;

const std::vector<std::string> kFolderTones = {"blue", "green", "orange", "purple", "aqua", "red"};
constexpr size_t kPreviewMax = 140;
constexpr long long kHashBase = 31;
constexpr long long kHashSeed = 7;

// `toUpperCase` одной кодовой точки (основные письменности; «ß» и прочие расширяющиеся — как есть)
char32_t upper(char32_t c) {
    if (c >= 'a' && c <= 'z') return c - 32;
    if (c >= 0xE0 && c <= 0xFE && c != 0xF7) return c - 32;
    if (c == 0xFF) return 0x178;
    if (c >= 0x100 && c <= 0x17F && c != 0x131 && c != 0x138 && c != 0x149) {
        const bool isOddPairs = (c >= 0x139 && c <= 0x148) || (c >= 0x179 && c <= 0x17E);
        if (isOddPairs ? c % 2 == 0 : c % 2 == 1) return c - 1;
        return c;
    }
    if (c >= 0x3B1 && c <= 0x3C9 && c != 0x3C2) return c - 32;
    if (c == 0x3C2) return 0x3A3;
    if (c >= 0x430 && c <= 0x44F) return c - 32;
    if (c >= 0x450 && c <= 0x45F) return c - 80;
    if (((c >= 0x460 && c <= 0x481) || (c >= 0x48A && c <= 0x4BF) || (c >= 0x4D0 && c <= 0x52F)) && c % 2 == 1) return c - 1;
    if (c >= 0x561 && c <= 0x586) return c - 48;
    if (c >= 0xFF41 && c <= 0xFF5A) return c - 32;
    return c;
}

bool hasTerminator(const U32 &s, size_t from) { return text::hasLineTerminator(s, from); }

// `[[название|подпись]]`: позиция после ссылки, название и подпись (если есть). Не ссылка — nullopt
struct Link {
    size_t end;
    U32 title;
    std::optional<U32> alias;
};

// `\[\[([^\]|]+)(?:\|([^\]]*))?\]\]` с позиции `at`; `aliasMin` — 0 либо 1 (во второй регулярке подпись `[^\]]+`)
std::optional<Link> linkAt(const U32 &s, size_t at, size_t aliasMin) {
    if (at + 1 >= s.size() || s[at] != U'[' || s[at + 1] != U'[') return std::nullopt;
    size_t i = at + 2;
    const size_t titleStart = i;
    while (i < s.size() && s[i] != U']' && s[i] != U'|') ++i;
    if (i == titleStart) return std::nullopt;
    Link link{0, s.substr(titleStart, i - titleStart), std::nullopt};
    if (i < s.size() && s[i] == U'|') {
        const size_t aliasStart = ++i;
        while (i < s.size() && s[i] != U']') ++i;
        if (i - aliasStart < aliasMin) return std::nullopt;
        link.alias = s.substr(aliasStart, i - aliasStart);
    }
    if (i + 1 >= s.size() || s[i] != U']' || s[i + 1] != U']') return std::nullopt;
    link.end = i + 2;
    return link;
}

// `.replace(/\*\*([^*\n]+)\*\*/g, '$1')`
U32 stripBold(const U32 &s) {
    U32 out;
    size_t i = 0;
    while (i < s.size()) {
        if (i + 1 < s.size() && s[i] == U'*' && s[i + 1] == U'*') {
            size_t j = i + 2;
            while (j < s.size() && s[j] != U'*' && s[j] != U'\n') ++j;
            if (j > i + 2 && j + 1 < s.size() && s[j] == U'*' && s[j + 1] == U'*') {
                out += s.substr(i + 2, j - i - 2);
                i = j + 2;
                continue;
            }
        }
        out.push_back(s[i]);
        ++i;
    }
    return out;
}

U32 dropBackticks(const U32 &s) {
    U32 out;
    for (char32_t c : s) {
        if (c != U'`') out.push_back(c);
    }
    return out;
}

// Разметка внутри строки — упрощённо: ссылка показывается подписью либо названием заметки, метка пункта,
// обратные кавычки и звёздочки жирного убираются
U32 plainInline(const U32 &raw) {
    const U32 s = preview::stripTaskMarker(raw);
    U32 out;
    size_t i = 0;
    while (i < s.size()) {
        if (const auto link = linkAt(s, i, 0)) {
            const auto alias = link->alias ? text::trimU(*link->alias) : U32();
            out += alias.empty() ? link->title : alias;
            i = link->end;
            continue;
        }
        out.push_back(s[i]);
        ++i;
    }
    return text::trimU(dropBackticks(stripBold(out)));
}

std::string slicePreview(const U32 &s) { return canvasjs::utf16Slice(text::encode(s), kPreviewMax); }

} // namespace

std::string folderTone(const std::string &folder, bool isDaily) {
    const auto top = text::split(folder, '/')[0];
    if (isDaily || top.empty()) return "note";
    long long hash = kHashSeed;
    for (char32_t c : text::decode(top)) hash = (hash * kHashBase + static_cast<long long>(c)) % 0xffff;
    return kFolderTones[hash % kFolderTones.size()];
}

bool isDayTitle(const std::string &title) {
    if (title.size() != 10) return false;
    for (size_t i = 0; i < 10; ++i) {
        const char c = title[i];
        if ((i == 4 || i == 7) ? c != '-' : (c < '0' || c > '9')) return false;
    }
    return true;
}

std::string avatarText(const std::string &title, bool isDaily) {
    if (isDaily && isDayTitle(title)) return std::to_string(std::stoi(title.substr(8, 2)));
    const auto chars = text::trimU(text::decode(title));
    if (chars.empty()) return "";
    std::string out;
    text::appendUtf8(out, upper(chars[0]));
    return out;
}

NotePreview previewLines(const std::string &title, const std::string &text, int max) {
    const auto ownTitle = text::toLower(text::trim(title));
    std::vector<NotePreviewLine> lines;
    bool isCode = false;
    for (const auto &rawLine : text::split(parseNote(text).body, '\n')) {
        const auto raw = text::decode(rawLine);
        if (text::startsWithU(text::trimU(raw), 0, U"```")) {
            isCode = !isCode;
            continue;
        }
        if (isCode) continue;
        // `^\s*[-*+] \[( |x|X)\](?: (.*))?$`, `^\s*[-*+] (.*)$`, `^#+\s+(.*)$` — `.` без концов строк
        size_t i = 0;
        while (i < raw.size() && text::isSpace(raw[i])) ++i;
        const bool isItemStart = i + 1 < raw.size() && (raw[i] == U'-' || raw[i] == U'*' || raw[i] == U'+') && raw[i + 1] == U' ';
        std::optional<std::string> mark;
        std::optional<U32> body;
        if (isItemStart && i + 5 <= raw.size() && raw[i + 2] == U'['
            && (raw[i + 3] == U' ' || raw[i + 3] == U'x' || raw[i + 3] == U'X') && raw[i + 4] == U']') {
            const size_t after = i + 5;
            if (after == raw.size()) {
                mark = raw[i + 3] == U' ' ? "todo" : "done";
                body = U32();
            } else if (raw[after] == U' ' && !hasTerminator(raw, after + 1)) {
                mark = raw[i + 3] == U' ' ? "todo" : "done";
                body = raw.substr(after + 1);
            }
        }
        if (!mark && isItemStart && !hasTerminator(raw, i + 2)) {
            mark = "bullet";
            body = raw.substr(i + 2);
        }
        bool isHeading = false;
        if (!mark) {
            size_t h = 0;
            while (h < raw.size() && raw[h] == U'#') ++h;
            size_t w = h;
            while (w < raw.size() && text::isSpace(raw[w])) ++w;
            if (h > 0 && w > h && !hasTerminator(raw, w)) {
                isHeading = true;
                mark = "heading";
                body = raw.substr(w);
            }
        }
        const auto line = slicePreview(plainInline(body ? *body : raw));
        if (line.empty() || (isHeading && text::toLower(line) == ownTitle)) continue;
        lines.push_back({line, mark});
    }
    NotePreview result;
    result.hasMore = static_cast<int>(lines.size()) > max;
    if (result.hasMore) lines.resize(static_cast<size_t>(std::max(0, max)));
    result.lines = std::move(lines);
    return result;
}

std::string previewOf(const std::string &title, const std::string &text) {
    const auto ownTitle = text::toLower(text::trim(title));
    for (const auto &rawLine : text::split(parseNote(text).body, '\n')) {
        auto raw = text::decode(rawLine);
        // `/^#+\s*|^\s*[-*+] (\[[ xX]\] )?/` — одна замена в начале строки
        if (const size_t heading = preview::headingMark(raw)) raw = raw.substr(heading);
        else if (const size_t item = preview::listMark(raw)) raw = raw.substr(item);
        raw = preview::stripTaskMarker(raw);
        U32 linked;
        size_t i = 0;
        while (i < raw.size()) {
            if (const auto link = linkAt(raw, i, 1)) {
                linked += link->title;
                i = link->end;
                continue;
            }
            linked.push_back(raw[i]);
            ++i;
        }
        const auto item = text::trimU(dropBackticks(linked));
        if (!item.empty() && text::toLower(text::encode(item)) != ownTitle) return slicePreview(item);
    }
    return "";
}

} // namespace parvane::sections::notes
