// Parvane fork (spec 029, T061): тесты подсказок ввода текстом — перенос случаев web `plannerQuickSuggest.test.ts`
// (строка из записи, источники, набранное, история и «Забыть», история в данных «Плана», окно под вид). Не
// перенесены: кэш разбора (C5) и замеры времени (кэша на desktop нет), хранилище устройства и вливание записи
// устройства (запасного пути нет).
#include <algorithm>
#include <cstdio>
#include <string>
#include <vector>

#include "parvane/sections/planner_quick.h"
#include "parvane/sections/planner_quick_suggest.h"

using namespace parvane::sections::planner;
using Strings = std::vector<std::string>;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name) {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}

static void printList(const Strings &list) {
    for (const auto &item : list) std::printf("      «%s»\n", item.c_str());
}

static void checkList(const Strings &got, const Strings &want, const std::string &name) {
    const bool ok = got == want;
    check(ok, name);
    if (!ok) {
        std::printf("    получено:\n");
        printList(got);
        std::printf("    ожидалось:\n");
        printList(want);
    }
}

static QuickContext ru() {
    QuickContext c;
    c.today = "2026-10-08";
    c.nowMinutes = 12 * 60;
    c.dayStart = 9 * 60;
    c.dayEnd = 21 * 60;
    c.lang = "ru";
    return c;
}

static QuickContext en() {
    auto c = ru();
    c.lang = "en";
    return c;
}

static const Strings EXAMPLES = {"созвон завтра 16:00 45 мин", "задача проверить работы до пт", "вода 500 мл"};

static QuickHistory history(const Strings &lines) {
    QuickHistory store;
    for (const auto &line : lines) {
        store = recordHistoryLine(store, line, lineKey(line, parseQuickInput(line, ru()), "ru")).history;
    }
    return store;
}

static QuickSuggestSources sources(QuickHistory h = {}, std::vector<Task> tasks = {}, std::vector<Event> events = {},
                                   Strings examples = EXAMPLES) {
    return QuickSuggestSources{std::move(h), std::move(tasks), std::move(events), std::move(examples)};
}

static int g_nextId = 0;

static Task task(const std::string &name) {
    ++g_nextId;
    Task t;
    t.id = "t" + std::to_string(g_nextId);
    t.name = name;
    t.rank = -g_nextId;
    return t;
}

static Event event(const std::string &name, const std::string &start, const std::string &end) {
    ++g_nextId;
    Event e;
    e.id = "e" + std::to_string(g_nextId);
    e.name = name;
    e.start = start;
    e.end = end;
    e.day = "2026-10-05";
    return e;
}

static Repeat weeklyRepeat(std::vector<int> weekdays, const std::string &startDay) {
    Repeat r;
    r.kind = "weekly";
    r.interval = 1;
    r.weekdays = std::move(weekdays);
    r.startDay = startDay;
    return r;
}

static Strings texts(const std::vector<QuickSuggestion> &list) {
    Strings out;
    for (const auto &item : list) out.push_back(item.text);
    return out;
}

static Strings texts(const std::vector<QuickCandidate> &list) {
    Strings out;
    for (const auto &item : list) out.push_back(item.text);
    return out;
}

static QuickLineRepeat weekly(std::vector<int> days, int interval = 1) {
    return QuickLineRepeat{"weekly", interval, std::move(days)};
}

static QuickLineRepeat every(const std::string &kind, int interval = 1) {
    return QuickLineRepeat{kind, interval, std::nullopt};
}

struct Row {
    QuickLineDraft draft;
    std::string line;
};

static QuickLineDraft ev(const std::string &name, std::optional<std::string> start, std::optional<std::string> end,
                         std::optional<QuickLineRepeat> repeat = std::nullopt, bool allDay = false,
                         std::optional<std::string> list = std::nullopt) {
    QuickLineDraft d;
    d.kind = "event";
    d.name = name;
    d.start = start;
    d.end = end;
    d.repeat = repeat;
    d.isAllDay = allDay;
    d.list = list;
    return d;
}

