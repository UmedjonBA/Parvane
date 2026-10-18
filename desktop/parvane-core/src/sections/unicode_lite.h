// Parvane fork (spec 029, фаза 4): внутренние помощники по тексту для модулей разделов «Облако», палитры
// и «Выгрузки» — UTF-8 ↔ кодовые точки, смена регистра, «буква или цифра», пробелы как в JS.
// Только стандартная библиотека (без ICU): таблицы покрывают латиницу (с Latin-1, Extended-A/B, вьетнамской),
// греческий, кириллицу, армянский и полноширинные — этого хватает для имён файлов и поиска. Редкие письменности
// регистр не меняют (в web `toLowerCase` полный Unicode) — расхождение только для них.
#pragma once

#include <cstdint>
#include <string>
#include <string_view>

namespace parvane::sections::unicode_lite {

// UTF-8 → кодовые точки; битые последовательности — U+FFFD по байту (как нестрогий TextDecoder).
inline std::u32string decode(std::string_view s) {
    std::u32string out;
    out.reserve(s.size());
    size_t i = 0;
    const size_t n = s.size();
    while (i < n) {
        const auto b0 = static_cast<unsigned char>(s[i]);
        if (b0 < 0x80) { out.push_back(b0); ++i; continue; }
        int len = 0;
        char32_t cp = 0;
        char32_t min = 0;
        if (b0 >= 0xC2 && b0 <= 0xDF) { len = 2; cp = b0 & 0x1F; min = 0x80; }
        else if (b0 >= 0xE0 && b0 <= 0xEF) { len = 3; cp = b0 & 0x0F; min = 0x800; }
        else if (b0 >= 0xF0 && b0 <= 0xF4) { len = 4; cp = b0 & 0x07; min = 0x10000; }
        bool ok = len > 0 && i + len <= n;
        for (int k = 1; ok && k < len; ++k) {
            const auto b = static_cast<unsigned char>(s[i + k]);
            if ((b & 0xC0) != 0x80) ok = false;
            else cp = (cp << 6) | (b & 0x3F);
        }
        if (ok && (cp < min || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF))) ok = false;
        if (!ok) { out.push_back(0xFFFD); ++i; continue; }
        out.push_back(cp);
        i += len;
    }
    return out;
}

