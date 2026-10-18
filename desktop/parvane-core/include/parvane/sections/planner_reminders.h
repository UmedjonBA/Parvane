// Parvane fork (spec 029, фаза 4): напоминания «Плана» — порт web `components/parvane/planner/plannerReminders.ts`.
// Напоминание — у задачи или события с `remind` (минут до начала); начала нет (задача без времени, событие на весь
// день) — начало дня по настройкам. Ключ `<id>@<день>@<минут>` одинаков на всех устройствах: им помечается «уже
// напомнено» (`State::reminded`).
//
// Отличия от web:
// - моменты — «настенные» миллисекунды: день и время как есть, отсчёт от 1970-01-01 00:00 без часового пояса
//   (`wallMs`/`wallDay`). Web считает в местном времени браузера (`Date#setHours`); UI переводит настенный момент
//   в настоящий (QDateTime в местной зоне) и обратно. В дни перевода часов web и desktop могут разойтись на час;
// - `readReminders` принимает уже прочитанное состояние (в web — JSON движка через `fromEngineState`, plannerSync
//   не перенесён);
// - порядок при равном моменте — по ключу приближением `localeCompare` (знаки < цифры < буквы без учёта регистра).
#pragma once

#include <optional>
#include <string>
#include <vector>

#include "parvane/sections/planner_types.h"

namespace parvane::sections::planner {

struct Reminder {
    std::string key;
    long long at = 0;       // момент напоминания, настенные мс
    long long startsAt = 0; // начало записи, настенные мс
    std::string title;
    std::string kind; // task | event
    std::string day;
    std::optional<std::string> start; // `HH:MM`; нет — запись без времени
};

// Настенный момент: день `YYYY-MM-DD` + минуты от полуночи → мс
long long wallMs(const std::string &day, int minutesOfDay);
// День настенного момента
std::string wallDay(long long ms);
// Время `HH:MM` настенного момента
std::string wallTime(long long ms);

std::string reminderKey(const std::string &id, const std::string &day, int minutes);

// Напоминания с моментом в `[fromMs, toMs]`, по времени. Выполненные задачи не напоминают
std::vector<Reminder> getReminders(const State &state, long long fromMs, long long toMs);
// Сработавшие и ещё не отмеченные: момент прошёл, но не раньше `sinceMs`
std::vector<Reminder> getDueReminders(const State &state, long long nowMs, long long sinceMs);

inline constexpr long long kReminderHorizonMs = 30LL * 24 * 60 * 60 * 1000;
inline constexpr long long kReminderCatchUpMs = 48LL * 60 * 60 * 1000;
inline constexpr size_t kMaxUpcomingReminders = 64;

struct ReminderPlan {
    std::vector<Reminder> upcoming;
    std::vector<Reminder> due;
};
// Ближайшие (горизонт месяц, не больше 64) и наступившие неотмеченные (за 48 ч)
ReminderPlan readReminders(const State &state, long long nowMs);

} // namespace parvane::sections::planner