static QuickLineDraft tk(const std::string &name, std::optional<std::string> start = std::nullopt,
                         std::optional<double> minutes = std::nullopt,
                         std::optional<QuickLineRepeat> repeat = std::nullopt,
                         std::optional<std::string> list = std::nullopt) {
    QuickLineDraft d;
    d.kind = "task";
    d.name = name;
    d.start = start;
    d.minutes = minutes;
    d.repeat = repeat;
    d.list = list;
    return d;
}

static void checkRows(const std::vector<Row> &rows, const QuickContext &c) {
    const auto lang = *c.lang;
    for (const auto &[draft, line] : rows) {
        const auto made = draftToLine(draft, lang);
        bool ok = made == line;
        for (const auto &textValue : {line, draftToLine(draft, lang, true)}) {
            const auto parsed = parseQuickInput(textValue, c);
            ok = ok && !parsed.error && parsed.kind == draft.kind && parsed.name == draft.name
                && parsed.list == draft.list && parsed.isAllDay.value_or(false) == draft.isAllDay;
            if (!draft.isAllDay) ok = ok && parsed.start == draft.start;
            if (draft.kind == "event" && !draft.isAllDay) ok = ok && parsed.end == draft.end;
            if (draft.kind == "task") ok = ok && parsed.minutes == draft.minutes;
            if (draft.repeat) {
                ok = ok && parsed.repeat && parsed.repeat->kind == draft.repeat->kind
                    && parsed.repeat->interval == draft.repeat->interval && !parsed.repeat->endDay;
                if (draft.repeat->weekdays && parsed.repeat) {
                    auto want = *draft.repeat->weekdays;
                    std::sort(want.begin(), want.end());
                    ok = ok && parsed.repeat->weekdays == want;
                }
            } else {
                ok = ok && !parsed.repeat && (!parsed.day || parsed.isDayAssumed.value_or(false));
            }
        }
        check(ok, line);
        if (made != line) std::printf("    получено: «%s»\n", made.c_str());
    }
}

