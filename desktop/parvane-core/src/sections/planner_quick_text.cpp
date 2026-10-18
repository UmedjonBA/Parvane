// Parvane fork (spec 029, фаза 4): строки и регулярные выражения с поведением JavaScript для ввода текстом «Плана».
#include "planner_quick_text.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdlib>
#include <map>
#include <mutex>
#include <stdexcept>
#include <unordered_map>

namespace parvane::sections::planner::text {

// ── UTF-8 ↔ UTF-16 ───────────────────────────────────────────────────────────

S fromUtf8(const std::string &utf8) {
    S out;
    out.reserve(utf8.size());
    const auto *p = reinterpret_cast<const unsigned char *>(utf8.data());
    const size_t n = utf8.size();
    size_t i = 0;
    while (i < n) {
        const unsigned c = p[i];
        char32_t cp = 0xFFFD;
        size_t len = 1;
        if (c < 0x80) {
            cp = c;
        } else if ((c & 0xE0) == 0xC0 && i + 1 < n && (p[i + 1] & 0xC0) == 0x80) {
            cp = ((c & 0x1F) << 6) | (p[i + 1] & 0x3F);
            len = 2;
        } else if ((c & 0xF0) == 0xE0 && i + 2 < n && (p[i + 1] & 0xC0) == 0x80 && (p[i + 2] & 0xC0) == 0x80) {
            cp = ((c & 0x0F) << 12) | ((p[i + 1] & 0x3F) << 6) | (p[i + 2] & 0x3F);
            len = 3;
        } else if ((c & 0xF8) == 0xF0 && i + 3 < n && (p[i + 1] & 0xC0) == 0x80 && (p[i + 2] & 0xC0) == 0x80
                   && (p[i + 3] & 0xC0) == 0x80) {
            cp = ((c & 0x07) << 18) | ((p[i + 1] & 0x3F) << 12) | ((p[i + 2] & 0x3F) << 6) | (p[i + 3] & 0x3F);
            len = 4;
        }
        i += len;
        if (cp >= 0x10000 && cp <= 0x10FFFF) {
            cp -= 0x10000;
            out += char16_t(0xD800 + (cp >> 10));
            out += char16_t(0xDC00 + (cp & 0x3FF));
        } else if (cp > 0x10FFFF) {
            out += char16_t(0xFFFD);
        } else {
            out += char16_t(cp); // одиночный суррогат (WTF-8) сохраняется как есть
        }
    }
    return out;
}

static void put(std::string &out, char32_t cp) {
    if (cp < 0x80) {
        out += char(cp);
    } else if (cp < 0x800) {
        out += char(0xC0 | (cp >> 6));
        out += char(0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
        out += char(0xE0 | (cp >> 12));
        out += char(0x80 | ((cp >> 6) & 0x3F));
        out += char(0x80 | (cp & 0x3F));
    } else {
        out += char(0xF0 | (cp >> 18));
        out += char(0x80 | ((cp >> 12) & 0x3F));
        out += char(0x80 | ((cp >> 6) & 0x3F));
        out += char(0x80 | (cp & 0x3F));
    }
}

std::string toUtf8(const S &text) {
    std::string out;
    out.reserve(text.size() * 2);
    for (size_t i = 0; i < text.size(); ++i) {
        const char16_t c = text[i];
        if (c >= 0xD800 && c < 0xDC00 && i + 1 < text.size() && text[i + 1] >= 0xDC00 && text[i + 1] < 0xE000) {
            put(out, 0x10000 + ((char32_t(c) - 0xD800) << 10) + (char32_t(text[i + 1]) - 0xDC00));
            ++i;
        } else {
            put(out, c);
        }
    }
    return out;
}

// ── регистр и классы символов ────────────────────────────────────────────────

char16_t lowerUnit(char16_t c) {
    if (c < 0x80) return (c >= 'A' && c <= 'Z') ? char16_t(c + 32) : c;
    if (c >= 0xC0 && c <= 0xDE && c != 0xD7) return char16_t(c + 32);
    if (c < 0x100) return c;
    const auto evenUp = [&](char16_t lo, char16_t hi) { return c >= lo && c <= hi && (c - lo) % 2 == 0; };
    if (evenUp(0x100, 0x12E) || evenUp(0x132, 0x136) || evenUp(0x14A, 0x176)) return char16_t(c + 1);
    if (evenUp(0x139, 0x147) || evenUp(0x179, 0x17D)) return char16_t(c + 1);
    if (c == 0x178) return 0xFF;
    if (c == 0x1C4 || c == 0x1C5) return 0x1C6;
    if (c == 0x1C7 || c == 0x1C8) return 0x1C9;
    if (c == 0x1CA || c == 0x1CB) return 0x1CC;
    if (evenUp(0x1CD, 0x1DB) || evenUp(0x1DE, 0x1EE) || evenUp(0x1F8, 0x21E) || evenUp(0x222, 0x232)) {
        return char16_t(c + 1);
    }
    if (c == 0x1F1 || c == 0x1F2) return 0x1F3;
    if (c == 0x1F4) return 0x1F5;
    if (c == 0x386) return 0x3AC;
    if (c >= 0x388 && c <= 0x38A) return char16_t(c + 37);
    if (c == 0x38C) return 0x3CC;
    if (c == 0x38E || c == 0x38F) return char16_t(c + 63);
    if ((c >= 0x391 && c <= 0x3A1) || (c >= 0x3A3 && c <= 0x3AB)) return char16_t(c + 32);
    if (c >= 0x400 && c <= 0x40F) return char16_t(c + 80);
    if (c >= 0x410 && c <= 0x42F) return char16_t(c + 32);
    if (evenUp(0x460, 0x480) || evenUp(0x48A, 0x4BE) || evenUp(0x4D0, 0x52E)) return char16_t(c + 1);
    if (c == 0x4C0) return 0x4CF;
    if (c >= 0x4C1 && c <= 0x4CD && (c - 0x4C1) % 2 == 0) return char16_t(c + 1);
    if (c >= 0x531 && c <= 0x556) return char16_t(c + 48);
    if (c >= 0x10A0 && c <= 0x10C5) return char16_t(c - 0x10A0 + 0x2D00);
    if (evenUp(0x1E00, 0x1E94) || evenUp(0x1EA0, 0x1EFE)) return char16_t(c + 1);
    if (c == 0x1E9E) return 0xDF;
    if (c >= 0x2160 && c <= 0x216F) return char16_t(c + 16);
    if (c >= 0x24B6 && c <= 0x24CF) return char16_t(c + 26);
    if (c >= 0xFF21 && c <= 0xFF3A) return char16_t(c + 32);
    return c;
}

S jsLower(const S &text) {
    S out;
    out.reserve(text.size());
    for (const char16_t c : text) {
        if (c == 0x130) {
            out += u"i̇";
        } else {
            out += lowerUnit(c);
        }
    }
    return out;
}

S foldYo(S text) {
    for (auto &c : text) {
        if (c == u'ё') c = u'е';
    }
    return text;
}

bool isJsSpace(char32_t c) {
    return c == 9 || c == 10 || c == 11 || c == 12 || c == 13 || c == 32 || c == 0xA0 || c == 0x1680
        || (c >= 0x2000 && c <= 0x200A) || c == 0x2028 || c == 0x2029 || c == 0x202F || c == 0x205F
        || c == 0x3000 || c == 0xFEFF;
}

bool isLetter(char32_t c) {
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) return true;
    if (c < 0xAA) return false;
    if (c == 0xAA || c == 0xB5 || c == 0xBA) return true;
    if (c >= 0xC0 && c <= 0x24F) return c != 0xD7 && c != 0xF7;
    if (c >= 0x250 && c <= 0x2C1) return true;
    if (c >= 0x370 && c <= 0x3FF) return c != 0x375 && c != 0x37E && c != 0x384 && c != 0x385 && c != 0x387;
    if (c >= 0x400 && c <= 0x52F) return !(c >= 0x482 && c <= 0x489);
    if (c >= 0x531 && c <= 0x556) return true;
    if (c >= 0x560 && c <= 0x588) return true;
    if (c >= 0x5D0 && c <= 0x5EA) return true;
    if (c >= 0x620 && c <= 0x64A) return true;
    if (c >= 0x671 && c <= 0x6D3) return true;
    if (c >= 0x904 && c <= 0x939) return true;
    if (c >= 0xE01 && c <= 0xE30) return true;
    if (c >= 0x10A0 && c <= 0x10FF) return true;
    if (c >= 0x1100 && c <= 0x11FF) return true;
    if (c >= 0x1E00 && c <= 0x1FFF) return true;
    if (c >= 0x2C00 && c <= 0x2DFF) return true;
    if (c >= 0x3041 && c <= 0x3096) return true;
    if (c >= 0x30A1 && c <= 0x30FA) return true;
    if (c >= 0x3400 && c <= 0x4DBF) return true;
    if (c >= 0x4E00 && c <= 0x9FFF) return true;
    if (c >= 0xA640 && c <= 0xA69F) return true;
    if (c >= 0xAC00 && c <= 0xD7A3) return true;
    if (c >= 0xF900 && c <= 0xFAFF) return true;
    if (c >= 0xFF21 && c <= 0xFF3A) return true;
    if (c >= 0xFF41 && c <= 0xFF5A) return true;
    if (c >= 0x10400 && c <= 0x1044F) return true;
    if (c >= 0x20000 && c <= 0x2FA1F) return true;
    return false;
}

bool isNumber(char32_t c) {
    if (c >= '0' && c <= '9') return true;
    if (c == 0xB2 || c == 0xB3 || c == 0xB9 || (c >= 0xBC && c <= 0xBE)) return true;
    if ((c >= 0x660 && c <= 0x669) || (c >= 0x6F0 && c <= 0x6F9) || (c >= 0x966 && c <= 0x96F)) return true;
    if (c >= 0x2070 && c <= 0x2079 && c != 0x2071 && c != 0x2072 && c != 0x2073) return true;
    if (c >= 0x2080 && c <= 0x2089) return true;
    if (c >= 0x2150 && c <= 0x2189) return true;
    if (c >= 0x2460 && c <= 0x249B) return true;
    if (c >= 0x24EA && c <= 0x24FF) return true;
    if (c >= 0x2776 && c <= 0x2793) return true;
    if (c >= 0xFF10 && c <= 0xFF19) return true;
    return false;
}

bool isPunct(char32_t c) {
    switch (c) {
    case '!': case '"': case '#': case '%': case '&': case '\'': case '(': case ')': case '*': case ',':
    case '-': case '.': case '/': case ':': case ';': case '?': case '@': case '[': case '\\': case ']':
    case '_': case '{': case '}':
        return true;
    default:
        break;
    }
    if (c == 0xA1 || c == 0xA7 || c == 0xAB || c == 0xB6 || c == 0xB7 || c == 0xBB || c == 0xBF) return true;
    if (c == 0x37E || c == 0x387 || (c >= 0x55A && c <= 0x55F) || c == 0x589 || c == 0x58A) return true;
    if (c == 0x5BE || c == 0x5C0 || c == 0x5C3 || c == 0x5C6 || c == 0x5F3 || c == 0x5F4) return true;
    if (c == 0x60C || c == 0x60D || c == 0x61B || c == 0x61F || (c >= 0x66A && c <= 0x66D)) return true;
    if (c >= 0x2010 && c <= 0x2027) return true;
    if (c >= 0x2030 && c <= 0x2043) return true;
    if (c >= 0x2045 && c <= 0x2051 && c != 0x2052) return true;
    if (c >= 0x2053 && c <= 0x205E) return true;
    if (c >= 0x3001 && c <= 0x3003) return true;
    if (c >= 0x3008 && c <= 0x3011) return true;
    if (c >= 0xFF01 && c <= 0xFF0F && c != 0xFF04 && c != 0xFF0B) return true;
    return false;
}

// ── строки ───────────────────────────────────────────────────────────────────

S trimStart(const S &text) {
    size_t a = 0;
    while (a < text.size() && isJsSpace(text[a])) ++a;
    return text.substr(a);
}

S trimEnd(const S &text) {
    size_t b = text.size();
    while (b > 0 && isJsSpace(text[b - 1])) --b;
    return text.substr(0, b);
}

S trim(const S &text) { return trimStart(trimEnd(text)); }

S repeat(const S &text, size_t count) {
    S out;
    out.reserve(text.size() * count);
    for (size_t i = 0; i < count; ++i) out += text;
    return out;
}

S slice(const S &text, long from, long to) {
    const long n = long(text.size());
    if (to == kToEnd) to = n;
    if (from < 0) from = std::max(0L, n + from);
    if (to < 0) to = std::max(0L, n + to);
    from = std::min(from, n);
    to = std::min(to, n);
    if (to <= from) return S();
    return text.substr(size_t(from), size_t(to - from));
}

long indexOf(const S &text, const S &needle, size_t from) {
    const auto at = text.find(needle, from);
    return at == S::npos ? -1 : long(at);
}

std::vector<S> splitStr(const S &text, const S &sep) {
    std::vector<S> out;
    size_t start = 0;
    for (;;) {
        const auto at = text.find(sep, start);
        if (at == S::npos) break;
        out.push_back(text.substr(start, at - start));
        start = at + sep.size();
    }
    out.push_back(text.substr(start));
    return out;
}

double jsNumber(const S &text) {
    const S t = trim(text);
    if (t.empty()) return 0;
    std::string ascii;
    for (const char16_t c : t) {
        if (!((c >= '0' && c <= '9') || c == '.' || c == '-' || c == '+' || c == 'e' || c == 'E')) return NAN;
        ascii += char(c);
    }
    char *end = nullptr;
    const double v = std::strtod(ascii.c_str(), &end);
    return (end && *end == 0) ? v : NAN;
}

// ── движок регулярных выражений ──────────────────────────────────────────────
//
// Разбор шаблона в дерево, затем программа для машины с откатом (как в RE2/«regexp2» Расса Кокса):
// SPLIT кладёт альтернативу на стек, SAVE запоминает прежнее значение слота для отката. Жадный повтор
// одного символа (`\s*`, `[^…]*`, `.*`) идёт отдельной командой без роста стека на каждый символ.

namespace {

enum Builtin : unsigned {
    kDigit = 1, kNotDigit = 2, kSpace = 4, kNotSpace = 8, kWord = 16, kNotWord = 32, kPropL = 64, kPropN = 128,
    kPropP = 256,
};

struct CharClass {
    bool negated = false;
    std::vector<std::pair<char32_t, char32_t>> ranges;
    unsigned builtins = 0;

