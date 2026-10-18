// Parvane fork (spec 029, T063): внешний вид холста — порт чистой части web `notes/notesCanvasLook.tsx`.
#include "parvane/sections/notes_canvas_look.h"

#include "parvane/sections/notes_canvas_edit.h"
#include "parvane/sections/notes_canvas_files.h"

namespace parvane::sections::notes {
namespace {

// Разметка с позиции `at`: длина совпадения (0 — нет). Порядок — как у альтернатив регулярного выражения web
std::size_t markupAt(std::string_view s, std::size_t at, CanvasInlinePart::Kind &kind) {
    const auto rest = s.substr(at);
    // `[[` + хотя бы один знак не `]` и не перевод строки + `]]`
    if (rest.size() >= 5 && rest.substr(0, 2) == "[[") {
        auto i = std::size_t(2);
        while (i < rest.size() && rest[i] != ']' && rest[i] != '\n') ++i;
        if (i > 2 && i + 1 < rest.size() && rest[i] == ']' && rest[i + 1] == ']') {
            kind = CanvasInlinePart::Kind::Link;
            return i + 2;
        }
    }
    if (rest.size() >= 3 && rest[0] == '`') {
        auto i = std::size_t(1);
        while (i < rest.size() && rest[i] != '`' && rest[i] != '\n') ++i;
        if (i > 1 && i < rest.size() && rest[i] == '`') {
            kind = CanvasInlinePart::Kind::Code;
            return i + 1;
        }
    }
    if (rest.size() >= 5 && rest.substr(0, 2) == "**") {
        auto i = std::size_t(2);
        while (i < rest.size() && rest[i] != '*' && rest[i] != '\n') ++i;
        if (i > 2 && i + 1 < rest.size() && rest[i] == '*' && rest[i + 1] == '*') {
            kind = CanvasInlinePart::Kind::Bold;
            return i + 2;
        }
    }
    return 0;
}

std::string linkCaption(std::string_view inner) {
    // `part.slice(2, -2).split('|')`: цель и псевдоним; показывается псевдоним, если он не пуст
    const auto bar = inner.find('|');
    const auto target = inner.substr(0, bar);
    if (bar != std::string_view::npos) {
        auto alias = inner.substr(bar + 1);
        if (const auto next = alias.find('|'); next != std::string_view::npos) alias = alias.substr(0, next);
        if (!alias.empty()) return canvasjs::trim(alias);
    }
    return canvasjs::trim(target);
}

} // namespace

std::vector<CanvasInlinePart> canvasInlineParts(std::string_view line) {
    auto result = std::vector<CanvasInlinePart>();
    auto plainFrom = std::size_t(0);
    auto at = std::size_t(0);
    while (at < line.size()) {
        auto kind = CanvasInlinePart::Kind::Text;
        const auto length = markupAt(line, at, kind);
        if (!length) {
            ++at;
            continue;
        }
        if (at > plainFrom) result.push_back({CanvasInlinePart::Kind::Text, std::string(line.substr(plainFrom, at - plainFrom))});
        const auto part = line.substr(at, length);
        switch (kind) {
        case CanvasInlinePart::Kind::Link:
            result.push_back({kind, linkCaption(part.substr(2, part.size() - 4))});
            break;
        case CanvasInlinePart::Kind::Code:
            result.push_back({kind, std::string(part.substr(1, part.size() - 2))});
            break;
        default:
            result.push_back({kind, std::string(part.substr(2, part.size() - 4))});
        }
        at += length;
        plainFrom = at;
    }
    if (plainFrom < line.size()) result.push_back({CanvasInlinePart::Kind::Text, std::string(line.substr(plainFrom))});
    return result;
}

CanvasArrowHead canvasArrowHead(const CanvasAnchor &anchor) {
    const auto normal = canvasSideNormal(anchor.side);
    const auto baseX = anchor.x + normal.x * kCanvasArrowLength;
    const auto baseY = anchor.y + normal.y * kCanvasArrowLength;
    const auto sideX = normal.y * kCanvasArrowHalfWidth;
    const auto sideY = normal.x * kCanvasArrowHalfWidth;
    return {{anchor.x, anchor.y}, {baseX + sideX, baseY + sideY}, {baseX - sideX, baseY - sideY}};
}

CanvasPoint canvasLineEnd(const CanvasAnchor &anchor, bool hasArrow) {
    const auto normal = canvasSideNormal(anchor.side);
    const auto by = hasArrow ? kCanvasArrowLength - 1 : 0.;
    return {anchor.x + normal.x * by, anchor.y + normal.y * by};
}

CanvasEdgeArrows canvasEdgeArrows(const CanvasEdge &edge) {
    return {edge.str("fromEnd") == std::optional<std::string>("arrow"),
            edge.str("toEnd") != std::optional<std::string>("none")};
}

std::optional<std::string> canvasNodeName(const CanvasNode &node) {
    // `noteTitleOfPath(node.file) || node.label || text.replace(/\*/g, '').slice(0, 24)` — пустые строки ложны
    if (const auto title = noteTitleOfPath(node.str("file")); title && !title->empty()) return title;
    if (const auto label = node.str("label"); label && !label->empty()) return label;
    auto text = node.str("text").value_or(std::string());
    auto plain = std::string();
    plain.reserve(text.size());
    for (const auto c : text) {
        if (c != '*') plain.push_back(c);
    }
    auto sliced = canvasjs::utf16Slice(plain, kCanvasNodeNameMax);
    if (sliced.empty()) return std::nullopt;
    return sliced;
}

} // namespace parvane::sections::notes
