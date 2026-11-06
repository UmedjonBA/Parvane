// Parvane fork (spec 029, фаза 4; доработка 6 ноя 2026): порт web `markdown/markdown.ts` (разбор без отрисовки).
// Регулярки web разобраны вручную по кодовым точкам; у функций — какая регулярка повторена. Сверка с web — общий
// образец `conformance/markdown/` (tests/sections/markdown_tests.cpp).
#include "parvane/sections/markdown.h"

#include <algorithm>
#include <set>
#include <vector>

#include "notes_text.h"

namespace parvane::sections::markdown {

namespace {

using namespace notes::text;

bool isAllSpace(const U32 &s, size_t from) {
    for (size_t i = from; i < s.size(); ++i) {
        if (!isSpace(s[i])) return false;
    }
    return true;
}

struct EmbedMatch {
    // `![[…]]` — группы 1 и 2; иначе `![…](…)` — группы 3 и 4
    bool isWiki = false;
    U32 file;
    std::optional<U32> caption;
    U32 label;
    U32 target;
};

// EMBED = /^\s*!(?:\[\[([^\]|]+)(?:\|([^\]]*))?\]\]|\[([^\]]*)\]\(([^)\s]+)[^)]*\))\s*$/
std::optional<EmbedMatch> matchEmbed(const U32 &s) {
    const size_t n = s.size();
    size_t i = 0;
    while (i < n && isSpace(s[i])) ++i;
    if (i >= n || s[i] != '!') return std::nullopt;
    ++i;
    if (i + 1 < n && s[i] == '[' && s[i + 1] == '[') {
        const size_t j = i + 2;
        size_t k = j;
        while (k < n && s[k] != ']' && s[k] != '|') ++k;
        if (k > j && k < n) {
            if (s[k] == '|') {
                size_t m = k + 1;
                while (m < n && s[m] != ']') ++m;
                if (m + 1 < n && s[m] == ']' && s[m + 1] == ']' && isAllSpace(s, m + 2)) {
                    return EmbedMatch{true, s.substr(j, k - j), s.substr(k + 1, m - k - 1), U32(), U32()};
                }
            } else if (k + 1 < n && s[k + 1] == ']' && isAllSpace(s, k + 2)) {
                return EmbedMatch{true, s.substr(j, k - j), std::nullopt, U32(), U32()};
            }
        }
    }
    if (i < n && s[i] == '[') {
        const size_t j = i + 1;
        size_t k = j;
        while (k < n && s[k] != ']') ++k;
        if (k + 1 < n && s[k + 1] == '(') {
            const size_t start = k + 2;
            size_t m = start;
            while (m < n && s[m] != ')' && !isSpace(s[m])) ++m;
            if (m > start) {
                size_t r = m;
                while (r < n && s[r] != ')') ++r;
                if (r < n && isAllSpace(s, r + 1)) {
                    return EmbedMatch{false, U32(), std::nullopt, s.substr(j, k - j), s.substr(start, m - start)};
                }
            }
        }
    }
    return std::nullopt;
}

// TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/
bool isTableSeparator(const U32 &s) {
    const size_t n = s.size();
    size_t i = 0;
    const auto skipSpace = [&] { while (i < n && isSpace(s[i])) ++i; };
    // Ячейка `:?-{3,}:?\s*`
    const auto cell = [&] {
        size_t j = i;
        if (j < n && s[j] == ':') ++j;
        const size_t dashes = j;
        while (j < n && s[j] == '-') ++j;
        if (j - dashes < 3) return false;
        if (j < n && s[j] == ':') ++j;
        while (j < n && isSpace(s[j])) ++j;
        i = j;
        return true;
    };
    skipSpace();
    if (i < n && s[i] == '|') ++i;
    skipSpace();
    if (!cell()) return false;
    while (i < n && s[i] == '|') {
        const size_t save = i;
        ++i;
        skipSpace();
        if (!cell()) {
            i = save;
            break;
        }
    }
    if (i < n && s[i] == '|') ++i;
    skipSpace();
    return i == n;
}

// Ячейки строки таблицы; `\|` — знак внутри ячейки
std::vector<std::string> splitRow(const U32 &line) {
    U32 trimmed = trimU(line);
    if (!trimmed.empty() && trimmed.front() == '|') trimmed.erase(0, 1);
    if (!trimmed.empty() && trimmed.back() == '|') trimmed.pop_back();
    std::vector<std::string> cells;
    U32 cell;
    for (size_t i = 0; i < trimmed.size(); ++i) {
        if (trimmed[i] == '\\' && i + 1 < trimmed.size() && trimmed[i + 1] == '|') {
            cell.push_back('|');
            ++i;
        } else if (trimmed[i] == '|') {
            cells.push_back(encode(trimU(cell)));
            cell.clear();
        } else {
            cell.push_back(trimmed[i]);
        }
    }
    cells.push_back(encode(trimU(cell)));
    return cells;
}

MdAlign alignOf(const std::string &cell) {
    const bool isLeft = startsWith(cell, ":");
    const bool isRight = endsWith(cell, ":");
    if (isLeft && isRight) return MdAlign::Center;
    if (isRight) return MdAlign::Right;
    return isLeft ? MdAlign::Left : MdAlign::None;
}

bool hasPrefixIgnoreCase(const std::string &value, const std::string &prefix) {
    if (value.size() < prefix.size()) return false;
    for (size_t i = 0; i < prefix.size(); ++i) {
        char c = value[i];
        if (c >= 'A' && c <= 'Z') c = static_cast<char>(c + 32);
        if (c != prefix[i]) return false;
    }
    return true;
}

// WEB_URL = /^https?:\/\//i
bool isWebUrl(const std::string &value) {
    return hasPrefixIgnoreCase(value, "http://") || hasPrefixIgnoreCase(value, "https://");
}

// SAFE_URL = /^(?:https?:|mailto:)/i
bool safeUrl(const std::string &value) {
    return hasPrefixIgnoreCase(value, "http:") || hasPrefixIgnoreCase(value, "https:")
        || hasPrefixIgnoreCase(value, "mailto:");
}

MdBlock embedOf(const EmbedMatch &match, int line) {
    MdBlock block;
    block.type = MdBlockType::Embed;
    block.line = line;
    if (match.isWiki) {
        block.name = encode(trimU(match.file));
        if (match.caption) {
            const std::string alt = encode(trimU(*match.caption));
            if (!alt.empty()) block.alt = alt;
        }
        return block;
    }
    const std::string target = encode(match.target);
    const std::string alt = encode(trimU(match.label));
    if (!alt.empty()) block.alt = alt;
    if (isWebUrl(target)) {
        block.name = target;
        block.url = target;
        return block;
    }
    // Неверная %-последовательность — имя как написано
    block.name = trim(decodeUri(target).value_or(target));
    return block;
}

// FRONT_MATTER = /^---\n[\s\S]*?\n---(?:\n|$)/
std::string frontMatterOf(const std::string &s) {
    if (!startsWith(s, "---\n")) return "";
    for (size_t pos = 4; pos + 4 <= s.size(); ++pos) {
        if (s.compare(pos, 4, "\n---") != 0) continue;
        const size_t end = pos + 4;
        if (end == s.size()) return s;
        if (s[end] == '\n') return s.substr(0, end + 1);
    }
    return "";
}

std::string normalizeEol(const std::string &text) {
    std::string out;
    out.reserve(text.size());
    for (size_t i = 0; i < text.size(); ++i) {
        if (text[i] == '\r') {
            out.push_back('\n');
            if (i + 1 < text.size() && text[i + 1] == '\n') ++i;
        } else {
            out.push_back(text[i]);
        }
    }
    return out;
}


// ── блоки ────────────────────────────────────────────────────────────────────────────────────────────────────────

constexpr int kIndentStep = 2;
constexpr int kCodeIndent = 4;
constexpr int kMaxDepth = 12;
constexpr size_t kScanLimit = 2000;
constexpr size_t kMaxTableColumns = 64;
constexpr size_t kMaxTableCells = 2000;

bool isTabOrSpace(char32_t c) { return c == ' ' || c == '\t'; }

// Значение знака по индексу; за концом строки — 0 (как `undefined` в JS: ни с чем не совпадает)
char32_t at(const U32 &s, size_t i) { return i < s.size() ? s[i] : 0; }

bool isBlank(const U32 &s) { return trimU(s).empty(); }

int columnsOf(const U32 &line) {
    int n = 0;
    for (char32_t c : line) {
        if (!isTabOrSpace(c)) break;
        n += c == '\t' ? kIndentStep : 1;
    }
    return n;
}

int columnsOfRun(const U32 &s, size_t from, size_t to) {
    int n = 0;
    for (size_t i = from; i < to; ++i) n += s[i] == '\t' ? kIndentStep : 1;
    return n;
}

U32 dedent(const U32 &line, int columns) {
    int n = 0;
    size_t i = 0;
    while (i < line.size() && n < columns && isTabOrSpace(line[i])) {
        n += line[i] == '\t' ? kIndentStep : 1;
        ++i;
    }
    return line.substr(i);
}

U32 trimStartU(const U32 &s) {
    size_t a = 0;
    while (a < s.size() && isSpace(s[a])) ++a;
    return s.substr(a);
}

bool containsU(const U32 &s, const U32 &needle, size_t from = 0) { return s.find(needle, from) != U32::npos; }

struct Fence {
    char32_t ch = 0;
    size_t length = 0;
    int indent = 0;
    std::string lang;
};

// /^([ \t]*)(`{3,}|~{3,})(.*)$/; info — trim; у ``` в info нет обратной кавычки; язык — /^[^\s{]+/ после `{?.?`
std::optional<Fence> fenceOpen(const U32 &line) {
    size_t i = 0;
    while (i < line.size() && isTabOrSpace(line[i])) ++i;
    const char32_t ch = at(line, i);
    if (ch != '`' && ch != '~') return std::nullopt;
    size_t j = i;
    while (j < line.size() && line[j] == ch) ++j;
    if (j - i < 3) return std::nullopt;
    if (hasLineTerminator(line, j)) return std::nullopt;
    const U32 info = trimU(line.substr(j));
    if (ch == '`' && containsU(info, U"`")) return std::nullopt;
    U32 rest = info;
    if (!rest.empty() && rest[0] == '{') rest.erase(0, 1);
    if (!rest.empty() && rest[0] == '.') rest.erase(0, 1);
    size_t k = 0;
    while (k < rest.size() && !isSpace(rest[k]) && rest[k] != '{') ++k;
    Fence fence;
    fence.ch = ch;
    fence.length = j - i;
    fence.indent = columnsOfRun(line, 0, i);
    fence.lang = encode(toLower(rest.substr(0, k)));
    return fence;
}

// /^[ \t]*(`{3,}|~{3,})[ \t]*$/ того же знака, не короче открытия
bool isFenceClose(const U32 &line, const Fence &fence) {
    size_t i = 0;
    while (i < line.size() && isTabOrSpace(line[i])) ++i;
    if (at(line, i) != fence.ch) return false;
    size_t j = i;
    while (j < line.size() && line[j] == fence.ch) ++j;
    if (j - i < 3 || j - i < fence.length) return false;
    while (j < line.size() && isTabOrSpace(line[j])) ++j;
    return j == line.size();
}

struct Heading {
    int level = 0;
    U32 text;
    std::string id;
};

bool isIdChar(char32_t c) { return isLetter(c) || isNumber(c) || c == '_' || c == '-'; }

// /^ {0,3}(#{1,6})[ \t]+(.+)$/, закрывающие `#`, свой id `{#id}`
std::optional<Heading> headingOf(const U32 &line) {
    size_t i = 0;
    while (i < line.size() && i < 3 && line[i] == ' ') ++i;
    const size_t hashes = i;
    while (i < line.size() && line[i] == '#') ++i;
    const size_t level = i - hashes;
    if (level < 1 || level > 6) return std::nullopt;
    const size_t spaces = i;
    while (i < line.size() && isTabOrSpace(line[i])) ++i;
    if (i == spaces || i >= line.size() || hasLineTerminator(line, i)) return std::nullopt;
    U32 text = line.substr(i);
    // .replace(/[ \t]+#+[ \t]*$/, '')
    {
        size_t e = text.size();
        while (e > 0 && isTabOrSpace(text[e - 1])) --e;
        size_t h = e;
        while (h > 0 && text[h - 1] == '#') --h;
        if (h < e && h > 0 && isTabOrSpace(text[h - 1])) {
            size_t s = h;
            while (s > 0 && isTabOrSpace(text[s - 1])) --s;
            text.erase(s);
        }
    }
    // .replace(/^#+[ \t]*$/, '')
    {
        size_t h = 0;
        while (h < text.size() && text[h] == '#') ++h;
        if (h > 0) {
            size_t e = h;
            while (e < text.size() && isTabOrSpace(text[e])) ++e;
            if (e == text.size()) text.clear();
        }
    }
    text = trimU(text);
    Heading heading;
    heading.level = static_cast<int>(level);
    // /[ \t]*\{#([\p{L}\p{N}_-]{1,100})\}$/u
    if (text.size() >= 4 && text.back() == '}') {
        size_t k = text.size() - 1;
        size_t idEnd = k;
        while (k > 0 && isIdChar(text[k - 1])) --k;
        const size_t idLength = idEnd - k;
        if (idLength >= 1 && idLength <= 100 && k >= 2 && text[k - 1] == '#' && text[k - 2] == '{') {
            heading.id = encode(text.substr(k, idLength));
            size_t s = k - 2;
            while (s > 0 && isTabOrSpace(text[s - 1])) --s;
            text = trimU(text.substr(0, s));
        }
    }
    heading.text = std::move(text);
    return heading;
}

// /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
bool isRule(const U32 &line) {
    size_t i = 0;
    while (i < line.size() && i < 3 && line[i] == ' ') ++i;
    const char32_t mark = at(line, i);
    if (mark != '-' && mark != '*' && mark != '_') return false;
    int count = 0;
    for (; i < line.size(); ++i) {
        if (line[i] == mark) ++count;
        else if (!isTabOrSpace(line[i])) return false;
    }
    return count >= 3;
}

struct ItemMatch {
    int indent = 0;
    int contentColumn = 0;
    std::optional<int> number;
    U32 text;
    std::optional<bool> isChecked;
};

// /^([ \t]*)([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/; галочка /^\[([ xX])\](?:[ \t]+(.*))?$/
std::optional<ItemMatch> itemOf(const U32 &line) {
    size_t i = 0;
    while (i < line.size() && isTabOrSpace(line[i])) ++i;
    const size_t markerFrom = i;
    std::optional<int> number;
    if (isAsciiDigit(at(line, i))) {
        while (i < line.size() && isAsciiDigit(line[i])) ++i;
        if (i - markerFrom > 9 || (at(line, i) != '.' && at(line, i) != ')')) return std::nullopt;
        number = std::stoi(encode(line.substr(markerFrom, i - markerFrom)));
        ++i;
    } else if (at(line, i) == '-' || at(line, i) == '*' || at(line, i) == '+') {
        ++i;
    } else {
        return std::nullopt;
    }
    const size_t markerTo = i;
    size_t j = i;
    while (j < line.size() && isTabOrSpace(line[j])) ++j;
    if (j == i && i < line.size()) return std::nullopt;
    if (hasLineTerminator(line, j)) return std::nullopt;
    ItemMatch item;
    item.indent = columnsOfRun(line, 0, markerFrom);
    const int spaces = j > i ? columnsOfRun(line, i, j) : 1;
    item.contentColumn = item.indent + static_cast<int>(markerTo - markerFrom) + (spaces > 4 ? 1 : spaces);
    item.number = number;
    U32 text = trimEndU(line.substr(j));
    if (text.size() >= 3 && text[0] == '[' && (text[1] == ' ' || text[1] == 'x' || text[1] == 'X') && text[2] == ']') {
        if (text.size() == 3) {
            item.isChecked = text[1] != ' ';
            text.clear();
        } else if (isTabOrSpace(text[3])) {
            item.isChecked = text[1] != ' ';
            size_t k = 3;
            while (k < text.size() && isTabOrSpace(text[k])) ++k;
            text = text.substr(k);
        }
    }
    item.text = std::move(text);
    return item;
}

// /^ {0,3}>(.*)$/, без одного пробела/табуляции после `>`
std::optional<U32> quoteOf(const U32 &line) {
    size_t i = 0;
    while (i < line.size() && i < 3 && line[i] == ' ') ++i;
    if (at(line, i) != '>') return std::nullopt;
    if (hasLineTerminator(line, i + 1)) return std::nullopt;
    U32 rest = line.substr(i + 1);
    if (!rest.empty() && isTabOrSpace(rest[0])) rest.erase(0, 1);
    return rest;
}

bool isCommentStart(const U32 &line) { return startsWithU(trimStartU(line), 0, U"<!--"); }

bool startsBlock(const U32 &line) {
    return headingOf(line) || fenceOpen(line) || isRule(line) || itemOf(line) || quoteOf(line) || matchEmbed(line)
        || isCommentStart(line);
}

std::vector<MdBlock> parseBlocks(const std::vector<U32> &lines, const std::vector<int> &lineNos, int depth);

MdBlock paragraphBlock(std::string text, int line) {
    MdBlock block;
    block.type = MdBlockType::Paragraph;
    block.text = std::move(text);
    block.line = line;
    return block;
}

std::string joinLines(const std::vector<U32> &lines, size_t from, size_t to) {
    std::string out;
    for (size_t k = from; k < to; ++k) {
        if (k > from) out += '\n';
        out += encode(lines[k]);
    }
    return out;
}

size_t parseQuote(
        const std::vector<U32> &lines, const std::vector<int> &lineNos, size_t start, int depth,
        std::vector<MdBlock> &out) {
    std::vector<U32> inner;
    std::vector<int> innerNos;
    size_t i = start;
    bool lazyAllowed = false;
    while (i < lines.size()) {
        if (const auto quoted = quoteOf(lines[i])) {
            inner.push_back(*quoted);
            innerNos.push_back(lineNos[i]);
            const U32 lead = trimStartU(*quoted);
            lazyAllowed = !isBlank(*quoted) && !startsBlock(*quoted) && !(!lead.empty() && lead[0] == '>');
            ++i;
            continue;
        }
        if (lazyAllowed && !isBlank(lines[i]) && !startsBlock(lines[i])) {
            inner.push_back(lines[i]);
            innerNos.push_back(lineNos[i]);
            ++i;
            continue;
        }
        break;
    }
    MdBlock block;
    block.type = MdBlockType::Quote;
    block.line = lineNos[start];
    // /^\[!([A-Za-z]{1,20})\]([+-]?)[ \t]*(.*)$/
    if (!inner.empty()) {
        const U32 &head = inner[0];
        if (head.size() >= 4 && head[0] == '[' && head[1] == '!') {
            size_t k = 2;
            while (k < head.size() && ((head[k] >= 'a' && head[k] <= 'z') || (head[k] >= 'A' && head[k] <= 'Z'))) ++k;
            const size_t kindLength = k - 2;
            if (kindLength >= 1 && kindLength <= 20 && at(head, k) == ']' && !hasLineTerminator(head, k)) {
                MdCallout callout;
                std::string kind = encode(head.substr(2, kindLength));
                for (auto &c : kind) {
                    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c + 32);
                }
                callout.kind = kind;
                ++k;
                if (at(head, k) == '+' || at(head, k) == '-') {
                    callout.fold = head[k] == '-' ? "closed" : "open";
                    ++k;
                }
                callout.title = encode(trimU(head.substr(std::min(k, head.size()))));
                block.callout = callout;
                inner.erase(inner.begin());
                innerNos.erase(innerNos.begin());
            }
        }
    }
    if (depth < kMaxDepth) {
        block.children = parseBlocks(inner, innerNos, depth + 1);
    } else if (!inner.empty()) {
        block.children.push_back(paragraphBlock(joinLines(inner, 0, inner.size()), innerNos[0]));
    }
    out.push_back(std::move(block));
    return i;
}

size_t parseList(
        const std::vector<U32> &lines, const std::vector<int> &lineNos, size_t start, int depth,
        std::vector<MdBlock> &out) {
    std::vector<MdListItem> items;
    // Последний номер на каждой глубине (сбрасывается пунктом мельче)
    std::vector<std::optional<int>> numbers;
    size_t i = start;
    int contentColumn = 0;
    std::vector<U32> child;
    std::vector<int> childNos;
    // Открытый блок кода среди строк пункта: строки с отступом принадлежат ему, даже если похожи на пункт
    std::optional<Fence> childFence;
    bool lazyAllowed = false;

    const auto pushChild = [&](U32 line, int lineNo) {
        if (childFence) {
            if (isFenceClose(line, *childFence)) childFence.reset();
        } else {
            childFence = fenceOpen(line);
        }
        child.push_back(std::move(line));
        childNos.push_back(lineNo);
    };
    const auto closeChild = [&] {
        while (!child.empty() && isBlank(child.back())) {
            child.pop_back();
            childNos.pop_back();
        }
        if (!items.empty() && !child.empty()) {
            std::vector<MdBlock> blocks;
            if (depth < kMaxDepth) {
                blocks = parseBlocks(child, childNos, depth + 1);
            } else {
                blocks.push_back(paragraphBlock(encode(trimU(decode(joinLines(child, 0, child.size())))), childNos[0]));
            }
            auto &target = items.back().blocks;
            for (auto &block : blocks) target.push_back(std::move(block));
        }
        child.clear();
        childNos.clear();
        childFence.reset();
    };

    while (i < lines.size()) {
        const U32 &line = lines[i];
        const auto item = itemOf(line);
        const bool inChildFence = childFence.has_value();
        if (item && !(inChildFence && columnsOf(line) >= contentColumn)) {
            if (i > start && isBlank(lines[i - 1])) break;
            closeChild();
            const int itemDepth = item->indent / kIndentStep;
            numbers.resize(itemDepth + 1);
            std::optional<int> number;
            if (item->number) {
                const auto previous = numbers[itemDepth];
                number = previous ? *previous + 1 : *item->number;
            }
            numbers[itemDepth] = number;
            MdListItem entry;
            entry.text = encode(item->text);
            entry.depth = itemDepth;
            entry.isChecked = item->isChecked;
            entry.number = number;
            entry.line = lineNos[i];
            items.push_back(std::move(entry));
            contentColumn = item->contentColumn;
            lazyAllowed = !item->text.empty();
            ++i;
            continue;
        }
        if (isBlank(line)) {
            // Пустая строка: пункт продолжается, только если дальше строка с отступом его текста
            size_t next = i + 1;
            while (next < lines.size() && isBlank(lines[next])) ++next;
            if (inChildFence
                || (next < lines.size() && columnsOf(lines[next]) >= contentColumn && !itemOf(lines[next]))) {
                for (; i < next; ++i) pushChild(U32(), lineNos[i]);
                lazyAllowed = false;
                continue;
            }
            break;
        }
        if (columnsOf(line) >= contentColumn || inChildFence) {
            pushChild(dedent(line, contentColumn), lineNos[i]);
            ++i;
            continue;
        }
        // Ленивое продолжение текста пункта: строка без отступа сразу после него
        if (lazyAllowed && child.empty() && !startsBlock(line)) {
            auto &last = items.back();
            last.text += "\n" + encode(trimU(line));
            ++i;
            continue;
        }
        break;
    }
    closeChild();
    MdBlock block;
    block.type = MdBlockType::List;
    block.isOrdered = items.front().number.has_value();
    block.items = std::move(items);
    block.line = lineNos[start];
    out.push_back(std::move(block));
    return i;
}

std::vector<MdBlock> parseBlocks(const std::vector<U32> &lines, const std::vector<int> &lineNos, int depth) {
    std::vector<MdBlock> blocks;
    std::vector<std::string> paragraph;
    int paragraphLine = 0;

    const auto flush = [&] {
        if (!paragraph.empty()) blocks.push_back(paragraphBlock(join(paragraph, "\n"), paragraphLine));
        paragraph.clear();
    };

    size_t i = 0;
    while (i < lines.size()) {
        const U32 &line = lines[i];
        const int lineNo = lineNos[i];
        if (isBlank(line)) {
            flush();
            ++i;
            continue;
        }
        // HTML-комментарий отдельной строкой либо на несколько строк — скрыт
        if (isCommentStart(line)) {
            const size_t open = line.find(U"<!--");
            const size_t close = line.find(U"-->", open + 4);
            if (close == U32::npos) {
                flush();
                ++i;
                while (i < lines.size() && !containsU(lines[i], U"-->")) ++i;
                ++i;
                continue;
            }
            if (isBlank(line.substr(close + 3))) {
                flush();
                ++i;
                continue;
            }
        }
        // Комментарий Obsidian `%%` на несколько строк — скрыт
        const U32 trimmed = trimU(line);
        if (startsWithU(trimmed, 0, U"%%")) {
            if (!containsU(trimmed, U"%%", 2)) {
                flush();
                ++i;
                while (i < lines.size() && !containsU(lines[i], U"%%")) ++i;
                ++i;
                continue;
            }
            if (trimmed.size() >= 4 && trimmed[trimmed.size() - 1] == '%' && trimmed[trimmed.size() - 2] == '%'
                && !hasLineTerminator(trimmed)) {
                flush();
                ++i;
                continue;
            }
        }
        // Код с отступом в 4 колонки (не продолжение абзаца)
        if (paragraph.empty() && columnsOf(line) >= kCodeIndent) {
            size_t end = i;
            while (end < lines.size()) {
                if (!isBlank(lines[end]) && columnsOf(lines[end]) < kCodeIndent) break;
                ++end;
            }
            while (end > i && isBlank(lines[end - 1])) --end;
            std::vector<U32> code;
            for (size_t k = i; k < end; ++k) code.push_back(dedent(lines[k], kCodeIndent));
            MdBlock block;
            block.type = MdBlockType::Code;
            block.text = joinLines(code, 0, code.size());
            block.line = lineNo;
            blocks.push_back(std::move(block));
            i = end;
            continue;
        }
        if (const auto fence = fenceOpen(line)) {
            flush();
            std::vector<U32> code;
            ++i;
            while (i < lines.size() && !isFenceClose(lines[i], *fence)) {
                code.push_back(dedent(lines[i], fence->indent));
                ++i;
            }
            ++i;
            MdBlock block;
            block.type = MdBlockType::Code;
            block.text = joinLines(code, 0, code.size());
            block.lang = fence->lang;
            block.line = lineNo;
            blocks.push_back(std::move(block));
            continue;
        }
        if (const auto heading = headingOf(line)) {
            flush();
            MdBlock block;
            block.type = MdBlockType::Heading;
            block.level = heading->level;
            block.text = encode(heading->text);
            block.id = heading->id;
            block.line = lineNo;
            blocks.push_back(std::move(block));
            ++i;
            continue;
        }
        if (isRule(line)) {
            flush();
            MdBlock block;
            block.type = MdBlockType::Rule;
            block.line = lineNo;
            blocks.push_back(std::move(block));
            ++i;
            continue;
        }
        if (const auto embed = matchEmbed(line)) {
            flush();
            blocks.push_back(embedOf(*embed, lineNo));
            ++i;
            continue;
        }
        if (line.find(U'|') != U32::npos && paragraph.empty() && i + 1 < lines.size()
            && isTableSeparator(lines[i + 1])) {
            flush();
            MdBlock block;
            block.type = MdBlockType::Table;
            block.header = splitRow(line);
            if (block.header.size() > kMaxTableColumns) block.header.resize(kMaxTableColumns);
            std::vector<MdAlign> align;
            for (const auto &cell : splitRow(lines[i + 1])) align.push_back(alignOf(cell));
            size_t next = i + 2;
            while (next < lines.size() && lines[next].find(U'|') != U32::npos && !isBlank(lines[next])) {
                // Потолок ячеек: каждая ячейка — виджет в Qt-клиенте; лишние строки съедаются
                if ((block.rows.size() + 2) * std::max<size_t>(block.header.size(), 1) <= kMaxTableCells) {
                    const auto cells = splitRow(lines[next]);
                    std::vector<std::string> row;
                    for (size_t c = 0; c < block.header.size(); ++c) row.push_back(c < cells.size() ? cells[c] : "");
                    block.rows.push_back(std::move(row));
                }
                ++next;
            }
            for (size_t c = 0; c < block.header.size(); ++c) {
                block.align.push_back(c < align.size() ? align[c] : MdAlign::None);
            }
            block.line = lineNo;
            blocks.push_back(std::move(block));
            i = next;
            continue;
        }
        if (itemOf(line)) {
            flush();
            i = parseList(lines, lineNos, i, depth, blocks);
            continue;
        }
        if (quoteOf(line)) {
            flush();
            i = parseQuote(lines, lineNos, i, depth, blocks);
            continue;
        }
        if (paragraph.empty()) paragraphLine = lineNo;
        paragraph.push_back(encode(trimmed));
        ++i;
    }
    flush();
    return blocks;
}

void assignIds(std::vector<MdBlock> &blocks, std::map<std::string, int> &used) {
    for (auto &block : blocks) {
        if (block.type == MdBlockType::Heading) {
            if (block.id.empty()) {
                const std::string base = slugOf(block.text);
                const auto found = used.find(base);
                block.id = found == used.end() ? base : base + "-" + std::to_string(found->second);
                used[base] = found == used.end() ? 1 : found->second + 1;
            }
        } else if (block.type == MdBlockType::Quote) {
            assignIds(block.children, used);
        } else if (block.type == MdBlockType::List) {
            for (auto &item : block.items) assignIds(item.blocks, used);
        }
    }
}

// ── строка ───────────────────────────────────────────────────────────────────────────────────────────────────────

const U32 kPunct = U"!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";

bool isPunct(char32_t c) { return c != 0 && kPunct.find(c) != U32::npos; }

// Перед началом строки и за её концом — «пробел» (как `undefined` в JS-проверках web)
bool isSpaceAt(const U32 &s, size_t i, bool before) {
    if (before) return i == 0 || isSpace(s[i - 1]);
    return i >= s.size() || isSpace(s[i]);
}

bool isWordAt(const U32 &s, size_t i, bool before) {
    if (before) return i > 0 && (isLetter(s[i - 1]) || isNumber(s[i - 1]));
    return i < s.size() && (isLetter(s[i]) || isNumber(s[i]));
}

bool isTagChar(char32_t c) { return isLetter(c) || isNumber(c) || c == '_' || c == '/' || c == '-'; }

size_t runLength(const U32 &s, size_t i, size_t to) {
    size_t j = i;
    while (j < to && s[j] == s[i]) ++j;
    return j - i;
}

char32_t lowerAscii(char32_t c) { return (c >= 'A' && c <= 'Z') ? c + 32 : c; }

bool startsWithIgnoreCase(const U32 &s, size_t at, const char *prefix) {
    for (size_t k = 0; prefix[k]; ++k) {
        if (at + k >= s.size() || lowerAscii(s[at + k]) != static_cast<char32_t>(prefix[k])) return false;
    }
    return true;
}

// Первое вхождение `needle`, начинающееся в [from, limit) (поиск не уходит за окно — без квадратичного разбора)
size_t findWithin(const U32 &s, const U32 &needle, size_t from, size_t limit) {
    for (size_t j = from; j < limit; ++j) {
        if (startsWithU(s, j, needle)) return j;
    }
    return U32::npos;
}

struct CodeSpan {
    size_t end = 0;
    U32 text;
};

// Конец кода с `i` и его текст
std::optional<CodeSpan> codeSpanAt(const U32 &s, size_t i, size_t to) {
    const size_t n = runLength(s, i, to);
    const size_t limit = std::min(to, i + n + kScanLimit);
    size_t j = i + n;
    while (j < limit) {
        if (s[j] != '`') {
            ++j;
            continue;
        }
        const size_t m = runLength(s, j, to);
        if (m == n) {
            U32 text = s.substr(i + n, j - i - n);
            for (auto &c : text) {
                if (c == '\n') c = ' ';
            }
            if (text.size() > 2 && text.front() == ' ' && text.back() == ' ' && !trimU(text).empty()) {
                text = text.substr(1, text.size() - 2);
            }
            return CodeSpan{j + m, std::move(text)};
        }
        j += m;
    }
    return std::nullopt;
}

// Закрывающий знак начертания (стек вложенных открытий того же знака — как web `findCloser`)
std::optional<size_t> findCloser(const U32 &s, size_t from, size_t to, char32_t mark, size_t length) {
    const size_t limit = std::min(to, from + kScanLimit);
    std::vector<size_t> stack;
    size_t j = from;
    while (j < limit) {
        const char32_t c = s[j];
        if (c == '\\') {
            j += 2;
            continue;
        }
        if (c == '`') {
            const auto code = codeSpanAt(s, j, to);
            j = code ? code->end : j + runLength(s, j, to);
            continue;
        }
        if (c != mark) {
            ++j;
            continue;
        }
        const size_t run = runLength(s, j, to);
        size_t m = run;
        const bool canClose = !isSpaceAt(s, j, true) && (mark != '_' || !isWordAt(s, j + run, false));
        const bool canOpen = !isSpaceAt(s, j + run, false) && (mark != '_' || !isWordAt(s, j, true));
        size_t pos = j;
        if (canClose) {
            while (m && !stack.empty()) {
                const size_t top = stack.back();
                stack.pop_back();
                const size_t used = std::min(top, m);
                m -= used;
                pos += used;
                if (top > used) stack.push_back(top - used);
            }
            if (m >= length && (m == length || !canOpen)) return pos;
        }
        if (canOpen && m) stack.push_back(m);
        j += run;
    }
    return std::nullopt;
}

struct LinkMatch {
    size_t labelFrom = 0;
    size_t labelTo = 0;
    U32 url;
    size_t end = 0;
};

// `[подпись](адрес "заголовок")` с `i` (на `[`)
std::optional<LinkMatch> linkAt(const U32 &s, size_t i, size_t to) {
    const size_t limit = std::min(to, i + kScanLimit);
    int level = 0;
    size_t j = i;
    for (; j < limit; ++j) {
        const char32_t c = s[j];
        if (c == '\\') {
            ++j;
        } else if (c == '[') {
            ++level;
        } else if (c == ']') {
            --level;
            if (!level) break;
        } else if (c == '\n' && at(s, j + 1) == '\n') {
            return std::nullopt;
        }
    }
    if (j >= limit || at(s, j + 1) != '(') return std::nullopt;
    const size_t labelEnd = j;
    size_t k = j + 2;
    while (k < to && isTabOrSpace(s[k])) ++k;
    U32 url;
    if (at(s, k) == '<') {
        const size_t close = findWithin(s, U">", k + 1, limit);
        if (close == U32::npos) return std::nullopt;
        url = s.substr(k + 1, close - k - 1);
        if (url.find(U'\n') != U32::npos) return std::nullopt;
        k = close + 1;
    } else {
        int parens = 0;
        const size_t from = k;
        for (; k < to && k < from + kScanLimit; ++k) {
            const char32_t c = s[k];
            if (c == '\\' && k + 1 < to) {
                ++k;
            } else if (c == '(') {
                ++parens;
            } else if (c == ')') {
                if (!parens) break;
                --parens;
            } else if (isSpace(c)) {
                break;
            }
        }
        // .replace(/\\(.)/g, '$1')
        const U32 raw = s.substr(from, std::min(k, s.size()) - from);
        for (size_t r = 0; r < raw.size(); ++r) {
            if (raw[r] == '\\' && r + 1 < raw.size() && !isLineTerminator(raw[r + 1])) ++r;
            url.push_back(raw[r]);
        }
    }
    while (k < to && isTabOrSpace(s[k])) ++k;
    const char32_t open = at(s, k);
    if (open == '"' || open == '\'' || open == '(') {
        const size_t close = findWithin(s, U32(1, open == '(' ? U')' : open), k + 1, std::min(to, k + kScanLimit));
        if (close == U32::npos) return std::nullopt;
        k = close + 1;
        while (k < to && isTabOrSpace(s[k])) ++k;
    }
    if (at(s, k) != ')') return std::nullopt;
    return LinkMatch{i + 1, labelEnd, std::move(url), k + 1};
}

// Голый адрес `https://…` / `www.…` с `i`: конец
std::optional<size_t> bareUrlAt(const U32 &s, size_t i, size_t to) {
    const bool isWww = startsWithIgnoreCase(s, i, "www.");
    const bool isHttps = startsWithIgnoreCase(s, i, "https://");
    if (!isWww && !isHttps && !startsWithIgnoreCase(s, i, "http://")) return std::nullopt;
    if (i > 0 && !isSpace(s[i - 1]) && U32(U"(*_~«").find(s[i - 1]) == U32::npos) return std::nullopt;
    size_t j = i;
    while (j < to && j < i + kScanLimit && !isSpace(s[j]) && s[j] != '<' && s[j] != '>') ++j;
    // Хвостовые знаки препинания и непарная `)` — не часть адреса
    const U32 trailing = U".,:;!?'\"*_~»";
    while (j > i) {
        const char32_t c = s[j - 1];
        if (trailing.find(c) != U32::npos) {
            --j;
        } else if (c == ')') {
            int opens = 0;
            int closes = 0;
            for (size_t k = i; k < j; ++k) {
                if (s[k] == '(') ++opens;
                if (s[k] == ')') ++closes;
            }
            if (opens < closes) --j;
            else break;
        } else {
            break;
        }
    }
    const size_t scheme = isWww ? 4 : isHttps ? 8 : 7;
    return j - i > scheme ? std::make_optional(j) : std::nullopt;
}

struct NoteMatch {
    size_t end = 0;
    U32 text;
    U32 target;
};

// `[[цель|подпись]]` с `i` (на первой `[`)
std::optional<NoteMatch> noteAt(const U32 &s, size_t i, size_t to) {
    const size_t close = findWithin(s, U"]]", i + 2, std::min(to, i + 302) + 1);
    if (close == U32::npos) return std::nullopt;
    const U32 inner = s.substr(i + 2, close - i - 2);
    if (inner.empty()) return std::nullopt;
    for (char32_t c : inner) {
        if (c == '[' || c == ']' || c == '\n') return std::nullopt;
    }
    const size_t bar = inner.find(U'|');
    const U32 target = trimU(inner.substr(0, bar));
    if (target.empty()) return std::nullopt;
    U32 alias;
    if (bar != U32::npos) {
        const size_t next = inner.find(U'|', bar + 1);
        alias = inner.substr(bar + 1, next == U32::npos ? U32::npos : next - bar - 1);
    }
    return NoteMatch{close + 2, alias.empty() ? target : trimU(alias), target};
}

// `</имя>` без учёта регистра латиницы в [from, to)
std::optional<size_t> findClosingTag(const U32 &s, size_t from, size_t to, const std::string &name) {
    const std::string needle = "</" + name + ">";
    for (size_t j = from; j + needle.size() <= to; ++j) {
        if (s[j] == '<' && startsWithIgnoreCase(s, j, needle.c_str())) return j;
    }
    return std::nullopt;
}

uint32_t tagStyle(const std::string &name) {
    static const std::map<std::string, uint32_t> kTags = {
        {"u", kMdUnderline}, {"ins", kMdUnderline}, {"mark", kMdMark}, {"sub", kMdSub}, {"sup", kMdSup},
        {"kbd", kMdCode}, {"code", kMdCode}, {"b", kMdBold}, {"strong", kMdBold}, {"i", kMdItalic},
        {"em", kMdItalic}, {"s", kMdStrike}, {"del", kMdStrike}, {"strike", kMdStrike},
    };
    const auto found = kTags.find(name);
    return found == kTags.end() ? 0 : found->second;
}

struct TagMatch {
    std::string name;
    size_t length = 0;
};

// /^<([a-zA-Z]{1,6})(?:\s[^<>]{0,200})?\s*\/?>/ в окне 220 знаков
std::optional<TagMatch> tagAt(const U32 &s, size_t i, size_t to) {
    const size_t limit = std::min(to, i + 220);
    size_t j = i + 1;
    while (j < limit && j - i - 1 < 7 && ((s[j] >= 'a' && s[j] <= 'z') || (s[j] >= 'A' && s[j] <= 'Z'))) ++j;
    const size_t nameLength = j - i - 1;
    if (nameLength < 1 || nameLength > 6) return std::nullopt;
    size_t close = j;
    while (close < limit && s[close] != '>' && s[close] != '<') ++close;
    if (close >= limit || s[close] != '>') return std::nullopt;
    const U32 rest = s.substr(j, close - j);
    // Хвост `\s*\/?` перед `>`
    size_t tail = rest.size();
    if (tail > 0 && rest[tail - 1] == '/') --tail;
    while (tail > 0 && isSpace(rest[tail - 1])) --tail;
    const bool isOk = tail == 0 || (isSpace(rest[0]) && tail <= 201);
    if (!isOk) return std::nullopt;
    std::string name = encode(s.substr(i + 1, nameLength));
    for (auto &c : name) {
        if (c >= 'A' && c <= 'Z') c = static_cast<char>(c + 32);
    }
    return TagMatch{std::move(name), close + 1 - i};
}

const std::map<std::string, std::string> &namedEntities() {
    static const std::map<std::string, std::string> kEntities = {
        {"amp", "&"}, {"lt", "<"}, {"gt", ">"}, {"quot", "\""}, {"apos", "'"}, {"nbsp", " "},
        {"copy", "©"}, {"reg", "®"}, {"trade", "™"}, {"mdash", "—"}, {"ndash", "–"}, {"hellip", "…"},
        {"laquo", "«"}, {"raquo", "»"}, {"ldquo", "“"}, {"rdquo", "”"}, {"lsquo", "‘"}, {"rsquo", "’"},
        {"bdquo", "„"}, {"times", "×"}, {"divide", "÷"}, {"minus", "−"}, {"plusmn", "±"}, {"deg", "°"},
        {"middot", "·"}, {"bull", "•"}, {"sect", "§"}, {"para", "¶"}, {"euro", "€"}, {"pound", "£"},
        {"yen", "¥"}, {"cent", "¢"}, {"larr", "←"}, {"rarr", "→"}, {"uarr", "↑"}, {"darr", "↓"},
        {"harr", "↔"}, {"le", "≤"}, {"ge", "≥"}, {"ne", "≠"}, {"asymp", "≈"}, {"infin", "∞"},
        {"check", "✓"}, {"ensp", " "}, {"emsp", " "}, {"thinsp", " "}, {"zwj", "‍"},
        {"zwnj", "‌"},
    };
    return kEntities;
}

struct EntityMatch {
    U32 value;
    size_t length = 0;
};

// /^&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/
std::optional<EntityMatch> entityAt(const U32 &s, size_t i) {
    size_t j = i + 1;
    const auto isHex = [](char32_t c) {
        return isAsciiDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
    };
    const auto isAlpha = [](char32_t c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); };
    if (at(s, j) == '#') {
        ++j;
        const bool hex = at(s, j) == 'x' || at(s, j) == 'X';
        if (hex) ++j;
        const size_t from = j;
        while (j < s.size() && (hex ? isHex(s[j]) : isAsciiDigit(s[j]))) ++j;
        const size_t digits = j - from;
        if (digits < 1 || digits > (hex ? 6u : 7u) || at(s, j) != ';') return std::nullopt;
        const long code = std::stol(encode(s.substr(from, digits)), nullptr, hex ? 16 : 10);
        const bool isValid = code > 0 && code <= 0x10FFFF && (code < 0xD800 || code > 0xDFFF);
        return EntityMatch{U32(1, isValid ? static_cast<char32_t>(code) : 0xFFFD), j + 1 - i};
    }
    if (!isAlpha(at(s, j))) return std::nullopt;
    const size_t from = j;
    while (j < s.size() && (isAlpha(s[j]) || isAsciiDigit(s[j]))) ++j;
    if (j - from < 2 || j - from > 32 || at(s, j) != ';') return std::nullopt;
    const auto found = namedEntities().find(encode(s.substr(from, j - from)));
    if (found == namedEntities().end()) return std::nullopt;
    return EntityMatch{decode(found->second), j + 1 - i};
}