    bool raw(char32_t c) const {
        for (const auto &[lo, hi] : ranges) {
            if (c >= lo && c <= hi) return true;
        }
        if (builtins) {
            const bool digit = c >= '0' && c <= '9';
            const bool word = digit || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_';
            if ((builtins & kDigit) && digit) return true;
            if ((builtins & kNotDigit) && !digit) return true;
            if ((builtins & kSpace) && isJsSpace(c)) return true;
            if ((builtins & kNotSpace) && !isJsSpace(c)) return true;
            if ((builtins & kWord) && word) return true;
            if ((builtins & kNotWord) && !word) return true;
            if ((builtins & kPropL) && isLetter(c)) return true;
            if ((builtins & kPropN) && isNumber(c)) return true;
            if ((builtins & kPropP) && isPunct(c)) return true;
        }
        return false;
    }
    bool test(char32_t c, bool icase) const {
        bool r = raw(c);
        if (!r && icase && c < 0x10000) {
            const char16_t l = lowerUnit(char16_t(c));
            if (l != c) r = raw(l);
        }
        return r != negated;
    }
};

struct Node {
    enum Kind { Empty, Char, Any, Class, Seq, Alt, Group, Look, Repeat, Bol, Eol, Backref } kind = Empty;
    char32_t ch = 0;
    int cls = -1;
    int group = -1;         // Group: номер захвата либо -1; Backref: номер
    bool negative = false;  // Look
    int min = 0, max = -1;  // Repeat: -1 — без верхней границы
    bool greedy = true;
    std::vector<std::unique_ptr<Node>> kids;
};

enum Op : uint8_t { ALT, CHAR, ANY, CLASS, SPLIT, JMP, SAVE, BOL, EOL, LOOK, MATCH, PSET, PCHECK, BACKREF, STAR1 };

struct Inst {
    Op op;
    char32_t ch = 0;
    int x = 0, y = 0; // SPLIT: x — первая ветвь, y — вторая; JMP: x; SAVE/PSET/PCHECK: x — слот; LOOK: x — начало
    int cls = -1;     // CLASS, STAR1 (класс либо -1 для ANY, -2 для CHAR)
    bool negative = false;
    bool greedy = true;
    int min = 0, max = -1;
};

class Parser {
public:
    Parser(const S &p, bool unicode, std::vector<CharClass> &classes)
        : p_(p), unicode_(unicode), classes_(classes) {}

