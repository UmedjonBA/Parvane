// Parvane fork (spec 029, T061): реализация planner_quick_suggest.h — порт web `plannerQuickSuggest.ts`.
// Тексты сравниваются в UTF-16 (как в web), кандидаты хранят строки в UTF-8: префиксы и вхождения целых кодовых
// точек в UTF-8 совпадают с теми же проверками в UTF-16.
#include "parvane/sections/planner_quick_suggest.h"

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <map>
#include <set>
#include <unordered_map>

#include "parvane/sections/planner_model.h"
#include "planner_quick_text.h"

namespace parvane::sections::planner {
namespace {

using text::S;

// Потолок строки в данных «Плана» — в байтах UTF-8 (схема `QuickLine.text`)
constexpr size_t kMaxLineBytes = 1200;
constexpr size_t kMaxLineLength = 300;
// Столько последних задач и столько же событий «Плана» становятся строками
constexpr size_t kMaxDataEntries = 150;
// Слово короче ищется только с начала слова
constexpr size_t kMinContainsLength = 2;
constexpr int kMinutesInHour = 60;

int sourceRank(const std::string &source) {
    return source == "history" ? 0 : source == "data" ? 1 : 2;
}

// Кодовые точки строки UTF-16 (пары суррогатов склеиваются)
std::u32string codepoints(const S &s) {
    std::u32string out;
    for (size_t i = 0; i < s.size(); ++i) {
        const char16_t c = s[i];
        if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.size() && s[i + 1] >= 0xDC00 && s[i + 1] <= 0xDFFF) {
            out.push_back(char32_t(0x10000 + ((c - 0xD800) << 10) + (s[i + 1] - 0xDC00)));
            ++i;
        } else {
            out.push_back(c);
        }
    }
    return out;
}

bool isWordChar(char32_t c) {
    return text::isLetter(c) || text::isNumber(c);
}

// `text.replace(/\s+/g, ' ')`
S collapseSpaces(const S &s) {
    S out;
    bool inSpace = false;
    for (const char16_t c : s) {
        if (text::isJsSpace(c)) {
            if (!inSpace) out.push_back(u' ');
            inSpace = true;
        } else {
            out.push_back(c);
            inSpace = false;
        }
    }
    return out;
}

S normalizeLine(const S &s) {
    return text::trim(collapseSpaces(s));
}

std::string normalizeLine(const std::string &s) {
    return text::toUtf8(normalizeLine(text::fromUtf8(s)));
}

// Сравнение без регистра, «ё» — «е»
S foldLine(const S &s) {
    return text::foldYo(text::jsLower(s));
}

std::string foldLine(const std::string &s) {
    return text::toUtf8(foldLine(text::fromUtf8(s)));
}

void appendPoint(std::string &out, char32_t cp) {
    if (cp < 0x80) {
        out.push_back(char(cp));
    } else if (cp < 0x800) {
        out.push_back(char(0xC0 | (cp >> 6)));
        out.push_back(char(0x80 | (cp & 0x3F)));
    } else if (cp < 0x10000) {
        out.push_back(char(0xE0 | (cp >> 12)));
        out.push_back(char(0x80 | ((cp >> 6) & 0x3F)));
        out.push_back(char(0x80 | (cp & 0x3F)));
    } else {
        out.push_back(char(0xF0 | (cp >> 18)));
        out.push_back(char(0x80 | ((cp >> 12) & 0x3F)));
        out.push_back(char(0x80 | ((cp >> 6) & 0x3F)));
        out.push_back(char(0x80 | (cp & 0x3F)));
    }
}

// `folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean)`
std::vector<std::string> tokenize(const std::string &folded) {
    std::vector<std::string> out;
    std::string word;
    for (const char32_t c : codepoints(text::fromUtf8(folded))) {
        if (isWordChar(c)) {
            appendPoint(word, c);
        } else if (!word.empty()) {
            out.push_back(word);
            word.clear();
        }
    }
    if (!word.empty()) out.push_back(word);
    return out;
}

size_t utf16Length(const std::string &s) {
    return text::fromUtf8(s).size();
}

bool startsWith(const std::string &s, const std::string &prefix) {
    return s.size() >= prefix.size() && s.compare(0, prefix.size(), prefix) == 0;
}

bool hasRuLetter(const S &s) {
    for (const char16_t c : s) {
        if ((c >= 0x430 && c <= 0x44F) || (c >= 0x410 && c <= 0x42F) || c == 0x451 || c == 0x401) return true;
    }
    return false;
}

bool hasEnLetter(const S &s) {
    for (const char16_t c : s) {
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) return true;
    }
    return false;
}