static void lines() {
    std::printf("строка из записи: разбор наоборот (русский)\n");
    checkRows({
        {ev("ОГЭ по информатике", "18:30", "20:15", weekly({1})), "ОГЭ по информатике пн 18:30 1 ч 45 мин каждую неделю"},
        {ev("созвон", "16:00", "16:30"), "созвон 16:00"},
        {ev("пара по английскому", "15:00", "16:45"), "пара по английскому 15:00"},
        {ev("доклад", "16:00", "16:45"), "доклад 16:00 45 мин"},
        {ev("Защита диплома", "10:00", "13:00"), "Защита диплома 10:00 3 ч"},
        {tk("купить хлеб"), "купить хлеб"},
        {tk("купить краску", std::nullopt, std::nullopt, std::nullopt, "Ремонт"), "купить краску #Ремонт"},
        {tk("заказать плитку", std::nullopt, std::nullopt, std::nullopt, "Ремонт кухни"),
         "заказать плитку #Ремонт_кухни"},
        {tk("разбор почты", "18:00", 30), "задача разбор почты 18:00"},
        {tk("разбор почты", "18:00", 50), "задача разбор почты 18:00 50 мин"},
        {tk("проверить работы", std::nullopt, 90), "проверить работы 1 ч 30 мин"},
        {ev("педсовет", std::nullopt, std::nullopt, std::nullopt, true), "событие педсовет"},
        {ev("зарядка", "07:30", "07:45", every("daily")), "зарядка 07:30 15 мин каждый день"},
        {ev("хор", "19:00", "20:00", weekly({3, 1})), "хор по пн, ср 19:00"},
        {ev("планёрка", "09:30", "10:30", weekly({1, 2, 3, 4, 5})), "планёрка по будням 09:30"},
        {tk("уборка", std::nullopt, std::nullopt, weekly({0, 6})), "уборка по выходным"},
        {ev("семинар", "12:00", "13:00", weekly({5}, 2)), "семинар пт 12:00 каждые 2 недели"},
        {ev("хор", "19:00", "20:00", weekly({1, 3}, 2)), "хор по пн, ср 19:00 каждые 2 недели"},
        {tk("оплатить интернет", std::nullopt, std::nullopt, every("monthly")), "оплатить интернет каждый месяц"},
        {tk("полить цветы", std::nullopt, std::nullopt, every("daily", 3)), "полить цветы каждые 3 дня"},
        {tk("проверить счётчики", std::nullopt, std::nullopt, every("monthly", 5)),
         "проверить счётчики каждые 5 месяцев"},
        {ev("техосмотр", std::nullopt, std::nullopt, every("yearly"), true), "событие техосмотр каждый год"},
    }, ru());
    std::printf("строка из записи: разбор наоборот (английский)\n");
    checkRows({
        {ev("Math exam prep", "18:30", "20:15", weekly({1})), "Math exam prep mon 18:30 1 h 45 min every week"},
        {ev("call", "16:00", "16:30"), "call 16:00"},
        {ev("Design review", "16:00", "16:45"), "Design review 16:00 45 min"},
        {tk("buy bread"), "buy bread"},
        {tk("paint the wall", std::nullopt, std::nullopt, std::nullopt, "Home repair"), "paint the wall #Home_repair"},
        {tk("review inbox", "18:00", 30), "task review inbox 18:00"},
        {tk("grade papers", std::nullopt, 90), "grade papers 1 h 30 min"},
        {ev("team offsite", std::nullopt, std::nullopt, std::nullopt, true), "event team offsite"},
        {ev("Standup", "10:00", "10:15", weekly({1, 2, 3, 4, 5})), "Standup on weekdays 10:00"},
        {ev("piano", "17:00", "18:00", weekly({2, 4})), "piano on tue, thu 17:00"},
        {ev("retro", "15:00", "16:00", weekly({5}, 2)), "retro fri 15:00 every 2 weeks"},
        {tk("feed the cat", std::nullopt, std::nullopt, every("daily", 3)), "feed the cat every 3 days"},
        {tk("pay rent", std::nullopt, std::nullopt, every("monthly")), "pay rent every month"},
        {ev("stretching", "07:30", "07:45", every("daily")), "stretching 07:30 15 min every day"},
    }, en());
    check(draftToLine(ev("созвон", "16:00", "16:30", weekly({1})), "ru", true) == "событие созвон по пн 16:00 30 мин",
          "полная запись (ru)");
    check(draftToLine(ev("call", "16:00", "16:30", weekly({1})), "en", true) == "event call every mon 16:00 30 min",
          "полная запись (en)");
    check(draftToLine(tk("купить кабель", std::nullopt, std::nullopt, std::nullopt, "1-й этаж"), "ru")
              == "купить кабель",
          "негодная метка не пишется");
    check(draftToLine(ev("педсовет", std::nullopt, std::nullopt, std::nullopt, true, "Школа"), "ru")
              == "событие педсовет #Школа",
          "группа события — меткой");
}

