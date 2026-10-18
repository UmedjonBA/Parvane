// Parvane fork (spec 029, фаза 4): порт web `components/parvane/palette/paletteSearch.ts` и `paletteKeys.ts`.
#include "parvane/sections/palette_search.h"

#include <algorithm>
#include <map>

#include "unicode_lite.h"

namespace parvane::sections::palette {

namespace u = parvane::sections::unicode_lite;

namespace {

constexpr int kSnippetBefore = 24;
constexpr int kSnippetLength = 90;

// Чем меньше, тем выше
constexpr int kRankTitleStart = 0;
constexpr int kRankWordStart = 1;
constexpr int kRankInside = 2;
constexpr int kRankTextWord = 3;
constexpr int kRankTextInside = 4;

std::u32string normalize32(std::u32string_view value) {
    std::u32string out;
    out.reserve(value.size());
    for (const char32_t c : value) {
        const char32_t lower = u::lower(c);
        out.push_back(lower == U'ё' ? U'е' : lower);
    }
    return out;
}

bool isWordStart(const std::u32string &text, size_t index) {
    if (index == 0) return true;
    return !u::isLetterOrNumber(text[index - 1]);
}

struct Found {
    size_t index = 0;
    bool isWordStart = false;
};

// Лучшее вхождение слова запроса: сначала то, что начинает слово
std::optional<Found> findTerm(const std::u32string &text, const std::u32string &term) {
    std::optional<size_t> first;
    for (size_t index = text.find(term); index != std::u32string::npos; index = text.find(term, index + 1)) {
        if (isWordStart(text, index)) return Found{index, true};
        if (!first) first = index;
    }
    if (!first) return std::nullopt;
    return Found{*first, false};
}

std::vector<PaletteRange> mergeRanges(std::vector<PaletteRange> ranges) {
    std::stable_sort(ranges.begin(), ranges.end(), [](const auto &a, const auto &b) { return a.first < b.first; });
    std::vector<PaletteRange> merged;
    for (const auto &[from, to] : ranges) {
        if (!merged.empty() && from <= merged.back().second) merged.back().second = std::max(merged.back().second, to);
        else merged.emplace_back(from, to);
    }
    return merged;
}

PaletteSnippet buildSnippet(const std::u32string &text, const std::vector<PaletteRange> &hits) {
    int first = hits.front().first;
    for (const auto &h : hits) first = std::min(first, h.first);
    // Отрывок не выходит за строку текста, в которой стоит первое совпадение
    int lineStart = 0;
    if (first > 0) {
        const auto at = text.rfind(U'\n', static_cast<size_t>(first - 1));
        lineStart = at == std::u32string::npos ? 0 : static_cast<int>(at) + 1;
    } else if (!text.empty() && text[0] == U'\n') {
        lineStart = 1; // lastIndexOf('\n', -1) в JS смотрит на позицию 0
    }
    const auto endAt = text.find(U'\n', static_cast<size_t>(first));
    const int lineEnd = endAt == std::u32string::npos ? static_cast<int>(text.size()) : static_cast<int>(endAt);
    const int from = std::max(lineStart, first - kSnippetBefore);
    const int to = std::min(lineEnd, from + kSnippetLength);
    const std::u32string prefix = from > lineStart ? U"…" : U"";
    const std::u32string suffix = to < lineEnd ? U"…" : U"";
    std::vector<PaletteRange> shifted;
    for (const auto &[hitFrom, hitTo] : hits) {
        if (hitFrom >= from && hitTo <= to) {
            const int shift = static_cast<int>(prefix.size()) - from;
            shifted.emplace_back(hitFrom + shift, hitTo + shift);
        }
    }
    PaletteSnippet snippet;
    snippet.text = u::encode(prefix + text.substr(from, std::max(0, to - from)) + suffix);
    snippet.ranges = mergeRanges(std::move(shifted));
    return snippet;
}

struct Match {
    PaletteResult result;
    int rank = 0;
    size_t order = 0;
};

std::optional<Match> matchItem(const PaletteItem &item, const std::vector<std::u32string> &terms, size_t order,
    bool withText) {
    const std::u32string title = item.normTitle ? u::decode(*item.normTitle) : normalize32(u::decode(item.title));
    std::u32string text;
    if (withText) {
        if (item.normText) text = u::decode(*item.normText);
        else if (item.text) text = normalize32(u::decode(*item.text));
    }
    std::vector<PaletteRange> ranges;
    std::vector<PaletteRange> textHits;
    int rank = 0;
    for (const auto &term : terms) {
        const int len = static_cast<int>(term.size());
        if (const auto inTitle = findTerm(title, term)) {
            const int at = static_cast<int>(inTitle->index);
            ranges.emplace_back(at, at + len);
            rank += at == 0 ? kRankTitleStart : inTitle->isWordStart ? kRankWordStart : kRankInside;
            continue;
        }
        const auto inText = text.empty() ? std::nullopt : findTerm(text, term);
        if (!inText) return std::nullopt;
        const int at = static_cast<int>(inText->index);
        textHits.emplace_back(at, at + len);
        rank += inText->isWordStart ? kRankTextWord : kRankTextInside;
    }
    Match match;
    match.result.index = order;
    match.result.ranges = mergeRanges(std::move(ranges));
    if (!textHits.empty()) match.result.snippet = buildSnippet(u::decode(item.text.value_or("")), textHits);
    match.rank = rank;
    match.order = order;
    return match;
}

} // namespace

const char *groupName(PaletteGroup group) {
    switch (group) {
    case PaletteGroup::Command: return "command";
    case PaletteGroup::Chat: return "chat";
    case PaletteGroup::Note: return "note";
    case PaletteGroup::Record: return "record";
    }
    return "command";
}

std::string normalizePaletteText(std::string_view value) {
    return u::encode(normalize32(u::decode(value)));
}

std::vector<std::string> splitPaletteQuery(std::string_view query) {
    const auto norm = normalize32(u::decode(query));
    std::vector<std::string> out;
    std::u32string current;
    for (const char32_t c : norm) {
        if (u::isJsSpace(c)) {
            if (!current.empty()) out.push_back(u::encode(current));
            current.clear();
        } else {
            current.push_back(c);
        }
    }
    if (!current.empty()) out.push_back(u::encode(current));
    return out;
}

PaletteItem withNormalized(PaletteItem item) {
    item.normTitle = normalizePaletteText(item.title);
    item.normText = item.text ? std::optional<std::string>(normalizePaletteText(*item.text)) : std::nullopt;
    return item;
}

std::vector<PaletteSection> searchPalette(const std::vector<PaletteItem> &items, std::string_view query, int limit) {
    std::vector<std::u32string> terms;
    size_t joined = 0;
    for (const auto &t : splitPaletteQuery(query)) {
        terms.push_back(u::decode(t));
        joined += terms.back().size();
    }
    const bool withText = static_cast<int>(joined) >= kTextMinQueryLength;
    std::map<PaletteGroup, std::vector<Match>> byGroup;
    for (size_t order = 0; order < items.size(); ++order) {
        const auto &item = items[order];
        std::optional<Match> match;
        if (!terms.empty()) {
            match = matchItem(item, terms, order, withText);
        } else if (item.group == PaletteGroup::Command) {
            Match m;
            m.result.index = order;
            m.order = order;
            match = std::move(m);
        }
        if (match) byGroup[item.group].push_back(std::move(*match));
    }
    std::vector<PaletteSection> sections;
    for (const auto group : kPaletteGroups) {
        auto it = byGroup.find(group);
        if (it == byGroup.end()) continue;
        auto &matches = it->second;
        std::stable_sort(matches.begin(), matches.end(), [](const Match &a, const Match &b) {
            return a.rank != b.rank ? a.rank < b.rank : a.order < b.order;
        });
        // Команд немного, и без запроса они — всё содержимое палитры: их не обрезаем
        const bool all = group == PaletteGroup::Command && terms.empty();
        const size_t shown = all ? matches.size() : std::min(matches.size(), static_cast<size_t>(std::max(0, limit)));
        PaletteSection section;
        section.group = group;
        for (size_t i = 0; i < shown; ++i) section.results.push_back(std::move(matches[i].result));
        sections.push_back(std::move(section));
    }
    return sections;
}

std::vector<PalettePart> splitByRanges(std::string_view text, const std::vector<PaletteRange> &ranges) {
    const auto cps = u::decode(text);
    const int size = static_cast<int>(cps.size());
    auto slice = [&](int from, int to) {
        from = std::clamp(from, 0, size);
        to = std::clamp(to, 0, size);
        return u::encode(to > from ? std::u32string_view(cps).substr(from, to - from) : std::u32string_view());
    };
    std::vector<PalettePart> parts;
    int position = 0;
    for (const auto &[from, to] : ranges) {
        if (from > position) parts.push_back({slice(position, from), false});
        parts.push_back({slice(from, to), true});
        position = to;
    }
    if (position < size) parts.push_back({slice(position, size), false});
    return parts;
}

int movePaletteIndex(int index, int delta, int count) {
    if (count <= 0) return 0;
    // JS `%` сохраняет знак делимого — как и C++
    return (index + delta + count) % count;
}

bool isEditableTarget(const PaletteKeyTarget &target) {
    if (!target.isElement) return false;
    if (target.isContentEditable) return true;
    if (target.tagName == "INPUT" || target.tagName == "TEXTAREA" || target.tagName == "SELECT") return true;
    return target.insideEditable;
}

bool isPaletteSlashKey(const PaletteKeyEvent &e) {
    if (e.key != "/" || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return false;
    return !isEditableTarget(e.target);
}

bool isPaletteHotkey(const PaletteKeyEvent &e) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return false;
    return e.code == "KeyK" || u::toLower(e.key) == "k";
}

} // namespace parvane::sections::palette