// Язык слов строки — по буквам названия
std::string pickLineLang(const std::string &name, const std::string &uiLang) {
    const auto s = text::fromUtf8(name);
    const bool hasRu = hasRuLetter(s);
    const bool hasEn = hasEnLetter(s);
    return hasRu == hasEn ? uiLang : hasRu ? "ru" : "en";
}

std::string pluralRu(int count, const char *one, const char *few, const char *many) {
    const int ones = count % 10;
    const int tens = count % 100;
    if (ones == 1 && tens != 11) return one;
    return ones >= 2 && ones <= 4 && (tens < 12 || tens > 14) ? few : many;
}

// ── слова строки (те же, что понимает разбор) ───────────────────────────────

const char *kRuWeekdays[] = {"вс", "пн", "вт", "ср", "чт", "пт", "сб"};
const char *kEnWeekdays[] = {"sun", "mon", "tue", "wed", "thu", "fri", "sat"};

std::string weekdayWord(int weekday, const std::string &lang) {
    const int index = ((weekday % 7) + 7) % 7;
    return lang == "en" ? kEnWeekdays[index] : kRuWeekdays[index];
}

std::string everyWords(const std::string &kind, int interval, const std::string &lang) {
    if (lang == "en") {
        const std::string unit = kind == "daily" ? "day" : kind == "weekly" ? "week" : kind == "monthly" ? "month"
                                                                                                         : "year";
        return interval == 1 ? "every " + unit : "every " + std::to_string(interval) + " " + unit + "s";
    }
    if (interval == 1) {
        return kind == "daily" ? "каждый день" : kind == "weekly" ? "каждую неделю"
            : kind == "monthly" ? "каждый месяц" : "каждый год";
    }
    std::string unit;
    if (kind == "daily") unit = pluralRu(interval, "день", "дня", "дней");
    else if (kind == "weekly") unit = pluralRu(interval, "неделю", "недели", "недель");
    else if (kind == "monthly") unit = pluralRu(interval, "месяц", "месяца", "месяцев");
    else unit = pluralRu(interval, "год", "года", "лет");
    return "каждые " + std::to_string(interval) + " " + unit;
}

std::string formatLineMinutes(int minutes, const std::string &lang) {
    const int hours = minutes / kMinutesInHour;
    const int rest = minutes % kMinutesInHour;
    std::string out;
    if (hours) out = std::to_string(hours) + (lang == "en" ? " h" : " ч");
    if (rest) {
        if (!out.empty()) out += ' ';
        out += std::to_string(rest) + (lang == "en" ? " min" : " мин");
    }
    return out;
}

