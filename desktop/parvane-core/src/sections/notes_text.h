// Parvane fork (spec 029, фаза 4): общие текстовые помощники модулей «Знаний» (notes_*, markdown) — UTF-8 ↔ кодовые
// точки и то, что web берёт из движка JS: `\s`, `trim`, `toLowerCase`, `\p{L}`/`\p{N}`, `localeCompare`,
// `JSON.stringify` строки, `encodeURI`/`decodeURI`, печать числа как `String(number)`. Внутренний заголовок: только
// для src/sections/notes_*.cpp и markdown.cpp. Регулярки web разбираются вручную по кодовым точкам — `std::regex`
// с UTF-8 ненадёжен.
#pragma once

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <optional>
#include <string>
#include <tuple>
#include <vector>

namespace parvane::sections::notes::text {

using U32 = std::u32string;

// UTF-8 → кодовые точки; неверная последовательность — U+FFFD на байт
inline U32 decode(const std::string &s) {
    U32 out;
    out.reserve(s.size());
    size_t i = 0;
    const size_t n = s.size();
    while (i < n) {
        const auto b = static_cast<unsigned char>(s[i]);
        if (b < 0x80) {
            out.push_back(b);
            ++i;
            continue;
        }
        int len = 0;
        char32_t cp = 0;
        if ((b & 0xE0) == 0xC0) { len = 2; cp = b & 0x1F; }
        else if ((b & 0xF0) == 0xE0) { len = 3; cp = b & 0x0F; }
        else if ((b & 0xF8) == 0xF0) { len = 4; cp = b & 0x07; }
        bool ok = len > 0 && i + len <= n;
        for (int k = 1; ok && k < len; ++k) {
            const auto c = static_cast<unsigned char>(s[i + k]);
            if ((c & 0xC0) != 0x80) ok = false;
            else cp = (cp << 6) | (c & 0x3F);
        }
        if (!ok) {
            out.push_back(0xFFFD);
            ++i;
            continue;
        }
        out.push_back(cp);
        i += len;
    }
    return out;
}

inline void appendUtf8(std::string &out, char32_t c) {
    if (c < 0x80) {
        out.push_back(static_cast<char>(c));
    } else if (c < 0x800) {
        out.push_back(static_cast<char>(0xC0 | (c >> 6)));
        out.push_back(static_cast<char>(0x80 | (c & 0x3F)));
    } else if (c < 0x10000) {
        out.push_back(static_cast<char>(0xE0 | (c >> 12)));
        out.push_back(static_cast<char>(0x80 | ((c >> 6) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | (c & 0x3F)));
    } else {
        out.push_back(static_cast<char>(0xF0 | (c >> 18)));
        out.push_back(static_cast<char>(0x80 | ((c >> 12) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | ((c >> 6) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | (c & 0x3F)));
    }
}

inline std::string encode(const U32 &s) {
    std::string out;
    out.reserve(s.size());
    for (char32_t c : s) appendUtf8(out, c);
    return out;
}

inline std::string encode(const U32 &s, size_t from, size_t to) {
    std::string out;
    for (size_t i = from; i < to && i < s.size(); ++i) appendUtf8(out, s[i]);
    return out;
}

// Длина кодовой точки в UTF-8 — для перевода позиций в байты
inline size_t utf8Length(char32_t c) {
    return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
}

inline size_t byteOffset(const U32 &s, size_t index) {
    size_t bytes = 0;
    for (size_t i = 0; i < index && i < s.size(); ++i) bytes += utf8Length(s[i]);
    return bytes;
}

// `\s` JS (и набор, который снимает `trim`)
inline bool isSpace(char32_t c) {
    switch (c) {
    case 0x09: case 0x0A: case 0x0B: case 0x0C: case 0x0D: case 0x20: case 0xA0: case 0x1680:
    case 0x2028: case 0x2029: case 0x202F: case 0x205F: case 0x3000: case 0xFEFF:
        return true;
    default:
        return c >= 0x2000 && c <= 0x200A;
    }
}

// Знак конца строки для `.` в регулярках JS
inline bool isLineTerminator(char32_t c) {
    return c == 0x0A || c == 0x0D || c == 0x2028 || c == 0x2029;
}

inline bool hasLineTerminator(const U32 &s, size_t from = 0) {
    for (size_t i = from; i < s.size(); ++i) {
        if (isLineTerminator(s[i])) return true;
    }
    return false;
}

inline bool isAsciiDigit(char32_t c) { return c >= '0' && c <= '9'; }

// `\p{N}` — цифры и числа основных письменностей (приближение таблицы Unicode)
inline bool isNumber(char32_t c) {
    if (isAsciiDigit(c)) return true;
    if (c == 0xB2 || c == 0xB3 || c == 0xB9 || (c >= 0xBC && c <= 0xBE)) return true;
    if ((c >= 0x660 && c <= 0x669) || (c >= 0x6F0 && c <= 0x6F9) || (c >= 0x966 && c <= 0x96F)) return true;
    if (c == 0x2070 || (c >= 0x2074 && c <= 0x2079) || (c >= 0x2080 && c <= 0x2089)) return true;
    if ((c >= 0x2150 && c <= 0x2189) || (c >= 0x2460 && c <= 0x249B) || (c >= 0x2776 && c <= 0x2793)) return true;
    if ((c >= 0xFF10 && c <= 0xFF19) || (c >= 0x3021 && c <= 0x3029)) return true;
    return false;
}

// `\p{L}` — буквы основных письменностей (приближение таблицы Unicode)
inline bool isLetter(char32_t c) {
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) return true;
    if (c < 0x80) return false;
    if (c == 0xAA || c == 0xB5 || c == 0xBA) return true;
    if (c >= 0xC0 && c <= 0x24F) return c != 0xD7 && c != 0xF7;
    if (c >= 0x250 && c <= 0x2C1) return true;
    if ((c >= 0x2C6 && c <= 0x2D1) || (c >= 0x2E0 && c <= 0x2E4) || c == 0x2EC || c == 0x2EE) return true;
    if ((c >= 0x370 && c <= 0x373) || c == 0x376 || c == 0x377 || (c >= 0x37B && c <= 0x37D) || c == 0x37F) return true;
    if (c == 0x386 || (c >= 0x388 && c <= 0x3FF)) return c != 0x38B && c != 0x38D && c != 0x3A2 && c != 0x3F6;
    if ((c >= 0x400 && c <= 0x481) || (c >= 0x48A && c <= 0x52F)) return true;
    if ((c >= 0x531 && c <= 0x556) || (c >= 0x560 && c <= 0x588)) return true;
    if ((c >= 0x5D0 && c <= 0x5EA) || (c >= 0x5EF && c <= 0x5F2)) return true;
    if ((c >= 0x620 && c <= 0x64A) || (c >= 0x671 && c <= 0x6D3) || c == 0x6D5) return true;
    if ((c >= 0x904 && c <= 0x939) || c == 0x93D || c == 0x950 || (c >= 0x958 && c <= 0x961)) return true;
    if ((c >= 0xE01 && c <= 0xE30) || c == 0xE32 || c == 0xE33 || (c >= 0xE40 && c <= 0xE46)) return true;
    if (c >= 0x10A0 && c <= 0x10FF) return true;
    if (c >= 0x1E00 && c <= 0x1FFF) return true;
    if (c == 0x2071 || c == 0x207F || (c >= 0x2090 && c <= 0x209C)) return true;
    if (c >= 0x2C00 && c <= 0x2CE4) return true;
    if ((c >= 0x3041 && c <= 0x3096) || (c >= 0x309D && c <= 0x309F)) return true;
    if ((c >= 0x30A1 && c <= 0x30FA) || (c >= 0x30FC && c <= 0x30FF)) return true;
    if ((c >= 0x3400 && c <= 0x4DBF) || (c >= 0x4E00 && c <= 0x9FFF)) return true;
    if (c >= 0xAC00 && c <= 0xD7A3) return true;
    if ((c >= 0xFF21 && c <= 0xFF3A) || (c >= 0xFF41 && c <= 0xFF5A)) return true;
    if (c >= 0x20000 && c <= 0x2FA1F) return true;
    return false;
}

// `toLowerCase` одной кодовой точки; «İ» даёт две точки, как в JS
inline U32 lowerFull(char32_t c) {
    if (c >= 'A' && c <= 'Z') return U32(1, c + 32);
    if (c < 0x80) return U32(1, c);
    if (c >= 0xC0 && c <= 0xDE && c != 0xD7) return U32(1, c + 32);
    if (c == 0x130) return U32{U'i', 0x307};
    if (c >= 0x100 && c <= 0x137) return U32(1, (c % 2 == 0) ? c + 1 : c);
    if (c >= 0x139 && c <= 0x148) return U32(1, (c % 2 == 1) ? c + 1 : c);
    if (c >= 0x14A && c <= 0x177) return U32(1, (c % 2 == 0) ? c + 1 : c);
    if (c == 0x178) return U32(1, 0xFF);
    if (c >= 0x179 && c <= 0x17E) return U32(1, (c % 2 == 1) ? c + 1 : c);
    if (c == 0x386) return U32(1, 0x3AC);
    if (c >= 0x388 && c <= 0x38A) return U32(1, c + 37);
    if (c == 0x38C) return U32(1, 0x3CC);
    if (c == 0x38E || c == 0x38F) return U32(1, c + 63);
    if (c >= 0x391 && c <= 0x3AB && c != 0x3A2) return U32(1, c + 32);
    if (c >= 0x400 && c <= 0x40F) return U32(1, c + 80);
    if (c >= 0x410 && c <= 0x42F) return U32(1, c + 32);
    if ((c >= 0x460 && c <= 0x481) || (c >= 0x48A && c <= 0x4BF) || (c >= 0x4D0 && c <= 0x52F)) {
        return U32(1, (c % 2 == 0) ? c + 1 : c);
    }
    if (c == 0x4C0) return U32(1, 0x4CF);
    if (c >= 0x4C1 && c <= 0x4CE) return U32(1, (c % 2 == 1) ? c + 1 : c);
    if (c >= 0x531 && c <= 0x556) return U32(1, c + 48);
    if (c >= 0x10A0 && c <= 0x10C5) return U32(1, c + 7264);
    if (c >= 0x1E00 && c <= 0x1E95) return U32(1, (c % 2 == 0) ? c + 1 : c);
    if (c >= 0x1EA0 && c <= 0x1EFF) return U32(1, (c % 2 == 0) ? c + 1 : c);
    if (c >= 0xFF21 && c <= 0xFF3A) return U32(1, c + 32);
    return U32(1, c);
}

inline U32 toLower(const U32 &s) {
    U32 out;
    out.reserve(s.size());
    for (char32_t c : s) out += lowerFull(c);
    return out;
}

inline std::string toLower(const std::string &s) { return encode(toLower(decode(s))); }

inline U32 trimU(const U32 &s) {
    size_t a = 0;
    size_t b = s.size();
    while (a < b && isSpace(s[a])) ++a;
    while (b > a && isSpace(s[b - 1])) --b;
    return s.substr(a, b - a);
}

inline U32 trimEndU(const U32 &s) {
    size_t b = s.size();
    while (b > 0 && isSpace(s[b - 1])) --b;
    return s.substr(0, b);
}

inline std::string trim(const std::string &s) { return encode(trimU(decode(s))); }
inline std::string trimEnd(const std::string &s) { return encode(trimEndU(decode(s))); }

inline bool startsWith(const std::string &s, const std::string &prefix) {
    return s.size() >= prefix.size() && s.compare(0, prefix.size(), prefix) == 0;
}

inline bool endsWith(const std::string &s, const std::string &suffix) {
    return s.size() >= suffix.size() && s.compare(s.size() - suffix.size(), suffix.size(), suffix) == 0;
}

inline bool startsWithU(const U32 &s, size_t at, const U32 &prefix) {
    return at <= s.size() && s.size() - at >= prefix.size() && s.compare(at, prefix.size(), prefix) == 0;
}

// `text.split(sep)` JS: пустая строка даёт `['']`
inline std::vector<std::string> split(const std::string &s, char sep) {
    std::vector<std::string> out;
    size_t start = 0;
    while (true) {
        const size_t at = s.find(sep, start);
        if (at == std::string::npos) {
            out.push_back(s.substr(start));
            return out;
        }
        out.push_back(s.substr(start, at - start));
        start = at + 1;
    }
}

inline std::string join(const std::vector<std::string> &parts, const std::string &sep) {
    std::string out;
    for (size_t i = 0; i < parts.size(); ++i) {
        if (i) out += sep;
        out += parts[i];
    }
    return out;
}

// `JSON.stringify(string)` JS: управляющие знаки — `\uXXXX` строчными, прочее как есть
inline std::string jsonQuote(const std::string &value) {
    static const char *kHex = "0123456789abcdef";
    std::string out = "\"";
    for (const char ch : value) {
        const auto c = static_cast<unsigned char>(ch);
        switch (c) {
        case '"': out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\b': out += "\\b"; break;
        case '\f': out += "\\f"; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        default:
            if (c < 0x20) {
                out += "\\u00";
                out.push_back(kHex[c >> 4]);
                out.push_back(kHex[c & 0xF]);
            } else {
                out.push_back(ch);
            }
        }
    }
    out += '"';
    return out;
}

// `Math.round` JS: половина — вверх
inline double jsRound(double value) {
    if (!std::isfinite(value)) return value;
    double r = std::floor(value);
    if (value - r >= 0.5) r += 1;
    return r == 0 ? 0.0 : r;
}

// `String(number)` JS для конечных чисел обычной величины
inline std::string formatNumber(double value) {
    if (value == 0) return "0";
    char buf[64];
    if (value == std::trunc(value) && std::fabs(value) < 1e21) {
        std::snprintf(buf, sizeof buf, "%.0f", value);
        return buf;
    }
    for (int precision = 1; precision <= 17; ++precision) {
        std::snprintf(buf, sizeof buf, "%.*g", precision, value);
        if (std::strtod(buf, nullptr) == value) break;
    }
    return buf;
}

// `number.toString(36)` для неотрицательных целых
inline std::string toBase36(long long value) {
    static const char *kDigits = "0123456789abcdefghijklmnopqrstuvwxyz";
    if (value <= 0) return "0";
    std::string out;
    while (value > 0) {
        out.insert(out.begin(), kDigits[value % 36]);
        value /= 36;
    }
    return out;
}

// `localeCompare` (корневая сортировка ICU, упрощённо): знаки < цифры < буквы; сначала без регистра и «ё» = «е»,
// затем «ё» после «е», затем строчная раньше заглавной
inline int localeCompare(const std::string &a, const std::string &b) {
    struct Key {
        std::vector<std::tuple<int, char32_t>> primary;
        std::vector<int> secondary;
        std::vector<int> tertiary;
    };
    auto keyOf = [](const std::string &s) {
        Key key;
        for (char32_t c : decode(s)) {
            const U32 lower = lowerFull(c);
            char32_t base = lower.size() == 1 ? lower[0] : c;
            int accent = 0;
            if (base == 0x451) { base = 0x435; accent = 1; }
            const int group = isLetter(c) ? 2 : isNumber(c) ? 1 : 0;
            key.primary.emplace_back(group, base);
            key.secondary.push_back(accent);
            key.tertiary.push_back(lower.size() == 1 && lower[0] != c ? 1 : 0);
        }
        return key;
    };
    const Key ka = keyOf(a);
    const Key kb = keyOf(b);
    if (ka.primary != kb.primary) return ka.primary < kb.primary ? -1 : 1;
    if (ka.secondary != kb.secondary) return ka.secondary < kb.secondary ? -1 : 1;
    if (ka.tertiary != kb.tertiary) return ka.tertiary < kb.tertiary ? -1 : 1;
    return 0;
}

// `encodeURI` JS: UTF-8 байты в %XX, кроме незарезервированных и зарезервированных знаков адреса
inline std::string encodeUri(const std::string &value) {
    static const std::string kKeep = ";,/?:@&=+$-_.!~*'()#";
    static const char *kHex = "0123456789ABCDEF";
    std::string out;
    for (const char ch : value) {
        const auto c = static_cast<unsigned char>(ch);
        const bool isAlnum = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
        if (isAlnum || (c < 0x80 && kKeep.find(static_cast<char>(c)) != std::string::npos)) {
            out.push_back(ch);
        } else {
            out.push_back('%');
            out.push_back(kHex[c >> 4]);
            out.push_back(kHex[c & 0xF]);
        }
    }
    return out;
}

// `decodeURI` JS; неверная %-последовательность — `std::nullopt` (в JS — URIError)
inline std::optional<std::string> decodeUri(const std::string &value) {
    static const std::string kReserved = ";/?:@&=+$,#";
    auto hexOf = [](char ch) -> int {
        if (ch >= '0' && ch <= '9') return ch - '0';
        if (ch >= 'a' && ch <= 'f') return ch - 'a' + 10;
        if (ch >= 'A' && ch <= 'F') return ch - 'A' + 10;
        return -1;
    };
    auto byteAt = [&](size_t at) -> int {
        if (at + 2 >= value.size()) return -1;
        if (value[at] != '%') return -1;
        const int hi = hexOf(value[at + 1]);
        const int lo = hexOf(value[at + 2]);
        return hi < 0 || lo < 0 ? -1 : hi * 16 + lo;
    };
    std::string out;
    size_t i = 0;
    while (i < value.size()) {
        if (value[i] != '%') {
            out.push_back(value[i]);
            ++i;
            continue;
        }
        const int lead = byteAt(i);
        if (lead < 0) return std::nullopt;
        if (lead < 0x80) {
            if (kReserved.find(static_cast<char>(lead)) != std::string::npos) out += value.substr(i, 3);
            else out.push_back(static_cast<char>(lead));
            i += 3;
            continue;
        }
        int len = 0;
        char32_t cp = 0;
        if ((lead & 0xE0) == 0xC0) { len = 2; cp = lead & 0x1F; }
        else if ((lead & 0xF0) == 0xE0) { len = 3; cp = lead & 0x0F; }
        else if ((lead & 0xF8) == 0xF0) { len = 4; cp = lead & 0x07; }
        else return std::nullopt;
        for (int k = 1; k < len; ++k) {
            const int next = byteAt(i + 3 * k);
            if (next < 0 || (next & 0xC0) != 0x80) return std::nullopt;
            cp = (cp << 6) | (next & 0x3F);
        }
        static const char32_t kMin[] = {0, 0, 0x80, 0x800, 0x10000};
        if (cp < kMin[len] || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return std::nullopt;
        appendUtf8(out, cp);
        i += 3 * len;
    }
    return out;
}

} // namespace parvane::sections::notes::text