struct AutoLink {
    U32 inner;
    size_t length = 0;
};

// /^<((?:https?:\/\/|mailto:)[^\s<>]{1,2000}|[^\s<>@]{1,200}@[^\s<>@]{1,200}\.[^\s<>@]{1,50})>/i в окне 2500
std::optional<AutoLink> autoLinkAt(const U32 &s, size_t i, size_t to) {
    const size_t limit = std::min(to, i + 2500);
    const auto stop = [](char32_t c) { return isSpace(c) || c == '<' || c == '>'; };
    size_t scheme = 0;
    if (startsWithIgnoreCase(s, i + 1, "https://")) scheme = 8;
    else if (startsWithIgnoreCase(s, i + 1, "http://")) scheme = 7;
    else if (startsWithIgnoreCase(s, i + 1, "mailto:")) scheme = 7;
    if (scheme) {
        size_t j = i + 1 + scheme;
        while (j < limit && !stop(s[j])) ++j;
        const size_t run = j - (i + 1 + scheme);
        if (run >= 1 && run <= 2000 && j < limit && s[j] == '>') {
            return AutoLink{s.substr(i + 1, j - i - 1), j + 1 - i};
        }
    }
    size_t j = i + 1;
    while (j < limit && !stop(s[j]) && s[j] != '@') ++j;
    const size_t local = j - i - 1;
    if (local < 1 || local > 200 || at(s, j) != '@' || j >= limit) return std::nullopt;
    const size_t domainFrom = j + 1;
    size_t k = domainFrom;
    while (k < limit && !stop(s[k]) && s[k] != '@') ++k;
    if (k >= limit || s[k] != '>') return std::nullopt;
    const size_t domainLength = k - domainFrom;
    bool isOk = false;
    for (size_t p = 1; p <= std::min<size_t>(200, domainLength); ++p) {
        const size_t tail = domainLength - p - 1;
        if (p < domainLength && s[domainFrom + p] == '.' && tail >= 1 && tail <= 50) {
            isOk = true;
            break;
        }
    }
    if (!isOk) return std::nullopt;
    return AutoLink{s.substr(i + 1, k - i - 1), k + 1 - i};
}

