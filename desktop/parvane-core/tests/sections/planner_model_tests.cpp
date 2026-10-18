// Parvane fork (spec 029, фаза 4): тесты модели «Плана» — перенос web `plannerModel.test.ts` и
// `plannerIndex.test.ts` (по одной проверке на `it`, имена — как в web).
// Правки задаются назначенными инициализаторами: остальные поля намеренно пусты
#pragma GCC diagnostic ignored "-Wmissing-field-initializers"

#include <algorithm>
#include <chrono>
#include <map>
#include <memory>
#include <cmath>
#include <cstdio>
#include <functional>
#include <string>
#include <vector>

#include "parvane/sections/planner_model.h"

using namespace parvane::sections::planner;
using nlohmann::json;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name) {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}

// Детерминированный генератор идентификаторов
static IdGen seqIds(const std::string &prefix = "id") {
    auto n = std::make_shared<int>(0);
    return [n, prefix]() { return prefix + std::to_string(++*n); };
}

// 8 октября 2026 — четверг
static const std::string TODAY = "2026-10-08";

static Task task(const std::string &id, const std::function<void(Task &)> &edit = nullptr) {
    Task t;
    t.id = id;
    t.name = "Задача";
    t.rank = 1;
    if (edit) edit(t);
    return t;
}

static Event event(const std::string &id, const std::string &name, const std::string &start, const std::string &end,
                   const std::function<void(Event &)> &edit = nullptr) {
    Event e;
    e.id = id;
    e.name = name;
    e.start = start;
    e.end = end;
    if (edit) edit(e);
    return e;
}

static Repeat rep(const std::string &kind, int interval, const std::string &startDay,
                  const std::function<void(Repeat &)> &edit = nullptr) {
    Repeat r;
    r.kind = kind;
    r.interval = interval;
    r.startDay = startDay;
    if (edit) edit(r);
    return r;
}

static Repeat weekly(std::vector<int> days, const std::string &startDay,
                     const std::function<void(Repeat &)> &edit = nullptr) {
    Repeat r = rep("weekly", 1, startDay, edit);
    if (!r.weekdays) r.weekdays = days;
    return r;
}

static Occurrence occ(const std::string &day, std::optional<bool> done = std::nullopt,
                      std::optional<bool> excluded = std::nullopt) {
    Occurrence o;
    o.day = day;
    o.done = done;
    o.excluded = excluded;
    return o;
}

template <typename T>
static std::vector<std::string> ids(const std::vector<T> &items) {
    std::vector<std::string> out;
    for (const auto &item : items) out.push_back(item.id);
    return out;
}

static std::vector<std::string> V(std::initializer_list<const char *> items) {
    return std::vector<std::string>(items.begin(), items.end());
}

template <typename T>
static bool same(const T &a, const T &b) {
    return json(a) == json(b);
}

static bool sameJson(const json &a, const char *expected) { return a == json::parse(expected); }

static FoodEntry food(const std::string &id, double kcal, std::function<void(FoodEntry &)> edit = nullptr) {
    FoodEntry f;
    f.id = id;
    f.name = id;
    f.meal = "lunch";
    f.kcal = kcal;
    if (edit) edit(f);
    return f;
}

static NutritionDay nday(std::vector<FoodEntry> entries, bool isComplete,
                         std::function<void(NutritionDay &)> edit = nullptr) {
    NutritionDay d;
    d.entries = std::move(entries);
    d.isComplete = isComplete;
    if (edit) edit(d);
    return d;
}

// ── plannerModel.test.ts ─────────────────────────────────────────────────────

static void eventsAndLoad() {
    std::printf("-- планировщик: события и загрузка дня\n");
    State state = createEmptyState();
    state.events = {
        event("10", "Созвон", "10:00", "10:30", [](Event &e) { e.repeat = weekly({1, 2, 3, 4, 5}, ""); }),
        event("11", "Ужин", "20:30", "22:00", [](Event &e) { e.day = "2026-10-22"; }),
    };
    state.tasks = {
        task("1", [](Task &t) { t.day = TODAY; t.start = "10:15"; t.minutes = 30; }),
        task("2", [](Task &t) { t.day = TODAY; t.minutes = 90; }),
        task("3", [](Task &t) { t.day = TODAY; }),
    };
    check(ids(getEventsForDay(state, TODAY)) == V({"10"}) && getEventsForDay(state, "2026-10-10").empty()
              && ids(getEventsForDay(state, "2026-10-22")) == V({"10", "11"}),
          "повтор по дням недели и разовая дата");
    check(getDayLoad(state, TODAY) == 30 + 30 + 90, "загрузка — события плюс оценки задач, без оценки не считается");
    check(countConflicts(state, TODAY) == 1 && countConflicts(state, "2026-10-09") == 0,
          "пересечение времени считается парами");
    const auto availability = getDayAvailability(state, TODAY);
    check(availability.free == std::vector<Slot>{{540, 600}, {645, 1260}} && availability.groups.size() == 1
              && availability.groups[0].items.size() == 2 && availability.freeMinutes == 60 + 615,
          "свободные окна 09–21 и группа пересекающихся дел");
}

static void slotsAndValidation() {
    std::printf("-- планировщик: поиск окна и проверки ввода\n");
    {
        State state = createEmptyState();
        state.tasks = {task("1", [](Task &t) { t.day = TODAY; t.start = "09:00"; t.minutes = 60; }),
                       task("2", [](Task &t) { t.minutes = 120; })};
        const auto slots = findSlots(state, state.tasks[1], TODAY, TODAY);
        check(!slots.empty() && slots[0] == SlotAnswer{TODAY, "10:00", "12:00"},
              "окно ищется сразу после занятого времени, без запаса и перерыва");
    }
    {
        State state = createEmptyState();
        state.budget = 120;
        state.tasks = {task("1", [](Task &t) { t.day = TODAY; t.minutes = 100; }),
                       task("2", [](Task &t) { t.minutes = 60; t.due = "2026-10-09"; })};
        const auto slots = findSlots(state, state.tasks[1], TODAY, TODAY);
        check(slots.size() == 1 && slots[0].day == "2026-10-09", "день сверх бюджета пропускается, дедлайн ограничивает поиск");
    }
    check(findSlots(createEmptyState(), task("1"), TODAY, TODAY).empty(), "задача без оценки окна не получает");
    auto vt = [](const std::function<void(Task &)> &edit) {
        Task t;
        edit(t);
        return validateTask(t);
    };
    check(vt([](Task &t) { t.name = " "; }) == "name" && vt([](Task &t) { t.name = "a"; t.minutes = 3; }) == "minutes"
              && vt([](Task &t) { t.name = "a"; t.start = "10:00"; }) == "startNeedsDayAndMinutes"
              && vt([](Task &t) { t.name = "a"; t.day = TODAY; t.start = "23:30"; t.minutes = 60; }) == "pastMidnight"
              && vt([](Task &t) { t.name = "a"; t.day = "2026-10-10"; t.due = TODAY; }) == "dayAfterDue"
              && !vt([](Task &t) { t.name = "a"; t.day = TODAY; t.start = "10:00"; t.minutes = 60; })
              // Время начала без оценки — можно (16 окт 2026)
              && !vt([](Task &t) { t.name = "a"; t.day = TODAY; t.start = "23:30"; }),
          "проверки задачи");
    auto ve = [](const std::function<void(Event &)> &edit) {
        Event e;
        e.name = "a";
        edit(e);
        return validateEvent(e);
    };
    check(ve([](Event &e) { e.start = "11:00"; e.end = "10:00"; e.day = TODAY; }) == "time"
              && ve([](Event &e) { e.start = "10:00"; e.end = "11:00"; }) == "repeat"
              && !ve([](Event &e) { e.start = "10:00"; e.end = "11:00"; e.repeat = weekly({1}, ""); })
              && ve([](Event &e) { e.start = "10:00"; e.end = "11:00"; e.repeat = rep("daily", 1, ""); }) == "startDay",
          "проверки события");
}

