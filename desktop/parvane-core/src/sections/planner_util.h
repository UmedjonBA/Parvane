// Parvane fork (spec 029, фаза 4): служебные функции порта «Плана» — UTF-8 по кодовым точкам (пробелы и `trim`
// как в JS, нижний регистр латиницы и кириллицы), разбор чисел дня/времени. Только для src/sections/planner_*.cpp.
#pragma once

#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <string>
#include <vector>

namespace parvane::sections::planner::util {

// Кодовая точка с позиции `i` (байт); `len` — её длина в байтах. Негодный байт — сам по себе (U+FFFD, длина 1)
inline char32_t decodeAt(const std::string &s, size_t i, size_t &len) {
    const auto c = static_cast<unsigned char>(s[i]);
    if (c < 0x80) { len = 1; return c; }
    int extra = 0;
    char32_t cp = 0;
    if ((c & 0xE0) == 0xC0) { extra = 1; cp = c & 0x1F; }
    else if ((c & 0xF0) == 0xE0) { extra = 2; cp = c & 0x0F; }
    else if ((c & 0xF8) == 0xF0) { extra = 3; cp = c & 0x07; }
    else { len = 1; return 0xFFFD; }
    if (i + extra >= s.size()) { len = 1; return 0xFFFD; }
    for (int k = 1; k <= extra; ++k) {
        const auto cc = static_cast<unsigned char>(s[i + k]);
        if ((cc & 0xC0) != 0x80) { len = 1; return 0xFFFD; }
        cp = (cp << 6) | (cc & 0x3F);
    }
    len = static_cast<size_t>(extra) + 1;
    return cp;
}

inline void appendUtf8(std::string &out, char32_t cp) {
    if (cp < 0x80) out += static_cast<char>(cp);
    else if (cp < 0x800) {
        out += static_cast<char>(0xC0 | (cp >> 6));
        out += static_cast<char>(0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
        out += static_cast<char>(0xE0 | (cp >> 12));
        out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
        out += static_cast<char>(0x80 | (cp & 0x3F));
    } else {
        out += static_cast<char>(0xF0 | (cp >> 18));
        out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
        out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
        out += static_cast<char>(0x80 | (cp & 0x3F));
    }
}

// Пробельный символ, как `\s` и `trim` в JS (WhiteSpace + LineTerminator)
inline bool isSpace(char32_t c) {
    switch (c) {
    case 0x09: case 0x0A: case 0x0B: case 0x0C: case 0x0D: case 0x20: case 0xA0: case 0x1680:
    case 0x2028: case 0x2029: case 0x202F: case 0x205F: case 0x3000: case 0xFEFF:
        return true;
    default:
        return c >= 0x2000 && c <= 0x200A;
    }
}

// `String.prototype.trim` по кодовым точкам
inline std::string trim(const std::string &s) {
    size_t begin = 0;
    while (begin < s.size()) {
        size_t len = 0;
        if (!isSpace(decodeAt(s, begin, len))) break;
        begin += len;
    }
    size_t end = begin;
    for (size_t i = begin; i < s.size();) {
        size_t len = 0;
        const auto cp = decodeAt(s, i, len);
        i += len;
        if (!isSpace(cp)) end = i;
    }
    return s.substr(begin, end - begin);
}

// Нижний регистр латиницы и кириллицы (длина в байтах не меняется: позиции совпадают с исходной строкой)
inline std::string lower(const std::string &s) {
    std::string out;
    out.reserve(s.size());
    for (size_t i = 0; i < s.size();) {
        size_t len = 0;
        auto cp = decodeAt(s, i, len);
        if (cp == 0xFFFD && len == 1) {
            out += s[i];
            i += 1;
            continue;
        }
        if (cp >= 'A' && cp <= 'Z') cp += 0x20;
        else if (cp >= 0x410 && cp <= 0x42F) cp += 0x20;
        else if (cp >= 0x400 && cp <= 0x40F) cp += 0x50;
        appendUtf8(out, cp);
        i += len;
    }
    return out;
}

// Первые `count` кодовых точек (web режет `slice` по UTF-16 — расходится только на символах вне BMP)
inline std::string takeCodepoints(const std::string &s, size_t count) {
    size_t i = 0;
    for (size_t n = 0; n < count && i < s.size(); ++n) {
        size_t len = 0;
        decodeAt(s, i, len);
        i += len;
    }
    return s.substr(0, i);
}

// Длина в единицах UTF-16 — как `string.length` в JS
inline size_t utf16Length(const std::string &s) {
    size_t n = 0;
    for (size_t i = 0; i < s.size();) {
        size_t len = 0;
        const auto cp = decodeAt(s, i, len);
        n += cp >= 0x10000 ? 2 : 1;
        i += len;
    }
    return n;
}

inline bool isDigit(char c) { return c >= '0' && c <= '9'; }

// `/^\d{4}-\d{2}-\d{2}$/`
inline bool isDayKey(const std::string &s) {
    if (s.size() != 10) return false;
    for (size_t i = 0; i < 10; ++i) {
        if (i == 4 || i == 7) {
            if (s[i] != '-') return false;
        } else if (!isDigit(s[i])) return false;
    }
    return true;
}

// `/^([01]\d|2[0-3]):[0-5]\d$/`
inline bool isTimeKey(const std::string &s) {
    if (s.size() != 5 || s[2] != ':') return false;
    if (!isDigit(s[0]) || !isDigit(s[1]) || !isDigit(s[3]) || !isDigit(s[4])) return false;
    if (s[0] > '2' || (s[0] == '2' && s[1] > '3')) return false;
    return s[3] <= '5';
}

// `Number(part)` для части ключа: пустая строка — 0, не число — NaN
inline double numberOf(const std::string &part) {
    const auto t = trim(part);
    if (t.empty()) return 0;
    for (char c : t) {
        if (!isDigit(c)) return NAN;
    }
    // strtod, не stod: на сотнях цифр stod бросает out_of_range (A0079-1), strtod даёт inf
    return std::strtod(t.c_str(), nullptr);
}

inline std::vector<std::string> split(const std::string &s, char sep) {
    std::vector<std::string> out;
    size_t start = 0;
    for (;;) {
        const auto pos = s.find(sep, start);
        out.push_back(s.substr(start, pos == std::string::npos ? std::string::npos : pos - start));
        if (pos == std::string::npos) break;
        start = pos + 1;
    }
    return out;
}

inline std::string pad2(long long value) {
    auto text = std::to_string(value);
    return text.size() < 2 ? "0" + text : text;
}

// `Math.floor(a / b)` для целых
inline long long floorDiv(long long a, long long b) {
    long long q = a / b;
    if ((a % b != 0) && ((a < 0) != (b < 0))) --q;
    return q;
}

// `Math.round` (половина — вверх)
inline double jsRound(double x) { return std::floor(x + 0.5); }

} // namespace parvane::sections::planner::util