void pushRun(std::vector<MdInline> &out, MdInline run) {
    if (run.text.empty()) return;
    if (!out.empty()) {
        auto &last = out.back();
        if ((run.type == MdInlineType::Text || run.type == MdInlineType::Link) && last.type == run.type
            && last.style == run.style && last.url == run.url) {
            last.text += run.text;
            return;
        }
    }
    out.push_back(std::move(run));
}

MdInline makeRun(MdInlineType type, const U32 &text, uint32_t style, const std::string &url = std::string()) {
    MdInline run;
    run.type = type;
    run.text = encode(text);
    run.style = style;
    run.url = url;
    return run;
}

bool hasPrefixIgnoreCaseU(const U32 &s, const char *prefix) { return startsWithIgnoreCase(s, 0, prefix); }

void parseSpan(
        const U32 &s, size_t from, size_t to, uint32_t style, const std::optional<std::string> &link,
        std::vector<MdInline> &out, int depth) {
    U32 buffer;
    const auto flushText = [&] {
        if (!buffer.empty()) {
            pushRun(out, link ? makeRun(MdInlineType::Link, buffer, style, *link)
                              : makeRun(MdInlineType::Text, buffer, style));
        }
        buffer.clear();
    };
    const auto nested = [&](size_t a, size_t b, uint32_t extra, const std::optional<std::string> &url) {
        flushText();
        if (depth >= kMaxDepth) {
            const U32 text = s.substr(a, b - a);
            pushRun(out, url ? makeRun(MdInlineType::Link, text, style | extra, *url)
                             : makeRun(MdInlineType::Text, text, style | extra));
        } else {
            parseSpan(s, a, b, style | extra, url, out, depth + 1);
        }
    };
    const auto pushNote = [&](const NoteMatch &note) {
        flushText();
        if (link) {
            pushRun(out, makeRun(MdInlineType::Link, note.text, style, *link));
        } else {
            MdInline run = makeRun(MdInlineType::Note, note.text, style);
            run.target = encode(note.target);
            pushRun(out, std::move(run));
        }
    };

    size_t i = from;
    while (i < to) {
        const char32_t c = s[i];
        if (c == '\\') {
            const char32_t next = at(s, i + 1);
            if (i + 1 < to && next == '\n') {
                buffer.push_back('\n');
                i += 2;
                continue;
            }
            if (i + 1 < to && isPunct(next)) {
                buffer.push_back(next);
                i += 2;
                continue;
            }
            buffer.push_back(c);
            ++i;
            continue;
        }
        if (c == '`') {
            if (const auto code = codeSpanAt(s, i, to)) {
                flushText();
                pushRun(out, link ? makeRun(MdInlineType::Link, code->text, style | kMdCode, *link)
                                  : makeRun(MdInlineType::Text, code->text, style | kMdCode));
                i = code->end;
            } else {
                const size_t n = runLength(s, i, to);
                buffer += s.substr(i, n);
                i += n;
            }
            continue;
        }
        if (c == '<') {
            if (startsWithU(s, i, U"<!--")) {
                const size_t end = findWithin(s, U"-->", i + 4, std::min(to, i + 4 + kScanLimit));
                if (end != U32::npos) {
                    i = end + 3;
                    continue;
                }
            }
            if (!link) {
                if (const auto autoLink = autoLinkAt(s, i, to)) {
                    flushText();
                    const U32 &inner = autoLink->inner;
                    const bool hasScheme = hasPrefixIgnoreCaseU(inner, "http:") || hasPrefixIgnoreCaseU(inner, "https:")
                        || hasPrefixIgnoreCaseU(inner, "mailto:");
                    const std::string url = hasScheme ? encode(inner) : "mailto:" + encode(inner);
                    const U32 text = hasPrefixIgnoreCaseU(inner, "mailto:") ? inner.substr(7) : inner;
                    pushRun(out, makeRun(MdInlineType::Link, text, style, url));
                    i += autoLink->length;
                    continue;
                }
            }
            if (const auto tag = tagAt(s, i, to)) {
                if (tag->name == "br") {
                    buffer.push_back('\n');
                    i += tag->length;
                    continue;
                }
                if (const uint32_t extra = tagStyle(tag->name)) {
                    const size_t a = i + tag->length;
                    if (const auto close = findClosingTag(s, a, std::min(to, a + kScanLimit), tag->name)) {
                        nested(a, *close, extra, link);
                        i = *close + tag->name.size() + 3;
                        continue;
                    }
                }
            }
            buffer.push_back(c);
            ++i;
            continue;
        }
        if (c == '&') {
            if (const auto entity = entityAt(s, i)) {
                buffer += entity->value;
                i += entity->length;
                continue;
            }
            buffer.push_back(c);
            ++i;
            continue;
        }
        if (c == '!' && at(s, i + 1) == '[') {
            if (at(s, i + 2) == '[') {
                if (const auto note = noteAt(s, i + 1, to)) {
                    pushNote(*note);
                    i = note->end;
                    continue;
                }
            }
            if (const auto image = linkAt(s, i + 1, to)) {
                // Картинка в строке — подписью (внутри ссылки — подписью ссылки), адрес http(s) — ссылкой
                const std::string imageUrl = encode(image->url);
                const std::optional<std::string> url = link ? link
                    : isWebUrl(imageUrl) ? std::make_optional(imageUrl) : std::nullopt;
                if (image->labelTo > image->labelFrom) {
                    nested(image->labelFrom, image->labelTo, 0, url);
                } else if (url) {
                    flushText();
                    pushRun(out, makeRun(MdInlineType::Link, image->url, style, *url));
                }
                i = image->end;
                continue;
            }
        }
        if (c == '[') {
            if (at(s, i + 1) == '[') {
                if (const auto note = noteAt(s, i, to)) {
                    pushNote(*note);
                    i = note->end;
                    continue;
                }
            }
            if (const auto found = linkAt(s, i, to)) {
                const U32 trimmedUrl = trimU(found->url);
                const std::string url = encode(trimmedUrl);
                const bool isSafe = safeUrl(url) || (trimmedUrl.size() > 1 && trimmedUrl[0] == '#');
                const std::optional<std::string> target = link ? link
                    : isSafe ? std::make_optional(url) : std::nullopt;
                if (found->labelTo > found->labelFrom) {
                    nested(found->labelFrom, found->labelTo, 0, target);
                } else if (target) {
                    flushText();
                    pushRun(out, makeRun(MdInlineType::Link, trimmedUrl, style, *target));
                }
                i = found->end;
                continue;
            }
            buffer.push_back(c);
            ++i;
            continue;
        }
        if (c == '*' || c == '_' || c == '~' || c == '=') {
            const size_t n = runLength(s, i, to);
            const bool isOpener = !isSpaceAt(s, i + n, false) && (c != '_' || !isWordAt(s, i, true));
            const bool isValid = (c == '*' || c == '_') ? n <= 3 : n == 2;
            if (isOpener && isValid) {
                const auto close = findCloser(s, i + n, to, c, n);
                if (close && *close > i + n) {
                    uint32_t extra = c == '~' ? kMdStrike : c == '=' ? kMdMark : 0;
                    if (c == '*' || c == '_') extra = n == 1 ? kMdItalic : n == 2 ? kMdBold : (kMdBold | kMdItalic);
                    nested(i + n, *close, extra, link);
                    i = *close + n;
                    continue;
                }
            }
            buffer += s.substr(i, n);
            i += n;
            continue;
        }
        if (c == '%' && at(s, i + 1) == '%') {
            const size_t end = s.find(U"%%", i + 2);
            if (end != U32::npos && end + 2 <= to) {
                i = end + 2;
                continue;
            }
        }
        if (c == '#' && isSpaceAt(s, i, true) && !link) {
            size_t j = i + 1;
            while (j < to && isTagChar(s[j])) ++j;
            bool isDigits = true;
            for (size_t k = i + 1; k < j; ++k) {
                if (!isAsciiDigit(s[k])) isDigits = false;
            }
            if (j > i + 1 && !isDigits) {
                flushText();
                pushRun(out, makeRun(MdInlineType::Tag, s.substr(i, j - i), style));
                i = j;
                continue;
            }
        }
        if ((c == 'h' || c == 'H' || c == 'w' || c == 'W') && !link) {
            if (const auto end = bareUrlAt(s, i, to)) {
                flushText();
                const U32 text = s.substr(i, *end - i);
                const std::string url = startsWithIgnoreCase(text, 0, "www.") ? "https://" + encode(text) : encode(text);
                pushRun(out, makeRun(MdInlineType::Link, text, style, url));
                i = *end;
                continue;
            }
        }
        buffer.push_back(c);
        ++i;
    }
    flushText();
}

