// Parvane fork (spec 029, фаза 4): расписание на неделю текстом — порт web `plannerSchedule.ts`. Регулярки web
// разобраны вручную: граница слова и регистр — по кодовым точкам (латиница и кириллица).
#include "parvane/sections/planner_schedule.h"

#include <utility>

#include "planner_util.h"

namespace parvane::sections::planner {

namespace {

// Дни недели как у `Date.getDay`; порядок вариантов — как в чередовании регулярки web
const std::vector<std::pair<std::vector<std::string>, int>> kWeekdayWords = {
    {{"понедельник", "пн", "monday", "mon"}, 1},
    {{"вторник", "вт", "tuesday", "tues", "tue"}, 2},
    {{"среда", "ср", "wednesday", "wed"}, 3},
    {{"четверг", "чт", "thursday", "thurs", "thu"}, 4},
    {{"пятница", "пт", "friday", "fri"}, 5},
    {{"суббота", "сб", "saturday", "sat"}, 6},
    {{"воскресенье", "вс", "sunday", "sun"}, 0},
};

const std::vector<std::string> kEndWords = {"до", "until", "till"};

// `[\s:,.;—–-]`
bool isWeekdaySeparator(char32_t c) {
    return util::isSpace(c) || c == ':' || c == ',' || c == '.' || c == ';' || c == 0x2014 || c == 0x2013
        || c == '-';
}

// `[-–—]`
bool isDash(char32_t c) { return c == '-' || c == 0x2013 || c == 0x2014; }

// `.` в JS не совпадает с концами строк
bool isLineTerminator(char32_t c) { return c == '\n' || c == '\r' || c == 0x2028 || c == 0x2029; }

char32_t at(const std::string &s, size_t i, size_t &len) {
    if (i >= s.size()) {
        len = 0;
        return 0;
    }
    return util::decodeAt(s, i, len);
}

size_t skipSpaces(const std::string &s, size_t i) {
    while (i < s.size()) {
        size_t len = 0;
        if (!util::isSpace(at(s, i, len))) break;
        i += len;
    }
    return i;
}

// `\d{min,max}` жадно с позиции `i`; `nullopt` — цифр меньше `min`
std::optional<std::string> digits(const std::string &s, size_t &i, size_t min, size_t max) {
    size_t n = 0;
    while (n < max && i + n < s.size() && util::isDigit(s[i + n])) ++n;
    if (n < min) return std::nullopt;
    auto out = s.substr(i, n);
    i += n;
    return out;
}

struct WeekdayMatch {
    int weekday = 0;
    std::string rest;
};

std::optional<WeekdayMatch> matchWeekday(const std::string &line) {
    const auto lower = util::lower(line);
    for (const auto &[words, weekday] : kWeekdayWords) {
        for (const auto &word : words) {
            if (lower.compare(0, word.size(), word) != 0) continue;
            size_t p = word.size();
            size_t len = 0;
            if (p < line.size() && !isWeekdaySeparator(at(line, p, len))) continue;
            while (p < line.size()) {
                if (!isWeekdaySeparator(at(line, p, len))) break;
                p += len;
            }
            return WeekdayMatch{weekday, line.substr(p)};
        }
    }
    return std::nullopt;
}

struct TimeRange {
    std::string h1, m1, h2, m2, title;
};

// `^(\d{1,2})[:.](\d{2})\s*[-–—]\s*(\d{1,2})[:.](\d{2})\s*(.*)$`
std::optional<TimeRange> matchTimeRange(const std::string &s) {
    size_t i = 0;
    size_t len = 0;
    TimeRange range;
    auto hours1 = digits(s, i, 1, 2);
    if (!hours1 || (s[i] != ':' && s[i] != '.')) return std::nullopt;
    ++i;
    auto minutes1 = digits(s, i, 2, 2);
    if (!minutes1) return std::nullopt;
    i = skipSpaces(s, i);
    if (!isDash(at(s, i, len))) return std::nullopt;
    i = skipSpaces(s, i + len);
    auto hours2 = digits(s, i, 1, 2);
    if (!hours2 || i >= s.size() || (s[i] != ':' && s[i] != '.')) return std::nullopt;
    ++i;
    auto minutes2 = digits(s, i, 2, 2);
    if (!minutes2) return std::nullopt;
    i = skipSpaces(s, i);
    for (size_t k = i; k < s.size(); k += len) {
        if (isLineTerminator(at(s, k, len))) return std::nullopt;
    }
    return TimeRange{*hours1, *minutes1, *hours2, *minutes2, s.substr(i)};
}

std::optional<std::string> toTimeString(const std::string &hours, const std::string &minutes) {
    const int h = std::stoi(hours);
    const int m = std::stoi(minutes);
    if (h > 23 || m > 59) return std::nullopt;
    return util::pad2(h) + ":" + minutes;
}

// `(?:^|\s)(?:до|until|till)\s+` + `tail`; первое совпадение слева
template <typename Tail>
std::optional<std::vector<std::string>> findEnd(const std::string &text, Tail &&tail) {
    const auto lower = util::lower(text);
    auto tryAt = [&](size_t q) -> std::optional<std::vector<std::string>> {
        for (const auto &word : kEndWords) {
            if (lower.compare(q, word.size(), word) != 0) continue;
            size_t p = q + word.size();
            const size_t afterSpaces = skipSpaces(text, p);
            if (afterSpaces == p) continue;
            if (auto groups = tail(text, afterSpaces)) return groups;
        }
        return std::nullopt;
    };
    for (size_t p = 0; p <= text.size();) {
        if (p == 0) {
            if (auto groups = tryAt(0)) return groups;
        }
        if (p == text.size()) break;
        size_t len = 0;
        const auto cp = at(text, p, len);
        if (util::isSpace(cp)) {
            if (auto groups = tryAt(p + len)) return groups;
        }
        p += len;
    }
    return std::nullopt;
}

int daysInMonth(long long year, int month) {
    static const int days[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
    if (month == 2) {
        const bool leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        return leap ? 29 : 28;
    }
    return days[month - 1];
}

std::optional<std::string> findEndDay(const std::string &text) {
    // `(\d{1,2})\.(\d{1,2})\.(\d{4})`
    const auto dotted = findEnd(text, [](const std::string &s, size_t i) -> std::optional<std::vector<std::string>> {
        auto day = digits(s, i, 1, 2);
        if (!day || i >= s.size() || s[i] != '.') return std::nullopt;
        ++i;
        auto month = digits(s, i, 1, 2);
        if (!month || i >= s.size() || s[i] != '.') return std::nullopt;
        ++i;
        auto year = digits(s, i, 4, 4);
        if (!year) return std::nullopt;
        return std::vector<std::string>{*year, *month, *day};
    });
    // `(\d{4})-(\d{2})-(\d{2})`
    const auto iso = findEnd(text, [](const std::string &s, size_t i) -> std::optional<std::vector<std::string>> {
        auto year = digits(s, i, 4, 4);
        if (!year || i >= s.size() || s[i] != '-') return std::nullopt;
        ++i;
        auto month = digits(s, i, 2, 2);
        if (!month || i >= s.size() || s[i] != '-') return std::nullopt;
        ++i;
        auto day = digits(s, i, 2, 2);
        if (!day) return std::nullopt;
        return std::vector<std::string>{*year, *month, *day};
    });
    const auto &groups = dotted ? dotted : iso;
    if (!groups) return std::nullopt;
    const auto &year = (*groups)[0];
    const auto month = (*groups)[1].size() < 2 ? "0" + (*groups)[1] : (*groups)[1];
    const auto day = (*groups)[2].size() < 2 ? "0" + (*groups)[2] : (*groups)[2];
    // Негодная дата (31 февраля, месяц 13) — без даты, как `new Date(...)` в web
    const int m = std::stoi(month);
    const int d = std::stoi(day);
    if (m < 1 || m > 12 || d < 1 || d > daysInMonth(std::stoll(year), m)) return std::nullopt;
    return year + "-" + month + "-" + day;
}

} // namespace

ParsedSchedule parseSchedule(const std::string &text) {
    ParsedSchedule out;
    std::optional<int> weekday;
    for (const auto &raw : util::split(text, '\n')) {
        const auto line = util::trim(raw);
        if (line.empty()) continue;
        // День недели — заголовком («Понедельник») или в начале строки со временем («Пн 10:00–11:00 …»)
        const auto day = matchWeekday(line);
        if (day) weekday = day->weekday;
        const auto range = matchTimeRange(day ? day->rest : line);
        if (!range) continue;
        const auto start = toTimeString(range->h1, range->m1);
        const auto end = toTimeString(range->h2, range->m2);
        const auto title = util::trim(range->title);
        if (!weekday || !start || !end || toMinutes(*end) <= toMinutes(*start) || title.empty()) {
            out.skipped.push_back(line);
            continue;
        }
        const auto comma = title.find(',');
        const bool hasComma = comma != std::string::npos && comma > 0;
        const auto name = util::takeCodepoints(util::trim(hasComma ? title.substr(0, comma) : title),
                                               kScheduleMaxNameLength);
        std::optional<std::string> description;
        if (hasComma) {
            const auto rest = util::trim(title.substr(comma + 1));
            if (!rest.empty()) description = rest;
        }
        out.items.push_back({*weekday, *start, *end, name, description});
    }
    out.endDay = findEndDay(text);
    return out;
}

std::vector<Event> buildScheduleEvents(const std::vector<ScheduleItem> &items, const std::string &startDay,
                                       const std::string &endDay, const std::optional<std::string> &project,
                                       const IdGen &newId) {
    std::vector<Event> events;
    for (const auto &item : items) {
        Event event;
        event.id = newId();
        event.name = item.name;
        if (project && !project->empty()) event.project = project;
        event.description = item.description;
        event.start = item.start;
        event.end = item.end;
        Repeat repeat;
        repeat.kind = "weekly";
        repeat.interval = 1;
        repeat.weekdays = std::vector<int>{item.weekday};
        repeat.startDay = startDay;
        repeat.endDay = endDay;
        event.repeat = repeat;
        event.occurrences = std::vector<Occurrence>();
        if (!validateRepeat(repeat)) events.push_back(event);
    }
    return events;
}

} // namespace parvane::sections::planner