    std::unique_ptr<Node> parse() {
        auto node = alternation();
        if (i_ < p_.size()) throw std::runtime_error("regex: лишняя )");
        return node;
    }
    int groups() const { return groups_; }

private:
    const S &p_;
    bool unicode_;
    std::vector<CharClass> &classes_;
    size_t i_ = 0;
    int groups_ = 0;

    bool more() const { return i_ < p_.size(); }
    char16_t peek() const { return p_[i_]; }

    std::unique_ptr<Node> alternation() {
        auto first = sequence();
        if (!more() || peek() != u'|') return first;
        auto alt = std::make_unique<Node>();
        alt->kind = Node::Alt;
        alt->kids.push_back(std::move(first));
        while (more() && peek() == u'|') {
            ++i_;
            alt->kids.push_back(sequence());
        }
        return alt;
    }

    std::unique_ptr<Node> sequence() {
        auto seq = std::make_unique<Node>();
        seq->kind = Node::Seq;
        while (more() && peek() != u'|' && peek() != u')') {
            auto atom = this->atom();
            seq->kids.push_back(quantified(std::move(atom)));
        }
        return seq;
    }

    bool readInt(int &out) {
        const size_t start = i_;
        long v = 0;
        while (more() && peek() >= u'0' && peek() <= u'9') {
            v = v * 10 + (peek() - u'0');
            if (v > 100000) v = 100000;
            ++i_;
        }
        out = int(v);
        return i_ > start;
    }

