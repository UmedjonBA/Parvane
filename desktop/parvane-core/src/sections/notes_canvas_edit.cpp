// Parvane fork (spec 029, фаза 4): правки холста «Знаний» — порт web `notes/notesCanvasEdit.ts` и `findFreeSpot`
// из `notes/notesCanvasGraph.ts`. См. notes_canvas_edit.h.
#include "parvane/sections/notes_canvas_edit.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <map>
#include <set>

namespace parvane::sections::notes {

namespace {

// Карточка, вынесенная за рамку группы меньше чем наполовину, остаётся в группе — рамка растёт
constexpr double kGroupKeepShare = 0.5;
constexpr double kEdgeMinBend = 40;
constexpr int kEdgeSamples = 24;
constexpr std::size_t kPastedTextMax = 20000;
constexpr int kSpotMaxRings = 240;

using namespace canvasjs;

bool isSameRect(const CanvasRect &a, const CanvasRect &b) {
    return a.x == b.x && a.y == b.y && a.width == b.width && a.height == b.height;
}

bool isInside(const CanvasRect &inner, const CanvasRect &outer) {
    return inner.x >= outer.x && inner.y >= outer.y
        && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}

double overlapArea(const CanvasRect &a, const CanvasRect &b) {
    const double width = std::min(a.x + a.width, b.x + b.width) - std::max(a.x, b.x);
    const double height = std::min(a.y + a.height, b.y + b.height) - std::max(a.y, b.y);
    return width > 0 && height > 0 ? width * height : 0;
}

double overlapShare(const CanvasRect &inner, const CanvasRect &outer) {
    const double area = inner.width * inner.height;
    return area > 0 ? overlapArea(inner, outer) / area : 0;
}

CanvasRect inflateRect(const CanvasRect &rect, double by) {
    return {rect.x - by, rect.y - by, rect.width + by * 2, rect.height + by * 2};
}

std::optional<CanvasRect> boundsOfRects(const std::vector<CanvasRect> &rects) {
    if (rects.empty()) return std::nullopt;
    double x = std::numeric_limits<double>::infinity();
    double y = x;
    double right = -x;
    double bottom = -x;
    for (const auto &r : rects) {
        x = std::min(x, r.x);
        y = std::min(y, r.y);
        right = std::max(right, r.x + r.width);
        bottom = std::max(bottom, r.y + r.height);
    }
    return CanvasRect{x, y, right - x, bottom - y};
}

std::vector<CanvasRect> rectsOf(const std::vector<CanvasNode> &nodes) {
    std::vector<CanvasRect> rects;
    rects.reserve(nodes.size());
    for (const auto &node : nodes) rects.push_back(node.rect());
    return rects;
}

CanvasRect unionRect(const CanvasRect &a, const CanvasRect &b) {
    return *boundsOfRects({a, b});
}

bool has(const std::vector<std::string> &list, std::string_view id) {
    return std::find(list.begin(), list.end(), id) != list.end();
}

double distanceToSegment(CanvasPoint point, CanvasPoint a, CanvasPoint b) {
    const double dx = b.x - a.x;
    const double dy = b.y - a.y;
    const double length = dx * dx + dy * dy;
    const double t = length
        ? std::max(0.0, std::min(1.0, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length)) : 0;
    return std::hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t));
}

std::set<std::string> withGroupContent(const CanvasDoc &doc, const std::vector<std::string> &ids) {
    std::set<std::string> result;
    for (const auto &id : ids) {
        if (!findNode(doc, id)) continue;
        result.insert(id);
        for (const auto &node : nodesInGroup(doc, id)) result.insert(node.id);
    }
    return result;
}

template <typename Item>
std::optional<std::string> freeId(const std::vector<Item> &taken, const CanvasMakeId &makeId) {
    for (int attempt = 0; attempt < 8; ++attempt) {
        const std::string id = makeId ? makeId() : newCanvasId();
        if (id.empty()) continue;
        const bool busy = std::any_of(taken.begin(), taken.end(), [&](const Item &item) { return item.id == id; });
        if (!busy) return id;
    }
    return std::nullopt;
}

// ── адрес ссылки (URL по WHATWG для http и https) ────────────────────────────

// Строгий разбор UTF-8; битая последовательность — false
bool decodeUtf8(std::string_view text, std::u32string &out) {
    std::size_t i = 0;
    while (i < text.size()) {
        const auto c = static_cast<unsigned char>(text[i]);
        int count = 0;
        char32_t cp = 0;
        if (c < 0x80) { cp = c; }
        else if ((c & 0xE0) == 0xC0) { count = 1; cp = c & 0x1F; }
        else if ((c & 0xF0) == 0xE0) { count = 2; cp = c & 0x0F; }
        else if ((c & 0xF8) == 0xF0) { count = 3; cp = c & 0x07; }
        else return false;
        if (i + count >= text.size()) return false;
        for (int k = 1; k <= count; ++k) {
            const auto b = static_cast<unsigned char>(text[i + k]);
            if ((b & 0xC0) != 0x80) return false;
            cp = (cp << 6) | (b & 0x3F);
        }
        out.push_back(cp);
        i += count + 1;
    }
    return true;
}

// Нижний регистр для имени узла (ASCII, латиница-1, греческий, кириллица) — упрощённое отображение UTS 46
char32_t lowerCodePoint(char32_t c) {
    if (c >= 'A' && c <= 'Z') return c + 32;
    if ((c >= 0xC0 && c <= 0xDE && c != 0xD7)) return c + 32;
    if (c >= 0x391 && c <= 0x3AB && c != 0x3A2) return c + 32;
    if (c >= 0x410 && c <= 0x42F) return c + 32;
    if (c >= 0x400 && c <= 0x40F) return c + 80;
    return c;
}

