// Parvane fork (spec 029, фаза 4): расписание на неделю текстом → еженедельные события «Плана» — порт web
// `plannerSchedule.ts`. Строка с днём недели («Понедельник», «Пн», «Monday», «Mon») открывает день; строки
// «ЧЧ:ММ–ЧЧ:ММ Название, подробности» под ним — события. Дата конца — «до 15.12.2026» (или «до 2026-12-15»,
// «until …») в любом месте текста. Разбор — вручную по кодовым точкам (регулярки с кириллицей ненадёжны).
#pragma once

#include <optional>
#include <string>
#include <vector>

#include "parvane/sections/planner_model.h"

namespace parvane::sections::planner {

struct ScheduleItem {
    int weekday = 0; // как `Date.getDay`: 0 — воскресенье
    std::string start;
    std::string end;
    std::string name;
    std::optional<std::string> description;
    bool operator==(const ScheduleItem &) const = default;
};

struct ParsedSchedule {
    std::vector<ScheduleItem> items;
    std::optional<std::string> endDay; // дата конца из текста (`YYYY-MM-DD`)
    std::vector<std::string> skipped;  // строки со временем, которые не удалось отнести к дню или разобрать
};

inline constexpr size_t kScheduleMaxNameLength = 200;

ParsedSchedule parseSchedule(const std::string &text);
// Каждое — еженедельный ряд в свой день с `startDay` по `endDay` включительно, в группе `project`
std::vector<Event> buildScheduleEvents(const std::vector<ScheduleItem> &items, const std::string &startDay,
                                       const std::string &endDay, const std::optional<std::string> &project,
                                       const IdGen &newId);

} // namespace parvane::sections::planner