static void settingsAndOrder() {
    std::printf("-- планировщик: настройки дня и порядок очереди (T014)\n");
    {
        State state = createEmptyState();
        state.settings = Settings{480, 1080, 0, 0, 0};
        state.tasks = {task("1", [](Task &t) { t.day = TODAY; t.start = "08:00"; t.minutes = 60; }),
                       task("2", [](Task &t) { t.minutes = 120; })};
        bool ok = getDayAvailability(state, TODAY).free == std::vector<Slot>{{540, 1080}};
        ok = ok && findSlots(state, state.tasks[1], TODAY, TODAY)[0] == SlotAnswer{TODAY, "09:00", "11:00"};
        // Перерыв и запас из записей прежних версий на поиск времени не влияют
        state.settings = Settings{480, 1080, 540, 600, 30};
        ok = ok && findSlots(state, state.tasks[1], TODAY, TODAY)[0] == SlotAnswer{TODAY, "09:00", "11:00"};
        check(ok, "окна дня берутся из настроек; перерыва и запаса между делами нет");
    }
    {
        const Settings d = defaultSettings();
        auto with = [&](const std::function<void(Settings &)> &edit) {
            Settings s = d;
            edit(s);
            return validateSettings(s);
        };
        check(!validateSettings(d) && with([](Settings &s) { s.dayStart = 1260; }) == "window"
                  && with([](Settings &s) { s.lunchStart = 480; s.lunchEnd = 600; }) == "lunch"
                  && !with([](Settings &s) { s.lunchStart = 0; s.lunchEnd = 0; })
                  && with([](Settings &s) { s.margin = 181; }) == "margin",
              "проверки настроек");
    }
    {
        auto ids0 = seqIds();
        const json defaults = defaultSettings();
        bool ok = json(normalizeState(json::parse(R"({"version":1,"tasks":[]})"), ids0).settings) == defaults;
        const auto restored = normalizeState(
            json::parse(R"({"version":1,"tasks":[],"settings":{"dayStart":600,"dayEnd":1200,"lunchStart":0,"lunchEnd":0,"margin":10}})"),
            ids0);
        ok = ok && sameJson(restored.settings, R"({"dayStart":600,"dayEnd":1200,"lunchStart":0,"lunchEnd":0,"margin":10})");
        ok = ok && json(normalizeState(json::parse(R"({"version":1,"tasks":[],"settings":{"dayStart":"x"}})"), ids0).settings)
            == defaults;
        ok = ok && json(normalizeState(json::parse(R"({"version":1,"tasks":[],"settings":{"dayStart":1300}})"), ids0).settings)
            == defaults;
        check(ok, "сохранённое без настроек или с негодными получает значения макета");
    }
    {
        State state = createEmptyState();
        state.tasks = {
            task("1", [](Task &t) { t.rank = 0; }),
            task("2", [](Task &t) { t.rank = 0; }),
            task("3", [](Task &t) { t.rank = 0; t.status = "active"; }),
            task("4", [](Task &t) { t.rank = 0; t.project = "Дом"; }),
        };
        bool ok = ids(getOrderedGroup(state, state.tasks[0], TODAY)) == V({"1", "2"});
        ok = ok && !moveTask(state, "1", -1, TODAY) && moveTask(state, "2", -1, TODAY);
        ok = ok && ids(getOrderedGroup(state, state.tasks[0], TODAY)) == V({"2", "1"});
        ok = ok && moveTask(state, "2", 1, TODAY);
        ok = ok && ids(getOrderedGroup(state, state.tasks[0], TODAY)) == V({"1", "2"});
        ok = ok && !moveTask(state, "3", 1, TODAY) && !moveTask(state, "99", 1, TODAY);
        check(ok, "стрелки меняют задачу местами с соседом того же списка и статуса, у края — ничего");
    }
}

static void nutrition() {
    std::printf("-- планировщик: питание\n");
    {
        FoodInput raw;
        raw.name = " Творог ";
        raw.meal = "breakfast";
        raw.isPer100 = true;
        raw.grams = 250;
        raw.values = {{"kcal", 120}, {"protein", 18}};
        const auto entry = makeFoodEntry(raw, seqIds());
        check(entry.name == "Творог" && entry.kcal == 300 && entry.protein == 45 && entry.grams == 250 && !entry.fat
                  && entry.per100 == NutrientMap{{"kcal", 120}, {"protein", 18}},
              "запись на 100 г пересчитывается по весу, неизвестное остаётся неизвестным");
    }
    {
        State state = createEmptyState();
        state.nutrition[TODAY] = nday({food("a", 1000, [](FoodEntry &f) { f.protein = 60; }),
                                       food("b", 1050, [](FoodEntry &f) { f.meal = "dinner"; })},
                                      true);
        bool ok = getNutrientTotal(state, TODAY, "protein") == NutrientTotal{60, 1, 2};
        ok = ok && getNutrientStatus(state, TODAY, "kcal", TODAY) == "ok";
        ok = ok && getNutrientStatus(state, TODAY, "protein", TODAY) == "incomplete";
        ok = ok && getNutrientStatus(state, "2026-10-07", "kcal", TODAY) == "none";
        state.nutrition[TODAY].isComplete = false;
        ok = ok && getNutrientStatus(state, TODAY, "kcal", TODAY) == "open";
        // spec 013: прошедший день завершён сам, без отметки
        ok = ok && getNutrientStatus(state, TODAY, "kcal", "2026-10-09") == "ok";
        check(ok, "пропуски не считаются нулём; статус дня — по завершённости и цели");
    }
    {
        State state = createEmptyState();
        state.nutrition[TODAY] = nday({food("a", 2000, [](FoodEntry &f) { f.meal = "other"; })}, true,
                                      [](NutritionDay &d) { d.fixedGoals = GoalValues{{"kcal", {2000, 100}}}; });
        state.goals = {{"kcal", {3000, 100}}};
        bool ok = getNutrientStatus(state, TODAY, "kcal", TODAY) == "ok";
        const auto stat = getNutrientStatistics(state, {TODAY, "2026-10-09"}, "kcal", TODAY);
        ok = ok && stat.sum == 2000 && stat.inGoal == 1 && stat.average == 2000.0 && stat.goalLow == 1900
            && stat.goalHigh == 2100;
        // SC-005: правка списка целей задним числом завершённый день не переоценивает
        state.goalPeriods.push_back({"g", TODAY, TODAY, {{"kcal", {1000, 50}}}});
        ok = ok && getNutrientStatus(state, TODAY, "kcal", TODAY) == "ok";
        check(ok, "цели завершённого дня не меняются при смене текущих целей");
    }
}

