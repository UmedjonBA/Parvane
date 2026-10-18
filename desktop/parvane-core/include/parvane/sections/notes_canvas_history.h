// Parvane fork (spec 029, фаза 4): отмена и возврат правок холста «Знаний» — зеркало web
// `notes/notesCanvasHistory.ts`. Документы неизменяемы, поэтому шаг истории — общий указатель на прежний
// документ (в web — ссылка на объект). Чистые функции, без UI.
#pragma once

#include <functional>
#include <memory>
#include <optional>
#include <vector>

#include "parvane/sections/notes_canvas.h"

namespace parvane::sections::notes {

using CanvasDocPtr = std::shared_ptr<const CanvasDoc>;

struct CanvasHistory {
    std::vector<CanvasDocPtr> past;
    std::vector<CanvasDocPtr> future;
};

struct CanvasHistoryMove {
    CanvasHistory history;
    CanvasDocPtr doc;
};

inline constexpr std::size_t kCanvasHistoryLimit = 100;

CanvasHistory createHistory();
// Новый шаг: `before` — документ до правки. «Вернуть» после новой правки невозможно; шагов не больше `limit`
CanvasHistory recordStep(const CanvasHistory &history, CanvasDocPtr before, std::size_t limit = kCanvasHistoryLimit);
// Отмена: `current` уходит в «вернуть». Отменять нечего — nullopt
std::optional<CanvasHistoryMove> undoStep(const CanvasHistory &history, CanvasDocPtr current);
std::optional<CanvasHistoryMove> redoStep(const CanvasHistory &history, CanvasDocPtr current);
// Последний шаг забывается совсем, без «вернуть»
std::optional<CanvasHistoryMove> dropStep(const CanvasHistory &history);
// Одна и та же поправка во всех шагах. `change` возвращает тот же указатель, если менять нечего; ничего не
// изменилось — прежняя история (`*changed` = false)
CanvasHistory mapHistory(const CanvasHistory &history, const std::function<CanvasDocPtr(const CanvasDocPtr &)> &change,
                         bool *changed = nullptr);

} // namespace parvane::sections::notes