    std::unique_ptr<Node> quantified(std::unique_ptr<Node> atom) {
        if (!more()) return atom;
        int min = -1, max = -1;
        const size_t save = i_;
        const char16_t c = peek();
        if (c == u'*') {
            min = 0; max = -1; ++i_;
        } else if (c == u'+') {
            min = 1; max = -1; ++i_;
        } else if (c == u'?') {
            min = 0; max = 1; ++i_;
        } else if (c == u'{') {
            ++i_;
            int a = 0;
            if (readInt(a)) {
                int b = a;
                bool ok = true;
                if (more() && peek() == u',') {
                    ++i_;
                    if (!readInt(b)) b = -1;
                }
                if (ok && more() && peek() == u'}') {
                    ++i_;
                    min = a;
                    max = b;
                }
            }
            if (min < 0) {
                i_ = save; // не квантификатор: «{» — обычный знак
                return atom;
            }
        } else {
            return atom;
        }
        bool greedy = true;
        if (more() && peek() == u'?') {
            greedy = false;
            ++i_;
        }
        auto rep = std::make_unique<Node>();
        rep->kind = Node::Repeat;
        rep->min = min;
        rep->max = max;
        rep->greedy = greedy;
        rep->kids.push_back(std::move(atom));
        return rep;
    }

    char32_t readHex(int count) {
        char32_t v = 0;
        for (int k = 0; k < count; ++k) {
            if (!more()) throw std::runtime_error("regex: \\u");
            const char16_t h = p_[i_++];
            v <<= 4;
            if (h >= u'0' && h <= u'9') v |= h - u'0';
            else if (h >= u'a' && h <= u'f') v |= h - u'a' + 10;
            else if (h >= u'A' && h <= u'F') v |= h - u'A' + 10;
            else throw std::runtime_error("regex: \\u");
        }
        return v;
    }

    // Экранированный знак: возвращает символ либо заполняет builtins (тогда символ не нужен)
    bool escape(char32_t &ch, unsigned &builtins, bool inClass) {
        if (!more()) throw std::runtime_error("regex: \\ в конце");
        const char16_t e = p_[i_++];
        switch (e) {
        case u'd': builtins = kDigit; return false;
        case u'D': builtins = kNotDigit; return false;
        case u's': builtins = kSpace; return false;
        case u'S': builtins = kNotSpace; return false;
        case u'w': builtins = kWord; return false;
        case u'W': builtins = kNotWord; return false;
        case u'n': ch = 10; return true;
        case u't': ch = 9; return true;
        case u'r': ch = 13; return true;
        case u'v': ch = 11; return true;
        case u'f': ch = 12; return true;
        case u'0': ch = 0; return true;
        case u'b':
            if (inClass) {
                ch = 8;
                return true;
            }
            throw std::runtime_error("regex: \\b не поддерживается");
        case u'u':
            if (more() && peek() == u'{' && unicode_) {
                ++i_;
                char32_t v = 0;
                while (more() && peek() != u'}') {
                    const size_t before = i_;
                    v = (v << 4) | readHex(1);
                    (void)before;
                }
                ++i_;
                ch = v;
                return true;
            }
            ch = readHex(4);
            return true;
        case u'p':
        case u'P': {
            if (!more() || peek() != u'{') throw std::runtime_error("regex: \\p");
            ++i_;
            S name;
            while (more() && peek() != u'}') name += p_[i_++];
            ++i_;
            if (name == u"L") builtins = kPropL;
            else if (name == u"N") builtins = kPropN;
            else if (name == u"P") builtins = kPropP;
            else throw std::runtime_error("regex: неизвестное свойство");
            if (e == u'P') throw std::runtime_error("regex: \\P не поддерживается");
            return false;
        }
        default:
            ch = e;
            return true;
        }
    }

    char32_t readChar() {
        const char16_t c = p_[i_++];
        if (unicode_ && c >= 0xD800 && c < 0xDC00 && more() && peek() >= 0xDC00 && peek() < 0xE000) {
            return 0x10000 + ((char32_t(c) - 0xD800) << 10) + (char32_t(p_[i_++]) - 0xDC00);
        }
        return c;
    }

    int parseClass() {
        CharClass cls;
        if (more() && peek() == u'^') {
            cls.negated = true;
            ++i_;
        }
        bool first = true;
        while (more() && (peek() != u']' || false)) {
            (void)first;
            first = false;
            char32_t lo = 0;
            unsigned b = 0;
            if (peek() == u'\\') {
                ++i_;
                if (!escape(lo, b, true)) {
                    cls.builtins |= b;
                    continue;
                }
            } else {
                lo = readChar();
            }
            if (more() && peek() == u'-' && i_ + 1 < p_.size() && p_[i_ + 1] != u']') {
                ++i_;
                char32_t hi = 0;
                unsigned b2 = 0;
                if (peek() == u'\\') {
                    ++i_;
                    if (!escape(hi, b2, true)) {
                        // «a-\d» — дефис обычный
                        cls.ranges.push_back({lo, lo});
                        cls.ranges.push_back({u'-', u'-'});
                        cls.builtins |= b2;
                        continue;
                    }
                } else {
                    hi = readChar();
                }
                cls.ranges.push_back({lo, hi});
            } else {
                cls.ranges.push_back({lo, lo});
            }
        }
        if (!more()) throw std::runtime_error("regex: незакрытый [");
        ++i_; // ]
        classes_.push_back(std::move(cls));
        return int(classes_.size()) - 1;
    }