// Дни недели (до времени) и слова повтора (после длительности)
std::pair<std::string, std::string> formatLineRepeat(const QuickLineRepeat &repeat, const std::string &lang,
                                                     bool isExplicit) {
    const auto every = everyWords(repeat.kind, repeat.interval, lang);
    std::vector<int> weekdays;
    for (const int day : repeat.weekdays.value_or(std::vector<int>{})) {
        if (std::find(weekdays.begin(), weekdays.end(), day) == weekdays.end()) weekdays.push_back(day);
    }
    // Понедельник — первым
    std::stable_sort(weekdays.begin(), weekdays.end(), [](int a, int b) { return (a + 6) % 7 < (b + 6) % 7; });
    if (repeat.kind != "weekly" || weekdays.empty()) return {std::string(), every};
    if (weekdays.size() == 1 && !isExplicit) return {weekdayWord(weekdays[0], lang), every};
    const auto isSet = [&](std::vector<int> set) {
        if (weekdays.size() != set.size()) return false;
        for (const int day : set) {
            if (std::find(weekdays.begin(), weekdays.end(), day) == weekdays.end()) return false;
        }
        return true;
    };
    std::string days;
    if (isSet({1, 2, 3, 4, 5})) {
        days = lang == "en" ? "on weekdays" : "по будням";
    } else if (isSet({6, 0})) {
        days = lang == "en" ? "on weekends" : "по выходным";
    } else if (weekdays.size() == 1) {
        days = (lang == "en" ? "every " : "по ") + weekdayWord(weekdays[0], lang);
    } else {
        std::string list;
        for (size_t i = 0; i < weekdays.size(); ++i) {
            if (i) list += ", ";
            list += weekdayWord(weekdays[i], lang);
        }
        days = (lang == "en" ? "on " : "по ") + list;
    }
    return {days, repeat.interval > 1 ? every : std::string()};
}

// Название списка, годное в метку `#…` (`/^\p{L}[\p{L}\p{N}_-]*$/u` над названием с «_» вместо пробелов)
std::optional<std::string> lineList(const std::optional<std::string> &list) {
    if (!list) return std::nullopt;
    const auto name = normalizeLine(*list);
    if (name.empty()) return std::nullopt;
    const auto points = codepoints(text::fromUtf8(name));
    if (points.empty() || !text::isLetter(points[0])) return std::nullopt;
    for (size_t i = 1; i < points.size(); ++i) {
        const char32_t c = points[i];
        if (!(isWordChar(c) || c == U' ' || c == U'_' || c == U'-')) return std::nullopt;
    }
    return name;
}

std::optional<double> getLineMinutes(const QuickLineDraft &draft, const std::string &lang, bool hasTime,
                                     bool isExplicit) {
    if (draft.kind == "task") {
        if (!isExplicit && hasTime && draft.minutes && *draft.minutes == kQuickTaskMinutes) return std::nullopt;
        return draft.minutes;
    }
    if (!hasTime || !draft.end) return std::nullopt;
    const int span = toMinutes(*draft.end) - toMinutes(*draft.start);
    if (span > 0 && (isExplicit || span != quickUsualMinutes(draft.name, lang))) return double(span);
    return std::nullopt;
}

bool isSameRepeat(const std::optional<Repeat> &parsed, const std::optional<QuickLineRepeat> &repeat) {
    if (!parsed || !repeat) return !parsed && !repeat;
    if (parsed->kind != repeat->kind || parsed->interval != repeat->interval || parsed->endDay
        || (parsed->count && *parsed->count)) {
        return false;
    }
    if (repeat->kind != "weekly") return true;
    auto a = parsed->weekdays.value_or(std::vector<int>{});
    auto b = repeat->weekdays.value_or(std::vector<int>{});
    std::sort(a.begin(), a.end());
    std::sort(b.begin(), b.end());
    return a == b;
}

bool nonEmpty(const std::optional<std::string> &value) {
    return value && !value->empty();
}

std::string lowerUtf8(const std::string &s) {
    return text::toUtf8(text::jsLower(text::fromUtf8(s)));
}

