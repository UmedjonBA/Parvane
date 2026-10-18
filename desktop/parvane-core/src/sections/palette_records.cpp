// Parvane fork (spec 029, фаза 4): записи «Плана» для палитры — порт web `paletteRecords.ts`.
#include "parvane/sections/palette_records.h"

#include <algorithm>
#include <cstdlib>
#include <limits>

#include "parvane/sections/planner_model.h"

namespace parvane::sections::palette {

namespace {

// Дни от 1970-01-01 (H. Hinnant)
long long daysFromCivil(long long y, long long m, long long d) {
    y -= m <= 2;
    const long long era = (y >= 0 ? y : y - 399) / 400;
    const long long yoe = y - era * 400;
    const long long doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    const long long doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + doe - 719468;
}

// Номер дня; негодный ключ — нет номера
std::optional<long long> dayNumber(const std::string &day) {
    if (!planner::isDayKey(day)) return std::nullopt;
    return daysFromCivil(std::stoll(day.substr(0, 4)), std::stoll(day.substr(5, 2)), std::stoll(day.substr(8, 2)));
}

template <typename T>
std::optional<std::string> recordDayOf(const T &item, const std::string &today) {
    if (!item.repeat) return item.day;
    for (int offset = 0; offset <= planner::kRepeatHorizonDays; ++offset) {
        const auto day = planner::addDays(today, offset);
        if (item.repeat->endDay && !item.repeat->endDay->empty() && day > *item.repeat->endDay) break;
        if (planner::hasInstanceOn(item, day)) return day;
    }
    if (!item.repeat->startDay.empty()) return item.repeat->startDay;
    return std::nullopt;
}

PaletteRecordItem make(const std::string &kind, const std::string &id, const std::string &title,
                       std::optional<std::string> text, std::optional<std::string> day) {
    PaletteRecordItem out;
    out.item.key = kind + ":" + id;
    out.item.group = PaletteGroup::Record;
    out.item.title = title;
    out.item.text = std::move(text);
    out.kind = kind;
    out.id = id;
    out.day = std::move(day);
    return out;
}

} // namespace

std::optional<std::string> recordDay(const planner::Task &item, const std::string &today) {
    return recordDayOf(item, today);
}

std::optional<std::string> recordDay(const planner::Event &item, const std::string &today) {
    return recordDayOf(item, today);
}

std::vector<PaletteRecordItem> collectPlannerRecords(const planner::State &state, const std::string &today) {
    std::vector<PaletteRecordItem> out;
    for (const auto &event : state.events) {
        out.push_back(make("event", event.id, event.name, event.description, recordDay(event, today)));
    }
    for (const auto &task : state.tasks) {
        // `[description, ...steps].filter(Boolean).join('\n')`
        std::string text;
        auto add = [&](const std::string &part) {
            if (part.empty()) return;
            if (!text.empty()) text += "\n";
            text += part;
        };
        add(task.description);
        for (const auto &step : task.steps) add(step.text);
        out.push_back(make("task", task.id, task.name, text, recordDay(task, today)));
    }
    for (const auto &record : state.health) {
        if (record.kind != "workout" || !record.name || record.name->empty()) continue;
        std::optional<std::string> text;
        if (record.exercises) {
            std::string joined;
            for (size_t i = 0; i < record.exercises->size(); ++i) {
                if (i) joined += "\n";
                joined += (*record.exercises)[i].name;
            }
            text = joined;
        }
        out.push_back(make("workout", record.id, *record.name, text, record.day));
    }
    // Ближайшие к сегодня — первыми: при равном совпадении порядок источника решает, что видно
    const auto todayNumber = dayNumber(today);
    auto distance = [&](const PaletteRecordItem &item) {
        const auto number = item.day ? dayNumber(*item.day) : std::nullopt;
        if (!number || !todayNumber) return std::numeric_limits<long long>::max();
        return std::llabs(*number - *todayNumber);
    };
    std::stable_sort(out.begin(), out.end(),
                     [&](const PaletteRecordItem &a, const PaletteRecordItem &b) { return distance(a) < distance(b); });
    return out;
}

std::vector<PaletteItem> paletteItemsOf(const std::vector<PaletteRecordItem> &records) {
    std::vector<PaletteItem> out;
    for (const auto &record : records) out.push_back(record.item);
    return out;
}

} // namespace parvane::sections::palette