static void sourcesCases() {
    std::printf("подсказки: источники\n");
    {
        const auto list = buildSuggestions("", sources(), ru());
        bool ok = list.size() == EXAMPLES.size();
        for (size_t i = 0; ok && i < list.size(); ++i) ok = list[i].text == EXAMPLES[i] && list[i].source == "example";
        check(ok, "без истории и данных — примеры в своём порядке");
    }
    {
        const auto list = buildSuggestions(
            "", sources(history({"Созвон с Олей завтра 16:00", "вес 72,4", "купить  кабель"})), ru());
        checkList(texts(list), {"купить кабель", "вес 72,4", "Созвон с Олей завтра 16:00", EXAMPLES[0], EXAMPLES[1],
                                EXAMPLES[2]},
                  "набранные строки — свежие первыми, примеры добирают");
        check(!list.empty() && list[0].source == "history" && list.back().source == "example", "источники подсказок");
    }
    checkList(texts(buildSuggestions("", sources(history({"вода 250 мл", "вода 250 мл", "купить кабель"}), {}, {}, {}),
                                     ru())),
              {"вода 250 мл", "купить кабель"}, "частая строка выше свежей");
    checkList(texts(buildSuggestions(
                  "", sources(history({"летучка завтра 10:00 20 мин", "купить кабель", "летучка пт 10:00 20 мин"}), {},
                              {}, {}),
                  ru())),
              {"летучка пт 10:00 20 мин", "купить кабель"}, "один шаблон — одна подсказка, самая свежая");
    {
        QuickHistory broken;
        broken.tick = 2;
        broken.lines = {QuickHistoryLine{"завтра 15:00", 5, 2}};
        const auto list = buildSuggestions("", sources(broken, {}, {}, {"завтра 15:00", "вода 500 мл"}), ru());
        check(list.size() == 1 && list[0].text == "вода 500 мл" && list[0].source == "example",
              "строка с ошибкой разбора не предлагается");
    }
    {
        auto bread = task("купить хлеб");
        bread.day = "2026-10-07";
        auto report = task("сдать отчёт");
        report.due = "2026-10-09";
        report.project = "Работа";
        auto exam = event("ОГЭ по информатике", "18:30", "20:15");
        exam.day = std::nullopt;
        exam.repeat = weeklyRepeat({1}, "2026-09-07");
        exam.repeat->endDay = "2027-05-31";
        const auto list = buildSuggestions("", sources({}, {bread, report}, {exam, event("созвон", "16:00", "16:30")}, {}),
                                           ru());
        checkList(texts(list), {"сдать отчёт #Работа", "созвон 16:00", "купить хлеб",
                                "ОГЭ по информатике пн 18:30 1 ч 45 мин каждую неделю"},
                  "записи «Плана» — строки без даты");
        check(list.size() == 4 && list[0].source == "data", "источник data");
    }
    {
        auto again = event("Созвон", "16:00", "16:30");
        again.day = "2026-10-06";
        auto detached = event("доклад", "12:00", "13:00");
        detached.origin = Origin{"x", "2026-10-01"};
        checkList(texts(buildSuggestions("", sources({}, {}, {event("созвон", "16:00", "16:30"),
                                                              event("доклад", "12:00", "13:00"), again, detached}, {}),
                                         ru())),
                  {"Созвон 16:00", "доклад 12:00"}, "повторяющаяся запись выше разовой");
    }
    {
        const auto list = buildSuggestions(
            "", sources(history({"созвон завтра 16:00"}), {},
                        {event("созвон", "16:00", "16:30"), event("созвон", "16:00", "16:30"),
                         event("доклад", "12:00", "13:00")},
                        {}),
            ru());
        check(list.size() == 2 && list[0].text == "созвон завтра 16:00" && list[0].source == "history"
                  && list[1].text == "доклад 12:00" && list[1].source == "data",
              "запись, добавленная строкой истории, второй подсказки не даёт");
    }
    {
        auto matan = task("Матан 2");
        matan.repeat = weeklyRepeat({1}, "2026-09-07");
        const std::vector<Task> tasks = {task("встреча в 5"), task("отчёт до пт"), task("обед 520 ккал"), task("вес 72"),
                                         matan, task("купить молоко, хлеб"), task("позвонить — насчёт дачи"),
                                         task("первая строка\nвторая")};
        const std::vector<Event> events = {event("пара", "15:00", "16:00"), event("Физика пара", "10:00", "11:00")};
        const auto candidates = buildCandidates(sources({}, tasks, events, {}), ru());
        Strings names;
        for (const auto &t : tasks) names.push_back(t.name);
        for (const auto &e : events) names.push_back(e.name);
        bool ok = true;
        for (const auto &candidate : candidates) {
            const auto parsed = parseQuickInput(candidate.text, ru());
            ok = ok && !parsed.error && std::find(names.begin(), names.end(), parsed.name) != names.end()
                && candidate.text.find('\n') == std::string::npos;
        }
        check(ok, "строки кандидатов читаются той же записью");
        const auto got = texts(candidates);
        bool all = true;
        for (const auto &want : Strings{"купить молоко, хлеб", "пара 15:00 1 ч", "событие Физика пара 10:00 1 ч",
                                        "задача Матан 2 по пн", "задача вес 72"}) {
            if (std::find(got.begin(), got.end(), want) == got.end()) {
                all = false;
                std::printf("    нет «%s»\n", want.c_str());
            }
        }
        check(all, "название, которое разбор читает иначе, — полной записью");
    }
    {
        auto sync = event("Sync", "11:00", "12:00");
        sync.day = std::nullopt;
        sync.repeat = weeklyRepeat({2}, "2026-09-01");
        checkList(texts(buildSuggestions("", sources({}, {}, {event("созвон", "16:00", "16:30"), sync}, {}), en())),
                  {"Sync tue 11:00 every week", "созвон 16:00"}, "слова строки — на языке названия");
    }
    {
        auto c = ru();
        c.learned = QuickLearned{{"летучка", QuickLearnedEntry{std::string("task"), 20}}};
        checkList(texts(buildSuggestions("", sources({}, {}, {event("летучка", "10:00", "11:00")}, {}), c)),
                  {"событие летучка 10:00 1 ч"}, "выученный тип не меняет запись подсказки");
    }
}

