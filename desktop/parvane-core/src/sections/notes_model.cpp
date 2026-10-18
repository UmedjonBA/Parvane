// Parvane fork (spec 029, фаза 4): порт web `notes/notesModel.ts`. Регулярки web разобраны вручную по кодовым
// точкам (поведение — как у движка JS, включая откаты), комментарий у каждой функции — какая регулярка повторена.
#include "parvane/sections/notes_model.h"

#include <algorithm>
#include <random>
#include <set>

#include <nlohmann/json.hpp>

#include "notes_text.h"

namespace parvane::sections::notes {

namespace {

using namespace text;

const std::string kFrontMatterFence = "---";

// --- Пункты и метки -----------------------------------------------------------------------------------------

struct TaskMatch {
    size_t checkPos = 0;
    // Текст после `] ` (группа 4 TASK_RE); нет — пункт кончается на `]`
    std::optional<U32> rest;
};

// TASK_RE = /^(\s*[-*+]\s+\[)([ xX])(\](?:\s+(.*))?)$/
std::optional<TaskMatch> matchTask(const U32 &s) {
    const size_t n = s.size();
    size_t i = 0;
    while (i < n && isSpace(s[i])) ++i;
    if (i >= n || (s[i] != '-' && s[i] != '*' && s[i] != '+')) return std::nullopt;
    ++i;
    const size_t wsStart = i;
    while (i < n && isSpace(s[i])) ++i;
    if (i == wsStart || i >= n || s[i] != '[') return std::nullopt;
    ++i;
    if (i >= n || (s[i] != ' ' && s[i] != 'x' && s[i] != 'X')) return std::nullopt;
    TaskMatch match;
    match.checkPos = i;
    ++i;
    if (i >= n || s[i] != ']') return std::nullopt;
    ++i;
    if (i == n) return match;
    if (!isSpace(s[i])) return std::nullopt;
    while (i < n && isSpace(s[i])) ++i;
    U32 rest = s.substr(i);
    if (hasLineTerminator(rest)) return std::nullopt;
    match.rest = std::move(rest);
    return match;
}

struct MarkerMatch {
    size_t pos = 0;
    U32 marker;
};

// MARKER_RE = /\s\^(t[a-z0-9]{4,12})\s*$/ — первое совпадение; `pos` — место пробела перед `^`
std::optional<MarkerMatch> findMarker(const U32 &s) {
    const size_t n = s.size();
    for (size_t p = 0; p + 2 < n; ++p) {
        if (!isSpace(s[p]) || s[p + 1] != '^' || s[p + 2] != 't') continue;
        size_t q = p + 3;
        while (q < n && ((s[q] >= 'a' && s[q] <= 'z') || isAsciiDigit(s[q]))) ++q;
        const size_t run = q - (p + 3);
        if (run < 4 || run > 12) continue;
        bool isTail = true;
        for (size_t k = q; k < n; ++k) {
            if (!isSpace(s[k])) {
                isTail = false;
                break;
            }
        }
        if (isTail) return MarkerMatch{p, s.substr(p + 2, run + 1)};
    }
    return std::nullopt;
}

U32 removeMarker(const U32 &s) {
    const auto marker = findMarker(s);
    return marker ? s.substr(0, marker->pos) : s;
}

std::pair<U32, U32> splitEol(const U32 &line) {
    if (!line.empty() && line.back() == '\r') return {line.substr(0, line.size() - 1), U"\r"};
    return {line, U""};
}

std::pair<std::string, std::string> splitEol(const std::string &line) {
    if (!line.empty() && line.back() == '\r') return {line.substr(0, line.size() - 1), "\r"};
    return {line, ""};
}

struct TaskInfo {
    bool isDone = false;
    U32 text;
    std::optional<U32> marker;
};

std::optional<TaskInfo> readTask(const U32 &line) {
    const auto match = matchTask(splitEol(line).first);
    if (!match) return std::nullopt;
    const U32 rest = match->rest.value_or(U"");
    const U32 spaced = U" " + rest;
    const auto marker = findMarker(spaced);
    TaskInfo info;
    info.isDone = splitEol(line).first[match->checkPos] != ' ';
    info.text = trimU(marker ? spaced.substr(0, marker->pos) : rest);
    if (marker) info.marker = marker->marker;
    return info;
}

std::optional<TaskInfo> readTask(const std::string &line) { return readTask(decode(line)); }

// --- Код в тексте -------------------------------------------------------------------------------------------

struct FenceMatch {
    U32 run;
    U32 rest;
};

// FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/
std::optional<FenceMatch> matchFence(const U32 &line) {
    const size_t n = line.size();
    size_t i = 0;
    while (i < n && line[i] == ' ') ++i;
    if (i > 3 || i >= n || (line[i] != '`' && line[i] != '~')) return std::nullopt;
    const char32_t mark = line[i];
    size_t j = i;
    while (j < n && line[j] == mark) ++j;
    if (j - i < 3) return std::nullopt;
    U32 rest = line.substr(j);
    if (hasLineTerminator(rest)) return std::nullopt;
    return FenceMatch{line.substr(i, j - i), std::move(rest)};
}

// INLINE_CODE_RE = /(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g — код заменяется пробелами (по кодовой точке на знак)
U32 maskInlineCode(const U32 &line) {
    U32 out = line;
    const size_t n = line.size();
    size_t p = 0;
    while (p < n) {
        if (line[p] != '`') {
            ++p;
            continue;
        }
        size_t runEnd = p;
        while (runEnd < n && line[runEnd] == '`') ++runEnd;
        const size_t width = runEnd - p;
        size_t end = 0;
        for (size_t c = runEnd; c < n; ++c) {
            if (line[c] == '`') continue;
            const size_t close = c + 1;
            if (close + width > n) break;
            bool isClose = true;
            for (size_t k = 0; k < width; ++k) {
                if (line[close + k] != '`') {
                    isClose = false;
                    break;
                }
            }
            if (!isClose) continue;
            if (close + width < n && line[close + width] == '`') continue;
            end = close + width;
            break;
        }
        if (!end) {
            ++p;
            continue;
        }
        for (size_t k = p; k < end; ++k) out[k] = ' ';
        p = end;
    }
    return out;
}

struct Masked {
    std::vector<U32> masked;
    std::vector<bool> fenced;
};

// Код для разбора «гасится»: строки внутри ``` помечаются, содержимое `…` заменяется пробелами той же длины
Masked maskCode(const std::vector<U32> &lines) {
    Masked result;
    std::optional<U32> fence;
    for (const U32 &line : lines) {
        const auto match = matchFence(line);
        if (fence) {
            const bool isClosing = match && match->run[0] == (*fence)[0] && match->run.size() >= fence->size()
                && trimU(match->rest).empty();
            if (isClosing) fence.reset();
        } else if (match) {
            fence = match->run;
        } else {
            result.masked.push_back(maskInlineCode(line));
            result.fenced.push_back(false);
            continue;
        }
        result.masked.push_back(U"");
        result.fenced.push_back(true);
    }
    return result;
}

std::vector<U32> decodeLines(const std::vector<std::string> &lines) {
    std::vector<U32> out;
    out.reserve(lines.size());
    for (const auto &line : lines) out.push_back(decode(line));
    return out;
}

// --- Ссылки и теги ------------------------------------------------------------------------------------------

struct LinkMatch {
    U32 target;
    std::optional<U32> alias;
    size_t from = 0;
    size_t to = 0;
};

// LINK_RE = /\[\[([^[\]|]+)(?:\|([^[\]]*))?\]\]/g — все совпадения
std::vector<LinkMatch> matchLinks(const U32 &s) {
    std::vector<LinkMatch> out;
    const size_t n = s.size();
    size_t p = 0;
    while (p + 1 < n) {
        if (s[p] != '[' || s[p + 1] != '[') {
            ++p;
            continue;
        }
        const size_t i = p + 2;
        size_t j = i;
        while (j < n && s[j] != '[' && s[j] != ']' && s[j] != '|') ++j;
        bool isMatch = false;
        LinkMatch link;
        if (j > i && j < n) {
            if (s[j] == '|') {
                size_t k = j + 1;
                while (k < n && s[k] != '[' && s[k] != ']') ++k;
                if (k + 1 < n && s[k] == ']' && s[k + 1] == ']') {
                    link = LinkMatch{s.substr(i, j - i), s.substr(j + 1, k - j - 1), p, k + 2};
                    isMatch = true;
                }
            } else if (s[j] == ']' && j + 1 < n && s[j + 1] == ']') {
                link = LinkMatch{s.substr(i, j - i), std::nullopt, p, j + 2};
                isMatch = true;
            }
        }
        if (!isMatch) {
            ++p;
            continue;
        }
        p = link.to;
        out.push_back(std::move(link));
    }
    return out;
}

std::vector<LinkMatch> findLinks(const U32 &maskedLine) {
    std::vector<LinkMatch> out;
    for (auto &link : matchLinks(maskedLine)) {
        if (!trimU(link.target).empty()) out.push_back(std::move(link));
    }
    return out;
}

bool isTagChar(char32_t c) {
    return isLetter(c) || isNumber(c) || c == '_' || c == '/' || c == '-';
}

// TAG_RE = /(^|\s)#([\p{L}\p{N}_/-]+)/gu по строке без ссылок; хвост из `-`/`/` срезается, нужна хоть одна буква
std::vector<U32> findTags(const U32 &maskedLine) {
    U32 s = maskedLine;
    for (const auto &link : matchLinks(maskedLine)) {
        for (size_t k = link.from; k < link.to; ++k) s[k] = ' ';
    }
    std::vector<U32> tags;
    const size_t n = s.size();
    size_t p = 0;
    while (p < n) {
        size_t hash = std::string::npos;
        if (p == 0 && s[0] == '#') hash = 0;
        else if (isSpace(s[p]) && p + 1 < n && s[p + 1] == '#') hash = p + 1;
        if (hash != std::string::npos) {
            size_t end = hash + 1;
            while (end < n && isTagChar(s[end])) ++end;
            if (end > hash + 1) {
                U32 tag = s.substr(hash + 1, end - hash - 1);
                while (!tag.empty() && (tag.back() == '-' || tag.back() == '/')) tag.pop_back();
                if (std::any_of(tag.begin(), tag.end(), [](char32_t c) { return isLetter(c); })) {
                    tags.push_back(std::move(tag));
                }
                p = end;
                continue;
            }
        }
        ++p;
    }
    return tags;
}

// --- Превью -------------------------------------------------------------------------------------------------

bool isHorizontalRule(const U32 &s) {
    // /^\s*([-*_])(\s*\1){2,}\s*$/
    char32_t mark = 0;
    int count = 0;
    for (char32_t c : s) {
        if (isSpace(c)) continue;
        if (!mark) {
            if (c != '-' && c != '*' && c != '_') return false;
            mark = c;
        } else if (c != mark) {
            return false;
        }
        ++count;
    }
    return count >= 3;
}

U32 stripMarkdown(const U32 &line) {
    U32 s = splitEol(line).first;
    if (isHorizontalRule(s)) return U"";
    // /^\s*(?:>\s*)*/
    {
        size_t i = 0;
        while (i < s.size() && (isSpace(s[i]) || s[i] == '>')) ++i;
        s = s.substr(i);
    }
    // /^#{1,6}(?:\s+|$)/
    {
        size_t i = 0;
        while (i < s.size() && s[i] == '#') ++i;
        if (i >= 1 && i <= 6) {
            if (i == s.size()) {
                s.clear();
            } else if (isSpace(s[i])) {
                while (i < s.size() && isSpace(s[i])) ++i;
                s = s.substr(i);
            }
        }
    }
    // /^[-*+]\s+(?:\[[ xX]\]\s*)?/
    if (!s.empty() && (s[0] == '-' || s[0] == '*' || s[0] == '+') && s.size() > 1 && isSpace(s[1])) {
        size_t i = 1;
        while (i < s.size() && isSpace(s[i])) ++i;
        if (i + 2 < s.size() && s[i] == '[' && (s[i + 1] == ' ' || s[i + 1] == 'x' || s[i + 1] == 'X')
            && s[i + 2] == ']') {
            i += 3;
            while (i < s.size() && isSpace(s[i])) ++i;
        }
        s = s.substr(i);
    }
    // /^\d+[.)]\s+/
    {
        size_t i = 0;
        while (i < s.size() && isAsciiDigit(s[i])) ++i;
        if (i > 0 && i + 1 < s.size() && (s[i] == '.' || s[i] == ')') && isSpace(s[i + 1])) {
            i += 1;
            while (i < s.size() && isSpace(s[i])) ++i;
            s = s.substr(i);
        }
    }
    s = removeMarker(s);
    // LINK_RE → (подпись || цель).trim()
    {
        U32 out;
        size_t at = 0;
        for (const auto &link : matchLinks(s)) {
            out += s.substr(at, link.from - at);
            out += trimU(link.alias && !link.alias->empty() ? *link.alias : link.target);
            at = link.to;
        }
        out += s.substr(at);
        s = std::move(out);
    }
    // /!?\[([^\]]*)\]\([^)]*\)/g → $1
    {
        U32 out;
        const size_t n = s.size();
        size_t p = 0;
        auto tryAt = [&](size_t open, size_t &end, U32 &label) {
            if (open >= n || s[open] != '[') return false;
            size_t j = open + 1;
            while (j < n && s[j] != ']') ++j;
            if (j + 1 >= n || s[j + 1] != '(') return false;
            size_t k = j + 2;
            while (k < n && s[k] != ')') ++k;
            if (k >= n) return false;
            label = s.substr(open + 1, j - open - 1);
            end = k + 1;
            return true;
        };
        while (p < n) {
            size_t end = 0;
            U32 label;
            if ((s[p] == '!' && tryAt(p + 1, end, label)) || tryAt(p, end, label)) {
                out += label;
                p = end;
                continue;
            }
            out.push_back(s[p]);
            ++p;
        }
        s = std::move(out);
    }
    // /(\*\*|__|~~|==|`)/g → ''
    {
        U32 out;
        const size_t n = s.size();
        size_t p = 0;
        while (p < n) {
            if (p + 1 < n && s[p] == s[p + 1] && (s[p] == '*' || s[p] == '_' || s[p] == '~' || s[p] == '=')) {
                p += 2;
                continue;
            }
            if (s[p] == '`') {
                ++p;
                continue;
            }
            out.push_back(s[p]);
            ++p;
        }
        s = std::move(out);
    }
    // /(^|[^\p{L}\p{N}])[*_]([^*_]+)[*_](?![\p{L}\p{N}])/gu → $1$2
    {
        U32 out;
        const size_t n = s.size();
        size_t p = 0;
        auto isMarkChar = [](char32_t c) { return c == '*' || c == '_'; };
        auto isWord = [](char32_t c) { return isLetter(c) || isNumber(c); };
        // Курсив с `open` (знак `*`/`_`): конец совпадения либо 0
        auto italicAt = [&](size_t open, U32 &inner) -> size_t {
            if (open >= n || !isMarkChar(s[open])) return 0;
            size_t j = open + 1;
            while (j < n && !isMarkChar(s[j])) ++j;
            if (j == open + 1 || j >= n) return 0;
            if (j + 1 < n && isWord(s[j + 1])) return 0;
            inner = s.substr(open + 1, j - open - 1);
            return j + 1;
        };
        while (p < n) {
            U32 inner;
            size_t end = 0;
            if (p == 0 && (end = italicAt(0, inner))) {
                out += inner;
                p = end;
                continue;
            }
            if (!isWord(s[p]) && (end = italicAt(p + 1, inner))) {
                out.push_back(s[p]);
                out += inner;
                p = end;
                continue;
            }
            out.push_back(s[p]);
            ++p;
        }
        s = std::move(out);
    }
    // /\s+/g → ' ', trim
    {
        U32 out;
        bool isGap = false;
        for (char32_t c : s) {
            if (isSpace(c)) {
                if (!isGap) out.push_back(' ');
                isGap = true;
            } else {
                out.push_back(c);
                isGap = false;
            }
        }
        s = trimU(out);
    }
    return s;
}

U32 buildPreview(const std::vector<U32> &lines, const std::vector<bool> &fenced) {
    for (size_t i = 0; i < lines.size(); ++i) {
        if (fenced[i]) continue;
        const U32 plain = stripMarkdown(lines[i]);
        if (plain.empty()) continue;
        if (plain.size() > static_cast<size_t>(kPreviewLength)) {
            return trimEndU(plain.substr(0, kPreviewLength - 1)) + U"…";
        }
        return plain;
    }
    return U"";
}

// --- Свойства -----------------------------------------------------------------------------------------------

std::string parseScalar(const std::string &raw) {
    const std::string value = trim(raw);
    if (value.size() >= 2 && value.front() == '"' && value.back() == '"') {
        try {
            const auto parsed = nlohmann::json::parse(value);
            if (parsed.is_string()) return parsed.get<std::string>();
        } catch (...) {
            // Не JSON-строка: кавычки снимаются как есть
        }
        return value.substr(1, value.size() - 2);
    }
    if (value.size() >= 2 && value.front() == '\'' && value.back() == '\'') {
        const std::string inner = value.substr(1, value.size() - 2);
        std::string out;
        for (size_t i = 0; i < inner.size(); ++i) {
            out.push_back(inner[i]);
            if (inner[i] == '\'' && i + 1 < inner.size() && inner[i + 1] == '\'') ++i;
        }
        return out;
    }
    return value;
}

std::vector<std::string> splitInlineList(const std::string &inner) {
    std::vector<std::string> items;
    std::string current;
    char quote = 0;
    for (size_t i = 0; i < inner.size(); ++i) {
        const char ch = inner[i];
        if (quote) {
            current.push_back(ch);
            if (ch == '\\' && quote == '"' && i + 1 < inner.size()) {
                ++i;
                current.push_back(inner[i]);
            } else if (ch == quote) {
                quote = 0;
            }
        } else if (ch == ',') {
            items.push_back(current);
            current.clear();
        } else {
            if ((ch == '"' || ch == '\'') && trim(current).empty()) quote = ch;
            current.push_back(ch);
        }
    }
    if (!trim(current).empty() || !items.empty()) items.push_back(current);
    return items;
}

// PROPERTY_ITEM_RE = /^\s*-(?:\s+(.*))?$/ — пункт списка свойства; нет совпадения — std::nullopt
std::optional<U32> matchPropertyItem(const U32 &s) {
    const size_t n = s.size();
    size_t i = 0;
    while (i < n && isSpace(s[i])) ++i;
    if (i >= n || s[i] != '-') return std::nullopt;
    ++i;
    if (i == n) return U32();
    if (!isSpace(s[i])) return std::nullopt;
    while (i < n && isSpace(s[i])) ++i;
    U32 rest = s.substr(i);
    if (hasLineTerminator(rest)) return std::nullopt;
    return rest;
}

struct PropertyPair {
    U32 key;
    U32 value;
};

// PROPERTY_RE = /^([^\s:#-][^:]*?)\s*:(?:\s+(.*))?$/
std::optional<PropertyPair> matchProperty(const U32 &s) {
    const size_t n = s.size();
    if (!n || isSpace(s[0]) || s[0] == ':' || s[0] == '#' || s[0] == '-') return std::nullopt;
    const size_t colon = s.find(U':');
    if (colon == U32::npos) return std::nullopt;
    PropertyPair pair{trimEndU(s.substr(0, colon)), U32()};
    size_t j = colon + 1;
    if (j == n) return pair;
    if (!isSpace(s[j])) return std::nullopt;
    while (j < n && isSpace(s[j])) ++j;
    U32 rest = s.substr(j);
    if (hasLineTerminator(rest)) return std::nullopt;
    pair.value = std::move(rest);
    return pair;
}

std::optional<NoteProperties> parseProperties(const std::vector<std::string> &lines) {
    NoteProperties properties;
    std::optional<std::string> listKey;
    for (const auto &raw : lines) {
        const U32 line = trimEndU(decode(raw));
        if (line.empty()) continue;

        if (const auto item = matchPropertyItem(line)) {
            if (!listKey) return std::nullopt;
            const PropertyValue *existing = properties.get(*listKey);
            std::vector<std::string> list = existing && existing->isList ? existing->list
                                                                         : std::vector<std::string>{};
            list.push_back(parseScalar(encode(*item)));
            properties.set(*listKey, PropertyValue::items(std::move(list)));
            continue;
        }

        const auto pair = matchProperty(line);
        if (!pair) return std::nullopt;
        const std::string key = encode(pair->key);
        const std::string value = trim(encode(pair->value));
        if (value.empty()) listKey = key;
        else listKey.reset();
        const bool isList = startsWith(value, "[") && endsWith(value, "]")
            && !(startsWith(value, "[[") && endsWith(value, "]]"));
        if (isList) {
            std::vector<std::string> list;
            for (const auto &part : splitInlineList(value.substr(1, value.size() - 2))) {
                list.push_back(parseScalar(part));
            }
            properties.set(key, PropertyValue::items(std::move(list)));
        } else {
            properties.set(key, PropertyValue::text(parseScalar(value)));
        }
    }
    return properties;
}

struct FrontMatter {
    NoteProperties properties;
    std::string body;
    int bodyLine = 0;
};

FrontMatter splitFrontMatter(const std::string &text) {
    const FrontMatter none{NoteProperties{}, text, 0};
    const auto lines = split(text, '\n');
    if (trimEnd(lines[0]) != kFrontMatterFence) return none;
    size_t end = 0;
    for (size_t i = 1; i < lines.size(); ++i) {
        if (trimEnd(lines[i]) == kFrontMatterFence) {
            end = i;
            break;
        }
    }
    if (!end) return none;
    // Блок, который не разобрался целиком, остаётся текстом заметки: ничего не теряем
    auto properties = parseProperties(std::vector<std::string>(lines.begin() + 1, lines.begin() + end));
    if (!properties) return none;
    return FrontMatter{std::move(*properties),
        join(std::vector<std::string>(lines.begin() + end + 1, lines.end()), "\n"), static_cast<int>(end + 1)};
}

std::string serializeScalar(const std::string &value, bool isListItem) {
    static const std::string kQuotedStart = "\"'[]{}#&*!|>%@`";
    const bool needsQuotes = value.empty() || value != trim(value)
        || kQuotedStart.find(value[0]) != std::string::npos
        || value.find('\n') != std::string::npos || value.find('\r') != std::string::npos
        || value == "-" || startsWith(value, "- ")
        || (isListItem && (value.find(',') != std::string::npos || value.find(']') != std::string::npos));
    return needsQuotes ? jsonQuote(value) : value;
}

std::string editLine(const std::string &text, int line, const std::function<std::string(const std::string &)> &edit) {
    auto lines = split(text, '\n');
    if (line < 0 || line >= static_cast<int>(lines.size())) return text;
    const auto [content, eol] = splitEol(lines[line]);
    lines[line] = edit(content) + eol;
    return join(lines, "\n");
}

std::set<std::string> collectMarkers(const std::vector<std::string> &lines) {
    std::set<std::string> markers;
    for (const auto &line : lines) {
        const auto task = readTask(line);
        if (task && task->marker) markers.insert(encode(*task->marker));
    }
    return markers;
}

std::string makeFreeMarker(std::set<std::string> &used, const MakeId &makeId) {
    for (int attempt = 0; attempt < kMarkerAttempts; ++attempt) {
        const std::string marker = "t" + makeId();
        if (!used.count(marker)) {
            used.insert(marker);
            return marker;
        }
    }
    // Генератор повторяется: добавляем счётчик, чтобы метка всё же была своей
    long long suffix = static_cast<long long>(used.size());
    while (used.count("t" + makeId() + toBase36(suffix))) ++suffix;
    const std::string marker = "t" + makeId() + toBase36(suffix);
    used.insert(marker);
    return marker;
}

// Без регистра и с «ё» = «е», число кодовых точек сохраняется (буквы вроде «İ», меняющие длину при смене
// регистра, остаются как есть) — участки совпадения годятся для исходной строки
U32 normalizeSearchU(const U32 &value) {
    U32 out;
    out.reserve(value.size());
    for (char32_t c : value) {
        const U32 lower = lowerFull(c);
        char32_t safe = lower.size() == 1 ? lower[0] : c;
        if (safe == 0x451) safe = 0x435;
        out.push_back(safe);
    }
    return out;
}

std::string normalizeSearch(const std::string &value) { return encode(normalizeSearchU(decode(value))); }

std::vector<std::string> splitTerms(const std::string &value) {
    std::vector<std::string> out;
    U32 current;
    for (char32_t c : decode(value)) {
        if (isSpace(c)) {
            if (!current.empty()) out.push_back(encode(current));
            current.clear();
        } else {
            current.push_back(c);
        }
    }
    if (!current.empty()) out.push_back(encode(current));
    return out;
}

} // namespace

// --- NoteProperties -----------------------------------------------------------------------------------------

void NoteProperties::set(const std::string &key, PropertyValue value) {
    for (auto &entry : entries) {
        if (entry.first == key) {
            entry.second = std::move(value);
            return;
        }
    }
    entries.emplace_back(key, std::move(value));
}

const PropertyValue *NoteProperties::get(const std::string &key) const {
    for (const auto &entry : entries) {
        if (entry.first == key) return &entry.second;
    }
    return nullptr;
}

bool NoteProperties::operator==(const NoteProperties &other) const {
    if (entries.size() != other.entries.size()) return false;
    for (const auto &entry : entries) {
        const PropertyValue *value = other.get(entry.first);
        if (!value || !(*value == entry.second)) return false;
    }
    return true;
}

// --- Разбор и запись ----------------------------------------------------------------------------------------

ParsedNote parseNote(const std::string &text) {
    FrontMatter front = splitFrontMatter(text);
    const auto lines = decodeLines(split(front.body, '\n'));
    const Masked masked = maskCode(lines);

    std::vector<std::pair<std::string, std::string>> links;
    std::vector<std::pair<std::string, std::string>> tags;
    std::vector<NoteTask> tasks;
    for (size_t index = 0; index < lines.size(); ++index) {
        if (masked.fenced[index]) continue;
        for (const auto &link : findLinks(masked.masked[index])) {
            const std::string key = normalizeNoteTitle(encode(link.target));
            const bool isKnown = std::any_of(links.begin(), links.end(), [&](const auto &item) {
                return item.first == key;
            });
            if (!key.empty() && !isKnown) links.emplace_back(key, encode(trimU(link.target)));
        }
        for (const auto &tag : findTags(masked.masked[index])) {
            const std::string key = encode(toLower(tag));
            const bool isKnown = std::any_of(tags.begin(), tags.end(), [&](const auto &item) {
                return item.first == key;
            });
            if (!isKnown) tags.emplace_back(key, encode(tag));
        }
        if (const auto task = readTask(lines[index])) {
            NoteTask item;
            item.line = front.bodyLine + static_cast<int>(index);
            item.isDone = task->isDone;
            item.text = encode(task->text);
            if (task->marker) item.marker = encode(*task->marker);
            tasks.push_back(std::move(item));
        }
    }

    ParsedNote parsed;
    parsed.properties = std::move(front.properties);
    parsed.body = std::move(front.body);
    for (auto &link : links) parsed.links.push_back(std::move(link.second));
    for (auto &tag : tags) parsed.tags.push_back(std::move(tag.second));
    parsed.tasks = std::move(tasks);
    parsed.preview = encode(buildPreview(lines, masked.fenced));
    return parsed;
}

std::string serializeNote(const NoteProperties &properties, const std::string &body) {
    std::vector<std::string> lines;
    for (const auto &[key, value] : properties.entries) {
        if (value.isList) {
            std::vector<std::string> items;
            for (const auto &item : value.list) items.push_back(serializeScalar(item, true));
            lines.push_back(key + ": [" + join(items, ", ") + "]");
        } else {
            lines.push_back(key + ": " + serializeScalar(value.scalar, false));
        }
    }
    if (lines.empty()) return body;
    std::vector<std::string> all{kFrontMatterFence};
    all.insert(all.end(), lines.begin(), lines.end());
    all.push_back(kFrontMatterFence);
    all.push_back(body);
    return join(all, "\n");
}

std::string normalizeNoteTitle(const std::string &title) {
    return encode(toLower(trimU(decode(title))));
}

std::string noteSearchText(const std::string &text) { return normalizeSearch(text); }

// --- Пункты -------------------------------------------------------------------------------------------------

std::string setTaskDone(const std::string &text, int line, bool isDone) {
    return editLine(text, line, [&](const std::string &content) {
        U32 s = decode(content);
        const auto match = matchTask(s);
        if (!match) return content;
        s[match->checkPos] = isDone ? U'x' : U' ';
        return encode(s);
    });
}

EnsureMarkerResult ensureTaskMarker(const std::string &text, int line, const MakeId &makeId) {
    const auto lines = split(text, '\n');
    const auto task = line >= 0 && line < static_cast<int>(lines.size()) ? readTask(lines[line])
                                                                           : std::optional<TaskInfo>{};
    if (!task) return {text, std::nullopt};
    if (task->marker) return {text, encode(*task->marker)};

    auto used = collectMarkers(lines);
    const std::string marker = makeFreeMarker(used, makeId);
    return {editLine(text, line, [&](const std::string &content) { return trimEnd(content) + " ^" + marker; }),
        marker};
}

std::optional<int> findTaskLine(const std::string &text, const std::string &marker) {
    const std::string wanted = startsWith(marker, "^") ? marker.substr(1) : marker;
    const auto lines = decodeLines(split(text, '\n'));
    const Masked masked = maskCode(lines);
    for (size_t i = 0; i < lines.size(); ++i) {
        if (masked.fenced[i]) continue;
        const auto task = readTask(lines[i]);
        if (task && task->marker && encode(*task->marker) == wanted) return static_cast<int>(i);
    }
    return std::nullopt;
}

std::string removeTaskLine(const std::string &text, const std::string &marker) {
    const auto line = findTaskLine(text, marker);
    if (!line) return text;
    auto lines = split(text, '\n');
    lines.erase(lines.begin() + *line);
    return join(lines, "\n");
}

DedupeMarkersResult dedupeTaskMarkers(const std::string &text, const MakeId &makeId) {
    auto lines = split(text, '\n');
    const Masked masked = maskCode(decodeLines(lines));
    auto used = collectMarkers(lines);
    std::set<std::string> seen;
    std::vector<TaskMarkerChange> changes;

    for (size_t index = 0; index < lines.size(); ++index) {
        if (masked.fenced[index]) continue;
        const auto task = readTask(lines[index]);
        if (!task || !task->marker) continue;
        const std::string oldMarker = encode(*task->marker);
        if (!seen.count(oldMarker)) {
            seen.insert(oldMarker);
            continue;
        }
        const std::string newMarker = makeFreeMarker(used, makeId);
        const auto [content, eol] = splitEol(decode(lines[index]));
        lines[index] = encode(removeMarker(content)) + " ^" + newMarker + encode(eol);
        changes.push_back({static_cast<int>(index), oldMarker, newMarker});
    }

    return {changes.empty() ? text : join(lines, "\n"), changes};
}

std::string makeRandomMarkerId() {
    static const char *kDigits = "0123456789abcdefghijklmnopqrstuvwxyz";
    static thread_local std::mt19937 random{std::random_device{}()};
    std::uniform_int_distribution<int> pick(0, 35);
    std::string id;
    for (int i = 0; i < kMarkerIdLength; ++i) id.push_back(kDigits[pick(random)]);
    return id;
}

// --- Указатель ----------------------------------------------------------------------------------------------

NotesIndex::NotesIndex(const std::vector<NoteSource> &sources) {
    for (const auto &source : sources) {
        // Одноимённые заметки из разных папок: ссылка ведёт на первую в списке
        idByTitle_.emplace(normalizeNoteTitle(source.title), source.id);
    }

    notes_.reserve(sources.size());
    for (const auto &source : sources) {
        IndexedNote note;
        static_cast<NoteSource &>(note) = source;
        note.parsed = parseNote(source.text);
        for (const auto &link : note.parsed.links) {
            const auto found = idByTitle_.find(normalizeNoteTitle(link));
            if (found == idByTitle_.end()) {
                note.unresolved.push_back(link);
            } else if (found->second != source.id
                && std::find(note.linkedIds.begin(), note.linkedIds.end(), found->second) == note.linkedIds.end()) {
                note.linkedIds.push_back(found->second);
            }
        }
        notes_.push_back(std::move(note));
    }

    // Как `new Map(notes.map(...))`: повторный id перезаписывает прежний
    for (size_t i = 0; i < notes_.size(); ++i) indexById_[notes_[i].id] = i;

    std::vector<std::pair<std::string, size_t>> missingOrder;
    std::vector<std::pair<std::string, int>> tagCounts;
    for (size_t i = 0; i < notes_.size(); ++i) {
        const auto &note = notes_[i];
        for (const auto &targetId : note.linkedIds) backlinks_[targetId].push_back(i);
        for (const auto &title : note.unresolved) {
            const std::string key = normalizeNoteTitle(title);
            auto found = std::find_if(missingOrder.begin(), missingOrder.end(), [&](const auto &item) {
                return item.first == key;
            });
            if (found == missingOrder.end()) {
                missingOrder.emplace_back(key, unresolved_.size());
                unresolved_.push_back({title, {}});
                found = missingOrder.end() - 1;
            }
            unresolved_[found->second].fromIds.push_back(note.id);
        }
        for (const auto &tag : note.parsed.tags) {
            const std::string key = encode(toLower(decode(tag)));
            auto found = std::find_if(tagCounts.begin(), tagCounts.end(), [&](const auto &item) {
                return item.first == key;
            });
            if (found == tagCounts.end()) tagCounts.emplace_back(key, 1);
            else ++found->second;
        }
    }

    for (const auto &[tag, count] : tagCounts) tags_.push_back({tag, count});
    std::stable_sort(tags_.begin(), tags_.end(), [](const TagCount &a, const TagCount &b) {
        if (a.count != b.count) return a.count > b.count;
        return localeCompare(a.tag, b.tag) < 0;
    });

    for (const auto &note : notes_) haystacks_.emplace_back(normalizeSearch(note.title), noteSearchText(note.text));
}

const IndexedNote *NotesIndex::byId(const std::string &noteId) const {
    const auto found = indexById_.find(noteId);
    return found == indexById_.end() ? nullptr : &notes_[found->second];
}

const IndexedNote *NotesIndex::byTitle(const std::string &title) const {
    const auto found = idByTitle_.find(normalizeNoteTitle(title));
    return found == idByTitle_.end() ? nullptr : byId(found->second);
}

std::vector<const IndexedNote *> NotesIndex::backlinks(const std::string &noteId) const {
    std::vector<const IndexedNote *> out;
    const auto found = backlinks_.find(noteId);
    if (found == backlinks_.end()) return out;
    for (size_t index : found->second) out.push_back(&notes_[index]);
    return out;
}

std::vector<const IndexedNote *> NotesIndex::search(const std::string &query) const {
    const auto terms = splitTerms(normalizeSearch(query));
    std::vector<const IndexedNote *> inTitle;
    std::vector<const IndexedNote *> inText;
    for (size_t i = 0; i < notes_.size(); ++i) {
        const auto &[title, textValue] = haystacks_[i];
        const bool isInTitle = std::all_of(terms.begin(), terms.end(), [&](const std::string &term) {
            return title.find(term) != std::string::npos;
        });
        if (isInTitle) {
            inTitle.push_back(&notes_[i]);
            continue;
        }
        const bool isInText = std::all_of(terms.begin(), terms.end(), [&](const std::string &term) {
            return title.find(term) != std::string::npos || textValue.find(term) != std::string::npos;
        });
        if (isInText) inText.push_back(&notes_[i]);
    }
    const auto byUpdated = [](const IndexedNote *a, const IndexedNote *b) { return a->updatedAt > b->updatedAt; };
    std::stable_sort(inTitle.begin(), inTitle.end(), byUpdated);
    std::stable_sort(inText.begin(), inText.end(), byUpdated);
    inTitle.insert(inTitle.end(), inText.begin(), inText.end());
    return inTitle;
}

// --- Ссылки -------------------------------------------------------------------------------------------------

std::string renameLinks(const std::string &text, const std::string &oldTitle, const std::string &newTitle) {
    const std::string oldKey = normalizeNoteTitle(oldTitle);
    const auto lines = decodeLines(split(text, '\n'));
    const Masked masked = maskCode(lines);
    const U32 next = decode(newTitle);
    std::vector<std::string> out;
    for (size_t index = 0; index < lines.size(); ++index) {
        const U32 &line = lines[index];
        if (masked.fenced[index]) {
            out.push_back(encode(line));
            continue;
        }
        U32 result;
        size_t position = 0;
        for (const auto &link : findLinks(masked.masked[index])) {
            if (normalizeNoteTitle(encode(link.target)) != oldKey) continue;
            result += line.substr(position, link.from - position);
            result += U"[[" + next + (link.alias ? U"|" + *link.alias : U"") + U"]]";
            position = link.to;
        }
        result += line.substr(position);
        out.push_back(encode(result));
    }
    return join(out, "\n");
}

NoteLines scanNoteLines(const std::string &text) {
    const FrontMatter front = splitFrontMatter(text);
    NoteLines result;
    result.lines = split(text, '\n');
    const Masked masked = maskCode(decodeLines(split(front.body, '\n')));
    for (size_t index = 0; index < result.lines.size(); ++index) {
        const bool isSkipped = static_cast<int>(index) < front.bodyLine
            || masked.fenced[index - static_cast<size_t>(front.bodyLine)];
        result.skipped.push_back(isSkipped);
        std::vector<NoteLineLink> links;
        if (!isSkipped) {
            const U32 original = decode(result.lines[index]);
            for (const auto &link : findLinks(masked.masked[index - static_cast<size_t>(front.bodyLine)])) {
                NoteLineLink item;
                item.target = encode(link.target);
                if (link.alias) item.alias = encode(*link.alias);
                item.from = byteOffset(original, link.from);
                item.to = byteOffset(original, link.to);
                links.push_back(std::move(item));
            }
        }
        result.links.push_back(std::move(links));
    }
    return result;
}

std::string dailyNoteTitle(const std::string &day) { return day; }

std::string dailyNoteTemplate(const std::string &day) { return "# " + day + "\n\n- [ ] \n"; }

} // namespace parvane::sections::notes