bool isSameEntry(const QuickDraft &parsed, const QuickLineDraft &draft) {
    if (parsed.error || parsed.kind != draft.kind || parsed.name != draft.name) return false;
    if (nonEmpty(parsed.description) || nonEmpty(parsed.due) || nonEmpty(parsed.place)
        || parsed.isImportant.value_or(false)) {
        return false;
    }
    if (lowerUtf8(parsed.list.value_or("")) != lowerUtf8(lineList(draft.list).value_or(""))) return false;
    if (!isSameRepeat(parsed.repeat, draft.repeat)) return false;
    // День в строку не пишется: названный днём кусок названия — не та запись
    if (!draft.repeat && nonEmpty(parsed.day) && !parsed.isDayAssumed.value_or(false)) return false;
    if (draft.kind == "task") return parsed.start == draft.start && parsed.minutes == draft.minutes;
    if (draft.isAllDay) return parsed.isAllDay.value_or(false);
    return !parsed.isAllDay.value_or(false) && parsed.start == draft.start && parsed.end == draft.end;
}

// Строка записи, проверенная разбором: предлагается, только если разбор вернёт ту же запись
std::optional<std::string> verifiedLine(const QuickLineDraft &draft, const std::string &lang,
                                        const QuickContext &ctx) {
    for (const bool isExplicit : {false, true}) {
        const auto line = draftToLine(draft, lang, isExplicit);
        if (utf16Length(line) <= kMaxLineLength && isSameEntry(parseQuickInput(line, ctx), draft)) return line;
    }
    return std::nullopt;
}

QuickCandidate makeCandidate(const std::string &textValue, const std::string &source, const std::string &key,
                             const std::string &name, double count, double at,
                             const std::vector<std::string> &texts, const std::string &kind) {
    QuickCandidate c;
    c.text = textValue;
    c.source = source;
    c.key = key;
    c.line = foldLine(normalizeLine(textValue));
    c.words = tokenize(c.line);
    auto nameWords = tokenize(foldLine(name));
    // У записей здоровья названия нет: строка ищется по своим словам
    c.nameWords = nameWords.empty() ? c.words : nameWords;
    c.count = count;
    c.at = at;
    c.texts = texts;
    c.kind = kind;
    return c;
}

struct DataEntry {
    std::string key;
    QuickLineDraft draft;
    std::string lang;
    double count = 0;
    double at = 0;
};

QuickLineRepeat lineRepeat(const Repeat &repeat) {
    return QuickLineRepeat{repeat.kind, repeat.interval, repeat.weekdays};
}

// Задачи и события «Плана», сведённые к шаблонам: одинаковые записи — один шаблон со счётчиком
std::vector<DataEntry> collectEntries(const QuickSuggestSources &sources, const std::string &uiLang) {
    std::vector<DataEntry> entries;
    std::unordered_map<std::string, size_t> byKey;
    const auto put = [&](QuickLineDraft draft, double at) {
        const auto name = normalizeLine(draft.name);
        // Многострочное название одной строкой не записать
        if (name.empty() || draft.name.find('\n') != std::string::npos) return;
        const auto lang = pickLineLang(name, uiLang);
        draft.name = name;
        const auto key = foldLine(draftToLine(draft, lang));
        const auto it = byKey.find(key);
        if (it != byKey.end()) {
            auto &known = entries[it->second];
            known.count += 1;
            known.at = std::max(known.at, at);
        } else {
            byKey.emplace(key, entries.size());
            entries.push_back(DataEntry{key, draft, lang, 1, at});
        }
    };
    // Отделённый экземпляр ряда — не отдельное дело
    std::vector<const Task *> tasks;
    for (const auto &task : sources.tasks) {
        if (!task.origin) tasks.push_back(&task);
    }
    if (tasks.size() > kMaxDataEntries) tasks.erase(tasks.begin(), tasks.end() - kMaxDataEntries);
    std::reverse(tasks.begin(), tasks.end());
    for (size_t i = 0; i < tasks.size(); ++i) {
        const auto &task = *tasks[i];
        QuickLineDraft draft;
        draft.kind = "task";
        draft.name = task.name;
        draft.start = task.start;
        if (task.minutes) draft.minutes = double(*task.minutes);
        if (task.repeat) draft.repeat = lineRepeat(*task.repeat);
        if (!task.project.empty()) draft.list = task.project;
        put(draft, -double(i));
    }
    std::vector<const Event *> events;
    for (const auto &event : sources.events) {
        if (!event.origin) events.push_back(&event);
    }
    if (events.size() > kMaxDataEntries) events.erase(events.begin(), events.end() - kMaxDataEntries);
    std::reverse(events.begin(), events.end());
    for (size_t i = 0; i < events.size(); ++i) {
        const auto &event = *events[i];
        const bool allDay = event.isAllDay.value_or(false);
        QuickLineDraft draft;
        draft.kind = "event";
        draft.name = event.name;
        if (!allDay) {
            draft.start = event.start;
            draft.end = event.end;
        }
        draft.isAllDay = allDay;
        if (event.repeat) draft.repeat = lineRepeat(*event.repeat);
        if (event.project && !event.project->empty()) draft.list = event.project;
        put(draft, -double(i));
    }
    return entries;
}

