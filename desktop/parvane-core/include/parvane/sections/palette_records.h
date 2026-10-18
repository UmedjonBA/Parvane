// Parvane fork (spec 029, фаза 4): записи «Плана» для палитры (Ctrl+K) — порт web
// `components/parvane/palette/paletteRecords.ts`. Ищутся события, задачи и тренировки с названием; еда, сон и
// показатели в общий поиск не входят.
//
// Отличие от web: запись с негодным днём (не `YYYY-MM-DD`) стоит в конце, как запись без дня (в web расстояние NaN
// и порядок такой записи зависит от сортировки).
#pragma once

#include <optional>
#include <string>
#include <vector>

#include "parvane/sections/palette_search.h"
#include "parvane/sections/planner_types.h"

namespace parvane::sections::palette {

struct PaletteRecordItem {
    PaletteItem item;         // group = Record, key `<вид>:<id>`
    std::string kind;         // task | event | workout
    std::string id;
    std::optional<std::string> day; // день, на котором запись откроется; у задачи без даты нет
};

// День записи: разовая дата либо ближайший от сегодня экземпляр ряда (нет впереди — начало ряда)
std::optional<std::string> recordDay(const planner::Task &item, const std::string &today);
std::optional<std::string> recordDay(const planner::Event &item, const std::string &today);

// События, задачи, тренировки; ближайшие к сегодня — первыми (при равенстве — порядок источника)
std::vector<PaletteRecordItem> collectPlannerRecords(const planner::State &state, const std::string &today);

// Записи для `searchPalette` (индексы результатов совпадают с индексами `records`)
std::vector<PaletteItem> paletteItemsOf(const std::vector<PaletteRecordItem> &records);

} // namespace parvane::sections::palette