// Punycode (RFC 3492) одной метки
std::string punycode(const std::u32string &input) {
    constexpr std::uint32_t base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700, initialBias = 72;
    auto digit = [](std::uint32_t d) { return static_cast<char>(d < 26 ? 'a' + d : '0' + (d - 26)); };
    auto adapt = [&](std::uint32_t delta, std::uint32_t points, bool first) {
        delta = first ? delta / damp : delta / 2;
        delta += delta / points;
        std::uint32_t k = 0;
        while (delta > ((base - tMin) * tMax) / 2) {
            delta /= base - tMin;
            k += base;
        }
        return k + (base - tMin + 1) * delta / (delta + skew);
    };
    std::string out;
    for (const char32_t c : input) {
        if (c < 0x80) out.push_back(static_cast<char>(c));
    }
    const std::uint32_t basic = static_cast<std::uint32_t>(out.size());
    std::uint32_t handled = basic;
    if (basic) out.push_back('-');
    std::uint32_t n = 0x80, delta = 0, bias = initialBias;
    while (handled < input.size()) {
        std::uint32_t m = 0xFFFFFFFF;
        for (const char32_t c : input) {
            if (c >= n && c < m) m = c;
        }
        delta += (m - n) * (handled + 1);
        n = m;
        for (const char32_t c : input) {
            if (c < n) ++delta;
            if (c == n) {
                std::uint32_t q = delta;
                for (std::uint32_t k = base;; k += base) {
                    const std::uint32_t t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
                    if (q < t) break;
                    out.push_back(digit(t + (q - t) % (base - t)));
                    q = (q - t) / (base - t);
                }
                out.push_back(digit(q));
                bias = adapt(delta, handled + 1, handled == basic);
                delta = 0;
                ++handled;
            }
        }
        ++delta;
        ++n;
    }
    return out;
}

