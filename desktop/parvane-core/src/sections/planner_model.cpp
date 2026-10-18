// Parvane fork (spec 029, фаза 4): модель «Плана» — порт web `plannerModel.ts`, слоёв и подписей без Intl.
// Поведение — как в web (комментарии к функциям — в заголовке и в web-исходнике).
#include "parvane/sections/planner_model.h"

#include <algorithm>
#include <cfloat>
#include <climits>
#include <cmath>
#include <cstdio>
#include <limits>
#include <random>
#include <type_traits>

#include "planner_util.h"

namespace parvane::sections::planner {

namespace {

using util::floorDiv;
using util::pad2;

constexpr int kSlotSearchDays = 7;
constexpr int kSlotAnswers = 3;
// Высота заголовка блока в минутах сетки: дело, начавшееся в этих пределах, заголовок перекрыло бы
constexpr int kTitleMinutes = 40;

// ── календарь без часового пояса ─────────────────────────────────────────────

// Дни от 1970-01-01 (H. Hinnant, days_from_civil)
long long daysFromCivil(long long y, long long m, long long d) {
    y -= m <= 2;
    const long long era = (y >= 0 ? y : y - 399) / 400;
    const long long yoe = y - era * 400;
    const long long doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    const long long doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + doe - 719468;
}

struct Parts {
    long long year = 0;
    int month = 0;
    int date = 0;
};

Parts civilFromDays(long long z) {
    z += 719468;
    const long long era = (z >= 0 ? z : z - 146096) / 146097;
    const long long doe = z - era * 146097;
    const long long yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    const long long y = yoe + era * 400;
    const long long doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    const long long mp = (5 * doy + 2) / 153;
    const long long d = doy - (153 * mp + 2) / 5 + 1;
    const long long m = mp + (mp < 10 ? 3 : -9);
    return {y + (m <= 2), static_cast<int>(m), static_cast<int>(d)};
}

// `Math.floor(Date.UTC(year, month - 1, date) / MS_IN_DAY)`: месяц и число переносятся, годы 0…99 — 19xx
long long epochOf(long long year, long long month, long long date) {
    if (year >= 0 && year <= 99) year += 1900;
    long long m0 = month - 1;
    year += floorDiv(m0, 12);
    m0 -= floorDiv(m0, 12) * 12;
    return daysFromCivil(year, m0 + 1, 1) + (date - 1);
}

Parts parts(const std::string &day) {
    const auto chunks = util::split(day, '-');
    auto num = [&](size_t i) {
        if (i >= chunks.size()) return 0LL;
        const double v = util::numberOf(chunks[i]);
        return std::isfinite(v) ? static_cast<long long>(v) : 0LL;
    };
    return {num(0), static_cast<int>(num(1)), static_cast<int>(num(2))};
}

long long epochDays(const std::string &day) {
    const auto p = parts(day);
    return epochOf(p.year, p.month, p.date);
}

std::string keyOfEpoch(long long epoch) {
    const auto p = civilFromDays(epoch);
    return std::to_string(p.year) + "-" + pad2(p.month) + "-" + pad2(p.date);
}

// Номер недели с понедельника
long long weekIndexOfEpoch(long long epoch) { return floorDiv(epoch + 3, 7); }
// Понедельник недели с таким номером
long long mondayOfWeek(long long week) { return week * 7 - 3; }
// День недели как `Date.getDay` (1970-01-01 — четверг)
int weekdayOfEpoch(long long epoch) { return static_cast<int>(((epoch + 4) % 7 + 7) % 7); }

int daysInMonth(long long year, long long month) {
    return civilFromDays(epochOf(year, month + 1, 0)).date;
}

// Позиция дня недели при неделе с понедельника
int mondayBased(int weekday) { return (weekday + 6) % 7; }

// `1 << n` как в JS (сдвиг по модулю 32)
unsigned bitOf(int n) { return 1u << (((n % 32) + 32) % 32); }

bool truthy(const std::optional<std::string> &value) { return value && !value->empty(); }

// ── правило повтора, разобранное один раз ────────────────────────────────────

struct CompiledRepeat {
    std::string kind;
    int interval = 1;
    bool isValid = false;
    std::optional<long long> start;
    std::optional<long long> end;
    std::optional<int> count;
    std::vector<int> positions;
    unsigned weekdayMask = 0;
    long long startWeek = 0;
    int skippedInFirstWeek = 0;
    long long startYear = 0;
    int startMonth = 0;
    int startDate = 0;
    int monthDay = 0;
};

CompiledRepeat compileRepeat(const Repeat &repeat) {
    CompiledRepeat rule;
    rule.kind = repeat.kind;
    rule.interval = repeat.interval;
    rule.isValid = repeat.interval >= 1;
    if (!repeat.startDay.empty()) rule.start = epochDays(repeat.startDay);
    std::vector<int> unique;
    for (int w : repeat.weekdays.value_or(std::vector<int>())) {
        if (std::find(unique.begin(), unique.end(), w) == unique.end()) unique.push_back(w);
    }
    for (int w : unique) rule.positions.push_back(mondayBased(w));
    std::sort(rule.positions.begin(), rule.positions.end());
    const int startPosition = rule.start ? mondayBased(weekdayOfEpoch(*rule.start)) : 0;
    Parts startParts;
    if (!repeat.startDay.empty()) startParts = parts(repeat.startDay);
    if (truthy(repeat.endDay)) rule.end = epochDays(*repeat.endDay);
    if (repeat.count && *repeat.count) rule.count = repeat.count;
    for (int position : rule.positions) rule.weekdayMask |= bitOf((position + 1) % 7);
    rule.startWeek = rule.start ? weekIndexOfEpoch(*rule.start) : 0;
    if (rule.start) {
        for (int position : rule.positions) {
            if (position < startPosition) ++rule.skippedInFirstWeek;
        }
    }
    rule.startYear = startParts.year;
    rule.startMonth = startParts.month;
    rule.startDate = startParts.date;
    rule.monthDay = repeat.monthDay && *repeat.monthDay ? *repeat.monthDay : startParts.date;
    return rule;
}

// Порядковый номер экземпляра (с 1) без учёта исключений; `nullopt` — в этот день экземпляра нет
std::optional<long long> ordinalOfEpoch(const CompiledRepeat &rule, long long epoch) {
    if (!rule.isValid) return std::nullopt;
    if (rule.start && epoch < *rule.start) return std::nullopt;
    if (rule.end && epoch > *rule.end) return std::nullopt;
    const long long interval = rule.interval;
    if (rule.kind == "weekly") {
        const int weekday = weekdayOfEpoch(epoch);
        if (!(rule.weekdayMask & bitOf(weekday))) return std::nullopt;
        if (!rule.start) return 1;
        const long long weeks = weekIndexOfEpoch(epoch) - rule.startWeek;
        if (weeks % interval != 0) return std::nullopt;
        const auto it = std::find(rule.positions.begin(), rule.positions.end(), mondayBased(weekday));
        const long long index = it - rule.positions.begin();
        return (weeks / interval) * static_cast<long long>(rule.positions.size()) + index + 1
            - rule.skippedInFirstWeek;
    }
    if (!rule.start) return std::nullopt;
    if (rule.kind == "daily") {
        const long long diff = epoch - *rule.start;
        return diff % interval == 0 ? std::optional<long long>(diff / interval + 1) : std::nullopt;
    }
    const auto d = civilFromDays(epoch);
    if (rule.kind == "monthly") {
        const long long months = (d.year * 12 + d.month) - (rule.startYear * 12 + rule.startMonth);
        if (months % interval != 0) return std::nullopt;
        const int wanted = std::min(rule.monthDay, daysInMonth(d.year, d.month));
        return d.date == wanted ? std::optional<long long>(months / interval + 1) : std::nullopt;
    }
    const long long years = d.year - rule.startYear;
    if (years % interval != 0 || d.month != rule.startMonth) return std::nullopt;
    const int wanted = std::min(rule.startDate, daysInMonth(d.year, d.month));
    return d.date == wanted ? std::optional<long long>(years / interval + 1) : std::nullopt;
}

bool occursOnEpoch(const CompiledRepeat &rule, long long epoch) {
    const auto ordinal = ordinalOfEpoch(rule, epoch);
    if (!ordinal) return false;
    return !rule.count || *ordinal <= *rule.count;
}

// Дни ряда в промежутке по порядку шагом правила; `visit` возвращает `true`, чтобы остановить обход
template <typename Visit>
void forEachRepeatDay(const Repeat &repeat, const std::string &fromDay, const std::string &toDay, Visit &&visit) {
    const auto rule = compileRepeat(repeat);
    if (!rule.isValid || fromDay > toDay) return;
    const long long from = epochDays(fromDay);
    const long long to = epochDays(toDay);
    const long long lo = rule.start ? std::max(from, *rule.start) : from;
    const long long hi = rule.end ? std::min(to, *rule.end) : to;
    if (lo > hi) return;
    const long long interval = rule.interval;
    // `false` — обход остановлен
    auto emit = [&](long long epoch, long long ordinal) {
        if (rule.count && ordinal > *rule.count) return false;
        if (epoch > hi) return false;
        if (epoch < lo) return true;
        return !visit(keyOfEpoch(epoch));
    };
    if (rule.kind == "weekly") {
        if (!rule.start) {
            for (long long epoch = lo; epoch <= hi; ++epoch) {
                if ((rule.weekdayMask & bitOf(weekdayOfEpoch(epoch))) && visit(keyOfEpoch(epoch))) return;
            }
            return;
        }
        const long long firstWeek = weekIndexOfEpoch(lo);
        const long long skip = -floorDiv(-(firstWeek - rule.startWeek), interval);
        for (long long week = rule.startWeek + skip * interval;; week += interval) {
            const long long monday = mondayOfWeek(week);
            if (monday > hi) return;
            const long long base = ((week - rule.startWeek) / interval) * static_cast<long long>(rule.positions.size())
                + 1 - rule.skippedInFirstWeek;
            for (size_t index = 0; index < rule.positions.size(); ++index) {
                if (!emit(monday + rule.positions[index], base + static_cast<long long>(index))) return;
            }
        }
    }
    if (!rule.start) return;
    const long long start = *rule.start;
    if (rule.kind == "daily") {
        const long long skip = -floorDiv(-(lo - start), interval);
        long long epoch = start + skip * interval;
        for (long long ordinal = skip + 1; emit(epoch, ordinal); ++ordinal) epoch += interval;
        return;
    }
    const auto loParts = civilFromDays(lo);
    if (rule.kind == "monthly") {
        const long long startIndex = rule.startYear * 12 + rule.startMonth - 1;
        const long long skip = std::max(0LL, -floorDiv(-(loParts.year * 12 + loParts.month - 1 - startIndex), interval));
        for (long long step = skip;; ++step) {
            const long long index = startIndex + step * interval;
            const long long year = floorDiv(index, 12);
            const long long month = index - year * 12 + 1;
            const long long epoch = epochOf(year, month, std::min(rule.monthDay, daysInMonth(year, month)));
            if (!emit(epoch, step + 1)) return;
        }
    }
    const long long skip = std::max(0LL, -floorDiv(-(loParts.year - rule.startYear), interval));
    for (long long step = skip;; ++step) {
        const long long year = rule.startYear + step * interval;
        const long long epoch = epochOf(year, rule.startMonth,
                                        std::min(rule.startDate, daysInMonth(year, rule.startMonth)));
        if (!emit(epoch, step + 1)) return;
    }
}

// ── записи рядов (общее для задач и событий) ─────────────────────────────────

template <typename T>
const Occurrence *occurrenceOf(const T &item, const std::string &day) {
    if (!item.occurrences) return nullptr;
    for (const auto &o : *item.occurrences) {
        if (o.day == day) return &o;
    }
    return nullptr;
}

bool isExcluded(const Occurrence *o) { return o && o->excluded.value_or(false); }

template <typename T>
std::vector<std::string> instancesOf(const T &item, const std::string &fromDay, const std::string &toDay) {
    std::vector<std::string> days;
    if (!item.repeat) return days;
    forEachRepeatDay(*item.repeat, fromDay, toDay, [&](const std::string &day) {
        if (!isExcluded(occurrenceOf(item, day))) days.push_back(day);
        return false;
    });
    return days;
}

template <typename T>
bool instanceOn(const T &item, const std::string &day) {
    if (!item.repeat) return false;
    return occursOn(*item.repeat, day) && !isExcluded(occurrenceOf(item, day));
}

template <typename T>
std::string keyOf(const T &item) {
    return truthy(item.instanceDay) ? item.id + "@" + *item.instanceDay : item.id;
}

template <typename T>
T stripSeries(T item) {
    item.repeat.reset();
    item.occurrences.reset();
    item.instanceDay.reset();
    return item;
}

template <typename T>
std::vector<T> &itemsOf(State &state);
template <>
std::vector<Task> &itemsOf<Task>(State &state) { return state.tasks; }
template <>
std::vector<Event> &itemsOf<Event>(State &state) { return state.events; }

template <typename T>
T *findIn(std::vector<T> &items, const std::string &id) {
    for (auto &item : items) {
        if (item.id == id) return &item;
    }
    return nullptr;
}

bool byDay(const Occurrence &a, const Occurrence &b) { return a.day < b.day; }

template <typename T>
bool setOccurrenceIn(T &item, const std::string &day, const OccurrencePatch &patch) {
    auto occurrences = item.occurrences.value_or(std::vector<Occurrence>());
    auto it = std::find_if(occurrences.begin(), occurrences.end(), [&](const Occurrence &o) { return o.day == day; });
    Occurrence next = it != occurrences.end() ? *it : Occurrence{};
    next.day = day;
    if (patch.excluded) next.excluded = patch.excluded;
    if (patch.done) next.done = patch.done;
    if (patch.doneSteps) next.doneSteps = patch.doneSteps;
    if (it != occurrences.end()) *it = next;
    else occurrences.push_back(next);
    std::stable_sort(occurrences.begin(), occurrences.end(), byDay);
    item.occurrences = occurrences;
    return true;
}

// Число экземпляров ряда до дня (для переноса `count` при разделении)
long long instancesBefore(const Repeat &repeat, const std::string &day) {
    if (repeat.startDay.empty()) return 0;
    return static_cast<long long>(expandRepeat(repeat, repeat.startDay, addDays(day, -1)).size());
}

// День с числом `date` через `months` месяцев от месяца дня; в коротком месяце — последний день
std::string moveToMonth(const std::string &day, long long months, int date) {
    const auto d = parts(day);
    const long long index = d.year * 12 + d.month - 1 + months;
    const long long year = floorDiv(index, 12);
    const long long month = index - year * 12 + 1;
    const int clamped = std::min(date, daysInMonth(year, month));
    return std::to_string(year) + "-" + pad2(month) + "-" + pad2(clamped);
}

template <typename T>
void shiftSeries(T &item, const std::string &fromDay, const std::string &toDay) {
    const Repeat repeat = *item.repeat;
    const bool isByMonth = repeat.kind == "monthly" || repeat.kind == "yearly";
    const long long days = epochDays(toDay) - epochDays(fromDay);
    const auto from = parts(fromDay);
    const auto to = parts(toDay);
    const long long months = (to.year - from.year) * 12 + to.month - from.month;
    auto move = [&](const std::string &value) {
        return isByMonth ? moveToMonth(value, months, to.date) : addDays(value, days);
    };
    Repeat next = repeat;
    next.startDay = repeat.startDay.empty() ? repeat.startDay : move(repeat.startDay);
    if (repeat.kind == "weekly" && repeat.weekdays) {
        std::vector<int> weekdays;
        for (int weekday : *repeat.weekdays) {
            weekdays.push_back(static_cast<int>(((weekday + days) % 7 + 7) % 7));
        }
        next.weekdays = weekdays;
    }
    if (repeat.kind == "monthly") next.monthDay = to.date;
    if (truthy(repeat.endDay)) {
        const auto moved = move(*repeat.endDay);
        // Экземпляр месяца, на который пришёлся конец, остаётся в ряду, только если он там был
        const auto monthStart = repeat.endDay->substr(0, 8) + "01";
        const bool keepsLast = !isByMonth || !expandRepeat(repeat, monthStart, *repeat.endDay).empty();
        next.endDay = keepsLast ? moved : addDays(moved.substr(0, 8) + "01", -1);
    }
    if (item.occurrences) {
        std::vector<Occurrence> moved;
        for (auto occurrence : *item.occurrences) {
            occurrence.day = move(occurrence.day);
            if (occursOn(next, occurrence.day)) moved.push_back(occurrence);
        }
        std::stable_sort(moved.begin(), moved.end(), byDay);
        item.occurrences = moved;
    }
    item.repeat = next;
}

// События на весь день — первыми, остальные — по началу (web — `localeCompare`; у `HH:MM` совпадает с байтами)
bool compareEvents(const Event &a, const Event &b) {
    const bool aAll = a.isAllDay.value_or(false);
    const bool bAll = b.isAllDay.value_or(false);
    if (aAll != bAll) return aAll;
    return a.start < b.start;
}

void sortEvents(std::vector<Event> &events) { std::stable_sort(events.begin(), events.end(), compareEvents); }

void sortTimed(std::vector<Timed> &timed) {
    std::stable_sort(timed.begin(), timed.end(), [](const Timed &a, const Timed &b) { return a.start < b.start; });
}

Timed timedOf(const std::string &name, const std::string &start, const std::string &end,
              const std::optional<Task> &task, const std::optional<Event> &event) {
    return {name, start, end, task, event};
}

int countTimedConflicts(const std::vector<Timed> &timed) {
    std::vector<std::pair<int, int>> spans;
    for (const auto &item : timed) spans.emplace_back(toMinutes(item.start), toMinutes(item.end));
    int count = 0;
    for (size_t i = 0; i < spans.size(); ++i) {
        for (size_t j = i + 1; j < spans.size(); ++j) {
            if (spans[i].first < spans[j].second && spans[j].first < spans[i].second) ++count;
        }
    }
    return count;
}

int eventMinutes(const Event &event) { return toMinutes(event.end) - toMinutes(event.start); }

bool hasStartAndMinutes(const Task &task) { return truthy(task.start) && task.minutes.has_value(); }

DayIndex buildDayIndex(const State &state, const std::string &fromDay, const std::string &toDay) {
    DayIndex index;
    auto isInside = [&](const std::optional<std::string> &day) {
        return truthy(day) && *day >= fromDay && *day <= toDay;
    };
    for (const auto &task : state.tasks) {
        const auto days = task.repeat ? instancesOf(task, fromDay, toDay)
                                      : (isInside(task.day) ? std::vector<std::string>{*task.day}
                                                            : std::vector<std::string>());
        for (const auto &day : days) {
            auto &entry = index[day];
            entry.tasks.push_back(task.repeat ? taskInstance(task, day) : task);
            entry.minutes += task.minutes.value_or(0);
        }
        if (!task.repeat && task.status != "done" && isInside(task.due)) index[*task.due].deadlines.push_back(task);
    }
    for (const auto &event : state.events) {
        const auto days = event.repeat ? instancesOf(event, fromDay, toDay)
                                       : (isInside(event.day) ? std::vector<std::string>{*event.day}
                                                              : std::vector<std::string>());
        for (const auto &day : days) {
            auto &entry = index[day];
            entry.events.push_back(event.repeat ? eventInstance(event, day) : event);
            if (event.isHoliday.value_or(false)) entry.isHoliday = true;
            if (!event.isAllDay.value_or(false)) entry.minutes += eventMinutes(event);
        }
    }
    for (auto &[day, entry] : index) {
        sortEvents(entry.events);
        for (const auto &event : entry.events) {
            if (event.isHoliday.value_or(false)) {
                entry.holiday = event;
                break;
            }
        }
        for (const auto &event : entry.events) {
            if (event.isAllDay.value_or(false)) entry.allDay.push_back(event);
        }
        entry.timed.clear();
        for (const auto &event : entry.events) {
            if (!event.isAllDay.value_or(false)) {
                entry.timed.push_back(timedOf(event.name, event.start, event.end, std::nullopt, event));
            }
        }
        for (const auto &task : entry.tasks) {
            if (hasStartAndMinutes(task)) {
                entry.timed.push_back(timedOf(task.name, *task.start,
                                              toTime(toMinutes(*task.start) + *task.minutes), task, std::nullopt));
            }
        }
        sortTimed(entry.timed);
        for (const auto &task : entry.tasks) {
            if (!hasStartAndMinutes(task)) entry.untimed.push_back(task);
            if (!task.minutes) ++entry.unrated;
        }
        entry.conflicts = countTimedConflicts(entry.timed);
    }
    return index;
}

// ── чтение JSON сохранённого состояния ───────────────────────────────────────

const json *member(const json &object, const char *key) {
    if (!object.is_object()) return nullptr;
    const auto it = object.find(key);
    return it == object.end() ? nullptr : &*it;
}

// Истинность значения, как в JS
bool truthyJson(const json *value) {
    if (!value) return false;
    switch (value->type()) {
    case json::value_t::boolean:
        return value->get<bool>();
    case json::value_t::number_integer:
    case json::value_t::number_unsigned:
    case json::value_t::number_float: {
        const double v = value->get<double>();
        return v != 0 && !std::isnan(v);
    }
    case json::value_t::string:
        return !value->get_ref<const std::string &>().empty();
    case json::value_t::object:
    case json::value_t::array:
    case json::value_t::binary:
        return true;
    default:
        return false;
    }
}

bool isString(const json *value) { return value && value->is_string(); }
std::string stringOf(const json *value) { return isString(value) ? value->get<std::string>() : std::string(); }
bool isNumber(const json *value) { return value && value->is_number(); }
double numberOfJson(const json *value) { return value->get<double>(); }
bool isFiniteJson(const json *value) { return isNumber(value) && std::isfinite(numberOfJson(value)); }
bool isKnownJson(const json *value) { return isFiniteJson(value) && numberOfJson(value) >= 0; }
bool isIntegerJson(const json *value) {
    if (!isFiniteJson(value)) return false;
    const double v = numberOfJson(value);
    return std::floor(v) == v;
}
// Целое число из JSON в пределах `int` (вне пределов — ближайшая граница)
int intOf(const json *value) {
    const double v = numberOfJson(value);
    if (v >= static_cast<double>(INT_MAX)) return INT_MAX;
    if (v <= static_cast<double>(INT_MIN)) return INT_MIN;
    return static_cast<int>(v);
}
bool isDayJson(const json *value) { return isString(value) && util::isDayKey(value->get<std::string>()); }
bool isTimeJson(const json *value) { return isString(value) && util::isTimeKey(value->get<std::string>()); }
std::optional<double> optNumber(const json *value) {
    return isNumber(value) ? std::optional<double>(numberOfJson(value)) : std::nullopt;
}
std::optional<std::string> optString(const json *value) {
    return isString(value) ? std::optional<std::string>(value->get<std::string>()) : std::nullopt;
}

bool isId(const json *value) {
    if (isString(value)) {
        const auto n = util::utf16Length(value->get<std::string>());
        return n > 0 && n <= 64;
    }
    return isIntegerJson(value);
}

// `String(id)`
std::string idOf(const json *value) {
    if (isString(value)) return value->get<std::string>();
    if (value->is_number_integer()) return std::to_string(value->get<long long>());
    if (value->is_number_unsigned()) return std::to_string(value->get<unsigned long long>());
    char buf[64];
    std::snprintf(buf, sizeof buf, "%.0f", value->get<double>());
    return buf;
}

std::vector<Step> stepsOf(const json *raw) {
    std::vector<Step> steps;
    if (!raw || !raw->is_array()) return steps;
    for (const auto &step : *raw) {
        if (!truthyJson(&step) || !isString(member(step, "text"))) continue;
        steps.push_back({member(step, "text")->get<std::string>(), truthyJson(member(step, "isDone"))});
    }
    return steps;
}

struct SeriesParts {
    std::optional<Repeat> repeat;
    std::optional<std::vector<Occurrence>> occurrences;
    std::optional<Origin> origin;
    std::optional<Source> source;
};

// Правило повтора, экземпляры и происхождение из сохранённого объекта (негодное отбрасывается)
SeriesParts normalizeSeries(const json &raw) {
    SeriesParts out;
    const json *r = member(raw, "repeat");
    const json *kind = r ? member(*r, "kind") : nullptr;
    if (r && r->is_object() && isString(kind)
        && std::find(kRepeatKinds.begin(), kRepeatKinds.end(), kind->get<std::string>()) != kRepeatKinds.end()) {
        const json *interval = member(*r, "interval");
        const json *monthDay = member(*r, "monthDay");
        const json *count = member(*r, "count");
        const double intervalValue = isKnownJson(interval) ? numberOfJson(interval) : 1;
        const bool hasMonthDay = isKnownJson(monthDay) && numberOfJson(monthDay) > 0;
        const bool hasCount = isKnownJson(count) && numberOfJson(count) > 0;
        // Дробные и огромные значения правило не пропускает (`validateRepeat` требует целые в пределах)
        auto fitsInt = [](double v) { return std::floor(v) == v && v <= 1e6; };
        if (fitsInt(intervalValue) && (!hasMonthDay || fitsInt(numberOfJson(monthDay)))
            && (!hasCount || fitsInt(numberOfJson(count)))) {
            Repeat repeat;
            repeat.kind = kind->get<std::string>();
            repeat.interval = static_cast<int>(intervalValue);
            const json *weekdays = member(*r, "weekdays");
            if (weekdays && weekdays->is_array()) {
                std::vector<int> days;
                for (const auto &d : *weekdays) {
                    if (isIntegerJson(&d) && d.get<double>() >= 0 && d.get<double>() <= 6) {
                        days.push_back(static_cast<int>(d.get<double>()));
                    }
                }
                repeat.weekdays = days;
            }
            if (hasMonthDay) repeat.monthDay = static_cast<int>(numberOfJson(monthDay));
            repeat.startDay = isDayJson(member(*r, "startDay")) ? member(*r, "startDay")->get<std::string>() : "";
            if (isDayJson(member(*r, "endDay"))) repeat.endDay = member(*r, "endDay")->get<std::string>();
            if (hasCount) repeat.count = static_cast<int>(numberOfJson(count));
            if (!validateRepeat(repeat)) out.repeat = repeat;
        }
    }
    const json *occurrences = member(raw, "occurrences");
    if (occurrences && occurrences->is_array()) {
        std::vector<Occurrence> list;
        for (const auto &o : *occurrences) {
            if (!truthyJson(&o) || !isDayJson(member(o, "day"))) continue;
            Occurrence occurrence;
            occurrence.day = member(o, "day")->get<std::string>();
            occurrence.excluded = truthyJson(member(o, "excluded"));
            occurrence.done = truthyJson(member(o, "done"));
            std::vector<int> steps;
            const json *doneSteps = member(o, "doneSteps");
            if (doneSteps && doneSteps->is_array()) {
                for (const auto &i : *doneSteps) {
                    if (isIntegerJson(&i) && i.get<double>() >= 0) steps.push_back(intOf(&i));
                }
            }
            occurrence.doneSteps = steps;
            list.push_back(occurrence);
        }
        if (!list.empty()) out.occurrences = list;
    }
    const json *origin = member(raw, "origin");
    const json *seriesId = origin ? member(*origin, "seriesId") : nullptr;
    if (truthyJson(origin) && isString(seriesId) && !seriesId->get<std::string>().empty()) {
        const json *day = member(*origin, "day");
        out.origin = Origin{seriesId->get<std::string>(), isDayJson(day) ? day->get<std::string>() : ""};
    }
    const json *source = member(raw, "source");
    const json *opId = source ? member(*source, "opId") : nullptr;
    if (truthyJson(source) && isString(opId) && !opId->get<std::string>().empty()) {
        out.source = Source{stringOf(member(*source, "chat")), opId->get<std::string>()};
    }
    return out;
}

std::optional<GoalValues> normalizeGoalValues(const json *raw) {
    if (!truthyJson(raw) || !(raw->is_object() || raw->is_array())) return std::nullopt;
    GoalValues out;
    for (const auto &metric : kGoalMetrics) {
        const json *goal = member(*raw, metric.c_str());
        if (!truthyJson(goal)) continue;
        const json *target = member(*goal, "target");
        const json *tolerance = member(*goal, "tolerance");
        if (!isNumber(target) || !isNumber(tolerance)) continue;
        const Goal value{numberOfJson(target), numberOfJson(tolerance)};
        if (validateGoal(value, metric == "kcal" || metric == "water")) out[metric] = value;
    }
    return out;
}

// `{ kcal: legacyKcal, ...legacyRest }`, если хоть одно из них есть
std::optional<json> legacyGoals(const json *kcal, const json *rest) {
    if (!truthyJson(kcal) && !truthyJson(rest)) return std::nullopt;
    json combined = json::object();
    if (kcal) combined["kcal"] = *kcal;
    if (rest && rest->is_object()) {
        for (auto it = rest->begin(); it != rest->end(); ++it) combined[it.key()] = it.value();
    }
    return combined;
}

FoodEntry foodOf(const json &raw) {
    FoodEntry entry;
    entry.name = stringOf(member(raw, "name"));
    entry.meal = stringOf(member(raw, "meal"));
    entry.kcal = numberOfJson(member(raw, "kcal"));
    entry.protein = optNumber(member(raw, "protein"));
    entry.fat = optNumber(member(raw, "fat"));
    entry.carbs = optNumber(member(raw, "carbs"));
    entry.fiber = optNumber(member(raw, "fiber"));
    entry.grams = optNumber(member(raw, "grams"));
    entry.sugar = optNumber(member(raw, "sugar"));
    entry.salt = optNumber(member(raw, "salt"));
    entry.time = optString(member(raw, "time"));
    const json *per100 = member(raw, "per100");
    if (per100 && per100->is_object()) {
        NutrientMap values;
        for (auto it = per100->begin(); it != per100->end(); ++it) {
            if (it.value().is_number()) values[it.key()] = it.value().get<double>();
        }
        entry.per100 = values;
    }
    return entry;
}

HealthRecord healthOf(const json &raw) {
    HealthRecord record;
    record.id = stringOf(member(raw, "id"));
    record.day = stringOf(member(raw, "day"));
    record.kind = stringOf(member(raw, "kind"));
    record.value = numberOfJson(member(raw, "value"));
    record.time = optString(member(raw, "time"));
    record.endTime = optString(member(raw, "endTime"));
    record.value2 = optNumber(member(raw, "value2"));
    record.name = optString(member(raw, "name"));
    const json *exercises = member(raw, "exercises");
    if (exercises && exercises->is_array()) {
        std::vector<Exercise> list;
        for (const auto &e : *exercises) {
            if (!e.is_object()) continue;
            list.push_back({stringOf(member(e, "name")), optNumber(member(e, "sets")), optNumber(member(e, "reps")),
                            optNumber(member(e, "weight"))});
        }
        record.exercises = list;
    }
    return record;
}

HealthGoals healthGoalsOf(const json &raw) {
    HealthGoals goals;
    goals.sugarMax = optNumber(member(raw, "sugarMax"));
    goals.saltMax = optNumber(member(raw, "saltMax"));
    goals.sleepMinutes = optNumber(member(raw, "sleepMinutes"));
    goals.bedtime = optNumber(member(raw, "bedtime"));
    goals.wakeTime = optNumber(member(raw, "wakeTime"));
    goals.weight = optNumber(member(raw, "weight"));
    goals.steps = optNumber(member(raw, "steps"));
    goals.activeMinutes = optNumber(member(raw, "activeMinutes"));
    goals.workouts = optNumber(member(raw, "workouts"));
    return goals;
}

// Настройки до T014 не сохранялись — отсутствие или негодные значения дают макетные
Settings normalizeSettings(const json *raw) {
    const Settings defaults;
    if (!truthyJson(raw) || !(raw->is_object() || raw->is_array())) return defaults;
    bool isValid = true;
    auto pick = [&](const char *key, int fallback) {
        const json *value = member(*raw, key);
        if (!isKnownJson(value)) return fallback;
        const double v = numberOfJson(value);
        // Дробное или вне суток `validateSettings` не пропустит
        if (std::floor(v) != v || v > 1e6) {
            isValid = false;
            return fallback;
        }
        return static_cast<int>(v);
    };
    Settings settings;
    settings.dayStart = pick("dayStart", defaults.dayStart);
    settings.dayEnd = pick("dayEnd", defaults.dayEnd);
    settings.lunchStart = pick("lunchStart", defaults.lunchStart);
    settings.lunchEnd = pick("lunchEnd", defaults.lunchEnd);
    settings.margin = pick("margin", defaults.margin);
    return !isValid || validateSettings(settings) ? defaults : settings;
}

} // namespace

// ── идентификаторы ───────────────────────────────────────────────────────────

std::string randomUuid() {
    static thread_local std::mt19937_64 engine{std::random_device{}()};
    unsigned char bytes[16];
    for (int i = 0; i < 16; i += 8) {
        const auto v = engine();
        for (int k = 0; k < 8; ++k) bytes[i + k] = static_cast<unsigned char>(v >> (k * 8));
    }
    bytes[6] = static_cast<unsigned char>((bytes[6] & 0x0F) | 0x40);
    bytes[8] = static_cast<unsigned char>((bytes[8] & 0x3F) | 0x80);
    char out[37];
    std::snprintf(out, sizeof out, "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
                  bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7], bytes[8], bytes[9],
                  bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]);
    return out;
}

