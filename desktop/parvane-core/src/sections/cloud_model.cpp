// Parvane fork (spec 029, фаза 4): порт web `components/parvane/cloud/cloudModel.ts`.
#include "parvane/sections/cloud_model.h"

#include <algorithm>
#include <cmath>
#include <set>
#include <unordered_map>

#include "unicode_lite.h"

namespace parvane::sections::cloud {

namespace u = parvane::sections::unicode_lite;
using nlohmann::json;

namespace {

const std::string kServicePrefix = ".parvane-";
constexpr size_t kTypeLabelMaxLength = 8;

const std::set<std::string> kPhotoExtensions = {"jpg", "jpeg", "png", "gif", "webp", "bmp", "avif"};
const std::set<std::string> kVideoExtensions = {"mp4", "webm", "mov", "m4v", "ogv"};
const std::set<std::string> kAudioExtensions = {"mp3", "ogg", "oga", "opus", "m4a", "wav", "flac", "aac"};
// Файлы, которые читаются как текст: заметки и холсты, данные, настройки, исходный код
const std::set<std::string> kTextExtensions = {
    "txt", "md", "markdown", "canvas", "log", "csv", "tsv", "json", "jsonl", "ndjson", "xml", "svg", "yaml", "yml",
    "toml", "ini", "cfg", "conf", "env", "properties", "html", "htm", "css", "scss", "less", "js", "mjs", "cjs", "jsx",
    "ts", "tsx", "py", "rs", "go", "java", "kt", "kts", "c", "h", "cpp", "hpp", "cc", "cs", "rb", "php", "swift", "sh",
    "bash", "zsh", "fish", "bat", "ps1", "sql", "lua", "pl", "r", "tex", "srt", "vtt", "gcode", "diff", "patch", "lock",
    "gradle", "cmake", "proto", "graphql", "vue", "svelte", "dart",
};
const std::set<std::string> kTextMimes = {
    "application/json", "application/xml", "application/javascript", "application/x-javascript",
    "application/typescript", "application/x-sh", "application/x-yaml", "application/yaml", "application/toml",
    "application/sql", "application/x-ndjson", "image/svg+xml",
};

bool startsWith(std::string_view s, std::string_view prefix) {
    return s.size() >= prefix.size() && s.compare(0, prefix.size(), prefix) == 0;
}

// (n.parent || undefined) — пустая строка считается корнем
std::optional<std::string> parentOf(const CloudNode &n) {
    if (!n.parent || n.parent->empty()) return std::nullopt;
    return n.parent;
}

std::optional<std::string> nonEmpty(const std::optional<std::string> &v) {
    if (!v || v->empty()) return std::nullopt;
    return v;
}

} // namespace

void from_json(const json &j, CloudNode &n) {
    n = CloudNode{};
    if (!j.is_object()) return;
    auto str = [&](const char *key) -> std::string {
        const auto it = j.find(key);
        return it != j.end() && it->is_string() ? it->get<std::string>() : std::string();
    };
    auto num = [&](const char *key) -> int64_t {
        const auto it = j.find(key);
        return it != j.end() && it->is_number() ? static_cast<int64_t>(it->get<double>()) : 0;
    };
    auto flag = [&](const char *key) {
        const auto it = j.find(key);
        return it != j.end() && it->is_boolean() && it->get<bool>();
    };
    n.id = str("id");
    n.kind = str("kind") == "folder" ? "folder" : "file";
    const auto p = str("parent");
    if (!p.empty()) n.parent = p;
    n.name = str("name");
    n.size = num("size");
    n.mime = str("mime");
    n.mtime = num("mtime");
    n.trashed = flag("trashed");
    n.trashTop = flag("trashTop");
    n.trashedAt = num("trashedAt");
    if (const auto it = j.find("blob"); it != j.end() && !it->is_null()) n.blob = *it;
    if (const auto it = j.find("thumb"); it != j.end() && !it->is_null()) n.thumb = *it;
}

void to_json(json &j, const CloudNode &n) {
    j = json{{"id", n.id}, {"kind", n.kind}, {"name", n.name}, {"size", n.size}, {"mime", n.mime},
        {"mtime", n.mtime}, {"trashed", n.trashed}, {"trashTop", n.trashTop}, {"trashedAt", n.trashedAt}};
    if (parentOf(n)) j["parent"] = *n.parent;
    if (n.blob) j["blob"] = *n.blob;
    if (n.thumb) j["thumb"] = *n.thumb;
}

const char *fileKindName(FileKind kind) {
    switch (kind) {
    case FileKind::Photo: return "photo";
    case FileKind::Video: return "video";
    case FileKind::Audio: return "audio";
    case FileKind::Pdf: return "pdf";
    case FileKind::Text: return "text";
    case FileKind::Other: return "other";
    }
    return "other";
}

const char *nameErrorName(NameError error) {
    switch (error) {
    case NameError::Empty: return "empty";
    case NameError::TooLong: return "too-long";
    case NameError::BadChars: return "bad-chars";
    case NameError::Reserved: return "reserved";
    }
    return "empty";
}

std::string getExtension(std::string_view name) {
    const auto dot = name.rfind('.');
    if (dot == std::string_view::npos || dot == 0 || dot + 1 >= name.size()) return "";
    return u::toLower(name.substr(dot + 1));
}

std::optional<NameError> validateName(std::string_view name) {
    if (u::trim32(u::decode(name)).empty()) return NameError::Empty;
    if (static_cast<int64_t>(name.size()) > kNameMaxBytes) return NameError::TooLong;
    for (const char c : name) {
        const auto b = static_cast<unsigned char>(c);
        if (b == '/' || b == '\\' || b < 0x20 || b == 0x7F) return NameError::BadChars;
    }
    if (name == "." || name == "..") return NameError::Reserved;
    return std::nullopt;
}

std::string freeName(const std::vector<std::string> &taken, const std::string &name) {
    const std::set<std::string> set(taken.begin(), taken.end());
    if (!set.count(name)) return name;
    const auto dot = name.rfind('.');
    const bool hasExtension = dot != std::string::npos && dot > 0 && dot + 1 < name.size();
    const std::string base = hasExtension ? name.substr(0, dot) : name;
    const std::string extension = hasExtension ? name.substr(dot) : "";
    for (int n = 2;; ++n) {
        std::string candidate = base + " (" + std::to_string(n) + ")" + extension;
        if (!set.count(candidate)) return candidate;
    }
}

std::vector<CloudNode> childrenOf(const std::vector<CloudNode> &nodes, const std::optional<std::string> &parent) {
    const auto want = nonEmpty(parent);
    std::vector<CloudNode> out;
    for (const auto &n : nodes) {
        if (!n.trashed && parentOf(n) == want) out.push_back(n);
    }
    return out;
}

bool isServiceNode(const CloudNode &node) {
    return node.kind == "file" && startsWith(u::toLower(node.name), kServicePrefix);
}

std::vector<CloudNode> listedNodes(const std::vector<CloudNode> &nodes) {
    std::vector<CloudNode> out;
    out.reserve(nodes.size());
    for (const auto &n : nodes) {
        if (!isServiceNode(n)) out.push_back(n);
    }
    return out;
}

std::vector<std::string> namesIn(const std::vector<CloudNode> &nodes, const std::optional<std::string> &parent,
    const std::optional<std::string> &exceptId) {
    std::vector<std::string> out;
    for (const auto &n : childrenOf(nodes, parent)) {
        if (exceptId && n.id == *exceptId) continue;
        out.push_back(n.name);
    }
    return out;
}

std::vector<CloudNode> pathOf(const std::vector<CloudNode> &nodes, const std::optional<std::string> &id) {
    std::unordered_map<std::string, const CloudNode *> byId;
    for (const auto &n : nodes) byId[n.id] = &n; // как Map: при повторе id побеждает последний
    std::vector<CloudNode> path;
    const CloudNode *current = nullptr;
    if (const auto want = nonEmpty(id)) {
        const auto it = byId.find(*want);
        if (it != byId.end()) current = it->second;
    }
    while (current && path.size() <= nodes.size()) {
        path.insert(path.begin(), *current);
        const auto p = parentOf(*current);
        if (!p) break;
        const auto it = byId.find(*p);
        current = it != byId.end() ? it->second : nullptr;
    }
    return path;
}

std::vector<CloudNode> subtreeOf(const std::vector<CloudNode> &nodes, const std::string &id) {
    std::unordered_map<std::string, std::vector<const CloudNode *>> byParent;
    for (const auto &n : nodes) {
        if (const auto p = parentOf(n)) byParent[*p].push_back(&n);
    }
    std::vector<const CloudNode *> out;
    for (const auto &n : nodes) {
        if (n.id == id) {
            out.push_back(&n);
            break;
        }
    }
    // Как в web: без защиты от циклов (дерево движка их не содержит), но с потолком на всякий случай
    for (size_t i = 0; i < out.size() && out.size() <= nodes.size() * 2 + 1; ++i) {
        const auto it = byParent.find(out[i]->id);
        if (it == byParent.end()) continue;
        out.insert(out.end(), it->second.begin(), it->second.end());
    }
    std::vector<CloudNode> result;
    result.reserve(out.size());
    for (const auto *n : out) result.push_back(*n);
    return result;
}

bool canMoveInto(const std::vector<CloudNode> &nodes, const std::vector<std::string> &movedIds,
    const std::optional<std::string> &target) {
    const auto want = nonEmpty(target);
    if (!want) return true;
    const CloudNode *targetNode = nullptr;
    for (const auto &n : nodes) {
        if (n.id == *want) {
            targetNode = &n;
            break;
        }
    }
    if (!targetNode || targetNode->kind != "folder" || targetNode->trashed) return false;
    std::set<std::string> targetPath;
    for (const auto &n : pathOf(nodes, want)) targetPath.insert(n.id);
    return std::none_of(movedIds.begin(), movedIds.end(), [&](const std::string &id) { return targetPath.count(id); });
}

namespace {

// Элемент сравнения имён: число (последовательность цифр) или знак с весами трёх уровней
struct CollElem {
    bool isNumber = false;
    std::u32string digits; // без ведущих нулей
    int klass = 0;         // 0 — пробелы и знаки, 1 — числа, 2 — буквы и прочее
    char32_t primary = 0;  // база буквы, строчная, без диакритики
    char32_t secondary = 0; // 0 — без диакритики, иначе знак с ней
    int tertiary = 0;       // 0 — строчная/без регистра, 1 — прописная
};

// Буква с диакритикой → база (уровень 2 — сама буква)
char32_t baseLetter(char32_t c) {
    switch (c) {
    case U'à': case U'á': case U'â': case U'ã': case U'ä': case U'å': case U'ā': case U'ă': case U'ą': return U'a';
    case U'ç': case U'ć': case U'č': return U'c';
    case U'ď': return U'd';
    case U'è': case U'é': case U'ê': case U'ë': case U'ē': case U'ę': case U'ě': return U'e';
    case U'ì': case U'í': case U'î': case U'ï': case U'ī': return U'i';
    case U'ñ': case U'ń': case U'ň': return U'n';
    case U'ò': case U'ó': case U'ô': case U'õ': case U'ö': case U'ō': case U'ő': return U'o';
    case U'ř': return U'r';
    case U'ś': case U'š': case U'ş': return U's';
    case U'ť': case U'ţ': return U't';
    case U'ù': case U'ú': case U'û': case U'ü': case U'ū': case U'ů': case U'ű': return U'u';
    case U'ý': case U'ÿ': return U'y';
    case U'ź': case U'ż': case U'ž': return U'z';
    case U'ё': return U'е';
    case U'й': return U'и';
    case U'ї': return U'і';
    case U'ў': return U'у';
    default: return c;
    }
}

std::vector<CollElem> collElems(std::string_view s) {
    const auto cps = u::decode(s);
    std::vector<CollElem> out;
    for (size_t i = 0; i < cps.size();) {
        const char32_t c = cps[i];
        if (c >= U'0' && c <= U'9') {
            CollElem e;
            e.isNumber = true;
            e.klass = 1;
            size_t j = i;
            while (j < cps.size() && cps[j] >= U'0' && cps[j] <= U'9') ++j;
            size_t k = i;
            while (k + 1 < j && cps[k] == U'0') ++k;
            e.digits = cps.substr(k, j - k);
            out.push_back(std::move(e));
            i = j;
            continue;
        }
        CollElem e;
        const char32_t lower = u::lower(c);
        const char32_t base = baseLetter(lower);
        e.klass = u::isLetterOrNumber(c) ? 2 : 0;
        e.primary = base;
        e.secondary = base == lower ? 0 : lower;
        e.tertiary = lower != c ? 1 : 0;
        out.push_back(std::move(e));
        ++i;
    }
    return out;
}

int cmp(auto a, auto b) { return a < b ? -1 : a > b ? 1 : 0; }

int comparePrimary(const CollElem &a, const CollElem &b) {
    if (a.klass != b.klass) return cmp(a.klass, b.klass);
    if (a.isNumber) {
        if (a.digits.size() != b.digits.size()) return cmp(a.digits.size(), b.digits.size());
        return a.digits.compare(b.digits) < 0 ? -1 : a.digits == b.digits ? 0 : 1;
    }
    return cmp(a.primary, b.primary);
}

} // namespace

int compareNames(std::string_view a, std::string_view b) {
    const auto ea = collElems(a);
    const auto eb = collElems(b);
    const size_t n = std::min(ea.size(), eb.size());
    for (size_t i = 0; i < n; ++i) {
        if (const int r = comparePrimary(ea[i], eb[i])) return r;
    }
    if (ea.size() != eb.size()) return cmp(ea.size(), eb.size());
    for (size_t i = 0; i < n; ++i) {
        if (const int r = cmp(ea[i].secondary, eb[i].secondary)) return r;
    }
    for (size_t i = 0; i < n; ++i) {
        if (const int r = cmp(ea[i].tertiary, eb[i].tertiary)) return r;
    }
    return 0;
}

std::vector<CloudNode> sortNodes(const std::vector<CloudNode> &nodes, const Sort &sort) {
    const int direction = sort.isDescending ? -1 : 1;
    std::vector<CloudNode> out = nodes;
    std::stable_sort(out.begin(), out.end(), [&](const CloudNode &a, const CloudNode &b) {
        if (a.kind != b.kind) return a.kind == "folder";
        int64_t result = 0;
        if (sort.key == SortKey::Date) result = a.mtime - b.mtime;
        if (sort.key == SortKey::Size) result = a.size - b.size;
        const int sign = result ? (result < 0 ? -1 : 1) : compareNames(a.name, b.name);
        return sign * direction < 0;
    });
    return out;
}

std::vector<CloudNode> searchNodes(const std::vector<CloudNode> &nodes, std::string_view query) {
    const auto needle = u::toLower(u::trim(query));
    if (needle.empty()) return {};
    std::vector<CloudNode> out;
    for (const auto &n : nodes) {
        if (!n.trashed && u::toLower(n.name).find(needle) != std::string::npos) out.push_back(n);
    }
    return out;
}

std::vector<CloudNode> trashOf(const std::vector<CloudNode> &nodes) {
    std::vector<CloudNode> out;
    for (const auto &n : nodes) {
        if (n.trashTop) out.push_back(n);
    }
    std::stable_sort(out.begin(), out.end(), [](const CloudNode &a, const CloudNode &b) {
        return b.trashedAt < a.trashedAt;
    });
    return out;
}

std::vector<CloudNode> expiredTrashOf(const std::vector<CloudNode> &nodes, int64_t nowMs, int64_t lifetimeMs) {
    std::vector<CloudNode> out;
    for (const auto &n : nodes) {
        if (n.trashTop && n.trashedAt > 0 && nowMs - n.trashedAt >= lifetimeMs) out.push_back(n);
    }
    return out;
}

int trashDaysLeft(const CloudNode &node, int64_t nowMs, int64_t lifetimeMs) {
    const auto whole = static_cast<int>(std::ceil(static_cast<double>(lifetimeMs) / kDayMs));
    if (!node.trashedAt) return whole;
    const double left = std::ceil(static_cast<double>(node.trashedAt + lifetimeMs - nowMs) / kDayMs);
    return std::min(whole, static_cast<int>(std::max(0.0, left)));
}

Usage usageOf(const std::vector<CloudNode> &nodes) {
    Usage usage;
    for (const auto &n : nodes) {
        usage.total += n.size;
        if (n.trashed) usage.trash += n.size;
    }
    return usage;
}

int64_t sizeOf(const std::vector<CloudNode> &nodes, const std::string &id) {
    int64_t sum = 0;
    for (const auto &n : subtreeOf(nodes, id)) sum += n.size;
    return sum;
}

std::map<std::string, FolderStats> folderStats(const std::vector<CloudNode> &nodes) {
    std::unordered_map<std::string, const CloudNode *> byId;
    for (const auto &n : nodes) byId[n.id] = &n;
    std::map<std::string, FolderStats> stats;
    const bool hasService = std::any_of(nodes.begin(), nodes.end(), isServiceNode);
    for (const auto &n : nodes) {
        const auto p = parentOf(n);
        if (!p) continue;
        if (!n.trashed && !(hasService && isServiceNode(n))) stats[*p].count += 1;
        if (!n.size) continue;
        auto it = byId.find(*p);
        const CloudNode *ancestor = it != byId.end() ? it->second : nullptr;
        for (size_t guard = 0; ancestor && guard <= nodes.size(); ++guard) {
            stats[ancestor->id].size += n.size;
            const auto ap = parentOf(*ancestor);
            if (!ap) break;
            it = byId.find(*ap);
            ancestor = it != byId.end() ? it->second : nullptr;
        }
    }
    return stats;
}

FileKind kindOfFile(std::string_view mime, std::string_view name) {
    const auto extension = getExtension(name);
    if (mime == "application/pdf" || extension == "pdf") return FileKind::Pdf;
    // Перенесено как в web: при `image/*` (кроме svg) — всегда фото, иначе — по расширению
    if (startsWith(mime, "image/") && mime != "image/svg+xml" ? true : kPhotoExtensions.count(extension) > 0) {
        return FileKind::Photo;
    }
    // Расширение текста важнее типа: `.ts` браузер считает видео (MPEG-TS), `.svg` показываем исходником
    if (kTextExtensions.count(extension)) return FileKind::Text;
    if (startsWith(mime, "video/") || kVideoExtensions.count(extension)) return FileKind::Video;
    if (startsWith(mime, "audio/") || kAudioExtensions.count(extension)) return FileKind::Audio;
    const auto semi = mime.find(';');
    const auto bare = u::trim(mime.substr(0, semi));
    if (startsWith(mime, "text/") || kTextMimes.count(bare)) return FileKind::Text;
    return FileKind::Other;
}

std::string fileTypeLabel(std::string_view name) {
    const auto extension = getExtension(name);
    const auto cps = u::decode(extension);
    // В web длина — в кодовых единицах UTF-16; для букв BMP совпадает с числом кодовых точек
    if (cps.empty() || cps.size() > kTypeLabelMaxLength) return "";
    for (const char32_t c : cps) {
        if (!(u::isLetterOrNumber(c) || c == U'_' || c == U'+' || c == U'-')) return "";
    }
    return u::toUpper(extension);
}

namespace {

// windows-1251, байты 0x80–0xBF (0xC0–0xFF — А…я подряд), по индексу WHATWG
constexpr char16_t kCp1251High[64] = {
    0x0402, 0x0403, 0x201A, 0x0453, 0x201E, 0x2026, 0x2020, 0x2021, 0x20AC, 0x2030, 0x0409, 0x2039, 0x040A, 0x040C,
    0x040B, 0x040F, 0x0452, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x0098, 0x2122, 0x0459, 0x203A,
    0x045A, 0x045C, 0x045B, 0x045F, 0x00A0, 0x040E, 0x045E, 0x0408, 0x00A4, 0x0490, 0x00A6, 0x00A7, 0x0401, 0x00A9,
    0x0404, 0x00AB, 0x00AC, 0x00AD, 0x00AE, 0x0407, 0x00B0, 0x00B1, 0x0406, 0x0456, 0x0491, 0x00B5, 0x00B6, 0x00B7,
    0x0451, 0x2116, 0x0454, 0x00BB, 0x0458, 0x0405, 0x0455, 0x0457,
};

// Строгий UTF-8 (как TextDecoder с fatal: true); nullopt — не UTF-8
std::optional<std::u32string> strictUtf8(std::string_view s) {
    std::u32string out;
    size_t i = 0;
    while (i < s.size()) {
        const auto b0 = static_cast<unsigned char>(s[i]);
        if (b0 < 0x80) { out.push_back(b0); ++i; continue; }
        int len = 0;
        char32_t cp = 0, min = 0;
        if (b0 >= 0xC2 && b0 <= 0xDF) { len = 2; cp = b0 & 0x1F; min = 0x80; }
        else if (b0 >= 0xE0 && b0 <= 0xEF) { len = 3; cp = b0 & 0x0F; min = 0x800; }
        else if (b0 >= 0xF0 && b0 <= 0xF4) { len = 4; cp = b0 & 0x07; min = 0x10000; }
        else return std::nullopt;
        if (i + len > s.size()) return std::nullopt;
        for (int k = 1; k < len; ++k) {
            const auto b = static_cast<unsigned char>(s[i + k]);
            if ((b & 0xC0) != 0x80) return std::nullopt;
            cp = (cp << 6) | (b & 0x3F);
        }
        if (cp < min || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return std::nullopt;
        out.push_back(cp);
        i += len;
    }
    return out;
}

std::string decodeUtf16(std::string_view bytes, bool littleEndian) {
    std::u32string out;
    // Метка порядка байтов не входит в текст (TextDecoder по умолчанию её снимает)
    size_t i = 2;
    auto unit = [&](size_t at) -> char16_t {
        const auto a = static_cast<unsigned char>(bytes[at]);
        const auto b = static_cast<unsigned char>(bytes[at + 1]);
        return littleEndian ? static_cast<char16_t>(a | (b << 8)) : static_cast<char16_t>((a << 8) | b);
    };
    while (i + 1 < bytes.size()) {
        const char16_t w = unit(i);
        i += 2;
        if (w >= 0xD800 && w <= 0xDBFF) {
            if (i + 1 < bytes.size()) {
                const char16_t w2 = unit(i);
                if (w2 >= 0xDC00 && w2 <= 0xDFFF) {
                    out.push_back(0x10000 + ((static_cast<char32_t>(w) - 0xD800) << 10) + (w2 - 0xDC00));
                    i += 2;
                    continue;
                }
            }
            out.push_back(0xFFFD);
        } else if (w >= 0xDC00 && w <= 0xDFFF) {
            out.push_back(0xFFFD);
        } else {
            out.push_back(w);
        }
    }
    if (i < bytes.size()) out.push_back(0xFFFD); // лишний байт в конце
    return u::encode(out);
}

} // namespace

std::optional<std::string> decodeTextPreview(std::string_view bytes) {
    if (bytes.size() >= 2) {
        const auto b0 = static_cast<unsigned char>(bytes[0]);
        const auto b1 = static_cast<unsigned char>(bytes[1]);
        if ((b0 == 0xFF && b1 == 0xFE) || (b0 == 0xFE && b1 == 0xFF)) return decodeUtf16(bytes, b0 == 0xFF);
    }
    if (bytes.find('\0') != std::string_view::npos) return std::nullopt;
    if (auto text = strictUtf8(bytes)) {
        if (!text->empty() && text->front() == 0xFEFF) text->erase(0, 1);
        return u::encode(*text);
    }
    std::string out;
    for (const char c : bytes) {
        const auto b = static_cast<unsigned char>(c);
        if (b < 0x80) out.push_back(c);
        else if (b < 0xC0) u::append(out, kCp1251High[b - 0x80]);
        else u::append(out, 0x0410 + (b - 0xC0));
    }
    return out;
}

} // namespace parvane::sections::cloud
