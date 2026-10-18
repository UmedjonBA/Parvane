// Parvane fork (spec 029, фаза 4): настройки «Знаний» на устройстве — чистая часть web `notes/notesPrefs.ts`.
#include "parvane/sections/notes_prefs.h"

#include <algorithm>

#include <nlohmann/json.hpp>

namespace parvane::sections::notes {

namespace {

// `JSON.parse(value || fallback)`; не разобрать — nullopt
std::optional<nlohmann::json> parse(const std::optional<std::string> &stored, const char *fallback) {
    const std::string text = stored && !stored->empty() ? *stored : fallback;
    auto value = nlohmann::json::parse(text, nullptr, false);
    if (value.is_discarded()) return std::nullopt;
    return value;
}

std::vector<std::string> strings(const nlohmann::json &array) {
    std::vector<std::string> out;
    for (const auto &item : array) {
        if (item.is_string()) out.push_back(item.get<std::string>());
    }
    return out;
}

std::string serializeList(const std::vector<std::string> &values) {
    const size_t count = std::min(values.size(), kCollapsedFoldersMax);
    return nlohmann::json(std::vector<std::string>(values.begin(), values.begin() + count)).dump();
}

} // namespace

std::vector<std::string> parseCollapsedFolders(const std::optional<std::string> &stored) {
    const auto value = parse(stored, "[]");
    return value && value->is_array() ? strings(*value) : std::vector<std::string>{};
}

std::string serializeCollapsedFolders(const std::vector<std::string> &keys) { return serializeList(keys); }

std::optional<std::vector<std::string>> parseGraphFolders(const std::optional<std::string> &stored) {
    const auto value = parse(stored, "null");
    if (!value || !value->is_array()) return std::nullopt;
    return strings(*value);
}

std::optional<std::string> serializeGraphFolders(const std::optional<std::vector<std::string>> &paths) {
    if (!paths) return std::nullopt;
    return serializeList(*paths);
}

std::string guideSeenKey(const std::optional<std::string> &userId) {
    return kKnowledgeGuideSeenKey + ":" + userId.value_or("");
}

bool isGuideSeenValue(const std::optional<std::string> &stored) { return stored == kGuideSeenValue; }

CanvasImageQuality parseCanvasImageQuality(const std::optional<std::string> &stored) {
    return stored == std::optional<std::string>("thumb") ? CanvasImageQuality::Thumb : CanvasImageQuality::Full;
}

std::string canvasImageQualityValue(CanvasImageQuality quality) {
    return quality == CanvasImageQuality::Thumb ? "thumb" : "full";
}

} // namespace parvane::sections::notes