State createEmptyState() {
    State state;
    state.projects = {""};
    state.goals = {
        {"kcal", {2000, 100}},
        {"protein", {120, 20}},
        {"fat", {70, 15}},
        {"carbs", {230, 30}},
    };
    state.budget = 600;
    state.settings = defaultSettings();
    state.healthGoals = defaultHealthGoals();
    return state;
}

// ── даты и время ─────────────────────────────────────────────────────────────

bool isDayKey(const std::string &day) { return util::isDayKey(day); }
bool isTimeKey(const std::string &time) { return util::isTimeKey(time); }

std::string toDayKey(int year, int month, int date) {
    return std::to_string(year) + "-" + pad2(month) + "-" + pad2(date);
}

std::string addDays(const std::string &day, long long delta) { return keyOfEpoch(epochDays(day) + delta); }

int toMinutes(const std::string &time) {
    const auto chunks = util::split(time, ':');
    const double hours = util::numberOf(chunks[0]);
    const double minutes = chunks.size() > 1 ? util::numberOf(chunks[1]) : NAN;
    const double total = hours * 60 + minutes;
    return std::isfinite(total) ? static_cast<int>(total) : 0;
}

std::string toTime(int minutes) {
    return pad2(floorDiv(minutes, 60)) + ":" + pad2(minutes % 60);
}

