// Parvane fork (spec 029, фаза 4): холст «Знаний» — порт web `notes/notesCanvas.ts`. См. notes_canvas.h.
#include "parvane/sections/notes_canvas.h"

#include <algorithm>
#include <charconv>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <random>
#include <set>

namespace parvane::sections::notes {

namespace {

const std::vector<std::string> kNodeHeadKeys = {"id", "type", "x", "y", "width", "height"};
const std::vector<std::string> kNodeKnownKeys = {
    "id", "type", "x", "y", "width", "height",
    "color", "text", "file", "subpath", "url", "label", "background", "backgroundStyle"};
const std::vector<std::string> kEdgeKnownKeys = {
    "id", "fromNode", "fromSide", "fromEnd", "toNode", "toSide", "toEnd", "color", "label"};
const char kHex[] = "0123456789abcdef";

bool contains(const std::vector<std::string> &list, std::string_view value) {
    return std::find(list.begin(), list.end(), value) != list.end();
}

// ── UTF-8 ────────────────────────────────────────────────────────────────────

// Следующая кодовая точка; битый байт — сам байт (как U+FFFD по длине 1)
char32_t nextCodePoint(std::string_view text, std::size_t &i) {
    const auto c = static_cast<unsigned char>(text[i]);
    auto take = [&](int count, char32_t first) -> char32_t {
        if (i + count >= text.size()) { ++i; return 0xFFFD; }
        char32_t cp = first;
        for (int k = 1; k <= count; ++k) {
            const auto b = static_cast<unsigned char>(text[i + k]);
            if ((b & 0xC0) != 0x80) { ++i; return 0xFFFD; }
            cp = (cp << 6) | (b & 0x3F);
        }
        i += count + 1;
        return cp;
    };
    if (c < 0x80) { ++i; return c; }
    if ((c & 0xE0) == 0xC0) return take(1, c & 0x1F);
    if ((c & 0xF0) == 0xE0) return take(2, c & 0x0F);
    if ((c & 0xF8) == 0xF0) return take(3, c & 0x07);
    ++i;
    return 0xFFFD;
}

std::u16string toUtf16(std::string_view text) {
    std::u16string out;
    std::size_t i = 0;
    while (i < text.size()) {
        const char32_t cp = nextCodePoint(text, i);
        if (cp >= 0x10000) {
            const char32_t v = cp - 0x10000;
            out.push_back(static_cast<char16_t>(0xD800 + (v >> 10)));
            out.push_back(static_cast<char16_t>(0xDC00 + (v & 0x3FF)));
        } else {
            out.push_back(static_cast<char16_t>(cp));
        }
    }
    return out;
}

// ── JSON.stringify ───────────────────────────────────────────────────────────

void appendEscaped(std::string &out, const std::string &text) {
    out.push_back('"');
    for (const char ch : text) {
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
                char buf[8];
                std::snprintf(buf, sizeof buf, "\\u%04x", c);
                out += buf;
            } else {
                out.push_back(ch);
            }
        }
    }
    out.push_back('"');
}

// Ключ-индекс массива JS: "0" либо без ведущего нуля, не больше 2^32 − 2
bool isArrayIndexKey(const std::string &key, std::uint64_t &value) {
    if (key.empty() || key.size() > 10) return false;
    if (key.size() > 1 && key[0] == '0') return false;
    value = 0;
    for (const char c : key) {
        if (c < '0' || c > '9') return false;
        value = value * 10 + static_cast<std::uint64_t>(c - '0');
    }
    return value < 4294967295ULL;
}

double numberOf(const CanvasJson &value) {
    return value.get<double>();
}

