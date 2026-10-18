// Parvane fork (spec 029, фаза 4): напоминания «Плана» — порт web `plannerReminders.ts`.
#include "parvane/sections/planner_reminders.h"

#include <algorithm>
#include <cctype>
#include <set>

#include "parvane/sections/planner_model.h"
#include "planner_util.h"

namespace parvane::sections::planner {

namespace {

constexpr long long kMinuteMs = 60 * 1000;
constexpr long long kDayMs = 24 * 60 * kMinuteMs;

// Дни от 1970-01-01 (H. Hinnant)
long long daysFromCivil(long long y, long long m, long long d) {
    y -= m <= 2;
    const long long era = (y >= 0 ? y : y - 399) / 400;
    const long long yoe = y - era * 400;
    const long long doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    const long long doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + doe - 719468;
}

long long epochOfDay(const std::string &day) {
    const auto parts = util::split(day, '-');
    auto num = [&](size_t i) { return i < parts.size() && !parts[i].empty() ? std::stoll(parts[i]) : 0LL; };
    return daysFromCivil(num(0), num(1), num(2));
}

// Ранг знака для приближения `localeCompare`: знаки, затем цифры, затем буквы (без учёта регистра)
int rank(unsigned char c) {
    if (std::isdigit(c)) return 1;
    if (std::isalpha(c) || c >= 0x80) return 2;
    return 0;
}

bool keyLess(const std::string &a, const std::string &b) {
    const size_t n = std::min(a.size(), b.size());
    for (size_t i = 0; i < n; ++i) {
        const auto ca = static_cast<unsigned char>(a[i]);
        const auto cb = static_cast<unsigned char>(b[i]);
        if (ca == cb) continue;
        if (rank(ca) != rank(cb)) return rank(ca) < rank(cb);
        const int la = std::tolower(ca);
        const int lb = std::tolower(cb);
        if (la != lb) return la < lb;
    }
    if (a.size() != b.size()) return a.size() < b.size();
    // Различие только в регистре: строчная раньше заглавной (как у ICU)
    for (size_t i = 0; i < n; ++i) {
        if (a[i] != b[i]) return std::islower(static_cast<unsigned char>(a[i])) != 0;
    }
    return false;
}

} // namespace

long long wallMs(const std::string &day, int minutesOfDay) {
    return epochOfDay(day) * kDayMs + minutesOfDay * kMinuteMs;
}

std::string wallDay(long long ms) {
    // Ключ дня из номера дня — через `addDays` от начала отсчёта
    return addDays("1970-01-01", util::floorDiv(ms, kDayMs));
}

std::string wallTime(long long ms) {
    const long long minutes = (ms - util::floorDiv(ms, kDayMs) * kDayMs) / kMinuteMs;
    return toTime(static_cast<int>(minutes));
}

std::string reminderKey(const std::string &id, const std::string &day, int minutes) {
    return id + "@" + day + "@" + std::to_string(minutes);
}

std::vector<Reminder> getReminders(const State &state, long long fromMs, long long toMs) {
    const int dayStart = state.settings.dayStart;
    std::vector<Reminder> out;
    const auto firstDay = wallDay(fromMs);
    // Напоминание «за неделю» может прийти на день раньше дня записи — дни перебираются с запасом
    const auto lastDay = addDays(wallDay(toMs), 8);
    for (auto day = firstDay; day <= lastDay; day = addDays(day, 1)) {
        auto add = [&](const char *kind, const std::string &id, const std::string &title,
                       const std::optional<int> &minutes, const std::optional<std::string> &start) {
            if (!minutes) return;
            const bool hasStart = start && !start->empty();
            const long long startsAt = wallMs(day, hasStart ? toMinutes(*start) : dayStart);
            const long long at = startsAt - *minutes * kMinuteMs;
            if (at < fromMs || at > toMs) return;
            out.push_back({reminderKey(id, day, *minutes), at, startsAt, title, kind, day,
                           hasStart ? start : std::nullopt});
        };
        for (const auto &task : getTasksForDay(state, day)) {
            const bool isDone = task.repeat ? isInstanceDone(task, day) : task.status == "done";
            if (!isDone) add("task", task.id, task.name, task.remind, task.start);
        }
        for (const auto &event : getEventsForDay(state, day)) {
            add("event", event.id, event.name, event.remind,
                event.isAllDay.value_or(false) ? std::nullopt : std::optional<std::string>(event.start));
        }
    }
    std::stable_sort(out.begin(), out.end(), [](const Reminder &a, const Reminder &b) {
        if (a.at != b.at) return a.at < b.at;
        return keyLess(a.key, b.key);
    });
    return out;
}

std::vector<Reminder> getDueReminders(const State &state, long long nowMs, long long sinceMs) {
    const std::set<std::string> reminded(state.reminded.begin(), state.reminded.end());
    std::vector<Reminder> out;
    for (auto &item : getReminders(state, sinceMs, nowMs)) {
        if (!reminded.count(item.key)) out.push_back(std::move(item));
    }
    return out;
}

ReminderPlan readReminders(const State &state, long long nowMs) {
    ReminderPlan plan;
    plan.upcoming = getReminders(state, nowMs, nowMs + kReminderHorizonMs);
    if (plan.upcoming.size() > kMaxUpcomingReminders) plan.upcoming.resize(kMaxUpcomingReminders);
    plan.due = getDueReminders(state, nowMs, nowMs - kReminderCatchUpMs);
    return plan;
}

} // namespace parvane::sections::planner
