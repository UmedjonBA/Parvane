// Parvane fork (spec 029, фаза 4): запись черновика ввода текстом — порт `applyQuickDraft` web `plannerHealth.ts`.
#include "parvane/sections/planner_quick_apply.h"

#include <algorithm>
#include <charconv>
#include <cmath>

#include "parvane/sections/planner_health.h"
#include "planner_util.h"

namespace parvane::sections::planner {

namespace {

// Допуск цели, заданной текстом: десятая часть значения
constexpr double kGoalToleranceShare = 0.1;
constexpr int kMinutesInHour = 60;

std::optional<int> toInt(const std::optional<double> &value) {
    if (!value) return std::nullopt;
    return static_cast<int>(*value);
}

// `String(number)` для конечных чисел: кратчайшая запись (целое — без дробной части)
std::string jsNumber(double value) {
    if (value == std::floor(value) && std::abs(value) < 1e21) return std::to_string(static_cast<long long>(value));
    char buffer[64];
    const auto result = std::to_chars(buffer, buffer + sizeof(buffer), value);
    return std::string(buffer, result.ptr);
}

// Группа из метки `#…`: существующая — по названию без учёта регистра, иначе новая — тем же путём, что у полной формы
std::string quickGroup(State &state, const std::optional<std::string> &list, const IdGen &newId) {
    if (list) {
        const auto listName = util::lower(util::trim(*list));
        for (const auto &known : state.lists) {
            if (util::lower(known.name) == listName && !known.name.empty()) return known.name;
        }
    }
    const auto *created = ensureList(state, list ? util::trim(*list) : std::string(), newId);
    return created ? created->name : std::string();
}

void putDaily(State &state, const HealthRecord &record) {
    std::vector<HealthRecord> kept;
    for (const auto &item : state.health) {
        if (item.id != record.id) kept.push_back(item);
    }
    kept.push_back(record);
    state.health = std::move(kept);
}

std::optional<double> nutrientOf(const QuickDraft &draft, const char *key) {
    if (!draft.nutrients) return std::nullopt;
    const auto it = draft.nutrients->find(key);
    return it == draft.nutrients->end() ? std::nullopt : std::optional<double>(it->second);
}

// `{ ...a, ...b }` для целей здоровья: заданные в `b` поля заменяют поля `a`
void mergeHealthGoals(HealthGoals &into, const HealthGoals &from) {
    auto put = [](std::optional<double> &to, const std::optional<double> &value) {
        if (value) to = value;
    };
    put(into.sugarMax, from.sugarMax);
    put(into.saltMax, from.saltMax);
    put(into.sleepMinutes, from.sleepMinutes);
    put(into.bedtime, from.bedtime);
    put(into.wakeTime, from.wakeTime);
    put(into.weight, from.weight);
    put(into.steps, from.steps);
    put(into.activeMinutes, from.activeMinutes);
    put(into.workouts, from.workouts);
}

} // namespace

std::optional<std::string> applyQuickDraft(State &state, const QuickDraft &draft, const std::string &today,
                                           const IdGen &newId, const std::optional<std::string> &replaceId) {
    if (draft.error) return std::nullopt;
    const std::string day = draft.day && !draft.day->empty() ? *draft.day : today;
    const auto &repeat = draft.repeat;
    const bool isAllDay = draft.isAllDay.value_or(false);
    if (draft.kind == "event") {
        Event event;
        event.id = newId();
        event.name = draft.name;
        const auto project = quickGroup(state, draft.list, newId);
        if (!project.empty()) event.project = project;
        event.description = quickDescription(draft);
        event.remind = toInt(draft.remind);
        event.start = isAllDay ? kAllDayStart : draft.start.value_or("");
        event.end = isAllDay ? kAllDayEnd : draft.end.value_or("");
        event.day = repeat ? std::nullopt : draft.day;
        event.repeat = repeat;
        event.isAllDay = draft.isAllDay;
        state.events.push_back(event);
        return draft.name;
    }
    if (draft.kind == "task") {
        Task task;
        task.id = newId();
        task.name = draft.name;
        task.description = quickDescription(draft).value_or("");
        // Метка «!» — задача сразу «В работе»
        task.status = draft.isImportant.value_or(false) ? "active" : "queue";
        task.project = quickGroup(state, draft.list, newId);
        task.minutes = toInt(draft.minutes);
        task.remind = toInt(draft.remind);
        task.day = repeat ? std::nullopt : draft.day;
        task.start = draft.start;
        task.due = draft.due;
        task.repeat = repeat;
        // Новая задача — первой в очереди
        double rank = 0;
        for (const auto &other : state.tasks) rank = std::min(rank, other.rank);
        task.rank = rank - 1;
        state.tasks.push_back(task);
        return draft.name;
    }
    if (draft.kind == "food") {
        FoodInput input;
        input.name = draft.name;
        input.meal = draft.meal.value_or("other");
        input.isPer100 = false;
        for (const char *key : {"kcal", "protein", "fat", "carbs", "fiber"}) {
            if (const auto value = nutrientOf(draft, key)) input.values[key] = *value;
        }
        auto entry = makeFoodEntry(input, newId);
        entry.grams = draft.grams;
        entry.sugar = nutrientOf(draft, "sugar");
        entry.salt = nutrientOf(draft, "salt");
        entry.time = draft.start;
        state.nutrition[day].entries.push_back(entry);
        return draft.name;
    }
    if (draft.kind == "water") {
        auto &record = state.nutrition[day];
        record.waterMl = record.waterMl.value_or(0) + draft.waterMl.value_or(0);
        return jsNumber(draft.waterMl.value_or(0));
    }
    if (draft.kind == "sleep") {
        // Снов за день может быть несколько (ночь и дневной): новый добавляется, правка меняет свой. Первый сон дня —
        // с id дня; ровно такой же сон дня второй раз не добавляется (повторное нажатие)
        HealthRecord record;
        record.day = day;
        record.kind = "sleep";
        record.time = draft.start;
        record.endTime = draft.end;
        record.value = draft.minutes.value_or(0);
        if (replaceId) {
            for (auto &item : state.health) {
                if (item.id == *replaceId) {
                    item = record;
                    item.id = *replaceId;
                }
            }
            return "sleep";
        }
        bool hasSameDay = false;
        for (const auto &item : state.health) {
            if (item.kind != "sleep" || item.day != day) continue;
            hasSameDay = true;
            if (item.time == record.time && item.endTime == record.endTime && item.value == record.value) {
                return "sleep";
            }
        }
        // «Не спал» (0 ч) — отметка дня без сна: при любом сне дня не нужна; настоящий сон её убирает
        if (record.value == 0 && hasSameDay) return "sleep";
        std::vector<HealthRecord> kept;
        for (const auto &item : state.health) {
            if (record.value > 0 && item.kind == "sleep" && item.day == day && item.value == 0) continue;
            kept.push_back(item);
        }
        const auto dayId = dailyRecordId("sleep", day);
        const bool taken = std::any_of(kept.begin(), kept.end(), [&](const HealthRecord &item) {
            return item.id == dayId;
        });
        record.id = taken ? newId() : dayId;
        kept.push_back(record);
        state.health = std::move(kept);
        return "sleep";
    }
    if (draft.kind == "metric") {
        HealthRecord record;
        record.id = dailyRecordId(draft.metric.value_or(""), day);
        record.day = day;
        record.kind = draft.metric.value_or("");
        record.value = draft.value.value_or(0);
        record.value2 = draft.value2;
        putDaily(state, record);
        return draft.metric;
    }
    if (draft.kind == "workout") {
        HealthRecord record;
        record.id = newId();
        record.day = day;
        record.kind = "workout";
        record.time = draft.start;
        record.value = draft.minutes.value_or(0);
        record.value2 = draft.distanceKm;
        record.name = draft.name;
        record.exercises = draft.exercises;
        state.health.push_back(record);
        return draft.name;
    }
    if (draft.kind == "goal") {
        if (!draft.goalChanges) return std::nullopt;
        const auto &changes = *draft.goalChanges;
        for (const auto &[metric, value] : changes.goals) {
            const double target = std::max(1.0, util::jsRound(value));
            const auto it = state.goals.find(metric);
            const double tolerance = it != state.goals.end() ? it->second.tolerance
                                                             : util::jsRound(target * kGoalToleranceShare);
            state.goals[metric] = Goal{target, std::min(target, tolerance)};
        }
        mergeHealthGoals(state.healthGoals, changes.health);
        if (changes.dayStart) {
            state.settings.dayStart = static_cast<int>(*changes.dayStart);
            state.settings.dayEnd = static_cast<int>(changes.dayEnd.value_or(0));
        }
        if (changes.budget && *changes.budget != 0) {
            state.budget = static_cast<int>(util::jsRound(*changes.budget / kMinutesInHour) * kMinutesInHour);
        }
        return "goal";
    }
    return std::nullopt;
}

} // namespace parvane::sections::planner