void stringifyInto(std::string &out, const CanvasJson &value, std::string_view indent, const std::string &pad) {
    switch (value.type()) {
    case CanvasJson::value_t::null: out += "null"; return;
    case CanvasJson::value_t::boolean: out += value.get<bool>() ? "true" : "false"; return;
    case CanvasJson::value_t::number_integer:
    case CanvasJson::value_t::number_unsigned:
    case CanvasJson::value_t::number_float: {
        const double number = numberOf(value);
        out += std::isfinite(number) ? canvasjs::numberToString(number) : "null";
        return;
    }
    case CanvasJson::value_t::string: appendEscaped(out, value.get_ref<const std::string &>()); return;
    case CanvasJson::value_t::array: {
        if (value.empty()) { out += "[]"; return; }
        const std::string inner = pad + std::string(indent);
        out.push_back('[');
        bool first = true;
        for (const auto &item : value) {
            if (!first) out.push_back(',');
            first = false;
            if (!indent.empty()) { out.push_back('\n'); out += inner; }
            stringifyInto(out, item, indent, inner);
        }
        if (!indent.empty()) { out.push_back('\n'); out += pad; }
        out.push_back(']');
        return;
    }
    case CanvasJson::value_t::object: {
        if (value.empty()) { out += "{}"; return; }
        // Порядок ключей объекта JS: индексы по возрастанию, затем прочие в порядке добавления
        std::vector<std::pair<std::uint64_t, const std::string *>> indexKeys;
        std::vector<const std::string *> otherKeys;
        for (auto it = value.begin(); it != value.end(); ++it) {
            std::uint64_t index = 0;
            if (isArrayIndexKey(it.key(), index)) indexKeys.emplace_back(index, &it.key());
            else otherKeys.push_back(&it.key());
        }
        std::sort(indexKeys.begin(), indexKeys.end(),
                  [](const auto &a, const auto &b) { return a.first < b.first; });
        std::vector<const std::string *> keys;
        for (const auto &[index, key] : indexKeys) keys.push_back(key);
        keys.insert(keys.end(), otherKeys.begin(), otherKeys.end());
        const std::string inner = pad + std::string(indent);
        out.push_back('{');
        bool first = true;
        for (const auto *key : keys) {
            if (!first) out.push_back(',');
            first = false;
            if (!indent.empty()) { out.push_back('\n'); out += inner; }
            appendEscaped(out, *key);
            out += indent.empty() ? ":" : ": ";
            stringifyInto(out, value.at(*key), indent, inner);
        }
        if (!indent.empty()) { out.push_back('\n'); out += pad; }
        out.push_back('}');
        return;
    }
    default: out += "null"; return;
    }
}

// ── разбор ───────────────────────────────────────────────────────────────────

std::optional<std::string> toId(const CanvasJson &value) {
    if (value.is_string()) {
        const auto &text = value.get_ref<const std::string &>();
        if (text.empty()) return std::nullopt;
        return text;
    }
    if (value.is_number()) {
        const double number = numberOf(value);
        if (std::isfinite(number)) return canvasjs::numberToString(number);
    }
    return std::nullopt;
}

double toNumber(const CanvasJson *value, double fallback) {
    if (!value) return fallback;
    if (value->is_number()) {
        const double number = numberOf(*value);
        return std::isfinite(number) ? number : fallback;
    }
    if (value->is_string()) {
        const auto &text = value->get_ref<const std::string &>();
        if (canvasjs::trim(text).empty()) return fallback;
        const auto parsed = canvasjs::stringToNumber(text);
        return parsed && std::isfinite(*parsed) ? *parsed : fallback;
    }
    return fallback;
}

double toSize(const CanvasJson *value, double fallback) {
    const double parsed = toNumber(value, fallback);
    return parsed > 0 ? parsed : fallback;
}

const CanvasJson *field(const CanvasJson &object, const char *key) {
    const auto it = object.find(key);
    return it == object.end() ? nullptr : &*it;
}

// Поля объекта в порядке JS для `orderKeys`: известные по списку, затем прочие по алфавиту (UTF-16)
CanvasJson orderKeys(const CanvasJson &source, const std::vector<std::string> &knownKeys) {
    CanvasJson result = CanvasJson::object();
    for (const auto &key : knownKeys) {
        const auto it = source.find(key);
        if (it != source.end()) result[key] = *it;
    }
    std::vector<std::string> rest;
    for (auto it = source.begin(); it != source.end(); ++it) {
        if (!contains(knownKeys, it.key())) rest.push_back(it.key());
    }
    std::sort(rest.begin(), rest.end(), [](const std::string &a, const std::string &b) {
        return canvasjs::utf16Less(a, b);
    });
    for (const auto &key : rest) result[key] = source.at(key);
    return result;
}