nlohmann::json inlineJson(const MdInline &part) {
    static const char *kTypes[] = {"text", "tag", "note", "link"};
    nlohmann::json out = {{"type", kTypes[static_cast<int>(part.type)]}, {"text", part.text}};
    if (part.type == MdInlineType::Note) out["target"] = part.target;
    if (part.type == MdInlineType::Link) out["url"] = part.url;
    if (part.style) out["style"] = part.style;
    return out;
}

nlohmann::json blockJson(const MdBlock &block) {
    nlohmann::json out = nlohmann::json::object();
    out["line"] = block.line;
    switch (block.type) {
    case MdBlockType::Heading:
        out["type"] = "heading";
        out["level"] = block.level;
        out["text"] = block.text;
        out["id"] = block.id;
        break;
    case MdBlockType::Paragraph:
        out["type"] = "paragraph";
        out["text"] = block.text;
        break;
    case MdBlockType::Code:
        out["type"] = "code";
        out["text"] = block.text;
        if (!block.lang.empty()) out["lang"] = block.lang;
        break;
    case MdBlockType::Rule:
        out["type"] = "rule";
        break;
    case MdBlockType::Quote: {
        out["type"] = "quote";
        auto children = nlohmann::json::array();
        for (const auto &child : block.children) children.push_back(blockJson(child));
        out["blocks"] = std::move(children);
        if (block.callout) {
            nlohmann::json callout = {{"kind", block.callout->kind}, {"title", block.callout->title}};
            if (!block.callout->fold.empty()) callout["fold"] = block.callout->fold;
            out["callout"] = std::move(callout);
        }
    } break;
    case MdBlockType::List: {
        out["type"] = "list";
        out["isOrdered"] = block.isOrdered;
        auto items = nlohmann::json::array();
        for (const auto &item : block.items) {
            nlohmann::json entry = {{"text", item.text}, {"depth", item.depth}, {"line", item.line}};
            if (item.isChecked) entry["isChecked"] = *item.isChecked;
            if (item.number) entry["number"] = *item.number;
            if (!item.blocks.empty()) {
                auto children = nlohmann::json::array();
                for (const auto &child : item.blocks) children.push_back(blockJson(child));
                entry["blocks"] = std::move(children);
            }
            items.push_back(std::move(entry));
        }
        out["items"] = std::move(items);
    } break;
    case MdBlockType::Table: {
        static const char *kAlign[] = {nullptr, "left", "center", "right"};
        out["type"] = "table";
        out["header"] = block.header;
        auto align = nlohmann::json::array();
        for (const auto value : block.align) {
            const char *name = kAlign[static_cast<int>(value)];
            align.push_back(name ? nlohmann::json(name) : nlohmann::json());
        }
        out["align"] = std::move(align);
        out["rows"] = block.rows;
    } break;
    case MdBlockType::Embed:
        out["type"] = "embed";
        out["name"] = block.name;
        if (block.alt) out["alt"] = *block.alt;
        if (block.url) out["url"] = *block.url;
        break;
    }
    return out;
}