static void repeats() {
    std::printf("-- планировщик: повторяющиеся события и задачи (spec 011)\n");
    auto ids0 = seqIds("new");
    {
        const auto repeat = weekly({1, 3}, "2026-10-12");
        bool ok = expandRepeat(repeat, "2026-11-01", "2026-11-30")
            == V({"2026-11-02", "2026-11-04", "2026-11-09", "2026-11-11", "2026-11-16", "2026-11-18", "2026-11-23",
                  "2026-11-25", "2026-11-30"});
        ok = ok && expandRepeat(repeat, "2026-10-01", "2026-10-11").empty();
        // Ряд с середины недели: понедельник той же недели не порождается, счёт идёт с первого экземпляра
        ok = ok && expandRepeat(weekly({1, 3}, "2026-10-14", [](Repeat &r) { r.count = 2; }), "2026-10-01", "2026-10-31")
                == V({"2026-10-14", "2026-10-19"});
        // Шаг две недели
        ok = ok && expandRepeat(weekly({1}, "2026-10-12", [](Repeat &r) { r.interval = 2; }), "2026-10-01", "2026-11-30")
                == V({"2026-10-12", "2026-10-26", "2026-11-09", "2026-11-23"});
        check(ok, "SC-001: еженедельный ряд по понедельникам и средам — весь ноябрь, до начала ряда ничего");
    }
    {
        const auto monthly = rep("monthly", 1, "2026-10-31");
        bool ok = expandRepeat(monthly, "2026-11-01", "2027-03-31")
            == V({"2026-11-30", "2026-12-31", "2027-01-31", "2027-02-28", "2027-03-31"});
        ok = ok && occursOn(monthly, "2028-02-29");
        ok = ok && occursOn(rep("monthly", 1, "2026-10-01", [](Repeat &r) { r.monthDay = 20; }), "2026-11-20");
        ok = ok && occursOn(rep("monthly", 3, "2026-10-31"), "2027-01-31");
        ok = ok && !occursOn(rep("monthly", 3, "2026-10-31"), "2026-12-31");
        ok = ok && expandRepeat(rep("yearly", 1, "2028-02-29"), "2028-01-01", "2030-12-31")
                == V({"2028-02-29", "2029-02-28", "2030-02-28"});
        check(ok, "SC-001: ежемесячно 31-го — в коротком месяце последний день; ежегодно 29 февраля — 28-го");
    }
    {
        const auto daily = rep("daily", 1, "2026-10-01", [](Repeat &r) { r.count = 10; });
        bool ok = expandRepeat(daily, "2026-09-01", "2026-12-31").size() == 10;
        ok = ok && occursOn(daily, "2026-10-10") && !occursOn(daily, "2026-10-11");
        auto every3 = daily;
        every3.interval = 3;
        every3.count.reset();
        every3.endDay = "2026-10-10";
        ok = ok && expandRepeat(every3, "2026-09-01", "2026-12-31")
                == V({"2026-10-01", "2026-10-04", "2026-10-07", "2026-10-10"});
        auto bad = daily;
        bad.interval = 0;
        ok = ok && validateRepeat(bad) == "interval";
        bad = daily;
        bad.endDay = "2026-09-01";
        ok = ok && validateRepeat(bad) == "endDay";
        ok = ok && validateRepeat(weekly({}, TODAY)) == "weekdays";
        bad = daily;
        bad.count = 1000;
        ok = ok && validateRepeat(bad) == "count";
        check(ok, "SC-001: ежедневно с числом повторов и датой конца; исключённые считаются в K");
    }
    {
        State state = createEmptyState();
        state.tasks = {task("s", [](Task &t) {
            t.name = "Зарядка";
            t.minutes = 15;
            t.steps = {{"а", false}, {"б", false}};
            t.repeat = rep("daily", 1, "2026-10-01", [](Repeat &r) { r.count = 10; });
        })};
        bool ok = getTasksForDay(state, TODAY).size() == 1 && getTasksForDay(state, "2026-10-20").empty();
        const auto instance = getTasksForDay(state, TODAY)[0];
        ok = ok && instance.id == "s" && instance.instanceDay == TODAY && instance.day == TODAY
            && instance.status == "queue";
        setTaskDone(state, instance, true);
        setTaskStepDone(state, instance, 1, true);
        const auto done = getTasksForDay(state, TODAY)[0];
        ok = ok && done.status == "done" && !done.steps[0].isDone && done.steps[1].isDone;
        const auto next = getTasksForDay(state, "2026-10-09")[0];
        ok = ok && next.status == "queue" && !next.steps[0].isDone && !next.steps[1].isDone;
        ok = ok && nextOpenInstance(state.tasks[0], TODAY)->instanceDay == "2026-10-09";
        // В списке задач — одна строка, ближайший невыполненный экземпляр
        const auto eligible = getEligibleTasks(state, TODAY);
        ok = ok && eligible.size() == 1 && eligible[0].instanceDay == "2026-10-09";
        setTaskDone(state, getTasksForDay(state, TODAY)[0], false);
        ok = ok && getTasksForDay(state, TODAY)[0].status == "queue";
        // Загрузка и поиск окна учитывают экземпляры
        ok = ok && getDayLoad(state, "2026-10-09") == 15;
        check(ok, "экземпляры задачи-ряда: выполнение одного дня не трогает следующий, шаги по дню, ближайший невыполненный");
    }
    {
        State state = createEmptyState();
        state.events = {event("e", "Бассейн", "19:00", "20:00", [](Event &e) { e.repeat = weekly({1, 3}, "2026-10-12"); })};
        const auto detached = std::get<Event>(*detachInstance(
            state, SeriesKind::Event, "e", "2026-10-14",
            ItemPatch{.start = "20:00", .end = "21:00", .day = "2026-10-15"}, ids0));
        bool ok = detached.origin && detached.origin->seriesId == "e" && detached.origin->day == "2026-10-14"
            && detached.day == "2026-10-15" && detached.start == "20:00" && !detached.repeat;
        ok = ok && getEventsForDay(state, "2026-10-14").empty();
        ok = ok && ids(getEventsForDay(state, "2026-10-15")) == std::vector<std::string>{detached.id};
        ok = ok && ids(getEventsForDay(state, "2026-10-19")) == V({"e"});
        excludeInstance(state, SeriesKind::Event, "e", "2026-10-19");
        ok = ok && getEventsForDay(state, "2026-10-19").empty();
        removeSeries(state, SeriesKind::Event, "e");
        ok = ok && ids(state.events) == std::vector<std::string>{detached.id};
        check(ok, "«только это»: отделённая копия с происхождением, день исключён у ряда; удаление ряда её не трогает");
    }
    {
        State state = createEmptyState();
        state.tasks = {task("s", [](Task &t) {
            t.name = "Бассейн";
            t.start = "19:00";
            t.minutes = 60;
            t.repeat = weekly({1}, "2026-10-12", [](Repeat &r) { r.count = 6; });
        })};
        setOccurrence(state, SeriesKind::Task, "s", "2026-10-19", OccurrencePatch{.done = true});
        setOccurrence(state, SeriesKind::Task, "s", "2026-11-09", OccurrencePatch{.done = true});
        const auto created =
            std::get<Task>(*splitSeries(state, SeriesKind::Task, "s", "2026-11-02", ItemPatch{.start = "20:00"}, ids0));
        bool ok = state.tasks[0].repeat->endDay == "2026-11-01" && state.tasks[0].repeat->count == 3;
        ok = ok && sameJson(json(*state.tasks[0].occurrences), R"([{"day":"2026-10-19","done":true}])");
        ok = ok && created.repeat->kind == "weekly" && created.repeat->startDay == "2026-11-02" && created.repeat->count == 3;
        ok = ok && created.start == "20:00";
        const auto oct26 = getTasksForDay(state, "2026-10-26");
        ok = ok && oct26.size() == 1 && oct26[0].id == "s" && oct26[0].start == "19:00";
        const auto nov2 = getTasksForDay(state, "2026-11-02");
        ok = ok && nov2.size() == 1 && nov2[0].id == created.id && nov2[0].start == "20:00";
        const auto nov9 = getTasksForDay(state, "2026-11-09");
        ok = ok && nov9.size() == 1 && nov9[0].id == created.id && nov9[0].status == "queue";
        // «Удалить это и последующие» — только обрезание
        truncateSeries(state, SeriesKind::Task, created.id, "2026-11-16");
        ok = ok && getTasksForDay(state, "2026-11-16").empty() && getTasksForDay(state, "2026-11-09").size() == 1;
        // Разделение на первом дне ряда — правка всего ряда
        const auto whole = splitSeries(state, SeriesKind::Task, "s", "2026-10-12", ItemPatch{.name = "Плавание"}, ids0);
        ok = ok && itemId(*whole) == "s";
        const Task *s = findTask(state, "s");
        ok = ok && s->name == "Плавание" && s->repeat->startDay == "2026-10-12";
        check(ok, "«это и последующие»: старый ряд заканчивается днём раньше с прежними отметками, новый — с этого дня");
    }
}