int weekdayOf(const std::string &day) { return weekdayOfEpoch(epochDays(day)); }

std::vector<std::string> getMonthKeys(int year, int month) {
    const int count = daysInMonth(year, month);
    std::vector<std::string> keys;
    for (int i = 1; i <= count; ++i) keys.push_back(toDayKey(year, month, i));
    return keys;
}

int getMonthOffset(int year, int month) { return mondayBased(weekdayOfEpoch(epochOf(year, month, 1))); }

std::vector<std::string> getWeekKeys(const std::string &day) {
    const auto monday = addDays(day, -mondayBased(weekdayOf(day)));
    std::vector<std::string> keys;
    for (int i = 0; i < 7; ++i) keys.push_back(addDays(monday, i));
    return keys;
}

std::vector<std::string> getYearKeys(int year) {
    std::vector<std::string> keys;
    for (int month = 1; month <= 12; ++month) {
        const auto days = getMonthKeys(year, month);
        keys.insert(keys.end(), days.begin(), days.end());
    }
    return keys;
}

std::vector<std::string> getMonthGridKeys(int year, int month) {
    const auto days = getMonthKeys(year, month);
    const int offset = getMonthOffset(year, month);
    const auto first = addDays(days[0], -offset);
    const int count = static_cast<int>((offset + days.size() + 6) / 7) * 7;
    std::vector<std::string> keys;
    for (int i = 0; i < count; ++i) keys.push_back(addDays(first, i));
    return keys;
}