void collectTextsInto(const std::vector<MdBlock> &blocks, std::vector<std::string> &out) {
    for (const auto &block : blocks) {
        if (block.type == MdBlockType::Heading || block.type == MdBlockType::Paragraph) {
            out.push_back(block.text);
        } else if (block.type == MdBlockType::List) {
            for (const auto &item : block.items) {
                out.push_back(item.text);
                collectTextsInto(item.blocks, out);
            }
        } else if (block.type == MdBlockType::Quote) {
            if (block.callout && !block.callout->title.empty()) out.push_back(block.callout->title);
            collectTextsInto(block.children, out);
        } else if (block.type == MdBlockType::Table) {
            for (const auto &cell : block.header) out.push_back(cell);
            for (const auto &row : block.rows) {
                for (const auto &cell : row) out.push_back(cell);
            }
        }
    }
}

void collectEmbedNames(const std::vector<MdBlock> &blocks, std::vector<std::string> &names, std::set<std::string> &seen) {
    for (const auto &block : blocks) {
        if (block.type == MdBlockType::Embed) {
            if (!block.url && seen.insert(block.name).second) names.push_back(block.name);
        } else if (block.type == MdBlockType::Quote) {
            collectEmbedNames(block.children, names, seen);
        } else if (block.type == MdBlockType::List) {
            for (const auto &item : block.items) collectEmbedNames(item.blocks, names, seen);
        }
    }
}

} // namespace

