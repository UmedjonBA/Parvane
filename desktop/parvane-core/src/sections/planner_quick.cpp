// Parvane fork (spec 029, фаза 4): ввод текстом «Плана» — порт web plannerQuick.ts (1:1).
//
// Структура повторяет web: словарь языка (WORDS) → выражения языка (compile) → распознаватели-кандидаты
// (parseText) → выбор набора → название, описание, тип. Регулярные выражения — тела web без изменений, их
// исполняет движок planner_quick_text (поведение JS, позиции в единицах UTF-16).
#include "parvane/sections/planner_quick.h"

#include <algorithm>
#include <cmath>
#include <functional>
#include <memory>
#include <mutex>
#include <set>

#include "parvane/sections/planner_links.h"
#include "parvane/sections/planner_numerals.h"
#include "parvane/sections/planner_quick_pick.h"
#include "planner_quick_text.h"

namespace parvane::sections::planner {

using namespace text;
using nlohmann::json;

namespace {

// ── константы ────────────────────────────────────────────────────────────────

constexpr int kMaxAlternatives = 4;
constexpr int kMaxPickRounds = 8;
constexpr double kGlassMl = 250;
constexpr double kMlInLitre = 1000;
constexpr double kMinutesInHour = 60;
constexpr double kKmInMile = 1.609344;
constexpr int kDaysInWeek = 7;
constexpr double kDayMinutes = 1440;
constexpr double kDefaultEventMins = 60;

const std::string LETTER = "a-zа-я";
const std::string ALNUM = LETTER + "0-9";
const std::string NUM = "\\d+(?:[.,]\\d+)?";
const std::string HOUR = "[01]?\\d|2[0-4]";
const std::string MINUTE = "[0-5]\\d";
const std::string DASH = "-|–|—";
const std::string SEPARATOR = "(?![" + ALNUM + "])";
constexpr double kMaxMood = 5;
constexpr size_t kMinTypoLength = 6;
constexpr double kMaxSleepMinutes = 16 * 60;
constexpr double kMaxSteps = 200000;
const std::vector<std::string> kMarkerFields = {"list", "place", "important"};

// ── словарь языка ────────────────────────────────────────────────────────────
// Значения — тела регулярных выражений по свёрнутой строке (нижний регистр, «ё» → «е»). В телах допустимы
// только незахватывающие группы `(?:…)`: номера групп считает общий код. Пара [тело, значение] — слова и
// то, что они означают. Пустая строка — «нет в словаре».
template <typename T>
using Entries = std::vector<std::pair<std::string, T>>;

struct Words {
    std::string task, event, water;
    std::string typoWords, typoSafe;
    Entries<double> eventMinutes, eventMinutesTail;
    std::string descLeads;
    Entries<bool> descLabels;
    std::string descWeak, abbreviations;
    std::string sleep, sleepPrefix, sleepYesterday, sleepDayBefore, sleepNone, sleepBed, sleepWake;
    std::string workout, goal;
    Entries<std::string> metrics;
    std::string weakLeads;
    std::string kcal, gram;
    Entries<std::string> macros, shortMacros, meals;
    std::string ml, litre, glass;
    std::string hour, minute, minuteGlued, halfHour, hourAndHalf;
    std::string at, from, to;
    Entries<std::string> dayparts, daypartLeads;
    std::string bareDayparts;
    Entries<double> namedTimes;
    Entries<int> weekdays;
    std::string weekdayLead, weakWeekdays, pluralWeekday;
    Entries<int> months;
    bool isMonthFirst = false;
    std::string ordinal, of;
    Entries<int> relative;
    std::string in;
    bool isInCountRequired = false;
    std::string nextWeek, dayLead, until, every, on;
    bool isOnAlwaysRepeat = false;
    std::string and_;
    Entries<std::string> units, adverbs;
    std::string oncePer, workdays, weekends, times;
    Entries<std::string> spans;
    std::string spanLead;
    std::vector<std::pair<std::string, int>> numbers; // порядок как у Object.keys в web
    std::string kg, beats, pressureOver;
    Entries<double> distance;
    std::map<std::string, std::string> goals;
};

Words ruWords() {
    Words w;
    w.task = "задач[ау]";
    w.event = "событие";
    w.water = "вод[аыу]";
    w.typoWords = "понедельник понедельника понедельникам вторник вторника вторникам средам четверг четверга четвергам"
                  " пятница пятницу пятницы пятницам суббота субботу субботы субботам воскресенье воскресенья воскресеньям"
                  " января февраля апреля августа сентября октября ноября декабря сегодня завтра послезавтра"
                  " неделя неделю недели недель каждый каждую каждое каждые месяц месяца месяцев"
                  " ежедневно еженедельно ежемесячно ежегодно будням выходным задача событие";
    w.typoSafe = "завтрак завтраки неделе каждой каждого каждая месяцы выходные выходных будние задачи задачу"
                 " события событий";
    w.eventMinutes = {{"пар[ауые]", 105}, {"урок(?:а|и|ов)?", 45}, {"созвон(?:а|ы|ов)?", 30}, {"встреч[аиу]", 60}};
    w.eventMinutesTail = {{"пара", 105}};
    w.descLeads = "будет|будут|нужно|надо|не\\s+забыть|взять|принести";
    w.descLabels = {{"(?:описание|примечание|заметка|прим)\\s*:|прим\\.", false}, {"тема\\s*:", true}};
    w.descWeak = "я|мне|мы|нам|ты|тебе|вы|вам|он|ему|она|ей|они|им|это|что|чтобы|если|когда|как|где|и|или|а|но|не"
                 "|еще|уже|тоже|там|тут|в|во|на|у|из|для|к|ко|от|по|с|со|за|до|при|о|об|под|над|через|после|перед|без";
    w.abbreviations = "ул|пр|пер|пл|кв|корп|стр|оф|ауд|каб|эт|им|см|напр|др|руб|тыс|млн|мин|сек|тел|доб|кг|гр|мл|шт|уп"
                      "|экз|км|мм";
    w.sleep = "сон|(?:по|про)?спал[аи]?|выспал(?:ся|ась)";
    w.sleepPrefix = "сегодня|ночью|сейчас|я";
    w.sleepYesterday = "вчера";
    w.sleepDayBefore = "позавчера";
    w.sleepNone = "не\\s+(?:по)?спал[аи]?|без\\s+сна";
    w.sleepBed = "л[её]г(?:ла)?|уснул[а]?|заснул[а]?";
    w.sleepWake = "встал[а]?|проснул(?:ся|ась)";
    w.workout = "зал|бег|тренировк[аиу]|кардио|плавание|йога|велосипед|прогулк[аиу]|спорт";
    w.goal = "цел[ьи]";
    w.metrics = {{"вес", "weight"}, {"давление", "pressure"}, {"пульс", "pulse"}, {"шаги", "steps"},
                 {"самочувствие", "mood"}};
    w.kcal = "ккал|кал";
    w.gram = "г|гр|грамм(?:а|ов)?";
    w.macros = {{"б|белк[иа]|белок", "protein"}, {"ж|жир[ыа]?", "fat"}, {"у|углевод[ыа]?", "carbs"},
                {"кл|клетчатк[аи]", "fiber"}, {"сахар[а]?", "sugar"}, {"сол[ьи]", "salt"}};
    w.meals = {{"завтрак", "breakfast"}, {"обед", "lunch"}, {"ужин", "dinner"}, {"перекус", "snack"}};
    w.ml = "мл";
    w.litre = "л|литр(?:а|ов)?";
    w.glass = "стакан(?:а|ов)?";
    w.hour = "ч|час(?:а|ов)?";
    w.minute = "м|мин|минут[аы]?";
    w.halfHour = "полчаса";
    w.hourAndHalf = "полтора\\s+часа";
    w.at = "в";
    w.from = "с";
    w.to = "до";
    w.dayparts = {{"утра|утром", "am"}, {"дня|днем|вечера|вечером", "pm"}, {"ночи|ночью", "night"}};
    w.daypartLeads = {{"утром", "am"}, {"днем|вечером", "pm"}, {"ночью", "night"}};
    w.namedTimes = {{"полдень", 12 * kMinutesInHour}, {"полночь", 0}};
    w.weekdays = {{"пн|понедельник(?:а|у|ам|и)?", 1}, {"вт|вторник(?:а|у|ам|и)?", 2}, {"ср|сред(?:а|у|ы|ам)", 3},
                  {"чт|четверг(?:а|у|ам|и)?", 4}, {"пт|пятниц(?:а|у|ы|ам)", 5}, {"сб|суббот(?:а|у|ы|ам)", 6},
                  {"вс|воскресень(?:е|я|ям)", 0}};
    w.weekdayLead = "во?";
    w.months = {{"январ[ья]", 1}, {"феврал[ья]", 2}, {"марта?", 3}, {"апрел[ья]", 4}, {"ма[йя]", 5}, {"июн[ья]", 6},
                {"июл[ья]", 7}, {"августа?", 8}, {"сентябр[ья]", 9}, {"октябр[ья]", 10}, {"ноябр[ья]", 11},
                {"декабр[ья]", 12}};
    w.relative = {{"сегодня", 0}, {"завтра", 1}, {"послезавтра", 2}, {"вчера", -1}};
    w.in = "через";
    w.nextWeek = "на\\s+следующей\\s+неделе";
    w.dayLead = "на|во?";
    w.until = "до";
    w.every = "кажд(?:ый|ую|ое|ые)";
    w.on = "по";
    w.isOnAlwaysRepeat = true;
    w.and_ = "и";
    w.units = {{"день|дня|дней", "daily"}, {"недел[юиь]", "weekly"}, {"месяц(?:а|ев)?", "monthly"},
               {"года?|лет", "yearly"}};
    w.adverbs = {{"ежедневно", "daily"}, {"еженедельно", "weekly"}, {"ежемесячно", "monthly"}, {"ежегодно", "yearly"}};
    w.oncePer = "раз\\s+в";
    w.workdays = "по\\s+будням";
    w.weekends = "по\\s+выходным";
    w.times = "раза?";
    w.spans = {{"мес|месяц(?:а|ев)?", "month"}, {"нед|недел[иья]", "week"}, {"года?|лет", "year"}};
    w.numbers = {{"две", 2}, {"два", 2}, {"три", 3}, {"четыре", 4}};
    w.kg = "кг";
    w.beats = "уд";
    w.pressureOver = "на";
    w.distance = {{"км", 1}};
    w.goals = {
        {"kcal", "ккал|калории|калорий"}, {"protein", "белок|белки|белка"}, {"fat", "жиры|жир"},
        {"carbs", "углеводы|углеводов"}, {"fiber", "клетчатка|клетчатки"}, {"water", "вод[аыу]"},
        {"sugar", "сахар[а]?"}, {"salt", "сол[ьи]"}, {"sleep", "сон"}, {"weight", "вес"}, {"steps", "шаги"},
        {"day", "день"}, {"budget", "бюджет"},
    };
    return w;
}

Words enWords() {
    Words w;
    w.task = "task|todo|to-do";
    w.event = "event";
    w.water = "water";
    w.typoWords = "monday mondays tuesday tuesdays wednesday wednesdays thursday thursdays friday fridays saturday"
                  " saturdays sunday sundays january february august september october november december tomorrow"
                  " weekly monthly yearly weekdays weekends minutes";
    w.typoSafe = "minute weekend weekday";
    w.eventMinutes = {{"lessons?", 45}, {"calls?", 30}, {"meetings?", 60}, {"stand-?ups?", 15}};
    w.descLeads = "will\\s+be|need\\s+to|needs|don['’]?t\\s+forget|bring";
    w.descLabels = {{"(?:notes?|description)\\s*:", false}, {"topic\\s*:", true}};
    w.descWeak = "i|me|we|us|you|he|him|she|her|they|them|it|this|that|there|what|who|if|when|and|or|but|not|to|also"
                 "|just|still|at|in|on|from|for|after|before|with|without|of|by|the|a|an";
    w.abbreviations = "etc|vs|mr|mrs|ms|dr|st|no|approx|apt|rm|tel|ext|min|max|hr|hrs|kg|ml|pcs|km|lb|lbs|oz";
    w.sleep = "sleep|slept";
    w.sleepPrefix = "today|tonight|last\\s+night|i";
    w.sleepYesterday = "yesterday";
    w.sleepNone = "didn'?t\\s+sleep|did\\s+not\\s+sleep|no\\s+sleep";
    w.sleepDayBefore = "(?:the\\s+)?day\\s+before\\s+yesterday";
    w.sleepBed = "went\\s+to\\s+bed|fell\\s+asleep";
    w.sleepWake = "woke(?:\\s+up)?|got\\s+up";
    w.workout = "gym|workout|training|cardio|run|running|jog|jogging|swim|swimming|yoga|bike|cycling|walk|hike";
    w.goal = "goals?";
    w.metrics = {{"weight", "weight"}, {"pressure|bp|blood\\s+pressure", "pressure"},
                 {"pulse|hr|heart\\s+rate", "pulse"}, {"steps", "steps"}, {"mood", "mood"}};
    w.weakLeads = "run|running|jog|jogging|swim|swimming|bike|cycling|walk|hike|training|cardio|yoga|steps|pressure"
                  "|blood\\s+pressure|heart\\s+rate|weight|sleep|mood|goals?";
    w.kcal = "kcal|cal|calories";
    w.gram = "g|gr|grams?";
    w.macros = {{"proteins?", "protein"}, {"fats?", "fat"}, {"carbs?|carbohydrates", "carbs"},
                {"fiber|fibre", "fiber"}, {"sugar", "sugar"}, {"salt", "salt"}};
    w.shortMacros = {{"p", "protein"}, {"f", "fat"}, {"c", "carbs"}};
    w.meals = {{"breakfast", "breakfast"}, {"lunch", "lunch"}, {"dinner|supper", "dinner"}, {"snack", "snack"}};
    w.ml = "ml|millilit(?:er|re)s?";
    w.litre = "l|lit(?:er|re)s?";
    w.glass = "glass(?:es)?|cups?";
    w.hour = "h|hr|hrs|hours?";
    w.minute = "min|mins|minutes?";
    w.minuteGlued = "m";
    w.halfHour = "half\\s+(?:an\\s+)?hour";
    w.hourAndHalf = "(?:an?\\s+|one\\s+)?hour\\s+and\\s+a\\s+half|one\\s+and\\s+a\\s+half\\s+hours?";
    w.at = "at";
    w.from = "from";
    w.to = "to|till|until";
    w.dayparts = {
        {"am|a\\.m\\.|in\\s+the\\s+morning|this\\s+morning", "am"},
        {"pm|p\\.m\\.|in\\s+the\\s+(?:afternoon|evening)|this\\s+(?:afternoon|evening)|tonight", "pm"},
        {"at\\s+night", "night"},
    };
    w.daypartLeads = {{"(?:this\\s+)?morning", "am"}, {"(?:this\\s+)?(?:afternoon|evening)|tonight", "pm"}};
    w.bareDayparts = "am|a\\.m\\.|pm|p\\.m\\.";
    w.namedTimes = {{"noon|midday", 12 * kMinutesInHour}, {"midnight", 0}};
    w.weekdays = {{"mon|mondays?", 1}, {"tue|tues|tuesdays?", 2}, {"wed|weds|wednesdays?", 3},
                  {"thu|thur|thurs|thursdays?", 4}, {"fri|fridays?", 5}, {"sat|saturdays?", 6}, {"sun|sundays?", 0}};
    w.weekdayLead = "next|this";
    w.weakWeekdays = "sat|sun|wed";
    w.pluralWeekday = "days";
    w.months = {{"jan|january", 1}, {"feb|february", 2}, {"mar|march", 3}, {"apr|april", 4}, {"may", 5},
                {"jun|june", 6}, {"jul|july", 7}, {"aug|august", 8}, {"sep|sept|september", 9},
                {"oct|october", 10}, {"nov|november", 11}, {"dec|december", 12}};
    w.isMonthFirst = true;
    w.ordinal = "st|nd|rd|th";
    w.of = "of";
    w.relative = {{"today", 0}, {"tomorrow|tmrw", 1}, {"(?:the\\s+)?day\\s+after\\s+tomorrow", 2}, {"yesterday", -1}};
    w.in = "in";
    w.isInCountRequired = true;
    w.nextWeek = "next\\s+week";
    w.dayLead = "on|for";
    w.until = "by|until|till|before|due";
    w.every = "(?:once\\s+)?every|each";
    w.on = "on";
    w.and_ = "and";
    w.units = {{"days?", "daily"}, {"weeks?", "weekly"}, {"months?", "monthly"}, {"years?", "yearly"}};
    w.adverbs = {{"daily", "daily"}, {"weekly", "weekly"}, {"monthly", "monthly"}, {"yearly|annually", "yearly"}};
    w.oncePer = "once\\s+(?:a|an|per|in)";
    w.workdays = "(?:on\\s+)?weekdays|(?:every|each)\\s+weekday";
    w.weekends = "(?:on\\s+)?weekends|(?:every|each)\\s+weekend";
    w.times = "times?";
    w.spans = {{"mo|mos|months?", "month"}, {"wk|wks|weeks?", "week"}, {"yr|yrs|years?", "year"}};
    w.spanLead = "for";
    w.numbers = {{"a", 1}, {"an", 1}, {"one", 1}, {"two", 2}, {"three", 3}, {"four", 4}, {"other", 2}, {"second", 2}};
    w.kg = "kg";
    w.beats = "bpm";
    w.pressureOver = "over";
    w.distance = {{"km|k|kilomet(?:er|re)s?", 1}, {"mi|miles?", kKmInMile}};
    w.goals = {
        {"kcal", "kcal|calories|cal"}, {"protein", "proteins?"}, {"fat", "fats?"}, {"carbs", "carbs?|carbohydrates"},
        {"fiber", "fiber|fibre"}, {"water", "water"}, {"sugar", "sugar"}, {"salt", "salt"}, {"sleep", "sleep"},
        {"weight", "weight"}, {"steps", "steps"}, {"day", "day"}, {"budget", "budget"},
    };
    return w;
}

template <typename T>
std::string bodies(const Entries<T> &entries) {
    std::string out;
    for (size_t i = 0; i < entries.size(); ++i) {
        if (i) out += '|';
        out += entries[i].first;
    }
    return out;
}

// Граница слова: `\b` не знает кириллицы, а просмотра назад нет — символ перед словом захватывается первой
// группой и в совпадение не входит
std::string wordBody(const std::string &body) {
    return "(^|[^" + ALNUM + "])(" + body + ")(?![" + ALNUM + "])";
}
PV_NO_DANGLING const Regex &word(const std::string &body) { return rx(wordBody(body)); }

template <typename T>
struct Lookup {
    std::vector<std::pair<const Regex *, T>> compiled;
    std::optional<T> operator()(const S &text) const {
        for (const auto &[re, value] : compiled) {
            if (re->test(text)) return value;
        }
        return std::nullopt;
    }
};

template <typename T>
Lookup<T> lookup(const Entries<T> &entries) {
    Lookup<T> out;
    for (const auto &[body, value] : entries) out.compiled.push_back({&rx("^(?:" + body + ")$"), value});
    return out;
}

// Словарь, собранный в выражения: считается один раз на язык
struct Lang {
    std::string id;
    Words words;
    std::string weekday, month, date, listSeparator, count, daypart, daypartLead, minutes;
    const Regex *kindLead, *waterLead;
    std::vector<std::pair<const Regex *, double>> eventMinutes, eventMinutesTail;
    std::string descLeads;
    const Regex *isWeakName, *labelTail, *labelHead, *abbreviationTail;
    std::vector<S> typoWords;
    std::set<S> typoSafe;
    const Regex *sleepLead;
    const Regex *sleepDayBefore = nullptr, *sleepNone = nullptr, *sleepYesterday = nullptr;
    const Regex *plainSleepLead;
    const Regex *bedWake = nullptr;
    const Regex *workoutLead, *goalLead, *metricLead;
    const Regex *weakLead = nullptr;
    const Regex *listSplit, *isEvery, *isFunctionWord;
    const Regex *isWeakWeekday = nullptr, *isPluralWeekday = nullptr, *isBareDaypart = nullptr;
    const Regex *isNextWeek, *inParts, *dayMonth, *monthDay, *weekdayParts;
    Lookup<int> weekdayOf, monthOf, relativeOf;
    Lookup<std::string> daypartOf, daypartLeadOf, unitOf, adverbOf, spanOf, mealOf, metricOf;
    Lookup<double> distanceOf, namedTimeOf;
    std::map<S, int> numberMap;