inline void append(std::string &out, char32_t cp) {
    if (cp < 0x80) {
        out.push_back(static_cast<char>(cp));
    } else if (cp < 0x800) {
        out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
        out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else if (cp < 0x10000) {
        out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
        out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else {
        out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
        out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    }
}

inline std::string encode(std::u32string_view s) {
    std::string out;
    out.reserve(s.size());
    for (const char32_t cp : s) append(out, cp);
    return out;
}

inline size_t length(std::string_view s) { return decode(s).size(); }

// Пары «прописная → строчная»: [lo, hi] с шагом step, строчная = прописная + delta
struct CaseRange { char32_t lo, hi; int delta; int step; };
inline constexpr CaseRange kCaseRanges[] = {
    {0x0041, 0x005A, 32, 1},   {0x00C0, 0x00D6, 32, 1},   {0x00D8, 0x00DE, 32, 1},
    {0x0100, 0x012E, 1, 2},    {0x0132, 0x0136, 1, 2},    {0x0139, 0x0147, 1, 2},
    {0x014A, 0x0176, 1, 2},    {0x0179, 0x017D, 1, 2},    {0x01CD, 0x01DB, 1, 2},
    {0x01DE, 0x01EE, 1, 2},    {0x01F8, 0x021E, 1, 2},    {0x0222, 0x0232, 1, 2},
    {0x0386, 0x0386, 38, 1},   {0x0388, 0x038A, 37, 1},   {0x038C, 0x038C, 64, 1},
    {0x038E, 0x038F, 63, 1},   {0x0391, 0x03A1, 32, 1},   {0x03A3, 0x03AB, 32, 1},
    {0x03D8, 0x03EE, 1, 2},    {0x0400, 0x040F, 80, 1},   {0x0410, 0x042F, 32, 1},
    {0x0460, 0x0480, 1, 2},    {0x048A, 0x04BE, 1, 2},    {0x04C0, 0x04C0, 15, 1},
    {0x04C1, 0x04CD, 1, 2},    {0x04D0, 0x052E, 1, 2},    {0x0531, 0x0556, 48, 1},
    {0x1E00, 0x1E94, 1, 2},    {0x1EA0, 0x1EFE, 1, 2},    {0x2160, 0x216F, 16, 1},
    {0x24B6, 0x24CF, 26, 1},   {0xFF21, 0xFF3A, 32, 1},
};

inline char32_t lower(char32_t cp) {
    if (cp < 0x80) return (cp >= 'A' && cp <= 'Z') ? cp + 32 : cp;
    if (cp == 0x0178) return 0x00FF;
    if (cp == 0x1E9E) return 0x00DF;
    // İ (U+0130) в JS даёт две кодовые единицы — не трогаем (палитра так и делает)
    for (const auto &r : kCaseRanges) {
        if (cp >= r.lo && cp <= r.hi && (cp - r.lo) % r.step == 0) return cp + r.delta;
    }
    return cp;
}

inline char32_t upper(char32_t cp) {
    if (cp < 0x80) return (cp >= 'a' && cp <= 'z') ? cp - 32 : cp;
    if (cp == 0x00FF) return 0x0178;
    if (cp == 0x00B5) return 0x039C;
    if (cp == 0x03C2) return 0x03A3;
    for (const auto &r : kCaseRanges) {
        const char32_t base = cp - r.delta;
        if (cp >= static_cast<char32_t>(r.delta) && base >= r.lo && base <= r.hi && (base - r.lo) % r.step == 0) {
            return base;
        }
    }
    return cp;
}

inline std::string toLower(std::string_view s) {
    std::string out;
    out.reserve(s.size());
    for (const char32_t cp : decode(s)) append(out, lower(cp));
    return out;
}

// Как String.prototype.toUpperCase: «ß» → «SS»
inline std::string toUpper(std::string_view s) {
    std::string out;
    out.reserve(s.size());
    for (const char32_t cp : decode(s)) {
        if (cp == 0x00DF) out += "SS";
        else append(out, upper(cp));
    }
    return out;
}

// Приближение \p{L}|\p{N} без ICU (основные письменности, цифры, индексы, CJK)
inline bool isLetterOrNumber(char32_t c) {
    struct R { char32_t lo, hi; };
    static constexpr R kRanges[] = {
        {0x30, 0x39}, {0x41, 0x5A}, {0x61, 0x7A}, {0xAA, 0xAA}, {0xB2, 0xB3}, {0xB5, 0xB5}, {0xB9, 0xBA},
        {0xBC, 0xBE}, {0xC0, 0xD6}, {0xD8, 0xF6}, {0xF8, 0x2C1}, {0x2C6, 0x2D1}, {0x2E0, 0x2E4},
        {0x370, 0x374}, {0x376, 0x37D}, {0x37F, 0x37F}, {0x386, 0x386}, {0x388, 0x3F5}, {0x3F7, 0x481},
        {0x48A, 0x52F}, {0x531, 0x556}, {0x560, 0x588}, {0x5D0, 0x5EA}, {0x620, 0x64A}, {0x660, 0x669},
        {0x66E, 0x6D3}, {0x6F0, 0x6FC}, {0x900, 0xDFF}, {0xE01, 0xE30}, {0x10A0, 0x10FF}, {0x1100, 0x11FF},
        {0x1E00, 0x1FBC}, {0x2070, 0x2070}, {0x2074, 0x2079}, {0x2080, 0x2089}, {0x2150, 0x2189},
        {0x2460, 0x249B}, {0x24EA, 0x24FF}, {0x2776, 0x2793}, {0x3005, 0x3007}, {0x3021, 0x3029},
        {0x3031, 0x3035}, {0x3038, 0x303C}, {0x3041, 0x3096}, {0x309D, 0x309F}, {0x30A1, 0x30FA},
        {0x30FC, 0x30FF}, {0x3105, 0x312F}, {0x3131, 0x318E}, {0x3400, 0x4DBF}, {0x4E00, 0x9FFF},
        {0xA000, 0xA48C}, {0xAC00, 0xD7A3}, {0xF900, 0xFAFF}, {0xFF10, 0xFF19}, {0xFF21, 0xFF3A},
        {0xFF41, 0xFF5A}, {0xFF66, 0xFFDC}, {0x20000, 0x3134F},
    };
    for (const auto &r : kRanges) {
        if (c < r.lo) return false;
        if (c <= r.hi) return true;
    }
    return false;
}

// Пробел в смысле JS `\s` / `trim`
inline bool isJsSpace(char32_t c) {
    return (c >= 0x09 && c <= 0x0D) || c == 0x20 || c == 0xA0 || c == 0x1680 || (c >= 0x2000 && c <= 0x200A)
        || c == 0x2028 || c == 0x2029 || c == 0x202F || c == 0x205F || c == 0x3000 || c == 0xFEFF;
}

inline std::u32string trim32(std::u32string_view s) {
    size_t a = 0, b = s.size();
    while (a < b && isJsSpace(s[a])) ++a;
    while (b > a && isJsSpace(s[b - 1])) --b;
    return std::u32string(s.substr(a, b - a));
}

inline std::string trim(std::string_view s) { return encode(trim32(decode(s))); }

} // namespace parvane::sections::unicode_lite