std::string shiftPeriod(const std::string &view, const std::string &day, int delta) {
    if (view == "day") return addDays(day, delta);
    if (view == "week" || view == "agenda") return addDays(day, static_cast<long long>(delta) * 7);
    const auto d = parts(day);
    long long year = 0;
    int month = 0;
    if (view == "year") {
        year = d.year + delta;
        month = d.month;
    } else {
        year = d.year + floorDiv(d.month - 1 + delta, 12);
        month = ((d.month - 1 + delta) % 12 + 12) % 12 + 1;
    }
    const int date = std::min(d.date, daysInMonth(year, month));
    return std::to_string(year) + "-" + pad2(month) + "-" + pad2(date);
}

std::string getDefaultEventEnd(const std::string &start) {
    return toTime(std::min(toMinutes(start) + kDefaultEventMinutes, kMinutesInDay - 1));
}

// ── повторы ──────────────────────────────────────────────────────────────────

const std::string &itemId(const SeriesItem &item) {
    return std::visit([](const auto &value) -> const std::string & { return value.id; }, item);
}

bool isRepeating(const Task &item) { return item.repeat.has_value(); }
bool isRepeating(const Event &item) { return item.repeat.has_value(); }

const Occurrence *getOccurrence(const Task &item, const std::string &day) { return occurrenceOf(item, day); }
const Occurrence *getOccurrence(const Event &item, const std::string &day) { return occurrenceOf(item, day); }

bool occursOn(const Repeat &repeat, const std::string &day) {
    if (!util::isDayKey(day)) return false;
    return occursOnEpoch(compileRepeat(repeat), epochDays(day));
}

std::vector<std::string> expandRepeat(const Repeat &repeat, const std::string &fromDay, const std::string &toDay) {
    std::vector<std::string> days;
    forEachRepeatDay(repeat, fromDay, toDay, [&](const std::string &day) {
        days.push_back(day);
        return false;
    });
    return days;
}

std::vector<std::string> expandInstances(const Task &item, const std::string &fromDay, const std::string &toDay) {
    return instancesOf(item, fromDay, toDay);
}
std::vector<std::string> expandInstances(const Event &item, const std::string &fromDay, const std::string &toDay) {
    return instancesOf(item, fromDay, toDay);
}
bool hasInstanceOn(const Task &item, const std::string &day) { return instanceOn(item, day); }
bool hasInstanceOn(const Event &item, const std::string &day) { return instanceOn(item, day); }
std::string instanceKey(const Task &item) { return keyOf(item); }
std::string instanceKey(const Event &item) { return keyOf(item); }

Task taskInstance(const Task &task, const std::string &day) {
    const Occurrence *occurrence = occurrenceOf(task, day);
    Task instance = task;
    instance.day = day;
    instance.due.reset();
    if (occurrence && occurrence->done.value_or(false)) instance.status = "done";
    else instance.status = task.status == "done" ? "queue" : task.status;
    const auto doneSteps = occurrence && occurrence->doneSteps ? *occurrence->doneSteps : std::vector<int>();
    for (size_t index = 0; index < instance.steps.size(); ++index) {
        instance.steps[index].isDone =
            std::find(doneSteps.begin(), doneSteps.end(), static_cast<int>(index)) != doneSteps.end();
    }
    instance.instanceDay = day;
    return instance;
}

Event eventInstance(const Event &event, const std::string &day) {
    Event instance = event;
    instance.day = day;
    instance.instanceDay = day;
    return instance;
}

bool isInstanceDone(const Task &task, const std::string &day) {
    const auto *o = occurrenceOf(task, day);
    return o && o->done.value_or(false);
}

std::optional<Task> nextOpenInstance(const Task &task, const std::string &today) {
    if (!task.repeat) return std::nullopt;
    std::optional<std::string> found;
    forEachRepeatDay(*task.repeat, today, addDays(today, kRepeatHorizonDays - 1), [&](const std::string &day) {
        const auto *occurrence = occurrenceOf(task, day);
        if (occurrence && (occurrence->excluded.value_or(false) || occurrence->done.value_or(false))) return false;
        found = day;
        return true;
    });
    if (!found) return std::nullopt;
    return taskInstance(task, *found);
}

std::optional<std::string> validateRepeat(const Repeat &repeat) {
    if (repeat.interval < 1 || repeat.interval > kMaxRepeatInterval) return "interval";
    if (repeat.kind == "weekly") {
        const auto days = repeat.weekdays.value_or(std::vector<int>());
        std::set<int> unique(days.begin(), days.end());
        const bool allWeekdays = std::all_of(days.begin(), days.end(), [](int d) { return d >= 0 && d <= 6; });
        if (days.empty() || !allWeekdays || unique.size() != days.size()) return "weekdays";
    }
    if (repeat.monthDay && (*repeat.monthDay < 1 || *repeat.monthDay > 31)) return "monthDay";
    if (!repeat.startDay.empty() ? !util::isDayKey(repeat.startDay) : repeat.kind != "weekly") return "startDay";
    if (truthy(repeat.endDay)
        && (!util::isDayKey(*repeat.endDay) || (!repeat.startDay.empty() && *repeat.endDay < repeat.startDay))) {
        return "endDay";
    }
    if (repeat.count && (*repeat.count < 1 || *repeat.count > kMaxRepeatCount)) return "count";
    return std::nullopt;
}

// ── частичные правки ─────────────────────────────────────────────────────────

RepeatPatch RepeatPatch::of(const Repeat &repeat) {
    RepeatPatch patch;
    patch.kind = std::optional<std::string>(repeat.kind);
    patch.interval = std::optional<int>(repeat.interval);
    patch.weekdays = repeat.weekdays;
    patch.monthDay = repeat.monthDay;
    patch.startDay = std::optional<std::string>(repeat.startDay);
    patch.endDay = repeat.endDay;
    patch.count = repeat.count;
    return patch;
}

Repeat applyRepeatPatch(Repeat base, const RepeatPatch &patch) {
    if (patch.kind) base.kind = patch.kind->value_or("");
    if (patch.interval) base.interval = patch.interval->value_or(0);
    if (patch.weekdays) base.weekdays = *patch.weekdays;
    if (patch.monthDay) base.monthDay = *patch.monthDay;
    if (patch.startDay) base.startDay = patch.startDay->value_or("");
    if (patch.endDay) base.endDay = *patch.endDay;
    if (patch.count) base.count = *patch.count;
    return base;
}

namespace {

template <typename T>
void putField(json &out, const char *key, const PatchField<T> &field) {
    if (!field) return;
    if (*field) out[key] = **field;
    else out[key] = nullptr;
}

json repeatPatchJson(const RepeatPatch &patch) {
    json out = json::object();
    putField(out, "kind", patch.kind);
    putField(out, "interval", patch.interval);
    putField(out, "weekdays", patch.weekdays);
    putField(out, "monthDay", patch.monthDay);
    putField(out, "startDay", patch.startDay);
    putField(out, "endDay", patch.endDay);
    putField(out, "count", patch.count);
    return out;
}

// Значение поля правки для записи: `undefined` — значение по умолчанию поля записи
template <typename T>
T valueOr(const std::optional<T> &inner, T fallback) {
    return inner ? *inner : fallback;
}

} // namespace

json ItemPatch::toJson() const {
    json out = json::object();
    putField(out, "name", name);
    putField(out, "description", description);
    putField(out, "start", start);
    putField(out, "end", end);
    putField(out, "day", day);
    putField(out, "due", due);
    putField(out, "status", status);
    putField(out, "project", project);
    putField(out, "minutes", minutes);
    putField(out, "color", color);
    putField(out, "remind", remind);
    putField(out, "rank", rank);
    putField(out, "isAllDay", isAllDay);
    putField(out, "isHoliday", isHoliday);
    putField(out, "steps", steps);
    putField(out, "source", source);
    if (repeat) out["repeat"] = *repeat ? repeatPatchJson(**repeat) : json(nullptr);
    return out;
}

bool ItemPatch::empty() const { return toJson().empty(); }

void applyPatch(Task &task, const ItemPatch &patch) {
    if (patch.name) task.name = valueOr<std::string>(*patch.name, "");
    if (patch.description) task.description = valueOr<std::string>(*patch.description, "");
    if (patch.start) task.start = *patch.start;
    if (patch.day) task.day = *patch.day;
    if (patch.due) task.due = *patch.due;
    if (patch.status) task.status = valueOr<std::string>(*patch.status, "queue");
    if (patch.project) task.project = valueOr<std::string>(*patch.project, "");
    if (patch.minutes) task.minutes = *patch.minutes;
    if (patch.remind) task.remind = *patch.remind;
    if (patch.rank) task.rank = valueOr<double>(*patch.rank, 0);
    if (patch.steps) task.steps = valueOr<std::vector<Step>>(*patch.steps, {});
    if (patch.source) task.source = *patch.source;
    if (patch.repeat) {
        if (*patch.repeat) task.repeat = applyRepeatPatch(Repeat{}, **patch.repeat);
        else task.repeat.reset();
    }
}

void applyPatch(Event &event, const ItemPatch &patch) {
    if (patch.name) event.name = valueOr<std::string>(*patch.name, "");
    if (patch.description) event.description = *patch.description;
    if (patch.start) event.start = valueOr<std::string>(*patch.start, "");
    if (patch.end) event.end = valueOr<std::string>(*patch.end, "");
    if (patch.day) event.day = *patch.day;
    if (patch.project) event.project = *patch.project;
    if (patch.color) event.color = *patch.color;
    if (patch.remind) event.remind = *patch.remind;
    if (patch.isAllDay) event.isAllDay = *patch.isAllDay;
    if (patch.isHoliday) event.isHoliday = *patch.isHoliday;
    if (patch.repeat) {
        if (*patch.repeat) event.repeat = applyRepeatPatch(Repeat{}, **patch.repeat);
        else event.repeat.reset();
    }
}

// ── повторы: правки экземпляров и ряда ───────────────────────────────────────