    std::unique_ptr<Node> atom() {
        auto node = std::make_unique<Node>();
        const char16_t c = peek();
        if (c == u'(') {
            ++i_;
            if (more() && peek() == u'?') {
                ++i_;
                const char16_t k = more() ? p_[i_++] : 0;
                if (k == u':') {
                    node->kind = Node::Group;
                    node->group = -1;
                } else if (k == u'=' || k == u'!') {
                    node->kind = Node::Look;
                    node->negative = k == u'!';
                } else {
                    throw std::runtime_error("regex: неизвестная группа");
                }
            } else {
                node->kind = Node::Group;
                node->group = ++groups_;
            }
            node->kids.push_back(alternation());
            if (!more() || peek() != u')') throw std::runtime_error("regex: незакрытая (");
            ++i_;
            return node;
        }
        if (c == u'[') {
            ++i_;
            node->kind = Node::Class;
            node->cls = parseClass();
            return node;
        }
        if (c == u'.') {
            ++i_;
            node->kind = Node::Any;
            return node;
        }
        if (c == u'^') {
            ++i_;
            node->kind = Node::Bol;
            return node;
        }
        if (c == u'$') {
            ++i_;
            node->kind = Node::Eol;
            return node;
        }
        if (c == u'\\') {
            ++i_;
            if (more() && peek() >= u'1' && peek() <= u'9') {
                node->kind = Node::Backref;
                node->group = p_[i_++] - u'0';
                return node;
            }
            char32_t ch = 0;
            unsigned b = 0;
            if (escape(ch, b, false)) {
                node->kind = Node::Char;
                node->ch = ch;
            } else {
                CharClass cls;
                cls.builtins = b;
                classes_.push_back(std::move(cls));
                node->kind = Node::Class;
                node->cls = int(classes_.size()) - 1;
            }
            return node;
        }
        node->kind = Node::Char;
        node->ch = readChar();
        return node;
    }
};

bool nullable(const Node &n) {
    switch (n.kind) {
    case Node::Empty: case Node::Bol: case Node::Eol: case Node::Look: case Node::Backref: return true;
    case Node::Char: case Node::Any: case Node::Class: return false;
    case Node::Seq:
        for (const auto &k : n.kids) {
            if (!nullable(*k)) return false;
        }
        return true;
    case Node::Alt:
        for (const auto &k : n.kids) {
            if (nullable(*k)) return true;
        }
        return false;
    case Node::Group: return nullable(*n.kids[0]);
    case Node::Repeat: return n.min == 0 || nullable(*n.kids[0]);
    }
    return true;
}

bool isSingle(const Node &n) { return n.kind == Node::Char || n.kind == Node::Any || n.kind == Node::Class; }

} // namespace

// Первые символы совпадения: отсев позиций и ветвей альтернативы до запуска машины. `nullable` —
// совпадение может начаться без поглощения символа (тогда отсева нет). `bolPasses` — проходит ли `^`
constexpr char32_t kFastLimit = 0x500; // латиница и кириллица — проверка по битовой карте
using FastBits = std::array<uint64_t, kFastLimit / 64>;

struct FirstSet {
    bool any = false;
    bool nullable = false;
    FastBits bits{};
    std::vector<int> classes;
    std::vector<char32_t> chars;

    void merge(const FirstSet &other) {
        any = any || other.any;
        classes.insert(classes.end(), other.classes.begin(), other.classes.end());
        chars.insert(chars.end(), other.chars.begin(), other.chars.end());
    }
};

FirstSet firstOf(const Node &n, bool bolPasses) {
    FirstSet f;
    switch (n.kind) {
    case Node::Empty: case Node::Eol: case Node::Look:
        f.nullable = true;
        break;
    case Node::Bol:
        f.nullable = bolPasses;
        break;
    case Node::Backref:
        f.any = true;
        f.nullable = true;
        break;
    case Node::Char: f.chars.push_back(n.ch); break;
    case Node::Any: f.any = true; break;
    case Node::Class: f.classes.push_back(n.cls); break;
    case Node::Group: return firstOf(*n.kids[0], bolPasses);
    case Node::Repeat: {
        f = firstOf(*n.kids[0], bolPasses);
        if (n.min == 0) f.nullable = true;
        break;
    }
    case Node::Alt:
        for (const auto &k : n.kids) {
            const FirstSet sub = firstOf(*k, bolPasses);
            f.merge(sub);
            f.nullable = f.nullable || sub.nullable;
        }
        break;
    case Node::Seq:
        f.nullable = true;
        for (const auto &k : n.kids) {
            const FirstSet sub = firstOf(*k, bolPasses);
            f.merge(sub);
            if (!sub.nullable) {
                f.nullable = false;
                break;
            }
        }
        break;
    }
    return f;
}

struct Regex::Impl {
    std::vector<Inst> prog;
    std::vector<CharClass> classes;
    int groups = 0;
    int slots = 0; // захваты + регистры продвижения
    bool icase = false, unicode = false, multiline = false;
    bool anchored = false;
    FirstSet first;
    bool filtered = false;
    std::vector<FirstSet> firstSets;
    std::vector<std::vector<std::pair<int, int>>> altTables;