CanvasJson nodeToJson(const CanvasNode &node) {
    CanvasJson out = CanvasJson::object();
    out["id"] = node.id;
    out["type"] = node.type;
    out["x"] = node.x;
    out["y"] = node.y;
    out["width"] = node.width;
    out["height"] = node.height;
    for (auto it = node.fields.begin(); it != node.fields.end(); ++it) {
        if (!contains(kNodeHeadKeys, it.key())) out[it.key()] = it.value();
    }
    return out;
}

CanvasJson edgeToJson(const CanvasEdge &edge) {
    CanvasJson out = CanvasJson::object();
    out["id"] = edge.id;
    out["fromNode"] = edge.fromNode;
    out["toNode"] = edge.toNode;
    for (auto it = edge.fields.begin(); it != edge.fields.end(); ++it) {
        if (it.key() != "id" && it.key() != "fromNode" && it.key() != "toNode") out[it.key()] = it.value();
    }
    return out;
}

bool fieldsEqual(const CanvasJson &a, const CanvasJson &b) {
    return canvasjs::deepEqual(a, b);
}

void setField(CanvasJson &fields, const std::string &key, CanvasJson value) {
    fields[key] = std::move(value);
}

void eraseField(CanvasJson &fields, std::string_view key) {
    const auto it = fields.find(std::string(key));
    if (it != fields.end()) fields.erase(it);
}

std::optional<std::string> strField(const CanvasJson &fields, std::string_view key) {
    const auto it = fields.find(std::string(key));
    if (it == fields.end() || !it->is_string()) return std::nullopt;
    return it->get<std::string>();
}

const CanvasJson *getField(const CanvasJson &fields, std::string_view key) {
    const auto it = fields.find(std::string(key));
    return it == fields.end() ? nullptr : &*it;
}

bool isInside(const CanvasRect &inner, const CanvasRect &outer) {
    return inner.x >= outer.x && inner.y >= outer.y
        && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
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
    }
    for (const auto &r : rects) {
        right = std::max(right, r.x + r.width);
        bottom = std::max(bottom, r.y + r.height);
    }
    return CanvasRect{x, y, right - x, bottom - y};
}

CanvasSide sideToward(const CanvasRect &from, const CanvasRect &to) {
    const double dx = (to.x + to.width / 2) - (from.x + from.width / 2);
    const double dy = (to.y + to.height / 2) - (from.y + from.height / 2);
    // Сравнение с диагональю прямоугольника: луч к центру соседа выходит через эту сторону
    if (std::abs(dx) * from.height > std::abs(dy) * from.width) return dx > 0 ? CanvasSide::Right : CanvasSide::Left;
    return dy >= 0 ? CanvasSide::Bottom : CanvasSide::Top;
}

// Математика JS: «нет значения» в Math.min — Infinity
double jsMin3(double a, double b, double c) {
    if (std::isnan(a) || std::isnan(b) || std::isnan(c)) return std::numeric_limits<double>::quiet_NaN();
    return std::min({a, b, c});
}

} // namespace

// ── стороны ──────────────────────────────────────────────────────────────────

const char *canvasSideName(CanvasSide side) {
    switch (side) {
    case CanvasSide::Top: return "top";
    case CanvasSide::Right: return "right";
    case CanvasSide::Bottom: return "bottom";
    case CanvasSide::Left: return "left";
    }
    return "top";
}

std::optional<CanvasSide> canvasSideFromName(std::string_view name) {
    if (name == "top") return CanvasSide::Top;
    if (name == "right") return CanvasSide::Right;
    if (name == "bottom") return CanvasSide::Bottom;
    if (name == "left") return CanvasSide::Left;
    return std::nullopt;
}

// ── узлы и связи ─────────────────────────────────────────────────────────────

bool CanvasNode::has(std::string_view key) const { return getField(fields, key) != nullptr; }
std::optional<std::string> CanvasNode::str(std::string_view key) const { return strField(fields, key); }
const CanvasJson *CanvasNode::get(std::string_view key) const { return getField(fields, key); }
void CanvasNode::set(const std::string &key, CanvasJson value) { setField(fields, key, std::move(value)); }
void CanvasNode::erase(std::string_view key) { eraseField(fields, key); }
bool CanvasNode::operator==(const CanvasNode &other) const {
    return id == other.id && type == other.type && x == other.x && y == other.y && width == other.width
        && height == other.height && fieldsEqual(fields, other.fields);
}