Task *findTask(State &state, const std::string &id) { return findIn(state.tasks, id); }
Event *findEvent(State &state, const std::string &id) { return findIn(state.events, id); }

bool setOccurrence(State &state, SeriesKind kind, const std::string &id, const std::string &day,
                   const OccurrencePatch &patch) {
    if (kind == SeriesKind::Task) {
        Task *item = findTask(state, id);
        return item && setOccurrenceIn(*item, day, patch);
    }
    Event *item = findEvent(state, id);
    return item && setOccurrenceIn(*item, day, patch);
}

bool excludeInstance(State &state, SeriesKind kind, const std::string &id, const std::string &day) {
    OccurrencePatch patch;
    patch.excluded = true;
    return setOccurrence(state, kind, id, day, patch);
}

std::optional<SeriesItem> detachInstance(State &state, SeriesKind kind, const std::string &id,
                                         const std::string &day, const ItemPatch &patch, const IdGen &newId) {
    const Origin origin{id, day};
    // `patch.day ?? day`
    const std::string detachedDay = patch.day && *patch.day ? **patch.day : day;
    if (kind == SeriesKind::Task) {
        Task *item = findTask(state, id);
        if (!item) return std::nullopt;
        Task detached = stripSeries(taskInstance(*item, day));
        applyPatch(detached, patch);
        detached.id = newId();
        detached.origin = origin;
        detached.day = detachedDay;
        state.tasks.push_back(detached);
        excludeInstance(state, kind, id, day);
        return detached;
    }
    Event *item = findEvent(state, id);
    if (!item) return std::nullopt;
    Event detached = stripSeries(*item);
    applyPatch(detached, patch);
    detached.id = newId();
    detached.origin = origin;
    detached.day = detachedDay;
    state.events.push_back(detached);
    excludeInstance(state, kind, id, day);
    return detached;
}

namespace {

template <typename T>
std::optional<SeriesItem> splitIn(State &state, const std::string &id, const std::string &day,
                                  const ItemPatch &patch, const IdGen &newId) {
    T *item = findIn(itemsOf<T>(state), id);
    if (!item || !item->repeat) return std::nullopt;
    const Repeat repeat = *item->repeat;
    const long long before = instancesBefore(repeat, day);
    Repeat nextRepeat = repeat;
    nextRepeat.startDay = day;
    nextRepeat.count = repeat.count
        ? std::optional<int>(static_cast<int>(std::max<long long>(1, *repeat.count - before))) : std::nullopt;
    if (patch.repeat && *patch.repeat) nextRepeat = applyRepeatPatch(nextRepeat, **patch.repeat);
    if (repeat.startDay.empty() || day <= repeat.startDay) {
        // Разделять нечего — правка всего ряда
        applyPatch(*item, patch);
        nextRepeat.startDay = repeat.startDay.empty() ? day : repeat.startDay;
        item->repeat = nextRepeat;
        return SeriesItem(*item);
    }
    Repeat ended = repeat;
    ended.endDay = addDays(day, -1);
    ended.count = repeat.count ? std::optional<int>(static_cast<int>(std::max<long long>(1, before))) : std::nullopt;
    item->repeat = ended;
    if (item->occurrences) {
        std::vector<Occurrence> kept;
        for (const auto &o : *item->occurrences) {
            if (o.day < day) kept.push_back(o);
        }
        item->occurrences = kept;
    }
    T created = stripSeries(*item);
    applyPatch(created, patch);
    created.id = newId();
    created.repeat = nextRepeat;
    if constexpr (std::is_same_v<T, Task>) {
        created.status = "queue";
        created.day.reset();
    }
    created.occurrences = std::vector<Occurrence>();
    itemsOf<T>(state).push_back(created);
    return SeriesItem(created);
}

template <typename T>
bool truncateIn(State &state, SeriesKind kind, const std::string &id, const std::string &day) {
    T *item = findIn(itemsOf<T>(state), id);
    if (!item || !item->repeat) return false;
    if (item->repeat->startDay.empty() || day <= item->repeat->startDay) {
        removeSeries(state, kind, id);
        return true;
    }
    const long long before = instancesBefore(*item->repeat, day);
    Repeat next = *item->repeat;
    next.endDay = addDays(day, -1);
    next.count = next.count ? std::optional<int>(static_cast<int>(std::max<long long>(1, before))) : std::nullopt;
    item->repeat = next;
    if (item->occurrences) {
        std::vector<Occurrence> kept;
        for (const auto &o : *item->occurrences) {
            if (o.day < day) kept.push_back(o);
        }
        item->occurrences = kept;
    }
    return true;
}

template <typename T>
std::optional<SeriesItem> updateIn(State &state, const std::string &id, const std::string &day,
                                   const ItemPatch &patch) {
    T *item = findIn(itemsOf<T>(state), id);
    if (!item || !item->repeat) return std::nullopt;
    ItemPatch fields = patch;
    fields.day.reset();
    fields.repeat.reset();
    applyPatch(*item, fields);
    if (patch.day && truthy(*patch.day) && **patch.day != day) shiftSeries(*item, day, **patch.day);
    return SeriesItem(*item);
}

} // namespace

std::optional<SeriesItem> splitSeries(State &state, SeriesKind kind, const std::string &id, const std::string &day,
                                      const ItemPatch &patch, const IdGen &newId) {
    return kind == SeriesKind::Task ? splitIn<Task>(state, id, day, patch, newId)
                                    : splitIn<Event>(state, id, day, patch, newId);
}

bool truncateSeries(State &state, SeriesKind kind, const std::string &id, const std::string &day) {
    return kind == SeriesKind::Task ? truncateIn<Task>(state, kind, id, day)
                                    : truncateIn<Event>(state, kind, id, day);
}

std::optional<SeriesItem> updateSeries(State &state, SeriesKind kind, const std::string &id,
                                       const std::string &day, const ItemPatch &patch) {
    return kind == SeriesKind::Task ? updateIn<Task>(state, id, day, patch) : updateIn<Event>(state, id, day, patch);
}

void removeSeries(State &state, SeriesKind kind, const std::string &id) {
    if (kind == SeriesKind::Task) {
        std::erase_if(state.tasks, [&](const Task &t) { return t.id == id; });
    } else {
        std::erase_if(state.events, [&](const Event &e) { return e.id == id; });
    }
}

bool setTaskDone(State &state, const Task &task, bool isDone) {
    if (task.repeat && truthy(task.instanceDay)) {
        OccurrencePatch patch;
        patch.done = isDone;
        return setOccurrence(state, SeriesKind::Task, task.id, *task.instanceDay, patch);
    }
    Task *target = findTask(state, task.id);
    if (!target) return false;
    target->status = isDone ? "done" : "queue";
    return true;
}

bool setTaskStepDone(State &state, const Task &task, int index, bool isDone) {
    if (task.repeat && truthy(task.instanceDay)) {
        const auto *occurrence = occurrenceOf(task, *task.instanceDay);
        std::set<int> current;
        if (occurrence && occurrence->doneSteps) current.insert(occurrence->doneSteps->begin(), occurrence->doneSteps->end());
        if (isDone) current.insert(index);
        else current.erase(index);
        OccurrencePatch patch;
        patch.doneSteps = std::vector<int>(current.begin(), current.end());
        return setOccurrence(state, SeriesKind::Task, task.id, *task.instanceDay, patch);
    }
    Task *target = findTask(state, task.id);
    if (!target || index < 0 || index >= static_cast<int>(target->steps.size())) return false;
    target->steps[index].isDone = isDone;
    return true;
}

// ── дела дня ─────────────────────────────────────────────────────────────────

std::vector<Task> getTasksForDay(const State &state, const std::string &day) {
    std::vector<Task> result;
    for (const auto &task : state.tasks) {
        if (task.repeat) {
            if (instanceOn(task, day)) result.push_back(taskInstance(task, day));
        } else if (task.day == day) {
            result.push_back(task);
        }
    }
    return result;
}

std::vector<Task> getDeadlines(const State &state, const std::string &day) {
    std::vector<Task> result;
    for (const auto &task : state.tasks) {
        if (!task.repeat && task.due == day && task.status != "done") result.push_back(task);
    }
    return result;
}

std::vector<Event> getEventsForDay(const State &state, const std::string &day) {
    std::vector<Event> result;
    for (const auto &event : state.events) {
        if (event.repeat) {
            if (instanceOn(event, day)) result.push_back(eventInstance(event, day));
        } else if (event.day == day) {
            result.push_back(event);
        }
    }
    sortEvents(result);
    return result;
}

DayIndex getDayIndex(const State &state, const std::string &fromDay, const std::string &toDay) {
    return buildDayIndex(state, fromDay, toDay);
}

DayIndexEntry getDayEntry(const State &state, const std::string &day) {
    auto index = buildDayIndex(state, day, day);
    const auto it = index.find(day);
    return it == index.end() ? DayIndexEntry{} : it->second;
}

DayIndex getDayRange(const State &state, const std::string &fromDay, const std::string &toDay) {
    return buildDayIndex(state, fromDay, toDay);
}

std::string noteTasksSignature(const State &state) {
    std::string out;
    bool isFirst = true;
    for (const auto &task : state.tasks) {
        if (!task.source || task.source->chat.rfind("note:", 0) != 0) continue;
        std::string steps;
        for (const auto &step : task.steps) steps += step.isDone ? '1' : '0';
        std::string occurrences;
        if (task.occurrences) {
            bool isFirstOccurrence = true;
            for (const auto &o : *task.occurrences) {
                if (!isFirstOccurrence) occurrences += ',';
                isFirstOccurrence = false;
                occurrences += o.day + (o.done.value_or(false) ? "+" : "") + (o.excluded.value_or(false) ? "-" : "");
            }
        }
        const std::vector<std::string> fields = {task.id, task.source->chat, task.name, task.status,
                                                 task.day.value_or(""), task.due.value_or(""), steps, occurrences};
        if (!isFirst) out += '\n';
        isFirst = false;
        for (size_t i = 0; i < fields.size(); ++i) {
            if (i) out += '\x01';
            out += fields[i];
        }
    }
    return out;
}

bool isHolidayOn(const State &state, const std::string &day) {
    const auto events = getEventsForDay(state, day);
    return std::any_of(events.begin(), events.end(), [](const Event &e) { return e.isHoliday.value_or(false); });
}

int countUnrated(const State &state, const std::string &day) {
    const auto tasks = getTasksForDay(state, day);
    return static_cast<int>(std::count_if(tasks.begin(), tasks.end(), [](const Task &t) { return !t.minutes; }));
}

int getDayLoad(const State &state, const std::string &day) {
    int events = 0;
    for (const auto &event : getEventsForDay(state, day)) {
        if (!event.isAllDay.value_or(false)) events += eventMinutes(event);
    }
    int tasks = 0;
    for (const auto &task : getTasksForDay(state, day)) tasks += task.minutes.value_or(0);
    return events + tasks;
}

std::vector<Timed> getTimedForDay(const State &state, const std::string &day,
                                  const std::optional<std::string> &excludedTaskId) {
    std::vector<Timed> timed;
    for (const auto &event : getEventsForDay(state, day)) {
        if (!event.isAllDay.value_or(false)) timed.push_back(timedOf(event.name, event.start, event.end, std::nullopt, event));
    }
    for (const auto &task : getTasksForDay(state, day)) {
        if (!hasStartAndMinutes(task) || (excludedTaskId && keyOf(task) == *excludedTaskId)) continue;
        timed.push_back(timedOf(task.name, *task.start, toTime(toMinutes(*task.start) + *task.minutes), task,
                                std::nullopt));
    }
    sortTimed(timed);
    return timed;
}