int hexValue(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

std::string percentDecode(std::string_view text) {
    std::string out;
    for (std::size_t i = 0; i < text.size(); ++i) {
        if (text[i] == '%' && i + 2 < text.size() && hexValue(text[i + 1]) >= 0 && hexValue(text[i + 2]) >= 0) {
            out.push_back(static_cast<char>(hexValue(text[i + 1]) * 16 + hexValue(text[i + 2])));
            i += 2;
        } else {
            out.push_back(text[i]);
        }
    }
    return out;
}

enum class EncodeSet { Userinfo, Path, Query, Fragment };

bool needsEncoding(unsigned char c, EncodeSet set) {
    if (c < 0x20 || c > 0x7E) return true;
    const auto in = [c](const char *chars) { return std::string_view(chars).find(static_cast<char>(c)) != std::string_view::npos; };
    switch (set) {
    case EncodeSet::Fragment: return in(" \"<>`");
    case EncodeSet::Query: return in(" \"#<>'");
    case EncodeSet::Path: return in(" \"#<>?^`{}");
    case EncodeSet::Userinfo: return in(" \"#<>?`{}/:;=@[\\]^|");
    }
    return false;
}

std::string percentEncode(std::string_view text, EncodeSet set) {
    static const char hex[] = "0123456789ABCDEF";
    std::string out;
    for (const char ch : text) {
        const auto c = static_cast<unsigned char>(ch);
        if (needsEncoding(c, set)) {
            out.push_back('%');
            out.push_back(hex[c >> 4]);
            out.push_back(hex[c & 15]);
        } else {
            out.push_back(ch);
        }
    }
    return out;
}

// Число части IPv4: десятичное, 0x… шестнадцатеричное, с ведущим нулём — восьмеричное
std::optional<std::uint64_t> ipv4Number(std::string_view part) {
    if (part.empty()) return std::nullopt;
    int base = 10;
    if (part.size() >= 2 && part[0] == '0' && (part[1] == 'x' || part[1] == 'X')) {
        part.remove_prefix(2);
        base = 16;
    } else if (part.size() >= 2 && part[0] == '0') {
        part.remove_prefix(1);
        base = 8;
    }
    if (part.empty()) return 0;
    std::uint64_t value = 0;
    for (const char c : part) {
        const int d = hexValue(c);
        if (d < 0 || d >= base) return std::nullopt;
        value = value * base + d;
        if (value > 0xFFFFFFFFFFULL) value = 0xFFFFFFFFFFULL; // заведомо больше допустимого
    }
    return value;
}

std::vector<std::string_view> splitDots(std::string_view text) {
    std::vector<std::string_view> parts;
    std::size_t start = 0;
    while (true) {
        const auto dot = text.find('.', start);
        if (dot == std::string_view::npos) {
            parts.push_back(text.substr(start));
            break;
        }
        parts.push_back(text.substr(start, dot - start));
        start = dot + 1;
    }
    return parts;
}

// Хост, разобранный по WHATWG: IPv4 или имя ASCII. nullopt — ошибка разбора
std::optional<std::string> parseHost(std::string_view raw) {
    if (raw.empty() || raw.front() == '[') return std::nullopt; // IPv6 в записи без точки — отвергнут всё равно
    std::u32string points;
    if (!decodeUtf8(percentDecode(raw), points)) return std::nullopt;
    std::string ascii;
    std::u32string label;
    auto flush = [&] {
        bool plain = true;
        for (const char32_t c : label) plain = plain && c < 0x80;
        if (plain) {
            for (const char32_t c : label) ascii.push_back(static_cast<char>(c));
        } else {
            ascii += "xn--" + punycode(label);
        }
        label.clear();
    };
    for (char32_t c : points) {
        if (c == 0x3002 || c == 0xFF0E || c == 0xFF61) c = '.';
        if (c == '.') {
            flush();
            ascii.push_back('.');
        } else {
            label.push_back(lowerCodePoint(c));
        }
    }
    flush();
    if (ascii.empty()) return std::nullopt;
    for (const char c : ascii) {
        const auto u = static_cast<unsigned char>(c);
        if (u <= 0x20 || u == 0x7F || std::string_view("#%/:<>?@[\\]^|").find(c) != std::string_view::npos) {
            return std::nullopt;
        }
    }
    // Имя, оканчивающееся числом, — адрес IPv4
    auto parts = splitDots(ascii);
    std::string_view last = parts.back();
    if (last.empty() && parts.size() > 1) last = parts[parts.size() - 2];
    const bool allDigits = !last.empty() && std::all_of(last.begin(), last.end(), [](char c) { return c >= '0' && c <= '9'; });
    if (!allDigits && !ipv4Number(last)) return ascii;
    if (parts.back().empty() && parts.size() > 1) parts.pop_back();
    if (parts.size() > 4) return std::nullopt;
    std::vector<std::uint64_t> numbers;
    for (const auto part : parts) {
        const auto number = ipv4Number(part);
        if (!number) return std::nullopt;
        numbers.push_back(*number);
    }
    for (std::size_t i = 0; i + 1 < numbers.size(); ++i) {
        if (numbers[i] > 255) return std::nullopt;
    }
    std::uint64_t limit = 1;
    for (std::size_t i = 0; i < 5 - numbers.size(); ++i) limit *= 256;
    if (numbers.back() >= limit) return std::nullopt;
    std::uint64_t ipv4 = numbers.back();
    for (std::size_t i = 0; i + 1 < numbers.size(); ++i) {
        std::uint64_t weight = 1;
        for (std::size_t k = 0; k < 3 - i; ++k) weight *= 256;
        ipv4 += numbers[i] * weight;
    }
    return std::to_string((ipv4 >> 24) & 255) + "." + std::to_string((ipv4 >> 16) & 255) + "."
        + std::to_string((ipv4 >> 8) & 255) + "." + std::to_string(ipv4 & 255);
}

bool isSingleDot(std::string_view seg) {
    return seg == "." || seg == "%2e" || seg == "%2E";
}

bool isDoubleDot(std::string_view seg) {
    std::string lower(seg);
    for (auto &c : lower) c = static_cast<char>(c >= 'A' && c <= 'Z' ? c + 32 : c);
    return lower == ".." || lower == ".%2e" || lower == "%2e." || lower == "%2e%2e";
}

struct ParsedUrl {
    std::string scheme;
    std::string hostname;
    std::string serialized;
};

// `new URL(text)` для схем http и https; иные схемы — nullopt (вызывающему они всё равно не годятся)
std::optional<ParsedUrl> parseHttpUrl(std::string_view input) {
    // Пробелы и управляющие по краям снимаются, табуляция и переводы строк внутри выбрасываются
    std::string text;
    {
        std::size_t start = 0;
        std::size_t end = input.size();
        while (start < end && static_cast<unsigned char>(input[start]) <= 0x20) ++start;
        while (end > start && static_cast<unsigned char>(input[end - 1]) <= 0x20) --end;
        for (std::size_t i = start; i < end; ++i) {
            if (input[i] != '\t' && input[i] != '\n' && input[i] != '\r') text.push_back(input[i]);
        }
    }
    const auto colon = text.find(':');
    if (colon == std::string::npos) return std::nullopt;
    std::string scheme = text.substr(0, colon);
    for (auto &c : scheme) c = static_cast<char>(c >= 'A' && c <= 'Z' ? c + 32 : c);
    if (scheme != "http" && scheme != "https") return std::nullopt;
    std::string_view rest = std::string_view(text).substr(colon + 1);
    while (!rest.empty() && (rest.front() == '/' || rest.front() == '\\')) rest.remove_prefix(1);

    const auto authorityEnd = rest.find_first_of("/\\?#");
    const std::string_view authority = rest.substr(0, authorityEnd);
    std::string_view tail = authorityEnd == std::string_view::npos ? std::string_view() : rest.substr(authorityEnd);

    std::string credentials;
    std::string_view hostPort = authority;
    const auto at = authority.rfind('@');
    if (at != std::string_view::npos) {
        const std::string_view userinfo = authority.substr(0, at);
        hostPort = authority.substr(at + 1);
        const auto split = userinfo.find(':');
        const std::string user = percentEncode(userinfo.substr(0, split), EncodeSet::Userinfo);
        const std::string pass = split == std::string_view::npos
            ? std::string() : percentEncode(userinfo.substr(split + 1), EncodeSet::Userinfo);
        if (!user.empty() || !pass.empty()) credentials = user + (pass.empty() ? "" : ":" + pass) + "@";
    }
    const auto portAt = hostPort.find(':');
    const std::string_view hostRaw = hostPort.substr(0, portAt);
    std::string port;
    if (portAt != std::string_view::npos) {
        const std::string_view portRaw = hostPort.substr(portAt + 1);
        if (!portRaw.empty()) {
            std::uint64_t value = 0;
            for (const char c : portRaw) {
                if (c < '0' || c > '9') return std::nullopt;
                value = value * 10 + static_cast<std::uint64_t>(c - '0');
                if (value > 65535) return std::nullopt;
            }
            const std::uint64_t defaultPort = scheme == "http" ? 80 : 443;
            if (value != defaultPort) port = ":" + std::to_string(value);
        }
    }
    const auto host = parseHost(hostRaw);
    if (!host) return std::nullopt;

    // Путь, запрос, якорь
    std::string_view pathRaw = tail;
    std::string_view query;
    std::string_view fragment;
    bool hasQuery = false;
    bool hasFragment = false;
    const auto hashAt = tail.find('#');
    if (hashAt != std::string_view::npos) {
        fragment = tail.substr(hashAt + 1);
        hasFragment = true;
        pathRaw = tail.substr(0, hashAt);
    }
    const auto queryAt = pathRaw.find('?');
    if (queryAt != std::string_view::npos) {
        query = pathRaw.substr(queryAt + 1);
        hasQuery = true;
        pathRaw = pathRaw.substr(0, queryAt);
    }
    if (!pathRaw.empty() && (pathRaw.front() == '/' || pathRaw.front() == '\\')) pathRaw.remove_prefix(1);
    std::vector<std::string> segments;
    std::size_t start = 0;
    while (true) {
        const auto slash = pathRaw.find_first_of("/\\", start);
        const bool isLast = slash == std::string_view::npos;
        const std::string_view seg = pathRaw.substr(start, isLast ? std::string_view::npos : slash - start);
        if (isDoubleDot(seg)) {
            if (!segments.empty()) segments.pop_back();
            if (isLast) segments.emplace_back();
        } else if (isSingleDot(seg)) {
            if (isLast) segments.emplace_back();
        } else {
            segments.push_back(percentEncode(seg, EncodeSet::Path));
        }
        if (isLast) break;
        start = slash + 1;
    }
    std::string path;
    for (const auto &seg : segments) path += "/" + seg;

    ParsedUrl url;
    url.scheme = scheme;
    url.hostname = *host;
    url.serialized = scheme + "://" + credentials + *host + port + path;
    if (hasQuery) url.serialized += "?" + percentEncode(query, EncodeSet::Query);
    if (hasFragment) url.serialized += "#" + percentEncode(fragment, EncodeSet::Fragment);
    return url;
}

// `/^[a-z][a-z0-9+.-]*:/i`
bool startsWithScheme(std::string_view text) {
    auto isAlpha = [](char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); };
    if (text.empty() || !isAlpha(text[0])) return false;
    for (std::size_t i = 1; i < text.size(); ++i) {
        const char c = text[i];
        if (c == ':') return true;
        if (!(isAlpha(c) || (c >= '0' && c <= '9') || c == '+' || c == '.' || c == '-')) return false;
    }
    return false;
}