bool CanvasEdge::has(std::string_view key) const { return getField(fields, key) != nullptr; }
std::optional<std::string> CanvasEdge::str(std::string_view key) const { return strField(fields, key); }
const CanvasJson *CanvasEdge::get(std::string_view key) const { return getField(fields, key); }
void CanvasEdge::set(const std::string &key, CanvasJson value) { setField(fields, key, std::move(value)); }
void CanvasEdge::erase(std::string_view key) { eraseField(fields, key); }
bool CanvasEdge::operator==(const CanvasEdge &other) const {
    return id == other.id && fromNode == other.fromNode && toNode == other.toNode
        && fieldsEqual(fields, other.fields);
}

bool CanvasDoc::operator==(const CanvasDoc &other) const {
    return nodes == other.nodes && edges == other.edges && fieldsEqual(extra, other.extra);
}

bool isCanvasNodeType(std::string_view type) { return contains(kCanvasNodeTypes, type); }

bool isCanvasPresetColor(const std::optional<std::string> &color) {
    return color && contains(kCanvasPresetColors, *color);
}

CanvasDoc createEmptyCanvas() { return {}; }

std::string newCanvasId(const CanvasRandom &random) {
    static thread_local std::mt19937_64 engine{std::random_device{}()};
    std::uniform_real_distribution<double> uniform(0.0, 1.0);
    std::string id;
    for (int i = 0; i < 16; ++i) {
        const double r = random ? random() : uniform(engine);
        const double index = std::min(15.0, std::max(0.0, std::floor(r * 16)));
        id += kHex[std::isnan(index) ? 0 : static_cast<int>(index)];
    }
    return id;
}

// ── разбор и запись ──────────────────────────────────────────────────────────

CanvasParseResult parseCanvas(std::string_view text) {
    CanvasParseResult result;
    if (canvasjs::trim(text).empty()) return result;

    CanvasJson raw = CanvasJson::parse(text.begin(), text.end(), nullptr, false);
    if (raw.is_discarded()) {
        result.error = CanvasParseError::Json;
        return result;
    }
    if (!raw.is_object()) {
        result.error = CanvasParseError::Shape;
        return result;
    }
    const CanvasJson empty = CanvasJson::array();
    const CanvasJson *rawNodes = field(raw, "nodes");
    const CanvasJson *rawEdges = field(raw, "edges");
    if (!rawNodes) rawNodes = &empty;
    if (!rawEdges) rawEdges = &empty;
    if (!rawNodes->is_array() || !rawEdges->is_array()) {
        result.error = CanvasParseError::Shape;
        return result;
    }

    CanvasDoc doc;
    std::set<std::string> nodeIds;
    for (const auto &item : *rawNodes) {
        const CanvasJson *idValue = item.is_object() ? field(item, "id") : nullptr;
        const auto id = idValue ? toId(*idValue) : std::nullopt;
        const CanvasJson *typeValue = item.is_object() ? field(item, "type") : nullptr;
        if (!item.is_object() || !id || !typeValue || !typeValue->is_string()
            || typeValue->get_ref<const std::string &>().empty() || nodeIds.count(*id)) {
            ++result.dropped.nodes;
            continue;
        }
        nodeIds.insert(*id);
        CanvasNode node;
        node.id = *id;
        node.type = typeValue->get<std::string>();
        node.x = toNumber(field(item, "x"), 0);
        node.y = toNumber(field(item, "y"), 0);
        node.width = toSize(field(item, "width"), kCanvasDefaultNodeWidth);
        node.height = toSize(field(item, "height"), kCanvasDefaultNodeHeight);
        for (auto it = item.begin(); it != item.end(); ++it) {
            if (!contains(kNodeHeadKeys, it.key())) node.fields[it.key()] = it.value();
        }
        doc.nodes.push_back(std::move(node));
    }

    std::set<std::string> edgeIds;
    for (const auto &item : *rawEdges) {
        const bool isObject = item.is_object();
        const CanvasJson *idValue = isObject ? field(item, "id") : nullptr;
        const CanvasJson *fromValue = isObject ? field(item, "fromNode") : nullptr;
        const CanvasJson *toValue = isObject ? field(item, "toNode") : nullptr;
        const auto id = idValue ? toId(*idValue) : std::nullopt;
        const auto fromNode = fromValue ? toId(*fromValue) : std::nullopt;
        const auto toNode = toValue ? toId(*toValue) : std::nullopt;
        if (!isObject || !id || !fromNode || !toNode || edgeIds.count(*id)) {
            ++result.dropped.edges;
            continue;
        }
        edgeIds.insert(*id);
        CanvasEdge edge;
        edge.id = *id;
        edge.fromNode = *fromNode;
        edge.toNode = *toNode;
        for (auto it = item.begin(); it != item.end(); ++it) {
            if (it.key() != "id" && it.key() != "fromNode" && it.key() != "toNode") edge.fields[it.key()] = it.value();
        }
        doc.edges.push_back(std::move(edge));
    }

    for (auto it = raw.begin(); it != raw.end(); ++it) {
        if (it.key() != "nodes" && it.key() != "edges") doc.extra[it.key()] = it.value();
    }
    result.doc = std::move(doc);
    return result;
}