static void typed() {
    std::printf("подсказки: набранное\n");
    const auto candidates = buildCandidates(
        sources(history({"пара по английскому вт 15:00", "купить ёлку", "созвон с Олей завтра 16:00",
                         "английский язык 18:00", "вес 72,4", "созвон с Олей завтра 16:00"}),
                {task("написать Оле")}, {}, {"созвон завтра 16:00 45 мин", "вода 500 мл"}),
        ru());
    const auto suggest = [&](const std::string &input) { return texts(filterSuggestions(input, candidates)); };
    checkList(suggest("  "), {"созвон с Олей завтра 16:00", "вес 72,4", "английский язык 18:00", "купить ёлку",
                              "пара по английскому вт 15:00", "написать Оле", "созвон завтра 16:00 45 мин",
                              "вода 500 мл"},
              "пустая строка — свои по частоте и свежести, затем примеры");
    checkList(suggest("анг"), {"английский язык 18:00", "пара по английскому вт 15:00"}, "начало строки старше");
    checkList(suggest("16"), {"созвон с Олей завтра 16:00", "созвон завтра 16:00 45 мин"}, "вхождение «16»");
    checkList(suggest("ол"), {"созвон с Олей завтра 16:00", "написать Оле"}, "начало слова названия");
    checkList(suggest("соз"), {"созвон с Олей завтра 16:00", "созвон завтра 16:00 45 мин"}, "чаще, свои прежде примеров");
    checkList(suggest("КУПИТЬ Е"), {"купить ёлку"}, "регистр не различается");
    checkList(suggest("ёлк"), {"купить ёлку"}, "«ё» набрана");
    checkList(suggest("елку"), {"купить ёлку"}, "«е» вместо «ё»");
    checkList(suggest("созвон ол"), {"созвон с Олей завтра 16:00"}, "прежние слова в строке");
    checkList(suggest("созвон оле"), {"созвон с Олей завтра 16:00"}, "недописанное слово");
    checkList(suggest("созвон вас"), {}, "чужое слово — ничего");
    checkList(suggest("соз "), {}, "дописанное «соз» — не слово строки");
    checkList(suggest("созвон "), {"созвон с Олей завтра 16:00", "созвон завтра 16:00 45 мин"}, "дописанное слово");
    checkList(suggest("я"), {"английский язык 18:00"}, "одна буква — с начала слова");
    checkList(suggest("в"), {"вес 72,4", "вода 500 мл", "пара по английскому вт 15:00"}, "одна буква «в»");
    checkList(suggest("Купить елку "), {}, "равная набранной не предлагается");
    checkList(suggest("вес 72,4"), {}, "равная набранной (2)");
    checkList(suggest("вес 72"), {"вес 72,4"}, "начало строки с числом");
    checkList(suggest("стоматолог"), {}, "ничего не подошло");
    {
        QuickHistory h;
        h.tick = 3;
        h.lines = {QuickHistoryLine{"Team sync tue 11:00", 1, 3}, QuickHistoryLine{"buy a synthesizer", 1, 2},
                   QuickHistoryLine{"weight 72.4", 1, 1}};
        const auto english = buildCandidates(sources(h, {}, {}, {"call tomorrow 16:00 45 min"}), en());
        checkList(texts(filterSuggestions("SY", english)), {"Team sync tue 11:00", "buy a synthesizer"}, "английская: SY");
        checkList(texts(filterSuggestions("team s", english)), {"Team sync tue 11:00"}, "английская: team s");
        checkList(texts(filterSuggestions("w", english)), {"weight 72.4"}, "английская: w");
        checkList(texts(filterSuggestions("", english)),
                  {"Team sync tue 11:00", "buy a synthesizer", "weight 72.4", "call tomorrow 16:00 45 min"},
                  "английская: пусто");
    }
    {
        Strings many;
        for (int i = 0; i < 30; ++i) many.push_back("дело номер " + std::to_string(i + 1));
        const auto list = buildSuggestions("", sources(history(many)), ru());
        check(list.size() == kMaxSuggestions
                  && std::all_of(list.begin(), list.end(), [](const auto &s) { return s.source == "history"; }),
              "не больше восьми подсказок");
        check(buildSuggestions("дело", sources(history(many)), ru()).size() == kMaxSuggestions, "восемь и при фильтре");
    }
    check(isSuggestionPrefix("Купить е", "купить ёлку"), "Tab: начало");
    check(isSuggestionPrefix("  купить  ", "купить ёлку"), "Tab: пробелы");
    check(!isSuggestionPrefix("купить ёлку", "купить ёлку"), "Tab: вся строка");
    check(!isSuggestionPrefix("купить ёлку ", "купить ёлку"), "Tab: вся строка с пробелом");
    check(!isSuggestionPrefix("елку", "купить ёлку"), "Tab: не начало");
    check(!isSuggestionPrefix("", "купить ёлку"), "Tab: пусто");
}