static void updateAll() {
    std::printf("-- планировщик: правка «Все в серии»\n");
    auto ids0 = seqIds("new");
    {
        State state = createEmptyState();
        state.tasks = {task("s", [](Task &t) {
            t.start = "10:00";
            t.minutes = 30;
            t.repeat = rep("daily", 1, "2026-10-05");
        })};
        state.events = {event("e", "Йога", "18:00", "19:00", [](Event &e) { e.repeat = rep("daily", 2, TODAY); })};
        updateSeries(state, SeriesKind::Task, "s", TODAY,
                     ItemPatch{.name = "Зарядка", .start = "11:00", .day = TODAY, .minutes = 45});
        bool ok = state.tasks[0].start == "11:00" && state.tasks[0].minutes == 45 && state.tasks[0].name == "Зарядка";
        ok = ok && !state.tasks[0].day;
        ok = ok && sameJson(json(*state.tasks[0].repeat), R"({"kind":"daily","interval":1,"startDay":"2026-10-05"})");
        updateSeries(state, SeriesKind::Event, "e", "2026-10-10",
                     ItemPatch{.end = "19:30", .color = 3,
                               .repeat = std::optional<RepeatPatch>(RepeatPatch::of(rep("daily", 1, TODAY)))});
        ok = ok && state.events[0].end == "19:30" && state.events[0].color == 3;
        ok = ok && state.events[0].repeat->interval == 2;
        ok = ok && !updateSeries(state, SeriesKind::Task, "нет", TODAY, ItemPatch{.name = "x"});
        check(ok, "поля уходят в шаблон: время, длительность, название, цвет; день и правило шаблона не трогаются");
    }
    {
        State state = createEmptyState();
        state.tasks = {task("s", [](Task &t) {
            t.repeat = rep("daily", 2, "2026-10-05", [](Repeat &r) {
                r.endDay = "2026-10-15";
                r.count = 5;
            });
            t.occurrences = std::vector<Occurrence>{occ("2026-10-07", true), occ("2026-10-09", std::nullopt, true)};
        })};
        // 9 октября → 12 октября: +3 дня
        updateSeries(state, SeriesKind::Task, "s", "2026-10-09", ItemPatch{.day = "2026-10-12"});
        const auto &series = state.tasks[0];
        bool ok = sameJson(json(*series.repeat),
                           R"({"kind":"daily","interval":2,"startDay":"2026-10-08","endDay":"2026-10-18","count":5})");
        ok = ok && sameJson(json(*series.occurrences),
                            R"([{"day":"2026-10-10","done":true},{"day":"2026-10-12","excluded":true}])");
        ok = ok && expandRepeat(*series.repeat, "2026-10-01", "2026-10-31")
                == V({"2026-10-08", "2026-10-10", "2026-10-12", "2026-10-14", "2026-10-16"});
        check(ok, "ежедневный ряд: перенос дня сдвигает начало, конец и отметки на то же число дней");
    }
    {
        State state = createEmptyState();
        state.events = {event("e", "Урок", "15:00", "16:00", [](Event &e) {
            // Понедельник и среда с понедельника 5 октября
            e.repeat = weekly({1, 3}, "2026-10-05", [](Repeat &r) { r.count = 4; });
            e.occurrences = std::vector<Occurrence>{occ("2026-10-07", std::nullopt, true)};
        })};
        // Среда 14 октября → четверг 15 октября
        updateSeries(state, SeriesKind::Event, "e", "2026-10-14", ItemPatch{.day = "2026-10-15"});
        auto r = *state.events[0].repeat;
        bool ok = r.weekdays == std::vector<int>{2, 4} && r.startDay == "2026-10-06" && r.count == 4;
        ok = ok && sameJson(json(*state.events[0].occurrences), R"([{"day":"2026-10-08","excluded":true}])");
        ok = ok && expandRepeat(r, "2026-10-01", "2026-11-30") == V({"2026-10-06", "2026-10-08", "2026-10-13", "2026-10-15"});
        // Вторник 13 октября → воскресенье 11 октября: −2 дня
        updateSeries(state, SeriesKind::Event, "e", "2026-10-13", ItemPatch{.day = "2026-10-11"});
        r = *state.events[0].repeat;
        ok = ok && r.weekdays == std::vector<int>{0, 2} && r.startDay == "2026-10-04";
        ok = ok && expandRepeat(r, "2026-10-01", "2026-11-30") == V({"2026-10-04", "2026-10-06", "2026-10-11", "2026-10-13"});
        ok = ok && sameJson(json(*state.events[0].occurrences), R"([{"day":"2026-10-06","excluded":true}])");
        check(ok, "еженедельный ряд: дни недели проворачиваются вместе со сдвигом, в том числе назад через границу недели");
    }
    {
        State state = createEmptyState();
        state.events = {
            event("e", "Смена", "09:00", "10:00",
                  [](Event &e) { e.repeat = weekly({1}, "2026-10-05", [](Repeat &r) { r.interval = 2; }); }),
            event("old", "Созвон", "10:00", "10:30", [](Event &e) { e.repeat = weekly({1}, ""); }),
        };
        // Понедельник 19 октября → воскресенье 18 октября
        updateSeries(state, SeriesKind::Event, "e", "2026-10-19", ItemPatch{.day = "2026-10-18"});
        bool ok = expandRepeat(*state.events[0].repeat, "2026-10-01", "2026-11-10")
            == V({"2026-10-04", "2026-10-18", "2026-11-01"});
        updateSeries(state, SeriesKind::Event, "old", "2026-10-19", ItemPatch{.day = "2026-10-21"});
        ok = ok && sameJson(json(*state.events[1].repeat), R"({"kind":"weekly","interval":1,"weekdays":[3],"startDay":""})");
        check(ok, "ряд «раз в две недели» с одним днём недели остаётся на своих неделях; ряд без даты начала — только дни");
    }
    {
        State state = createEmptyState();
        state.events = {event("e", "Аренда", "12:00", "12:30", [](Event &e) {
            e.repeat = rep("monthly", 1, "2026-01-01", [](Repeat &r) {
                r.monthDay = 31;
                r.endDay = "2026-04-30";
            });
            e.occurrences = std::vector<Occurrence>{occ("2026-01-31", std::nullopt, true)};
        })};
        // Экземпляр 28 февраля (в коротком месяце — последний день) → 3 марта
        updateSeries(state, SeriesKind::Event, "e", "2026-02-28", ItemPatch{.day = "2026-03-03"});
        const auto &r = *state.events[0].repeat;
        bool ok = sameJson(json(r),
                           R"({"kind":"monthly","interval":1,"monthDay":3,"startDay":"2026-02-03","endDay":"2026-05-03"})");
        ok = ok && expandRepeat(r, "2026-01-01", "2026-12-31") == V({"2026-02-03", "2026-03-03", "2026-04-03", "2026-05-03"});
        ok = ok && sameJson(json(*state.events[0].occurrences), R"([{"day":"2026-02-03","excluded":true}])");
        check(ok, "ежемесячный ряд встаёт на число нового дня и едет на столько же месяцев");
    }
    {
        State state = createEmptyState();
        state.events = {event("e", "Отчёт", "12:00", "12:30", [](Event &e) {
            // Последний экземпляр — 20 марта: конец 10 апреля раньше апрельского
            e.repeat = rep("monthly", 1, "2026-01-20", [](Repeat &r) { r.endDay = "2026-04-10"; });
        })};
        updateSeries(state, SeriesKind::Event, "e", "2026-02-20", ItemPatch{.day = "2026-02-05"});
        const auto &r = *state.events[0].repeat;
        bool ok = r.monthDay == 5 && r.startDay == "2026-01-05" && r.endDay == "2026-03-31";
        ok = ok && expandRepeat(r, "2026-01-01", "2026-12-31") == V({"2026-01-05", "2026-02-05", "2026-03-05"});
        check(ok, "ежемесячный ряд: конец до экземпляра своего месяца не добавляет лишний экземпляр");
    }
    {
        State state = createEmptyState();
        state.events = {event("e", "День рождения", "00:00", "23:59",
                              [](Event &e) { e.repeat = rep("yearly", 1, "2024-03-10"); })};
        updateSeries(state, SeriesKind::Event, "e", "2026-03-10", ItemPatch{.day = "2026-04-02"});
        const auto &r = *state.events[0].repeat;
        check(r.startDay == "2024-04-02" && occursOn(r, "2026-04-02") && !occursOn(r, "2026-03-10"),
              "ежегодный ряд переезжает на новый день и месяц");
    }
    {
        State state = createEmptyState();
        state.tasks = {task("s", [](Task &t) { t.repeat = rep("daily", 3, "2026-10-05"); })};
        const auto created = std::get<Task>(*splitSeries(state, SeriesKind::Task, "s", "2026-10-11",
                                                         ItemPatch{.start = "09:00", .minutes = 30}, ids0));
        updateSeries(state, SeriesKind::Task, created.id, "2026-10-11", ItemPatch{.day = "2026-10-12"});
        bool ok = ids(getTasksForDay(state, "2026-10-08")) == V({"s"});
        ok = ok && getTasksForDay(state, "2026-10-11").empty();
        const auto oct12 = getTasksForDay(state, "2026-10-12");
        ok = ok && oct12.size() == 1 && oct12[0].id == created.id && oct12[0].start == "09:00";
        ok = ok && ids(getTasksForDay(state, "2026-10-15")) == std::vector<std::string>{created.id};
        check(ok, "«это и последующие» с новым днём: прежний ряд стоит на месте, продолжение переезжает");
    }
    {
        State state = createEmptyState();
        state.tasks = {task("s", [](Task &t) {
            // Вторая отметка — вне правила (осталась от прежнего правила ряда)
            t.repeat = rep("daily", 2, "2026-10-05");
            t.occurrences = std::vector<Occurrence>{occ("2026-10-07", true), occ("2026-10-08", true)};
        })};
        updateSeries(state, SeriesKind::Task, "s", "2026-10-07", ItemPatch{.day = "2026-10-08"});
        check(sameJson(json(*state.tasks[0].occurrences), R"([{"day":"2026-10-08","done":true}])"),
              "отметка, на новый день которой ряд экземпляра не даёт, отбрасывается");
    }
}

static void goalsByDate() {
    std::printf("-- планировщик: цели питания по датам (spec 011)\n");
    const GoalValues base = {{"kcal", {2000, 100}}, {"water", {2000, 300}}};
    State state = createEmptyState();
    state.goals = base;
    state.goalPeriods = {
        {"week", "2026-10-20", "2026-10-27", {{"kcal", {2500, 100}}}},
        {"day", "2026-10-15", "2026-10-15", {{"kcal", {1500, 100}}}},
        {"inside", "2026-10-25", "2026-10-25", {{"kcal", {1200, 100}}}},
        {"long", "2026-11-01", "", {{"kcal", {2200, 100}}}},
        {"short", "2026-11-01", "2026-11-03", {{"kcal", {1800, 100}}}},
    };
    auto idOn = [&](const std::string &day) { return getGoalRecordForDay(state, day)->id; };
    bool ok = idOn("2026-10-14").empty() && idOn("2026-10-15") == "day" && idOn("2026-10-16").empty()
        && idOn("2026-10-22") == "week" && idOn("2026-10-25") == "inside" && idOn("2026-10-28").empty()
        && idOn("2026-11-02") == "short" && idOn("2026-11-10") == "long";
    State noGoals = createEmptyState();
    noGoals.goals = {};
    ok = ok && !getGoalRecordForDay(noGoals, TODAY);
    ok = ok && validateGoalRecord({"", "2026-11-05", "2026-11-01", base}) == "endDay";
    ok = ok && validateGoalRecord({"", "2026-11-05", "", {}}) == "empty";
    ok = ok && validateGoalRecord({"", "", "", {{"fiber", {10, 20}}}}) == "fiber";
    check(ok, "SC-004: накрывающая запись — позже начатая, затем короче; иначе цели «с самого начала»");

    State foodState = createEmptyState();
    foodState.goals = base;
    foodState.goals["fiber"] = {30, 5};
    foodState.nutrition[TODAY] = nday({food("a", 2000, [](FoodEntry &f) { f.fiber = 20; })}, true, [&](NutritionDay &d) {
        GoalValues fixed = base;
        fixed["fiber"] = {30, 5};
        d.fixedGoals = fixed;
        d.waterMl = 1500;
    });
    foodState.nutrition["2026-10-07"] = nday({food("b", 1000)}, true, [](NutritionDay &d) {
        d.fixedGoals = GoalValues{{"kcal", {1000, 100}}};
        d.waterMl = 2000;
    });
    ok = getNutrientTotal(foodState, TODAY, "water") == NutrientTotal{1500, 0, 1};
    ok = ok && getNutrientStatus(foodState, TODAY, "water", TODAY) == "below";
    ok = ok && getNutrientStatus(foodState, TODAY, "fiber", TODAY) == "below";
    ok = ok && getNutrientStatus(foodState, TODAY, "protein", TODAY) == "nogoal";
    ok = ok && getNutrientStatus(foodState, "2026-10-07", "water", TODAY) == "nogoal";
    ok = ok && getNutrientStatus(foodState, "2026-10-07", "fiber", TODAY) == "nogoal";
    ok = ok && getNutrientStatus(foodState, "2026-10-06", "water", TODAY) == "none";
    const auto stat = getNutrientStatistics(foodState, {"2026-10-07", TODAY}, "water", TODAY);
    ok = ok && stat.recorded == V({"2026-10-07", "2026-10-08"}) && stat.withGoal == V({"2026-10-08"}) && stat.inGoal == 0
        && stat.average == 1750.0;
    check(ok, "статусы по воде и клетчатке; показатель без цели — только факт");
}

