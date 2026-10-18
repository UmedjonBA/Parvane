// Parvane fork (spec 029, фаза 4): порт web `markdown/markdown.ts` (разбор без отрисовки). Регулярки web разобраны
// вручную по кодовым точкам; у каждой функции — какая регулярка повторена.
#include "parvane/sections/markdown.h"

#include <algorithm>

#include "notes_text.h"

namespace parvane::sections::markdown {

namespace {

using namespace notes::text;

// Отступ вложенного пункта: два пробела либо табуляция на уровень
constexpr int kIndentStep = 2;

bool isAllSpace(const U32 &s, size_t from) {
    for (size_t i = from; i < s.size(); ++i) {
        if (!isSpace(s[i])) return false;
    }
    return true;
}

bool isBulletChar(char32_t c) { return c == '-' || c == '*' || c == '+'; }

// FENCE = /^\s*```/
bool isFence(const U32 &s) {
    size_t i = 0;
    while (i < s.size() && isSpace(s[i])) ++i;
    return startsWithU(s, i, U"```");
}

struct HeadingMatch {
    int level = 0;
    U32 text;
};

// HEADING = /^(#{1,3})\s+(.*)$/
std::optional<HeadingMatch> matchHeading(const U32 &s) {
    size_t i = 0;
    while (i < s.size() && s[i] == '#') ++i;
    if (i < 1 || i > 3 || i >= s.size() || !isSpace(s[i])) return std::nullopt;
    const int level = static_cast<int>(i);
    while (i < s.size() && isSpace(s[i])) ++i;
    U32 rest = s.substr(i);
    if (hasLineTerminator(rest)) return std::nullopt;
    return HeadingMatch{level, std::move(rest)};
}

// RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/
bool isRule(const U32 &s) {
    size_t i = 0;
    while (i < s.size() && isSpace(s[i])) ++i;
    if (i >= s.size() || (s[i] != '-' && s[i] != '*' && s[i] != '_')) return false;
    const char32_t mark = s[i];
    const size_t start = i;
    while (i < s.size() && s[i] == mark) ++i;
    return i - start >= 3 && isAllSpace(s, i);
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

struct ItemMatch {
    U32 indent;
    std::optional<bool> isChecked;
    U32 text;
};

// TASK = /^(\s*)[-*+] \[( |x|X)\](?: (.*))?$/
std::optional<ItemMatch> matchTask(const U32 &s) {
    const size_t n = s.size();
    size_t i = 0;
    while (i < n && isSpace(s[i])) ++i;
    const U32 indent = s.substr(0, i);
    if (i + 4 >= n || !isBulletChar(s[i]) || s[i + 1] != ' ' || s[i + 2] != '[') return std::nullopt;
    const char32_t mark = s[i + 3];
    if (mark != ' ' && mark != 'x' && mark != 'X') return std::nullopt;
    if (s[i + 4] != ']') return std::nullopt;
    size_t j = i + 5;
    U32 text;
    if (j < n) {
        if (s[j] != ' ') return std::nullopt;
        text = s.substr(j + 1);
        if (hasLineTerminator(text)) return std::nullopt;
    }
    return ItemMatch{indent, mark != ' ', std::move(text)};
}

// BULLET = /^(\s*)[-*+] (.*)$/
std::optional<ItemMatch> matchBullet(const U32 &s) {
    const size_t n = s.size();
    size_t i = 0;
    while (i < n && isSpace(s[i])) ++i;
    if (i + 1 >= n || !isBulletChar(s[i]) || s[i + 1] != ' ') return std::nullopt;
    U32 text = s.substr(i + 2);
    if (hasLineTerminator(text)) return std::nullopt;
    return ItemMatch{s.substr(0, i), std::nullopt, std::move(text)};
}

// ORDERED = /^(\s*)\d+[.)] (.*)$/
std::optional<ItemMatch> matchOrdered(const U32 &s) {
    const size_t n = s.size();
    size_t i = 0;
    while (i < n && isSpace(s[i])) ++i;
    const size_t digits = i;
    while (i < n && isAsciiDigit(s[i])) ++i;
    if (i == digits || i + 1 >= n || (s[i] != '.' && s[i] != ')') || s[i + 1] != ' ') return std::nullopt;
    U32 text = s.substr(i + 2);
    if (hasLineTerminator(text)) return std::nullopt;
    return ItemMatch{s.substr(0, digits), std::nullopt, std::move(text)};
}

// QUOTE = /^>\s?(.*)$/
std::optional<U32> matchQuote(const U32 &s) {
    if (s.empty() || s[0] != '>') return std::nullopt;
    size_t i = 1;
    if (i < s.size() && isSpace(s[i])) ++i;
    U32 rest = s.substr(i);
    if (hasLineTerminator(rest)) return std::nullopt;
    return rest;
}

int depthOf(const U32 &indent) {
    size_t length = 0;
    for (char32_t c : indent) length += c == '\t' ? kIndentStep : 1;
    return static_cast<int>(length / kIndentStep);
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
bool isSafeUrl(const std::string &value) {
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

// --- Строка ---------------------------------------------------------------------------------------------------

bool isMarkChar(char32_t c) { return c == '*' || c == '_'; }

bool isTagChar(char32_t c) { return isLetter(c) || isAsciiDigit(c) || c == '_' || c == '/' || c == '-'; }

// Конец парного знака `**…**`, `~~…~~` с `p` либо 0
size_t matchPair(const U32 &s, size_t p, char32_t mark) {
    const size_t n = s.size();
    if (p + 1 >= n || s[p] != mark || s[p + 1] != mark) return 0;
    size_t j = p + 2;
    while (j < n && s[j] != mark && s[j] != '\n') ++j;
    if (j == p + 2 || j + 1 >= n || s[j] != mark || s[j + 1] != mark) return 0;
    return j + 2;
}

// Конец `` `…` `` с `p` либо 0
size_t matchCode(const U32 &s, size_t p) {
    const size_t n = s.size();
    if (s[p] != '`') return 0;
    size_t j = p + 1;
    while (j < n && s[j] != '`' && s[j] != '\n') ++j;
    if (j == p + 1 || j >= n || s[j] != '`') return 0;
    return j + 1;
}

// Конец `[[…]]` с `p` либо 0
size_t matchNote(const U32 &s, size_t p) {
    const size_t n = s.size();
    if (p + 1 >= n || s[p] != '[' || s[p + 1] != '[') return 0;
    size_t j = p + 2;
    while (j < n && s[j] != ']' && s[j] != '\n') ++j;
    if (j == p + 2 || j + 1 >= n || s[j] != ']' || s[j + 1] != ']') return 0;
    return j + 2;
}

// Конец `[…](…)` с `p` либо 0
size_t matchLink(const U32 &s, size_t p) {
    const size_t n = s.size();
    if (s[p] != '[') return 0;
    size_t j = p + 1;
    while (j < n && s[j] != ']' && s[j] != '\n') ++j;
    if (j == p + 1 || j + 1 >= n || s[j] != ']' || s[j + 1] != '(') return 0;
    size_t k = j + 2;
    while (k < n && s[k] != ')' && !isSpace(s[k])) ++k;
    if (k == j + 2 || k >= n || s[k] != ')') return 0;
    return k + 1;
}

// Курсив `[*_][^*_\n]+[*_]` с `q` либо 0
size_t matchItalicBody(const U32 &s, size_t q) {
    const size_t n = s.size();
    if (q >= n || !isMarkChar(s[q])) return 0;
    size_t j = q + 1;
    while (j < n && !isMarkChar(s[j]) && s[j] != '\n') ++j;
    if (j == q + 1 || j >= n || !isMarkChar(s[j])) return 0;
    return j + 1;
}

// Тег `#[\p{L}\d_/-]+` с `q` либо 0
size_t matchTagBody(const U32 &s, size_t q) {
    const size_t n = s.size();
    if (q >= n || s[q] != '#') return 0;
    size_t j = q + 1;
    while (j < n && isTagChar(s[j])) ++j;
    return j == q + 1 ? 0 : j;
}

// `(?:^|\s)<тело>` с `p`: конец совпадения либо 0
size_t matchAfterSpace(const U32 &s, size_t p, size_t (*body)(const U32 &, size_t)) {
    if (p == 0) {
        if (const size_t end = body(s, 0)) return end;
    }
    if (isSpace(s[p])) return body(s, p + 1);
    return 0;
}

struct InlineFound {
    size_t index = 0;
    size_t end = 0;
};

// INLINE — самое левое совпадение; на одном месте альтернативы пробуются по порядку
std::optional<InlineFound> findInline(const U32 &s) {
    for (size_t p = 0; p < s.size(); ++p) {
        size_t end = matchPair(s, p, '*');
        if (!end) end = matchPair(s, p, '~');
        if (!end) end = matchCode(s, p);
        if (!end) end = matchNote(s, p);
        if (!end) end = matchLink(s, p);
        if (!end) end = matchAfterSpace(s, p, matchItalicBody);
        if (!end) end = matchAfterSpace(s, p, matchTagBody);
        if (end) return InlineFound{p, end};
    }
    return std::nullopt;
}

MdInline inlineOf(const U32 &token) {
    MdInline part;
    const auto slice = [&](size_t from, size_t cut) { return encode(token.substr(from, token.size() - from - cut)); };
    if (startsWithU(token, 0, U"**")) {
        part.type = MdInlineType::Bold;
        part.text = slice(2, 2);
    } else if (startsWithU(token, 0, U"~~")) {
        part.type = MdInlineType::Strike;
        part.text = slice(2, 2);
    } else if (startsWithU(token, 0, U"`")) {
        part.type = MdInlineType::Code;
        part.text = slice(1, 1);
    } else if (startsWithU(token, 0, U"[[")) {
        const U32 inner = token.substr(2, token.size() - 4);
        const size_t bar = inner.find(U'|');
        const U32 target = inner.substr(0, bar);
        U32 alias;
        if (bar != U32::npos) {
            const size_t next = inner.find(U'|', bar + 1);
            alias = inner.substr(bar + 1, next == U32::npos ? U32::npos : next - bar - 1);
        }
        part.type = MdInlineType::Note;
        part.text = encode(trimU(alias.empty() ? target : alias));
        part.target = encode(trimU(target));
    } else if (startsWithU(token, 0, U"[")) {
        const size_t split = token.find(U"](");
        const std::string label = encode(token.substr(1, split - 1));
        const std::string url = encode(token.substr(split + 2, token.size() - split - 3));
        part.text = label;
        if (isSafeUrl(url)) {
            part.type = MdInlineType::Link;
            part.url = url;
        }
    } else if (startsWithU(token, 0, U"#")) {
        part.type = MdInlineType::Tag;
        part.text = encode(token);
    } else {
        part.type = MdInlineType::Italic;
        part.text = slice(1, 1);
    }
    return part;
}

std::vector<MdInline> mergeText(const std::vector<MdInline> &parts) {
    std::vector<MdInline> out;
    for (const auto &part : parts) {
        if (part.type == MdInlineType::Text && !out.empty() && out.back().type == MdInlineType::Text) {
            out.back().text += part.text;
        } else {
            out.push_back(part);
        }
    }
    return out;
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

} // namespace

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
    for (const auto &line : split(normalized.substr(frontMatter.size()), '\n')) lines.push_back(decode(line));
    std::vector<MdBlock> blocks;
    const std::string ownTitle = encode(toLower(trimU(decode(title))));
    std::vector<std::string> paragraph;
    int paragraphLine = 0;
    std::optional<std::vector<std::string>> code;
    int codeLine = 0;
    std::vector<std::string> quote;
    int quoteLine = 0;
    std::optional<MdBlock> list;

    const auto flush = [&] {
        if (!paragraph.empty()) {
            MdBlock block;
            block.type = MdBlockType::Paragraph;
            block.text = join(paragraph, "\n");
            block.line = paragraphLine;
            blocks.push_back(std::move(block));
        }
        if (!quote.empty()) {
            MdBlock block;
            block.type = MdBlockType::Quote;
            block.text = join(quote, "\n");
            block.line = quoteLine;
            blocks.push_back(std::move(block));
        }
        if (list) blocks.push_back(std::move(*list));
        paragraph.clear();
        quote.clear();
        list.reset();
    };
    const auto addItem = [&](bool isOrdered, MdListItem item) {
        if (!paragraph.empty() || !quote.empty() || (list && list->isOrdered != isOrdered)) flush();
        if (!list) {
            list = MdBlock{};
            list->type = MdBlockType::List;
            list->isOrdered = isOrdered;
            list->line = item.line;
        }
        list->items.push_back(std::move(item));
    };

    for (size_t i = 0; i < lines.size(); ++i) {
        const U32 &line = lines[i];
        const int at = static_cast<int>(i) + offset;
        if (code) {
            if (isFence(line)) {
                MdBlock block;
                block.type = MdBlockType::Code;
                block.text = join(*code, "\n");
                block.line = codeLine;
                blocks.push_back(std::move(block));
                code.reset();
            } else {
                code->push_back(encode(line));
            }
            continue;
        }
        if (isFence(line)) {
            flush();
            code = std::vector<std::string>{};
            codeLine = at;
            continue;
        }
        if (trimU(line).empty()) {
            flush();
            continue;
        }
        if (const auto heading = matchHeading(line)) {
            flush();
            const U32 headingText = trimU(heading->text);
            if (blocks.empty() && encode(toLower(headingText)) == ownTitle) continue;
            MdBlock block;
            block.type = MdBlockType::Heading;
            block.level = heading->level;
            block.text = encode(headingText);
            block.line = at;
            blocks.push_back(std::move(block));
            continue;
        }
        if (isRule(line)) {
            flush();
            MdBlock block;
            block.type = MdBlockType::Rule;
            block.line = at;
            blocks.push_back(std::move(block));
            continue;
        }
        if (const auto embed = matchEmbed(line)) {
            flush();
            blocks.push_back(embedOf(*embed, at));
            continue;
        }
        const bool hasBar = line.find(U'|') != U32::npos;
        if (hasBar && i + 1 < lines.size() && isTableSeparator(lines[i + 1]) && paragraph.empty()) {
            flush();
            MdBlock block;
            block.type = MdBlockType::Table;
            block.header = splitRow(line);
            std::vector<MdAlign> align;
            for (const auto &cell : splitRow(lines[i + 1])) align.push_back(alignOf(cell));
            size_t next = i + 2;
            while (next < lines.size() && lines[next].find(U'|') != U32::npos && !trimU(lines[next]).empty()) {
                const auto cells = splitRow(lines[next]);
                std::vector<std::string> row;
                for (size_t c = 0; c < block.header.size(); ++c) row.push_back(c < cells.size() ? cells[c] : "");
                block.rows.push_back(std::move(row));
                ++next;
            }
            for (size_t c = 0; c < block.header.size(); ++c) {
                block.align.push_back(c < align.size() ? align[c] : MdAlign::None);
            }
            block.line = at;
            blocks.push_back(std::move(block));
            i = next - 1;
            continue;
        }
        if (const auto task = matchTask(line)) {
            addItem(false, MdListItem{encode(task->text), depthOf(task->indent), task->isChecked, at});
            continue;
        }
        if (const auto bullet = matchBullet(line)) {
            addItem(false, MdListItem{encode(bullet->text), depthOf(bullet->indent), std::nullopt, at});
            continue;
        }
        if (const auto ordered = matchOrdered(line)) {
            addItem(true, MdListItem{encode(ordered->text), depthOf(ordered->indent), std::nullopt, at});
            continue;
        }
        if (const auto quoted = matchQuote(line)) {
            if (!paragraph.empty() || list) flush();
            if (quote.empty()) quoteLine = at;
            quote.push_back(encode(*quoted));
            continue;
        }
        if (!quote.empty() || list) flush();
        if (paragraph.empty()) paragraphLine = at;
        paragraph.push_back(encode(line));
    }
    if (code) {
        MdBlock block;
        block.type = MdBlockType::Code;
        block.text = join(*code, "\n");
        block.line = codeLine;
        blocks.push_back(std::move(block));
    }
    flush();
    return blocks;
}

std::vector<MdInline> parseInline(const std::string &text) {
    std::vector<MdInline> parts;
    U32 rest = decode(text);
    while (!rest.empty()) {
        const auto found = findInline(rest);
        if (!found) {
            parts.push_back(MdInline{MdInlineType::Text, encode(rest), "", ""});
            break;
        }
        const U32 match = rest.substr(found->index, found->end - found->index);
        const bool hasSpace = isSpace(match[0]);
        const U32 before = rest.substr(0, found->index) + (hasSpace ? match.substr(0, 1) : U32());
        if (!before.empty()) parts.push_back(MdInline{MdInlineType::Text, encode(before), "", ""});
        parts.push_back(inlineOf(match.substr(hasSpace ? 1 : 0)));
        rest = rest.substr(found->end);
    }
    return mergeText(parts);
}

std::vector<std::string> embedNames(const std::string &markdown) {
    std::vector<std::string> names;
    for (const auto &block : parseMarkdown(markdown)) {
        if (block.type == MdBlockType::Embed && !block.url
            && std::find(names.begin(), names.end(), block.name) == names.end()) {
            names.push_back(block.name);
        }
    }
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