static void historyCases() {
    std::printf("подсказки: история и «Забыть»\n");
    {
        const auto store = history({"Купить кабель", "вес 72,4", "  купить   КАБЕЛЬ "});
        check(store.lines.size() == 2 && store.lines[0] == QuickHistoryLine{"купить КАБЕЛЬ", 2, 3}
                  && store.lines[1] == QuickHistoryLine{"вес 72,4", 1, 2},
              "та же строка не дублируется");
    }
    {
        const QuickHistory store;
        std::string longLine;
        for (int i = 0; i < 301; ++i) longLine += "а";
        check(!recordHistoryLine(store, "   ", "").changed && !recordHistoryLine(store, longLine, "x").changed,
              "пустая и длинная строка не запоминаются");
    }
    {
        Strings list;
        for (size_t i = 0; i < kHistoryMaxLines + 20; ++i) list.push_back("дело " + std::to_string(i));
        const auto store = history(list);
        check(store.lines.size() == kHistoryMaxLines
                  && store.lines[0].text == "дело " + std::to_string(kHistoryMaxLines + 19)
                  && store.lines.back().text == "дело 20",
              "помнит двести последних строк");
    }
    {
        auto base = sources(history({"летучка завтра 10:00 20 мин", "купить кабель", "летучка пт 10:00 20 мин"}),
                            {task("купить кабель")}, {event("летучка", "10:00", "10:20")}, {});
        const auto candidates = buildCandidates(base, ru());
        const auto target = std::find_if(candidates.begin(), candidates.end(),
                                         [](const auto &c) { return c.text == "летучка пт 10:00 20 мин"; });
        check(target != candidates.end()
                  && target->texts == Strings{"летучка пт 10:00 20 мин", "летучка завтра 10:00 20 мин"},
              "кандидат несёт строки шаблона");
        if (target != candidates.end()) {
            const auto forgotten = forgetSuggestion(base.history, target->key, target->texts);
            check(forgotten.lines.size() == 1 && forgotten.lines[0].text == "купить кабель", "строки шаблона стёрты");
            auto withForgotten = base;
            withForgotten.history = forgotten;
            checkList(texts(buildSuggestions("", withForgotten, ru())), {"купить кабель"},
                      "забытое не возвращается из данных");
            const std::string line = "летучка 10:00 20 мин";
            const auto again = recordHistoryLine(forgotten, line, lineKey(line, parseQuickInput(line, ru()), "ru"));
            check(again.history.hidden.empty(), "добавленная снова строка перестаёт быть забытой");
            withForgotten.history = again.history;
            checkList(texts(buildSuggestions("", withForgotten, ru())), {line, "купить кабель"}, "и снова подсказка");
        }
    }
    {
        const auto base = sources({}, {task("купить хлеб"), task("купить кабель")}, {}, {});
        const auto first = buildCandidates(base, ru()).at(0);
        check(first.text == "купить кабель" && first.source == "data" && first.texts.empty(), "подсказка из данных");
        const auto forgotten = forgetSuggestion(base.history, first.key, first.texts);
        check(forgotten.hidden == Strings{"купить кабель"}, "шаблон забыт");
        auto withForgotten = base;
        withForgotten.history = forgotten;
        checkList(texts(buildSuggestions("", withForgotten, ru())), {"купить хлеб"}, "забытая из данных скрыта");
    }
    {
        QuickHistory store;
        for (size_t i = 0; i < kHistoryMaxHidden + 10; ++i) store = forgetSuggestion(store, "дело " + std::to_string(i), {});
        check(store.hidden.size() == kHistoryMaxHidden && store.hidden[0] == "дело " + std::to_string(kHistoryMaxHidden + 9),
              "список забытого ограничен");
    }
}

