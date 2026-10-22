// Parvane fork (spec 029, фаза 4): карточки файлов и ссылок на холсте — порт web `notes/notesCanvasFiles.ts`.
#include "parvane/sections/notes_canvas_files.h"

#include <algorithm>
#include <cmath>
#include <map>
#include <set>

#include "notes_text.h"
#include "parvane/sections/notes_canvas.h"

namespace parvane::sections::notes {

namespace {

const std::string kNoteSuffix = ".md";
constexpr std::size_t kTitleMax = 200;
constexpr std::size_t kDescriptionMax = 400;
// Картинку превью рисуем только растровую: SVG может нести сценарий
const std::vector<std::string> kImageMimes = {"image/jpeg", "image/png", "image/webp", "image/gif"};
const std::vector<std::string> kSizeUnits = {"B", "KB", "MB", "GB"};
constexpr double kSizeStep = 1024;
const std::vector<std::string> kSpecialSchemes = {"http", "https", "ws", "wss", "ftp", "file"};

std::optional<std::string> parentOf(const cloud::CloudNode &node) {
    if (!node.parent || node.parent->empty()) return std::nullopt;
    return node.parent;
}

std::string asciiLower(std::string value) {
    for (auto &c : value) {
        if (c >= 'A' && c <= 'Z') c = static_cast<char>(c + 32);
    }
    return value;
}

// `(text || '').replace(/\s+/g, ' ').trim()`, затем `slice(0, max)` в единицах UTF-16; пусто — nullopt
std::optional<std::string> cleanText(const std::optional<std::string> &value, std::size_t max) {
    text::U32 out;
    bool inSpace = false;
    for (char32_t c : text::decode(value.value_or(""))) {
        if (text::isSpace(c)) {
            if (!inSpace) out.push_back(U' ');
            inSpace = true;
        } else {
            out.push_back(c);
            inSpace = false;
        }
    }
    const auto trimmed = text::encode(text::trimU(out));
    if (trimmed.empty()) return std::nullopt;
    return canvasjs::utf16Slice(trimmed, max);
}

// `Number.prototype.toFixed(1)`: половина — вверх
std::string toFixed1(double value) {
    const double scaled = value * 10;
    double n = std::floor(scaled);
    if (scaled - n >= 0.5) n += 1;
    const long long whole = static_cast<long long>(n);
    return std::to_string(whole / 10) + "." + std::to_string(whole % 10);
}

} // namespace

std::string drivePathOf(const std::vector<cloud::CloudNode> &nodes, const std::string &id) {
    std::map<std::string, const cloud::CloudNode *> byId;
    for (const auto &node : nodes) byId.emplace(node.id, &node);
    auto find = [&](const std::optional<std::string> &key) -> const cloud::CloudNode * {
        if (!key) return nullptr;
        const auto it = byId.find(*key);
        return it == byId.end() ? nullptr : it->second;
    };
    std::vector<std::string> names;
    const cloud::CloudNode *current = find(id);
    // Ревью 21 окт 2026: цикл родителей — до повтора; путь — с конца и разворотом (без квадрата на цепочке)
    std::set<const cloud::CloudNode *> seen;
    while (current && seen.insert(current).second) {
        names.push_back(current->name);
        current = find(parentOf(*current));
    }
    std::reverse(names.begin(), names.end());
    return text::join(names, "/");
}

const cloud::CloudNode *resolveDrivePath(const std::vector<cloud::CloudNode> &nodes, const std::string &path) {
    std::vector<std::string> names;
    for (auto &part : text::split(path, '/')) {
        if (!part.empty()) names.push_back(part);
    }
    std::optional<std::string> parent;
    const cloud::CloudNode *found = nullptr;
    for (size_t i = 0; i < names.size(); ++i) {
        const std::string kind = i == names.size() - 1 ? "file" : "folder";
        found = nullptr;
        for (const auto &node : nodes) {
            if (!node.trashed && node.name == names[i] && parentOf(node) == parent && node.kind == kind) {
                found = &node;
                break;
            }
        }
        if (!found) return nullptr;
        parent = found->id;
    }
    return found;
}

std::optional<std::string> noteTitleOfPath(const std::optional<std::string> &path) {
    const auto name = fileNameOfPath(path);
    if (name.size() > kNoteSuffix.size() && asciiLower(name.substr(name.size() - kNoteSuffix.size())) == kNoteSuffix) {
        return name.substr(0, name.size() - kNoteSuffix.size());
    }
    return std::nullopt;
}

std::string fileNameOfPath(const std::optional<std::string> &path) {
    return text::split(path.value_or(""), '/').back();
}

std::string hostOf(const std::string &url) {
    // Крайние управляющие знаки и пробелы парсер адреса снимает
    size_t from = 0;
    size_t to = url.size();
    while (from < to && static_cast<unsigned char>(url[from]) <= 0x20) ++from;
    while (to > from && static_cast<unsigned char>(url[to - 1]) <= 0x20) --to;
    const std::string input = url.substr(from, to - from);
    auto isAlpha = [](char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); };
    if (input.empty() || !isAlpha(input[0])) return url;
    size_t colon = 1;
    while (colon < input.size() && (isAlpha(input[colon]) || (input[colon] >= '0' && input[colon] <= '9')
                                    || input[colon] == '+' || input[colon] == '-' || input[colon] == '.')) {
        ++colon;
    }
    if (colon >= input.size() || input[colon] != ':') return url;
    const std::string scheme = asciiLower(input.substr(0, colon));
    const bool isSpecial = std::find(kSpecialSchemes.begin(), kSpecialSchemes.end(), scheme) != kSpecialSchemes.end();
    size_t at = colon + 1;
    if (isSpecial) {
        while (at < input.size() && (input[at] == '/' || input[at] == '\\')) ++at;
    } else if (input.compare(at, 2, "//") == 0) {
        at += 2;
    } else {
        // Адрес без узла (`mailto:`): `hostname` пуст
        return url;
    }
    size_t end = at;
    while (end < input.size() && input[end] != '/' && input[end] != '?' && input[end] != '#'
           && !(isSpecial && input[end] == '\\')) {
        ++end;
    }
    std::string authority = input.substr(at, end - at);
    if (const auto userinfo = authority.rfind('@'); userinfo != std::string::npos) {
        authority = authority.substr(userinfo + 1);
    }
    std::string host;
    if (!authority.empty() && authority[0] == '[') {
        const auto close = authority.find(']');
        if (close == std::string::npos) return url;
        host = authority.substr(0, close + 1);
    } else {
        host = authority.substr(0, authority.find(':'));
    }
    if (isSpecial && scheme != "file" && host.empty()) return url;
    for (const char c : host) {
        const auto b = static_cast<unsigned char>(c);
        if (b <= 0x20 || b == 0x7F || c == '<' || c == '>' || c == '^' || c == '|' || c == '%' || c == '"') return url;
    }
    host = asciiLower(host);
    if (text::startsWith(host, "www.")) host = host.substr(4);
    return host.empty() ? url : host;
}