    bool slowStarts(const FirstSet &set, char32_t c) const {
        for (const char32_t ch : set.chars) {
            if (c == ch || (icase && c < 0x10000 && ch < 0x10000 && lowerUnit(char16_t(c)) == lowerUnit(char16_t(ch)))) {
                return true;
            }
        }
        for (const int cls : set.classes) {
            if (classes[size_t(cls)].test(c, icase)) return true;
        }
        return false;
    }

    bool startsWith(const FirstSet &set, const S &s, int pos) const {
        if (set.nullable || set.any) return true;
        if (size_t(pos) >= s.size()) return false;
        int len = 1;
        const char32_t c = at(s, pos, len);
        if (c < kFastLimit) return (set.bits[c >> 6] >> (c & 63)) & 1;
        return slowStarts(set, c);
    }

    void prepareFast() {
        flatBits.assign(classes.size() * size_t(kFastWords), 0);
        for (size_t k = 0; k < classes.size(); ++k) {
            for (char32_t c = 0; c < kFastLimit; ++c) {
                if (classes[k].test(c, icase)) flatBits[k * size_t(kFastWords) + (c >> 6)] |= uint64_t(1) << (c & 63);
            }
        }
        const auto fill = [&](FirstSet &set) {
            for (char32_t c = 0; c < kFastLimit; ++c) {
                if (slowStarts(set, c)) set.bits[c >> 6] |= uint64_t(1) << (c & 63);
            }
        };
        fill(first);
        for (auto &set : firstSets) fill(set);
    }

    int emit(Inst inst) {
        prog.push_back(inst);
        return int(prog.size()) - 1;
    }

    void compile(const Node &n) {
        switch (n.kind) {
        case Node::Empty: break;
        case Node::Char: emit({CHAR, n.ch}); break;
        case Node::Any: emit({ANY}); break;
        case Node::Class: {
            Inst inst{CLASS};
            inst.cls = n.cls;
            emit(inst);
            break;
        }
        case Node::Bol: emit({BOL}); break;
        case Node::Eol: emit({EOL}); break;
        case Node::Backref: {
            Inst inst{BACKREF};
            inst.x = n.group;
            emit(inst);
            break;
        }
        case Node::Seq:
            for (const auto &k : n.kids) compile(*k);
            break;
        case Node::Alt: {
            // ALT: ветви, которые не могут начаться с текущего символа, не пробуются вовсе (тела словаря —
            // длинные альтернативы, а большинство ветвей отпадает на первом символе)
            Inst alt{ALT};
            alt.x = int(altTables.size());
            altTables.emplace_back();
            const int at = emit(alt);
            (void)at;
            std::vector<int> jumps;
            std::vector<std::pair<int, int>> table;
            for (size_t k = 0; k < n.kids.size(); ++k) {
                firstSets.push_back(firstOf(*n.kids[k], true));
                table.push_back({int(prog.size()), int(firstSets.size()) - 1});
                compile(*n.kids[k]);
                jumps.push_back(emit({JMP}));
            }
            for (const int j : jumps) prog[j].x = int(prog.size());
            altTables[size_t(alt.x)] = std::move(table);
            break;
        }
        case Node::Group:
            if (n.group >= 0) {
                Inst open{SAVE};
                open.x = n.group * 2;
                emit(open);
                compile(*n.kids[0]);
                Inst close{SAVE};
                close.x = n.group * 2 + 1;
                emit(close);
            } else {
                compile(*n.kids[0]);
            }
            break;
        case Node::Look: {
            Inst look{LOOK};
            look.negative = n.negative;
            const int at = emit(look);
            // Подпрограмма идёт следом, за ней MATCH; основная программа перепрыгивает её
            const int jump = emit({JMP});
            prog[at].x = int(prog.size());
            compile(*n.kids[0]);
            emit({MATCH});
            prog[jump].x = int(prog.size());
            break;
        }
        case Node::Repeat: {
            const Node &body = *n.kids[0];
            if (isSingle(body) && n.max == -1) {
                Inst star{STAR1};
                star.cls = body.kind == Node::Class ? body.cls : (body.kind == Node::Any ? -1 : -2);
                star.ch = body.ch;
                star.min = n.min;
                star.greedy = n.greedy;
                emit(star);
                break;
            }
            for (int k = 0; k < n.min; ++k) compile(body);
            const bool guard = nullable(body);
            if (n.max == -1) {
                const int reg = guard ? slots++ : -1;
                const int split = emit({SPLIT});
                const int bodyAt = int(prog.size());
                if (guard) {
                    Inst set{PSET};
                    set.x = reg;
                    emit(set);
                }
                compile(body);
                if (guard) {
                    Inst check{PCHECK};
                    check.x = reg;
                    emit(check);
                }
                Inst back{JMP};
                back.x = split;
                emit(back);
                const int after = int(prog.size());
                prog[split].x = n.greedy ? bodyAt : after;
                prog[split].y = n.greedy ? after : bodyAt;
            } else {
                std::vector<int> splits;
                for (int k = n.min; k < n.max; ++k) {
                    splits.push_back(emit({SPLIT}));
                    const int bodyAt = int(prog.size());
                    compile(body);
                    prog[splits.back()].x = bodyAt;
                }
                const int after = int(prog.size());
                for (const int s : splits) {
                    if (n.greedy) {
                        prog[s].y = after;
                    } else {
                        prog[s].y = prog[s].x;
                        prog[s].x = after;
                    }
                }
            }
            break;
        }
        }
    }

    // Символ строки в позиции: в режиме u — кодовая точка (суррогатная пара целиком)
    char32_t at(const char16_t *str, int n, int pos, int &len) const {
        const char16_t c = str[pos];
        if (unicode && c >= 0xD800 && c < 0xDC00 && pos + 1 < n && str[pos + 1] >= 0xDC00 && str[pos + 1] < 0xE000) {
            len = 2;
            return 0x10000 + ((char32_t(c) - 0xD800) << 10) + (char32_t(str[pos + 1]) - 0xDC00);
        }
        len = 1;
        return c;
    }
    char32_t at(const S &s, int pos, int &len) const { return at(s.data(), int(s.size()), pos, len); }

