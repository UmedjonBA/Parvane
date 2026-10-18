// Parvane fork (spec 029, T061/T062): реализация planner_forms.h.
#include "parvane/sections/planner_forms.h"

#include <algorithm>
#include <cmath>

#include "parvane/sections/planner_model.h"
#include "planner_util.h"

namespace parvane::sections::planner {
namespace {

// `Number(text)` поля type=number, сведённый к целому: пусто — `nullopt`, не целое число — 0 (его отклонит
// проверка правила)
std::optional<int> fieldNumber(const std::string &text) {
    const auto t = util::trim(text);
    if (t.empty()) return std::nullopt;
    size_t i = 0;
    const bool negative = t[0] == '-';
    if (negative || t[0] == '+') i = 1;
    if (i >= t.size()) return 0;
    long long value = 0;
    for (; i < t.size(); ++i) {
        if (!util::isDigit(t[i])) return 0;
        value = value * 10 + (t[i] - '0');
        if (value > 1000000) return 0;
    }
    return static_cast<int>(negative ? -value : value);
}

bool isLeap(int year) {
    return (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
}

int daysInMonth(int year, int month) {
    static const int kDays[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
    return (month == 2 && isLeap(year)) ? 29 : kDays[month - 1];
}

// Части строки из цифр, разделённые одним знаком из `separators`
std::optional<std::vector<int>> digitGroups(const std::string &text, const std::string &separators,
                                            std::vector<size_t> &lengths) {
    std::vector<int> out;
    lengths.clear();
    std::string current;
    auto flush = [&]() -> bool {
        if (current.empty() || current.size() > 4) return false;
        out.push_back(std::stoi(current));
        lengths.push_back(current.size());
        current.clear();
        return true;
    };
    for (char c : text) {
        if (util::isDigit(c)) {
            current += c;
        } else if (separators.find(c) != std::string::npos) {
            if (!flush()) return std::nullopt;
        } else {
            return std::nullopt;
        }
    }
    if (!flush()) return std::nullopt;
    return out;
}

std::optional<std::string> validDay(int year, int month, int day) {
    if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return std::nullopt;
    if (day > daysInMonth(year, month)) return std::nullopt;
    auto y = std::to_string(year);
    while (y.size() < 4) y = "0" + y;
    return y + "-" + util::pad2(month) + "-" + util::pad2(day);
}

} // namespace

RepeatDraft emptyRepeatDraft(const std::string &startDay) {
    RepeatDraft draft;
    draft.startDay = startDay;
    return draft;
}

RepeatDraft repeatToDraft(const std::optional<Repeat> &repeat, const std::string &startDay) {
    if (!repeat) return emptyRepeatDraft(startDay);
    RepeatDraft draft;
    draft.kind = repeat->kind;
    draft.interval = std::to_string(repeat->interval);
    draft.weekdays = repeat->weekdays.value_or(std::vector<int>());
    draft.monthDay = (repeat->monthDay && *repeat->monthDay) ? std::to_string(*repeat->monthDay) : std::string();
    draft.startDay = repeat->startDay;
    const bool hasEnd = repeat->endDay && !repeat->endDay->empty();
    const bool hasCount = repeat->count && *repeat->count;
    draft.endKind = hasEnd ? "until" : hasCount ? "count" : "never";
    draft.endDay = hasEnd ? *repeat->endDay : std::string();
    draft.count = hasCount ? std::to_string(*repeat->count) : std::string();
    return draft;
}

std::optional<Repeat> draftToRepeat(const RepeatDraft &draft) {
    if (draft.kind == "none") return std::nullopt;
    Repeat repeat;
    repeat.kind = draft.kind;
    repeat.interval = draft.interval.empty() ? 1 : fieldNumber(draft.interval).value_or(1);
    if (draft.kind == "weekly") repeat.weekdays = draft.weekdays;
    if (draft.kind == "monthly" && !draft.monthDay.empty()) repeat.monthDay = fieldNumber(draft.monthDay);
    repeat.startDay = draft.startDay;
    if (draft.endKind == "until" && !draft.endDay.empty()) repeat.endDay = draft.endDay;
    if (draft.endKind == "count" && !draft.count.empty()) repeat.count = fieldNumber(draft.count);
    return repeat;
}

std::vector<int> remindOptions(const std::optional<int> &value) {
    auto options = kRemindOptions;
    if (!value || std::find(options.begin(), options.end(), *value) != options.end()) return options;
    options.push_back(*value);
    std::sort(options.begin(), options.end());
    return options;
}

double newTaskRank(const State &state) {
    double low = 0;
    for (const auto &task : state.tasks) low = std::min(low, task.rank);
    return low - 1;
}

std::optional<std::string> parseDayInput(const std::string &text) {
    const auto t = util::trim(text);
    if (t.empty()) return std::string();
    std::vector<size_t> lengths;
    if (t.find('-') != std::string::npos) {
        const auto groups = digitGroups(t, "-", lengths);
        if (!groups || groups->size() != 3 || lengths[0] != 4) return std::nullopt;
        return validDay((*groups)[0], (*groups)[1], (*groups)[2]);
    }
    const auto groups = digitGroups(t, "./", lengths);
    if (!groups || groups->size() != 3 || lengths[0] > 2 || lengths[1] > 2) return std::nullopt;
    auto year = (*groups)[2];
    if (lengths[2] == 2) year += 2000;
    else if (lengths[2] != 4) return std::nullopt;
    return validDay(year, (*groups)[1], (*groups)[0]);
}

std::optional<std::string> parseTimeInput(const std::string &text) {
    const auto t = util::trim(text);
    if (t.empty()) return std::string();
    int hours = 0;
    int minutes = 0;
    std::vector<size_t> lengths;
    if (t.find(':') != std::string::npos || t.find('.') != std::string::npos) {
        const auto groups = digitGroups(t, ":.", lengths);
        if (!groups || groups->size() != 2 || lengths[0] > 2 || lengths[1] != 2) return std::nullopt;
        hours = (*groups)[0];
        minutes = (*groups)[1];
    } else {
        for (char c : t) {
            if (!util::isDigit(c)) return std::nullopt;
        }
        if (t.size() <= 2) {
            hours = std::stoi(t);
        } else if (t.size() == 4 || t.size() == 3) {
            hours = std::stoi(t.substr(0, t.size() - 2));
            minutes = std::stoi(t.substr(t.size() - 2));
        } else {
            return std::nullopt;
        }
    }
    if (hours > 23 || minutes > 59) return std::nullopt;
    return util::pad2(hours) + ":" + util::pad2(minutes);
}

std::string formatDayInput(const std::string &day) {
    if (!util::isDayKey(day)) return day;
    return day.substr(8, 2) + "." + day.substr(5, 2) + "." + day.substr(0, 4);
}

} // namespace parvane::sections::planner
