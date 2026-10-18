// Parvane fork (spec 029, фаза 4): порт web `notes/notesLinkEdit.ts`. Регулярки web разобраны вручную по кодовым
// точкам.
#include "parvane/sections/notes_link_edit.h"

#include <algorithm>
#include <vector>

#include "notes_text.h"
#include "parvane/sections/notes_model.h"

namespace parvane::sections::notes {

namespace {

using namespace text;

const std::string kCrlf = "\r\n";

struct SplitText {
    std::string eol;
    std::vector<std::string> lines;
};

SplitText splitText(const std::string &value) {
    SplitText result{value.find(kCrlf) != std::string::npos ? kCrlf : "\n", {}};
    // split(/\r?\n/)
    size_t start = 0;
    while (true) {
        const size_t at = value.find('\n', start);
        if (at == std::string::npos) {
            result.lines.push_back(value.substr(start));
            break;
        }
        size_t end = at;
        if (end > start && value[end - 1] == '\r') --end;
        result.lines.push_back(value.substr(start, end - start));
        start = at + 1;
    }
    return result;
}

bool isFilled(const std::string &line) { return !trim(line).empty(); }

int lastFilled(const std::vector<std::string> &lines, int from, int to) {
    for (int i = to - 1; i >= from; --i) {
        if (isFilled(lines[i])) return i;
    }
    return -1;
}

bool isSeparator(char32_t c) { return isSpace(c) || c == ',' || c == ';' || c == 0xB7; }

// LINKS_ONLY = /^\s*(?:[-*+]\s+)?(?:\[\[[^[\]]+\]\][\s,;·]*)+$/
bool isLinksOnly(const std::string &line) {
    const U32 s = decode(line);
    const size_t n = s.size();
    size_t i = 0;
    while (i < n && isSpace(s[i])) ++i;
    if (i < n && (s[i] == '-' || s[i] == '*' || s[i] == '+') && i + 1 < n && isSpace(s[i + 1])) {
        ++i;
        while (i < n && isSpace(s[i])) ++i;
    }
    int count = 0;
    while (i + 1 < n && s[i] == '[' && s[i + 1] == '[') {
        size_t j = i + 2;
        while (j < n && s[j] != '[' && s[j] != ']') ++j;
        if (j == i + 2 || j + 1 >= n || s[j] != ']' || s[j + 1] != ']') return false;
        i = j + 2;
        while (i < n && isSeparator(s[i])) ++i;
        ++count;
    }
    return count > 0 && i == n;
}

// BULLET = /^(\s*[-*+]\s+)/ — приставка пункта списка либо пусто
std::string bulletOf(const std::string &line) {
    const U32 s = decode(line);
    size_t i = 0;
    while (i < s.size() && isSpace(s[i])) ++i;
    if (i >= s.size() || (s[i] != '-' && s[i] != '*' && s[i] != '+')) return "";
    ++i;
    const size_t wsStart = i;
    while (i < s.size() && isSpace(s[i])) ++i;
    return i == wsStart ? "" : encode(s, 0, i);
}

// HEADING = /^\s{0,3}#{1,6}\s/
bool isHeading(const std::string &line) {
    const U32 s = decode(line);
    size_t i = 0;
    while (i < s.size() && isSpace(s[i])) ++i;
    if (i > 3) return false;
    const size_t hashStart = i;
    while (i < s.size() && s[i] == '#') ++i;
    const size_t hashes = i - hashStart;
    return hashes >= 1 && hashes <= 6 && i < s.size() && isSpace(s[i]);
}

// Хвост LINKS_HEADING: (?:\*\*)?\s*:?\s*(?:\*\*)?\s*$
bool isHeadingTail(const U32 &s, size_t i) {
    const size_t n = s.size();
    auto skipSpace = [&] { while (i < n && isSpace(s[i])) ++i; };
    auto skipStars = [&] { if (i + 1 < n && s[i] == '*' && s[i + 1] == '*') i += 2; };
    skipStars();
    skipSpace();
    if (i < n && s[i] == ':') ++i;
    skipSpace();
    skipStars();
    skipSpace();
    return i == n;
}

// Конец слова-названия раздела с `i` (строка в нижнем регистре) либо npos
std::vector<size_t> headingWordEnds(const U32 &s, size_t i) {
    std::vector<size_t> ends;
    const size_t n = s.size();
    auto word = [&](const U32 &literal) { if (startsWithU(s, i, literal)) ends.push_back(i + literal.size()); };
    word(U"связи");
    word(U"ссылки");
    word(U"связанное");
    word(U"links");
    word(U"related");
    // см\.?\s*также
    if (startsWithU(s, i, U"см")) {
        size_t j = i + 2;
        if (j < n && s[j] == '.') ++j;
        while (j < n && isSpace(s[j])) ++j;
        if (startsWithU(s, j, U"также")) ends.push_back(j + 5);
    }
    // смотри(?:те)?\s+также
    if (startsWithU(s, i, U"смотри")) {
        size_t j = i + 6;
        if (startsWithU(s, j, U"те")) j += 2;
        const size_t wsStart = j;
        while (j < n && isSpace(s[j])) ++j;
        if (j > wsStart && startsWithU(s, j, U"также")) ends.push_back(j + 5);
    }
    // see\s+also
    if (startsWithU(s, i, U"see")) {
        size_t j = i + 3;
        const size_t wsStart = j;
        while (j < n && isSpace(s[j])) ++j;
        if (j > wsStart && startsWithU(s, j, U"also")) ends.push_back(j + 4);
    }
    return ends;
}

// LINKS_HEADING (без учёта регистра): заголовок либо строка-подпись раздела со ссылками
bool isLinksHeading(const std::string &line) {
    const U32 s = toLower(decode(line));
    const size_t n = s.size();
    size_t i = 0;
    while (i < n && isSpace(s[i])) ++i;
    // (?:#{1,6}\s+)?
    if (i < n && s[i] == '#') {
        size_t j = i;
        while (j < n && s[j] == '#') ++j;
        const size_t hashes = j - i;
        const size_t wsStart = j;
        while (j < n && isSpace(s[j])) ++j;
        if (hashes > 6 || j == wsStart) return false;
        i = j;
    }
    if (i + 1 < n && s[i] == '*' && s[i + 1] == '*') i += 2;
    for (size_t end : headingWordEnds(s, i)) {
        if (isHeadingTail(s, end)) return true;
    }
    return false;
}

// SEPARATORS_BEFORE = /^[\s,;·]*/ → ''
std::string stripSeparatorsBefore(const std::string &value) {
    const U32 s = decode(value);
    size_t i = 0;
    while (i < s.size() && isSeparator(s[i])) ++i;
    return encode(s.substr(i));
}

// SEPARATORS_AFTER = /[\s,;·]+$/ → ''
std::string stripSeparatorsAfter(const std::string &value) {
    U32 s = decode(value);
    while (!s.empty() && isSeparator(s.back())) s.pop_back();
    return encode(s);
}

bool isUnlinkable(char32_t c) { return c == '[' || c == ']' || c == '|' || c == '\r' || c == '\n'; }

} // namespace

bool canLinkTitle(const std::string &title) {
    if (trim(title).empty()) return false;
    const U32 s = decode(title);
    return std::none_of(s.begin(), s.end(), isUnlinkable);
}

AddLinkResult addLinkToText(const std::string &text, const std::string &title) {
    const std::string target = trim(title);
    if (!canLinkTitle(target)) return {AddLinkStatus::Refused, text};
    const NoteLines scan = scanNoteLines(text);
    const std::string key = normalizeNoteTitle(target);
    for (const auto &found : scan.links) {
        for (const auto &link : found) {
            if (normalizeNoteTitle(link.target) == key) return {AddLinkStatus::Exists, text};
        }
    }

    auto [eol, lines] = splitText(text);
    const std::string link = "[[" + target + "]]";
    // Новая строка повторяет вид соседней: в списке ссылок — пункт списка
    const auto like = [&](int index) { return bulletOf(lines[index]) + link; };
    const auto isLinksLine = [&](int index) { return !scan.skipped[index] && isLinksOnly(lines[index]); };
    const int count = static_cast<int>(lines.size());

    int heading = -1;
    for (int index = 0; index < count; ++index) {
        if (!scan.skipped[index] && isLinksHeading(lines[index])) heading = index;
    }
    if (heading >= 0) {
        int end = -1;
        for (int index = heading + 1; index < count; ++index) {
            if (!scan.skipped[index] && isHeading(lines[index])) {
                end = index;
                break;
            }
        }
        if (end < 0) end = count;
        const int filled = lastFilled(lines, heading + 1, end);
        std::vector<std::string> added = filled < 0 ? std::vector<std::string>{"", link}
                                                    : std::vector<std::string>{isLinksLine(filled) ? like(filled) : link};
        const int at = (filled < 0 ? heading : filled) + 1;
        // Раздел не в конце заметки: следующая за ним строка остаётся отделена пустой
        if (at < count && isFilled(lines[at])) added.push_back("");
        lines.insert(lines.begin() + at, added.begin(), added.end());
        return {AddLinkStatus::Added, join(lines, eol)};
    }

    const int last = lastFilled(lines, 0, count);
    if (last < 0) return {AddLinkStatus::Added, link + eol};
    // Заметка, кончавшаяся переводом строки, им и кончается; без него — кончается ссылкой
    const bool hasFinalEol = !isFilled(lines.back());
    std::vector<std::string> kept(lines.begin(), lines.begin() + last + 1);
    if (isLinksLine(last)) {
        kept.push_back(like(last));
    } else {
        kept.push_back("");
        kept.push_back(link);
    }
    if (hasFinalEol) kept.push_back("");
    return {AddLinkStatus::Added, join(kept, eol)};
}

RemoveLinkResult removeLinkFromText(const std::string &text, const std::string &title) {
    const std::string key = normalizeNoteTitle(title);
    const NoteLines scan = scanNoteLines(text);
    struct Found {
        size_t line;
        size_t from;
        size_t to;
    };
    std::vector<Found> found;
    for (size_t line = 0; line < scan.links.size(); ++line) {
        for (const auto &link : scan.links[line]) {
            if (normalizeNoteTitle(link.target) == key) found.push_back({line, link.from, link.to});
        }
    }
    if (found.empty()) return {RemoveLinkStatus::None, text, 0, 0};

    auto [eol, lines] = splitText(text);
    const auto inline_ = std::find_if(found.begin(), found.end(), [&](const Found &item) {
        return !isLinksOnly(lines[item.line]);
    });
    if (inline_ != found.end()) {
        size_t offset = 0;
        for (size_t i = 0; i < inline_->line; ++i) offset += scan.lines[i].size() + 1;
        return {RemoveLinkStatus::Inline, text, offset + inline_->from, offset + inline_->to};
    }

    const auto isBlank = [&](long long index) {
        return index < 0 || index >= static_cast<long long>(lines.size()) || !isFilled(lines[index]);
    };
    // С конца: удаление не сдвигает ещё не обработанные ссылки
    for (auto item = found.rbegin(); item != found.rend(); ++item) {
        const std::string content = lines[item->line];
        const std::string rest = content.substr(0, item->from) + stripSeparatorsBefore(content.substr(item->to));
        if (rest.find("[[") != std::string::npos) {
            lines[item->line] = stripSeparatorsAfter(rest);
            continue;
        }
        const long long line = static_cast<long long>(item->line);
        lines.erase(lines.begin() + line);
        // Пустая строка, отделявшая ссылку, уходит вместе с ней: двух пустых подряд и пустой в конце не остаётся
        if (line > 0 && isBlank(line - 1) && isBlank(line)) lines.erase(lines.begin() + (line - 1));
    }
    return {RemoveLinkStatus::Removed, join(lines, eol), 0, 0};
}

} // namespace parvane::sections::notes