static void statisticsAndStorage() {
    std::printf("-- планировщик: статистика времени и хранение\n");
    {
        State state = createEmptyState();
        state.projects = {"", "Учёба"};
        state.events = {event("5", "e", "10:00", "11:00", [](Event &e) { e.day = TODAY; })};
        state.tasks = {
            task("1", [](Task &t) { t.day = TODAY; t.minutes = 30; t.project = "Учёба"; }),
            task("2", [](Task &t) { t.day = TODAY; }),
            task("3", [](Task &t) { t.minutes = 500; }),
        };
        const auto all = getTimeStatistics(state, {TODAY}, {});
        check(all.total == 90 && all.unrated == 1 && getTimeStatistics(state, {TODAY}, {"Учёба"}).total == 60,
              "время по спискам и событиям; скрытая группа не входит в сумму");
    }
    {
        auto ids0 = seqIds("list");
        const json empty = createEmptyState();
        bool ok = json(normalizeState(json(), ids0)) == empty;
        ok = ok && json(normalizeState(json::parse(R"({"version":2,"tasks":[]})"), ids0)) == empty;
        const auto restored = normalizeState(json::parse(R"({"version":1,
            "tasks":[{"id":"7","name":"x","status":"nonsense","project":"Дом","day":"вчера","minutes":2}],
            "events":[{"id":"9","name":"e","start":"25:00","end":"26:00"}],
            "projects":["Работа"]})"),
                                             ids0);
        const auto &t = restored.tasks[0];
        ok = ok && t.id == "7" && t.status == "queue" && t.project == "Дом" && t.description.empty() && t.steps.empty();
        ok = ok && !t.day && !t.minutes && restored.events.empty();
        ok = ok && restored.projects == V({"", "Работа", "Дом"});
        std::vector<std::string> listNames;
        for (const auto &l : restored.lists) listNames.push_back(l.name);
        ok = ok && listNames == V({"Работа", "Дом"});
        // Описание события: строка сохраняется, пустое либо негодное значение — «описания нет»
        const auto events = normalizeState(json::parse(R"({"version":1,"tasks":[],"projects":[],"events":[
            {"id":"a","name":"пара","start":"15:00","end":"16:45","day":"2026-10-13","description":"будет тест"},
            {"id":"b","name":"созвон","start":"10:00","end":"11:00","day":"2026-10-13","description":""},
            {"id":"c","name":"обед","start":"13:00","end":"14:00","day":"2026-10-13","description":5},
            {"id":"d","name":"ужин","start":"19:00","end":"20:00","day":"2026-10-13"}]})"),
                                           ids0)
                                .events;
        ok = ok && events.size() == 4 && events[0].description == "будет тест" && !events[1].description
            && !events[2].description && !events[3].description;
        check(ok, "негодное сохранённое состояние — пустой планировщик, годное приводится к форме");
    }
}

static void calendarViews() {
    std::printf("-- планировщик: виды календаря и навигация (spec 013)\n");
    {
        bool ok = getWeekKeys(TODAY)
            == V({"2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"});
        // Октябрь 2026 начинается в четверг: три дня сентября в начале, один день ноября в конце
        const auto grid = getMonthGridKeys(2026, 10);
        ok = ok && grid.size() == 35 && grid[0] == "2026-09-28" && grid[3] == "2026-10-01" && grid[34] == "2026-11-01";
        ok = ok && getYearKeys(2028).size() == 366 && getYearKeys(2026)[0] == "2026-01-01";
        check(ok, "неделя с понедельника, сетка месяца полными неделями, год");
    }
    check(shiftPeriod("day", TODAY, 1) == "2026-10-09" && shiftPeriod("week", TODAY, -1) == "2026-10-01"
              && shiftPeriod("agenda", TODAY, 1) == "2026-10-15" && shiftPeriod("month", "2026-12-31", 2) == "2027-02-28"
              && shiftPeriod("month", "2026-01-15", -1) == "2025-12-15"
              && shiftPeriod("year", "2028-02-29", 1) == "2029-02-28",
          "стрелки листают период вида");
    {
        State state = createEmptyState();
        state.events = {
            event("e1", "Созвон", "10:00", "10:30", [](Event &e) {
                e.repeat = weekly({4}, "2026-10-01");
                e.occurrences = std::vector<Occurrence>{occ("2026-10-15", std::nullopt, true)};
            }),
            event("e2", "Праздник", "00:00", "23:59", [](Event &e) {
                e.day = TODAY;
                e.isAllDay = true;
                e.isHoliday = true;
            }),
        };
        state.tasks = {
            task("t1", [](Task &t) { t.day = TODAY; t.minutes = 45; }),
            task("t2", [](Task &t) { t.due = "2026-10-09"; }),
            task("t3", [](Task &t) { t.minutes = 20; t.repeat = rep("daily", 2, "2026-10-07"); }),
        };
        const auto index = getDayIndex(state, "2026-10-01", "2026-10-31");
        const auto &today = index.at(TODAY);
        bool ok = ids(today.events) == V({"e2", "e1"}) && today.isHoliday;
        // Весь день в минуты не входит: созвон 30 + задача 45
        ok = ok && today.minutes == 75 && today.minutes == getDayLoad(state, TODAY);
        ok = ok && index.count("2026-10-15") && index.at("2026-10-15").events.empty();
        ok = ok && ids(index.at("2026-10-09").deadlines) == V({"t2"});
        ok = ok && ids(index.at("2026-10-09").tasks) == V({"t3"});
        ok = ok && index.at("2026-10-09").tasks[0].instanceDay == "2026-10-09";
        ok = ok && isHolidayOn(state, TODAY) && !isHolidayOn(state, "2026-10-09");
        check(ok, "индекс дней совпадает с функциями дня и развёрнут по рядам");
    }
    {
        State state = createEmptyState();
        for (int i = 0; i < 400; ++i) {
            char day[16];
            std::snprintf(day, sizeof day, "2026-%02d-%02d", (i % 12) + 1, (i % 28) + 1);
            state.tasks.push_back(task("t" + std::to_string(i), [&](Task &t) { t.day = std::string(day); }));
        }
        for (int i = 0; i < 100; ++i) {
            state.events.push_back(event("e" + std::to_string(i), "Ряд", "10:00", "11:00",
                                         [&](Event &e) { e.repeat = weekly({i % 7}, "2026-01-01"); }));
        }
        const auto started = std::chrono::steady_clock::now();
        const auto index = getDayIndex(state, "2026-01-01", "2026-12-31");
        const auto ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
        check(ms < 500 && index.size() == 365, "год с 500 делами индексируется быстро (SC-003)");
    }
}