std::vector<TimedLayout> layoutTimed(const std::vector<Timed> &timed) {
    std::vector<TimedLayout> result;
    std::vector<size_t> cluster;
    int clusterEnd = -1;
    std::vector<int> laneEnds;
    auto closeCluster = [&]() {
        for (size_t i : cluster) result[i].lanes = static_cast<int>(laneEnds.size());
        cluster.clear();
        laneEnds.clear();
    };
    auto sorted = timed;
    std::stable_sort(sorted.begin(), sorted.end(),
                     [](const Timed &a, const Timed &b) { return toMinutes(a.start) < toMinutes(b.start); });
    for (const auto &item : sorted) {
        const int start = toMinutes(item.start);
        const int end = std::max(toMinutes(item.end), start + 1);
        if (start >= clusterEnd) closeCluster();
        auto it = std::find_if(laneEnds.begin(), laneEnds.end(), [&](int laneEnd) { return laneEnd <= start; });
        const int lane = it == laneEnds.end() ? static_cast<int>(laneEnds.size()) : static_cast<int>(it - laneEnds.begin());
        if (lane == static_cast<int>(laneEnds.size())) laneEnds.push_back(end);
        else laneEnds[lane] = end;
        clusterEnd = std::max(clusterEnd, end);
        result.push_back({item, lane, 1, 1});
        cluster.push_back(result.size() - 1);
    }
    closeCluster();
    for (auto &entry : result) {
        const int start = toMinutes(entry.item.start);
        const int end = std::max(toMinutes(entry.item.end), start + 1);
        entry.right = entry.lanes;
        for (const auto &other : result) {
            if (other.lane <= entry.lane) continue;
            const int otherStart = toMinutes(other.item.start);
            const bool isOverlapping = otherStart < end && start < std::max(toMinutes(other.item.end), otherStart + 1);
            if (isOverlapping && otherStart < start + kTitleMinutes) entry.right = std::min(entry.right, other.lane);
        }
    }
    return result;
}

int countConflicts(const State &state, const std::string &day) {
    return countTimedConflicts(getTimedForDay(state, day));
}

double getLoadFraction(const State &state, double minutes) {
    return state.budget > 0 ? std::min(1.0, minutes / state.budget) : 0;
}

DayAvailability getDayAvailability(const State &state, const std::string &day) {
    const int dayStart = state.settings.dayStart;
    const int dayEnd = state.settings.dayEnd;
    const auto timed = getTimedForDay(state, day);
    std::vector<Slot> clipped;
    for (const auto &item : timed) {
        const Slot slot{std::max(dayStart, toMinutes(item.start)), std::min(dayEnd, toMinutes(item.end))};
        if (slot.start < slot.end) clipped.push_back(slot);
    }
    std::stable_sort(clipped.begin(), clipped.end(), [](const Slot &a, const Slot &b) { return a.start < b.start; });
    std::vector<Slot> busy;
    for (const auto &slot : clipped) {
        if (!busy.empty() && slot.start <= busy.back().end) busy.back().end = std::max(busy.back().end, slot.end);
        else busy.push_back(slot);
    }
    DayAvailability out;
    int cursor = dayStart;
    for (const auto &slot : busy) {
        if (slot.start > cursor) out.free.push_back({cursor, slot.start});
        cursor = std::max(cursor, slot.end);
    }
    if (cursor < dayEnd) out.free.push_back({cursor, dayEnd});
    // Пересекающиеся дела показываются одной группой с предупреждением
    for (const auto &item : timed) {
        const int from = toMinutes(item.start);
        const int until = toMinutes(item.end);
        if (out.groups.empty() || from >= out.groups.back().end) out.groups.push_back({from, until, {}});
        auto &group = out.groups.back();
        group.items.push_back(item);
        group.end = std::max(group.end, until);
    }
    for (const auto &slot : out.free) out.freeMinutes += slot.end - slot.start;
    return out;
}

std::vector<SlotAnswer> findSlots(const State &state, const Task &task, const std::string &today,
                                  const std::string &picked) {
    if (!task.minutes || !*task.minutes) return {};
    const int minutes = *task.minutes;
    const int dayStart = state.settings.dayStart;
    const int dayEnd = state.settings.dayEnd;
    const std::string base = truthy(task.day) && *task.day >= today ? *task.day : (picked >= today ? picked : today);
    std::vector<SlotAnswer> answers;
    for (int offset = 0; offset < kSlotSearchDays && static_cast<int>(answers.size()) < kSlotAnswers; ++offset) {
        const auto day = addDays(base, offset);
        if (truthy(task.due) && day > *task.due) break;
        const int ownLoad = task.day == day ? minutes : 0;
        if (getDayLoad(state, day) - ownLoad + minutes > state.budget) continue;
        std::vector<std::pair<int, int>> busy;
        for (const auto &item : getTimedForDay(state, day, instanceKey(task))) {
            const int from = std::max(dayStart, toMinutes(item.start));
            const int until = std::min(dayEnd, toMinutes(item.end));
            if (from < until) busy.emplace_back(from, until);
        }
        std::stable_sort(busy.begin(), busy.end(), [](const auto &a, const auto &b) { return a.first < b.first; });
        busy.emplace_back(dayEnd, dayEnd);
        int cursor = dayStart;
        for (const auto &[from, until] : busy) {
            if (from - cursor >= minutes) {
                answers.push_back({day, toTime(cursor), toTime(cursor + minutes)});
                break;
            }
            cursor = std::max(cursor, until);
        }
    }
    return answers;
}

// ── списки задач ─────────────────────────────────────────────────────────────

List *ensureList(State &state, const std::string &name, const IdGen &newId) {
    if (name.empty()) return nullptr;
    for (auto &list : state.lists) {
        if (list.name == name) return &list;
    }
    state.lists.push_back({newId(), name, static_cast<double>(state.lists.size()), std::nullopt});
    if (std::find(state.projects.begin(), state.projects.end(), name) == state.projects.end()) {
        state.projects.push_back(name);
    }
    return &state.lists.back();
}

int getListColor(const State &state, const std::string &name) {
    if (name.empty()) return 0;
    for (const auto &list : state.lists) {
        if (list.name == name) return list.color.value_or(0);
    }
    return 0;
}

int getEventColor(const State &state, const Event &event) {
    if (const int color = getListColor(state, event.project.value_or(""))) return color;
    return event.color.value_or(0);
}

bool hasLunchBreak(const Settings &settings) { return settings.lunchEnd > settings.lunchStart; }

std::vector<Task> getEligibleTasks(const State &state, const std::string &today) {
    std::vector<Task> result;
    for (const auto &task : state.tasks) {
        if (task.repeat) {
            if (auto next = nextOpenInstance(task, today)) result.push_back(*next);
        } else if (!truthy(task.due) && task.status != "done") {
            result.push_back(task);
        }
    }
    return result;
}

namespace {

bool byRankThenId(const Task &a, const Task &b) {
    if (a.rank != b.rank) return a.rank < b.rank;
    return a.id < b.id;
}

} // namespace

std::vector<Task> getUndatedTasks(const State &state) {
    std::vector<Task> result;
    for (const auto &task : state.tasks) {
        if (!task.repeat && !truthy(task.day) && task.status != "done") result.push_back(task);
    }
    std::stable_sort(result.begin(), result.end(), [](const Task &a, const Task &b) {
        const bool aActive = a.status == "active";
        const bool bActive = b.status == "active";
        if (aActive != bActive) return aActive;
        return byRankThenId(a, b);
    });
    return result;
}

std::vector<Task> getCompletedTasks(const State &state) {
    std::vector<Task> result;
    for (const auto &task : state.tasks) {
        if (!task.repeat && !truthy(task.due) && task.status == "done") result.push_back(task);
    }
    return result;
}

std::vector<Task> getOrderedGroup(const State &state, const Task &task, const std::string &today) {
    std::vector<Task> group;
    for (const auto &item : getEligibleTasks(state, today)) {
        if (item.project == task.project && item.status == task.status) group.push_back(item);
    }
    std::stable_sort(group.begin(), group.end(), byRankThenId);
    return group;
}

bool moveTask(State &state, const std::string &taskId, int direction, const std::string &today) {
    Task *task = findTask(state, taskId);
    if (!task) return false;
    std::vector<Task *> group;
    for (const auto &item : getOrderedGroup(state, *task, today)) group.push_back(findTask(state, item.id));
    const auto it = std::find(group.begin(), group.end(), task);
    if (it == group.end()) return false;
    const int index = static_cast<int>(it - group.begin());
    const int target = index + direction;
    if (target < 0 || target >= static_cast<int>(group.size())) return false;
    // Ранги группы делаются различными, иначе обмен равных рангов ничего не меняет
    for (size_t i = 0; i < group.size(); ++i) group[i]->rank = static_cast<double>(i);
    group[index]->rank = target;
    group[target]->rank = index;
    return true;
}

// ── проверки ввода ───────────────────────────────────────────────────────────

std::optional<std::string> validateTask(const Task &task) {
    if (util::trim(task.name).empty()) return "name";
    if (task.minutes && (*task.minutes < kMinTaskMinutes || *task.minutes > kMinutesInDay)) return "minutes";
    // Время начала — только у задачи с датой; оценка не обязательна (16 окт 2026)
    if (truthy(task.start) && !truthy(task.day)) return "startNeedsDayAndMinutes";
    if (truthy(task.start) && task.minutes && toMinutes(*task.start) + *task.minutes > kMinutesInDay) {
        return "pastMidnight";
    }
    if (truthy(task.day) && truthy(task.due) && *task.day > *task.due) return "dayAfterDue";
    return std::nullopt;
}

std::optional<std::string> validateSettings(const Settings &settings) {
    auto isMinute = [](int value) { return value >= 0 && value <= kMinutesInDay; };
    if (!isMinute(settings.dayStart) || !isMinute(settings.dayEnd) || settings.dayStart >= settings.dayEnd) {
        return "window";
    }
    if (!isMinute(settings.lunchStart) || !isMinute(settings.lunchEnd)) return "lunch";
    if (hasLunchBreak(settings) && (settings.lunchStart < settings.dayStart || settings.lunchEnd > settings.dayEnd)) {
        return "lunch";
    }
    if (settings.margin < 0 || settings.margin > kMaxSlotMargin) return "margin";
    return std::nullopt;
}

bool validateBudget(double budget) {
    return std::isfinite(budget) && std::floor(budget) == budget && budget >= kMinBudgetMinutes
        && budget <= kMinutesInDay;
}

std::optional<std::string> validateEvent(const Event &event) {
    if (util::trim(event.name).empty()) return "name";
    if (!event.isAllDay.value_or(false)
        && (!util::isTimeKey(event.start) || !util::isTimeKey(event.end) || event.start >= event.end)) {
        return "time";
    }
    if (event.repeat) return validateRepeat(*event.repeat);
    if (!truthy(event.day)) return "repeat";
    return std::nullopt;
}

// ── питание ──────────────────────────────────────────────────────────────────

bool isKnownNumber(double value) { return std::isfinite(value) && value >= 0; }

namespace {

double roundNutrient(double value) { return util::jsRound((value + DBL_EPSILON) * 10000) / 10000; }

std::optional<double> nutrientOf(const FoodEntry &entry, const std::string &nutrient) {
    if (nutrient == "kcal") return entry.kcal;
    if (nutrient == "protein") return entry.protein;
    if (nutrient == "fat") return entry.fat;
    if (nutrient == "carbs") return entry.carbs;
    if (nutrient == "fiber") return entry.fiber;
    return std::nullopt;
}

bool isKnown(const std::optional<double> &value) { return value && isKnownNumber(*value); }

} // namespace