LinkPreview buildLinkPreview(const std::string &url, const std::optional<LinkPreviewSource> &source) {
    LinkPreview preview;
    preview.host = hostOf(url);
    const auto hostKey = text::toLower(preview.host);
    const auto title = cleanText(source ? source->title : std::nullopt, kTitleMax);
    const auto siteName = cleanText(source ? source->siteName : std::nullopt, kTitleMax);
    const auto imageMime = text::toLower(source && source->imageMime ? *source->imageMime : std::string());
    const bool hasImage = source && source->imageBase64 && !source->imageBase64->empty()
        && std::find(kImageMimes.begin(), kImageMimes.end(), imageMime) != kImageMimes.end();
    if (title && text::toLower(*title) != hostKey) preview.title = title;
    preview.description = cleanText(source ? source->description : std::nullopt, kDescriptionMax);
    if (siteName && text::toLower(*siteName) != hostKey) preview.siteName = siteName;
    if (hasImage) {
        preview.imageBase64 = source->imageBase64;
        preview.imageMime = imageMime;
    }
    return preview;
}

bool hasPreviewContent(const LinkPreview &preview) {
    return (preview.title && !preview.title->empty()) || (preview.description && !preview.description->empty())
        || (preview.imageBase64 && !preview.imageBase64->empty());
}

std::string formatCardSize(double bytes) {
    double value = std::max(0.0, bytes);
    size_t unit = 0;
    while (value >= kSizeStep && unit < kSizeUnits.size() - 1) {
        value /= kSizeStep;
        ++unit;
    }
    std::string number;
    if (value >= 10 || unit == 0) {
        number = canvasjs::numberToString(canvasjs::round(value));
    } else {
        number = toFixed1(value);
        if (text::endsWith(number, ".0")) number.resize(number.size() - 2);
    }
    return number + " " + kSizeUnits[unit];
}

} // namespace parvane::sections::notes