std::string serializeCanvas(const CanvasDoc &doc) {
    CanvasJson out = CanvasJson::object();
    CanvasJson nodes = CanvasJson::array();
    for (const auto &node : doc.nodes) nodes.push_back(orderKeys(nodeToJson(node), kNodeKnownKeys));
    CanvasJson edges = CanvasJson::array();
    for (const auto &edge : doc.edges) edges.push_back(orderKeys(edgeToJson(edge), kEdgeKnownKeys));
    out["nodes"] = std::move(nodes);
    out["edges"] = std::move(edges);
    std::vector<std::string> keys;
    for (auto it = doc.extra.begin(); it != doc.extra.end(); ++it) {
        if (it.key() != "nodes" && it.key() != "edges") keys.push_back(it.key());
    }
    std::sort(keys.begin(), keys.end(), [](const std::string &a, const std::string &b) {
        return canvasjs::utf16Less(a, b);
    });
    for (const auto &key : keys) out[key] = doc.extra.at(key);
    return canvasjs::stringify(out, "\t");
}

// ── правки ───────────────────────────────────────────────────────────────────

const CanvasNode *findNode(const CanvasDoc &doc, std::string_view id) {
    for (const auto &node : doc.nodes) {
        if (node.id == id) return &node;
    }
    return nullptr;
}

const CanvasEdge *findEdge(const CanvasDoc &doc, std::string_view id) {
    for (const auto &edge : doc.edges) {
        if (edge.id == id) return &edge;
    }
    return nullptr;
}

CanvasDoc addNode(const CanvasDoc &doc, const CanvasNode &node) {
    if (node.id.empty() || findNode(doc, node.id)) return doc;
    CanvasDoc next = doc;
    next.nodes.push_back(node);
    return next;
}

namespace {

void applyNodePatch(CanvasNode &node, const CanvasPatch &patch) {
    for (const auto &[key, value] : patch) {
        if (key == "id") continue;
        if (key == "x" || key == "y" || key == "width" || key == "height") {
            if (!value || !value->is_number()) continue;
            double &slot = key == "x" ? node.x : key == "y" ? node.y : key == "width" ? node.width : node.height;
            slot = numberOf(*value);
            continue;
        }
        if (key == "type") {
            if (value && value->is_string()) node.type = value->get<std::string>();
            continue;
        }
        if (value) node.set(key, *value);
        else node.erase(key);
    }
}

} // namespace

CanvasDoc updateNode(const CanvasDoc &doc, std::string_view id, const CanvasPatch &patch) {
    if (!findNode(doc, id)) return doc;
    CanvasDoc next = doc;
    for (auto &node : next.nodes) {
        if (node.id == id) applyNodePatch(node, patch);
    }
    return next;
}

CanvasDoc removeNode(const CanvasDoc &doc, std::string_view id) {
    if (!findNode(doc, id)) return doc;
    CanvasDoc next = doc;
    next.nodes.clear();
    next.edges.clear();
    for (const auto &node : doc.nodes) {
        if (node.id != id) next.nodes.push_back(node);
    }
    for (const auto &edge : doc.edges) {
        if (edge.fromNode != id && edge.toNode != id) next.edges.push_back(edge);
    }
    return next;
}