static void allDayAndColors() {
    std::printf("-- планировщик: событие на весь день, цвет списка, статусы (spec 013)\n");
    {
        Event allDay = event("e", "Отпуск", "00:00", "23:59", [](Event &e) {
            e.day = TODAY;
            e.isAllDay = true;
        });
        bool ok = !validateEvent(allDay);
        Event blank = allDay;
        blank.start = "";
        blank.end = "";
        ok = ok && !validateEvent(blank);
        Event notAll = allDay;
        notAll.isAllDay = false;
        notAll.start = "12:00";
        notAll.end = "11:00";
        ok = ok && validateEvent(notAll) == "time";
        State state = createEmptyState();
        state.events = {allDay};
        state.tasks = {task("1", [](Task &t) { t.day = TODAY; t.start = "10:00"; t.minutes = 60; })};
        ok = ok && getDayLoad(state, TODAY) == 60 && countConflicts(state, TODAY) == 0
            && !getDayAvailability(state, TODAY).free.empty() && getTimeStatistics(state, {TODAY}, {}).total == 60;
        check(ok, "весь день не требует времени и не занимает день");
    }
    check(getDefaultEventEnd("14:00") == "15:00" && getDefaultEventEnd("23:30") == "23:59",
          "конец события по умолчанию — через час, не позже конца суток");
    {
        const auto state = normalizeState(json::parse(R"({"version":1,
            "tasks":[{"id":"a","name":"Задача","description":"","steps":[],"status":"later","project":"","rank":1},
                     {"id":"b","name":"Задача","description":"","steps":[],"status":"waiting","project":"Дом","rank":1}],
            "projects":["","Дом"],
            "lists":[{"id":"l1","name":"Дом","order":0,"color":3},{"id":"l2","name":"Работа","order":1,"color":12}]})"),
                                          seqIds());
        check(state.tasks[0].status == "queue" && state.tasks[1].status == "queue" && getListColor(state, "Дом") == 3
                  && getListColor(state, "Работа") == 0 && getListColor(state, "") == 0,
              "прежние статусы «позже» и «жду» читаются как «в очереди», цвет списка в пределах палитры");
    }
}

static void dayClosed() {
    std::printf("-- планировщик: день питания завершается сам (spec 013)\n");
    const std::string dayBefore = "2026-10-07";
    auto make = [&]() {
        State state = createEmptyState();
        state.nutrition[dayBefore] = nday({food("a", 2000, [](FoodEntry &f) { f.meal = "other"; })}, false);
        state.nutrition[TODAY] = nday({food("b", 2000, [](FoodEntry &f) { f.meal = "other"; })}, false);
        state.goals = {{"kcal", {2000, 100}}};
        return state;
    };
    {
        const auto state = make();
        check(isDayClosed(state, dayBefore, TODAY) && !isDayClosed(state, TODAY, TODAY)
                  && getNutrientStatus(state, dayBefore, "kcal", TODAY) == "ok"
                  && getNutrientStatus(state, TODAY, "kcal", TODAY) == "open",
              "прошедший день закрыт, сегодняшний открыт");
    }
    {
        auto state = make();
        bool ok = freezePastGoals(state, TODAY) == 1;
        state.goals = {{"kcal", {1000, 50}}};
        ok = ok && getGoalsForDay(state, dayBefore, TODAY).at("kcal").target == 2000;
        ok = ok && getNutrientStatus(state, dayBefore, "kcal", TODAY) == "ok";
        ok = ok && getGoalsForDay(state, TODAY, TODAY).at("kcal").target == 1000;
        // Повторная заморозка уже зафиксированное не трогает
        ok = ok && freezePastGoals(state, TODAY) == 0 && !state.nutrition[TODAY].fixedGoals;
        check(ok, "правка цели не переоценивает прошедшие дни");
    }
}

static void layout() {
    std::printf("-- раскладка пересечений в сетке часов\n");
    auto timed = [](const std::string &name, const std::string &start, const std::string &end) {
        return Timed{name, start, end, std::nullopt, std::nullopt};
    };
    auto byName = [](const std::vector<TimedLayout> &items) {
        std::map<std::string, std::vector<int>> out;
        for (const auto &e : items) out[e.item.name] = {e.lane, e.right, e.lanes};
        return out;
    };
    using M = std::map<std::string, std::vector<int>>;
    check(byName(layoutTimed({timed("a", "09:00", "10:00"), timed("b", "10:00", "11:00")}))
              == M{{"a", {0, 1, 1}}, {"b", {0, 1, 1}}},
          "дела без пересечений занимают всю ширину");
    // Случай со скриншота пользователя (10 окт 2026)
    const auto l = byName(layoutTimed({timed("тест", "02:40", "03:40"), timed("йц", "02:50", "03:50"),
                                       timed("долгое", "03:00", "09:00"), timed("тт", "04:00", "05:00"),
                                       timed("позже", "04:30", "05:00")}));
    check(l.at("тест") == std::vector<int>{0, 1, 3} && l.at("йц") == std::vector<int>{1, 2, 3}
              && l.at("долгое") == std::vector<int>{2, 3, 3} && l.at("тт") == std::vector<int>{0, 1, 3}
              && l.at("позже") == std::vector<int>{1, 2, 3},
          "начавшиеся почти одновременно стоят рядом, начавшееся позже ложится поверх со сдвигом");
    check(byName(layoutTimed({timed("раннее", "09:00", "12:00"), timed("позднее", "10:00", "11:00")}))
              == M{{"раннее", {0, 2, 2}}, {"позднее", {1, 2, 2}}},
          "дело, начавшееся заметно позже, не сужает раннее");
}

static void undated() {
    std::printf("-- планировщик: задачи без даты\n");
    State state = createEmptyState();
    state.tasks = {
        task("a", [](Task &t) { t.rank = 3; }),
        task("b", [](Task &t) { t.rank = 1; t.due = "2026-10-20"; }),
        task("c", [](Task &t) { t.rank = 5; t.status = "active"; }),
        task("d", [](Task &t) { t.rank = 0; t.day = TODAY; }),
        task("e", [](Task &t) { t.rank = 0; t.status = "done"; }),
        task("f", [](Task &t) { t.rank = 0; t.repeat = rep("daily", 1, TODAY); }),
    };
    check(ids(getUndatedTasks(state)) == V({"c", "b", "a"}),
          "берёт незавершённые без даты работы и не ряды; «в работе» первыми, дальше по рангу");
}

// ── plannerIndex.test.ts ─────────────────────────────────────────────────────

static bool isDayKeyNaive(const std::string &day) { return isDayKey(day); }

static long long epochNaive(const std::string &day) {
    // Через `addDays` от известной точки: дни между ключами
    const int y = std::stoi(day.substr(0, 4));
    const int m = std::stoi(day.substr(5, 2));
    const int d = std::stoi(day.substr(8, 2));
    // days_from_civil
    const int yy = y - (m <= 2);
    const long long era = (yy >= 0 ? yy : yy - 399) / 400;
    const long long yoe = yy - era * 400;
    const long long doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    const long long doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + doe - 719468;
}