    static bool lineTerm(char32_t c) { return c == 10 || c == 13 || c == 0x2028 || c == 0x2029; }

    // Карты классов подряд: класс k — слова [k * kFastWords, (k + 1) * kFastWords)
    static constexpr int kFastWords = int(kFastLimit / 64);
    std::vector<uint64_t> flatBits;

    // Один символ под командой CHAR / ANY / CLASS (либо телом STAR1)
    bool one(const Inst &inst, const char16_t *str, int n, int &pos) const {
        if (pos >= n) return false;
        int len = 1;
        const char32_t c = at(str, n, pos, len);
        bool ok;
        const int kind = inst.op == STAR1 ? inst.cls : (inst.op == CHAR ? -2 : inst.op == ANY ? -1 : inst.cls);
        if (kind == -2) {
            ok = c == inst.ch || (icase && c < 0x10000 && inst.ch < 0x10000
                                  && lowerUnit(char16_t(c)) == lowerUnit(char16_t(inst.ch)));
        } else if (kind == -1) {
            ok = !lineTerm(c);
        } else if (c < kFastLimit) {
            ok = (flatBits.data()[kind * kFastWords + int(c >> 6)] >> (c & 63)) & 1;
        } else {
            ok = classes[size_t(kind)].test(c, icase);
        }
        if (ok) pos += len;
        return ok;
    }
    bool one(const Inst &inst, const S &s, int &pos) const { return one(inst, s.data(), int(s.size()), pos); }

    struct Frame {
        int pc;
        int pos;  // ветвь: позиция; откат слота: старое значение
        int slot; // -1 — ветвь, -2 — ленивый повтор, -3 — жадный повтор отдаёт символ, ≥0 — откат слота
        int count;
    };