FoodEntry makeFoodEntry(const FoodInput &raw, const IdGen &newId) {
    const double grams = raw.grams.value_or(0);
    const double factor = raw.isPer100 ? (grams ? grams : 0) / 100 : 1;
    std::map<std::string, double> scaled;
    for (const auto &nutrient : kNutrients) {
        const auto it = raw.values.find(nutrient);
        if (it != raw.values.end() && isKnownNumber(it->second)) scaled[nutrient] = roundNutrient(it->second * factor);
    }
    auto scaledOf = [&](const char *key) {
        const auto it = scaled.find(key);
        return it == scaled.end() ? std::nullopt : std::optional<double>(it->second);
    };
    FoodEntry entry;
    entry.id = raw.id && !raw.id->empty() ? *raw.id : newId();
    entry.name = util::trim(raw.name);
    entry.meal = raw.meal;
    entry.kcal = scaledOf("kcal").value_or(0);
    entry.protein = scaledOf("protein");
    entry.fat = scaledOf("fat");
    entry.carbs = scaledOf("carbs");
    entry.fiber = scaledOf("fiber");
    if (raw.isPer100) {
        entry.grams = raw.grams;
        entry.per100 = raw.values;
    }
    return entry;
}

NutrientTotal getNutrientTotal(const State &state, const std::string &day, const std::string &nutrient) {
    const auto it = state.nutrition.find(day);
    const NutritionDay *record = it == state.nutrition.end() ? nullptr : &it->second;
    if (nutrient == "water") {
        const bool known = record && isKnown(record->waterMl);
        return {known ? *record->waterMl : 0, 0, known ? 1 : 0};
    }
    NutrientTotal total;
    if (!record) return total;
    double value = 0;
    for (const auto &entry : record->entries) {
        const auto amount = nutrientOf(entry, nutrient);
        if (isKnown(amount)) value += *amount;
        else ++total.missing;
    }
    total.value = roundNutrient(value);
    total.count = static_cast<int>(record->entries.size());
    return total;
}

std::optional<GoalRecord> getGoalRecordForDay(const State &state, const std::string &day) {
    auto length = [](const GoalRecord &r) {
        return !r.endDay.empty() && !r.startDay.empty() ? static_cast<double>(epochDays(r.endDay) - epochDays(r.startDay))
                                                        : std::numeric_limits<double>::infinity();
    };
    const GoalRecord *best = nullptr;
    for (const auto &record : state.goalPeriods) {
        if ((!record.startDay.empty() && day < record.startDay) || (!record.endDay.empty() && day > record.endDay)) {
            continue;
        }
        if (!best || record.startDay > best->startDay
            || (record.startDay == best->startDay && length(record) <= length(*best))) {
            best = &record;
        }
    }
    if (best) return *best;
    if (state.goals.empty()) return std::nullopt;
    return GoalRecord{"", "", "", state.goals};
}

bool isDayClosed(const State &state, const std::string &day, const std::string &today) {
    if (day < today) return true;
    const auto it = state.nutrition.find(day);
    return it != state.nutrition.end() && it->second.isComplete;
}

GoalValues getGoalsForDay(const State &state, const std::string &day, const std::string &today) {
    const auto it = state.nutrition.find(day);
    if (it != state.nutrition.end() && it->second.fixedGoals && isDayClosed(state, day, today)) {
        return *it->second.fixedGoals;
    }
    const auto record = getGoalRecordForDay(state, day);
    return record ? record->goals : GoalValues();
}

int freezePastGoals(State &state, const std::string &today) {
    int count = 0;
    for (auto &[day, record] : state.nutrition) {
        const bool hasWater = record.waterMl && *record.waterMl != 0 && !std::isnan(*record.waterMl);
        if (day >= today || record.fixedGoals || !(!record.entries.empty() || hasWater)) continue;
        const auto goals = getGoalRecordForDay(state, day);
        record.fixedGoals = goals ? goals->goals : GoalValues();
        record.isComplete = true;
        ++count;
    }
    return count;
}

std::optional<Goal> getNutrientGoal(const State &state, const std::string &day, const std::string &metric,
                                    const std::string &today) {
    const auto goals = getGoalsForDay(state, day, today);
    const auto it = goals.find(metric);
    return it == goals.end() ? std::nullopt : std::optional<Goal>(it->second);
}

std::string getNutrientStatus(const State &state, const std::string &day, const std::string &metric,
                              const std::string &today) {
    const auto total = getNutrientTotal(state, day, metric);
    if (!state.nutrition.count(day) || !total.count) return "none";
    const auto goal = getNutrientGoal(state, day, metric, today);
    if (!goal) return "nogoal";
    if (total.missing) return "incomplete";
    if (!isDayClosed(state, day, today)) return "open";
    if (total.value < goal->target - goal->tolerance) return "below";
    if (total.value > goal->target + goal->tolerance) return "above";
    return "ok";
}

NutrientStatistics getNutrientStatistics(const State &state, const std::vector<std::string> &days,
                                         const std::string &metric, const std::string &today) {
    NutrientStatistics out;
    for (const auto &day : days) {
        if (day <= today && getNutrientTotal(state, day, metric).count) out.recorded.push_back(day);
    }
    for (const auto &day : out.recorded) {
        if (isDayClosed(state, day, today) && !getNutrientTotal(state, day, metric).missing) out.complete.push_back(day);
    }
    // Дни «в норме» считаются по собственной цели каждого дня; дни без цели в норму не входят
    for (const auto &day : out.complete) {
        if (getNutrientGoal(state, day, metric, today)) out.withGoal.push_back(day);
    }
    double sum = 0;
    for (const auto &day : out.recorded) sum += getNutrientTotal(state, day, metric).value;
    out.sum = roundNutrient(sum);
    double completeSum = 0;
    for (const auto &day : out.complete) completeSum += getNutrientTotal(state, day, metric).value;
    out.completeSum = roundNutrient(completeSum);
    for (const auto &day : out.withGoal) {
        if (getNutrientStatus(state, day, metric, today) == "ok") ++out.inGoal;
        const auto goal = *getNutrientGoal(state, day, metric, today);
        out.goalLow += goal.target - goal.tolerance;
        out.goalHigh += goal.target + goal.tolerance;
    }
    if (!out.complete.empty()) out.average = roundNutrient(out.completeSum / static_cast<double>(out.complete.size()));
    return out;
}

std::optional<std::string> validateGoalRecord(const GoalRecord &record) {
    if (!record.startDay.empty() && !util::isDayKey(record.startDay)) return "startDay";
    if (!record.endDay.empty()
        && (!util::isDayKey(record.endDay) || (!record.startDay.empty() && record.endDay < record.startDay))) {
        return "endDay";
    }
    bool hasAny = false;
    for (const auto &metric : kGoalMetrics) {
        const auto it = record.goals.find(metric);
        if (it == record.goals.end()) continue;
        hasAny = true;
        if (!validateGoal(it->second, metric == "kcal" || metric == "water")) return metric;
    }
    if (!hasAny) return "empty";
    return std::nullopt;
}

bool validateGoal(const Goal &goal, bool isInteger) {
    if (!isKnownNumber(goal.target) || goal.target <= 0 || !isKnownNumber(goal.tolerance)
        || goal.tolerance > goal.target) {
        return false;
    }
    return !isInteger || (std::floor(goal.target) == goal.target && std::floor(goal.tolerance) == goal.tolerance);
}

// ── статистика времени ───────────────────────────────────────────────────────

TimeStatistics getTimeStatistics(const State &state, const std::vector<std::string> &days,
                                 const std::set<std::string> &hidden) {
    // Группы — в порядке появления, как `Map` в JS
    std::vector<std::pair<std::string, int>> groups;
    TimeStatistics out;
    auto add = [&](const std::string &name, int minutes) {
        for (auto &group : groups) {
            if (group.first == name) {
                group.second += minutes;
                return;
            }
        }
        groups.emplace_back(name, minutes);
    };
    for (const auto &day : days) {
        for (const auto &task : getTasksForDay(state, day)) {
            if (!task.minutes) ++out.unrated;
            else add(task.project, *task.minutes);
        }
        for (const auto &event : getEventsForDay(state, day)) {
            if (!event.isAllDay.value_or(false)) add(kEventsGroup, eventMinutes(event));
        }
    }
    for (const auto &[name, minutes] : groups) {
        if (minutes <= 0) continue;
        int colorIndex = 4;
        if (name != kEventsGroup) {
            const auto it = std::find(state.projects.begin(), state.projects.end(), name);
            const int index = it == state.projects.end() ? 0 : static_cast<int>(it - state.projects.begin());
            colorIndex = index % 4;
        }
        out.rows.push_back({name, minutes, colorIndex});
    }
    for (const auto &row : out.rows) {
        if (!hidden.count(row.name)) out.total += row.minutes;
    }
    return out;
}

// ── хранение ─────────────────────────────────────────────────────────────────

