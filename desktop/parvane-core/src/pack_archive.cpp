// Parvane: PVPK1 и правила PACK-1/EMOJI-1 — см. include/parvane/pack_archive.h.
#include "parvane/pack_archive.h"

#include <algorithm>
#include <cctype>
#include <cstring>

#include <nlohmann/json.hpp>

namespace parvane::pack {

namespace {

std::string lowerExt(const std::string &name) {
    const auto dot = name.rfind('.');
    if (dot == std::string::npos) return {};
    std::string ext = name.substr(dot);
    for (auto &c : ext) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return ext;
}

std::string basename(const std::string &name) {
    const auto pos = name.find_last_of("/\\");
    return pos == std::string::npos ? name : name.substr(pos + 1);
}

// Символ UTF-8 → code point (упрощённый декодер для sanitizeName/altEmoji).
bool nextCodePoint(const std::string &s, std::size_t &i, std::uint32_t &cp) {
    if (i >= s.size()) return false;
    const auto c = static_cast<unsigned char>(s[i]);
    std::size_t len = 1;
    if (c >= 0xF0) { cp = c & 0x07; len = 4; }
    else if (c >= 0xE0) { cp = c & 0x0F; len = 3; }
    else if (c >= 0xC0) { cp = c & 0x1F; len = 2; }
    else { cp = c; }
    if (i + len > s.size()) { cp = c; i += 1; return true; }
    for (std::size_t k = 1; k < len; ++k) cp = (cp << 6) | (static_cast<unsigned char>(s[i + k]) & 0x3F);
    i += len;
    return true;
}

void appendCodePoint(std::string &out, std::uint32_t cp) {
    if (cp < 0x80) out.push_back(static_cast<char>(cp));
    else if (cp < 0x800) { out.push_back(static_cast<char>(0xC0 | (cp >> 6))); out.push_back(static_cast<char>(0x80 | (cp & 0x3F))); }
    else if (cp < 0x10000) { out.push_back(static_cast<char>(0xE0 | (cp >> 12))); out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F))); out.push_back(static_cast<char>(0x80 | (cp & 0x3F))); }
    else { out.push_back(static_cast<char>(0xF0 | (cp >> 18))); out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F))); out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F))); out.push_back(static_cast<char>(0x80 | (cp & 0x3F))); }
}

// «Буква или цифра» как QChar::isLetterOrNumber для ASCII и кириллицы; прочие
// не-ASCII code point'ы считаем буквами (desktop пропускает любые буквы Unicode).
bool isLetterOrNumber(std::uint32_t cp) {
    if (cp < 0x80) return std::isalnum(static_cast<int>(cp)) != 0;
    return cp >= 0x00C0 && cp != 0x00D7 && cp != 0x00F7 && cp < 0x2000;
}

} // namespace

bool isAllowedExtension(const std::string &name) {
    const auto e = lowerExt(name);
    return e == ".webp" || e == ".png" || e == ".tgs" || e == ".webm";
}

std::string mimeForName(const std::string &name) {
    const auto e = lowerExt(name);
    if (e == ".webp") return "image/webp";
    if (e == ".png") return "image/png";
    if (e == ".tgs") return "application/x-tgsticker";
    if (e == ".webm") return "video/webm";
    return {};
}

std::string build(const std::vector<Entry> &entries) {
    auto index = nlohmann::json::array();
    std::string blob;
    std::size_t count = 0;
    for (const auto &e : entries) {
        const auto name = basename(e.name);
        if (name.empty() || e.bytes.empty() || !isAllowedExtension(name)) continue;
        if (count + 1 > kMaxFiles) break;
        if (blob.size() + e.bytes.size() > kMaxBytes) break;
        ++count;
        index.push_back({{"name", name}, {"size", e.bytes.size()}});
        blob.append(e.bytes);
    }
    if (index.empty()) return {};
    const auto indexStr = index.dump();
    std::string out(kMagic);
    const auto len = static_cast<std::uint32_t>(indexStr.size());
    out.append(reinterpret_cast<const char *>(&len), 4); // little-endian на всех наших платформах
    out.append(indexStr);
    out.append(blob);
    return out;
}

