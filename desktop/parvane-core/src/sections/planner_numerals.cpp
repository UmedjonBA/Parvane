// Parvane fork (spec 029, фаза 4): числительные словами для ввода текстом «Плана» — порт web plannerNumerals.ts.
//
// Правило: слово-число значит ровно то же, что цифра на его месте. Исключение — разговорные часы, у которых
// цифровой записи нет («полтретьего», «без четверти пять», half past, quarter to/past): они двенадцатичасовые,
// половину суток выбирает разбор по окну дня (`isLoose`).
//
// Особенность web, перенесённая как есть: словари чисел в web — обычные объекты JS, поэтому слово
// «constructor» находится в любом из них (это Object.prototype.constructor) и ведёт себя как «не число» (NaN),
// которое при выводе пишется как «function Object() { [native code] }». Для пользователя это незаметно:
// незабранная замена возвращает исходные слова.
#include "parvane/sections/planner_numerals.h"

#include <cmath>
#include <functional>
#include <map>
#include <set>

#include "planner_quick_text.h"

namespace parvane::sections::planner {

using namespace text;

namespace {

constexpr int kMinutesInHour = 60;
constexpr int kHoursOnDial = 12;
constexpr int kMaxHour = 23;
constexpr int kFirstTens = 20;
constexpr int kTen = 10;
const char16_t *const kFunctionText = u"function Object() { [native code] }";

// Значение словаря: число либо «функция» (слово constructor, см. шапку) — она ведёт себя как NaN
struct Num {
    double v = 0;
    bool fn = false;
};

S numText(const Num &n) {
    if (n.fn) return kFunctionText;
    if (std::isnan(n.v)) return u"NaN";
    const double r = std::round(n.v);
    if (r == n.v) return fromUtf8(std::to_string((long long)r));
    // Нецелых в словарях нет; на всякий случай — как JS для простых дробей
    std::string s = std::to_string(n.v);
    while (!s.empty() && s.back() == '0') s.pop_back();
    if (!s.empty() && s.back() == '.') s.pop_back();
    return fromUtf8(s);
}

using Numbers = std::map<S, int>;

std::optional<Num> lookup(const Numbers &numbers, const std::optional<S> &word) {
    const S key = word.value_or(u"");
    if (key == u"constructor") return Num{NAN, true};
    const auto it = numbers.find(key);
    if (it == numbers.end()) return std::nullopt;
    return Num{double(it->second), false};
}

Numbers make(std::initializer_list<std::pair<const char *, int>> items) {
    Numbers out;
    for (const auto &[word, value] : items) out[fromUtf8(word)] = value;
    return out;
}

std::set<S> makeSet(std::initializer_list<const char *> items) {
    std::set<S> out;
    for (const char *word : items) out.insert(fromUtf8(word));
    return out;
}

const Numbers &ruCardinals() {
    static const Numbers v = make({
        {"ноль", 0}, {"один", 1}, {"одна", 1}, {"одно", 1}, {"одну", 1}, {"два", 2}, {"две", 2}, {"три", 3},
        {"четыре", 4}, {"пять", 5}, {"шесть", 6}, {"семь", 7}, {"восемь", 8}, {"девять", 9}, {"десять", 10},
        {"одиннадцать", 11}, {"двенадцать", 12}, {"тринадцать", 13}, {"четырнадцать", 14}, {"пятнадцать", 15},
        {"шестнадцать", 16}, {"семнадцать", 17}, {"восемнадцать", 18}, {"девятнадцать", 19}, {"двадцать", 20},
        {"тридцать", 30}, {"сорок", 40}, {"пятьдесят", 50}, {"шестьдесят", 60}, {"семьдесят", 70},
        {"восемьдесят", 80}, {"девяносто", 90},
    });
    return v;
}

// Родительный падеж: «с десяти до двенадцати», «без пятнадцати пять»
const Numbers &ruGenitives() {
    static const Numbers v = make({
        {"одного", 1}, {"одной", 1}, {"двух", 2}, {"трех", 3}, {"четырех", 4}, {"пяти", 5}, {"шести", 6},
        {"семи", 7}, {"восьми", 8}, {"девяти", 9}, {"десяти", 10}, {"одиннадцати", 11}, {"двенадцати", 12},
        {"тринадцати", 13}, {"четырнадцати", 14}, {"пятнадцати", 15}, {"шестнадцати", 16}, {"семнадцати", 17},
        {"восемнадцати", 18}, {"девятнадцати", 19}, {"двадцати", 20}, {"тридцати", 30}, {"сорока", 40},
        {"пятидесяти", 50},
    });
    return v;
}

// «Третьего» в «полтретьего» — идёт третий час: 2:30
const Numbers &ruHourOf() {
    static const Numbers v = make({
        {"первого", 1}, {"второго", 2}, {"третьего", 3}, {"четвертого", 4}, {"пятого", 5}, {"шестого", 6},
        {"седьмого", 7}, {"восьмого", 8}, {"девятого", 9}, {"десятого", 10}, {"одиннадцатого", 11},
        {"двенадцатого", 12},
    });
    return v;
}

const Numbers &enCardinals() {
    static const Numbers v = make({
        {"zero", 0}, {"one", 1}, {"two", 2}, {"three", 3}, {"four", 4}, {"five", 5}, {"six", 6}, {"seven", 7},
        {"eight", 8}, {"nine", 9}, {"ten", 10}, {"eleven", 11}, {"twelve", 12}, {"thirteen", 13},
        {"fourteen", 14}, {"fifteen", 15}, {"sixteen", 16}, {"seventeen", 17}, {"eighteen", 18},
        {"nineteen", 19}, {"twenty", 20}, {"thirty", 30}, {"forty", 40}, {"fifty", 50}, {"sixty", 60},
        {"seventy", 70}, {"eighty", 80}, {"ninety", 90},
    });
    return v;
}

struct Found {
    int count = 0;
    int lead = 0;
    S value;
    std::optional<bool> isLoose;
};

using At = std::function<std::optional<S>(int)>;
using IsJoined = std::function<bool(int, bool)>;
using GapAfter = std::function<S(int)>;

S pad(const Num &value) {
    S s = numText(value);
    while (s.size() < 2) s = u"0" + s;
    return s;
}

// Час на циферблате: 0 — это 12
std::optional<Found> clock(const Num &hour, const Num &minute) {
    // В JS сравнения с NaN ложны: «не число» проходит проверку диапазона
    if (hour.v < 0 || hour.v >= kHoursOnDial || minute.v < 0 || minute.v >= kMinutesInHour) return std::nullopt;
    const Num shown = (hour.v == 0 || std::isnan(hour.v)) ? Num{double(kHoursOnDial)} : hour;
    Found f;
    f.value = numText(shown) + u":" + pad(minute);
    f.isLoose = true;
    return f;
}

Num minus(const Num &a, double b) { return Num{a.v - b, false}; }

// «До получаса»: N минут до часа H
std::optional<Found> clockBefore(const Num &hour, const Num &minutes) {
    return minutes.v > 0 && minutes.v < kMinutesInHour && hour.v >= 1 && hour.v <= kHoursOnDial
        ? clock(minus(hour, 1), Num{kMinutesInHour - minutes.v}) : std::nullopt;
}

bool isDialHour(const std::optional<Num> &hour) {
    return hour && hour->v >= 1 && hour->v <= kHoursOnDial;
}

Num modDial(const Num &hour) { return Num{std::fmod(hour.v, double(kHoursOnDial)), hour.fn}; }

struct Counted {
    Num value;
    int count = 1;
};

// Число из одного либо двух слов («двадцать пять», «twenty-five») начиная со слова `index`
std::optional<Counted> numberAt(const Numbers &numbers, int index, const At &at, const IsJoined &isJoined) {
    const auto first = lookup(numbers, at(index));
    if (!first) return std::nullopt;
    const auto unit = lookup(numbers, at(index + 1));
    if (first->v >= kFirstTens && std::fmod(first->v, kTen) == 0 && unit && unit->v > 0 && unit->v < kTen
        && isJoined(index, true)) {
        return Counted{Num{first->v + unit->v}, 2};
    }
    return Counted{*first, 1};
}

// Час и минуты после предлога: «в десять тридцать», «at ten thirty», «в семь ноль пять»
std::optional<Found> hourMinuteAt(const Numbers &numbers, const S &zero, int index, const At &at,
                                  const IsJoined &isJoined) {
    const auto hour = numberAt(numbers, index, at, isJoined);
    if (!hour || hour->value.v > kMaxHour || !isJoined(index + hour->count - 1, false)) return std::nullopt;
    const int next = index + hour->count;
    if (at(next) == zero) {
        const auto unit = lookup(numbers, at(next + 1));
        if (!unit || unit->v >= kTen || !isJoined(next, false)) return std::nullopt;
        return Found{hour->count + 2, 0, numText(hour->value) + u":" + pad(*unit), std::nullopt};
    }
    const auto minute = numberAt(numbers, next, at, isJoined);
    if (!minute || minute->value.v < kTen || minute->value.v >= kMinutesInHour) return std::nullopt;
    return Found{hour->count + minute->count, 0, numText(hour->value) + u":" + pad(minute->value), std::nullopt};
}

std::optional<Found> withCount(std::optional<Found> found, int count) {
    if (found) found->count = count;
    return found;
}

std::optional<Found> matchRu(const At &at, const IsJoined &isJoined, const GapAfter &) {
    static const std::set<S> half = makeSet({"пол", "половина", "половине", "половину"});
    static const std::set<S> minuteWords = makeSet({"минут", "минута", "минуты", "минуту"});
    static const std::set<S> atWords = makeSet({"в", "с", "до"});
    static const std::set<S> fromTo = makeSet({"с", "до"});
    static const std::set<S> daypart = makeSet({"дня", "ночи"});
    static const std::set<S> hourWords = makeSet({"час", "часа", "часов"});
    const S word = *at(0);
    const auto next = at(1);
    const S pol = u"пол";
    // «полтретьего», «пол третьего», «пол-третьего», «половина третьего»
    if (word.rfind(pol, 0) == 0) {
        const auto glued = lookup(ruHourOf(), word.substr(3));
        // В JS условие — истинность значения: «не число» (constructor) тоже истинно
        if (glued && (glued->fn || glued->v != 0)) return withCount(clock(minus(*glued, 1), Num{30}), 1);
    }
    if (half.count(word) && next) {
        const auto hourOf = lookup(ruHourOf(), next);
        if (hourOf && isJoined(0, true)) return withCount(clock(minus(*hourOf, 1), Num{30}), 2);
    }
    // «без пятнадцати пять», «без четверти пять», «без пяти минут час»
    if (word == u"без" && isJoined(0, false)) {
        const auto minutes = next == S(u"четверти") ? std::optional<Counted>(Counted{Num{15}, 1})
                                                    : numberAt(ruGenitives(), 1, at, isJoined);
        if (minutes && isJoined(minutes->count, false)) {
            const int skipped = minuteWords.count(at(1 + minutes->count).value_or(u""))
                    && isJoined(1 + minutes->count, false) ? 1 : 0;
            const auto hourWord = at(1 + minutes->count + skipped);
            const std::optional<Num> hour = hourWord == S(u"час") ? std::optional<Num>(Num{1})
                                                                  : lookup(ruCardinals(), hourWord);
            const auto found = isDialHour(hour) ? clockBefore(*hour, minutes->value) : std::nullopt;
            if (found) return withCount(found, 2 + minutes->count + skipped);
        }
    }
    // «четверть шестого»
    if (word == u"четверть" && next) {
        const auto hourOf = lookup(ruHourOf(), next);
        if (hourOf && isJoined(0, false)) return withCount(clock(minus(*hourOf, 1), Num{15}), 2);
    }
    const auto number = numberAt(ruCardinals(), 0, at, isJoined);
    if (number) {
        const auto after = at(number->count);
        const bool isAfterJoined = isJoined(number->count - 1, false);
        // «пять минут шестого»
        const auto hourOf = lookup(ruHourOf(), at(number->count + 1));
        if (after && minuteWords.count(*after) && hourOf && isAfterJoined && isJoined(number->count, false)) {
            const auto found = clock(minus(*hourOf, 1), number->value);
            if (found && number->value.v > 0) return withCount(found, number->count + 2);
        }
        // «два с половиной часа»
        if (after == S(u"с") && at(number->count + 1) == S(u"половиной")
            && hourWords.count(at(number->count + 2).value_or(u"")) && isAfterJoined && isJoined(number->count, false)
            && isJoined(number->count + 1, false)) {
            return Found{number->count + 2, 0, numText(number->value) + u".5", std::nullopt};
        }
        return Found{number->count, 0, numText(number->value), std::nullopt};
    }
    if (!next || !isJoined(0, false)) return std::nullopt;
    // «на час» — длительность, «в час» — время; «на час дня» и «час пик» — не они
    if (*next == u"час") {
        const auto tail = isJoined(1, false) ? at(2) : std::nullopt;
        if (word == u"на" && !daypart.count(tail.value_or(u"")) && tail != S(u"с") && tail != S(u"пик")) {
            return Found{2, 0, u"1 ч", std::nullopt};
        }
        if (word == u"в" && tail != S(u"пик")) return Found{1, 1, u"1", std::nullopt};
    }
    if (atWords.count(word)) {
        auto pair = hourMinuteAt(ruCardinals(), u"ноль", 1, at, isJoined);
        if (pair) {
            pair->lead = 1;
            return pair;
        }
    }
    if (fromTo.count(word)) {
        const auto genitive = numberAt(ruGenitives(), 1, at, isJoined);
        if (genitive) return Found{genitive->count, 1, numText(genitive->value), std::nullopt};
    }
    return std::nullopt;
}

std::optional<Found> matchEn(const At &at, const IsJoined &isJoined, const GapAfter &gapAfter) {
    static const std::set<S> atWords = makeSet({"at", "from", "to", "till", "until", "by"});
    static const std::set<S> past = makeSet({"past", "after"});
    static const std::set<S> minuteWords = makeSet({"minute", "minutes"});
    static const std::set<S> hourWords = makeSet({"hour", "hours", "hr", "hrs"});
    const S word = *at(0);
    const auto next = at(1);
    // «half past two»
    if (word == u"half" && next == S(u"past") && isJoined(0, false) && isJoined(1, false)) {
        const auto hour = lookup(enCardinals(), at(2));
        if (isDialHour(hour)) return withCount(clock(modDial(*hour), Num{30}), 3);
    }
    // «quarter to five», «a quarter past five»
    const int quarter = word == u"quarter" ? 0 : (word == u"a" && next == S(u"quarter") && isJoined(0, false) ? 1 : -1);
    if (quarter >= 0 && isJoined(quarter, false) && isJoined(quarter + 1, false)) {
        const S link = at(quarter + 1).value_or(u"");
        const auto hour = lookup(enCardinals(), at(quarter + 2));
        if (isDialHour(hour)) {
            const auto found = link == u"to" ? clockBefore(*hour, Num{15})
                : past.count(link) ? clock(modDial(*hour), Num{15}) : std::nullopt;
            if (found) return withCount(found, quarter + 3);
        }
    }
    const auto number = numberAt(enCardinals(), 0, at, isJoined);
    if (number) {
        const bool isAfterJoined = isJoined(number->count - 1, false);
        const bool hasMinutes = minuteWords.count(at(number->count).value_or(u"")) && isAfterJoined
            && isJoined(number->count, false);
        const int linkAt = number->count + (hasMinutes ? 1 : 0);
        const S link = at(linkAt).value_or(u"");
        const auto hour = lookup(enCardinals(), at(linkAt + 1));
        // «ten past five», «ten minutes to five»; «ten to five» без «minutes» — диапазон, а не время
        if (isDialHour(hour) && isJoined(linkAt - 1, false) && isJoined(linkAt, false)) {
            const auto found = past.count(link) ? clock(modDial(*hour), number->value)
                : link == u"to" && hasMinutes ? clockBefore(*hour, number->value) : std::nullopt;
            if (found && number->value.v > 0) return withCount(found, linkAt + 2);
        }
        // «two and a half hours»
        if (link == u"and" && !hasMinutes && at(linkAt + 1) == S(u"a") && at(linkAt + 2) == S(u"half")
            && hourWords.count(at(linkAt + 3).value_or(u"")) && isAfterJoined && isJoined(linkAt, false)
            && isJoined(linkAt + 1, false) && isJoined(linkAt + 2, false)) {
            return Found{linkAt + 3, 0, numText(number->value) + u".5", std::nullopt};
        }
        // «five o'clock»
        const S gap = gapAfter(number->count);
        if (at(number->count) == S(u"o") && at(number->count + 1) == S(u"clock") && isAfterJoined
            && (gap == u"'" || gap == u"’")) {
            return Found{number->count + 2, 0, numText(number->value), std::nullopt};
        }
        return Found{number->count, 0, numText(number->value), std::nullopt};
    }
    if (!next || !isJoined(0, false)) return std::nullopt;
    // «for an hour» — длительность; «an hour and a half» разбирает словарь
    if (word == u"for" && (next == S(u"an") || next == S(u"a")) && at(2) == S(u"hour") && isJoined(1, false)
        && !(at(3) == S(u"and") && isJoined(2, false))) {
        return Found{3, 0, u"1 hr", std::nullopt};
    }
    if (atWords.count(word)) {
        auto pair = hourMinuteAt(enCardinals(), u"oh", 1, at, isJoined);
        if (pair) {
            pair->lead = 1;
            return pair;
        }
    }
    return std::nullopt;
}

struct Token {
    S word;
    int from;
    int to;
};

bool isTokenChar(char16_t c) {
    return (c >= u'a' && c <= u'z') || (c >= u'а' && c <= u'я') || (c >= u'0' && c <= u'9') || c == u'_';
}

} // namespace

NumeralRewrite rewriteNumerals(const std::u16string &text, NumeralLang lang) {
    const S folded = foldYo(jsLower(text));
    NumeralRewrite none{text, {}};
    // Свёртка регистра обязана сохранять позиции символов
    if (folded.size() != text.size()) return none;
    std::vector<Token> tokens;
    // Слова, слитые с цифрами («v2two»), — не числительные
    for (size_t i = 0; i < folded.size();) {
        if (!isTokenChar(folded[i])) {
            ++i;
            continue;
        }
        size_t j = i;
        bool hasDigit = false;
        while (j < folded.size() && isTokenChar(folded[j])) {
            if ((folded[j] >= u'0' && folded[j] <= u'9') || folded[j] == u'_') hasDigit = true;
            ++j;
        }
        if (!hasDigit) tokens.push_back({folded.substr(i, j - i), int(i), int(j)});
        i = j;
    }
    if (tokens.empty()) return none;
    const auto match = lang == NumeralLang::Ru ? matchRu : matchEn;
    std::vector<NumeralEdit> edits;
    S out;
    int copied = 0;
    int index = 0;
    const int count = int(tokens.size());
    while (index < count) {
        const int base = index;
        const At at = [&](int offset) -> std::optional<S> {
            const int k = base + offset;
            if (k < 0 || k >= count) return std::nullopt;
            return tokens[size_t(k)].word;
        };
        const GapAfter gapAfter = [&](int offset) -> S {
            const int k = base + offset;
            if (k < 0 || k + 1 >= count) return S();
            return folded.substr(size_t(tokens[size_t(k)].to), size_t(tokens[size_t(k + 1)].from - tokens[size_t(k)].to));
        };
        // Слова `offset` и `offset + 1` стоят рядом: между ними только пробелы (либо дефис — «twenty-five»)
        const IsJoined isJoined = [&](int offset, bool isHyphenOk) {
            const S gap = gapAfter(offset);
            bool spaces = !gap.empty();
            for (const char16_t c : gap) {
                if (c != u' ' && c != u'\t') spaces = false;
            }
            return spaces || (isHyphenOk && gap == u"-");
        };
        const auto result = match(at, isJoined, gapAfter);
        if (!result) {
            index += 1;
        } else {
            const Token &first = tokens[size_t(base + result->lead)];
            const Token &last = tokens[size_t(base + result->lead + result->count - 1)];
            out += text.substr(size_t(copied), size_t(first.from - copied));
            NumeralEdit edit;
            edit.from = int(out.size());
            edit.to = int(out.size() + result->value.size());
            edit.value = result->value;
            edit.source = text.substr(size_t(first.from), size_t(last.to - first.from));
            edit.isLoose = result->isLoose;
            edits.push_back(edit);
            out += result->value;
            copied = last.to;
            index = base + result->lead + result->count;
        }
    }
    if (edits.empty()) return none;
    return {out + text.substr(size_t(copied)), edits};
}

std::string rewriteNumeralsText(const std::string &text, NumeralLang lang) {
    return toUtf8(rewriteNumerals(fromUtf8(text), lang).text);
}

std::u16string restoreNumerals(const std::u16string &marked, const std::vector<NumeralEdit> &edits) {
    if (edits.empty()) return marked;
    S out;
    int copied = 0;
    for (const auto &edit : edits) {
        const bool isIntact = slice(marked, edit.from, edit.to) == edit.value;
        out += slice(marked, copied, edit.from) + (isIntact ? edit.source : S(edit.source.size(), u' '));
        copied = edit.to;
    }
    return out + slice(marked, copied);
}

int toSourceOffset(int position, const std::vector<NumeralEdit> &edits, bool isEnd) {
    int shift = 0;
    for (const auto &edit : edits) {
        if (position <= edit.from) break;
        // Внутри замены
        if (position < edit.to) return edit.from + shift + (isEnd ? int(edit.source.size()) : 0);
        shift += int(edit.source.size()) - (edit.to - edit.from);
    }
    return position + shift;
}

} // namespace parvane::sections::planner
