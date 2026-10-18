// Parvane fork (spec 029, фаза 4): что начинает нажатие на поле холста «Знаний» — сдвиг поля, сдвиг группы или
// карточки, рамку выделения, размер, стрелку. Зеркало web `notes/notesCanvasPress.ts`. Чистая функция: решение по
// тому, что лежит под указателем.
#pragma once

#include <optional>
#include <string>

#include "parvane/sections/notes_canvas.h"
#include "parvane/sections/notes_canvas_edit.h"

namespace parvane::sections::notes {

// Нажатие: клавиши и режимы плюс то, что под указателем. `nodeId` — узел под указателем (карточка, а у группы —
// шапка, граница и ручки). Пустой id считается отсутствующим, как в web
struct CanvasPress {
    // Средняя кнопка либо зажатый пробел: поле двигается, что бы ни было под указателем
    bool isPanForced = false;
    // Shift, Ctrl, Cmd либо режим «Выбрать несколько»
    bool isAdditive = false;
    // Режим «Связать»: следующее нажатие выбирает вторую карточку
    bool isLinking = false;
    std::optional<std::string> nodeId;
    std::optional<CanvasSide> port;
    std::optional<CanvasHandle> handle;
    std::optional<std::string> edgeId;
};

struct CanvasPressAction {
    enum class Kind { Pan, Arrow, Resize, Link, Node, Edge, Marquee, Board } kind = Kind::Board;
    std::optional<std::string> id;      // Arrow, Resize, Node, Edge; у Link — может не быть
    std::optional<CanvasSide> side;     // Arrow
    std::optional<CanvasHandle> handle; // Resize
    bool operator==(const CanvasPressAction &) const = default;
};

CanvasPressAction pressAction(const CanvasPress &press);

} // namespace parvane::sections::notes