bool startsWithHttp(std::string_view text) {
    std::string head(text.substr(0, 8));
    for (auto &c : head) c = static_cast<char>(c >= 'A' && c <= 'Z' ? c + 32 : c);
    return head.rfind("http://", 0) == 0 || head.rfind("https://", 0) == 0;
}

double snapUp(double value) {
    return std::ceil(value / kCanvasGrid) * kCanvasGrid;
}

bool isApart(const CanvasRect &a, const CanvasRect &b, double clearance) {
    return a.x + a.width + clearance <= b.x || b.x + b.width + clearance <= a.x
        || a.y + a.height + clearance <= b.y || b.y + b.height + clearance <= a.y;
}

std::optional<CanvasPoint> findSpot(const CanvasRect &around, const std::vector<CanvasRect> &taken, double width,
                                    double height, double gap) {
    const double stepX = snapUp((width + gap) / 2);
    const double stepY = snapUp((height + gap) / 2);
    const double baseX = round((around.x + around.width / 2 - width / 2) / kCanvasGrid) * kCanvasGrid;
    const double baseY = round((around.y + around.height / 2 - height / 2) / kCanvasGrid) * kCanvasGrid;
    const double clearance = gap / 2;
    struct Cell {
        int i;
        int j;
        double distance;
    };
    for (int ring = 0; ring <= kSpotMaxRings; ++ring) {
        std::vector<Cell> cells;
        for (int i = -ring; i <= ring; ++i) {
            for (int j = -ring; j <= ring; ++j) {
                if (std::max(std::abs(i), std::abs(j)) != ring) continue;
                cells.push_back({i, j, std::pow(i * stepX, 2) + std::pow(j * stepY, 2)});
            }
        }
        std::stable_sort(cells.begin(), cells.end(), [](const Cell &a, const Cell &b) {
            if (a.distance != b.distance) return a.distance < b.distance;
            if (a.j != b.j) return a.j > b.j;
            return a.i > b.i;
        });
        for (const auto &cell : cells) {
            const CanvasRect rect{baseX + cell.i * stepX, baseY + cell.j * stepY, width, height};
            const bool free = std::all_of(taken.begin(), taken.end(),
                                          [&](const CanvasRect &other) { return isApart(rect, other, clearance); });
            if (free) return CanvasPoint{rect.x, rect.y};
        }
    }
    return std::nullopt;
}

} // namespace

// ── ручки и стороны ──────────────────────────────────────────────────────────

const char *canvasHandleName(CanvasHandle handle) {
    switch (handle) {
    case CanvasHandle::N: return "n";
    case CanvasHandle::NE: return "ne";
    case CanvasHandle::E: return "e";
    case CanvasHandle::SE: return "se";
    case CanvasHandle::S: return "s";
    case CanvasHandle::SW: return "sw";
    case CanvasHandle::W: return "w";
    case CanvasHandle::NW: return "nw";
    }
    return "n";
}

std::optional<CanvasHandle> canvasHandleFromName(std::string_view name) {
    for (const auto handle : kCanvasHandles) {
        if (name == canvasHandleName(handle)) return handle;
    }
    return std::nullopt;
}

bool canvasHandleHas(CanvasHandle handle, char side) {
    return std::string_view(canvasHandleName(handle)).find(side) != std::string_view::npos;
}

CanvasPoint canvasSideNormal(CanvasSide side) {
    switch (side) {
    case CanvasSide::Top: return {0, -1};
    case CanvasSide::Bottom: return {0, 1};
    case CanvasSide::Left: return {-1, 0};
    case CanvasSide::Right: return {1, 0};
    }
    return {0, 0};
}

// ── сетка и размер ───────────────────────────────────────────────────────────

double snapTo(double value, double grid) {
    return grid > 1 ? round(value / grid) * grid : round(value);
}