    double countOf(const std::optional<S> &text) const {
        if (!text) return 1;
        const auto it = numberMap.find(*text);
        return it != numberMap.end() ? it->second : jsNumber(*text);
    }
};

Lang compile(const std::string &id, const Words &words) {
    Lang lang;
    lang.id = id;
    lang.words = words;
    const std::string weekday = bodies(words.weekdays);
    const std::string month = bodies(words.months);
    std::string small;
    for (size_t i = 0; i < words.numbers.size(); ++i) small += (i ? "|" : "") + words.numbers[i].first;
    const std::string ordinal = !words.ordinal.empty() ? "(?:" + words.ordinal + ")?" : "";
    const std::string of = !words.of.empty() ? "(?:(?:" + words.of + ")\\s+)?" : "";
    // «через 3 дня», «in 2 weeks»: единицы — день, неделя, месяц
    const Entries<std::string> units3(words.units.begin(), words.units.begin() + 3);
    const auto inBody = [&](const std::string &open) {
        return "(?:" + words.in + ")\\s+(?:" + open + "\\d+|" + small + ")\\s+)" + (words.isInCountRequired ? "" : "?")
            + open + bodies(units3) + ")";
    };
    std::vector<std::string> dateParts = {
        bodies(words.relative),
        inBody("(?:"),
        words.nextWeek,
        "\\d{1,2}\\.\\d{2}(?:\\.\\d{4}|\\.\\d{2})?",
        "\\d{1,2}" + ordinal + "\\s+" + of + "(?:" + month + ")",
    };
    if (words.isMonthFirst) dateParts.push_back("(?:" + month + ")\\s+\\d{1,2}" + ordinal);
    dateParts.push_back("(?:(?:" + words.weekdayLead + ")\\s+)?(?:" + weekday + ")");
    std::string date;
    for (size_t i = 0; i < dateParts.size(); ++i) date += (i ? "|" : "") + dateParts[i];
    const std::string listSeparator = "(?:\\s*,\\s*(?:(?:" + words.and_ + ")\\s+)?|\\s+(?:" + words.and_ + ")\\s+)";
    const auto lead = [&](const std::string &body) { return &rx("^\\s*(?:" + body + ")" + SEPARATOR + "\\s*"); };
    const auto whole = [&](const std::string &body) { return &rx("^(?:" + body + ")$"); };
    const auto anywhere = [&](const std::string &body) {
        return &rx("(?:^|[^" + ALNUM + "])(?:" + body + ")" + SEPARATOR);
    };
    std::string sleepDays;
    for (const std::string *part : std::initializer_list<const std::string *>{&words.sleepDayBefore, &words.sleepYesterday}) {
        if (part->empty()) continue;
        sleepDays += (sleepDays.empty() ? "" : "|") + *part;
    }
    std::string sleepPrefixes;
    for (const std::string *part : std::initializer_list<const std::string *>{&words.sleepPrefix, &sleepDays}) {
        if (part->empty()) continue;
        sleepPrefixes += (sleepPrefixes.empty() ? "" : "|") + *part;
    }
    lang.weekday = weekday;
    lang.month = month;
    lang.date = date;
    lang.listSeparator = listSeparator;
    lang.count = "\\d{1,2}|" + small;
    lang.daypart = bodies(words.dayparts);
    const std::string leads = bodies(words.daypartLeads);
    // Уточнение перед временем; пустой словарь — выражение, которое не совпадает ни с чем
    lang.daypartLead = "(?:(" + (leads.empty() ? std::string("(?!)") : leads) + ")\\s+)?";
    lang.minutes = "(?:\\s*(?:" + words.minute + ")"
        + (words.minuteGlued.empty() ? std::string() : "|(?:" + words.minuteGlued + ")") + ")";
    lang.kindLead = &rx("^\\s*(?:(" + words.task + ")|(" + words.event + "))(?:\\s*[:—–]\\s*|\\s+-\\s+|\\s+|$)");
    lang.waterLead = lead(words.water);
    for (const auto &[body, minutes] : words.eventMinutes) {
        // Ссылки на заметки перед словом (их заглушки) первым словом не считаются
        lang.eventMinutes.push_back({&rx("^\\s*(?:[\\ue000-\\uf8ff]+\\s*)*(?:" + body + ")" + SEPARATOR), minutes});
    }
    for (const auto &[body, minutes] : words.eventMinutesTail) {
        lang.eventMinutesTail.push_back({&rx("^(?:(.*[^" + ALNUM + "]))?(?:" + body + ")\\s*$"), minutes});
    }
    lang.descLeads = words.descLeads;
    lang.isWeakName = &rx("^(?:" + words.descWeak + "|" + words.descLeads + ")" + SEPARATOR + "|(?:^|[^" + ALNUM
                          + "])(?:" + words.descWeak + ")$");
    Entries<bool> dropped, kept;
    for (const auto &entry : words.descLabels) (entry.second ? kept : dropped).push_back(entry);
    lang.labelTail = &rx("(?:^|[^" + ALNUM + "])(?:(" + bodies(dropped) + ")|(" + bodies(kept) + "))$");
    lang.labelHead = &rx("^(?:" + bodies(dropped) + ")\\s*(?=\\S)");
    lang.abbreviationTail = &rx("(?:^|[^" + ALNUM + "])(?:" + words.abbreviations + "|[" + LETTER + "])$");
    for (const auto &w : splitStr(fromUtf8(words.typoWords), u" ")) {
        lang.typoWords.push_back(w);
        lang.typoSafe.insert(w);
    }
    for (const auto &w : splitStr(fromUtf8(words.typoSafe), u" ")) lang.typoSafe.insert(w);
    lang.sleepLead = lead("(?:(?:" + (sleepPrefixes.empty() ? std::string("(?!)") : sleepPrefixes) + ")\\s+)*(?:"
                          + words.sleep + ")");
    if (!words.sleepDayBefore.empty()) lang.sleepDayBefore = anywhere(words.sleepDayBefore);
    if (!words.sleepNone.empty()) {
        lang.sleepNone = &rx("^\\s*(?:(?:" + sleepPrefixes + ")\\s+)*(?:" + words.sleepNone + ")(?:\\s+(?:" + sleepDays
                             + "))?\\s*[.!]?\\s*$");
    }
    if (!words.sleepYesterday.empty()) lang.sleepYesterday = anywhere(words.sleepYesterday);
    lang.plainSleepLead = lead(words.sleep);
    if (!words.sleepBed.empty() && !words.sleepWake.empty()) {
        lang.bedWake = &rx("(?:^|[^" + ALNUM + "])(?:" + words.sleepBed + ")\\s+(?:(?:" + words.at
                           + ")\\s+)?(\\d{1,2})(?:[:.](\\d{2}))?" + "[^" + ALNUM + "]+(?:(?:" + words.and_
                           + ")\\s+)?(?:" + words.sleepWake + ")\\s+(?:(?:" + words.at + ")\\s+)?"
                           + "(\\d{1,2})(?:[:.](\\d{2}))?" + SEPARATOR);
    }
    lang.workoutLead = lead(words.workout);
    lang.goalLead = lead(words.goal);
    lang.metricLead = &rx("^\\s*(" + bodies(words.metrics) + ")" + SEPARATOR + "\\s*(.*)$");
    if (!words.weakLeads.empty()) lang.weakLead = lead(words.weakLeads);
    lang.listSplit = &rx(listSeparator);
    lang.isEvery = whole(words.every);
    lang.isFunctionWord = whole(words.descWeak);
    if (!words.weakWeekdays.empty()) lang.isWeakWeekday = whole(words.weakWeekdays);
    if (!words.pluralWeekday.empty()) lang.isPluralWeekday = &rx("(?:" + words.pluralWeekday + ")$");
    if (!words.bareDayparts.empty()) lang.isBareDaypart = whole(words.bareDayparts);
    lang.isNextWeek = whole(words.nextWeek);
    lang.inParts = whole(inBody("("));
    lang.dayMonth = &rx("^(\\d{1,2})" + ordinal + "\\s+" + of + "(" + month + ")$");
    lang.monthDay = &rx("^(" + month + ")\\s+(\\d{1,2})");
    lang.weekdayParts = &rx("^(?:(?:" + words.weekdayLead + ")\\s+)?(" + weekday + ")$");
    lang.weekdayOf = lookup(words.weekdays);
    lang.monthOf = lookup(words.months);
    lang.daypartOf = lookup(words.dayparts);
    lang.daypartLeadOf = lookup(words.daypartLeads);
    lang.relativeOf = lookup(words.relative);
    lang.unitOf = lookup(words.units);
    lang.adverbOf = lookup(words.adverbs);
    lang.spanOf = lookup(words.spans);
    lang.mealOf = lookup(words.meals);
    lang.metricOf = lookup(words.metrics);
    lang.distanceOf = lookup(words.distance);
    lang.namedTimeOf = lookup(words.namedTimes);
    for (const auto &[w, n] : words.numbers) lang.numberMap[fromUtf8(w)] = n;
    return lang;
}

// Словарь языка компилируется при первом разборе (десятки регулярных выражений)
const Lang &langOf(const std::string &id) {
    static std::once_flag ruOnce, enOnce;
    static std::unique_ptr<Lang> ru, en;
    if (id == "ru") {
        std::call_once(ruOnce, [] { ru = std::make_unique<Lang>(compile("ru", ruWords())); });
        return *ru;
    }
    std::call_once(enOnce, [] { en = std::make_unique<Lang>(compile("en", enWords())); });
    return *en;
}

// ── числа, даты и время (свои помощники: plannerModel переносится отдельно) ─────

double jsRound(double x) { return std::floor(x + 0.5); }

double toNumber(const S &value) {
    S v = value;
    const auto comma = v.find(u',');
    if (comma != S::npos) v[comma] = u'.';
    return jsNumber(v);
}

bool truthy(const std::optional<double> &v) { return v && *v != 0 && !std::isnan(*v); }

std::string pad2(long long v) {
    std::string s = std::to_string(v);
    while (s.size() < 2) s = "0" + s;
    return s;
}

std::string toTime(double minutes) {
    const long long m = (long long)minutes;
    return pad2((long long)std::floor(minutes / 60)) + ":" + pad2(m % 60);
}

// Дни от 1970-01-01 по григорианскому календарю (как Date с нормализацией месяца и дня)
long long daysFromCivil(long long y, long long m, long long d) {
    y -= m <= 2;
    const long long era = (y >= 0 ? y : y - 399) / 400;
    const long long yoe = y - era * 400;
    const long long doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    const long long doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + doe - 719468;
}

struct Civil {
    long long y;
    int m;
    int d;
};

Civil civilFromDays(long long z) {
    z += 719468;
    const long long era = (z >= 0 ? z : z - 146096) / 146097;
    const long long doe = z - era * 146097;
    const long long yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    const long long y = yoe + era * 400;
    const long long doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    const long long mp = (5 * doy + 2) / 153;
    const int d = int(doy - (153 * mp + 2) / 5 + 1);
    const int m = int(mp < 10 ? mp + 3 : mp - 9);
    return {y + (m <= 2), m, d};
}

// new Date(y, month0, d): годы 0…99 — это 1900…1999, месяц и день нормализуются
long long epochOf(long long y, long long month0, long long d) {
    if (y >= 0 && y <= 99) y += 1900;
    y += month0 >= 0 ? month0 / 12 : -((-month0 + 11) / 12);
    month0 = ((month0 % 12) + 12) % 12;
    return daysFromCivil(y, month0 + 1, 1) + d - 1;
}

std::string keyOf(long long epoch) {
    const Civil c = civilFromDays(epoch);
    return std::to_string(c.y) + "-" + pad2(c.m) + "-" + pad2(c.d);
}

Civil fromDayKey(const std::string &key) {
    const auto parts = splitStr(fromUtf8(key), u"-");
    const auto num = [&](size_t i) {
        const double v = i < parts.size() ? jsNumber(parts[i]) : NAN;
        return std::isnan(v) ? 0LL : (long long)v;
    };
    return {num(0), int(num(1)), int(num(2))};
}

long long epochDays(const std::string &key) {
    const Civil c = fromDayKey(key);
    return epochOf(c.y, c.m - 1, c.d);
}

std::string addDays(const std::string &key, long long delta) { return keyOf(epochDays(key) + delta); }

int weekdayOfKey(const std::string &key) {
    const long long e = epochDays(key);
    return int(((e + 4) % 7 + 7) % 7);
}

std::string addMonths(const std::string &day, long long months) {
    const Civil date = fromDayKey(day);
    const long long target = epochOf(date.y, date.m - 1 + months, 1);
    const Civil t = civilFromDays(target);
    const Civil last = civilFromDays(epochOf(t.y, t.m, 0));
    return keyOf(epochOf(t.y, t.m - 1, std::min<long long>(date.d, last.d)));
}

// Ближайшая будущая дата с таким числом и месяцем (сегодня считается); `isNear` — дата этого года,
// даже если она уже прошла
std::optional<std::string> nearestDate(const std::string &today, double month, double dayOfMonth,
                                       std::optional<double> year = std::nullopt, bool isNear = false) {
    if (!(month >= 1 && month <= 12 && dayOfMonth >= 1 && dayOfMonth <= 31)) return std::nullopt;
    const auto build = [&](long long y) -> std::optional<std::string> {
        const long long e = epochOf(y, (long long)month - 1, (long long)dayOfMonth);
        const Civil c = civilFromDays(e);
        // Год 0…99 у Date означает 1900…1999 — сверяем месяц по нормализованной дате
        return c.m == (long long)month ? std::optional<std::string>(keyOf(e)) : std::nullopt;
    };
    if (year) return build((long long)(*year < 100 ? 2000 + *year : *year));
    const long long thisYear = fromDayKey(today).y;
    const auto day = build(thisYear);
    return day && (isNear || *day >= today) ? day : build(thisYear + 1);
}

std::string nextWeekday(const std::string &from, int weekday, bool isTodayCounted) {
    const int delta = ((weekday - weekdayOfKey(from)) % kDaysInWeek + kDaysInWeek) % kDaysInWeek;
    return addDays(from, delta ? delta : (isTodayCounted ? 0 : kDaysInWeek));
}

const Regex &dayKeyPattern() { return rx("^\\d{4}-\\d{2}-\\d{2}$"); }
const Regex &timePattern() { return rx("^([01]\\d|2[0-3]):[0-5]\\d$"); }

double toMinutesOf(const std::string &time) {
    const auto parts = splitStr(fromUtf8(time), u":");
    return jsNumber(parts[0]) * 60 + (parts.size() > 1 ? jsNumber(parts[1]) : NAN);
}

bool isInteger(double v) { return std::isfinite(v) && std::floor(v) == v; }

std::optional<std::string> validateRepeat(const Repeat &repeat) {
    if (repeat.interval < 1 || repeat.interval > kMaxRepeatInterval) return "interval";
    if (repeat.kind == "weekly") {
        const auto days = repeat.weekdays.value_or(std::vector<int>{});
        std::set<int> unique(days.begin(), days.end());
        bool ok = !days.empty() && unique.size() == days.size();
        for (const int d : days) ok = ok && d >= 0 && d <= 6;
        if (!ok) return "weekdays";
    }
    if (repeat.monthDay && (*repeat.monthDay < 1 || *repeat.monthDay > 31)) return "monthDay";
    if (!repeat.startDay.empty() ? !dayKeyPattern().test(fromUtf8(repeat.startDay)) : repeat.kind != "weekly") {
        return "startDay";
    }
    if (repeat.endDay && !repeat.endDay->empty()
        && (!dayKeyPattern().test(fromUtf8(*repeat.endDay))
            || (!repeat.startDay.empty() && *repeat.endDay < repeat.startDay))) {
        return "endDay";
    }
    if (repeat.count && (*repeat.count < 1 || *repeat.count > kMaxRepeatCount)) return "count";
    return std::nullopt;
}

std::optional<std::string> validateTask(const QuickDraft &task) {
    if (trim(fromUtf8(task.name)).empty()) return "name";
    if (task.minutes && (!std::isfinite(*task.minutes) || *task.minutes < kMinTaskMinutes || *task.minutes > kDayMinutes)) {
        return "minutes";
    }
    const bool hasStart = task.start && !task.start->empty();
    const bool hasDay = task.day && !task.day->empty();
    if (hasStart && !hasDay) return "startNeedsDayAndMinutes";
    if (hasStart && task.minutes && toMinutesOf(*task.start) + *task.minutes > kDayMinutes) return "pastMidnight";
    if (hasDay && task.due && !task.due->empty() && *task.day > *task.due) return "dayAfterDue";
    return std::nullopt;
}

std::optional<std::string> validateEvent(const std::string &name, const std::string &start, const std::string &end,
                                         bool isAllDay, const std::optional<std::string> &day,
                                         const std::optional<Repeat> &repeat) {
    if (trim(fromUtf8(name)).empty()) return "name";
    if (!isAllDay && (!timePattern().test(fromUtf8(start)) || !timePattern().test(fromUtf8(end)) || start >= end)) {
        return "time";
    }
    if (repeat) return validateRepeat(*repeat);
    if (!day || day->empty()) return "repeat";
    return std::nullopt;
}

// ── группы совпадения ────────────────────────────────────────────────────────

// Группы совпадения, начиная с `off` (в web — `match.slice(off)`)
struct G {
    const Match *m;
    const S *s;
    int off;
    bool has(int i) const { return m->has(off + i); }
    // Истинность в JS: группа участвовала и не пуста
    bool truthy(int i) const { return has(i) && m->stop(off + i) > m->start(off + i); }
    S operator[](int i) const { return m->str(*s, off + i); }
    std::optional<S> opt(int i) const { return has(i) ? std::optional<S>((*this)[i]) : std::nullopt; }
};

// ── кандидаты ────────────────────────────────────────────────────────────────
// Распознаватель предлагает кандидата: участок строки, поле (чип) и значение. Слот — значение, которое в
// записи одно; оценка и выбор набора — planner_quick_pick. Ранг распознавателя — насколько он точен.
namespace rank {
constexpr int kind = 60, marker = 58, kcal = 54, macro = 52, shortMacro = 44, grams = 40, meal = 39, waterLead = 38,
              water = 37, durationHalf = 34, durationHours = 33, durationMinutes = 32, timeRange = 30, timeClock = 29,
              timeHour = 28, timeNamed = 27, repeatEvery = 24, repeatAdverb = 23, repeatOnce = 22, repeatWorkdays = 21,
              repeatWeekends = 20, repeatDays = 19, repeatEnd = 18, repeatCount = 17, repeatSpan = 16, due = 12,
              day = 10;
}

struct CandidateValue {
    std::optional<std::string> nutrient;
    bool isShort = false;
    std::optional<double> amount;
    std::optional<std::string> meal;
    std::optional<double> minutes;
    // Время в минутах от полуночи; `altStart` — другое чтение часа («в 7»: утро либо вечер)
    std::optional<double> start, end, altStart;
    std::optional<std::string> repeatKind;
    std::optional<double> interval;
    std::optional<std::vector<int>> days;
    std::optional<double> count, months, weeks;
    // День либо срок; `altDay` — другое чтение
    std::optional<std::string> day, altDay;
    std::optional<int> weekday;
    bool isWeak = false;
};

struct Chosen;
struct Candidate;
using When = std::function<bool(const Chosen &, const Candidate &)>;

struct Candidate : PickItem {
    std::string field;
    CandidateValue value;
    // Условие: кандидат годится только при таком выборе кандидатов старше его
    When when;
    int id = 0;
};

// Выбранный набор и то, что о нём спрашивают условия
struct Chosen {
    std::vector<Candidate> items;
    std::map<std::string, const Candidate *> slots;
    // Занятые символы строки; день в счёт не идёт — он младше всех
    std::vector<bool> taken;
    int nutrients = 0;
    int regularNutrients = 0;