bool MdListItem::operator==(const MdListItem &other) const {
    return text == other.text && depth == other.depth && isChecked == other.isChecked && number == other.number
        && blocks == other.blocks && line == other.line;
}

std::vector<MdBlock> parseMarkdown(const std::string &markdown, const std::string &title) {
    const std::string normalized = normalizeEol(markdown);
    const std::string frontMatter = frontMatterOf(normalized);
    // Номера строк — по исходному тексту: свойства в начале заметки тоже строки
    int offset = 0;
    if (!frontMatter.empty()) {
        offset = static_cast<int>(std::count(frontMatter.begin(), frontMatter.end(), '\n')) + 1
            - (frontMatter.back() == '\n' ? 1 : 0);
    }
    std::vector<U32> lines;
    std::vector<int> lineNos;
    for (const auto &line : split(normalized.substr(frontMatter.size()), '\n')) {
        lineNos.push_back(offset + static_cast<int>(lines.size()));
        lines.push_back(decode(line));
    }
    auto blocks = parseBlocks(lines, lineNos, 0);
    const U32 ownTitle = trimU(decode(title));
    if (!blocks.empty() && blocks.front().type == MdBlockType::Heading && !ownTitle.empty()
        && toLower(trimU(decode(inlineText(blocks.front().text)))) == toLower(ownTitle)) {
        blocks.erase(blocks.begin());
    }
    std::map<std::string, int> used;
    assignIds(blocks, used);
    return blocks;
}