bool matchClass(const QuickCandidate &candidate, const std::string &typed, const std::string &whole,
                const std::vector<std::string> &words, const std::optional<std::string> &prefix, int &out) {
    const auto &line = candidate.line;
    if (line == whole) return false;
    if (startsWith(line, typed)) {
        out = 0;
        return true;
    }
    // Дописанные слова — слова строки целиком
    for (const auto &item : words) {
        if (std::find(candidate.words.begin(), candidate.words.end(), item) == candidate.words.end()) return false;
    }
    if (!prefix) {
        const bool inName = std::any_of(words.begin(), words.end(), [&](const std::string &item) {
            return std::find(candidate.nameWords.begin(), candidate.nameWords.end(), item)
                != candidate.nameWords.end();
        });
        out = inName ? 1 : 2;
        return true;
    }
    for (const auto &item : candidate.nameWords) {
        if (startsWith(item, *prefix)) {
            out = 1;
            return true;
        }
    }
    bool isContained = false;
    if (utf16Length(*prefix) >= kMinContainsLength) {
        isContained = line.find(*prefix) != std::string::npos;
    } else {
        isContained = std::any_of(candidate.words.begin(), candidate.words.end(), [&](const std::string &item) {
            return startsWith(item, *prefix);
        });
    }
    if (!isContained) return false;
    out = 2;
    return true;
}

// ── хэш строки (cyrb53, обе половины) ────────────────────────────────────────

std::string hashLine(const S &value) {
    uint32_t h1 = 0xdeadbeefu;
    uint32_t h2 = 0x41c6ce57u;
    for (const char16_t code : value) {
        h1 = (h1 ^ uint32_t(code)) * 2654435761u;
        h2 = (h2 ^ uint32_t(code)) * 1597334677u;
    }
    h1 = ((h1 ^ (h1 >> 16)) * 2246822507u) ^ ((h2 ^ (h2 >> 13)) * 3266489909u);
    h2 = ((h2 ^ (h2 >> 16)) * 2246822507u) ^ ((h1 ^ (h1 >> 13)) * 3266489909u);
    char buffer[17];
    std::snprintf(buffer, sizeof(buffer), "%08x%08x", unsigned(h2), unsigned(h1));
    return buffer;
}

// Движок принимает одну строку без управляющих знаков, не длиннее потолка в байтах
bool isSyncedLine(const std::string &value) {
    for (const char32_t c : codepoints(text::fromUtf8(value))) {
        if (c < 0x20 || (c >= 0x7F && c <= 0x9F)) return false;
    }
    return value.size() <= kMaxLineBytes;
}

} // namespace

// ── подсказки ────────────────────────────────────────────────────────────────