    const Candidate *slot(const std::string &name) const {
        const auto it = slots.find(name);
        return it == slots.end() ? nullptr : it->second;
    }
};

void chosenState(Chosen &state, std::vector<Candidate> items, size_t length) {
    state.items = std::move(items);
    state.taken.assign(length, false);
    state.slots.clear();
    state.nutrients = 0;
    state.regularNutrients = 0;
    for (const auto &item : state.items) {
        state.slots[item.slot] = &item;
        if (item.slot != "day") {
            for (int i = std::max(0, item.from); i < std::min<int>(item.to, int(length)); ++i) state.taken[size_t(i)] = true;
        }
        if (item.value.nutrient) state.nutrients += 1;
        if (item.value.nutrient && !item.value.isShort) state.regularNutrients += 1;
    }
}

struct Zone {
    int from;
    int to;
    Match match;
};

std::vector<Zone> matchZones(const Regex &re, const S &lower) {
    std::vector<Zone> zones;
    int from = 0;
    Match found;
    while (re.exec(lower, from, found)) {
        const int start = found.index() + (found.stop(1) - found.start(1));
        const int to = start + (found.stop(2) - found.start(2));
        zones.push_back({start, to, found});
        from = std::max(to, found.index() + 1);
    }
    return zones;
}

// Ключ значения для вариантов и закрепления: время, день, срок
const std::vector<std::string> kPickSlots = {"time", "day", "due"};

std::optional<std::string> timeKey(const std::optional<double> &start, const std::optional<double> &end) {
    if (!start || *start >= kDayMinutes) return std::nullopt;
    if (!end || *end > kDayMinutes) return toTime(*start);
    return toTime(*start) + "-" + toTime(std::min(*end, kDayMinutes - 1));
}

std::optional<std::string> valueKey(const std::string &slot, const CandidateValue &value) {
    return slot == "time" ? timeKey(value.start, value.end) : value.day;
}

std::optional<std::string> altKey(const std::string &slot, const CandidateValue &value) {
    return slot == "time" ? timeKey(value.altStart, value.end) : value.altDay;
}

const std::optional<std::string> &pickOf(const QuickPick &pick, const std::string &slot) {
    if (slot == "time") return pick.time;
    if (slot == "day") return pick.day;
    if (slot == "due") return pick.due;
    return pick.repeat;
}

// Закреплённое чтение: в слоте остаётся кандидат с этим значением (своим либо другим чтением)
std::vector<Candidate> pinCandidates(const std::vector<Candidate> &pool, const std::optional<QuickPick> &pick,
                                     int &nextId) {
    if (!pick) return pool;
    std::vector<Candidate> result = pool;
    for (const auto &slot : kPickSlots) {
        const auto &wanted = pickOf(*pick, slot);
        if (!wanted || wanted->empty()) continue;
        const Candidate *exact = nullptr;
        const Candidate *other = nullptr;
        for (const auto &item : result) {
            if (item.slot == slot && valueKey(slot, item.value) == wanted) {
                exact = &item;
                break;
            }
        }
        if (!exact) {
            for (const auto &item : result) {
                if (item.slot == slot && altKey(slot, item.value) == wanted) {
                    other = &item;
                    break;
                }
            }
        }
        std::optional<Candidate> pinned;
        if (exact) {
            pinned = *exact;
        } else if (other) {
            pinned = *other;
            pinned->id = nextId++;
            if (slot == "time") {
                std::swap(pinned->value.start, pinned->value.altStart);
            } else {
                std::swap(pinned->value.day, pinned->value.altDay);
            }
        }
        if (pinned) {
            std::vector<Candidate> next;
            for (const auto &item : result) {
                if (item.slot != slot) next.push_back(item);
            }
            next.push_back(*pinned);
            result = std::move(next);
        }
    }
    return result;
}

// День недели, если текст — название дня (с предлогом либо без)
std::optional<int> weekdayIn(const S &text, const Lang &lang) {
    Match parts;
    if (!lang.weekdayParts->exec(text, 0, parts)) return std::nullopt;
    return lang.weekdayOf(parts.str(text, 1));
}

// `isNear` — другое чтение: день недели, совпавший с сегодняшним, — сегодня (а не через неделю), дата без
// года — в этом году, даже если прошла
std::optional<std::string> resolveDate(const S &text, const std::string &today, const Lang &lang, bool isNear = false) {
    if (const auto relative = lang.relativeOf(text)) return addDays(today, *relative);
    Match m;
    if (lang.inParts->exec(text, 0, m)) {
        const double count = lang.countOf(m.has(1) ? std::optional<S>(m.str(text, 1)) : std::nullopt);
        const auto unit = lang.unitOf(m.str(text, 2));
        return unit == "monthly" ? addMonths(today, (long long)count)
                                 : addDays(today, (long long)(unit == "weekly" ? count * kDaysInWeek : count));
    }
    if (lang.isNextWeek->test(text)) return nextWeekday(today, 1, false);
    if (rx("^(\\d{1,2})\\.(\\d{2})(?:\\.(\\d{2,4}))?$").exec(text, 0, m)) {
        return nearestDate(today, jsNumber(m.str(text, 2)), jsNumber(m.str(text, 1)),
                           m.has(3) ? std::optional<double>(jsNumber(m.str(text, 3))) : std::nullopt, isNear);
    }
    if (lang.dayMonth->exec(text, 0, m)) {
        return nearestDate(today, lang.monthOf(m.str(text, 2)).value_or(0), jsNumber(m.str(text, 1)), std::nullopt,
                           isNear);
    }
    if (lang.words.isMonthFirst && lang.monthDay->exec(text, 0, m)) {
        return nearestDate(today, lang.monthOf(m.str(text, 1)).value_or(0), jsNumber(m.str(text, 2)), std::nullopt,
                           isNear);
    }
    if (const auto weekday = weekdayIn(text, lang)) return nextWeekday(today, *weekday, isNear);
    // «до марта»: первый день месяца
    const auto month = lang.monthOf(text);
    return month && *month ? nearestDate(today, *month, 1, std::nullopt, isNear) : std::nullopt;
}

std::optional<double> resolveHour(double hour, double minute, const std::optional<std::string> &daypart = std::nullopt) {
    if (hour > 24 || minute > 59 || (hour == 24 && minute != 0)) return std::nullopt;
    double h = hour;
    if (daypart == "pm") {
        if (h < 12) h += 12;
    } else if (daypart == "night") {
        if (h == 12) h = 0;
        else if (h >= 9 && h < 12) h += 12;
    } else if (daypart == "am") {
        if (h == 12) h = 0;
    }
    return h * kMinutesInHour + minute;
}

// «в 5» без уточнения — значение внутри окна дня; оба подходят либо ни одно — как написано
double resolveBareHour(double hour, const QuickContext &ctx) {
    const double morning = hour * kMinutesInHour;
    const double evening = morning + 12 * kMinutesInHour;
    const auto isInside = [&](double value) { return value >= ctx.dayStart && value <= ctx.dayEnd; };
    return hour <= 11 && !isInside(morning) && isInside(evening) ? evening : morning;
}

// Разговорные часы двенадцатичасовые: половина суток — по окну дня, как у голого часа
double resolveLooseClock(double hour, double minute, const QuickContext &ctx) {
    const double morning = std::fmod(hour, 12) * kMinutesInHour + minute;
    const double evening = morning + 12 * kMinutesInHour;
    const auto isInside = [&](double value) { return value >= ctx.dayStart && value <= ctx.dayEnd; };
    return !isInside(morning) && isInside(evening) ? evening : morning;
}

// Свёртка регистра обязана сохранять позиции символов: участки меряются по исходной строке
S fold(const S &text) {
    const S folded = foldYo(jsLower(text));
    return folded.size() == text.size() ? folded : text;
}

std::string mealByTime(double minutes) {
    if (minutes < 11 * kMinutesInHour) return "breakfast";
    if (minutes < 16 * kMinutesInHour) return "lunch";
    if (minutes < 22 * kMinutesInHour) return "dinner";
    return "snack";
}

// ── опечатки ─────────────────────────────────────────────────────────────────

bool isOneEditAway(const S &a, const S &b) {
    if ((a.size() > b.size() ? a.size() - b.size() : b.size() - a.size()) > 1) return false;
    size_t start = 0;
    while (start < a.size() && start < b.size() && a[start] == b[start]) start++;
    const S restA = a.substr(start);
    const S restB = b.substr(start);
    const auto from = [](const S &s, size_t k) { return k < s.size() ? s.substr(k) : S(); };
    const auto at = [](const S &s, size_t k) { return k < s.size() ? std::optional<char16_t>(s[k]) : std::nullopt; };
    if (a.size() == b.size()) {
        return from(restA, 1) == from(restB, 1)
            || (at(restA, 0) == at(restB, 1) && at(restA, 1) == at(restB, 0) && from(restA, 2) == from(restB, 2));
    }
    return a.size() > b.size() ? from(restA, 1) == restB : restA == from(restB, 1);
}

// «по понидельникам каждую ниделю»: длинное слово с одной опечаткой читается как слово разбора. Первая буква
// обязана совпасть
S fixTypos(const S &text, const Lang &lang) {
    return replaceAll(rx("[a-zа-яё]+", "i"), text, [&](const Match &m) {
        const S token = m.str(text, 0);
        const S typed = foldYo(jsLower(token));
        if (typed.size() < kMinTypoLength || lang.typoSafe.count(typed)) return token;
        for (const auto &known : lang.typoWords) {
            if (!known.empty() && known[0] == typed[0] && isOneEditAway(typed, known)) return known;
        }
        return token;
    });
}

// ── напоминание ──────────────────────────────────────────────────────────────

struct Remind {
    double minutes;
    int from;
    int to;
};

double remindUnitMinutes(const S &unit) {
    const S u = jsLower(unit);
    const char16_t c = u.empty() ? 0 : u[0];
    if (c == u'м' || c == u'm') return 1;
    if (c == u'ч' || c == u'h') return 60;
    if (c == u'д' || c == u'd') return 24 * 60;
    return 7 * 24 * 60;
}

std::optional<Remind> findRemind(const S &text) {
    static const Regex &head = rx("(^|[\\s,;])(напомнить|напомни|напоминание|remind(?:\\s+me)?|reminder)(?=$|[\\s,;])",
                                  "i");
    static const Regex &ru = rx("^\\s+(?:мне\\s+)?за\\s+(?:(\\d+)\\s*"
                                "(минут[уы]?|мин|м|час(?:а|ов)?|ч|дн(?:я|ей)|день|д|недел[юи]|нед)"
                                "|(полчаса|час|день|сутки|неделю))(?=$|[\\s,;.])",
                                "i");
    static const Regex &en = rx("^\\s+(?:(\\d+)\\s*(minutes?|mins?|m|hours?|h|days?|d|weeks?|w)"
                                "|(half an hour|an hour|a day|a week))\\s+(?:before|earlier|ahead)(?=$|[\\s,;.])",
                                "i");
    static const std::map<S, double> words = {
        {u"полчаса", 30}, {u"час", 60}, {u"день", 24 * 60}, {u"сутки", 24 * 60}, {u"неделю", 7 * 24 * 60},
        {u"half an hour", 30}, {u"an hour", 60}, {u"a day", 24 * 60}, {u"a week", 7 * 24 * 60},
    };
    Match h;
    if (!head.exec(text, 0, h)) return std::nullopt;
    const int from = h.start(2);
    int to = h.stop(2);
    const S rest = text.substr(size_t(to));
    Match amount;
    const bool found = ru.exec(rest, 0, amount) || en.exec(rest, 0, amount);
    double minutes = 0;
    if (found) {
        if (amount.has(1) && amount.stop(1) > amount.start(1)) {
            minutes = jsNumber(amount.str(rest, 1)) * remindUnitMinutes(amount.str(rest, 2));
        } else {
            const auto it = words.find(jsLower(amount.str(rest, 3)));
            minutes = it == words.end() ? NAN : it->second;
        }
        to += amount.end();
    }
    if (!std::isfinite(minutes) || minutes > 7 * 24 * 60) return std::nullopt;
    return Remind{minutes, from, to};
}

// ── явные метки ──────────────────────────────────────────────────────────────
// Метка — отдельное слово: перед знаком начало строки либо пробел, после слова — конец строки, пробел либо
// знак препинания. #слово — группа; @место — место; ! — важное (один «!» отдельным словом либо в самом конце
// первой строки сразу после слова). Берётся первая метка каждого вида; остальные остаются в названии.
struct Span2 {
    int from;
    int to;
};

std::optional<Span2> markerFind(const std::string &pattern, const S &text) {
    const Regex &re = rx("(^|\\s)(" + pattern + ")(?![^\\s,;.:!?)])", "u");
    Match m;
    if (!re.exec(text, 0, m)) return std::nullopt;
    return Span2{m.start(2), m.stop(2)};
}

std::optional<Span2> findImportant(const S &text) {
    Match alone;
    if (rx("(^|\\s)!(?=\\s|$)").exec(text, 0, alone)) {
        const int from = alone.start(0) + (alone.stop(1) - alone.start(1));
        return Span2{from, from + 1};
    }
    const long lineEnd = indexOf(text, u"\n");
    const S line = trimEnd(lineEnd < 0 ? text : text.substr(0, size_t(lineEnd)));
    return rx("[^\\s!?]!$").test(line) ? std::optional<Span2>(Span2{int(line.size()) - 1, int(line.size())})
                                       : std::nullopt;
}

std::optional<Span2> findMarker(int index, const S &text) {
    if (index == 0) return markerFind("#\\p{L}[\\p{L}\\p{N}_-]*", text);
    if (index == 1) return markerFind("@[\\p{L}\\p{N}][\\p{L}\\p{N}_-]*", text);
    return findImportant(text);
}

// ── название и описание ──────────────────────────────────────────────────────

// Как в web: replace(/\s+/g, ' ') → replace(/\s+([,;])/g, '$1') → replace(/^[\s,;.:—–-]+|[\s,;:—–-]+$/g, '')
// (написано вручную — функция горячая)
S cleanName(const S &text) {
    S collapsed;
    collapsed.reserve(text.size());
    for (size_t i = 0; i < text.size(); ++i) {
        if (isJsSpace(text[i])) {
            while (i + 1 < text.size() && isJsSpace(text[i + 1])) ++i;
            collapsed += u' ';
        } else {
            collapsed += text[i];
        }
    }
    S out;
    out.reserve(collapsed.size());
    for (size_t i = 0; i < collapsed.size(); ++i) {
        if (collapsed[i] == u' ' && i + 1 < collapsed.size() && (collapsed[i + 1] == u',' || collapsed[i + 1] == u';')) {
            continue;
        }
        out += collapsed[i];
    }
    const auto isEdge = [](char16_t c, bool lead) {
        return c == u' ' || c == u',' || c == u';' || c == u':' || c == u'—' || c == u'–' || c == u'-'
            || (lead && c == u'.');
    };
    size_t from = 0;
    while (from < out.size() && isEdge(out[from], true)) ++from;
    size_t to = out.size();
    while (to > from && isEdge(out[to - 1], false)) --to;
    return out.substr(from, to - from);
}

// Описание многострочное: переводы строк внутри него сохраняются
S cleanDescription(const S &text) {
    S out;
    bool first = true;
    for (const auto &line : splitStr(text, u"\n")) {
        const S clean = cleanName(line);
        if (clean.empty()) continue;
        if (!first) out += u'\n';
        out += clean;
        first = false;
    }
    return out;
}

// Ссылка на заметку (её заглушка) — тоже слово: название может состоять из неё одной
bool hasLetter(const S &text) { return rx("[a-zа-яё\\ue000-\\uf8ff]", "i").test(text); }

struct Split {
    S name;
    S description;
    int from;
};

// Название и описание задачи либо события (правила — в web у splitName): перевод строки; явный разделитель
// (« -- », « — », « – », « - », « // », «: », «; », «. »; метки-подписи `descLabels`); слово-ввод описания
// (`descLeads`). Не делят запятая, скобки, дефис и двоеточие без пробела, точка после сокращения.
std::optional<Split> splitName(const S &plain, const S &lower, const Lang &lang) {
    const auto result = [&](int nameEnd, int from) -> std::optional<Split> {
        const S name = replaceAll(rx("\\.+$"), cleanName(slice(plain, 0, nameEnd)), [](const Match &) { return S(); });
        const S full = cleanDescription(slice(plain, from));
        Match label;
        const int cut = lang.labelHead->exec(jsLower(full), 0, label) ? label.end() - label.index() : 0;
        const S description = slice(full, cut);
        if (hasLetter(name) && rx("[^\\s\\p{P}]", "u").test(description)) return Split{name, description, from};
        return std::nullopt;
    };

    const long lineBreak = indexOf(lower, u"\n");
    if (lineBreak >= 0) {
        if (auto byLine = result(int(lineBreak), int(lineBreak) + 1)) return byLine;
    }

    const Regex &separator = rx("\\s(?:--|[—–-]|\\/\\/)\\s|[:;.]\\s");
    Match match;
    int from = 0;
    while (separator.exec(lower, from, match)) {
        const S whole = match.str(lower, 0);
        const S sign = trim(whole);
        const int at = match.index() + int(indexOf(whole, sign));
        const int to = at + int(sign.size());
        from = match.index() + 1;
        Match label;
        const bool hasLabel = lang.labelTail->exec(slice(lower, 0, to), 0, label);
        if (hasLabel || sign != u"." || !lang.abbreviationTail->test(slice(lower, 0, at))) {
            const int labelLen = hasLabel ? (label.has(1) && label.stop(1) > label.start(1)
                                                 ? label.stop(1) - label.start(1)
                                                 : label.stop(2) - label.start(2))
                                          : 0;
            const int labelAt = hasLabel ? to - labelLen : at;
            // «тема: оптика» уходит в описание целиком; подпись («описание:») отбрасывается
            const bool kept = hasLabel && label.has(2) && label.stop(2) > label.start(2);
            const auto found = kept ? result(labelAt, labelAt) : result(labelAt, to);
            if (found) return found;
        }
    }

    const Regex &lead = word(lang.descLeads);
    from = 0;
    while (lead.exec(lower, from, match)) {
        const int start = match.start(2);
        const int to = match.stop(2);
        from = to;
        if (!lang.isWeakName->test(cleanName(slice(lower, 0, start))) && hasLetter(slice(lower, to))) {
            if (auto found = result(start, start)) return found;
        }
    }
    return std::nullopt;
}

// Первое слово названия для словаря правок: служебные и однобуквенные слова пропускаются
std::optional<S> headWord(const S &name, const Lang &lang) {
    const S folded = fold(name);
    for (const auto &m : matchAll(rx("[a-zа-я]+"), folded)) {
        const S item = m.str(folded, 0);
        if (item.size() > 1 && !lang.isFunctionWord->test(item)) return item;
    }
    return std::nullopt;
}

QuickDraft parseText(const S &text, const std::vector<NumeralEdit> &edits, const QuickContext &ctx, const Lang &lang);

// ── здоровье и цели (spec 020) ───────────────────────────────────────────────

QuickDraft healthDraft(const std::string &kind, const QuickContext &ctx) {
    QuickDraft draft;
    draft.kind = kind;
    draft.day = ctx.today;
    return draft;
}

bool has(const std::optional<std::vector<std::string>> &list, const std::string &value) {
    return list && std::find(list->begin(), list->end(), value) != list->end();
}

QuickDraft parseMetric(const std::string &metric, const S &rest, const QuickContext &ctx, const Lang &lang) {
    const Words &words = lang.words;
    QuickDraft fail = healthDraft("metric", ctx);
    fail.metric = metric;
    fail.error = "name";
    const S body = trim(rest);
    Match m;
    if (metric == "pressure") {
        if (!rx("^(\\d{2,3})\\s*(?:\\/|" + words.pressureOver + ")\\s*(\\d{2,3})$").exec(body, 0, m)) return fail;
        QuickDraft draft = healthDraft("metric", ctx);
        draft.metric = metric;
        draft.value = jsNumber(m.str(body, 1));
        draft.value2 = jsNumber(m.str(body, 2));
        return draft;
    }
    if (!rx("^(\\d[\\d ]*(?:[.,]\\d+)?)\\s*(?:" + words.kg + "|" + words.beats + ")?$").exec(body, 0, m)) return fail;
    S digits;
    for (const char16_t c : m.str(body, 1)) {
        if (c != u' ') digits += c;
    }
    const double value = toNumber(digits);
    const bool isWhole = isInteger(value);
    const bool isValid = metric == "weight" ? value > 0 && value < 500
        : metric == "mood"                  ? isWhole && value >= 1 && value <= kMaxMood
        : metric == "steps"                 ? isWhole && value <= kMaxSteps
                                            : isWhole && value > 0 && value < 300;
    if (!isValid) return fail;
    QuickDraft draft = healthDraft("metric", ctx);
    draft.metric = metric;
    draft.value = value;
    return draft;
}

// Группы: час и минуты отхода ко сну, час и минуты подъёма
QuickDraft sleepRange(const Match &g, const S &s, const QuickContext &ctx) {
    const auto num = [&](int i) { return g.has(i) && g.stop(i) > g.start(i) ? jsNumber(g.str(s, i)) : 0.0; };
    const auto typedBed = resolveHour(jsNumber(g.str(s, 1)), num(2));
    const auto wake = resolveHour(jsNumber(g.str(s, 3)), num(4));
    // «с 11 до 7» — лёг вечером: сон дольше 16 часов означает, что час отхода назван без «вечера»
    const bool isEvening = typedBed && wake && *typedBed < kDayMinutes / 2
        && std::fmod(*wake - *typedBed + kDayMinutes, kDayMinutes) > kMaxSleepMinutes;
    const auto bed = isEvening ? std::optional<double>(*typedBed + kDayMinutes / 2) : typedBed;
    QuickDraft draft = healthDraft("sleep", ctx);
    if (!bed || !wake || *bed == *wake || *bed >= kDayMinutes || *wake >= kDayMinutes) {
        draft.error = "time";
        return draft;
    }
    draft.start = toTime(*bed);
    draft.end = toTime(*wake);
    draft.minutes = std::fmod(*wake - *bed + kDayMinutes, kDayMinutes);
    return draft;
}

// «23:40-07:30» — лёг и встал; «7,5 ч», «7 ч 30 мин» — только длительность
QuickDraft parseSleep(const S &rest, const QuickContext &ctx, const Lang &lang) {
    const Words &words = lang.words;
    Match range;
    if (rx("(\\d{1,2})(?:[:.](\\d{2}))?\\s*(?:" + DASH + "|" + words.to + ")\\s*(\\d{1,2})(?:[:.](\\d{2}))?"
           + "(?![.,:]?\\d|\\s*(?:" + words.hour + ")" + SEPARATOR + ")")
            .exec(rest, 0, range)) {
        return sleepRange(range, rest, ctx);
    }
    Match duration;
    const bool hasDuration = rx("(" + NUM + ")\\s*(?:" + words.hour + ")" + SEPARATOR + "(?:\\s*(\\d{1,2})" + lang.minutes
                                + SEPARATOR + ")?")
                                 .exec(rest, 0, duration);
    const double minutes = hasDuration ? jsRound(toNumber(duration.str(rest, 1)) * kMinutesInHour)
            + (duration.has(2) && duration.stop(2) > duration.start(2) ? jsNumber(duration.str(rest, 2)) : 0)
                                       : 0;
    QuickDraft draft = healthDraft("sleep", ctx);
    // «0», «0 ч», «0ч» — записанный ноль, как «не спал»
    if ((hasDuration && minutes == 0) || rx("^\\s*0\\s*$").test(rest)) {
        draft.minutes = 0;
        return draft;
    }
    if (minutes > 0 && minutes < kDayMinutes) {
        draft.minutes = minutes;
    } else {
        draft.error = "time";
    }
    return draft;
}

// «вчера спал с 5 до 15», «позавчера лёг в 23 встал в 7»: сон — на названный день (день подъёма)
QuickDraft sleepOnDay(QuickDraft draft, const S &lower, const QuickContext &ctx, const Lang &lang) {
    const int shift = lang.sleepDayBefore && lang.sleepDayBefore->test(lower) ? -2
        : lang.sleepYesterday && lang.sleepYesterday->test(lower)              ? -1
                                                                              : 0;
    if (shift) draft.day = addDays(ctx.today, shift);
    return draft;
}

// Тренировка-запись: «бег 5 км 28 мин», «зал присед 4x8x80, жим 3x10x60», «зал 60 мин». Тренировка с временем
// начала, на будущий день либо с повтором — запланированное событие календаря, его разбирает основной разбор
std::optional<QuickDraft> parseWorkout(const S &text, const S &lower, const std::vector<NumeralEdit> &edits,
                                       const QuickContext &ctx, const Lang &lang) {
    const Words &words = lang.words;
    std::vector<bool> taken(text.size(), false);
    const auto cut = [&](int from, int to) {
        for (int i = from; i < to && i < int(taken.size()); ++i) taken[size_t(i)] = true;
    };
    std::optional<double> distanceKm;
    Match distance;
    if (rx("(" + NUM + ")\\s*(" + bodies(words.distance) + ")" + SEPARATOR).exec(lower, 0, distance)) {
        distanceKm = jsRound(toNumber(distance.str(lower, 1)) * lang.distanceOf(distance.str(lower, 2)).value_or(1) * 100)
            / 100;
        cut(distance.index(), distance.end());
    }
    std::vector<Exercise> exercises;
    // Название, затем «подходы × повторы × вес» (вес необязателен); упражнения разделены запятой
    const Regex &sets = rx("([" + LETTER + "][" + LETTER + " ]*?)\\s*(\\d{1,2})\\s*[xх×*]\\s*(\\d{1,3})"
                           + "(?:\\s*[xх×*]\\s*(\\d+(?:[.,]\\d+)?))?\\s*(?:" + words.kg + ")?\\s*(?:,|;|$)");
    Match lead;
    int from = lang.workoutLead->exec(lower, 0, lead) ? lead.end() : 0;
    Match match;
    while (sets.exec(lower, from, match)) {
        Exercise exercise;
        exercise.name = toUtf8(trim(slice(text, match.index(), match.index() + (match.stop(1) - match.start(1)))));
        exercise.sets = jsNumber(match.str(lower, 2));
        exercise.reps = jsNumber(match.str(lower, 3));
        if (match.has(4) && match.stop(4) > match.start(4)) exercise.weight = toNumber(match.str(lower, 4));
        exercises.push_back(exercise);
        cut(match.index(), match.end());
        from = match.end() > match.index() ? match.end() : match.index() + 1;
    }
    // `[...text]` в web идёт по кодовым точкам, а занятые позиции — по единицам UTF-16: переносим как есть
    S rest;
    {
        size_t i = 0;
        size_t index = 0;
        while (i < text.size()) {
            size_t len = 1;
            if (text[i] >= 0xD800 && text[i] < 0xDC00 && i + 1 < text.size() && text[i + 1] >= 0xDC00
                && text[i + 1] < 0xE000) {
                len = 2;
            }
            if (index < taken.size() && taken[index]) rest += u' ';
            else rest += text.substr(i, len);
            i += len;
            ++index;
        }
    }
    // У записи тренировки нет ни описания, ни меток: название не делится
    QuickContext inner = ctx;
    inner.kind = "event";
    inner.kinds = std::nullopt;
    std::vector<std::string> skip = ctx.skip.value_or(std::vector<std::string>{});
    skip.push_back("description");
    skip.insert(skip.end(), kMarkerFields.begin(), kMarkerFields.end());
    inner.skip = skip;
    const QuickDraft base = parseText(rest, edits, inner, lang);
    const bool isRecord = (distanceKm && *distanceKm != 0) || !exercises.empty()
        || (!base.start && !base.repeat && base.day.value_or(ctx.today) <= ctx.today);
    if (!isRecord && ctx.kind != "workout") return std::nullopt;
    const bool hasContent = (distanceKm && *distanceKm != 0) || !exercises.empty() || truthy(base.minutes);
    // «бег 28 мин» — запись тренировки либо дело с длительностью: второе чтение остаётся вариантом
    std::vector<std::string> plainKinds;
    for (const std::string kind : {"task", "event"}) {
        if (!ctx.kinds || has(ctx.kinds, kind)) plainKinds.push_back(kind);
    }
    std::optional<std::string> other;
    if (!ctx.kind && !plainKinds.empty()) {
        QuickContext second = ctx;
        second.kinds = plainKinds;
        second.pick = std::nullopt;
        other = parseText(text, edits, second, lang).kind;
    }
    QuickDraft draft;
    draft.kind = "workout";
    if (other) draft.alternatives = std::vector<QuickAlt>{{"kind", *other, std::nullopt}};
    draft.name = base.name;
    draft.day = base.day ? base.day : std::optional<std::string>(ctx.today);
    if (base.day && base.day->empty()) draft.day = ctx.today;
    draft.start = base.start;
    draft.minutes = base.minutes;
    draft.distanceKm = distanceKm;
    if (!exercises.empty()) draft.exercises = exercises;
    if (base.name.empty()) draft.error = "name";
    else if (!hasContent) draft.error = "minutes";
    return draft;
}

// «цель белок 140 вода 2,5л сон 8ч день с 8 до 22» — меняет цели и настройки
QuickDraft parseGoal(const S &rest, const QuickContext &ctx, const Lang &lang) {
    const Words &words = lang.words;
    const auto &names = words.goals;
    QuickGoalChanges changes;
    int found = 0;
    const auto take = [&](const std::string &body, const std::function<void(const G &)> &apply) {
        Match match;
        if (!word(body).exec(rest, 0, match)) return;
        apply(G{&match, &rest, 2});
        found += 1;
    };
    for (const std::string metric : {"kcal", "protein", "fat", "carbs", "fiber"}) {
        take("(?:" + names.at(metric) + ")\\s*(" + NUM + ")", [&](const G &g) { changes.goals[metric] = toNumber(g[1]); });
    }
    take("(?:" + names.at("water") + ")\\s*(" + NUM + ")\\s*(?:(" + words.ml + ")|(" + words.litre + "))?",
         [&](const G &g) {
             const double amount = toNumber(g[1]);
             // Без единицы: большое число — миллилитры, малое — литры
             changes.goals["water"] = jsRound(g.truthy(2) || (!g.truthy(3) && amount > 20) ? amount : amount * kMlInLitre);
         });
    take("(?:" + names.at("sugar") + ")\\s*(" + NUM + ")", [&](const G &g) { changes.health.sugarMax = toNumber(g[1]); });
    take("(?:" + names.at("salt") + ")\\s*(" + NUM + ")", [&](const G &g) { changes.health.saltMax = toNumber(g[1]); });
    // «сон 23:30-07:00» — режим: когда ложиться и вставать (минуты от полуночи); «сон 8ч» — длительность
    take("(?:" + names.at("sleep") + ")\\s+(?:(?:" + words.from + ")\\s+)?(" + HOUR + "):(" + MINUTE + ")\\s*(?:" + DASH
             + "|" + words.to + ")\\s*(" + HOUR + "):(" + MINUTE + ")",
         [&](const G &g) {
             changes.health.bedtime = std::fmod(jsNumber(g[1]), 24) * kMinutesInHour + jsNumber(g[2]);
             changes.health.wakeTime = std::fmod(jsNumber(g[3]), 24) * kMinutesInHour + jsNumber(g[4]);
         });
    take("(?:" + names.at("sleep") + ")\\s*(" + NUM + ")(?![:\\d])\\s*(?:" + words.hour + ")?",
         [&](const G &g) { changes.health.sleepMinutes = jsRound(toNumber(g[1]) * kMinutesInHour); });
    take("(?:" + names.at("weight") + ")\\s*(" + NUM + ")", [&](const G &g) { changes.health.weight = toNumber(g[1]); });
    take("(?:" + names.at("steps") + ")\\s*(\\d[\\d ]*\\d|\\d)", [&](const G &g) {
        S digits;
        for (const char16_t c : g[1]) {
            if (c != u' ') digits += c;
        }
        changes.health.steps = jsNumber(digits);
    });
    take("(?:" + names.at("day") + ")\\s+(?:(?:" + words.from + ")\\s+)?(" + HOUR + ")(?::(" + MINUTE + "))?\\s*(?:"
             + DASH + "|" + words.to + ")\\s*(" + HOUR + ")(?::(" + MINUTE + "))?",
         [&](const G &g) {
             changes.dayStart = jsNumber(g[1]) * kMinutesInHour + (g.truthy(2) ? jsNumber(g[2]) : 0);
             changes.dayEnd = jsNumber(g[3]) * kMinutesInHour + (g.truthy(4) ? jsNumber(g[4]) : 0);
         });
    take("(?:" + names.at("budget") + ")\\s*(" + NUM + ")\\s*(?:" + words.hour + ")?",
         [&](const G &g) { changes.budget = jsRound(toNumber(g[1]) * kMinutesInHour); });
    const bool isWindowValid = !changes.dayStart || !changes.dayEnd || *changes.dayStart < *changes.dayEnd;
    QuickDraft draft = healthDraft("goal", ctx);
    draft.day = std::nullopt;
    draft.goalChanges = changes;
    if (!found) draft.error = "name";
    else if (!isWindowValid) draft.error = "time";
    return draft;
}

S replaceLead(const Regex &re, const S &text) {
    return replaceFirst(re, text, [](const Match &) { return S(); });
}

std::optional<QuickDraft> parseHealth(const S &text, const S &lower, const std::vector<NumeralEdit> &edits,
                                      const QuickContext &ctx, const std::set<std::string> &allowed, const Lang &lang) {
    const auto can = [&](const std::string &kind) { return allowed.count(kind) && (!ctx.kind || *ctx.kind == kind); };
    // Слово, обычное и в названиях дел: без разобранного значения это не запись здоровья
    const bool isWeak = !ctx.kind && lang.weakLead && lang.weakLead->test(lower);
    const auto settle = [&](std::optional<QuickDraft> draft) -> std::optional<QuickDraft> {
        return isWeak && draft && draft->error ? std::nullopt : draft;
    };
    QuickDraft zero = healthDraft("sleep", ctx);
    zero.minutes = 0;
    if (!has(ctx.skip, "kind")) {
        if (can("goal") && lang.goalLead->test(lower)) {
            const QuickDraft goal = parseGoal(replaceLead(*lang.goalLead, lower), ctx, lang);
            // Найденная, но неверная цель — ошибка цели, а не название дела
            if (isWeak && goal.error == "name") return std::nullopt;
            return goal;
        }
        Match metric;
        if (can("metric") && lang.metricLead->exec(lower, 0, metric)) {
            return settle(parseMetric(*lang.metricOf(metric.str(lower, 1)), metric.str(lower, 2), ctx, lang));
        }
        if (can("sleep") && lang.sleepNone && lang.sleepNone->test(lower)) return sleepOnDay(zero, lower, ctx, lang);
        if (can("sleep") && lang.sleepLead->test(lower)) {
            const QuickDraft sleep = sleepOnDay(parseSleep(replaceLead(*lang.sleepLead, lower), ctx, lang), lower, ctx, lang);
            // «я спал плохо» без времени — не запись сна, а обычная строка
            if (!lang.plainSleepLead->test(lower) && sleep.error) return std::nullopt;
            return settle(sleep);
        }
        Match bedWake;
        if (can("sleep") && lang.bedWake && lang.bedWake->exec(lower, 0, bedWake)) {
            return sleepOnDay(sleepRange(bedWake, lower, ctx), lower, ctx, lang);
        }
    }
    if (ctx.kind == "sleep" && lang.sleepNone && lang.sleepNone->test(lower)) return sleepOnDay(zero, lower, ctx, lang);
    if (ctx.kind == "sleep") return sleepOnDay(parseSleep(lower, ctx, lang), lower, ctx, lang);
    // Тип «цель» выбран вызывающим: слово «цель» в начале не обязательно
    if (ctx.kind == "goal") return parseGoal(lower, ctx, lang);
    if (can("workout") && (ctx.kind == "workout" || lang.workoutLead->test(lower))) {
        return settle(parseWorkout(text, lower, edits, ctx, lang));
    }
    return std::nullopt;
}

// ── разбор строки ────────────────────────────────────────────────────────────

// `text` — строка с цифрами на месте числительных, `edits` — её замены: название и описание режутся из слов
// пользователя (незабранная замена возвращает исходные слова), участки — в позициях этих слов
QuickDraft parseText(const S &text, const std::vector<NumeralEdit> &edits, const QuickContext &ctx, const Lang &lang) {
    const Words &words = lang.words;
    const S lower = fold(text);
    const size_t length = text.size();
    std::vector<bool> taken(length, false);
    std::vector<QuickSpan> spans;
    const auto skipped = [&](const std::string &field) { return has(ctx.skip, field); };
    std::set<std::string> allowed;
    if (ctx.kind) allowed.insert(*ctx.kind);
    else if (ctx.kinds) allowed.insert(ctx.kinds->begin(), ctx.kinds->end());
    else allowed.insert(kQuickKinds.begin(), kQuickKinds.end());

    // Здоровье и цели узнаются по первому слову; тип, выбранный пользователем, сильнее слова
    if (auto health = parseHealth(text, lower, edits, ctx, allowed, lang)) return *health;

    QuickDraft draft;
    std::optional<std::string> explicitKind = ctx.kind;

    // ── кандидаты ──────────────────────────────────────────────────────────────
    std::vector<Candidate> pool;
    int nextId = 1;
    const auto push = [&](const std::string &slot, const std::string &field, int rankValue, int from, int to,
                          CandidateValue value = {}, When when = nullptr) {
        Candidate c;
        c.slot = slot;
        c.field = field;
        c.from = from;
        c.to = to;
        c.score = candidateScore(rankValue, from, to);
        c.value = std::move(value);
        c.when = std::move(when);
        c.id = nextId++;
        pool.push_back(std::move(c));
    };
    using Read = std::function<std::optional<CandidateValue>(const G &, int, int)>;
    // Все совпадения выражения по порядку; `read` возвращает значение либо ничего — «не моё»
    const auto offer = [&](const std::string &slot, const std::string &field, int rankValue, const std::string &body,
                           const Read &read, When when = nullptr) {
        if (skipped(field)) return;
        const Regex &re = word(body);
        Match match;
        int from = 0;
        while (re.exec(lower, from, match)) {
            const int start = match.start(2);
            const int to = match.stop(2);
            from = std::max(to, match.index() + 1);
            if (auto value = read(G{&match, &lower, 2}, start, to)) push(slot, field, rankValue, start, to, *value, when);
        }
    };

    // Слова-типы в начале строки
    if (!explicitKind) {
        Match lead;
        if (lang.kindLead->exec(lower, 0, lead)) {
            const std::string leadKind = lead.has(2) ? "event" : "task";
            if (allowed.count(leadKind) && !skipped("kind")) {
                explicitKind = leadKind;
                push("kind", "kind", rank::kind, 0, lead.end());
            }
        }
    }

    // Явные метки: #список, @место, !. Старше всех, чтобы слова внутри метки не разбирались
    for (int index = 0; index < 3; ++index) {
        const std::string &field = kMarkerFields[size_t(index)];
        const auto found = skipped(field) ? std::nullopt : findMarker(index, text);
        if (found) push(field, field, rank::marker - index, found->from, found->to);
    }

    // Числа с единицами: питание и вода
    const auto isFoodIn = [&](const Chosen &state) {
        return explicitKind == "food" || (!explicitKind && state.nutrients > 0);
    };
    const auto isWaterIn = [&](const Chosen &state) { return explicitKind == "water" || state.slot("water"); };
    const When foodWhen = [&](const Chosen &state, const Candidate &) { return isFoodIn(state); };
    if (allowed.count("food") && explicitKind != "water") {
        offer("kcal", "kcal", rank::kcal, "(" + NUM + ")\\s*(?:" + words.kcal + ")", [&](const G &g, int, int) {
            CandidateValue v;
            v.nutrient = "kcal";
            v.amount = toNumber(g[1]);
            return std::optional<CandidateValue>(v);
        });
        const auto macroBody = [&](const std::string &names) {
            return "(?:" + names + ")\\s*(" + NUM + ")(?:\\s*(?:" + words.gram + "))?";
        };
        for (size_t index = 0; index < words.macros.size(); ++index) {
            const std::string nutrient = words.macros[index].second;
            offer(nutrient, nutrient, rank::macro - int(index), macroBody(words.macros[index].first),
                  [nutrient](const G &g, int, int) {
                      CandidateValue v;
                      v.nutrient = nutrient;
                      v.amount = toNumber(g[1]);
                      return std::optional<CandidateValue>(v);
                  });
        }
        // «f1», «c4» — обычные слова: одна буква с числом считается, когда признаков питания не меньше двух
        Entries<std::string> shortOnes;
        for (const auto &entry : words.shortMacros) {
            if (word(macroBody(entry.first)).test(lower)) shortOnes.push_back(entry);
        }
        const int shortCount = int(shortOnes.size());
        for (size_t index = 0; index < shortOnes.size(); ++index) {
            const std::string nutrient = shortOnes[index].second;
            offer("short-" + nutrient, nutrient, rank::shortMacro - int(index), macroBody(shortOnes[index].first),
                  [nutrient](const G &g, int, int) {
                      CandidateValue v;
                      v.nutrient = nutrient;
                      v.amount = toNumber(g[1]);
                      v.isShort = true;
                      return std::optional<CandidateValue>(v);
                  },
                  [shortCount](const Chosen &state, const Candidate &) { return state.regularNutrients + shortCount > 1; });
        }
    }
    offer("grams", "grams", rank::grams, "(" + NUM + ")\\s*(?:" + words.gram + ")", [&](const G &g, int, int) {
        CandidateValue v;
        v.amount = toNumber(g[1]);
        return std::optional<CandidateValue>(v);
    }, foodWhen);
    offer("meal", "meal", rank::meal, bodies(words.meals), [&](const G &g, int, int) {
        CandidateValue v;
        v.meal = lang.mealOf(g[0]);
        return std::optional<CandidateValue>(v);
    }, foodWhen);

    if (allowed.count("water") && (!explicitKind || explicitKind == "water")) {
        Match lead;
        const bool hasLead = lang.waterLead->exec(lower, 0, lead);
        const std::string volume = "(" + NUM + ")\\s*(?:(" + words.ml + ")|(" + words.glass + ")|(" + words.litre + "))";
        Match found;
        const bool hasFound = word(volume).exec(lower, 0, found);
        S rest = u"x";
        if (hasFound) {
            S tail = slice(lower, hasLead ? lead.end() : 0);
            const S body = found.str(lower, 2);
            const long at = indexOf(tail, body);
            if (at >= 0) tail.erase(size_t(at), body.size());
            rest = trim(tail);
        }
        // Вода — слово «вода» в начале либо один объём без других слов
        if (hasFound && (hasLead || explicitKind == "water" || rest.empty())) {
            const When isNotFood = [&](const Chosen &state, const Candidate &) { return !isFoodIn(state); };
            offer("water", "water", rank::water, volume, [&](const G &g, int, int) {
                CandidateValue v;
                v.amount = jsRound(toNumber(g[1]) * (g.truthy(2) ? 1 : g.truthy(3) ? kGlassMl : kMlInLitre));
                return std::optional<CandidateValue>(v);
            }, isNotFood);
            if (hasLead) push("waterLead", "kind", rank::waterLead, 0, lead.end(), {}, isNotFood);
        }
    }

    // Длительность: составная старше простой
    const auto isPlainIn = [&](const Chosen &state) { return !isFoodIn(state) && !isWaterIn(state); };
    const When plainWhen = [&](const Chosen &state, const Candidate &) { return isPlainIn(state); };
    offer("minutes", "minutes", rank::durationHalf, "(" + words.hourAndHalf + ")|(?:" + words.halfHour + ")",
          [&](const G &g, int, int) {
              CandidateValue v;
              v.minutes = g.truthy(1) ? 90 : 30;
              return std::optional<CandidateValue>(v);
          }, plainWhen);
    const std::string hoursBody = "(" + NUM + ")\\s*(?:" + words.hour + ")(?:\\s*(\\d{1,2})" + lang.minutes + ")?";
    offer("minutes", "minutes", rank::durationHours, hoursBody, [&](const G &g, int, int) {
        CandidateValue v;
        v.minutes = jsRound(toNumber(g[1]) * kMinutesInHour) + (g.truthy(2) ? jsNumber(g[2]) : 0);
        return std::optional<CandidateValue>(v);
    }, plainWhen);
    offer("minutes", "minutes", rank::durationMinutes, "(\\d{1,4})" + lang.minutes, [&](const G &g, int, int) {
        CandidateValue v;
        v.minutes = jsNumber(g[1]);
        return std::optional<CandidateValue>(v);
    }, plainWhen);

    // Время: диапазон старше одного значения, часы с минутами — голого часа
    const When notWaterWhen = [&](const Chosen &state, const Candidate &) { return !isWaterIn(state); };
    const std::string clock = "(" + HOUR + ")(?::(" + MINUTE + "))?(?:\\s*(" + lang.daypart + "))?";
    const auto repeatZones = matchZones(
        word("(?:" + words.every + "|" + words.oncePer + ")\\s+(?:" + lang.count + ")\\s+(?:" + bodies(words.units) + ")"),
        lower);
    // Уточнение после часа сильнее уточнения перед ним: «вечером в 7», «в 7 вечера»
    const auto daypartIn = [&](const G &g, int after, int before) -> std::optional<std::string> {
        if (g.truthy(after)) return lang.daypartOf(g[after]);
        if (g.truthy(before)) return lang.daypartLeadOf(g[before]);
        return std::nullopt;
    };
    const std::string rangeBody = "(?:(" + words.from + ")\\s+)?" + clock + "\\s*(?:" + DASH + "|" + words.to + ")\\s*"
        + clock;
    offer("time", "time", rank::timeRange, rangeBody, [&](const G &g, int, int) -> std::optional<CandidateValue> {
        const auto fromPart = g.truthy(4) ? lang.daypartOf(g[4]) : std::nullopt;
        const auto toPart = g.truthy(7) ? lang.daypartOf(g[7]) : std::nullopt;
        // «10-12» без «с», без минут и без уточнения — не время (счёт, номер, диапазон чего угодно)
        if (!g.truthy(1) && !g.has(3) && !g.has(6) && !fromPart && !toPart) return std::nullopt;
        auto from = resolveHour(jsNumber(g[2]), g.truthy(3) ? jsNumber(g[3]) : 0, fromPart);
        const auto to = resolveHour(jsNumber(g[5]), g.truthy(6) ? jsNumber(g[6]) : 0, toPart);
        if (!from || !to) return std::nullopt;
        // «5-6pm»: уточнение конца относится и к началу, если начало при этом остаётся раньше конца
        if (!fromPart && toPart) {
            const auto same = resolveHour(jsNumber(g[2]), g.truthy(3) ? jsNumber(g[3]) : 0, toPart);
            if (same && *same < *to) from = same;
        }
        CandidateValue v;
        v.start = from;
        v.end = to;
        return v;
    }, notWaterWhen);
    const std::string clockBody = lang.daypartLead + "(?:(?:" + words.at + ")\\s+)?(" + HOUR + "):(" + MINUTE
        + ")(?:\\s*(" + lang.daypart + "))?";
    offer("time", "time", rank::timeClock, clockBody, [&](const G &g, int from, int to) -> std::optional<CandidateValue> {
        const auto part = daypartIn(g, 4, 1);
        const double hour = jsNumber(g[2]);
        const double minute = jsNumber(g[3]);
        // Разговорные часы двенадцатичасовые: вторая половина суток — другое чтение
        bool loose = false;
        for (const auto &edit : edits) loose = loose || (edit.isLoose.value_or(false) && edit.from >= from && edit.to <= to);
        CandidateValue v;
        if (!part && loose) {
            const double start = resolveLooseClock(hour, minute, ctx);
            v.start = start;
            v.altStart = std::fmod(start + kDayMinutes / 2, kDayMinutes);
            return v;
        }
        const auto start = resolveHour(hour, minute, part);
        if (!start) return std::nullopt;
        v.start = start;
        return v;
    }, notWaterWhen);
    const std::string hourBody = lang.daypartLead + "(?:(" + words.at + ")\\s+)?(" + HOUR + ")(?![.:,]\\d)(?:\\s*("
        + lang.daypart + "))?";
    offer("time", "time", rank::timeHour, hourBody, [&](const G &g, int from, int to) -> std::optional<CandidateValue> {
        // Голый час — только с предлогом («в 5») либо с уточнением, понятным без него («5pm»)
        if (!g.truthy(2) && !(g.truthy(4) && lang.isBareDaypart && lang.isBareDaypart->test(g[4]))) return std::nullopt;
        // «раз в 2 недели», «once in 2 weeks»: число принадлежит повтору
        for (const auto &zone : repeatZones) {
            if (zone.from < to && from < zone.to) return std::nullopt;
        }
        const auto part = daypartIn(g, 4, 1);
        const double hour = jsNumber(g[3]);
        CandidateValue v;
        if (part) {
            const auto start = resolveHour(hour, 0, part);
            if (!start) return std::nullopt;
            v.start = start;
            return v;
        }
        // «в 7» — утро либо вечер: выбор по окну дня, другое чтение остаётся вариантом
        const double start = resolveBareHour(hour, ctx);
        const bool isAmbiguous = hour >= 1 && hour < 12;
        v.start = start;
        if (isAmbiguous) v.altStart = std::fmod(start + kDayMinutes / 2, kDayMinutes);
        return v;
    }, notWaterWhen);
    if (!words.namedTimes.empty()) {
        offer("time", "time", rank::timeNamed, "(?:(?:" + words.at + ")\\s+)?(" + bodies(words.namedTimes) + ")",
              [&](const G &g, int, int) -> std::optional<CandidateValue> {
                  const auto start = lang.namedTimeOf(g[1]);
                  if (!start) return std::nullopt;
                  CandidateValue v;
                  v.start = start;
                  return v;
              }, notWaterWhen);
    }

    // Повтор
    const std::string units = bodies(words.units);
    const auto repeatKindIn = [&](const Chosen &state) -> std::optional<std::string> {
        const Candidate *kind = state.slot("repeatKind");
        if (kind && kind->value.repeatKind && !kind->value.repeatKind->empty()) return kind->value.repeatKind;
        return state.slot("weekdays") ? std::optional<std::string>("weekly") : std::nullopt;
    };
    const When hasRepeatWhen = [&](const Chosen &state, const Candidate &) {
        return isPlainIn(state) && repeatKindIn(state).has_value();
    };
    // Дни недели — только у еженедельного повтора
    const When weeklyWhen = [&](const Chosen &state, const Candidate &) {
        const Candidate *kind = state.slot("repeatKind");
        const auto value = kind ? kind->value.repeatKind : std::nullopt;
        return isPlainIn(state) && (!value || value->empty() || *value == "weekly");
    };
    const Read everyRead = [&](const G &g, int, int) {
        CandidateValue v;
        v.repeatKind = lang.unitOf(g[2]);
        v.interval = lang.countOf(g.opt(1));
        return std::optional<CandidateValue>(v);
    };
    offer("repeatKind", "repeat", rank::repeatEvery,
          "(?:" + words.every + ")\\s+(?:(" + lang.count + ")\\s+)?(" + units + ")", everyRead, plainWhen);
    offer("repeatKind", "repeat", rank::repeatAdverb, bodies(words.adverbs), [&](const G &g, int, int) {
        CandidateValue v;
        v.repeatKind = lang.adverbOf(g[0]);
        return std::optional<CandidateValue>(v);
    }, plainWhen);
    offer("repeatKind", "repeat", rank::repeatOnce,
          "(?:" + words.oncePer + ")\\s+(?:(" + lang.count + ")\\s+)?(" + units + ")", everyRead, plainWhen);
    offer("weekdays", "repeat", rank::repeatWorkdays, words.workdays, [](const G &, int, int) {
        CandidateValue v;
        v.days = std::vector<int>{1, 2, 3, 4, 5};
        return std::optional<CandidateValue>(v);
    }, weeklyWhen);
    offer("weekdays", "repeat", rank::repeatWeekends, words.weekends, [](const G &, int, int) {
        CandidateValue v;
        v.days = std::vector<int>{6, 0};
        return std::optional<CandidateValue>(v);
    }, weeklyWhen);
    const std::string dayList = "(?:" + lang.weekday + ")(?:" + lang.listSeparator + "(?:" + lang.weekday + "))*";
    offer("weekdays", "repeat", rank::repeatDays, "(?:(" + words.every + "|" + words.on + ")\\s+)?(" + dayList + ")",
          [&](const G &g, int, int) -> std::optional<CandidateValue> {
              const auto names = splitRe(*lang.listSplit, g[2]);
              // «каждый вторник», «по вт»; «on friday» — дата, «on mon and wed» — повтор
              const bool isRepeat = g.truthy(1)
                  ? (lang.isEvery->test(g[1]) || words.isOnAlwaysRepeat || names.size() > 1) : false;
              // «mondays 19:00» — повтор и без предлога
              bool isPlural = false;
              for (const auto &name : names) isPlural = isPlural || (lang.isPluralWeekday && lang.isPluralWeekday->test(name));
              if (!isRepeat && !isPlural) return std::nullopt;
              std::vector<int> days;
              for (const auto &name : names) {
                  const int day = lang.weekdayOf(name).value_or(-1);
                  if (std::find(days.begin(), days.end(), day) == days.end()) days.push_back(day);
              }
              CandidateValue v;
              v.days = days;
              return v;
          }, weeklyWhen);
    // «N мес / N раз / до <дата>» — граница ряда, только когда повтор найден; иначе «до <дата>» — срок
    const std::string untilBody = "(?:" + words.until + ")\\s+(" + lang.date + "|" + lang.month + ")";
    const auto readDate = [&](const S &value) -> std::optional<CandidateValue> {
        const auto day = resolveDate(value, ctx.today, lang);
        if (!day) return std::nullopt;
        // Другое чтение: день недели — сегодня, а не через неделю; дата без года — в этом году, хотя прошла
        const auto altDay = resolveDate(value, ctx.today, lang, true);
        CandidateValue v;
        v.day = day;
        if (altDay != day) v.altDay = altDay;
        return v;
    };
    const bool isOpen = ctx.pick && ctx.pick->repeat == std::string(kQuickRepeatOpen);
    if (!isOpen) {
        offer("repeatEnd", "repeat", rank::repeatEnd, untilBody, [&](const G &g, int, int) { return readDate(g[1]); },
              hasRepeatWhen);
    }
    offer("repeatCount", "repeat", rank::repeatCount, "(\\d{1,3})\\s*(?:" + words.times + ")", [&](const G &g, int, int) {
        CandidateValue v;
        v.count = jsNumber(g[1]);
        return std::optional<CandidateValue>(v);
    }, hasRepeatWhen);
    const std::string spanLead = !words.spanLead.empty() ? "(?:(?:" + words.spanLead + ")\\s+)?" : "";
    offer("repeatSpan", "repeat", rank::repeatSpan, spanLead + "(\\d{1,2})\\s*(" + bodies(words.spans) + ")",
          [&](const G &g, int, int) {
              const double amount = jsNumber(g[1]);
              const auto unit = lang.spanOf(g[2]);
              CandidateValue v;
              if (unit == "week") v.weeks = amount;
              else v.months = unit == "month" ? amount : amount * 12;
              return std::optional<CandidateValue>(v);
          }, hasRepeatWhen);

    // Срок и дата: «до пт» как срок старше «пт» как дня
    offer("due", "due", rank::due, untilBody, [&](const G &g, int, int) { return readDate(g[1]); }, plainWhen);
    offer("day", "day", rank::day, "(?:(?:" + words.dayLead + ")\\s+)?(" + lang.date + ")",
          [&](const G &g, int, int) -> std::optional<CandidateValue> {
              auto value = readDate(g[1]);
              if (!value) return std::nullopt;
              const auto weekday = weekdayIn(g[1], lang);
              if (!weekday) return value;
              // «sat down» — не суббота: такое сокращение без предлога — день только в конце строки, перед
              // числом или перед уже распознанным значением
              value->weekday = weekday;
              value->isWeak = g[0] == g[1] && lang.isWeakWeekday && lang.isWeakWeekday->test(g[1]);
              return value;
          },
          [&](const Chosen &state, const Candidate &self) {
              if (isWaterIn(state)) return false;
              if (!self.value.weekday) return true;
              // «1000 Вт» — не вторник: день недели сразу после числа, не распознанного как значение, — не день
              const int before = int(trimEnd(slice(lower, 0, self.from)).size()) - 1;
              if (before >= 0 && lower[size_t(before)] >= u'0' && lower[size_t(before)] <= u'9'
                  && !state.taken[size_t(before)]) {
                  return false;
              }
              if (self.value.isWeak) {
                  const int found = search(rx("\\S"), slice(lower, self.to));
                  const int after = self.to + found;
                  if (after >= self.to && !state.taken[size_t(after)]) {
                      const char16_t c = lower[size_t(after)];
                      const bool ok = (c >= u'0' && c <= u'9') || c == u',' || c == u';' || c == u'.' || c == u'!'
                          || c == u'?' || c == u')';
                      if (!ok) return false;
                  }
              }
              return true;
          });

    // «до <дата>» при повторе прочитано не как конец ряда (выбор пользователя): слова остаются в названии —
    // ни срок, ни день их не забирают
    const auto openZones = isOpen ? matchZones(word(untilBody), lower) : std::vector<Zone>{};
    std::vector<Candidate> offered = pool;
    if (!openZones.empty()) {
        for (auto &item : offered) {
            bool isInside = false;
            if (item.slot == "due" || item.slot == "day") {
                for (const auto &zone : openZones) isInside = isInside || (zone.from < item.to && item.from < zone.to);
            }
            if (!isInside) continue;
            const When inner = item.when;
            item.when = [&, inner](const Chosen &state, const Candidate &self) {
                return !repeatKindIn(state) && (!inner || inner(state, self));
            };
            item.id = nextId++;
        }
    }
    const std::vector<Candidate> candidates = pinCandidates(offered, ctx.pick, nextId);

    // ── выбор ──────────────────────────────────────────────────────────────────
    // Условия зависят от выбранного, а выбранное — от условий: выбор повторяется, пока набор не перестанет
    // меняться
    auto state = std::make_unique<Chosen>();
    chosenState(*state, {}, length);
    for (int round = 0; round < kMaxPickRounds; ++round) {
        std::vector<Candidate> eligible;
        for (const auto &item : candidates) {
            if (!item.when || item.when(*state, item)) eligible.push_back(item);
        }
        auto chosen = pickCandidates(eligible);
        bool same = chosen.size() == state->items.size();
        for (size_t i = 0; same && i < chosen.size(); ++i) same = chosen[i].id == state->items[i].id;
        auto next = std::make_unique<Chosen>();
        chosenState(*next, std::move(chosen), length);
        state = std::move(next);
        if (same) break;
    }
    const bool isFood = isFoodIn(*state);
    const bool isWater = isWaterIn(*state);
    std::vector<Candidate> picked = state->items;
    const auto valueOf = [&](const std::string &slot) -> const CandidateValue * {
        for (const auto &item : picked) {
            if (item.slot == slot) return &item.value;
        }
        return nullptr;
    };

    // ── значения выбранных кандидатов ──────────────────────────────────────────
    std::map<std::string, double> nutrients;
    std::map<std::string, bool> nutrientSet;
    // Однобуквенное обозначение разбирается после полного и потому сильнее его
    for (const bool isShort : {false, true}) {
        for (const auto &item : picked) {
            if (item.value.nutrient && item.value.isShort == isShort) {
                nutrients[*item.value.nutrient] = item.value.amount.value_or(NAN);
            }
        }
    }
    if (const auto *v = valueOf("grams")) draft.grams = v->amount;
    if (const auto *v = valueOf("meal")) draft.meal = v->meal;
    if (const auto *v = valueOf("water")) draft.waterMl = v->amount;
    if (const auto *v = valueOf("minutes")) draft.minutes = v->minutes;
    const auto *time = valueOf("time");
    const std::optional<double> start = time ? time->start : std::nullopt;
    const std::optional<double> end = time ? time->end : std::nullopt;
    const auto *weekdaysValue = valueOf("weekdays");
    std::optional<std::vector<int>> weekdays = weekdaysValue ? weekdaysValue->days : std::nullopt;
    const auto repeatKind = repeatKindIn(*state);
    const auto *kindValue = valueOf("repeatKind");
    const double interval = kindValue && kindValue->interval ? *kindValue->interval : 1;
    std::optional<std::string> endDay = valueOf("repeatEnd") ? valueOf("repeatEnd")->day : std::nullopt;
    const std::optional<double> count = valueOf("repeatCount") ? valueOf("repeatCount")->count : std::nullopt;
    const auto *spanValue = valueOf("repeatSpan");
    const double spanMonths = spanValue && truthy(spanValue->months) ? *spanValue->months : 0;
    const double spanWeeks = spanValue && truthy(spanValue->weeks) ? *spanValue->weeks : 0;
    if (const auto *v = valueOf("due")) draft.due = v->day;
    std::optional<std::string> day = valueOf("day") ? valueOf("day")->day : std::nullopt;
    const std::optional<int> namedWeekday = valueOf("day") ? valueOf("day")->weekday : std::nullopt;

    const auto settle = [&]() {
        std::fill(taken.begin(), taken.end(), false);
        spans.clear();
        for (const auto &item : picked) {
            for (int i = std::max(0, item.from); i < std::min<int>(item.to, int(length)); ++i) taken[size_t(i)] = true;
            spans.push_back({item.field, item.from, item.to});
        }
    };
    const auto unmark = [&](const std::vector<std::string> &fields) {
        std::vector<Candidate> next;
        for (const auto &item : picked) {
            if (std::find(fields.begin(), fields.end(), item.field) == fields.end()) next.push_back(item);
        }
        picked = std::move(next);
        settle();
    };
    const auto markerText = [&](const std::string &field) -> std::optional<S> {
        for (const auto &span : spans) {
            if (span.field == field) return slice(text, span.from + 1, span.to);
        }
        return std::nullopt;
    };
    settle();

    // ── тип задачи либо события; метки, которые ему не положены ───────────────
    const auto blank = [&]() {
        S marked = text;
        for (size_t i = 0; i < marked.size(); ++i) {
            if (taken[i]) marked[i] = u' ';
        }
        return restoreNumerals(marked, edits);
    };
    const bool hasTime = start.has_value();
    std::optional<QuickLearnedEntry> learned;
    // Другие чтения: второе значение выбранного кандидата и кандидаты того же поля, которым не хватило места
    std::vector<QuickAlt> alternatives;
    const auto suggest = [&](const std::string &field, const std::optional<std::string> &pick,
                             const std::optional<std::string> &altDay = std::nullopt) {
        bool isKnown = false;
        int inField = 0;
        for (const auto &item : alternatives) {
            if (item.field == field && pick && item.pick == *pick) isKnown = true;
            if (item.field == field) ++inField;
        }
        if (pick && !pick->empty() && !isKnown && inField < kMaxAlternatives) {
            alternatives.push_back({field, *pick, altDay && !altDay->empty() ? altDay : std::nullopt});
        }
    };
    for (const auto &slot : kPickSlots) {
        const Candidate *winner = nullptr;
        for (const auto &item : picked) {
            if (item.slot == slot) {
                winner = &item;
                break;
            }
        }
        if (!winner) continue;
        const auto current = valueKey(slot, winner->value);
        const auto other = altKey(slot, winner->value);
        if (other != current) suggest(slot, other);
        // Закрепление оставляет в слоте одного кандидата — остальные берутся из полного набора. Из
        // пересекающихся остаётся лучший: диапазон, а не два его времени
        std::vector<Candidate> spare;
        for (const auto &item : offered) {
            if (item.slot != slot || (item.when && !item.when(*state, item))) continue;
            bool overlaps = false;
            for (const auto &taker : picked) overlaps = overlaps || (taker.from < item.to && item.from < taker.to);
            if (overlaps) continue;
            Candidate copy = item;
            copy.slot.clear();
            spare.push_back(copy);
        }
        for (const auto &item : pickCandidates(spare)) {
            const auto key = valueKey(slot, item.value);
            if (key != current) suggest(slot, key);
        }
    }
    // «до <дата>» при повторе — конец ряда; другое чтение — слова названия
    if (valueOf("repeatEnd")) {
        suggest("repeat", std::string(kQuickRepeatOpen));
    } else if (repeatKind && !openZones.empty()) {
        for (const auto &zone : openZones) {
            const G g{&zone.match, &lower, 2};
            const auto closed = readDate(g[1]);
            if (closed && closed->day && !closed->day->empty()) {
                suggest("repeat", std::string(kQuickRepeatEnd), closed->day);
                break;
            }
        }
    }
    const auto valueDay = valueOf("day");
    if (isWater || isFood) {
        unmark(kMarkerFields);
    } else {
        // Первое слово названия считается до возврата меток: «#дом купить молоко» — «купить»
        const auto head = headWord(blank(), lang);
        if (head) draft.head = toUtf8(*head);
        if (draft.head && ctx.learned) {
            const auto it = ctx.learned->find(*draft.head);
            if (it != ctx.learned->end()) learned = it->second;
        }
        const std::string guessed = hasTime && allowed.count("event") ? "event" : "task";
        draft.kind = explicitKind == "task" || explicitKind == "event" ? *explicitKind : guessed;
        if (!allowed.count(draft.kind)) draft.kind = allowed.count("task") ? "task" : "event";
        // Тип, выученный по правкам: когда пользователь не выбрал тип сам и не снял выученный
        if (!explicitKind && learned && learned->kind && !learned->kind->empty() && *learned->kind != draft.kind
            && allowed.count(*learned->kind) && !skipped("kind")) {
            draft.kind = *learned->kind;
            draft.learned = std::vector<std::string>{"kind"};
        }
        // У события нет статуса: «!» остаётся в названии; «#группа» — и у события
        if (draft.kind == "event") unmark({"important"});
        // Событие либо задача: разбор выбрал сам — другое чтение остаётся вариантом
        const std::string otherKind = draft.kind == "event" ? "task" : "event";
        const bool isDated = hasTime || valueDay || repeatKind;
        if (!explicitKind && allowed.count(otherKind) && (draft.kind == "event" || isDated)) suggest("kind", otherKind);
        if (const auto list = markerText("list")) {
            S value = *list;
            for (auto &c : value) {
                if (c == u'_') c = u' ';
            }
            draft.list = toUtf8(value);
        }
        if (const auto place = markerText("place")) draft.place = toUtf8(*place);
        for (const auto &span : spans) {
            if (span.field == "important") draft.isImportant = true;
        }
    }

    if (!alternatives.empty()) draft.alternatives = alternatives;

    // ── название: всё непомеченное, в словах пользователя ─────────────────────
    const S plain = blank();
    draft.name = toUtf8(cleanName(plain));
    const auto byFrom = [](const QuickSpan &a, const QuickSpan &b) { return a.from < b.from; };
    std::stable_sort(spans.begin(), spans.end(), byFrom);
    S mealText;
    for (const auto &span : spans) {
        if (span.field == "meal") {
            mealText = slice(text, span.from, span.to);
            break;
        }
    }
    if (!edits.empty()) {
        for (auto &span : spans) {
            span.from = toSourceOffset(span.from, edits);
            span.to = toSourceOffset(span.to, edits, true);
        }
    }

    // ── вода и еда ────────────────────────────────────────────────────────────
    if (isWater) {
        draft.kind = "water";
        draft.day = ctx.today;
        if (!draft.waterMl) draft.error = "name";
        draft.spans = spans;
        return draft;
    }
    if (isFood) {
        draft.kind = "food";
        draft.day = day ? *day : ctx.today;
        if (!draft.meal || draft.meal->empty()) draft.meal = mealByTime(start ? *start : ctx.nowMinutes);
        if (start && *start < kDayMinutes) draft.start = toTime(*start);
        if (!nutrients.count("kcal")) {
            const bool any = nutrients.count("protein") || nutrients.count("fat") || nutrients.count("carbs");
            if (any) {
                const auto get = [&](const char *key) {
                    const auto it = nutrients.find(key);
                    return it == nutrients.end() || std::isnan(it->second) ? 0.0 : it->second;
                };
                nutrients["kcal"] = jsRound(get("protein") * 4 + get("fat") * 9 + get("carbs") * 4);
            }
        }
        draft.nutrients = nutrients;
        if (draft.name.empty()) draft.name = toUtf8(mealText);
        if (draft.name.empty()) draft.error = "name";
        draft.spans = spans;
        return draft;
    }

    // ── задача либо событие: название и описание ──────────────────────────────
    const auto split = skipped("description") ? std::nullopt : splitName(plain, fold(plain), lang);
    if (split) {
        draft.name = toUtf8(split->name);
        draft.description = toUtf8(split->description);
        spans.push_back({"description", split->from + search(rx("\\S"), slice(plain, split->from)),
                         int(trimEnd(plain).size())});
        std::stable_sort(spans.begin(), spans.end(), byFrom);
    }
    if ((!day || day->empty()) && (hasTime || draft.kind == "event") && !repeatKind) {
        day = hasTime && *start <= ctx.nowMinutes ? addDays(ctx.today, 1) : ctx.today;
        draft.isDayAssumed = true;
    }

    if (repeatKind) {
        const std::string base = day && !day->empty() ? *day : ctx.today;
        if (*repeatKind == "weekly" && !weekdays) {
            weekdays = std::vector<int>{namedWeekday ? *namedWeekday : weekdayOfKey(base)};
        }
        // Начало ряда — первый подходящий день не раньше названной даты
        std::string startDay = base;
        if (*repeatKind == "weekly") {
            std::vector<std::string> starts;
            for (const int weekday : *weekdays) starts.push_back(nextWeekday(base, weekday, true));
            std::sort(starts.begin(), starts.end());
            startDay = starts[0];
        }
        if ((!endDay || endDay->empty()) && spanMonths) endDay = addMonths(startDay, (long long)spanMonths);
        if ((!endDay || endDay->empty()) && spanWeeks) endDay = addDays(startDay, (long long)(spanWeeks * kDaysInWeek));
        Repeat repeat;
        repeat.kind = *repeatKind;
        repeat.interval = int(interval);
        if (*repeatKind == "weekly") {
            std::vector<int> sorted = *weekdays;
            std::stable_sort(sorted.begin(), sorted.end());
            repeat.weekdays = sorted;
        }
        repeat.startDay = startDay;
        if (endDay && !endDay->empty()) repeat.endDay = endDay;
        if (count) repeat.count = int(*count);
        draft.repeat = repeat;
        day = startDay;
    }
    draft.day = day && !day->empty() ? day : std::nullopt;

    if (draft.kind == "event") {
        if (hasTime) {
            // Обычная длительность — по первому слову НАЗВАНИЯ: «вт 15:00 пара по английскому» — пара,
            // «сдать пару отчётов 9:00» — нет
            const S head = foldYo(jsLower(fromUtf8(draft.name)));
            std::optional<double> usual;
            for (const auto &[pattern, minutes] : lang.eventMinutes) {
                if (pattern->test(head)) {
                    usual = minutes;
                    break;
                }
            }
            if (!truthy(usual) && !end && !truthy(draft.minutes)) {
                // Слово-мера в конце названия: длительность берётся по нему, а само слово из названия уходит
                for (const auto &[pattern, minutes] : lang.eventMinutesTail) {
                    Match m;
                    if (!pattern->test(head)) continue;
                    pattern->exec(head, 0, m);
                    const int restLength = m.has(1) ? m.stop(1) - m.start(1) : 0;
                    const S rest = trim(slice(fromUtf8(draft.name), 0, restLength));
                    if (!rest.empty()) {
                        usual = minutes;
                        draft.name = toUtf8(rest);
                    }
                    break;
                }
            }
            if (!truthy(usual)) usual = kDefaultEventMins;
            // Длительность, выученная по правкам, — только когда она не названа и её чип не снят
            const bool isNamed = end.has_value() || truthy(draft.minutes);
            const std::optional<double> learnedMinutes = learned ? learned->minutes : std::nullopt;
            const std::optional<double> own = !isNamed && !skipped("minutes") && learnedMinutes != usual
                ? learnedMinutes : std::nullopt;
            if (truthy(own)) {
                auto list = draft.learned.value_or(std::vector<std::string>{});
                list.push_back("minutes");
                draft.learned = list;
            }
            draft.usualMinutes = usual;
            const double finish = end ? *end
                                      : *start + (truthy(draft.minutes) ? *draft.minutes : truthy(own) ? *own : *usual);
            draft.start = toTime(*start);
            // Ровно полночь — последняя минута суток; позже — ошибка, а не обрезка
            if (finish == kDayMinutes) draft.end = "23:59";
            else if (finish < kDayMinutes) draft.end = toTime(finish);
            if (end) draft.minutes = *end - *start;
        } else {
            draft.isAllDay = true;
        }
        draft.due = std::nullopt;
        const bool allDay = draft.isAllDay.value_or(false);
        if (!allDay && !draft.end) {
            draft.error = "time";
        } else {
            draft.error = validateEvent(draft.name, draft.start.value_or("00:00"), draft.end.value_or("23:59"), allDay,
                                        draft.repeat ? std::nullopt : draft.day, draft.repeat);
        }
        draft.spans = spans;
        return draft;
    }

    if (hasTime) {
        draft.start = toTime(*start);
        draft.minutes = end ? *end - *start : (draft.minutes ? *draft.minutes : kQuickTaskMinutes);
    }
    if (draft.repeat) draft.due = std::nullopt;
    draft.error = validateTask(draft);
    if (!draft.error && draft.repeat) draft.error = validateRepeat(*draft.repeat);
    draft.spans = spans;
    return draft;
}

// Сколько распознано: помеченные участки; запись здоровья, еды или воды без ошибки — ещё одно
size_t recognisedCount(const QuickDraft &draft) {
    const bool isPlain = draft.kind == "task" || draft.kind == "event";
    return draft.spans.size() + (!isPlain && !draft.error ? 1 : 0);
}

// Строка проходит правку опечаток и замену числительных цифрами, затем разбор
QuickDraft parseLine(const S &typed, const QuickContext &ctx, const Lang &lang) {
    const auto rewrite = rewriteNumerals(fixTypos(typed, lang), lang.id == "ru" ? NumeralLang::Ru : NumeralLang::En);
    return parseText(rewrite.text, rewrite.edits, ctx, lang);
}

// Язык разбора: строка без букв либо с буквами одного языка словаря разбирается этим языком (без букв —
// языком интерфейса); смешанная — обоими словарями, берётся разбор, распознавший больше; при равенстве —
// язык интерфейса
QuickDraft parseMasked(const S &text, const QuickContext &ctx) {
    const std::string lang = ctx.lang && !ctx.lang->empty() ? *ctx.lang : "ru";
    const std::string other = lang == "ru" ? "en" : "ru";
    const bool hasRu = rx("[а-яё]", "i").test(text);
    const bool hasEn = rx("[a-z]", "i").test(text);
    const bool hasOwn = lang == "ru" ? hasRu : hasEn;
    const bool hasOther = lang == "ru" ? hasEn : hasRu;
    if (!hasOther) return parseLine(text, ctx, langOf(lang));
    if (!hasOwn) return parseLine(text, ctx, langOf(other));
    QuickDraft own = parseLine(text, ctx, langOf(lang));
    QuickDraft foreign = parseLine(text, ctx, langOf(other));
    return recognisedCount(foreign) > recognisedCount(own) ? foreign : own;
}

json num(double v) {
    if (std::isnan(v) || std::isinf(v)) return nullptr;
    if (std::floor(v) == v && std::fabs(v) < 9007199254740992.0) return (long long)v;
    return v;
}

} // namespace

QuickDraft parseQuickInput(const std::string &typedUtf8, const QuickContext &ctx) {
    const auto masked = maskNameLinks16(fromUtf8(typedUtf8));
    const S &linked = masked.text;
    const auto remind = has(ctx.skip, "remind") ? std::nullopt : findRemind(linked);
    // Слова напоминания закрыты пробелами той же длины: участки остальных полей остаются на местах
    S text = linked;
    if (remind) {
        for (int i = remind->from; i < remind->to; ++i) text[size_t(i)] = u' ';
    }
    QuickDraft draft = parseMasked(text, ctx);
    if (remind && (draft.kind == "task" || draft.kind == "event")) {
        draft.remind = remind->minutes;
        draft.spans.push_back({"remind", remind->from, remind->to});
        std::stable_sort(draft.spans.begin(), draft.spans.end(),
                         [](const QuickSpan &a, const QuickSpan &b) { return a.from < b.from; });
    }
    if (masked.links.empty()) return draft;
    draft.name = toUtf8(unmaskNameLinks16(fromUtf8(draft.name), masked.links));
    if (draft.description && !draft.description->empty()) {
        draft.description = toUtf8(unmaskNameLinks16(fromUtf8(*draft.description), masked.links));
    }
    return draft;
}

std::string getQuickLang(const std::optional<std::string> &code) {
    if (!code) return "en";
    const S lower = jsLower(fromUtf8(*code));
    return lower.rfind(u"ru", 0) == 0 ? "ru" : "en";
}

double quickUsualMinutes(const std::string &name, const std::string &lang) {
    const S head = foldYo(jsLower(maskNameLinks16(fromUtf8(name)).text));
    for (const auto &[pattern, minutes] : langOf(lang == "ru" ? "ru" : "en").eventMinutes) {
        if (pattern->test(head)) return minutes ? minutes : kDefaultEventMins;
    }
    return kDefaultEventMins;
}

std::optional<std::string> quickDescription(const QuickDraft &draft) {
    std::vector<std::string> parts;
    if (draft.place && !draft.place->empty()) parts.push_back("@" + *draft.place);
    if (draft.description && !draft.description->empty()) parts.push_back(*draft.description);
    if (parts.empty()) return std::nullopt;
    std::string out = parts[0];
    for (size_t i = 1; i < parts.size(); ++i) out += "\n" + parts[i];
    return out;
}

json toJson(const QuickDraft &d) {
    json j = json::object();
    j["kind"] = d.kind;
    j["name"] = d.name;
    const auto str = [&](const char *key, const std::optional<std::string> &v) {
        if (v) j[key] = *v;
    };
    const auto number = [&](const char *key, const std::optional<double> &v) {
        if (v) j[key] = num(*v);
    };
    const auto flag = [&](const char *key, const std::optional<bool> &v) {
        if (v) j[key] = *v;
    };
    str("description", d.description);
    str("list", d.list);
    str("place", d.place);
    flag("isImportant", d.isImportant);
    number("remind", d.remind);
    str("day", d.day);
    flag("isDayAssumed", d.isDayAssumed);
    str("start", d.start);
    str("end", d.end);
    flag("isAllDay", d.isAllDay);
    number("minutes", d.minutes);
    str("due", d.due);
    if (d.repeat) {
        json r = {{"kind", d.repeat->kind}, {"interval", d.repeat->interval}, {"startDay", d.repeat->startDay}};
        if (d.repeat->weekdays) r["weekdays"] = *d.repeat->weekdays;
        if (d.repeat->monthDay) r["monthDay"] = *d.repeat->monthDay;
        if (d.repeat->endDay) r["endDay"] = *d.repeat->endDay;
        if (d.repeat->count) r["count"] = *d.repeat->count;
        j["repeat"] = r;
    }
    str("meal", d.meal);
    number("grams", d.grams);
    if (d.nutrients) {
        json n = json::object();
        for (const auto &[key, value] : *d.nutrients) n[key] = num(value);
        j["nutrients"] = n;
    }
    number("waterMl", d.waterMl);
    str("metric", d.metric);
    number("value", d.value);
    number("value2", d.value2);
    number("distanceKm", d.distanceKm);
    if (d.exercises) {
        json list = json::array();
        for (const auto &e : *d.exercises) {
            json x = {{"name", e.name}};
            if (e.sets) x["sets"] = num(*e.sets);
            if (e.reps) x["reps"] = num(*e.reps);
            if (e.weight) x["weight"] = num(*e.weight);
            list.push_back(x);
        }
        j["exercises"] = list;
    }
    if (d.goalChanges) {
        json goals = json::object();
        for (const auto &[key, value] : d.goalChanges->goals) goals[key] = num(value);
        json health = json::object();
        const auto &h = d.goalChanges->health;
        const auto put = [&](const char *key, const std::optional<double> &v) {
            if (v) health[key] = num(*v);
        };
        put("sugarMax", h.sugarMax);
        put("saltMax", h.saltMax);
        put("sleepMinutes", h.sleepMinutes);
        put("bedtime", h.bedtime);
        put("wakeTime", h.wakeTime);
        put("weight", h.weight);
        put("steps", h.steps);
        put("activeMinutes", h.activeMinutes);
        put("workouts", h.workouts);
        json g = {{"goals", goals}, {"health", health}};
        if (d.goalChanges->dayStart) g["dayStart"] = num(*d.goalChanges->dayStart);
        if (d.goalChanges->dayEnd) g["dayEnd"] = num(*d.goalChanges->dayEnd);
        if (d.goalChanges->budget) g["budget"] = num(*d.goalChanges->budget);
        j["goalChanges"] = g;
    }
    str("head", d.head);
    number("usualMinutes", d.usualMinutes);
    if (d.learned) j["learned"] = *d.learned;
    if (d.alternatives) {
        json list = json::array();
        for (const auto &a : *d.alternatives) {
            json x = {{"field", a.field}, {"pick", a.pick}};
            if (a.day) x["day"] = *a.day;
            list.push_back(x);
        }
        j["alternatives"] = list;
    }
    json spans = json::array();
    for (const auto &s : d.spans) spans.push_back({{"field", s.field}, {"from", s.from}, {"to", s.to}});
    j["spans"] = spans;
    str("error", d.error);
    return j;
}

QuickContext quickContextFromJson(const json &j) {
    QuickContext ctx;
    const auto text = [&](const char *key) -> std::optional<std::string> {
        const auto it = j.find(key);
        return it != j.end() && it->is_string() ? std::optional<std::string>(it->get<std::string>()) : std::nullopt;
    };
    const auto list = [&](const char *key) -> std::optional<std::vector<std::string>> {
        const auto it = j.find(key);
        if (it == j.end() || !it->is_array()) return std::nullopt;
        std::vector<std::string> out;
        for (const auto &v : *it) {
            if (v.is_string()) out.push_back(v.get<std::string>());
        }
        return out;
    };
    ctx.today = text("today").value_or("");
    ctx.nowMinutes = j.value("nowMinutes", 0.0);
    ctx.dayStart = j.value("dayStart", 540.0);
    ctx.dayEnd = j.value("dayEnd", 1260.0);
    ctx.kind = text("kind");
    ctx.kinds = list("kinds");
    ctx.skip = list("skip");
    ctx.lang = text("lang");
    if (const auto it = j.find("learned"); it != j.end() && it->is_object()) {
        QuickLearned learned;
        for (const auto &[key, value] : it->items()) {
            QuickLearnedEntry entry;
            if (value.is_object()) {
                if (value.contains("kind") && value["kind"].is_string()) entry.kind = value["kind"].get<std::string>();
                if (value.contains("minutes") && value["minutes"].is_number()) {
                    entry.minutes = value["minutes"].get<double>();
                }
            }
            learned[key] = entry;
        }
        ctx.learned = learned;
    }
    if (const auto it = j.find("pick"); it != j.end() && it->is_object()) {
        QuickPick pick;
        const auto get = [&](const char *key) -> std::optional<std::string> {
            return it->contains(key) && (*it)[key].is_string() ? std::optional<std::string>((*it)[key].get<std::string>())
                                                               : std::nullopt;
        };
        pick.time = get("time");
        pick.day = get("day");
        pick.due = get("due");
        pick.repeat = get("repeat");
        ctx.pick = pick;
    }
    return ctx;
}
} // namespace parvane::sections::planner
