// Parvane fork (spec 029, фаза 4): здоровье в «Плане» — порт web `plannerHealth.ts` (без `applyQuickDraft`).
// Поведение — как в web; комментарии к функциям — в заголовке и в web-исходнике.
#include "parvane/sections/planner_health.h"

#include <algorithm>
#include <cmath>
#include <numbers>

#include "parvane/sections/planner_model.h"
#include "planner_util.h"

namespace parvane::sections::planner {

namespace {

using util::jsRound;

constexpr int kMinutesInHour = 60;
constexpr int kHalfDay = kMinutesInDay / 2;
const double kTurn = (2 * std::numbers::pi) / kMinutesInDay;
// Средний вектор короче этого — времена разбросаны по всему кругу, среднего нет
constexpr double kNoDirection = 1e-9;
constexpr int kSaturday = 6;
constexpr int kSleepRoutineOutliers = 3;
constexpr int kSleepJetlagMinNights = 2;
constexpr double kSleepWindowLow = 0.1;
constexpr double kSleepWindowHigh = 0.9;
const std::vector<int> kSleepAxisSteps = {kMinutesInHour, 2 * kMinutesInHour, 3 * kMinutesInHour,
                                          4 * kMinutesInHour};
constexpr int kSleepAxisMaxTicks = 8;
constexpr int kSleepAxisPad = 30;
constexpr int kSleepAxisEmptyFrom = -2 * kMinutesInHour;
constexpr int kSleepAxisEmptyTo = 8 * kMinutesInHour;

bool isKnown(const std::optional<double> &value) { return value && isKnownNumber(*value); }

// Сны дня по порядку данных
std::vector<HealthRecord> sleepsOf(const State &state, const std::string &day) {
    std::vector<HealthRecord> out;
    for (const auto &record : state.health) {
        if (record.kind == "sleep" && record.day == day) out.push_back(record);
    }
    return out;
}

struct CircularMean {
    double length = 0;
    double mean = 0;
};

CircularMean circularMean(const std::vector<double> &values) {
    double x = 0;
    double y = 0;
    for (const double value : values) {
        x += std::cos(value * kTurn);
        y += std::sin(value * kTurn);
    }
    const double length = std::min(1.0, std::hypot(x, y) / static_cast<double>(values.size()));
    return {length, length < kNoDirection ? values[0] : wrapClock(std::atan2(y, x) / kTurn)};
}

double quantile(const std::vector<double> &sorted, double share) {
    const double position = static_cast<double>(sorted.size() - 1) * share;
    const auto low = static_cast<size_t>(std::floor(position));
    const auto high = static_cast<size_t>(std::ceil(position));
    return sorted[low] + (sorted[high] - sorted[low]) * (position - static_cast<double>(low));
}

int roundInt(double value) { return static_cast<int>(jsRound(value)); }

} // namespace

std::string dailyRecordId(const std::string &kind, const std::string &day) { return kind + "-" + day; }

std::vector<HealthRecord> getSleepRecords(const State &state, const std::string &day) {
    return sleepsOf(state, day);
}

std::optional<HealthRecord> getDailyRecord(const State &state, const std::string &kind, const std::string &day) {
    if (kind == "sleep") {
        const auto list = sleepsOf(state, day);
        if (list.empty()) return std::nullopt;
        if (list.size() < 2) return list.front();
        // Сон дня — сумма снов; время «лёг → встал» — самого долгого (при равенстве — первого)
        const HealthRecord *main = &list.front();
        double sum = 0;
        for (const auto &item : list) {
            if (item.value > main->value) main = &item;
            sum += item.value;
        }
        HealthRecord out = *main;
        out.value = sum;
        return out;
    }
    for (const auto &record : state.health) {
        if (record.kind == kind && record.day == day) return record;
    }
    return std::nullopt;
}

std::optional<HealthRecord> getLatestRecord(const State &state, const std::string &kind, const std::string &day) {
    // Последний день не позже `day`; среди записей этого дня — первая по порядку данных
    const HealthRecord *best = nullptr;
    for (const auto &record : state.health) {
        if (record.kind != kind || record.day > day) continue;
        if (!best || record.day > best->day) best = &record;
    }
    if (!best) return std::nullopt;
    return *best;
}

std::vector<std::string> getLastDays(const std::string &day, int count) {
    std::vector<std::string> out;
    for (int index = 0; index < count; ++index) out.push_back(addDays(day, index - count + 1));
    return out;
}

std::vector<std::optional<double>> getDailySeries(const State &state, const std::string &kind,
                                                  const std::vector<std::string> &days) {
    std::vector<std::optional<double>> out;
    for (const auto &day : days) {
        const auto record = getDailyRecord(state, kind, day);
        out.push_back(record ? std::optional<double>(record->value) : std::nullopt);
    }
    return out;
}

std::vector<HealthRecord> getWorkouts(const State &state, const std::vector<std::string> &days) {
    std::vector<HealthRecord> out;
    for (const auto &record : state.health) {
        if (record.kind == "workout" && std::find(days.begin(), days.end(), record.day) != days.end()) {
            out.push_back(record);
        }
    }
    // Новые дни первыми; в дне — позднее время первым (время — `HH:MM`, сравнение строк = localeCompare)
    std::stable_sort(out.begin(), out.end(), [](const HealthRecord &a, const HealthRecord &b) {
        if (a.day != b.day) return a.day > b.day;
        return a.time.value_or("") > b.time.value_or("");
    });
    return out;
}

double sumActiveMinutes(const std::vector<HealthRecord> &workouts) {
    double sum = 0;
    for (const auto &record : workouts) sum += record.value;
    return sum;
}

double getActiveMinutes(const State &state, const std::vector<std::string> &days) {
    return sumActiveMinutes(getWorkouts(state, days));
}

std::optional<std::string> formatPace(double minutes, double km) {
    // `!minutes || !km`: ноль и NaN — нет темпа
    if (!(minutes != 0 && !std::isnan(minutes)) || !(km != 0 && !std::isnan(km))) return std::nullopt;
    const auto seconds = static_cast<long long>(jsRound((minutes * kMinutesInHour) / km));
    const long long mins = util::floorDiv(seconds, kMinutesInHour);
    long long secs = seconds % kMinutesInHour;
    // `%` в JS сохраняет знак делимого — как и в C++; отрицательного темпа на деле не бывает
    std::string rest = std::to_string(secs);
    if (rest.size() < 2) rest = "0" + rest;
    return std::to_string(mins) + ":" + rest;
}

double getLimitTotal(const State &state, const std::string &day, const std::string &nutrient) {
    const auto it = state.nutrition.find(day);
    if (it == state.nutrition.end()) return 0;
    double sum = 0;
    for (const auto &entry : it->second.entries) {
        const auto &value = nutrient == "sugar" ? entry.sugar : nutrient == "salt" ? entry.salt
                                                                                   : std::optional<double>();
        if (isKnown(value)) sum += *value;
    }
    return sum;
}

bool isShortSleep(const State &state, const std::string &day) {
    const auto sleep = getDailyRecord(state, "sleep", day);
    return sleep ? sleep->value < kShortSleepMinutes : false;
}

double getDayBudget(const State &state, const std::string &day) {
    return isShortSleep(state, day) ? jsRound(state.budget * kShortSleepBudgetFactor) : state.budget;
}

std::optional<int> getWakeMinutes(const State &state, const std::string &day) {
    const auto sleep = getDailyRecord(state, "sleep", day);
    if (!sleep || !sleep->endTime || sleep->endTime->empty()) return std::nullopt;
    return toMinutes(*sleep->endTime);
}

// ── режим сна ────────────────────────────────────────────────────────────────

double wrapClock(double minutes) {
    return std::fmod(std::fmod(minutes, kMinutesInDay) + kMinutesInDay, kMinutesInDay);
}

double clockDifference(double a, double b) { return wrapClock(a - b + kHalfDay) - kHalfDay; }

std::optional<int> parseClock(const std::optional<std::string> &time) {
    if (!time || time->empty()) return std::nullopt;
    const auto &text = *time;
    const auto colon = text.find(':');
    if (colon == std::string::npos || colon < 1 || colon > 2 || text.size() != colon + 3) return std::nullopt;
    for (size_t i = 0; i < text.size(); ++i) {
        if (i != colon && !util::isDigit(text[i])) return std::nullopt;
    }
    const int hours = std::stoi(text.substr(0, colon));
    const int minutes = std::stoi(text.substr(colon + 1));
    if (hours < 24 && minutes < kMinutesInHour) return hours * kMinutesInHour + minutes;
    return std::nullopt;
}

std::optional<SleepSpan> getSleepSpan(const std::optional<std::string> &time,
                                      const std::optional<std::string> &endTime) {
    const auto bed = parseClock(time);
    const auto wake = parseClock(endTime);
    if (!bed || !wake || *bed == *wake) return std::nullopt;
    return SleepSpan{*bed < *wake ? *bed : *bed - kMinutesInDay, *wake};
}

int getBedOffset(int clock) { return clock >= kHalfDay ? clock - kMinutesInDay : clock; }

SleepAxis getSleepAxis(const std::vector<double> &marks) {
    const double from = marks.empty() ? kSleepAxisEmptyFrom
                                      : *std::min_element(marks.begin(), marks.end()) - kSleepAxisPad;
    const double to = marks.empty() ? kSleepAxisEmptyTo
                                    : *std::max_element(marks.begin(), marks.end()) + kSleepAxisPad;
    int step = kSleepAxisSteps.back();
    for (const int value : kSleepAxisSteps) {
        if ((to - from) / value <= kSleepAxisMaxTicks) {
            step = value;
            break;
        }
    }
    SleepAxis axis;
    axis.step = step;
    axis.low = static_cast<int>(std::floor(from / step) * step);
    axis.high = static_cast<int>(std::ceil(to / step) * step);
    for (int index = 0; index <= (axis.high - axis.low) / step; ++index) axis.ticks.push_back(axis.low + index * step);
    return axis;
}

std::optional<double> getClockGoal(const std::optional<double> &value) {
    if (isKnown(value) && *value < kMinutesInDay) return value;
    return std::nullopt;
}

std::optional<SleepClockStat> getClockStat(const std::vector<double> &values) {
    if (values.empty()) return std::nullopt;
    const auto [length, mean] = circularMean(values);
    // У одинаковых времён длина вектора — единица: логарифм даёт «минус ноль», его и убирает max
    const double spread = length < kNoDirection
        ? kHalfDay
        : std::min<double>(kHalfDay, std::sqrt(std::max(0.0, -2 * std::log(length))) / kTurn);
    std::vector<double> deviations;
    for (const double value : values) deviations.push_back(clockDifference(value, mean));
    std::sort(deviations.begin(), deviations.end());
    return SleepClockStat{
        static_cast<int>(wrapClock(jsRound(mean))),
        roundInt(spread),
        static_cast<int>(wrapClock(jsRound(mean + quantile(deviations, kSleepWindowLow)))),
        static_cast<int>(wrapClock(jsRound(mean + quantile(deviations, kSleepWindowHigh)))),
    };
}

std::string getSleepRoutineLevel(const std::optional<int> &spread) {
    if (!spread) return "none";
    if (*spread <= kSleepRoutineStableSpread) return "stable";
    return *spread <= kSleepRoutineDriftingSpread ? "drifting" : "broken";
}

SleepRoutine getSleepRoutine(const State &state, const std::string &day, int count) {
    SleepRoutine routine;
    routine.days = getLastDays(day, count);
    for (const auto &key : routine.days) {
        const auto record = getDailyRecord(state, "sleep", key);
        if (!record) continue;
        const auto bed = parseClock(record->time);
        const auto wake = parseClock(record->endTime);
        SleepNight night;
        night.day = key;
        night.minutes = record->value;
        if (bed && wake && *bed != *wake) {
            night.bed = bed;
            night.wake = wake;
            night.midpoint = wrapClock(*bed + wrapClock(*wake - *bed) / 2);
        }
        routine.nights.push_back(night);
    }
    std::vector<size_t> timed;
    std::vector<double> midpoints;
    for (size_t i = 0; i < routine.nights.size(); ++i) {
        if (!routine.nights[i].bed) continue;
        timed.push_back(i);
        midpoints.push_back(*routine.nights[i].midpoint);
    }
    routine.timedCount = static_cast<int>(timed.size());
    routine.untimedCount = static_cast<int>(routine.nights.size() - timed.size());
    if (!timed.empty()) routine.center = static_cast<int>(wrapClock(jsRound(circularMean(midpoints).mean)));
    if (routine.timedCount < kSleepRoutineMinNights) return routine;

    std::vector<double> beds;
    std::vector<double> wakes;
    for (const auto i : timed) {
        beds.push_back(*routine.nights[i].bed);
        wakes.push_back(*routine.nights[i].wake);
    }
    // Отклонения — от неокруглённого среднего: иначе у одинаковых ночей появляется лишняя минута
    const double bedMean = circularMean(beds).mean;
    const double wakeMean = circularMean(wakes).mean;
    for (const auto i : timed) {
        auto &night = routine.nights[i];
        night.bedDeviation = roundInt(clockDifference(*night.bed, bedMean));
        night.wakeDeviation = roundInt(clockDifference(*night.wake, wakeMean));
        night.deviation = std::max(std::abs(*night.bedDeviation), std::abs(*night.wakeDeviation));
    }
    routine.bed = getClockStat(beds);
    routine.wake = getClockStat(wakes);
    const int spread = std::max(routine.bed->spread, routine.wake->spread);
    routine.level = getSleepRoutineLevel(spread);
    routine.midpoint = getClockStat(midpoints);
    routine.spread = spread;

    // Ночь относится ко дню подъёма: выходные — ночи на субботу и на воскресенье
    std::vector<double> free;
    std::vector<double> work;
    std::vector<SleepNight> outliers;
    for (const auto i : timed) {
        const auto &night = routine.nights[i];
        (weekdayOf(night.day) % kSaturday == 0 ? free : work).push_back(*night.midpoint);
        if (*night.deviation > kSleepRoutineStableSpread) outliers.push_back(night);
    }
    std::stable_sort(outliers.begin(), outliers.end(), [](const SleepNight &a, const SleepNight &b) {
        if (*a.deviation != *b.deviation) return *a.deviation > *b.deviation;
        return a.day > b.day;
    });
    if (outliers.size() > kSleepRoutineOutliers) outliers.resize(kSleepRoutineOutliers);
    routine.outliers = outliers;
    if (free.size() >= kSleepJetlagMinNights && work.size() >= kSleepJetlagMinNights) {
        routine.socialJetlag = roundInt(clockDifference(circularMean(free).mean, circularMean(work).mean));
    }
    const auto goalBed = getClockGoal(state.healthGoals.bedtime);
    const auto goalWake = getClockGoal(state.healthGoals.wakeTime);
    if (goalBed) routine.bedGoalDeviation = roundInt(clockDifference(bedMean, *goalBed));
    if (goalWake) routine.wakeGoalDeviation = roundInt(clockDifference(wakeMean, *goalWake));
    return routine;
}

} // namespace parvane::sections::planner