    bool run(int startPc, int startPos, const S &s, std::vector<int> &slotv, std::vector<Frame> &stackv) const {
        const Inst *P = prog.data();
        const char16_t *str = s.data();
        const int n = int(s.size());
        int *slot = slotv.data();
        if (stackv.size() < 64) stackv.resize(64);
        Frame *st = stackv.data();
        size_t sp = 0;
#define PV_PUSH(PC, POS, SLOT, COUNT)                                                                       \
    do {                                                                                                    \
        if (sp == stackv.size()) {                                                                          \
            stackv.resize(sp * 2);                                                                          \
            st = stackv.data();                                                                             \
        }                                                                                                   \
        st[sp].pc = (PC);                                                                                   \
        st[sp].pos = (POS);                                                                                 \
        st[sp].slot = (SLOT);                                                                               \
        st[sp].count = (COUNT);                                                                             \
        ++sp;                                                                                               \
    } while (0)
        int pc = startPc;
        int pos = startPos;
        for (;;) {
            bool fail = false;
            const Inst &inst = P[pc];
            switch (inst.op) {
            case CHAR:
            case ANY:
            case CLASS:
                if (one(inst, str, n, pos)) ++pc;
                else fail = true;
                break;
            case STAR1: {
                int p = pos;
                int count = 0;
                if (inst.greedy) {
                    while (one(inst, str, n, p)) ++count;
                    if (count < inst.min) {
                        fail = true;
                        break;
                    }
                    // Откат по одному символу — одним кадром со счётчиком
                    if (count > inst.min) PV_PUSH(pc + 1, p, -3, count - inst.min);
                } else {
                    while (count < inst.min && one(inst, str, n, p)) ++count;
                    if (count < inst.min) {
                        fail = true;
                        break;
                    }
                    // Ленивый: сначала продолжаем, при откате берём ещё символ
                    PV_PUSH(pc, p, -2, 0);
                }
                pos = p;
                ++pc;
                break;
            }
            case SPLIT:
                PV_PUSH(inst.y, pos, -1, 0);
                pc = inst.x;
                break;
            case ALT: {
                // Ветви по порядку: первая подходящая — сейчас, остальные — в стек в обратном порядке
                const auto &table = altTables[size_t(inst.x)];
                const size_t count = table.size();
                const std::pair<int, int> *rows = table.data();
                int firstPc = -1;
                const size_t mark = sp;
                for (size_t k = 0; k < count; ++k) {
                    if (!startsWith(firstSets[size_t(rows[k].second)], s, pos)) continue;
                    if (firstPc < 0) firstPc = rows[k].first;
                    else PV_PUSH(rows[k].first, pos, -1, 0);
                }
                if (firstPc < 0) {
                    fail = true;
                    break;
                }
                std::reverse(st + mark, st + sp);
                pc = firstPc;
                break;
            }
            case JMP:
                pc = inst.x;
                break;
            case SAVE:
            case PSET:
                PV_PUSH(0, slot[inst.x], inst.x, 0);
                slot[inst.x] = pos;
                ++pc;
                break;
            case PCHECK:
                if (slot[inst.x] == pos) fail = true;
                else ++pc;
                break;
            case BOL:
                if (pos == 0 || (multiline && lineTerm(str[pos - 1]))) ++pc;
                else fail = true;
                break;
            case EOL:
                if (pos == n || (multiline && lineTerm(str[pos]))) ++pc;
                else fail = true;
                break;
            case BACKREF: {
                const int a = slot[inst.x * 2];
                const int b = slot[inst.x * 2 + 1];
                if (a < 0 || b < 0) {
                    ++pc;
                    break;
                }
                const int len = b - a;
                if (pos + len <= n && s.compare(size_t(pos), size_t(len), s, size_t(a), size_t(len)) == 0) {
                    pos += len;
                    ++pc;
                } else {
                    fail = true;
                }
                break;
            }
            case LOOK: {
                std::vector<int> copy = slotv;
                std::vector<Frame> inner;
                const bool found = run(inst.x, pos, s, copy, inner);
                // Следом за LOOK — JMP через подпрограмму
                if (found != inst.negative) ++pc;
                else fail = true;
                break;
            }
            case MATCH:
                return true;
            }
            if (!fail) continue;
            // Откат
            for (;;) {
                if (sp == 0) return false;
                const Frame f = st[--sp];
                if (f.slot >= 0) {
                    slot[f.slot] = f.pos;
                    continue;
                }
                if (f.slot == -3) {
                    // Жадный повтор одного символа отдаёт символ (в режиме u — пару суррогатов целиком)
                    int p = f.pos - 1;
                    if (unicode && p > 0 && str[p] >= 0xDC00 && str[p] < 0xE000 && str[p - 1] >= 0xD800
                        && str[p - 1] < 0xDC00) {
                        --p;
                    }
                    if (f.count > 1) PV_PUSH(f.pc, p, -3, f.count - 1);
                    pc = f.pc;
                    pos = p;
                    break;
                }
                if (f.slot == -2) {
                    // Ленивый повтор: взять ещё один символ и продолжить
                    int p = f.pos;
                    if (!one(P[f.pc], str, n, p)) continue;
                    PV_PUSH(f.pc, p, -2, 0);
                    pc = f.pc + 1;
                    pos = p;
                    break;
                }
                pc = f.pc;
                pos = f.pos;
                break;
            }
        }
#undef PV_PUSH
    }
};

Regex::Regex(const S &pattern, const std::string &flags) : impl_(std::make_unique<Impl>()) {
    impl_->icase = flags.find('i') != std::string::npos;
    impl_->unicode = flags.find('u') != std::string::npos;
    impl_->multiline = flags.find('m') != std::string::npos;
    Parser parser(pattern, impl_->unicode, impl_->classes);
    const auto root = parser.parse();
    impl_->groups = parser.groups();
    impl_->slots = (impl_->groups + 1) * 2;
    impl_->anchored = !impl_->multiline && root->kind == Node::Seq && !root->kids.empty()
        && root->kids[0]->kind == Node::Bol;
    impl_->first = firstOf(*root, impl_->multiline);
    impl_->filtered = !impl_->first.nullable && !impl_->first.any;
    Inst open{SAVE};
    open.x = 0;
    impl_->emit(open);
    impl_->compile(*root);
    Inst close{SAVE};
    close.x = 1;
    impl_->emit(close);
    impl_->emit({MATCH});
    impl_->prepareFast();
}

Regex::~Regex() = default;

int Regex::groupCount() const { return impl_->groups; }

bool Regex::exec(const S &text, int from, Match &out) const {
    const Impl *impl = impl_.get();
    const int n = int(text.size());
    if (from < 0) from = 0;
    if (from > n) return false;
    if (impl->anchored && from > 0) return false;
    const int last = impl->anchored ? 0 : n;
    std::vector<int> slots(size_t(impl->slots), -1);
    std::vector<Impl::Frame> stack;
    const bool filtered = impl->filtered;
    // Отсев позиций по первому символу (быстрая карта для латиницы и кириллицы)
    const uint64_t *bits = impl->first.bits.data();
    const char16_t *str = text.data();
    for (int start = from; start <= last; ++start) {
        if (start > 0 && filtered) {
            if (start >= n) continue;
            const char16_t c = str[start];
            if (c < kFastLimit) {
                if (!((bits[c >> 6] >> (c & 63)) & 1)) continue;
            } else if (!impl->startsWith(impl->first, text, start)) {
                continue;
            }
        }
        std::fill(slots.begin(), slots.end(), -1);
        if (impl->run(0, start, text, slots, stack)) {
            out.slots.assign(slots.begin(), slots.begin() + (impl->groups + 1) * 2);
            return true;
        }
    }
    return false;
}

bool Regex::test(const S &text) const {
    Match m;
    return exec(text, 0, m);
}

const Regex &rx(const std::string &pattern, const std::string &flags) {
    // Общий кэш: выражения неизменяемы после сборки, exec не трогает общее состояние
    static std::mutex mutex;
    static std::unordered_map<std::string, std::unique_ptr<Regex>> cache;
    const std::string key = flags + '\x01' + pattern;
    std::lock_guard<std::mutex> lock(mutex);
    auto it = cache.find(key);
    if (it == cache.end()) {
        it = cache.emplace(key, std::make_unique<Regex>(fromUtf8(pattern), flags)).first;
    }
    return *it->second;
}

std::vector<Match> matchAll(const Regex &re, const S &text) {
    std::vector<Match> out;
    int from = 0;
    Match m;
    while (from <= int(text.size()) && re.exec(text, from, m)) {
        out.push_back(m);
        from = m.end() > m.index() ? m.end() : m.index() + 1;
    }
    return out;
}

std::vector<S> splitRe(const Regex &re, const S &text) {
    // String.prototype.split(regex): пустое совпадение в позиции 0 и в конце строки не режет
    std::vector<S> out;
    if (text.empty()) {
        if (!re.test(text)) out.push_back(text);
        return out;
    }
    int p = 0;
    int q = 0;
    const int n = int(text.size());
    Match m;
    while (q < n) {
        if (!re.exec(text, q, m)) break;
        const int e = m.end();
        if (m.index() >= n) break;
        if (e == p || (m.index() == m.end() && m.index() == p)) {
            q = m.index() + 1;
            continue;
        }
        out.push_back(text.substr(size_t(p), size_t(m.index() - p)));
        p = e;
        q = e > m.index() ? e : m.index() + 1;
    }
    out.push_back(text.substr(size_t(p)));
    return out;
}

int search(const Regex &re, const S &text) {
    Match m;
    return re.exec(text, 0, m) ? m.index() : -1;
}

} // namespace parvane::sections::planner::text