CanvasDelta snapDelta(CanvasPoint rect, double dx, double dy, double grid) {
    return {snapTo(rect.x + dx, grid) - rect.x, snapTo(rect.y + dy, grid) - rect.y};
}

CanvasSize minSizeOf(std::string_view nodeType) {
    return nodeType == "group" ? kCanvasGroupMin : kCanvasCardMin;
}

CanvasRect resizeRect(const CanvasRect &rect, CanvasHandle handle, double dx, double dy, CanvasSize min,
                      double grid) {
    double left = rect.x;
    double top = rect.y;
    double right = rect.x + rect.width;
    double bottom = rect.y + rect.height;
    if (canvasHandleHas(handle, 'w')) left = std::min(snapTo(left + dx, grid), right - min.width);
    if (canvasHandleHas(handle, 'e')) right = std::max(snapTo(right + dx, grid), left + min.width);
    if (canvasHandleHas(handle, 'n')) top = std::min(snapTo(top + dy, grid), bottom - min.height);
    if (canvasHandleHas(handle, 's')) bottom = std::max(snapTo(bottom + dy, grid), top + min.height);
    return {left, top, right - left, bottom - top};
}

CanvasDoc placeNode(const CanvasDoc &doc, std::string_view id, const CanvasRect &rect) {
    const CanvasNode *node = findNode(doc, id);
    if (!node || isSameRect(rect, node->rect())) return doc;
    CanvasDoc next = doc;
    const auto index = static_cast<std::size_t>(node - doc.nodes.data());
    auto &item = next.nodes[index];
    item.x = rect.x;
    item.y = rect.y;
    item.width = rect.width;
    item.height = rect.height;
    return next;
}

// ── сдвиг и группы ───────────────────────────────────────────────────────────

CanvasDoc moveNodes(const CanvasDoc &doc, const std::vector<std::string> &ids, double dx, double dy) {
    const auto moving = withGroupContent(doc, ids);
    if (moving.empty() || (!dx && !dy)) return doc;
    CanvasDoc next = doc;
    for (auto &node : next.nodes) {
        if (!moving.count(node.id)) continue;
        node.x = round(node.x + dx);
        node.y = round(node.y + dy);
    }
    return next;
}

// Правило рамки: узел, который до правки лежал в группе целиком, а после неё выступил за рамку меньше чем
// наполовину, остаётся в группе — рамка растягивается до него с полем. Выросшая группа так же растягивает ту, в
// которой лежала сама. Сдвинутые узлы — те, чей прямоугольник сменился (в web — сменившийся объект узла)
CanvasDoc growGroups(const CanvasDoc &before, const CanvasDoc &after, double padding) {
    std::vector<const CanvasNode *> groups;
    for (const auto &node : before.nodes) {
        if (node.type == "group") groups.push_back(&node);
    }
    if (groups.empty()) return after;
    std::map<std::string, const CanvasNode *> beforeById;
    for (const auto &node : before.nodes) beforeById.emplace(node.id, &node);
    std::map<std::string, CanvasRect> nowById;
    for (const auto &node : after.nodes) nowById[node.id] = node.rect();
    std::vector<std::string> queue;
    for (const auto &node : after.nodes) {
        const auto was = beforeById.find(node.id);
        if (was != beforeById.end() && !isSameRect(was->second->rect(), node.rect())) queue.push_back(node.id);
    }
    CanvasDoc doc = after;
    std::size_t head = 0;
    const std::size_t limit = before.nodes.size() * groups.size() + 1;
    for (std::size_t step = 0; head < queue.size() && step < limit; ++step) {
        const std::string id = queue[head++];
        const CanvasRect was = beforeById.at(id)->rect();
        for (const auto *group : groups) {
            const auto now = nowById.find(id);
            const auto frame = nowById.find(group->id);
            if (now == nowById.end() || frame == nowById.end() || group->id == id || !isInside(was, group->rect())
                || isInside(now->second, frame->second)) {
                continue;
            }
            if (overlapShare(now->second, frame->second) < kGroupKeepShare) continue;
            const CanvasRect grown = unionRect(frame->second, inflateRect(now->second, padding));
            for (auto &node : doc.nodes) {
                if (node.id != group->id) continue;
                node.x = grown.x;
                node.y = grown.y;
                node.width = grown.width;
                node.height = grown.height;
            }
            nowById[group->id] = grown;
            queue.push_back(group->id);
        }
    }
    return doc;
}

CanvasDoc fitGroupToContent(const CanvasDoc &doc, std::string_view groupId, double padding) {
    const auto bounds = boundsOfRects(rectsOf(nodesInGroup(doc, groupId)));
    if (!bounds) return doc;
    const CanvasRect rect = inflateRect(*bounds, padding);
    CanvasDoc next = doc;
    for (auto &node : next.nodes) {
        if (node.id != groupId || isSameRect(node.rect(), rect)) continue;
        node.x = rect.x;
        node.y = rect.y;
        node.width = rect.width;
        node.height = rect.height;
    }
    return next;
}

CanvasWrapResult wrapInGroup(const CanvasDoc &doc, const std::vector<std::string> &ids, const CanvasMakeId &makeId,
                             double padding) {
    std::vector<CanvasRect> wrapped;
    std::optional<std::size_t> at;
    for (std::size_t i = 0; i < doc.nodes.size(); ++i) {
        if (!has(ids, doc.nodes[i].id)) continue;
        if (!at) at = i;
        wrapped.push_back(doc.nodes[i].rect());
    }
    const auto bounds = boundsOfRects(wrapped);
    // Как в web: id берётся и тогда, когда оборачивать нечего
    const auto id = freeId(doc.nodes, makeId);
    if (!bounds || !id) return {doc, std::nullopt};
    const CanvasRect rect = inflateRect(*bounds, padding);
    CanvasNode group;
    group.id = *id;
    group.type = "group";
    group.x = rect.x;
    group.y = rect.y;
    group.width = rect.width;
    group.height = rect.height;
    CanvasDoc next = doc;
    next.nodes.insert(next.nodes.begin() + static_cast<std::ptrdiff_t>(*at), group);
    return {next, id};
}