std::vector<QuickCandidate> buildCandidates(const QuickSuggestSources &sources, const QuickContext &ctx) {
    const auto uiLang = ctx.lang.value_or("ru");
    std::vector<QuickCandidate> list;
    std::unordered_map<std::string, size_t> byKey;
    std::set<std::string> lines;
    const auto add = [&](QuickCandidate candidate) {
        lines.insert(candidate.line);
        const auto it = byKey.find(candidate.key);
        if (it != byKey.end()) {
            list[it->second] = std::move(candidate);
        } else {
            byKey.emplace(candidate.key, list.size());
            list.push_back(std::move(candidate));
        }
    };

    for (const auto &item : sources.history.lines) {
        const auto draft = parseQuickInput(item.text, ctx);
        if (draft.error) continue;
        const auto key = lineKey(item.text, draft, uiLang);
        const auto it = byKey.find(key);
        // Строки одного шаблона: показывается самая свежая
        if (it != byKey.end()) {
            list[it->second].count += item.count;
            list[it->second].texts.push_back(item.text);
            continue;
        }
        add(makeCandidate(item.text, "history", key, draft.name, item.count, item.at, {item.text}, draft.kind));
    }

    const std::set<std::string> hidden(sources.history.hidden.begin(), sources.history.hidden.end());
    for (const auto &entry : collectEntries(sources, uiLang)) {
        const auto it = byKey.find(entry.key);
        // Запись, добавленная этой же строкой истории, новой подсказки не даёт — только вес
        if (it != byKey.end()) {
            list[it->second].count = std::max(list[it->second].count, entry.count);
            continue;
        }
        if (hidden.count(entry.key)) continue;
        const auto line = verifiedLine(entry.draft, entry.lang, ctx);
        if (line && !lines.count(foldLine(*line))) {
            add(makeCandidate(*line, "data", entry.key, entry.draft.name, entry.count, entry.at, {},
                              entry.draft.kind));
        }
    }

    for (size_t index = 0; index < sources.examples.size(); ++index) {
        const auto value = normalizeLine(sources.examples[index]);
        const auto key = foldLine(value);
        if (value.empty() || lines.count(key) || byKey.count(key)) continue;
        const auto draft = parseQuickInput(value, ctx);
        if (!draft.error) {
            add(makeCandidate(value, "example", key, draft.name, 0, -double(kMaxDataEntries) - 1 - double(index), {},
                              draft.kind));
        }
    }

    std::stable_sort(list.begin(), list.end(), [](const QuickCandidate &a, const QuickCandidate &b) {
        if (a.count != b.count) return a.count > b.count;
        const int ra = sourceRank(a.source);
        const int rb = sourceRank(b.source);
        if (ra != rb) return ra < rb;
        return a.at > b.at;
    });
    return list;
}

std::vector<QuickSuggestion> filterSuggestions(const std::string &input, const std::vector<QuickCandidate> &all,
                                               size_t limit, const std::optional<std::vector<std::string>> &kinds) {
    std::vector<const QuickCandidate *> candidates;
    for (const auto &candidate : all) {
        if (!kinds || std::find(kinds->begin(), kinds->end(), candidate.kind) != kinds->end()) {
            candidates.push_back(&candidate);
        }
    }
    const auto typed16 = foldLine(text::trimStart(collapseSpaces(text::fromUtf8(input))));
    const auto typed = text::toUtf8(typed16);
    const auto whole = text::toUtf8(text::trimEnd(typed16));
    std::vector<const QuickCandidate *> picked;
    if (whole.empty()) {
        for (size_t i = 0; i < candidates.size() && i < limit; ++i) picked.push_back(candidates[i]);
    } else {
        auto words = tokenize(typed);
        // Строка кончается буквой либо цифрой — последнее слово ещё дописывается
        std::optional<std::string> prefix;
        const auto points = codepoints(typed16);
        if (!points.empty() && isWordChar(points.back()) && !words.empty()) {
            prefix = words.back();
            words.pop_back();
        }
        std::vector<const QuickCandidate *> classes[3];
        for (const auto *candidate : candidates) {
            int matched = 0;
            if (matchClass(*candidate, typed, whole, words, prefix, matched)) classes[matched].push_back(candidate);
        }
        for (const auto &bucket : classes) {
            for (const auto *candidate : bucket) {
                if (picked.size() < limit) picked.push_back(candidate);
            }
        }
    }
    std::vector<QuickSuggestion> out;
    out.reserve(picked.size());
    for (const auto *candidate : picked) out.push_back(QuickSuggestion{candidate->text, candidate->source});
    return out;
}

