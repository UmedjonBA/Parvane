// Parvane fork (spec 029, фаза 4): выравнивание на холсте «Знаний» — прилипание к краям и серединам соседей при
// сдвиге и смене размера (с направляющими линиями), выравнивание и распределение выделенного. Зеркало web
// `notes/notesCanvasAlign.ts`. Чистые функции.
#pragma once

#include <string>
#include <vector>

#include "parvane/sections/notes_canvas.h"
#include "parvane/sections/notes_canvas_edit.h"

namespace parvane::sections::notes {

enum class CanvasAxis { X, Y };

// Направляющая: ось X — вертикальная линия при x = `at` от y = `from` до y = `to`; ось Y — горизонтальная
struct CanvasGuide {
    CanvasAxis axis = CanvasAxis::X;
    double at = 0;
    double from = 0;
    double to = 0;
    bool operator==(const CanvasGuide &) const = default;
};

enum class CanvasAlign { Left, Center, Right, Top, Middle, Bottom };
inline const std::vector<CanvasAlign> kCanvasAligns = {
    CanvasAlign::Left, CanvasAlign::Center, CanvasAlign::Right,
    CanvasAlign::Top, CanvasAlign::Middle, CanvasAlign::Bottom};

struct CanvasSnap {
    double dx = 0;
    double dy = 0;
    std::vector<CanvasGuide> guides;
    bool operator==(const CanvasSnap &) const = default;
};

struct CanvasResizeSnap {
    CanvasRect rect;
    std::vector<CanvasGuide> guides;
};

// Ближе этого (в точках холста при масштабе 1) край прилипает к соседу
inline constexpr double kCanvasSnapDistance = 6;

CanvasSnap snapToNeighbours(const CanvasRect &moving, const std::vector<CanvasRect> &others,
                            double tolerance = kCanvasSnapDistance);
CanvasResizeSnap snapResize(const CanvasRect &rect, CanvasHandle handle, const std::vector<CanvasRect> &others,
                            double tolerance = kCanvasSnapDistance, CanvasSize min = kCanvasCardMin);
CanvasDoc alignNodes(const CanvasDoc &doc, const std::vector<std::string> &ids, CanvasAlign align);
CanvasDoc distributeNodes(const CanvasDoc &doc, const std::vector<std::string> &ids, CanvasAxis axis);

} // namespace parvane::sections::notes