CanvasDoc addEdge(const CanvasDoc &doc, const std::string &from, const std::string &to,
                  const std::optional<std::string> &label, const CanvasMakeId &makeId) {
    if (from == to || !findNode(doc, from) || !findNode(doc, to)) return doc;
    for (const auto &edge : doc.edges) {
        if (edge.fromNode == from && edge.toNode == to) return doc;
    }
    auto make = [&] { return makeId ? makeId() : newCanvasId(); };
    std::string id = make();
    for (int attempt = 0; attempt < 8 && findEdge(doc, id); ++attempt) id = make();
    if (id.empty() || findEdge(doc, id)) return doc;
    CanvasEdge edge;
    edge.id = id;
    edge.fromNode = from;
    edge.toNode = to;
    if (label && !label->empty()) edge.set("label", *label);
    CanvasDoc next = doc;
    next.edges.push_back(std::move(edge));
    return next;
}

CanvasDoc updateEdge(const CanvasDoc &doc, std::string_view id, const CanvasPatch &patch) {
    if (!findEdge(doc, id)) return doc;
    CanvasDoc next = doc;
    for (auto &edge : next.edges) {
        if (edge.id != id) continue;
        for (const auto &[key, value] : patch) {
            if (key == "id" || key == "fromNode" || key == "toNode") continue;
            if (value) edge.set(key, *value);
            else edge.erase(key);
        }
        const auto *label = edge.get("label");
        if (label && label->is_string() && label->get_ref<const std::string &>().empty()) edge.erase("label");
    }
    return next;
}

CanvasDoc removeEdge(const CanvasDoc &doc, std::string_view id) {
    if (!findEdge(doc, id)) return doc;
    CanvasDoc next = doc;
    next.edges.clear();
    for (const auto &edge : doc.edges) {
        if (edge.id != id) next.edges.push_back(edge);
    }
    return next;
}

std::vector<CanvasNode> nodesInGroup(const CanvasDoc &doc, std::string_view groupId) {
    const CanvasNode *group = findNode(doc, groupId);
    if (!group || group->type != "group") return {};
    std::vector<CanvasNode> result;
    for (const auto &node : doc.nodes) {
        if (&node != group && isInside(node.rect(), group->rect())) result.push_back(node);
    }
    return result;
}

CanvasDoc moveNode(const CanvasDoc &doc, std::string_view id, double dx, double dy) {
    if (!findNode(doc, id) || (!dx && !dy)) return doc;
    std::set<std::string> moving = {std::string(id)};
    for (const auto &node : nodesInGroup(doc, id)) moving.insert(node.id);
    CanvasDoc next = doc;
    for (auto &node : next.nodes) {
        if (!moving.count(node.id)) continue;
        node.x = canvasjs::round(node.x + dx);
        node.y = canvasjs::round(node.y + dy);
    }
    return next;
}

// ── геометрия ────────────────────────────────────────────────────────────────

std::optional<CanvasRect> boundsOf(const CanvasDoc &doc) {
    std::vector<CanvasRect> rects;
    for (const auto &node : doc.nodes) rects.push_back(node.rect());
    return boundsOfRects(rects);
}

double clampCanvasScale(double scale) {
    return std::min(kCanvasMaxScale, std::max(kCanvasMinScale, scale));
}

CanvasView fitView(const std::optional<CanvasRect> &bounds, CanvasViewport viewport, double padding) {
    if (!bounds) return {1, viewport.width / 2, viewport.height / 2};
    const double inf = std::numeric_limits<double>::infinity();
    const double roomX = std::max(1.0, viewport.width - padding * 2);
    const double roomY = std::max(1.0, viewport.height - padding * 2);
    const double scale = clampCanvasScale(jsMin3(
        bounds->width > 0 ? roomX / bounds->width : inf,
        bounds->height > 0 ? roomY / bounds->height : inf,
        kCanvasFitMaxScale));
    return {
        scale,
        viewport.width / 2 - (bounds->x + bounds->width / 2) * scale,
        viewport.height / 2 - (bounds->y + bounds->height / 2) * scale,
    };
}