static long long floorDivT(long long a, long long b) {
    long long q = a / b;
    if ((a % b != 0) && ((a < 0) != (b < 0))) --q;
    return q;
}
static long long weekIndexNaive(const std::string &day) { return floorDivT(epochNaive(day) + 3, 7); }
static int dimNaive(int year, int month) {
    static const int days[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
    if (month == 2) return ((year % 4 == 0 && year % 100 != 0) || year % 400 == 0) ? 29 : 28;
    return days[month - 1];
}
static int weekdayNaive(const std::string &day) { return static_cast<int>(((epochNaive(day) + 4) % 7 + 7) % 7); }
static int mondayBasedT(int w) { return (w + 6) % 7; }

// Прежний порядковый номер экземпляра — как в plannerModel.ts до ревью
static std::optional<long long> ordinalOfNaive(const Repeat &repeat, const std::string &day) {
    if (!isDayKeyNaive(day) || repeat.interval < 1) return std::nullopt;
    if (!repeat.startDay.empty() && day < repeat.startDay) return std::nullopt;
    if (repeat.endDay && !repeat.endDay->empty() && day > *repeat.endDay) return std::nullopt;
    const int dy = std::stoi(day.substr(0, 4)), dm = std::stoi(day.substr(5, 2)), dd = std::stoi(day.substr(8, 2));
    const long long interval = repeat.interval;
    if (repeat.kind == "weekly") {
        auto weekdays = repeat.weekdays.value_or(std::vector<int>());
        std::stable_sort(weekdays.begin(), weekdays.end(),
                         [](int a, int b) { return mondayBasedT(a) < mondayBasedT(b); });
        const auto it = std::find(weekdays.begin(), weekdays.end(), weekdayNaive(day));
        if (it == weekdays.end()) return std::nullopt;
        const long long index = it - weekdays.begin();
        if (repeat.startDay.empty()) return 1;
        const long long weeks = weekIndexNaive(day) - weekIndexNaive(repeat.startDay);
        if (weeks % interval != 0) return std::nullopt;
        const int startPosition = mondayBasedT(weekdayNaive(repeat.startDay));
        long long skipped = 0;
        for (int w : weekdays) {
            if (mondayBasedT(w) < startPosition) ++skipped;
        }
        return (weeks / interval) * static_cast<long long>(weekdays.size()) + index + 1 - skipped;
    }
    if (repeat.startDay.empty()) return std::nullopt;
    const int sy = std::stoi(repeat.startDay.substr(0, 4)), sm = std::stoi(repeat.startDay.substr(5, 2)),
              sd = std::stoi(repeat.startDay.substr(8, 2));
    if (repeat.kind == "daily") {
        const long long diff = epochNaive(day) - epochNaive(repeat.startDay);
        return diff % interval == 0 ? std::optional<long long>(diff / interval + 1) : std::nullopt;
    }
    if (repeat.kind == "monthly") {
        const long long months = (dy * 12LL + dm) - (sy * 12LL + sm);
        if (months % interval != 0) return std::nullopt;
        const int wanted = std::min(repeat.monthDay && *repeat.monthDay ? *repeat.monthDay : sd, dimNaive(dy, dm));
        return dd == wanted ? std::optional<long long>(months / interval + 1) : std::nullopt;
    }
    const long long years = dy - sy;
    if (years % interval != 0 || dm != sm) return std::nullopt;
    const int wanted = std::min(sd, dimNaive(dy, dm));
    return dd == wanted ? std::optional<long long>(years / interval + 1) : std::nullopt;
}

static bool occursOnNaive(const Repeat &repeat, const std::string &day) {
    const auto ordinal = ordinalOfNaive(repeat, day);
    if (!ordinal) return false;
    return !repeat.count || !*repeat.count || *ordinal <= *repeat.count;
}

static std::vector<std::string> allDays(const std::string &from, const std::string &to) {
    std::vector<std::string> days;
    for (auto day = from; day <= to; day = addDays(day, 1)) days.push_back(day);
    return days;
}

static std::vector<std::string> expandNaive(const Repeat &repeat, const std::string &from, const std::string &to) {
    std::vector<std::string> days;
    for (const auto &day : allDays(from, to)) {
        if (occursOnNaive(repeat, day)) days.push_back(day);
    }
    return days;
}

static std::optional<Task> nextOpenNaive(const Task &t, const std::string &today) {
    for (int i = 0; i < 366; ++i) {
        const auto day = addDays(today, i);
        if (hasInstanceOn(t, day) && !isInstanceDone(t, day)) return taskInstance(t, day);
    }
    return std::nullopt;
}

static std::vector<std::pair<std::string, Repeat>> rules() {
    return {
        {"каждый день", rep("daily", 1, "2026-01-15")},
        {"каждые 3 дня, до даты", rep("daily", 3, "2026-01-15", [](Repeat &r) { r.endDay = "2026-03-01"; })},
        {"каждые 7 дней, 5 раз", rep("daily", 7, "2026-12-29", [](Repeat &r) { r.count = 5; })},
        {"по будням", weekly({1, 2, 3, 4, 5}, "2026-01-14")},
        {"раз в 2 недели, пн и вс (начало в среду)", weekly({0, 1}, "2026-01-14", [](Repeat &r) { r.interval = 2; })},
        {"раз в 3 недели, сб и вс, 4 раза", weekly({6, 0}, "2026-01-17", [](Repeat &r) {
             r.interval = 3;
             r.count = 4;
         })},
        {"по дням недели без начала (унаследованный ряд)", weekly({2, 4}, "")},
        {"по дням недели без начала, до даты", weekly({3}, "", [](Repeat &r) { r.endDay = "2026-02-10"; })},
        {"каждый месяц 31-го", rep("monthly", 1, "2026-01-31", [](Repeat &r) { r.monthDay = 31; })},
        {"каждые 2 месяца 10-го, начало после 10-го", rep("monthly", 2, "2026-01-20", [](Repeat &r) { r.monthDay = 10; })},
        {"каждый месяц по числу начала, 3 раза", rep("monthly", 1, "2026-01-29", [](Repeat &r) { r.count = 3; })},
        {"каждый год 29 февраля", rep("yearly", 1, "2024-02-29")},
        {"каждые 2 года, до даты", rep("yearly", 2, "2024-06-15", [](Repeat &r) { r.endDay = "2028-06-14"; })},
        {"негодный интервал", rep("daily", 0, "2026-01-15")},
        // не перенесено: «дробный интервал» (1.5) — в типах C++ шаг повтора целый
    };
}

static void repeatWalk() {
    std::printf("-- повторы: обход шагом правила (C3) совпадает с проверкой каждого дня\n");
    const std::string from = "2023-12-01", to = "2029-01-31";
    const auto days = allDays(from, to);
    for (const auto &[name, repeat] : rules()) {
        std::vector<std::string> naive, fast;
        for (const auto &day : days) {
            if (occursOnNaive(repeat, day)) naive.push_back(day);
            if (occursOn(repeat, day)) fast.push_back(day);
        }
        bool ok = fast == naive && expandRepeat(repeat, from, to) == naive;
        // Промежутки внутри ряда, в том числе пустые и из одного дня
        ok = ok && expandRepeat(repeat, "2026-02-27", "2026-03-02") == expandNaive(repeat, "2026-02-27", "2026-03-02");
        ok = ok && expandRepeat(repeat, "2026-12-31", "2027-01-05") == expandNaive(repeat, "2026-12-31", "2027-01-05");
        ok = ok && expandRepeat(repeat, "2026-03-15", "2026-03-15") == expandNaive(repeat, "2026-03-15", "2026-03-15");
        ok = ok && expandRepeat(repeat, "2026-03-15", "2026-03-14").empty();
        check(ok, name + ": occursOn по дням и expandRepeat");
    }
    check(!occursOn(rules()[0].second, "2026-1-5") && !occursOn(rules()[0].second, ""), "negодный день — не экземпляр");
    {
        bool ok = true;
        for (const auto &[name, repeat] : rules()) {
            Task t = task("r", [&](Task &x) {
                x.name = "Ряд";
                x.rank = 0;
                x.repeat = repeat;
                x.occurrences = std::vector<Occurrence>{occ("2026-01-15", true), occ("2026-01-16", std::nullopt, true),
                                                        occ("2026-02-10", true)};
            });
            for (const auto &today : V({"2025-12-31", "2026-01-15", "2026-01-16", "2026-02-10", "2027-05-05"})) {
                const auto naive = nextOpenNaive(t, today);
                const auto fast = nextOpenInstance(t, today);
                const bool sameDay = (naive ? naive->instanceDay : std::nullopt) == (fast ? fast->instanceDay : std::nullopt);
                if (!sameDay || (naive && !same(*naive, *fast))) {
                    ok = false;
                    std::printf("     расхождение: %s, %s\n", name.c_str(), today.c_str());
                }
            }
        }
        check(ok, "ближайший невыполненный экземпляр — тот же, что при переборе дней");
    }
    {
        Task t = task("t", [](Task &x) {
            x.name = "Зарядка";
            x.steps = {{"а", false}};
            x.rank = 0;
            x.repeat = rep("daily", 1, "2026-01-15");
        });
        // Тождество объектов (кэш web) не воспроизводится — сверяется содержимое
        bool ok = same(taskInstance(t, "2026-02-01"), taskInstance(t, "2026-02-01"));
        t.name = "Пробежка";
        ok = ok && taskInstance(t, "2026-02-01").name == "Пробежка";
        t.steps[0].text = "б";
        ok = ok && taskInstance(t, "2026-02-01").steps[0].text == "б";
        t.occurrences = std::vector<Occurrence>{occ("2026-02-01", true)};
        ok = ok && taskInstance(t, "2026-02-01").status == "done";
        (*t.occurrences)[0].done = false;
        ok = ok && taskInstance(t, "2026-02-01").status == "queue";
        check(ok, "экземпляр устойчив, пока шаблон тот же, и обновляется после правки шаблона на месте");
    }
}

// Детерминированный генератор (LCG): таблица состояний воспроизводима
struct Lcg {
    unsigned long long value;
    double operator()() {
        value = (value * 1664525ULL + 1013904223ULL) % 4294967296ULL;
        return static_cast<double>(value) / 4294967296.0;
    }
};

// Как web `synthState` (записи здоровья не строятся: их модуль — не этот)
static State synthState(unsigned long long seed, int count) {
    Lcg next{seed};
    const auto ruleList = rules();
    auto pickIndex = [&](size_t size) { return static_cast<size_t>(std::floor(next() * static_cast<double>(size))); };
    auto day = [&]() { return addDays("2026-01-01", static_cast<long long>(std::floor(next() * 400))); };
    const std::vector<std::string> minutesParts = {"00", "15", "30", "45"};
    auto time = [&]() {
        const int hours = static_cast<int>(std::floor(next() * 23));
        char buf[16];
        std::snprintf(buf, sizeof buf, "%02d", hours);
        return std::string(buf) + ":" + minutesParts[pickIndex(4)];
    };
    auto repeat = [&]() -> std::optional<Repeat> {
        if (next() < 0.7) return std::nullopt;
        return ruleList[pickIndex(13)].second;
    };
    auto occurrences = [&]() -> std::optional<std::vector<Occurrence>> {
        if (next() < 0.5) return std::nullopt;
        Occurrence a;
        a.day = "2026-01-15";
        a.done = next() < 0.5;
        a.doneSteps = std::vector<int>{0};
        Occurrence b;
        b.day = "2026-02-10";
        b.excluded = next() < 0.5;
        Occurrence c;
        c.day = "2026-03-31";
        c.excluded = true;
        return std::vector<Occurrence>{a, b, c};
    };
    State state = createEmptyState();
    const std::vector<std::string> statuses = {"queue", "active", "done"};
    const std::vector<std::string> projects = {"", "Дом", "Работа"};
    const std::vector<int> durations = {15, 30, 60, 120};
    for (int i = 0; i < count; ++i) {
        const auto rule = repeat();
        const bool withTime = next() < 0.5;
        Task t;
        t.id = "t" + std::to_string(i);
        t.name = "Задача " + std::to_string(i);
        if (next() < 0.3) t.steps = {{"шаг", false}, {"ещё", true}};
        t.status = statuses[pickIndex(3)];
        t.project = projects[pickIndex(3)];
        t.rank = i;
        if (!rule && next() < 0.8) t.day = day();
        if (withTime) t.start = time();
        if (withTime || next() < 0.5) t.minutes = durations[pickIndex(4)];
        if (!rule && next() < 0.3) t.due = day();
        t.repeat = rule;
        if (rule) t.occurrences = occurrences();
        if (next() < 0.2) t.source = Source{"note:n" + std::to_string(i % 7), "o" + std::to_string(i)};
        state.tasks.push_back(t);
    }
    for (int i = 0; i < count / 2; ++i) {
        const auto rule = repeat();
        const bool isAllDay = next() < 0.2;
        const auto start = time();
        Event e;
        e.id = "e" + std::to_string(i);
        e.name = "Событие " + std::to_string(i);
        e.start = isAllDay ? "00:00" : start;
        if (isAllDay) {
            e.end = "23:59";
        } else {
            char buf[16];
            std::snprintf(buf, sizeof buf, "%02d:30", std::min(23, std::stoi(start.substr(0, 2)) + 1));
            e.end = buf;
        }
        if (!rule) e.day = day();
        e.repeat = rule;
        if (rule) e.occurrences = occurrences();
        if (isAllDay) e.isAllDay = true;
        if (isAllDay && next() < 0.5) e.isHoliday = true;
        if (next() < 0.3) e.color = 3;
        state.events.push_back(e);
    }
    return state;
}

static std::vector<std::string> instanceIds(const std::vector<Task> &items) {
    std::vector<std::string> out;
    for (const auto &i : items) out.push_back(i.id + "@" + i.instanceDay.value_or(""));
    return out;
}
static std::vector<std::string> instanceIds(const std::vector<Event> &items) {
    std::vector<std::string> out;
    for (const auto &i : items) out.push_back(i.id + "@" + i.instanceDay.value_or(""));
    return out;
}

static std::vector<std::string> timedRows(const std::vector<Timed> &items) {
    std::vector<std::string> out;
    for (const auto &i : items) out.push_back(i.name + "|" + i.start + "|" + i.end);
    return out;
}

static void dayIndex() {
    std::printf("-- индекс дня (C2) совпадает с функциями дня\n");
    for (const auto &[seed, count] : std::vector<std::pair<int, int>>{{1, 60}, {7, 300}, {42, 120}}) {
        const auto state = synthState(seed, count);
        const std::string from = "2026-01-01", to = "2027-02-10";
        const auto index = getDayIndex(state, from, to);
        bool ok = true;
        std::string failedAt;
        for (const auto &day : allDays(from, to)) {
            const auto tasks = getTasksForDay(state, day);
            const auto events = getEventsForDay(state, day);
            const auto deadlines = getDeadlines(state, day);
            const auto it = index.find(day);
            bool dayOk = true;
            if (it == index.end()) {
                dayOk = tasks.empty() && events.empty() && deadlines.empty();
            } else {
                const auto &entry = it->second;
                dayOk = instanceIds(entry.tasks) == instanceIds(tasks) && same(entry.tasks, tasks)
                    && instanceIds(entry.events) == instanceIds(events)
                    && instanceIds(entry.deadlines) == instanceIds(deadlines)
                    && entry.minutes == getDayLoad(state, day) && entry.unrated == countUnrated(state, day)
                    && entry.conflicts == countConflicts(state, day) && entry.isHoliday == isHolidayOn(state, day);
                std::optional<Event> holiday;
                for (const auto &e : events) {
                    if (e.isHoliday.value_or(false)) {
                        holiday = e;
                        break;
                    }
                }
                dayOk = dayOk && json(entry.holiday) == json(holiday);
                dayOk = dayOk && timedRows(entry.timed) == timedRows(getTimedForDay(state, day));
                std::vector<Event> allDay;
                for (const auto &e : events) {
                    if (e.isAllDay.value_or(false)) allDay.push_back(e);
                }
                std::vector<Task> untimed;
                for (const auto &t : tasks) {
                    if (!t.start || t.start->empty() || !t.minutes) untimed.push_back(t);
                }
                dayOk = dayOk && same(entry.allDay, allDay) && same(entry.untimed, untimed);
                // Запись одного дня — та же по содержимому
                dayOk = dayOk && same(getDayEntry(state, day).tasks, entry.tasks);
            }
            if (!dayOk && ok) failedAt = day;
            ok = ok && dayOk;
        }
        // День вне построенных индексов — индекс одного дня
        ok = ok && same(getDayEntry(state, "2031-01-01").tasks, getTasksForDay(state, "2031-01-01"));
        ok = ok && same(getDayEntry(state, "2019-01-01").tasks, getTasksForDay(state, "2019-01-01"));
        if (!failedAt.empty()) std::printf("     первый расходящийся день: %s\n", failedAt.c_str());
        check(ok, "состояние #" + std::to_string(seed) + " из " + std::to_string(count) + " задач");
    }
    {
        // Кэша по объекту нет (и сброса `resetPlannerCaches` тоже) — повторный расчёт даёт то же
        const auto state = synthState(3, 40);
        const auto entry = getDayEntry(state, "2026-01-15");
        check(same(getDayEntry(state, "2026-01-15").tasks, entry.tasks)
                  && same(getDayEntry(state, "2026-01-15").events, entry.events),
              "индекс одного дня строится при первом обращении и переиспользуется");
    }
    {
        const auto state = synthState(5, 50);
        const auto signature = noteTasksSignature(state);
        bool ok = noteTasksSignature(state) == signature;
        auto other = state;
        for (auto &t : other.tasks) {
            if (!t.source) t.name = "x";
        }
        ok = ok && noteTasksSignature(other) == signature;
        auto changed = state;
        size_t noteIndex = 0;
        while (!changed.tasks[noteIndex].source) ++noteIndex;
        auto &noteTask = changed.tasks[noteIndex];
        noteTask.status = noteTask.status == "done" ? "queue" : "done";
        ok = ok && noteTasksSignature(changed) != signature;
        auto removed = state;
        removed.tasks.erase(removed.tasks.begin() + static_cast<long>(noteIndex));
        ok = ok && noteTasksSignature(removed) != signature;
        check(ok, "подпись задач из заметок меняется только от таких задач");
    }
    // не перенесено: «индекс здоровья (C2) совпадает с перебором записей» — `plannerHealth.ts` в этот модуль не входит
    {
        const auto state = synthState(99, 3300);
        const auto start = std::chrono::steady_clock::now();
        getDayIndex(state, "2026-01-01", "2026-12-31");
        const auto year = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
        const auto monthStart = std::chrono::steady_clock::now();
        getDayIndex(state, "2026-03-01", "2026-03-31");
        const auto month = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - monthStart).count();
        const auto naiveStart = std::chrono::steady_clock::now();
        for (const auto &day : allDays("2026-03-01", "2026-03-31")) {
            getDayLoad(state, day);
            countUnrated(state, day);
            countConflicts(state, day);
            getEventsForDay(state, day);
            getTasksForDay(state, day);
            getDeadlines(state, day);
        }
        const auto naive = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - naiveStart).count();
        std::printf("     [perf] 5 000 записей: индекс года %.1f мс, месяца %.1f мс, месяц функциями дня %.1f мс\n", year,
                    month, naive);
#ifdef __OPTIMIZE__
        const double limit = 2000; // как в web
#else
        const double limit = 10000; // сборка -O0 (light_build) медленнее оптимизированной примерно в 8 раз
#endif
        check(year < limit, "индекс года и месяца, перебор дней");
    }
}

// ── слои и подписи без Intl ──────────────────────────────────────────────────

int main() {
    std::printf("=== parvane-core planner model tests (без стека) ===\n");
    eventsAndLoad();
    slotsAndValidation();
    settingsAndOrder();
    nutrition();
    repeats();
    updateAll();
    goalsByDate();
    statisticsAndStorage();
    calendarViews();
    allDayAndColors();
    dayClosed();
    layout();
    undated();
    repeatWalk();
    dayIndex();
    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