// ── выделение ────────────────────────────────────────────────────────────────

bool isSelectionEmpty(const CanvasSelection &selection) {
    return selection.nodes.empty() && selection.edges.empty();
}

CanvasSelection toggleSelected(const CanvasSelection &selection, CanvasSelectionKind kind, const std::string &id) {
    CanvasSelection next = selection;
    auto &list = kind == CanvasSelectionKind::Nodes ? next.nodes : next.edges;
    if (has(list, id)) list.erase(std::remove(list.begin(), list.end(), id), list.end());
    else list.push_back(id);
    return next;
}

CanvasSelection selectAll(const CanvasDoc &doc) {
    CanvasSelection selection;
    for (const auto &node : doc.nodes) selection.nodes.push_back(node.id);
    for (const auto &edge : doc.edges) selection.edges.push_back(edge.id);
    return selection;
}

CanvasSelection pruneSelection(const CanvasDoc &doc, const CanvasSelection &selection) {
    CanvasSelection next;
    for (const auto &id : selection.nodes) {
        if (findNode(doc, id)) next.nodes.push_back(id);
    }
    for (const auto &id : selection.edges) {
        if (findEdge(doc, id)) next.edges.push_back(id);
    }
    if (next.nodes.size() == selection.nodes.size() && next.edges.size() == selection.edges.size()) return selection;
    return next;
}

CanvasRect rectOfPoints(CanvasPoint a, CanvasPoint b) {
    return {std::min(a.x, b.x), std::min(a.y, b.y), std::abs(a.x - b.x), std::abs(a.y - b.y)};
}

std::vector<std::string> nodesInRect(const CanvasDoc &doc, const CanvasRect &rect) {
    std::vector<std::string> ids;
    for (const auto &node : doc.nodes) {
        const bool hit = node.type == "group" ? isInside(node.rect(), rect) : overlapArea(node.rect(), rect) > 0;
        if (hit) ids.push_back(node.id);
    }
    return ids;
}

std::optional<CanvasRect> selectionBounds(const CanvasDoc &doc, const std::vector<std::string> &ids) {
    std::vector<CanvasRect> rects;
    for (const auto &node : doc.nodes) {
        if (has(ids, node.id)) rects.push_back(node.rect());
    }
    return boundsOfRects(rects);
}

CanvasDoc removeSelection(const CanvasDoc &doc, const CanvasSelection &selection) {
    CanvasDoc next = doc;
    next.nodes.clear();
    next.edges.clear();
    for (const auto &node : doc.nodes) {
        if (!has(selection.nodes, node.id)) next.nodes.push_back(node);
    }
    for (const auto &edge : doc.edges) {
        if (!has(selection.edges, edge.id) && !has(selection.nodes, edge.fromNode)
            && !has(selection.nodes, edge.toNode)) {
            next.edges.push_back(edge);
        }
    }
    if (next.nodes.size() == doc.nodes.size() && next.edges.size() == doc.edges.size()) return doc;
    return next;
}

CanvasDoc recolorSelection(const CanvasDoc &doc, const CanvasSelection &selection,
                           const std::optional<std::string> &color) {
    auto paint = [&](auto &items, const std::vector<std::string> &ids) {
        for (auto &item : items) {
            if (!has(ids, item.id)) continue;
            const CanvasJson *current = item.get("color");
            const bool same = color ? (current && current->is_string() && current->template get<std::string>() == *color)
                                    : current == nullptr;
            if (same) continue;
            item.erase("color");
            // Новый цвет встаёт в конец полей, как `{ ...rest, color }`
            if (color && !color->empty()) item.set("color", *color);
        }
    };
    CanvasDoc next = doc;
    paint(next.nodes, selection.nodes);
    paint(next.edges, selection.edges);
    return next;
}

std::optional<std::string> colorOfSelection(const CanvasDoc &doc, const CanvasSelection &selection) {
    std::vector<const CanvasJson *> colors;
    for (const auto &node : doc.nodes) {
        if (has(selection.nodes, node.id)) colors.push_back(node.get("color"));
    }
    for (const auto &edge : doc.edges) {
        if (has(selection.edges, edge.id)) colors.push_back(edge.get("color"));
    }
    if (colors.empty() || !colors[0] || !colors[0]->is_string()) return std::nullopt;
    const std::string first = colors[0]->get<std::string>();
    if (!isCanvasPresetColor(first)) return std::nullopt;
    for (const auto *color : colors) {
        if (!color || !color->is_string() || color->get<std::string>() != first) return std::nullopt;
    }
    return first;
}

// ── копии ────────────────────────────────────────────────────────────────────

CanvasClip copyNodes(const CanvasDoc &doc, const std::vector<std::string> &ids) {
    const auto taken = withGroupContent(doc, ids);
    CanvasClip clip;
    for (const auto &node : doc.nodes) {
        if (taken.count(node.id)) clip.nodes.push_back(node);
    }
    for (const auto &edge : doc.edges) {
        if (taken.count(edge.fromNode) && taken.count(edge.toNode)) clip.edges.push_back(edge);
    }
    return clip;
}