std::vector<MdInline> parseInline(const std::string &text) {
    std::vector<MdInline> out;
    const U32 s = decode(text);
    parseSpan(s, 0, s.size(), 0, std::nullopt, out, 0);
    return out;
}

std::string inlineText(const std::string &text) {
    std::string out;
    for (const auto &part : parseInline(text)) out += part.text;
    return out;
}

std::string slugOf(const std::string &text) {
    U32 out;
    for (const char32_t c : toLower(decode(inlineText(text)))) {
        if (c == ' ') out.push_back('-');
        else if (isLetter(c) || isNumber(c) || c == '_' || c == '-') out.push_back(c);
    }
    return encode(out);
}

std::vector<std::string> collectTexts(const std::vector<MdBlock> &blocks) {
    std::vector<std::string> out;
    collectTextsInto(blocks, out);
    return out;
}

nlohmann::json toJson(const std::vector<MdBlock> &blocks) {
    auto out = nlohmann::json::array();
    for (const auto &block : blocks) out.push_back(blockJson(block));
    return out;
}

nlohmann::json toJson(const std::vector<MdInline> &parts) {
    auto out = nlohmann::json::array();
    for (const auto &part : parts) out.push_back(inlineJson(part));
    return out;
}

bool isSafeUrl(const std::string &url) { return safeUrl(url); }