static void syncedCases() {
    std::printf("подсказки: история в данных «Плана»\n");
    const auto key = [](const std::string &line) { return lineKey(line, parseQuickInput(line, ru()), "ru"); };
    check(quickLineId("Купить  кабель") == quickLineId(" купить КАБЕЛЬ"), "ключ без регистра и пробелов");
    check(quickLineId("ёлка") == quickLineId("елка"), "ключ: «ё» — «е»");
    check(quickLineId("купить кабель") != quickLineId("купить кабели"), "разные строки — разные ключи");
    check(quickLineId("созвон", true) != quickLineId("созвон"), "строка и забытый шаблон — разные записи");
    check(quickLineId("купить кабель").size() == 17 && quickLineId("купить кабель")[0] == 'q', "вид ключа строки");
    check(quickLineId("созвон", true)[0] == 'h', "вид ключа забытого");
    check(quickLineId("созвон завтра 16:00") == "q84f71769879cc437", "ключ закреплён (как в web)");
    {
        const auto store = forgetSuggestion(history({"купить кабель", "вес 72,4", "Купить кабель"}), "созвон", {});
        const auto list = historyToLines(store);
        const auto cable = std::find_if(list.begin(), list.end(), [](const auto &l) { return l.text == "Купить кабель"; });
        const auto hidden = std::find_if(list.begin(), list.end(), [](const auto &l) { return l.isHidden.value_or(false); });
        check(list.size() == 3 && cable != list.end() && cable->id == quickLineId("купить кабель") && cable->count == 2
                  && cable->touched == 3,
              "строка истории → запись");
        check(hidden != list.end() && hidden->id == quickLineId("созвон", true) && hidden->text == "созвон"
                  && hidden->count == 0 && hidden->touched == 3,
              "забытый шаблон → запись");
        check(historyFromLines(list) == store, "записи → история без потерь");
        const auto again = historyToLines(historyFromLines(list), list);
        bool same = again.size() == list.size();
        for (size_t i = 0; same && i < list.size(); ++i) {
            same = again[i].id == list[i].id && again[i].text == list[i].text && again[i].count == list[i].count
                && again[i].touched == list[i].touched && again[i].isHidden == list[i].isHidden;
        }
        check(same, "повторный проход записи не меняет");
    }
    {
        const auto list = historyToLines(history({"купить кабель", "вес 72,4"}));
        const auto next = recordQuickLine(list, "купить КАБЕЛЬ", key("купить кабель"));
        const auto changed = std::find_if(next.begin(), next.end(), [](const auto &l) { return l.text == "купить КАБЕЛЬ"; });
        check(next.size() == 2 && changed != next.end() && changed->count == 2 && changed->touched == 3,
              "добавленная строка меняет одну запись");
        Strings many;
        for (size_t i = 0; i < kHistoryMaxLines; ++i) many.push_back("дело " + std::to_string(i));
        const auto pushed = recordQuickLine(historyToLines(history(many)), "новое дело", key("новое дело"));
        const auto has = [&](const std::string &t) {
            return std::any_of(pushed.begin(), pushed.end(), [&](const auto &l) { return l.text == t; });
        };
        check(pushed.size() == kHistoryMaxLines && !has("дело 0") && has("новое дело"), "вытесненная строка уходит");
    }
    {
        const auto list = historyToLines(history({"летучка завтра 10:00 20 мин", "купить кабель", "летучка пт 10:00 20 мин"}));
        const auto templ = key("летучка пт 10:00 20 мин");
        const auto forgotten = forgetQuickLine(list, templ, {"летучка пт 10:00 20 мин", "летучка завтра 10:00 20 мин"});
        bool ok = forgotten.size() == 2;
        for (const auto &line : forgotten) {
            ok = ok && ((line.text == "купить кабель" && !line.isHidden.value_or(false))
                        || (line.text == templ && line.isHidden.value_or(false)));
        }
        check(ok, "«Забыть» убирает строки и помечает шаблон");
        const auto later = recordQuickLine(forgotten, "вес 72,4", key("вес 72,4"));
        const auto hiddenOf = [](const std::vector<QuickLine> &l) {
            return std::find_if(l.begin(), l.end(), [](const auto &x) { return x.isHidden.value_or(false); });
        };
        check(hiddenOf(later) != later.end() && hiddenOf(forgotten) != forgotten.end()
                  && hiddenOf(later)->touched == hiddenOf(forgotten)->touched,
              "свежесть забытого не меняется");
        const auto again = recordQuickLine(later, "летучка 10:00 20 мин", templ);
        Strings got;
        for (const auto &line : again) got.push_back(line.text);
        std::sort(got.begin(), got.end());
        check(hiddenOf(again) == again.end() && got == Strings{"вес 72,4", "купить кабель", "летучка 10:00 20 мин"},
              "добавленная снова строка снимает пометку");
    }
    {
        QuickHistory store;
        store.tick = 2;
        store.lines = {QuickHistoryLine{"дело\x07 со звонком", 1, 2}, QuickHistoryLine{"дело", 1, 1}};
        store.hidden = {std::string("ключ") + '\0'};
        const auto list = historyToLines(store);
        check(list.size() == 1 && list[0].text == "дело", "негодное движку в записи не попадает");
        QuickLine other;
        other.id = "other";
        other.text = " Дело ";
        other.count = 0;
        other.touched = 7;
        QuickLine same;
        same.id = quickLineId("дело");
        same.text = "дело";
        same.count = 3;
        same.touched = 5;
        QuickLine empty;
        empty.id = "empty";
        empty.text = "   ";
        empty.count = 1;
        empty.touched = 9;
        const auto read = historyFromLines({other, same, empty});
        check(read.tick == 9 && read.lines.size() == 1 && read.lines[0] == QuickHistoryLine{"Дело", 1, 7}
                  && read.hidden.empty(),
              "чужие записи читаются терпимо");
    }
}

static void kindsCases() {
    std::printf("подсказки окна, открытого под вид\n");
    auto examples = EXAMPLES;
    examples.push_back("сон 23:40-07:30");
    examples.push_back("бег 5 км 28 мин");
    const auto candidates = buildCandidates(
        sources(history({"спал с 14 до 15", "созвон завтра 16:00", "бег 3 км 20 мин"}), {}, {}, examples), ru());
    const auto sleep = filterSuggestions("", candidates, 8, Strings{"sleep"});
    check(sleep.size() == 2 && sleep[0] == QuickSuggestion{"спал с 14 до 15", "history"}
              && sleep[1] == QuickSuggestion{"сон 23:40-07:30", "example"},
          "сон: свои, затем примеры");
    checkList(texts(filterSuggestions("", candidates, 8, Strings{"workout"})), {"бег 3 км 20 мин", "бег 5 км 28 мин"},
              "спорт");
    checkList(texts(filterSuggestions("", candidates, 8, Strings{"water"})), {"вода 500 мл"}, "вода");
}

int main() {
    std::printf("=== parvane-core planner quick suggest tests (без стека) ===\n");
    lines();
    sourcesCases();
    typed();
    historyCases();
    syncedCases();
    kindsCases();
    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