CanvasPasteResult pasteClip(const CanvasDoc &doc, const CanvasClip &clip, double dx, double dy,
                            const CanvasMakeId &makeId) {
    CanvasDoc next = doc;
    // Карта старый id → новый в порядке добавления (как Map в JS)
    std::vector<std::pair<std::string, std::string>> idMap;
    auto mapped = [&](const std::string &old) -> std::optional<std::string> {
        for (const auto &[from, to] : idMap) {
            if (from == old) return to;
        }
        return std::nullopt;
    };
    for (const auto &node : clip.nodes) {
        const auto id = freeId(next.nodes, makeId);
        if (!id) continue;
        bool replaced = false;
        for (auto &entry : idMap) {
            if (entry.first == node.id) { entry.second = *id; replaced = true; }
        }
        if (!replaced) idMap.emplace_back(node.id, *id);
        CanvasNode copy = node;
        copy.id = *id;
        copy.x = round(node.x + dx);
        copy.y = round(node.y + dy);
        next.nodes.push_back(std::move(copy));
    }
    for (const auto &edge : clip.edges) {
        const auto fromNode = mapped(edge.fromNode);
        const auto toNode = mapped(edge.toNode);
        const auto id = freeId(next.edges, makeId);
        if (!fromNode || !toNode || !id) continue;
        CanvasEdge copy = edge;
        copy.id = *id;
        copy.fromNode = *fromNode;
        copy.toNode = *toNode;
        next.edges.push_back(std::move(copy));
    }
    if (idMap.empty()) return {doc, {}};
    std::vector<std::string> ids;
    for (const auto &[from, to] : idMap) ids.push_back(to);
    return {next, ids};
}

std::optional<CanvasRect> clipBounds(const CanvasClip &clip) {
    return boundsOfRects(rectsOf(clip.nodes));
}

std::string serializeClip(const CanvasClip &clip) {
    CanvasDoc doc;
    doc.nodes = clip.nodes;
    doc.edges = clip.edges;
    return serializeCanvas(doc);
}

std::optional<CanvasPasted> parsePasted(std::string_view text) {
    const std::string clean = trim(text);
    if (clean.empty()) return std::nullopt;
    if (clean.front() == '{') {
        auto parsed = parseCanvas(clean);
        if (!parsed.error && !parsed.doc.nodes.empty()) {
            CanvasPasted pasted;
            pasted.kind = CanvasPasted::Kind::Nodes;
            pasted.clip = {std::move(parsed.doc.nodes), std::move(parsed.doc.edges)};
            return pasted;
        }
    }
    const auto url = startsWithHttp(clean) ? normalizeCanvasUrl(clean) : std::nullopt;
    CanvasPasted pasted;
    if (url) {
        pasted.kind = CanvasPasted::Kind::Link;
        pasted.url = *url;
    } else {
        pasted.kind = CanvasPasted::Kind::Text;
        pasted.text = utf16Slice(clean, kPastedTextMax);
    }
    return pasted;
}

// ── слои ─────────────────────────────────────────────────────────────────────

CanvasDoc reorderNodes(const CanvasDoc &doc, const std::vector<std::string> &ids, CanvasLayer place) {
    std::vector<CanvasNode> picked;
    std::vector<CanvasNode> rest;
    for (const auto &node : doc.nodes) (has(ids, node.id) ? picked : rest).push_back(node);
    if (picked.empty()) return doc;
    std::vector<CanvasNode> nodes;
    const auto &first = place == CanvasLayer::Front ? rest : picked;
    const auto &second = place == CanvasLayer::Front ? picked : rest;
    nodes.insert(nodes.end(), first.begin(), first.end());
    nodes.insert(nodes.end(), second.begin(), second.end());
    bool same = true;
    for (std::size_t i = 0; i < nodes.size(); ++i) same = same && nodes[i].id == doc.nodes[i].id;
    if (same) return doc;
    CanvasDoc next = doc;
    next.nodes = std::move(nodes);
    return next;
}

// ── стрелки ──────────────────────────────────────────────────────────────────

CanvasSide oppositeSide(CanvasSide side) {
    switch (side) {
    case CanvasSide::Top: return CanvasSide::Bottom;
    case CanvasSide::Bottom: return CanvasSide::Top;
    case CanvasSide::Left: return CanvasSide::Right;
    case CanvasSide::Right: return CanvasSide::Left;
    }
    return side;
}

CanvasSide nearestSide(const CanvasRect &rect, CanvasPoint point) {
    // Вне прямоугольника расстояние до стороны считается до её отрезка, а не до всей прямой
    const double outX = std::max({rect.x - point.x, 0.0, point.x - (rect.x + rect.width)});
    const double outY = std::max({rect.y - point.y, 0.0, point.y - (rect.y + rect.height)});
    const std::pair<CanvasSide, double> distances[] = {
        {CanvasSide::Top, std::abs(point.y - rect.y) + outX},
        {CanvasSide::Right, std::abs(point.x - (rect.x + rect.width)) + outY},
        {CanvasSide::Bottom, std::abs(point.y - (rect.y + rect.height)) + outX},
        {CanvasSide::Left, std::abs(point.x - rect.x) + outY},
    };
    auto best = distances[0];
    for (const auto &item : distances) {
        if (item.second < best.second) best = item;
    }
    return best.first;
}

const CanvasNode *nodeAtPoint(const CanvasDoc &doc, CanvasPoint point, std::string_view exceptId) {
    for (auto i = doc.nodes.size(); i-- > 0;) {
        const auto &node = doc.nodes[i];
        if (node.type != "group" && (exceptId.empty() || node.id != exceptId)
            && isInside({point.x, point.y, 0, 0}, node.rect())) {
            return &node;
        }
    }
    return nullptr;
}

CanvasDoc connectNodes(const CanvasDoc &doc, const std::string &from, const std::string &to,
                       const CanvasSides &sides, const CanvasMakeId &makeId) {
    const CanvasDoc next = addEdge(doc, from, to, std::nullopt, makeId);
    if (next.edges.size() == doc.edges.size()) return doc;
    CanvasPatch patch;
    if (sides.fromSide) patch.emplace_back("fromSide", CanvasJson(*sides.fromSide));
    if (sides.toSide) patch.emplace_back("toSide", CanvasJson(*sides.toSide));
    return updateEdge(next, next.edges.back().id, patch);
}