std::vector<QuickSuggestion> buildSuggestions(const std::string &input, const QuickSuggestSources &sources,
                                              const QuickContext &ctx) {
    return filterSuggestions(input, buildCandidates(sources, ctx));
}

bool isSuggestionPrefix(const std::string &input, const std::string &suggestion) {
    const auto typed16 = foldLine(text::trimStart(collapseSpaces(text::fromUtf8(input))));
    const auto typed = text::toUtf8(typed16);
    const auto line = foldLine(normalizeLine(suggestion));
    return !text::trim(typed16).empty() && startsWith(line, typed) && line != text::toUtf8(text::trimEnd(typed16));
}

std::string lineKey(const std::string &value, const QuickDraft &draft, const std::string &uiLang) {
    if (draft.kind != "task" && draft.kind != "event") return foldLine(normalizeLine(value));
    QuickLineDraft line;
    line.kind = draft.kind;
    line.name = draft.name;
    const bool allDay = draft.isAllDay.value_or(false);
    if (!allDay) line.start = draft.start;
    line.end = draft.end;
    line.isAllDay = allDay;
    line.minutes = draft.minutes;
    if (draft.repeat) line.repeat = lineRepeat(*draft.repeat);
    line.list = draft.list;
    return foldLine(draftToLine(line, pickLineLang(draft.name, uiLang)));
}

std::string draftToLine(const QuickLineDraft &draft, const std::string &lang, bool isExplicit) {
    const bool isEvent = draft.kind == "event";
    const bool hasTime = draft.start && !draft.start->empty() && !draft.isAllDay;
    std::string days;
    std::string every;
    if (draft.repeat) std::tie(days, every) = formatLineRepeat(*draft.repeat, lang, isExplicit);
    const auto minutes = getLineMinutes(draft, lang, hasTime, isExplicit);
    const auto list = lineList(draft.list);
    std::vector<std::string> parts;
    if (isExplicit || isEvent != hasTime) {
        parts.push_back(isEvent ? (lang == "en" ? "event" : "событие") : (lang == "en" ? "task" : "задача"));
    }
    parts.push_back(normalizeLine(draft.name));
    parts.push_back(days);
    if (hasTime) parts.push_back(*draft.start);
    if (minutes && *minutes) parts.push_back(formatLineMinutes(int(*minutes), lang));
    parts.push_back(every);
    if (list) {
        auto mark = *list;
        std::replace(mark.begin(), mark.end(), ' ', '_');
        parts.push_back("#" + mark);
    }
    std::string out;
    for (const auto &part : parts) {
        if (part.empty()) continue;
        if (!out.empty()) out += ' ';
        out += part;
    }
    return out;
}

// ── история ──────────────────────────────────────────────────────────────────

HistoryResult recordHistoryLine(const QuickHistory &history, const std::string &typed, const std::string &key) {
    const auto value = normalizeLine(typed);
    if (value.empty() || utf16Length(value) > kMaxLineLength) return {history, false};
    const auto folded = foldLine(value);
    const QuickHistoryLine *known = nullptr;
    for (const auto &line : history.lines) {
        if (foldLine(line.text) == folded) {
            known = &line;
            break;
        }
    }
    QuickHistory next;
    next.tick = history.tick + 1;
    next.lines.push_back(QuickHistoryLine{value, (known ? known->count : 0) + 1, next.tick});
    for (const auto &line : history.lines) {
        if (&line != known) next.lines.push_back(line);
    }
    if (next.lines.size() > kHistoryMaxLines) next.lines.resize(kHistoryMaxLines);
    for (const auto &item : history.hidden) {
        if (item != key) next.hidden.push_back(item);
    }
    return {next, true};
}

