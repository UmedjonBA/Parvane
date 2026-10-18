// Parvane fork (spec 029, фаза 4): порт web `notes/notesMerge.ts`.
#include "parvane/sections/notes_merge.h"

#include <algorithm>
#include <cstdint>
#include <optional>
#include <vector>

namespace parvane::sections::notes {

namespace {

constexpr long long kNoMatch = -1;

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

// Завершающий перевод строки — не отдельная пустая строка
std::vector<std::string> splitLines(const std::string &text) {
    std::vector<std::string> lines;
    if (text.empty()) return lines;
    const std::string body = text.back() == '\n' ? text.substr(0, text.size() - 1) : text;
    size_t start = 0;
    while (true) {
        const size_t at = body.find('\n', start);
        if (at == std::string::npos) {
            lines.push_back(body.substr(start));
            return lines;
        }
        lines.push_back(body.substr(start, at - start));
        start = at + 1;
    }
}

bool areEqual(const std::vector<std::string> &a, size_t aFrom, size_t aTo, const std::vector<std::string> &b,
    size_t bFrom, size_t bTo) {
    if (aTo - aFrom != bTo - bFrom) return false;
    return std::equal(a.begin() + aFrom, a.begin() + aTo, b.begin() + bFrom);
}

/**
 * Наибольшая общая подпоследовательность строк: для каждой строки `from` — номер парной строки в `to` либо
 * `kNoMatch`. Слишком большие тексты не сравниваются — std::nullopt.
 */
std::optional<std::vector<long long>> matchLines(const std::vector<std::string> &from, const std::vector<std::string> &to) {
    std::vector<long long> match(from.size(), kNoMatch);
    size_t head = 0;
    while (head < from.size() && head < to.size() && from[head] == to[head]) {
        match[head] = static_cast<long long>(head);
        ++head;
    }
    size_t tail = 0;
    while (tail < from.size() - head && tail < to.size() - head
        && from[from.size() - 1 - tail] == to[to.size() - 1 - tail]) {
        match[from.size() - 1 - tail] = static_cast<long long>(to.size() - 1 - tail);
        ++tail;
    }

    const size_t rows = from.size() - head - tail;
    const size_t columns = to.size() - head - tail;
    if (!rows || !columns) return match;
    if (static_cast<long long>(rows) * static_cast<long long>(columns) > kMaxDiffCells) return std::nullopt;

    // `lengths[row * width + column]` — длина общей части хвостов `from[head + row…]` и `to[head + column…]`
    const size_t width = columns + 1;
    std::vector<uint32_t> lengths((rows + 1) * width, 0);
    for (size_t row = rows; row-- > 0;) {
        for (size_t column = columns; column-- > 0;) {
            lengths[row * width + column] = from[head + row] == to[head + column]
                ? lengths[(row + 1) * width + column + 1] + 1
                : std::max(lengths[(row + 1) * width + column], lengths[row * width + column + 1]);
        }
    }

    size_t row = 0;
    size_t column = 0;
    while (row < rows && column < columns) {
        if (from[head + row] == to[head + column]) {
            match[head + row] = static_cast<long long>(head + column);
            ++row;
            ++column;
        } else if (lengths[(row + 1) * width + column] >= lengths[row * width + column + 1]) {
            ++row;
        } else {
            ++column;
        }
    }
    return match;
}

} // namespace

NotesMergeResult mergeNotes(const std::string &base, const std::string &mine, const std::string &theirs) {
    const std::string baseText = normalizeEol(base);
    const std::string mineText = normalizeEol(mine);
    const std::string theirsText = normalizeEol(theirs);
    if (mineText == theirsText || theirsText == baseText) return {mineText, false};
    if (mineText == baseText) return {theirsText, false};

    const auto baseLines = splitLines(baseText);
    const auto mineLines = splitLines(mineText);
    const auto theirsLines = splitLines(theirsText);
    const auto mineMatch = matchLines(baseLines, mineLines);
    const auto theirsMatch = matchLines(baseLines, theirsLines);
    const NotesMergeResult conflict{mineText, true};
    if (!mineMatch || !theirsMatch) return conflict;

    std::vector<std::string> merged;
    size_t baseAt = 0;
    size_t mineAt = 0;
    size_t theirsAt = 0;
    while (baseAt < baseLines.size() || mineAt < mineLines.size() || theirsAt < theirsLines.size()) {
        // Общий участок: строки основы стоят на своих местах у обеих сторон
        size_t stable = 0;
        while (baseAt + stable < baseLines.size()
            && (*mineMatch)[baseAt + stable] == static_cast<long long>(mineAt + stable)
            && (*theirsMatch)[baseAt + stable] == static_cast<long long>(theirsAt + stable)) {
            ++stable;
        }
        if (stable) {
            merged.insert(merged.end(), baseLines.begin() + baseAt, baseLines.begin() + baseAt + stable);
            baseAt += stable;
            mineAt += stable;
            theirsAt += stable;
            continue;
        }

        // Изменённый участок тянется до ближайшей строки основы, уцелевшей у обеих сторон
        size_t baseEnd = baseAt;
        while (baseEnd < baseLines.size()
            && ((*mineMatch)[baseEnd] == kNoMatch || (*theirsMatch)[baseEnd] == kNoMatch)) {
            ++baseEnd;
        }
        const size_t mineEnd = baseEnd < baseLines.size() ? static_cast<size_t>((*mineMatch)[baseEnd]) : mineLines.size();
        const size_t theirsEnd = baseEnd < baseLines.size() ? static_cast<size_t>((*theirsMatch)[baseEnd])
                                                            : theirsLines.size();

        const bool theirsIsBase = areEqual(theirsLines, theirsAt, theirsEnd, baseLines, baseAt, baseEnd);
        const bool mineIsTheirs = areEqual(mineLines, mineAt, mineEnd, theirsLines, theirsAt, theirsEnd);
        if (theirsIsBase || mineIsTheirs) {
            merged.insert(merged.end(), mineLines.begin() + mineAt, mineLines.begin() + mineEnd);
        } else if (areEqual(mineLines, mineAt, mineEnd, baseLines, baseAt, baseEnd)) {
            merged.insert(merged.end(), theirsLines.begin() + theirsAt, theirsLines.begin() + theirsEnd);
        } else {
            return conflict;
        }

        baseAt = baseEnd;
        mineAt = mineEnd;
        theirsAt = theirsEnd;
    }

    const bool hasFinalEol = !mineText.empty() && mineText.back() == '\n' && !merged.empty();
    std::string text;
    for (size_t i = 0; i < merged.size(); ++i) {
        if (i) text.push_back('\n');
        text += merged[i];
    }
    if (hasFinalEol) text.push_back('\n');
    return {text, false};
}

} // namespace parvane::sections::notes
