// Parvane fork (spec 029, фаза 4): запись черновика ввода текстом в состояние «Плана» — порт `applyQuickDraft`
// из web `components/parvane/planner/plannerHealth.ts` (spec 017/020). Отдельно от planner_health: зависит от
// модуля быстрого ввода (planner_quick), а сводки здоровья — нет.
//
// Отличия от web: правка — над `State&` (в web — черновик `updatePlanner`), новые id — параметр `IdGen`.
// Возврат — подпись для уведомления (название записи, `sleep`, `goal`, вид показателя, объём воды строкой как
// `String(number)` в JS) либо `nullopt` (черновик с ошибкой или незнакомый вид).
#pragma once

#include <optional>
#include <string>

#include "parvane/sections/planner_model.h"
#include "parvane/sections/planner_quick.h"
#include "parvane/sections/planner_types.h"

namespace parvane::sections::planner {

// `replaceId` — правка уже записанного сна (его запись меняется на месте); без него сон добавляется к дню
std::optional<std::string> applyQuickDraft(State &state, const QuickDraft &draft, const std::string &today,
                                           const IdGen &newId,
                                           const std::optional<std::string> &replaceId = std::nullopt);

} // namespace parvane::sections::planner