CanvasView firstGroupView(const CanvasDoc &doc, CanvasViewport viewport, double padding) {
    for (const auto &node : doc.nodes) {
        if (node.type == "group") return fitView(boundsOfRects({node.rect()}), viewport, padding);
    }
    return fitView(boundsOf(doc), viewport, padding);
}

CanvasPoint sidePoint(const CanvasRect &rect, CanvasSide side) {
    switch (side) {
    case CanvasSide::Top: return {rect.x + rect.width / 2, rect.y};
    case CanvasSide::Bottom: return {rect.x + rect.width / 2, rect.y + rect.height};
    case CanvasSide::Left: return {rect.x, rect.y + rect.height / 2};
    default: return {rect.x + rect.width, rect.y + rect.height / 2};
    }
}

CanvasSides sidesOf(const CanvasEdge &edge) {
    return {edge.str("fromSide"), edge.str("toSide")};
}

CanvasAnchors edgeAnchors(const CanvasRect &fromNode, const CanvasRect &toNode, const CanvasSides &sides) {
    auto pick = [](const std::optional<std::string> &side, CanvasSide fallback) {
        const auto known = side ? canvasSideFromName(*side) : std::nullopt;
        return known ? *known : fallback;
    };
    const CanvasSide fromSide = pick(sides.fromSide, sideToward(fromNode, toNode));
    const CanvasSide toSide = pick(sides.toSide, sideToward(toNode, fromNode));
    const auto p = sidePoint(fromNode, fromSide);
    const auto q = sidePoint(toNode, toSide);
    return {{p.x, p.y, fromSide}, {q.x, q.y, toSide}};
}

// ── поведение JS ─────────────────────────────────────────────────────────────