std::optional<CanvasCurve> edgeCurve(const CanvasDoc &doc, const CanvasEdge &edge) {
    const CanvasNode *from = findNode(doc, edge.fromNode);
    const CanvasNode *to = findNode(doc, edge.toNode);
    if (!from || !to) return std::nullopt;
    const auto anchors = edgeAnchors(from->rect(), to->rect(), sidesOf(edge));
    return curveBetween(anchors.from, anchors.to);
}

CanvasCurve curveBetween(const CanvasAnchor &p, const CanvasAnchor &q) {
    const double bend = std::max(kEdgeMinBend, std::hypot(q.x - p.x, q.y - p.y) / 3);
    const auto start = canvasSideNormal(p.side);
    const auto end = canvasSideNormal(q.side);
    return {p, {p.x + start.x * bend, p.y + start.y * bend}, {q.x + end.x * bend, q.y + end.y * bend}, q};
}

CanvasPoint curvePoint(const CanvasCurve &curve, double t) {
    const double u = 1 - t;
    const double a = u * u * u;
    const double b = 3 * u * u * t;
    const double c = 3 * u * t * t;
    const double d = t * t * t;
    return {a * curve.p.x + b * curve.c1.x + c * curve.c2.x + d * curve.q.x,
            a * curve.p.y + b * curve.c1.y + c * curve.c2.y + d * curve.q.y};
}

double distanceToCurve(const CanvasCurve &curve, CanvasPoint point) {
    double best = std::numeric_limits<double>::infinity();
    CanvasPoint last = curvePoint(curve, 0);
    for (int i = 1; i <= kEdgeSamples; ++i) {
        const CanvasPoint next = curvePoint(curve, static_cast<double>(i) / kEdgeSamples);
        best = std::min(best, distanceToSegment(point, last, next));
        last = next;
    }
    return best;
}

std::optional<std::string> edgeAt(const CanvasDoc &doc, CanvasPoint point, double tolerance) {
    std::optional<std::string> found;
    double best = tolerance;
    // Карта узлов как в web (`new Map(...)`): при повторе id берётся последний
    std::map<std::string, const CanvasNode *> nodeById;
    for (const auto &node : doc.nodes) nodeById[node.id] = &node;
    for (const auto &edge : doc.edges) {
        const auto from = nodeById.find(edge.fromNode);
        const auto to = nodeById.find(edge.toNode);
        if (from == nodeById.end() || to == nodeById.end()) continue;
        const auto anchors = edgeAnchors(from->second->rect(), to->second->rect(), sidesOf(edge));
        const double distance = distanceToCurve(curveBetween(anchors.from, anchors.to), point);
        if (distance <= best) {
            best = distance;
            found = edge.id;
        }
    }
    return found;
}

CanvasEnds nextEdgeEnds(const CanvasEnds &edge) {
    const bool hasStart = edge.fromEnd == "arrow";
    const bool hasEnd = edge.toEnd != "none";
    if (hasEnd && !hasStart) return {"arrow", std::nullopt};
    if (hasEnd && hasStart) return {std::nullopt, "none"};
    return {};
}

// ── прочее ───────────────────────────────────────────────────────────────────

std::optional<std::string> normalizeCanvasUrl(std::string_view text) {
    const std::string clean = trim(text);
    if (clean.empty() || hasSpace(clean)) return std::nullopt;
    const std::string withScheme = startsWithScheme(clean) ? clean : "https://" + clean;
    const auto url = parseHttpUrl(withScheme);
    if (!url || url->hostname.find('.') == std::string::npos) return std::nullopt;
    return url->serialized;
}

std::optional<CanvasShortcut> canvasShortcut(const CanvasKey &e) {
    if (e.altKey) return std::nullopt;
    if (e.ctrlKey || e.metaKey) {
        if (e.code == "KeyZ") return e.shiftKey ? CanvasShortcut::Redo : CanvasShortcut::Undo;
        if (e.code == "KeyY" && !e.shiftKey) return CanvasShortcut::Redo;
        if (e.shiftKey) return std::nullopt;
        // Копирование и вставка идут событиями буфера обмена, а не клавишами
        if (e.code == "KeyA") return CanvasShortcut::SelectAll;
        if (e.code == "KeyD") return CanvasShortcut::Duplicate;
        return std::nullopt;
    }
    std::optional<CanvasShortcut> action;
    if (e.key == "Delete" || e.key == "Backspace") action = CanvasShortcut::Remove;
    else if (e.key == "Enter" || e.key == "F2") action = CanvasShortcut::Edit;
    else if (e.key == "ArrowLeft") action = CanvasShortcut::Left;
    else if (e.key == "ArrowRight") action = CanvasShortcut::Right;
    else if (e.key == "ArrowUp") action = CanvasShortcut::Up;
    else if (e.key == "ArrowDown") action = CanvasShortcut::Down;
    // Shift меняет только шаг стрелок
    if (e.shiftKey && (action == CanvasShortcut::Remove || action == CanvasShortcut::Edit)) return std::nullopt;
    return action;
}

CanvasPoint findFreeSpot(const CanvasDoc &doc, CanvasPoint center, double width, double height, double gap) {
    std::vector<CanvasRect> taken;
    for (const auto &node : doc.nodes) {
        if (node.type != "group") taken.push_back(node.rect());
    }
    const auto spot = findSpot({center.x, center.y, 0, 0}, taken, width, height, gap);
    return spot ? *spot : CanvasPoint{center.x - width / 2, center.y - height / 2};
}

} // namespace parvane::sections::notes
