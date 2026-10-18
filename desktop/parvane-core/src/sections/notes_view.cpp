// Parvane fork (spec 029, T063): чистая часть экранов «Знаний» — см. notes_view.h.
#include "parvane/sections/notes_view.h"

#include <algorithm>
#include <cmath>

#include "notes_text.h"
#include "parvane/sections/notes_model.h"

namespace parvane::sections::notes {

namespace {

constexpr double kPi = 3.14159265358979323846;

bool isMarkerChar(char32_t c) {
    return (c >= 'a' && c <= 'z') || text::isAsciiDigit(c);
}

} // namespace

std::vector<PlannedItem> shownPlanned(const std::vector<PlannedItem> &items, const std::string &today, int pastMax) {
    std::vector<PlannedItem> past;
    std::vector<PlannedItem> rest;
    for (const auto &item : items) {
        if (item.day && *item.day < today) past.push_back(item);
        else rest.push_back(item);
    }
    std::vector<PlannedItem> result;
    const auto skip = past.size() > size_t(std::max(pastMax, 0)) ? past.size() - size_t(std::max(pastMax, 0)) : 0;
    result.insert(result.end(), past.begin() + skip, past.end());
    result.insert(result.end(), rest.begin(), rest.end());
    return result;
}

TaskMarkerSplit splitTaskMarker(const std::string &value) {
    // / \^(t[a-z0-9]{4,12})\s*$/
    const auto s = text::decode(value);
    auto end = s.size();
    while (end > 0 && text::isSpace(s[end - 1])) --end;
    auto start = end;
    while (start > 0 && isMarkerChar(s[start - 1])) --start;
    // Метка начинается с `t`: всё, что левее первой `t` в найденном куске, — не метка
    for (auto from = start; from < end; ++from) {
        if (s[from] != 't') continue;
        const auto length = end - from - 1;
        if (length < 4 || length > 12) continue;
        if (from < 2 || s[from - 1] != '^' || s[from - 2] != ' ') continue;
        return {text::encode(s, 0, from - 2), text::encode(s, from, end)};
    }
    return {value, std::nullopt};
}

std::vector<std::string> titleLinks(const std::string &value) {
    // /\[\[([^\]|\n]+)/g
    std::vector<std::string> result;
    const auto s = text::decode(value);
    size_t i = 0;
    while (i + 1 < s.size()) {
        if (s[i] != '[' || s[i + 1] != '[') {
            ++i;
            continue;
        }
        auto j = i + 2;
        while (j < s.size() && s[j] != ']' && s[j] != '|' && s[j] != '\n') ++j;
        if (j == i + 2) {
            ++i;
            continue;
        }
        result.push_back(text::trim(text::encode(s, i + 2, j)));
        i = j;
    }
    return result;
}

std::vector<GraphRecordInput> graphRecordsOf(const planner::State &state) {
    std::vector<GraphRecordInput> result;
    result.reserve(state.events.size() + state.tasks.size());
    for (const auto &event : state.events) {
        result.push_back({"e" + event.id, event.name, titleLinks(event.name), std::string("event")});
    }
    for (const auto &task : state.tasks) {
        result.push_back({"t" + task.id, task.name, titleLinks(task.name), std::string("task")});
    }
    return result;
}

std::string recordLabel(const std::string &title) {
    // .replace(/\[\[[^\]\n]*\]\]/g, '').replace(/\s+/g, ' ').trim()
    const auto s = text::decode(title);
    text::U32 stripped;
    size_t i = 0;
    while (i < s.size()) {
        if (i + 1 < s.size() && s[i] == '[' && s[i + 1] == '[') {
            auto j = i + 2;
            while (j < s.size() && s[j] != ']' && s[j] != '\n') ++j;
            if (j + 1 < s.size() && s[j] == ']' && s[j + 1] == ']') {
                i = j + 2;
                continue;
            }
        }
        stripped.push_back(s[i]);
        ++i;
    }
    text::U32 collapsed;
    bool space = false;
    for (const auto c : stripped) {
        if (text::isSpace(c)) {
            space = true;
            continue;
        }
        if (space && !collapsed.empty()) collapsed.push_back(' ');
        space = false;
        collapsed.push_back(c);
    }
    const auto result = text::encode(collapsed);
    return result.empty() ? title : result;
}

std::string shortenLabel(const std::string &value, int max) {
    const auto s = text::decode(value);
    if (max <= 0 || s.size() <= size_t(max)) return value;
    return text::encode(s, 0, size_t(max - 1)) + "…";
}

std::string graphQueryText(const std::string &value) {
    return noteSearchText(text::trim(value));
}

bool isGraphFound(const std::string &query, const std::string &label, const std::string &title) {
    const auto wanted = graphQueryText(query);
    if (wanted.empty()) return false;
    return graphQueryText(label).find(wanted) != std::string::npos
        || graphQueryText(title).find(wanted) != std::string::npos;
}

std::optional<size_t> nextFoundIndex(const std::vector<std::string> &hitIds, const std::optional<std::string> &pickedId) {
    if (hitIds.empty()) return std::nullopt;
    const auto at = pickedId ? std::find(hitIds.begin(), hitIds.end(), *pickedId) : hitIds.end();
    if (at == hitIds.end()) return 0; // findIndex −1 → (−1 + 1) % n
    return (size_t(at - hitIds.begin()) + 1) % hitIds.size();
}

std::vector<std::string> toggleGraphFolder(const std::optional<std::vector<std::string>> &folders,
                                           const std::string &path) {
    if (!folders) return {path};
    auto result = *folders;
    const auto at = std::find(result.begin(), result.end(), path);
    if (at != result.end()) result.erase(at);
    else result.push_back(path);
    return result;
}

std::vector<GraphPoint> miniGraphPlaces(size_t count) {
    const auto shown = std::min(count, size_t(kMiniGraphMaxPoints));
    std::vector<GraphPoint> result;
    result.reserve(shown);
    for (size_t i = 0; i < shown; ++i) {
        const auto angle = -kPi / 2 + (double(i) / double(shown)) * kPi * 2;
        result.push_back({kMiniGraphWidth / 2 + std::cos(angle) * kMiniGraphRadiusX,
                          kMiniGraphHeight / 2 + std::sin(angle) * kMiniGraphRadiusY});
    }
    return result;
}

std::optional<std::string> newNoteFolder(const NewNoteContext &context) {
    if (!context.openFolder || context.openIsDay) return std::nullopt;
    if (context.guideFolder && *context.guideFolder == *context.openFolder) return std::nullopt;
    if (context.openFolder->empty()) return std::nullopt;
    return context.openFolder;
}

} // namespace parvane::sections::notes
