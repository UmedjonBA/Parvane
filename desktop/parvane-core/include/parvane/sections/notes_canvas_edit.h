// Parvane fork (spec 029, фаза 4): правки холста «Знаний», которые делает редактор, — размер и сетка, группы,
// выделение, копии, порядок слоёв, стрелки, клавиши. Зеркало web `notes/notesCanvasEdit.ts` (+ `findFreeSpot` из
// `notesCanvasGraph.ts`). Чистые функции над документом JSON Canvas: каждая возвращает новый документ (или
// прежний, если менять нечего). Без UI, хранилища и сети.
#pragma once

#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "parvane/sections/notes_canvas.h"

namespace parvane::sections::notes {

enum class CanvasHandle { N, NE, E, SE, S, SW, W, NW };
inline const std::vector<CanvasHandle> kCanvasHandles = {
    CanvasHandle::N, CanvasHandle::NE, CanvasHandle::E, CanvasHandle::SE,
    CanvasHandle::S, CanvasHandle::SW, CanvasHandle::W, CanvasHandle::NW};
inline const std::vector<CanvasHandle> kCanvasCornerHandles = {
    CanvasHandle::NE, CanvasHandle::SE, CanvasHandle::SW, CanvasHandle::NW};
// Имя ручки как в web ('n', 'ne', …) и проверка «в имени есть буква» (`handle.includes('w')`)
const char *canvasHandleName(CanvasHandle handle);
std::optional<CanvasHandle> canvasHandleFromName(std::string_view name);
bool canvasHandleHas(CanvasHandle handle, char side);

struct CanvasSelection {
    std::vector<std::string> nodes;
    std::vector<std::string> edges;
    bool operator==(const CanvasSelection &) const = default;
};
enum class CanvasSelectionKind { Nodes, Edges };

struct CanvasClip {
    std::vector<CanvasNode> nodes;
    std::vector<CanvasEdge> edges;
    bool operator==(const CanvasClip &) const = default;
};

struct CanvasSize {
    double width = 0;
    double height = 0;
    bool operator==(const CanvasSize &) const = default;
};

struct CanvasCurve {
    CanvasAnchor p;
    CanvasPoint c1;
    CanvasPoint c2;
    CanvasAnchor q;
};

// Концы стрелки ('none' | 'arrow'); nullopt — значение по умолчанию, в файл не пишется
struct CanvasEnds {
    std::optional<std::string> fromEnd;
    std::optional<std::string> toEnd;
    bool operator==(const CanvasEnds &) const = default;
};

enum class CanvasShortcut { Undo, Redo, SelectAll, Duplicate, Remove, Edit, Left, Right, Up, Down };

// Что лежит в буфере обмена: узлы холста, адрес страницы либо просто текст
struct CanvasPasted {
    enum class Kind { Nodes, Link, Text } kind = Kind::Text;
    CanvasClip clip;   // Nodes
    std::string url;   // Link
    std::string text;  // Text
};

struct CanvasKey {
    std::string key;
    std::string code;
    bool ctrlKey = false;
    bool metaKey = false;
    bool shiftKey = false;
    bool altKey = false;
};

// Шаг сетки: к нему прилипают сдвиг и размер
inline constexpr double kCanvasGrid = 10;
// Сдвиг стрелками с Shift
inline constexpr double kCanvasNudgeBig = 50;
// Поле между рамкой группы и её содержимым
inline constexpr double kCanvasGroupPadding = 20;
inline constexpr CanvasSize kCanvasCardMin{80, 40};
inline constexpr CanvasSize kCanvasGroupMin{120, 80};
inline constexpr double kCanvasCopyShift = 20;
// Просвет вокруг новой карточки в `findFreeSpot` (web FREE_SPOT_GAP)
inline constexpr double kCanvasFreeSpotGap = 40;

CanvasPoint canvasSideNormal(CanvasSide side);

// ── сетка и размер ───────────────────────────────────────────────────────────

double snapTo(double value, double grid = kCanvasGrid);
struct CanvasDelta {
    double dx = 0;
    double dy = 0;
    bool operator==(const CanvasDelta &) const = default;
};
CanvasDelta snapDelta(CanvasPoint rect, double dx, double dy, double grid = kCanvasGrid);
CanvasSize minSizeOf(std::string_view nodeType);
CanvasRect resizeRect(const CanvasRect &rect, CanvasHandle handle, double dx, double dy,
                      CanvasSize min = kCanvasCardMin, double grid = kCanvasGrid);
CanvasDoc placeNode(const CanvasDoc &doc, std::string_view id, const CanvasRect &rect);

// ── сдвиг и группы ───────────────────────────────────────────────────────────

CanvasDoc moveNodes(const CanvasDoc &doc, const std::vector<std::string> &ids, double dx, double dy);
CanvasDoc growGroups(const CanvasDoc &before, const CanvasDoc &after, double padding = kCanvasGroupPadding);
CanvasDoc fitGroupToContent(const CanvasDoc &doc, std::string_view groupId, double padding = kCanvasGroupPadding);
struct CanvasWrapResult {
    CanvasDoc doc;
    std::optional<std::string> id;
};
CanvasWrapResult wrapInGroup(const CanvasDoc &doc, const std::vector<std::string> &ids,
                             const CanvasMakeId &makeId = {}, double padding = kCanvasGroupPadding);

// ── выделение ────────────────────────────────────────────────────────────────

bool isSelectionEmpty(const CanvasSelection &selection);
CanvasSelection toggleSelected(const CanvasSelection &selection, CanvasSelectionKind kind, const std::string &id);
CanvasSelection selectAll(const CanvasDoc &doc);
CanvasSelection pruneSelection(const CanvasDoc &doc, const CanvasSelection &selection);
CanvasRect rectOfPoints(CanvasPoint a, CanvasPoint b);
std::vector<std::string> nodesInRect(const CanvasDoc &doc, const CanvasRect &rect);
std::optional<CanvasRect> selectionBounds(const CanvasDoc &doc, const std::vector<std::string> &ids);
CanvasDoc removeSelection(const CanvasDoc &doc, const CanvasSelection &selection);
// Цвет всему выделенному; nullopt (и пустая строка) убирает цвет
CanvasDoc recolorSelection(const CanvasDoc &doc, const CanvasSelection &selection,
                           const std::optional<std::string> &color = std::nullopt);
std::optional<std::string> colorOfSelection(const CanvasDoc &doc, const CanvasSelection &selection);

// ── копии ────────────────────────────────────────────────────────────────────

CanvasClip copyNodes(const CanvasDoc &doc, const std::vector<std::string> &ids);
struct CanvasPasteResult {
    CanvasDoc doc;
    std::vector<std::string> ids;
};
CanvasPasteResult pasteClip(const CanvasDoc &doc, const CanvasClip &clip, double dx, double dy,
                            const CanvasMakeId &makeId = {});
std::optional<CanvasRect> clipBounds(const CanvasClip &clip);
std::string serializeClip(const CanvasClip &clip);
std::optional<CanvasPasted> parsePasted(std::string_view text);

// ── слои ─────────────────────────────────────────────────────────────────────

enum class CanvasLayer { Front, Back };
CanvasDoc reorderNodes(const CanvasDoc &doc, const std::vector<std::string> &ids, CanvasLayer place);

// ── стрелки ──────────────────────────────────────────────────────────────────

CanvasSide oppositeSide(CanvasSide side);
CanvasSide nearestSide(const CanvasRect &rect, CanvasPoint point);
const CanvasNode *nodeAtPoint(const CanvasDoc &doc, CanvasPoint point, std::string_view exceptId = {});
CanvasDoc connectNodes(const CanvasDoc &doc, const std::string &from, const std::string &to,
                       const CanvasSides &sides, const CanvasMakeId &makeId = {});
std::optional<CanvasCurve> edgeCurve(const CanvasDoc &doc, const CanvasEdge &edge);
CanvasCurve curveBetween(const CanvasAnchor &p, const CanvasAnchor &q);
CanvasPoint curvePoint(const CanvasCurve &curve, double t);
double distanceToCurve(const CanvasCurve &curve, CanvasPoint point);
std::optional<std::string> edgeAt(const CanvasDoc &doc, CanvasPoint point, double tolerance);
CanvasEnds nextEdgeEnds(const CanvasEnds &edge);

// ── прочее ───────────────────────────────────────────────────────────────────

// Адрес для карточки-ссылки: только http и https; адрес без схемы получает https. Запись — как `URL.toString()`
std::optional<std::string> normalizeCanvasUrl(std::string_view text);
std::optional<CanvasShortcut> canvasShortcut(const CanvasKey &e);

// Свободное место для новой карточки с серединой около `center` (из web `notesCanvasGraph.ts`): клетки сетки
// кольцами от середины наружу; группы местом не считаются
CanvasPoint findFreeSpot(const CanvasDoc &doc, CanvasPoint center, double width, double height,
                         double gap = kCanvasFreeSpotGap);

} // namespace parvane::sections::notes