namespace {

// Адрес для сравнения с подписью: без пробелов по краям, схемы, `www.`, завершающей `/`, в нижнем регистре ASCII
std::string comparableUrl(const std::string &value) {
    auto v = encode(trimU(decode(value)));
    for (auto &c : v) {
        if (c >= 'A' && c <= 'Z') c = static_cast<char>(c + 32);
    }
    for (const char *prefix : {"https://", "http://", "mailto:"}) {
        if (startsWith(v, prefix)) {
            v.erase(0, std::char_traits<char>::length(prefix));
            break;
        }
    }
    if (startsWith(v, "www.")) v.erase(0, 4);
    while (!v.empty() && v.back() == '/') v.pop_back();
    return v;
}

} // namespace

bool linkNeedsConfirmation(const std::string &text, const std::string &url) {
    if (encode(trimU(decode(text))).empty()) return false;
    return comparableUrl(text) != comparableUrl(url);
}

std::vector<std::string> embedNames(const std::string &markdown) {
    std::vector<std::string> names;
    std::set<std::string> seen; // повторы — без квадратичного поиска (ревью 21 окт, 2.3)
    collectEmbedNames(parseMarkdown(markdown), names, seen);
    return names;
}

std::string embedBaseName(const std::string &name) {
    std::string last;
    for (const auto &part : split(name, '/')) {
        if (!part.empty()) last = part;
    }
    return last.empty() ? name : last;
}

std::string renameEmbeds(const std::string &markdown, const std::map<std::string, std::string> &rename) {
    std::vector<std::string> out;
    for (const auto &line : split(markdown, '\n')) {
        const auto embed = matchEmbed(decode(line));
        if (!embed) {
            out.push_back(line);
            continue;
        }
        const MdBlock block = embedOf(*embed, 0);
        const auto found = block.url ? rename.end() : rename.find(block.name);
        if (found == rename.end() || found->second.empty() || found->second == block.name) {
            out.push_back(line);
            continue;
        }
        const std::string &next = found->second;
        if (embed->isWiki) {
            out.push_back("![[" + next + (embed->caption ? "|" + encode(*embed->caption) : "") + "]]");
        } else {
            out.push_back("![" + encode(embed->label) + "](" + encodeUri(next) + ")");
        }
    }
    return join(out, "\n");
}

} // namespace parvane::sections::markdown