QuickHistory forgetSuggestion(const QuickHistory &history, const std::string &key,
                              const std::vector<std::string> &texts) {
    std::set<std::string> folded;
    for (const auto &item : texts) folded.insert(foldLine(item));
    QuickHistory next;
    next.tick = history.tick;
    for (const auto &line : history.lines) {
        if (!folded.count(foldLine(line.text))) next.lines.push_back(line);
    }
    next.hidden.push_back(key);
    for (const auto &item : history.hidden) {
        if (item != key) next.hidden.push_back(item);
    }
    if (next.hidden.size() > kHistoryMaxHidden) next.hidden.resize(kHistoryMaxHidden);
    return next;
}

// ── история в данных «Плана» ─────────────────────────────────────────────────

std::string quickLineId(const std::string &value, bool isHidden) {
    return (isHidden ? "h" : "q") + hashLine(foldLine(normalizeLine(text::fromUtf8(value))));
}

QuickHistory historyFromLines(const std::vector<QuickLine> &lines) {
    QuickHistory history;
    std::vector<const QuickLine *> sorted;
    for (const auto &line : lines) sorted.push_back(&line);
    std::stable_sort(sorted.begin(), sorted.end(), [](const QuickLine *a, const QuickLine *b) {
        if (a->touched != b->touched) return a->touched > b->touched;
        return a->id < b->id;
    });
    std::set<std::string> seen;
    for (const auto *line : sorted) {
        history.tick = std::max(history.tick, line->touched);
        const auto value = normalizeLine(line->text);
        const bool hidden = line->isHidden.value_or(false);
        const auto mark = (hidden ? "h" : "q") + foldLine(value);
        if (value.empty() || utf16Length(value) > kMaxLineLength || seen.count(mark)) continue;
        seen.insert(mark);
        if (hidden) {
            history.hidden.push_back(value);
        } else {
            history.lines.push_back(QuickHistoryLine{value, double(std::max(1, line->count)), line->touched});
        }
    }
    if (history.lines.size() > kHistoryMaxLines) history.lines.resize(kHistoryMaxLines);
    if (history.hidden.size() > kHistoryMaxHidden) history.hidden.resize(kHistoryMaxHidden);
    return history;
}

std::vector<QuickLine> historyToLines(const QuickHistory &history, const std::vector<QuickLine> &previous) {
    std::map<std::string, const QuickLine *> known;
    for (const auto &line : previous) known.emplace(line.id, &line);
    std::vector<QuickLine> lines;
    for (size_t i = 0; i < history.lines.size() && i < kHistoryMaxLines; ++i) {
        const auto &item = history.lines[i];
        if (!isSyncedLine(item.text)) continue;
        QuickLine line;
        line.id = quickLineId(item.text);
        line.text = item.text;
        line.count = int(item.count);
        line.touched = item.at;
        lines.push_back(line);
    }
    for (size_t i = 0; i < history.hidden.size() && i < kHistoryMaxHidden; ++i) {
        const auto &key = history.hidden[i];
        if (!isSyncedLine(key)) continue;
        QuickLine line;
        line.id = quickLineId(key, true);
        line.text = key;
        line.count = 0;
        const auto it = known.find(line.id);
        line.touched = it != known.end() ? it->second->touched : history.tick;
        line.isHidden = true;
        lines.push_back(line);
    }
    std::stable_sort(lines.begin(), lines.end(), [](const QuickLine &a, const QuickLine &b) { return a.id < b.id; });
    return lines;
}

std::vector<QuickLine> recordQuickLine(const std::vector<QuickLine> &lines, const std::string &typed,
                                       const std::string &key) {
    return historyToLines(recordHistoryLine(historyFromLines(lines), typed, key).history, lines);
}

std::vector<QuickLine> forgetQuickLine(const std::vector<QuickLine> &lines, const std::string &key,
                                       const std::vector<std::string> &texts) {
    return historyToLines(forgetSuggestion(historyFromLines(lines), key, texts), lines);
}

} // namespace parvane::sections::planner
