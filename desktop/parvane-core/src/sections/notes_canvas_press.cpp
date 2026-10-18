// Parvane fork (spec 029, фаза 4): нажатие на поле холста — порт web `notes/notesCanvasPress.ts`.
#include "parvane/sections/notes_canvas_press.h"

namespace parvane::sections::notes {

namespace {

CanvasPressAction make(CanvasPressAction::Kind kind, std::optional<std::string> id = std::nullopt,
                       std::optional<CanvasSide> side = std::nullopt,
                       std::optional<CanvasHandle> handle = std::nullopt) {
    CanvasPressAction action;
    action.kind = kind;
    action.id = std::move(id);
    action.side = side;
    action.handle = handle;
    return action;
}

} // namespace

// По старшинству: сдвиг поля средней кнопкой и пробелом; точка стрелки и ручка размера (они лежат поверх узла);
// выбор второй карточки в режиме «Связать»; узел под указателем; стрелка; рамка выделения; пустое место — сдвиг
// поля, и внутри группы тоже: группу берут только за шапку и границу
CanvasPressAction pressAction(const CanvasPress &press) {
    using Kind = CanvasPressAction::Kind;
    const bool hasNode = press.nodeId && !press.nodeId->empty();
    const bool hasEdge = press.edgeId && !press.edgeId->empty();
    if (press.isPanForced) return make(Kind::Pan);
    if (hasNode && press.port) return make(Kind::Arrow, press.nodeId, press.port);
    if (hasNode && press.handle) return make(Kind::Resize, press.nodeId, std::nullopt, press.handle);
    if (press.isLinking) return make(Kind::Link, press.nodeId);
    if (hasNode) return make(Kind::Node, press.nodeId);
    if (hasEdge) return make(Kind::Edge, press.edgeId);
    if (press.isAdditive) return make(Kind::Marquee);
    return make(Kind::Board);
}

} // namespace parvane::sections::notes