namespace canvasjs {

double round(double value) {
    if (!std::isfinite(value)) return value;
    const double floor = std::floor(value);
    double result = value - floor >= 0.5 ? floor + 1 : floor;
    // Math.round(-0.4) — это -0; для записи и сравнения разницы нет, но держим как в JS
    if (result == 0 && std::signbit(value)) result = -0.0;
    return result;
}

std::string numberToString(double value) {
    if (std::isnan(value)) return "NaN";
    if (std::isinf(value)) return value > 0 ? "Infinity" : "-Infinity";
    if (value == 0) return "0";
    std::string out;
    if (value < 0) {
        out.push_back('-');
        value = -value;
    }
    // Кратчайшие цифры, которые читаются обратно тем же числом
    char buf[64];
    const auto res = std::to_chars(buf, buf + sizeof buf, value, std::chars_format::scientific);
    const std::string sci(buf, res.ptr);
    const auto ePos = sci.find('e');
    std::string digits;
    for (std::size_t i = 0; i < ePos; ++i) {
        if (sci[i] != '.') digits.push_back(sci[i]);
    }
    const int exponent = std::atoi(sci.c_str() + ePos + 1);
    const int k = static_cast<int>(digits.size());
    const int n = exponent + 1;
    if (k <= n && n <= 21) {
        out += digits + std::string(static_cast<std::size_t>(n - k), '0');
    } else if (0 < n && n <= 21) {
        out += digits.substr(0, static_cast<std::size_t>(n)) + "." + digits.substr(static_cast<std::size_t>(n));
    } else if (-6 < n && n <= 0) {
        out += "0." + std::string(static_cast<std::size_t>(-n), '0') + digits;
    } else {
        out += digits.substr(0, 1);
        if (k > 1) out += "." + digits.substr(1);
        out += "e";
        out += n - 1 >= 0 ? "+" : "-";
        out += std::to_string(std::abs(n - 1));
    }
    return out;
}

std::string stringify(const CanvasJson &value, std::string_view indent) {
    std::string out;
    stringifyInto(out, value, indent, "");
    return out;
}

bool deepEqual(const CanvasJson &a, const CanvasJson &b) {
    if (a.is_number() && b.is_number()) return numberOf(a) == numberOf(b);
    if (a.type() != b.type()) return false;
    if (a.is_object()) {
        if (a.size() != b.size()) return false;
        for (auto it = a.begin(); it != a.end(); ++it) {
            const auto other = b.find(it.key());
            if (other == b.end() || !deepEqual(it.value(), *other)) return false;
        }
        return true;
    }
    if (a.is_array()) {
        if (a.size() != b.size()) return false;
        for (std::size_t i = 0; i < a.size(); ++i) {
            if (!deepEqual(a[i], b[i])) return false;
        }
        return true;
    }
    return a == b;
}

bool utf16Less(std::string_view a, std::string_view b) {
    return toUtf16(a) < toUtf16(b);
}

bool isSpace(char32_t c) {
    switch (c) {
    case 0x09: case 0x0A: case 0x0B: case 0x0C: case 0x0D: case 0x20: case 0xA0: case 0x1680:
    case 0x2028: case 0x2029: case 0x202F: case 0x205F: case 0x3000: case 0xFEFF:
        return true;
    default:
        return c >= 0x2000 && c <= 0x200A;
    }
}

std::string trim(std::string_view text) {
    std::size_t start = 0;
    std::size_t end = 0;
    bool seen = false;
    std::size_t i = 0;
    while (i < text.size()) {
        const std::size_t at = i;
        const char32_t cp = nextCodePoint(text, i);
        if (!isSpace(cp)) {
            if (!seen) { start = at; seen = true; }
            end = i;
        }
    }
    return seen ? std::string(text.substr(start, end - start)) : std::string();
}

bool hasSpace(std::string_view text) {
    std::size_t i = 0;
    while (i < text.size()) {
        if (isSpace(nextCodePoint(text, i))) return true;
    }
    return false;
}

std::size_t utf16Length(std::string_view text) {
    std::size_t units = 0;
    std::size_t i = 0;
    while (i < text.size()) units += nextCodePoint(text, i) >= 0x10000 ? 2 : 1;
    return units;
}

std::string utf16Slice(std::string_view text, std::size_t units) {
    std::size_t taken = 0;
    std::size_t i = 0;
    while (i < text.size()) {
        std::size_t next = i;
        const std::size_t size = nextCodePoint(text, next) >= 0x10000 ? 2 : 1;
        if (taken + size > units) break;
        taken += size;
        i = next;
    }
    return std::string(text.substr(0, i));
}

std::optional<double> stringToNumber(std::string_view raw) {
    const std::string text = trim(raw);
    if (text.empty()) return 0.0;
    if (text == "Infinity" || text == "+Infinity") return std::numeric_limits<double>::infinity();
    if (text == "-Infinity") return -std::numeric_limits<double>::infinity();
    // 0x…, 0o…, 0b… (без знака)
    if (text.size() > 2 && text[0] == '0') {
        const char kind = static_cast<char>(text[1] | 0x20);
        const int base = kind == 'x' ? 16 : kind == 'o' ? 8 : kind == 'b' ? 2 : 0;
        if (base) {
            double value = 0;
            for (std::size_t i = 2; i < text.size(); ++i) {
                const char c = static_cast<char>(text[i] | 0x20);
                int digit = -1;
                if (c >= '0' && c <= '9') digit = c - '0';
                else if (c >= 'a' && c <= 'f') digit = c - 'a' + 10;
                if (digit < 0 || digit >= base) return std::nullopt;
                value = value * base + digit;
            }
            return value;
        }
    }
    // Десятичная запись: [+-] (цифры [. цифры] | . цифры) [e [+-] цифры]
    std::size_t i = 0;
    if (text[i] == '+' || text[i] == '-') ++i;
    std::size_t intDigits = 0;
    while (i < text.size() && text[i] >= '0' && text[i] <= '9') { ++i; ++intDigits; }
    std::size_t fracDigits = 0;
    if (i < text.size() && text[i] == '.') {
        ++i;
        while (i < text.size() && text[i] >= '0' && text[i] <= '9') { ++i; ++fracDigits; }
    }
    if (!intDigits && !fracDigits) return std::nullopt;
    if (i < text.size() && (text[i] == 'e' || text[i] == 'E')) {
        ++i;
        if (i < text.size() && (text[i] == '+' || text[i] == '-')) ++i;
        std::size_t expDigits = 0;
        while (i < text.size() && text[i] >= '0' && text[i] <= '9') { ++i; ++expDigits; }
        if (!expDigits) return std::nullopt;
    }
    if (i != text.size()) return std::nullopt;
    return std::strtod(text.c_str(), nullptr);
}

} // namespace canvasjs

} // namespace parvane::sections::notes
