// Parvane fork (spec 029, T061/T062): чистая логика окон «Плана» — черновик правила повтора формы (web
// `PlannerRepeatFields.tsx`: `emptyRepeatDraft`, `repeatToDraft`, `draftToRepeat`), варианты «Напомнить» (web
// `PlannerRemindSelect.tsx`), место новой задачи в очереди (web `PlannerTaskForm.tsx`) и разбор дат и времени,
// набранных в поле (в web это делают поля `type="date"`/`type="time"` браузера; на desktop поле текстовое).
#pragma once

#include <optional>
#include <string>
#include <vector>

#include "parvane/sections/planner_types.h"

namespace parvane::sections::planner {

// ── черновик правила повтора ─────────────────────────────────────────────────

// Числа — строками, как набраны в полях; `kind` = none — разовое дело
struct RepeatDraft {
    std::string kind = "none";     // none | daily | weekly | monthly | yearly
    std::string interval = "1";
    std::vector<int> weekdays;     // как `Date.getDay`: 0 — воскресенье
    std::string monthDay;
    std::string startDay;
    std::string endKind = "never"; // never | until | count
    std::string endDay;
    std::string count;
    bool operator==(const RepeatDraft &) const = default;
};

RepeatDraft emptyRepeatDraft(const std::string &startDay = std::string());
RepeatDraft repeatToDraft(const std::optional<Repeat> &repeat, const std::string &startDay = std::string());
// Черновик → правило; `nullopt` — разовое дело. Негодное число (`Number()` web даёт NaN) становится 0 —
// его отклонит `validateRepeat`
std::optional<Repeat> draftToRepeat(const RepeatDraft &draft);

// ── «Напомнить» ──────────────────────────────────────────────────────────────

// Варианты, минут до начала: в начале, 5, 10, 15, 30 мин, 1 и 2 ч, сутки, неделя
inline const std::vector<int> kRemindOptions = {0, 5, 10, 15, 30, 60, 120, 24 * 60, 7 * 24 * 60};
// Список поля: своё значение (из ввода текстом) встаёт в общий список по порядку
std::vector<int> remindOptions(const std::optional<int> &value);

// ── новая задача ─────────────────────────────────────────────────────────────

// Новая задача — первой в очереди: на единицу меньше самого малого ранга (и не больше −1)
double newTaskRank(const State &state);

// ── даты и время из текстового поля ──────────────────────────────────────────

// Набранная дата: `ГГГГ-ММ-ДД`, `Д.М.ГГГГ`, `Д.М.ГГ` (20ГГ), `Д/М/ГГГГ`. Пусто — "" (поле очищено), негодное
// (в том числе несуществующий день) — `nullopt`
std::optional<std::string> parseDayInput(const std::string &text);
// Набранное время: `Ч:ММ`, `ЧЧ:ММ`, `Ч.ММ`, `ЧЧММ`, `Ч` / `ЧЧ` (ровный час). Пусто — "", негодное — `nullopt`
std::optional<std::string> parseTimeInput(const std::string &text);
// Дата в поле: `ДД.ММ.ГГГГ`; не дата — как есть
std::string formatDayInput(const std::string &day);

} // namespace parvane::sections::planner