std::vector<Entry> parse(const std::string &bytes) {
    if (bytes.size() < 9 || bytes.compare(0, 5, kMagic) != 0 || bytes.size() > kMaxBytes + (1u << 20)) return {};
    std::uint32_t len = 0;
    std::memcpy(&len, bytes.data() + 5, 4);
    if (9 + static_cast<std::size_t>(len) > bytes.size()) return {};
    auto index = nlohmann::json::parse(bytes.substr(9, len), nullptr, false);
    if (index.is_discarded() || !index.is_array() || index.size() > kMaxFiles) return {};
    std::vector<Entry> out;
    std::size_t offset = 9 + static_cast<std::size_t>(len);
    for (const auto &e : index) {
        if (!e.is_object()) return {};
        const auto name = basename(e.value("name", std::string()));
        const auto size = e.value("size", std::size_t(0));
        if (name.empty() || offset + size > bytes.size()) return {};
        if (isAllowedExtension(name) && size > 0) out.push_back({name, bytes.substr(offset, size)});
        offset += size;
    }
    return out;
}

std::string sanitizeName(const std::string &name) {
    std::string out;
    std::size_t i = 0;
    std::uint32_t cp = 0;
    std::size_t kept = 0;
    std::vector<std::uint32_t> cps;
    while (nextCodePoint(name, i, cp)) {
        if (isLetterOrNumber(cp) || cp == ' ' || cp == '-' || cp == '_') cps.push_back(cp);
    }
    // trim пробелов
    std::size_t b = 0, e = cps.size();
    while (b < e && cps[b] == ' ') ++b;
    while (e > b && cps[e - 1] == ' ') --e;
    for (std::size_t k = b; k < e && kept < 32; ++k, ++kept) appendCodePoint(out, cps[k]);
    // повторный trim после обрезки до 32
    while (!out.empty() && out.back() == ' ') out.pop_back();
    return out.empty() ? std::string("Pack") : out;
}

std::int64_t fnv1a64Signed(const std::string &utf8) {
    std::uint64_t h = kFnvOffsetBasis;
    for (const auto c : utf8) {
        h ^= static_cast<unsigned char>(c);
        h *= kFnvPrime;
    }
    return static_cast<std::int64_t>(h);
}

std::int64_t emojiDocId(const std::string &rawName, const std::string &file) {
    return fnv1a64Signed("pvemoji:" + rawName + "|" + file);
}

std::int64_t packSetId(const std::string &sanitizedName) {
    return fnv1a64Signed("pack:" + sanitizedName);
}

std::int64_t emojiSetId(const std::string &rawName) {
    return fnv1a64Signed("pvemoji-set:" + rawName);
}

bool canReuseRef(const std::vector<std::string> &uploadedFor, const std::vector<std::string> &recipients) {
    for (const auto &r : recipients) {
        if (std::find(uploadedFor.begin(), uploadedFor.end(), r) == uploadedFor.end()) return false;
    }
    return true;
}

std::string altEmojiForFileName(const std::string &name, const std::string &fallback) {
    // NN-<hex>.<ext>
    const auto dash = name.find('-');
    const auto dot = name.rfind('.');
    if (dash == std::string::npos || dot == std::string::npos || dot <= dash + 1) return fallback;
    const auto hex = name.substr(dash + 1, dot - dash - 1);
    if (hex.empty() || hex.size() > 6) return fallback;
    std::uint32_t cp = 0;
    for (const auto c : hex) {
        if (!std::isxdigit(static_cast<unsigned char>(c))) return fallback;
        cp = cp * 16 + static_cast<std::uint32_t>(std::isdigit(static_cast<unsigned char>(c)) ? c - '0' : std::tolower(static_cast<unsigned char>(c)) - 'a' + 10);
    }
    if (cp == 0 || cp > 0x10FFFF) return fallback;
    std::string out;
    appendCodePoint(out, cp);
    return out;
}

} // namespace parvane::pack
