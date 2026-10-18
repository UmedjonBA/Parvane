// Parvane fork (spec 029, фаза 4): выравнивание на холсте — порт web `notes/notesCanvasAlign.ts`.
#include "parvane/sections/notes_canvas_align.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <optional>
#include <set>

namespace parvane::sections::notes {

namespace {

constexpr double kSame = 0.5;

// `x || 0` в JS: -0 становится 0
double orZero(const std::optional<double> &value) {
    return value && *value != 0 ? *value : 0.0;
}

// Начало, середина и конец прямоугольника вдоль оси
std::array<double, 3> linesOf(const CanvasRect &rect, CanvasAxis axis) {
    const double start = axis == CanvasAxis::X ? rect.x : rect.y;
    const double size = axis == CanvasAxis::X ? rect.width : rect.height;
    return {start, start + size / 2, start + size};
}

std::vector<double> allLines(const std::vector<CanvasRect> &rects, CanvasAxis axis) {
    std::vector<double> lines;
    for (const auto &rect : rects) {
        const auto l = linesOf(rect, axis);
        lines.insert(lines.end(), l.begin(), l.end());
    }
    return lines;
}

std::optional<double> nearestShift(const std::vector<double> &lines, const std::vector<double> &targets,
                                   double tolerance) {
    std::optional<double> best;
    for (const double line : lines) {
        for (const double target : targets) {
            const double shift = target - line;
            if (std::abs(shift) <= tolerance && (!best || std::abs(shift) < std::abs(*best))) best = shift;
        }
    }
    return best;
}

// Линии через `lines` прямоугольника `rect`, на которых лежит край либо середина хотя бы одного соседа
std::vector<CanvasGuide> guidesOf(const CanvasRect &rect, const std::vector<CanvasRect> &others, CanvasAxis axis,
                                  const std::vector<double> &lines) {
    const CanvasAxis cross = axis == CanvasAxis::X ? CanvasAxis::Y : CanvasAxis::X;
    std::vector<CanvasGuide> guides;
    for (const double at : lines) {
        std::vector<CanvasRect> matched;
        for (const auto &other : others) {
            const auto l = linesOf(other, axis);
            if (std::any_of(l.begin(), l.end(), [&](double line) { return std::abs(line - at) < kSame; })) {
                matched.push_back(other);
            }
        }
        const bool seen = std::any_of(guides.begin(), guides.end(),
                                      [&](const CanvasGuide &guide) { return std::abs(guide.at - at) < kSame; });
        if (matched.empty() || seen) continue;
        double from = linesOf(rect, cross)[0];
        double to = linesOf(rect, cross)[2];
        for (const auto &item : matched) {
            from = std::min(from, linesOf(item, cross)[0]);
            to = std::max(to, linesOf(item, cross)[2]);
        }
        guides.push_back({axis, at, from, to});
    }
    return guides;
}

CanvasRect boundsOf(const std::vector<CanvasRect> &rects) {
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
    return {x, y, right - x, bottom - y};
}

// Выделенные узлы без тех, что лежат внутри выделенной же группы
std::vector<CanvasNode> topItems(const CanvasDoc &doc, const std::vector<std::string> &ids) {
    std::set<std::string> nested;
    for (const auto &id : ids) {
        for (const auto &node : nodesInGroup(doc, id)) nested.insert(node.id);
    }
    std::vector<CanvasNode> items;
    for (const auto &id : ids) {
        if (nested.count(id)) continue;
        if (const auto *node = findNode(doc, id)) items.push_back(*node);
    }
    return items;
}

} // namespace

CanvasSnap snapToNeighbours(const CanvasRect &moving, const std::vector<CanvasRect> &others, double tolerance) {
    const auto movingX = linesOf(moving, CanvasAxis::X);
    const auto movingY = linesOf(moving, CanvasAxis::Y);
    const auto dx = nearestShift({movingX.begin(), movingX.end()}, allLines(others, CanvasAxis::X), tolerance);
    const auto dy = nearestShift({movingY.begin(), movingY.end()}, allLines(others, CanvasAxis::Y), tolerance);
    CanvasRect placed = moving;
    placed.x = moving.x + orZero(dx);
    placed.y = moving.y + orZero(dy);
    CanvasSnap snap{orZero(dx), orZero(dy), {}};
    if (dx) {
        const auto l = linesOf(placed, CanvasAxis::X);
        const auto g = guidesOf(placed, others, CanvasAxis::X, {l.begin(), l.end()});
        snap.guides.insert(snap.guides.end(), g.begin(), g.end());
    }
    if (dy) {
        const auto l = linesOf(placed, CanvasAxis::Y);
        const auto g = guidesOf(placed, others, CanvasAxis::Y, {l.begin(), l.end()});
        snap.guides.insert(snap.guides.end(), g.begin(), g.end());
    }
    return snap;
}

CanvasResizeSnap snapResize(const CanvasRect &rect, CanvasHandle handle, const std::vector<CanvasRect> &others,
                            double tolerance, CanvasSize min) {
    double left = rect.x;
    double top = rect.y;
    double right = rect.x + rect.width;
    double bottom = rect.y + rect.height;
    const auto xTargets = allLines(others, CanvasAxis::X);
    const auto yTargets = allLines(others, CanvasAxis::Y);
    auto shift = [&](double value, CanvasAxis axis) {
        return orZero(nearestShift({value}, axis == CanvasAxis::X ? xTargets : yTargets, tolerance));
    };
    if (canvasHandleHas(handle, 'w') && right - (left + shift(left, CanvasAxis::X)) >= min.width) {
        left += shift(left, CanvasAxis::X);
    }
    if (canvasHandleHas(handle, 'e') && right + shift(right, CanvasAxis::X) - left >= min.width) {
        right += shift(right, CanvasAxis::X);
    }
    if (canvasHandleHas(handle, 'n') && bottom - (top + shift(top, CanvasAxis::Y)) >= min.height) {
        top += shift(top, CanvasAxis::Y);
    }
    if (canvasHandleHas(handle, 's') && bottom + shift(bottom, CanvasAxis::Y) - top >= min.height) {
        bottom += shift(bottom, CanvasAxis::Y);
    }
    const CanvasRect next{left, top, right - left, bottom - top};
    std::vector<double> xLines;
    std::vector<double> yLines;
    if (canvasHandleHas(handle, 'w')) xLines.push_back(left);
    if (canvasHandleHas(handle, 'e')) xLines.push_back(right);
    if (canvasHandleHas(handle, 'n')) yLines.push_back(top);
    if (canvasHandleHas(handle, 's')) yLines.push_back(bottom);
    CanvasResizeSnap result{next, guidesOf(next, others, CanvasAxis::X, xLines)};
    const auto g = guidesOf(next, others, CanvasAxis::Y, yLines);
    result.guides.insert(result.guides.end(), g.begin(), g.end());
    return result;
}

CanvasDoc alignNodes(const CanvasDoc &doc, const std::vector<std::string> &ids, CanvasAlign align) {
    const auto items = topItems(doc, ids);
    if (items.size() < 2) return doc;
    const CanvasAxis axis = align == CanvasAlign::Left || align == CanvasAlign::Center || align == CanvasAlign::Right
        ? CanvasAxis::X : CanvasAxis::Y;
    const int index = align == CanvasAlign::Left || align == CanvasAlign::Top ? 0
        : align == CanvasAlign::Center || align == CanvasAlign::Middle ? 1 : 2;
    std::vector<CanvasRect> rects;
    for (const auto &item : items) rects.push_back(item.rect());
    const double target = linesOf(boundsOf(rects), axis)[index];
    CanvasDoc next = doc;
    for (const auto &item : items) {
        const double shift = target - linesOf(item.rect(), axis)[index];
        next = moveNodes(next, {item.id}, axis == CanvasAxis::X ? shift : 0, axis == CanvasAxis::Y ? shift : 0);
    }
    return next;
}

CanvasDoc distributeNodes(const CanvasDoc &doc, const std::vector<std::string> &ids, CanvasAxis axis) {
    auto items = topItems(doc, ids);
    auto start = [axis](const CanvasNode &n) { return axis == CanvasAxis::X ? n.x : n.y; };
    auto size = [axis](const CanvasNode &n) { return axis == CanvasAxis::X ? n.width : n.height; };
    std::stable_sort(items.begin(), items.end(), [&](const CanvasNode &a, const CanvasNode &b) {
        return (start(a) + size(a) / 2) < (start(b) + size(b) / 2);
    });
    if (items.size() < 3) return doc;
    const auto &first = items.front();
    const auto &last = items.back();
    double total = 0;
    for (const auto &item : items) total += size(item);
    const double room = start(last) + size(last) - start(first) - total;
    const double gap = room / static_cast<double>(items.size() - 1);
    double at = start(first);
    CanvasDoc next = doc;
    for (const auto &item : items) {
        const double shift = canvasjs::round(at) - start(item);
        at += size(item) + gap;
        next = moveNodes(next, {item.id}, axis == CanvasAxis::X ? shift : 0, axis == CanvasAxis::Y ? shift : 0);
    }
    return next;
}

} // namespace parvane::sections::notes