State normalizeState(const json &raw, const IdGen &newId) {
    State empty = createEmptyState();
    if (!raw.is_object()) return empty;
    const json *version = member(raw, "version");
    const json *rawTasks = member(raw, "tasks");
    if (!isNumber(version) || numberOfJson(version) != 1 || !rawTasks || !rawTasks->is_array()) return empty;

    State state = empty;
    state.tasks.clear();
    int index = 0;
    for (const auto &t : *rawTasks) {
        if (!truthyJson(&t) || !isId(member(t, "id")) || !isString(member(t, "name"))) continue;
        Task task;
        task.id = idOf(member(t, "id"));
        task.name = member(t, "name")->get<std::string>();
        task.description = stringOf(member(t, "description"));
        task.steps = stepsOf(member(t, "steps"));
        const auto status = stringOf(member(t, "status"));
        task.status = std::find(kStatuses.begin(), kStatuses.end(), status) != kStatuses.end() ? status : "queue";
        task.project = stringOf(member(t, "project"));
        task.rank = isFiniteJson(member(t, "rank")) ? numberOfJson(member(t, "rank")) : index;
        if (isDayJson(member(t, "day"))) task.day = member(t, "day")->get<std::string>();
        if (isTimeJson(member(t, "start"))) task.start = member(t, "start")->get<std::string>();
        if (isDayJson(member(t, "due"))) task.due = member(t, "due")->get<std::string>();
        const json *minutes = member(t, "minutes");
        // Оценка в web — любое число; в типах C++ — целое (дробная отбрасывается вниз)
        if (isKnownJson(minutes) && numberOfJson(minutes) >= kMinTaskMinutes) task.minutes = intOf(minutes);
        auto series = normalizeSeries(t);
        task.repeat = series.repeat;
        task.occurrences = series.occurrences;
        task.origin = series.origin;
        task.source = series.source;
        state.tasks.push_back(task);
        ++index;
    }

    const json *rawEvents = member(raw, "events");
    if (rawEvents && rawEvents->is_array()) {
        for (const auto &e : *rawEvents) {
            if (!truthyJson(&e) || !isId(member(e, "id")) || !isString(member(e, "name"))
                || !isTimeJson(member(e, "start")) || !isTimeJson(member(e, "end"))) {
                continue;
            }
            // События «по дням недели» этапов 1–2 — еженедельный ряд без нижней границы (research R5)
            std::vector<int> legacyWeekdays;
            const json *rawWeekdays = member(e, "weekdays");
            if (rawWeekdays && rawWeekdays->is_array()) {
                for (const auto &d : *rawWeekdays) {
                    if (isIntegerJson(&d) && d.get<double>() >= 0 && d.get<double>() <= 6) {
                        legacyWeekdays.push_back(static_cast<int>(d.get<double>()));
                    }
                }
            }
            auto series = normalizeSeries(e);
            std::optional<Repeat> repeat = series.repeat;
            if (!repeat && !legacyWeekdays.empty()) {
                Repeat legacy;
                legacy.kind = "weekly";
                legacy.interval = 1;
                legacy.weekdays = legacyWeekdays;
                legacy.startDay = "";
                repeat = legacy;
            }
            Event event;
            event.id = idOf(member(e, "id"));
            event.name = member(e, "name")->get<std::string>();
            const auto description = stringOf(member(e, "description"));
            if (!description.empty()) event.description = description;
            event.start = member(e, "start")->get<std::string>();
            event.end = member(e, "end")->get<std::string>();
            if (!repeat && isDayJson(member(e, "day"))) event.day = member(e, "day")->get<std::string>();
            event.occurrences = series.occurrences;
            event.origin = series.origin;
            event.repeat = repeat;
            if (truthyJson(member(e, "isAllDay"))) event.isAllDay = true;
            if (truthyJson(member(e, "isHoliday"))) event.isHoliday = true;
            const json *color = member(e, "color");
            if (isIntegerJson(color) && numberOfJson(color) > 0 && numberOfJson(color) <= kListColorCount) {
                event.color = intOf(color);
            }
            const auto project = stringOf(member(e, "project"));
            if (!project.empty()) event.project = project;
            state.events.push_back(event);
        }
    }

    state.projects = {""};
    const json *rawProjects = member(raw, "projects");
    if (rawProjects && rawProjects->is_array()) {
        for (const auto &name : *rawProjects) {
            if (!name.is_string()) continue;
            const auto value = name.get<std::string>();
            if (std::find(state.projects.begin(), state.projects.end(), value) == state.projects.end()) {
                state.projects.push_back(value);
            }
        }
    }
    for (const auto &task : state.tasks) {
        if (std::find(state.projects.begin(), state.projects.end(), task.project) == state.projects.end()) {
            state.projects.push_back(task.project);
        }
    }
    const json *rawLists = member(raw, "lists");
    if (rawLists && rawLists->is_array()) {
        int listIndex = 0;
        for (const auto &l : *rawLists) {
            if (!truthyJson(&l) || !isString(member(l, "id")) || !isString(member(l, "name"))
                || stringOf(member(l, "name")).empty()) {
                continue;
            }
            List list;
            list.id = member(l, "id")->get<std::string>();
            list.name = member(l, "name")->get<std::string>();
            list.order = isFiniteJson(member(l, "order")) ? numberOfJson(member(l, "order")) : listIndex;
            const json *color = member(l, "color");
            if (isIntegerJson(color) && numberOfJson(color) >= 1 && numberOfJson(color) <= kListColorCount) {
                list.color = intOf(color);
            }
            state.lists.push_back(list);
            ++listIndex;
        }
    }
    for (const auto &name : state.projects) {
        if (name.empty()) continue;
        const bool exists = std::any_of(state.lists.begin(), state.lists.end(),
                                        [&](const List &list) { return list.name == name; });
        if (!exists) state.lists.push_back({newId(), name, static_cast<double>(state.lists.size()), std::nullopt});
    }

    const json *rawNutrition = member(raw, "nutrition");
    if (truthyJson(rawNutrition) && rawNutrition->is_object()) {
        for (auto it = rawNutrition->begin(); it != rawNutrition->end(); ++it) {
            const json &record = it.value();
            const json *entries = member(record, "entries");
            if (!util::isDayKey(it.key()) || !truthyJson(&record) || !entries || !entries->is_array()) continue;
            // Этап 1 хранил цели завершённого дня как `goal` (ккал) и `macroGoals` — сводятся в `fixedGoals`
            const json *fixedRaw = member(record, "fixedGoals");
            std::optional<GoalValues> fixedGoals;
            if (truthyJson(fixedRaw)) {
                fixedGoals = normalizeGoalValues(fixedRaw);
            } else if (auto legacy = legacyGoals(member(record, "goal"), member(record, "macroGoals"))) {
                fixedGoals = normalizeGoalValues(&*legacy);
            }
            NutritionDay day;
            for (const auto &entry : *entries) {
                if (!truthyJson(&entry) || !isString(member(entry, "name")) || !isKnownJson(member(entry, "kcal"))) {
                    continue;
                }
                FoodEntry food = foodOf(entry);
                const auto id = stringOf(member(entry, "id"));
                food.id = !id.empty() ? id : newId();
                if (std::find(kMeals.begin(), kMeals.end(), food.meal) == kMeals.end()) food.meal = "other";
                day.entries.push_back(food);
            }
            day.isComplete = truthyJson(member(record, "isComplete"));
            if (fixedGoals && !fixedGoals->empty()) day.fixedGoals = fixedGoals;
            if (isKnownJson(member(record, "waterMl"))) day.waterMl = numberOfJson(member(record, "waterMl"));
            state.nutrition[it.key()] = day;
        }
    }

    // Этап 1: `calorieGoal` + `macroGoals`; spec 011: `goals` целиком
    std::optional<GoalValues> goals;
    if (const json *rawGoals = member(raw, "goals"); truthyJson(rawGoals)) {
        goals = normalizeGoalValues(rawGoals);
    } else if (auto legacy = legacyGoals(member(raw, "calorieGoal"), member(raw, "macroGoals"))) {
        goals = normalizeGoalValues(&*legacy);
    }
    state.goals = goals ? *goals : empty.goals;

    const json *rawPeriods = member(raw, "goalPeriods");
    if (rawPeriods && rawPeriods->is_array()) {
        for (const auto &r : *rawPeriods) {
            if (!truthyJson(&r) || !isString(member(r, "id")) || stringOf(member(r, "id")).empty()
                || !truthyJson(member(r, "goals"))) {
                continue;
            }
            GoalRecord record;
            record.id = member(r, "id")->get<std::string>();
            record.startDay = isDayJson(member(r, "startDay")) ? member(r, "startDay")->get<std::string>() : "";
            record.endDay = isDayJson(member(r, "endDay")) ? member(r, "endDay")->get<std::string>() : "";
            record.goals = normalizeGoalValues(member(r, "goals")).value_or(GoalValues());
            if (!validateGoalRecord(record)) state.goalPeriods.push_back(record);
        }
    }

    const json *budget = member(raw, "budget");
    state.budget = isKnownJson(budget) && validateBudget(numberOfJson(budget)) ? intOf(budget) : empty.budget;
    state.settings = normalizeSettings(member(raw, "settings"));

    const json *rawHealth = member(raw, "health");
    if (rawHealth && rawHealth->is_array()) {
        for (const auto &record : *rawHealth) {
            if (!truthyJson(&record) || !isString(member(record, "id")) || !isDayJson(member(record, "day"))
                || !isString(member(record, "kind")) || !isKnownJson(member(record, "value"))) {
                continue;
            }
            state.health.push_back(healthOf(record));
        }
    }
    const json *rawHealthGoals = member(raw, "healthGoals");
    state.healthGoals = truthyJson(rawHealthGoals) && (rawHealthGoals->is_object() || rawHealthGoals->is_array())
        ? healthGoalsOf(*rawHealthGoals) : empty.healthGoals;
    state.learned = normalizeLearned(member(raw, "learned") ? *member(raw, "learned") : json());
    state.quickLines = normalizeQuickLines(member(raw, "quickLines") ? *member(raw, "quickLines") : json());
    const json *reminded = member(raw, "reminded");
    if (reminded && reminded->is_array()) {
        for (const auto &id : *reminded) {
            if (id.is_string()) state.reminded.push_back(id.get<std::string>());
        }
    }
    return state;
}

namespace {

// Целое больше нуля либо 0
double positiveCount(const json *value) {
    return isIntegerJson(value) && numberOfJson(value) > 0 ? numberOfJson(value) : 0;
}

int countInt(double value) { return value >= static_cast<double>(INT_MAX) ? INT_MAX : static_cast<int>(value); }

} // namespace

std::vector<QuickLine> normalizeQuickLines(const json &raw) {
    std::vector<QuickLine> lines;
    if (!raw.is_array()) return lines;
    std::set<std::string> seen;
    for (const auto &line : raw) {
        const json *id = member(line, "id");
        if (!truthyJson(&line) || !isString(id) || id->get<std::string>().empty() || seen.count(id->get<std::string>())) {
            continue;
        }
        const json *text = member(line, "text");
        if (!isString(text) || util::trim(text->get<std::string>()).empty()) continue;
        seen.insert(id->get<std::string>());
        QuickLine out;
        out.id = id->get<std::string>();
        out.text = text->get<std::string>();
        out.count = countInt(positiveCount(member(line, "count")));
        out.touched = positiveCount(member(line, "touched"));
        if (truthyJson(member(line, "isHidden"))) out.isHidden = true;
        lines.push_back(out);
    }
    return lines;
}

std::vector<LearnedWord> normalizeLearned(const json &raw) {
    std::vector<LearnedWord> words;
    if (!raw.is_array()) return words;
    std::set<std::string> seen;
    for (const auto &word : raw) {
        const json *id = member(word, "id");
        if (!truthyJson(&word) || !isString(id) || id->get<std::string>().empty() || seen.count(id->get<std::string>())) {
            continue;
        }
        const auto kind = stringOf(member(word, "kind"));
        const bool isKind = isString(member(word, "kind")) && (kind == "task" || kind == "event");
        const int kindCount = isKind ? countInt(positiveCount(member(word, "kindCount"))) : 0;
        const json *minutes = member(word, "minutes");
        const bool isMinutes = isIntegerJson(minutes) && numberOfJson(minutes) >= kMinTaskMinutes
            && numberOfJson(minutes) <= kMinutesInDay;
        const int minutesCount = isMinutes ? countInt(positiveCount(member(word, "minutesCount"))) : 0;
        if (!kindCount && !minutesCount) continue;
        seen.insert(id->get<std::string>());
        LearnedWord out;
        out.id = id->get<std::string>();
        if (kindCount) out.kind = kind;
        out.kindCount = kindCount;
        if (minutesCount) out.minutes = intOf(minutes);
        out.minutesCount = minutesCount;
        out.touched = positiveCount(member(word, "touched"));
        words.push_back(out);
    }
    return words;
}

// ── подписи без Intl ─────────────────────────────────────────────────────────

std::string formatClock(int minutes) {
    const auto clock = toTime(minutes);
    return minutes % 60 ? clock : clock.substr(0, 2);
}

std::string formatSpan(double minutes) {
    const auto hours = static_cast<long long>(std::floor(minutes / 60));
    auto rest = static_cast<long long>(util::jsRound(std::fmod(minutes, 60)));
    return std::to_string(hours) + ":" + pad2(rest);
}

std::optional<std::string> listColorStyle(int color) {
    if (!color) return std::nullopt;
    return "--planner-list-color: var(--color-peer-" + std::to_string(color - 1) + ")";
}

// ── слои календаря ───────────────────────────────────────────────────────────

Layers parseLayers(const std::optional<std::string> &saved) {
    const auto hidden = util::split(saved.value_or(""), ',');
    auto has = [&](const char *name) { return std::find(hidden.begin(), hidden.end(), name) != hidden.end(); };
    return {!has("sleep"), !has("food"), !has("work")};
}

std::string serializeLayers(const Layers &layers) {
    std::string out;
    const bool values[] = {layers.sleep, layers.food, layers.work};
    for (size_t i = 0; i < kLayers.size(); ++i) {
        if (values[i]) continue;
        if (!out.empty()) out += ',';
        out += kLayers[i];
    }
    return out;
}

} // namespace parvane::sections::planner
