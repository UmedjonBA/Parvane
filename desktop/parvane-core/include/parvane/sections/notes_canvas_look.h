// Parvane fork (spec 029, T063): внешний вид холста «Знаний» без UI — порт чистой части web
// `components/parvane/notes/notesCanvasLook.tsx` и подписи узла `nameOfNode` из `NotesCanvas.tsx`. Разметка строки
// карточки (`[[ссылка]]`, `` `код` ``, `**жирный**`), наконечник стрелки и концы её линии, подпись узла в шторке
// связей. Рисует интерфейс; здесь только то, что он рисует.
#pragma once

#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "parvane/sections/notes_canvas.h"

namespace parvane::sections::notes {

// Часть строки карточки. У ссылки `text` — то, что показывается: псевдоним после `|`, иначе цель (без пробелов
// по краям)
struct CanvasInlinePart {
    enum class Kind { Text, Link, Code, Bold } kind = Kind::Text;
    std::string text;
    bool operator==(const CanvasInlinePart &) const = default;
};

// Строка карточки по частям — как `text.split(/(\[\[[^\]\n]+\]\]|`[^`\n]+`|\*\*[^*\n]+\*\*)/g)` web; пустые
// куски обычного текста между соседними разметками не возвращаются
std::vector<CanvasInlinePart> canvasInlineParts(std::string_view line);

// Наконечник стрелки (web ARROW_LENGTH, ARROW_HALF_WIDTH): остриё в конце стрелки, основание отведено от стороны
// узла наружу
inline constexpr double kCanvasArrowLength = 11;
inline constexpr double kCanvasArrowHalfWidth = 5;

struct CanvasArrowHead {
    CanvasPoint tip;
    CanvasPoint left;
    CanvasPoint right;
    bool operator==(const CanvasArrowHead &) const = default;
};
CanvasArrowHead canvasArrowHead(const CanvasAnchor &anchor);

// Конец линии стрелки: с наконечником линия кончается у его основания (на единицу глубже), чтобы не торчать из
// острия (web `curvePath`)
CanvasPoint canvasLineEnd(const CanvasAnchor &anchor, bool hasArrow);

// Наконечники связи: в начале — только `fromEnd: 'arrow'`, в конце — всё, кроме `toEnd: 'none'`
struct CanvasEdgeArrows {
    bool start = false;
    bool end = true;
    bool operator==(const CanvasEdgeArrows &) const = default;
};
CanvasEdgeArrows canvasEdgeArrows(const CanvasEdge &edge);

// Подпись узла (шторка связей, «откуда → куда»): название заметки из пути, подпись группы либо начало текста
// без `*` (24 знака UTF-16). Пусто — nullopt: подпись по типу узла даёт интерфейс («Группа» / «Текст»)
inline constexpr std::size_t kCanvasNodeNameMax = 24;
std::optional<std::string> canvasNodeName(const CanvasNode &node);

} // namespace parvane::sections::notes
