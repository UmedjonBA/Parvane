// Parvane fork (spec 029, фаза 4): тесты правок рядов, групп, расписания и слоёв «Плана» — перенос web
// `plannerSeriesEdit.test.ts`, `plannerSeriesRule.test.ts`, `plannerGroups.test.ts`, `plannerSchedule.test.ts`,
// `plannerLayers.test.ts` (по одной проверке на `it`, имена — как в web).
// Правки задаются назначенными инициализаторами: остальные поля намеренно пусты
#pragma GCC diagnostic ignored "-Wmissing-field-initializers"

#include <algorithm>
#include <cstdio>
#include <functional>
#include <memory>
#include <set>
#include <string>
#include <vector>

#include "parvane/sections/planner_groups.h"
#include "parvane/sections/planner_model.h"
#include "parvane/sections/planner_schedule.h"
#include "parvane/sections/planner_series.h"

using namespace parvane::sections::planner;
using nlohmann::json;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name) {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}

static IdGen seqIds(const std::string &prefix = "id") {
    auto n = std::make_shared<int>(0);
    return [n, prefix]() { return prefix + std::to_string(++*n); };
}

static std::vector<std::string> V(std::initializer_list<const char *> items) {
    return std::vector<std::string>(items.begin(), items.end());
}

template <typename T>
static std::vector<std::string> ids(const std::vector<T> &items) {
    std::vector<std::string> out;
    for (const auto &item : items) out.push_back(item.id);
    return out;
}

static bool sameJson(const json &a, const char *expected) { return a == json::parse(expected); }

// 12 октября 2026 — понедельник
static const std::string MONDAY = "2026-10-12";
static const std::string NEXT_MONDAY = "2026-10-19";

static Repeat weeklyRepeat(std::vector<int> weekdays = {1}) {
    Repeat r;
    r.kind = "weekly";
    r.interval = 1;
    r.weekdays = weekdays;
    r.startDay = MONDAY;
    return r;
}
static const Repeat WEEKLY = weeklyRepeat();

static Event event(const std::function<void(Event &)> &edit = nullptr) {
    Event e;
    e.id = "e1";
    e.name = "Йога";
    e.start = "18:00";
    e.end = "19:00";
    e.repeat = WEEKLY;
    if (edit) edit(e);
    return e;
}

static Task task(const std::function<void(Task &)> &edit = nullptr) {
    Task t;
    t.id = "t1";
    t.name = "Зарядка";
    t.rank = 1;
    t.start = "10:00";
    t.minutes = 15;
    Repeat r;
    r.kind = "daily";
    r.interval = 1;
    r.startDay = MONDAY;
    t.repeat = r;
    if (edit) edit(t);
    return t;
}

static std::vector<std::string> descriptionsOn(const State &state, const std::string &day) {
    std::vector<std::string> out;
    for (const auto &e : getEventsForDay(state, day)) out.push_back(e.description.value_or(""));
    for (const auto &t : getTasksForDay(state, day)) out.push_back(t.description);
    return out;
}

template <typename T>
static T as(const std::optional<SeriesItem> &item) {
    return std::get<T>(*item);
}

static const Event *findById(const State &state, const std::string &id) {
    for (const auto &e : state.events) {
        if (e.id == id) return &e;
    }
    return nullptr;
}

// ── plannerSeriesEdit.test.ts ────────────────────────────────────────────────

static void descriptionScope() {
    std::printf("-- планировщик: описание ряда — всех повторов или одного дня\n");
    auto ids0 = seqIds("copy");
    {
        State state = createEmptyState();
        const auto detached = addEntry(state, SeriesKind::Event, event([](Event &e) { e.description = "Взять коврик"; }),
                                       DescriptionScope::All, MONDAY, ids0);
        check(!detached && state.events.size() == 1 && descriptionsOn(state, MONDAY) == V({"Взять коврик"})
                  && descriptionsOn(state, NEXT_MONDAY) == V({"Взять коврик"}),
              "новый ряд с описанием «для всех»: одна запись, описание у каждого повтора");
    }
    {
        State state = createEmptyState();
        const auto detached = addEntry(state, SeriesKind::Event, event([](Event &e) { e.description = "Взять коврик"; }),
                                       DescriptionScope::One, MONDAY, ids0);
        bool ok = state.events.size() == 2;
        const auto &series = state.events[0];
        ok = ok && series.id == "e1" && !series.description && json(*series.repeat) == json(WEEKLY)
            && sameJson(json(*series.occurrences), R"([{"day":"2026-10-12","excluded":true}])");
        const auto copy = as<Event>(detached);
        ok = ok && copy.name == "Йога" && copy.description == "Взять коврик" && copy.day == MONDAY
            && copy.origin->seriesId == "e1" && copy.origin->day == MONDAY && !copy.repeat;
        // В первый день — одна запись (копия), через неделю — экземпляр ряда без описания
        ok = ok && descriptionsOn(state, MONDAY) == V({"Взять коврик"}) && descriptionsOn(state, NEXT_MONDAY) == V({""});
        check(ok, "новый ряд с описанием «только этого дня»: ряд без описания, первый день — отделённой копией с описанием");
    }
    {
        const Repeat repeat = weeklyRepeat({3});
        bool ok = firstSeriesDay(repeat, MONDAY) == "2026-10-14";
        State state = createEmptyState();
        const auto detached = as<Task>(addEntry(state, SeriesKind::Task, task([&](Task &t) {
                                                    t.description = "Первое занятие";
                                                    t.repeat = repeat;
                                                }),
                                                DescriptionScope::One, MONDAY, ids0));
        ok = ok && detached.day == "2026-10-14" && detached.description == "Первое занятие" && detached.start == "10:00"
            && detached.minutes == 15;
        ok = ok && state.tasks[0].id == "t1" && state.tasks[0].description.empty();
        ok = ok && descriptionsOn(state, "2026-10-21") == V({""});
        check(ok, "первый день считается по правилу, а не по дате начала: ряд по средам с понедельника");
    }
    {
        // Начало в среду, день ряда — понедельник: неделя начала экземпляра не даёт
        Repeat repeat = weeklyRepeat({1});
        repeat.interval = 2;
        repeat.startDay = "2026-10-14";
        check(firstSeriesDay(repeat, MONDAY) == "2026-10-26",
              "ряд раз в две недели, первая неделя без экземпляра: первый день — через шаг");
    }
    {
        State empty = createEmptyState();
        bool ok = !addEntry(empty, SeriesKind::Event, event(), DescriptionScope::One, MONDAY, ids0) && empty.events.size() == 1;
        // Ряд кончается раньше первого экземпляра
        Repeat none = weeklyRepeat({5});
        none.endDay = "2026-10-13";
        State state = createEmptyState();
        const auto withText = event([&](Event &e) {
            e.description = "Текст";
            e.repeat = none;
        });
        ok = ok && !addEntry(state, SeriesKind::Event, withText, DescriptionScope::One, MONDAY, ids0);
        ok = ok && json(state.events) == json(std::vector<Event>{withText});
        // Разовая запись создаётся как есть
        State single = createEmptyState();
        const auto once = event([](Event &e) {
            e.description = "Текст";
            e.repeat.reset();
            e.day = MONDAY;
        });
        addEntry(single, SeriesKind::Event, once, DescriptionScope::One, MONDAY, ids0);
        ok = ok && json(single.events) == json(std::vector<Event>{once});
        check(ok, "без описания и без первого дня ничего не отделяется, описание не теряется");
    }
    {
        State state = createEmptyState();
        state.events = {event([](Event &e) { e.description = "Старое"; })};
        detachInstance(state, SeriesKind::Event, "e1", MONDAY, ItemPatch{.description = "Своё"}, ids0);
        const auto instance = eventInstance(state.events[0], NEXT_MONDAY);
        const auto result = setDescription(state, SeriesKind::Event, instance, "Новое", DescriptionScope::All, ids0);
        check(itemId(*result) == "e1" && state.events.size() == 2 && descriptionsOn(state, MONDAY) == V({"Своё"})
                  && descriptionsOn(state, NEXT_MONDAY) == V({"Новое"}) && descriptionsOn(state, "2026-10-26") == V({"Новое"}),
              "правка описания у экземпляра: «для всех» — шаблон, отделённые дни хранят своё");
    }
    {
        State state = createEmptyState();
        state.tasks = {task([](Task &t) { t.description = "Общее"; })};
        const auto instance = taskInstance(state.tasks[0], "2026-10-13");
        const auto result = as<Task>(setDescription(state, SeriesKind::Task, instance, "Только сегодня",
                                                    DescriptionScope::One, ids0));
        bool ok = result.description == "Только сегодня" && result.day == "2026-10-13" && result.origin->seriesId == "t1"
            && result.origin->day == "2026-10-13" && result.id != "t1";
        ok = ok && state.tasks[0].description == "Общее";
        ok = ok && descriptionsOn(state, "2026-10-13") == V({"Только сегодня"}) && descriptionsOn(state, "2026-10-14") == V({"Общее"});
        check(ok, "правка описания у экземпляра: «только этот день» — день отделяется, у ряда описание прежнее");
    }
    {
        State state = createEmptyState();
        state.events = {event([](Event &e) { e.description = "Было"; })};
        state.tasks = {task([](Task &t) { t.description = "Было"; })};
        setDescription(state, SeriesKind::Event, eventInstance(state.events[0], MONDAY), "", DescriptionScope::All, ids0);
        setDescription(state, SeriesKind::Task, taskInstance(state.tasks[0], MONDAY), "", DescriptionScope::All, ids0);
        check(!state.events[0].description && state.tasks[0].description.empty(),
              "пустое описание у события — отсутствие значения, у задачи — пустая строка");
    }
    {
        State state = createEmptyState();
        state.events = {event([](Event &e) { e.description = "Общее"; })};
        const auto series = state.events[0];
        bool ok = getDescriptionScope(state, SeriesKind::Event, eventInstance(series, MONDAY)) == DescriptionScope::All;
        // Шаблон ряда и разовая запись — без галочки
        ok = ok && !getDescriptionScope(state, SeriesKind::Event, series);
        ok = ok && !getDescriptionScope(state, SeriesKind::Event, event([](Event &e) {
            e.id = "e9";
            e.repeat.reset();
            e.day = MONDAY;
        }));
        const auto same = detachInstance(state, SeriesKind::Event, "e1", MONDAY, ItemPatch{.start = "19:00"}, ids0);
        ok = ok && getDescriptionScope(state, SeriesKind::Event, *same) == DescriptionScope::All;
        const auto own = detachInstance(state, SeriesKind::Event, "e1", NEXT_MONDAY, ItemPatch{.description = "Своё"}, ids0);
        ok = ok && getDescriptionScope(state, SeriesKind::Event, *own) == DescriptionScope::One;
        // Ряд удалён — отделённый день становится обычной разовой записью
        std::erase_if(state.events, [](const Event &e) { return e.id == "e1"; });
        ok = ok && !getDescriptionScope(state, SeriesKind::Event, *own);
        check(ok, "галочка у открытой записи: экземпляр — «для всех», отделённый день — по совпадению с рядом");
    }
    {
        State state = createEmptyState();
        state.events = {event([](Event &e) { e.description = "Общее"; })};
        const auto copy = *detachInstance(state, SeriesKind::Event, "e1", MONDAY, ItemPatch{}, ids0);
        setDescription(state, SeriesKind::Event, copy, "Только копия", DescriptionScope::One, ids0);
        bool ok = state.events[0].description == "Общее" && descriptionsOn(state, MONDAY) == V({"Только копия"});
        setDescription(state, SeriesKind::Event, copy, "И ряду тоже", DescriptionScope::All, ids0);
        ok = ok && descriptionsOn(state, MONDAY) == V({"И ряду тоже"}) && descriptionsOn(state, NEXT_MONDAY) == V({"И ряду тоже"});
        // Перенос: копия остаётся отделённой, ряд получает её описание
        setDescription(state, SeriesKind::Event, copy, "Третье", DescriptionScope::One, ids0);
        Event current = *findById(state, itemId(copy));
        ok = ok && getDescriptionScope(state, SeriesKind::Event, current) == DescriptionScope::One;
        ok = ok && shareDescription(state, SeriesKind::Event, current);
        ok = ok && state.events.size() == 2 && descriptionsOn(state, NEXT_MONDAY) == V({"Третье"});
        ok = ok && getDescriptionScope(state, SeriesKind::Event, current) == DescriptionScope::All;
        ok = ok && !shareDescription(state, SeriesKind::Event, event([](Event &e) {
            e.id = "e9";
            e.repeat.reset();
            e.day = MONDAY;
        }));
        check(ok, "отделённый день: своё описание; «для всех» пишет его и в ряд; перенос описания в ряд");
    }
    {
        State state = createEmptyState();
        state.events = {event()};
        const auto copy = detachWithDescription(state, SeriesKind::Event, "e1", NEXT_MONDAY, "Свой текст", ids0);
        bool ok = copy && as<Event>(copy).day == NEXT_MONDAY && as<Event>(copy).description == "Свой текст";
        ok = ok && !detachWithDescription(state, SeriesKind::Event, "e1", "2026-10-20", "Нет экземпляра", ids0);
        ok = ok && state.events.size() == 2;
        check(ok, "своё описание дня после правки остальных полей у ряда: день отделяется, если ряд его даёт");
    }
}

static void copiesForAll() {
    std::printf("-- планировщик: правка отделённого дня и правка «для всех»\n");
    const std::string MOVED = "2026-10-13";
    const std::string LATER_MONDAY = "2026-10-26";
    auto ids0 = seqIds("copy");
    auto seriesWithCopies = [&](State &state, Event &moved, Event &late) {
        state = createEmptyState();
        state.events = {event()};
        // Первый понедельник перенесён на вторник, третий — со своим временем
        moved = as<Event>(detachInstance(state, SeriesKind::Event, "e1", MONDAY, ItemPatch{.day = MOVED}, ids0));
        late = as<Event>(detachInstance(state, SeriesKind::Event, "e1", LATER_MONDAY,
                                        ItemPatch{.start = "20:00", .end = "21:00"}, ids0));
    };
    {
        const auto before = event([](Event &e) { e.day = MONDAY; });
        const auto fields = changedFields(
            before, ItemPatch{.name = "Пилатес", .start = "18:00", .end = "19:00", .day = MOVED});
        const auto taskFields = changedFields(task(), ItemPatch{.status = "done", .minutes = 30});
        check(sameJson(fields.toJson(), R"({"name":"Пилатес"})") && sameJson(taskFields.toJson(), R"({"minutes":30})"),
              "изменённые поля — только то, что отличается, без своего дня и отметки");
    }
    {
        State state;
        Event moved, late;
        seriesWithCopies(state, moved, late);
        const auto series = seriesOfCopy(state, SeriesKind::Event, moved);
        bool ok = series && itemId(*series) == "e1";
        state.events[0].repeat.reset();
        ok = ok && !seriesOfCopy(state, SeriesKind::Event, moved);
        check(ok, "отделённый день знает свой ряд, пока тот повторяется");
    }
    {
        State state;
        Event moved, late;
        seriesWithCopies(state, moved, late);
        updateFromCopy(state, SeriesKind::Event, moved, ItemPatch{.name = "Пилатес"});
        auto names = [&](const std::string &day) {
            std::vector<std::string> out;
            for (const auto &e : getEventsForDay(state, day)) out.push_back(e.name);
            return out;
        };
        bool ok = names(MOVED) == V({"Пилатес"}) && names(NEXT_MONDAY) == V({"Пилатес"});
        const auto lateDay = getEventsForDay(state, LATER_MONDAY);
        ok = ok && lateDay.size() == 1 && lateDay[0].name == "Пилатес" && lateDay[0].start == "20:00";
        ok = ok && findById(state, late.id)->day == LATER_MONDAY && getEventsForDay(state, MONDAY).empty();
        check(ok, "правка копии «для всех»: ряд и все отделённые дни, у каждого свой день остаётся");
    }
    {
        State state;
        Event moved, late;
        seriesWithCopies(state, moved, late);
        bool ok = patchCopies(state, SeriesKind::Event, "e1", ItemPatch{.name = "Пилатес"}, NEXT_MONDAY) == 1;
        ok = ok && findById(state, moved.id)->name == "Йога" && findById(state, late.id)->name == "Пилатес";
        ok = ok && patchCopies(state, SeriesKind::Event, "e1", ItemPatch{.color = 3}) == 2;
        ok = ok && patchCopies(state, SeriesKind::Event, "e1", ItemPatch{}) == 0;
        check(ok, "правка ряда «для всех» доходит до отделённых дней; «с этого дня» — только до поздних");
    }
}

// ── plannerSeriesRule.test.ts ────────────────────────────────────────────────

static void seriesRule() {
    std::printf("-- планировщик: смена правила повтора у экземпляра\n");
    auto ids0 = seqIds("rule");
    {
        auto with = [](const std::function<void(Repeat &)> &edit) {
            Repeat r = WEEKLY;
            edit(r);
            return r;
        };
        bool ok = sameRepeat(std::nullopt, std::nullopt) && !sameRepeat(WEEKLY, std::nullopt);
        ok = ok && sameRepeat(with([](Repeat &r) { r.weekdays = std::vector<int>{1, 3}; }),
                              with([](Repeat &r) { r.weekdays = std::vector<int>{3, 1}; r.endDay.reset(); }));
        ok = ok && !sameRepeat(WEEKLY, with([](Repeat &r) { r.weekdays = std::vector<int>{2}; }));
        ok = ok && !sameRepeat(WEEKLY, with([](Repeat &r) { r.interval = 2; }));
        ok = ok && !sameRepeat(WEEKLY, with([](Repeat &r) { r.endDay = "2026-12-01"; }));
        ok = ok && !sameRepeat(WEEKLY, with([](Repeat &r) { r.count = 3; }));
        check(ok, "сравнение правил: порядок дней недели и пустые значения не важны");
    }
    {
        State state = createEmptyState();
        state.tasks = {task([](Task &t) { t.repeat = weeklyRepeat({1, 3}); })};
        // Отметка прошедшего дня остаётся у прежнего ряда
        Occurrence done;
        done.day = MONDAY;
        done.done = true;
        state.tasks[0].occurrences = std::vector<Occurrence>{done};
        const Repeat next = weeklyRepeat({2, 4});
        const auto created = as<Task>(changeSeriesRule(state, SeriesKind::Task, "t1", NEXT_MONDAY, next,
                                                       RuleScope::Following, ItemPatch{}, ids0));
        bool ok = created.id != "t1";
        const auto &old = *state.tasks[0].repeat;
        ok = ok && old.weekdays == std::vector<int>{1, 3} && old.startDay == MONDAY && old.endDay == "2026-10-18";
        ok = ok && sameJson(json(*state.tasks[0].occurrences), R"([{"day":"2026-10-12","done":true}])");
        Repeat expected = next;
        expected.startDay = NEXT_MONDAY;
        ok = ok && json(*created.repeat) == json(expected);
        // Первая неделя — понедельник и среда, со второй — вторник и четверг
        std::vector<std::string> days;
        for (const auto &day : V({"2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-19", "2026-10-20",
                                  "2026-10-21", "2026-10-22"})) {
            if (!getTasksForDay(state, day).empty()) days.push_back(day);
        }
        ok = ok && days == V({"2026-10-12", "2026-10-14", "2026-10-20", "2026-10-22"});
        // День, с которого правили, новому правилу не подходит — карточка открывается на ближайшем
        ok = ok && nearestSeriesDay(created, NEXT_MONDAY) == "2026-10-20";
        check(ok, "«это и последующие»: прежние дни по старому правилу, с этого дня — по новому");
    }
    {
        Repeat daily;
        daily.kind = "daily";
        daily.interval = 1;
        daily.startDay = MONDAY;
        daily.count = 10;
        State shared = createEmptyState();
        shared.events = {event([&](Event &e) { e.repeat = daily; })};
        Repeat every2 = daily;
        every2.interval = 2;
        const auto tail = as<Event>(changeSeriesRule(shared, SeriesKind::Event, "e1", "2026-10-15", every2,
                                                     RuleScope::Following, ItemPatch{}, ids0));
        bool ok = shared.events[0].repeat->endDay == "2026-10-14" && shared.events[0].repeat->count == 3;
        ok = ok && sameJson(json(*tail.repeat), R"({"kind":"daily","interval":2,"startDay":"2026-10-15","count":7})");
        State own = createEmptyState();
        own.events = {event([&](Event &e) { e.repeat = daily; })};
        Repeat four = daily;
        four.count = 4;
        const auto fresh = as<Event>(changeSeriesRule(own, SeriesKind::Event, "e1", "2026-10-15", four,
                                                      RuleScope::Following, ItemPatch{}, ids0));
        ok = ok && fresh.repeat->startDay == "2026-10-15" && fresh.repeat->count == 4;
        check(ok, "«это и последующие»: неизменённое число повторов делится, изменённое — берётся как есть");
    }
    {
        State state = createEmptyState();
        state.events = {event()};
        const auto result = changeSeriesRule(state, SeriesKind::Event, "e1", MONDAY, weeklyRepeat({1, 5}),
                                             RuleScope::Following, ItemPatch{}, ids0);
        check(itemId(*result) == "e1" && state.events.size() == 1
                  && json(*state.events[0].repeat) == json(weeklyRepeat({1, 5})),
              "«это и последующие» у первого дня ряда — правка всего ряда, без второй записи");
    }
    {
        State state = createEmptyState();
        state.tasks = {task([](Task &t) { t.repeat = weeklyRepeat({1, 3}); })};
        Occurrence done;
        done.day = MONDAY;
        done.done = true;
        Occurrence excluded;
        excluded.day = "2026-10-14";
        excluded.excluded = true;
        state.tasks[0].occurrences = std::vector<Occurrence>{done, excluded};
        const Repeat next = weeklyRepeat({1, 5});
        const auto result = as<Task>(changeSeriesRule(state, SeriesKind::Task, "t1", NEXT_MONDAY, next, RuleScope::All,
                                                      ItemPatch{.name = "Бег", .day = "2026-10-20"}, ids0));
        bool ok = result.id == "t1" && state.tasks.size() == 1;
        ok = ok && state.tasks[0].name == "Бег" && json(*state.tasks[0].repeat) == json(next)
            && sameJson(json(*state.tasks[0].occurrences), R"([{"day":"2026-10-12","done":true}])");
        ok = ok && !state.tasks[0].day;
        ok = ok && getTasksForDay(state, "2026-10-16").size() == 1 && getTasksForDay(state, "2026-10-14").empty();
        ok = ok && nearestSeriesDay(result, NEXT_MONDAY) == NEXT_MONDAY;
        check(ok, "«все в серии»: правило у всего ряда, отметки дней вне нового правила отбрасываются, поля — в шаблон");
    }
    {
        State state = createEmptyState();
        state.tasks = {task()};
        const auto single = as<Task>(changeSeriesRule(state, SeriesKind::Task, "t1", "2026-10-14", std::nullopt,
                                                      RuleScope::Stop, ItemPatch{}, ids0));
        bool ok = single.day == "2026-10-14" && single.start == "10:00" && single.origin->seriesId == "t1"
            && single.origin->day == "2026-10-14" && !single.repeat;
        ok = ok && state.tasks[0].repeat->startDay == MONDAY && state.tasks[0].repeat->endDay == "2026-10-13";
        ok = ok && state.tasks[0].occurrences.value_or(std::vector<Occurrence>()).empty();
        ok = ok && getTasksForDay(state, "2026-10-13").size() == 1;
        ok = ok && ids(getTasksForDay(state, "2026-10-14")) == std::vector<std::string>{single.id};
        ok = ok && getTasksForDay(state, "2026-10-15").empty();
        check(ok, "«не повторять с этого дня»: день остаётся разовой записью, следующих нет, прежние на месте");
    }
    {
        State state = createEmptyState();
        state.events = {event()};
        const auto single = as<Event>(changeSeriesRule(state, SeriesKind::Event, "e1", MONDAY, std::nullopt,
                                                       RuleScope::Stop, ItemPatch{.name = "Йога один раз"}, ids0));
        bool ok = json(state.events) == json(std::vector<Event>{single});
        ok = ok && single.name == "Йога один раз" && single.day == MONDAY;
        // Разовая копия встаёт на день, выбранный в карточке
        State moved = createEmptyState();
        moved.events = {event()};
        const auto copy = as<Event>(changeSeriesRule(moved, SeriesKind::Event, "e1", NEXT_MONDAY, std::nullopt,
                                                     RuleScope::Stop, ItemPatch{.day = "2026-10-21"}, ids0));
        ok = ok && copy.day == "2026-10-21" && copy.origin->seriesId == "e1" && copy.origin->day == NEXT_MONDAY;
        ok = ok && getEventsForDay(moved, NEXT_MONDAY).empty() && getEventsForDay(moved, MONDAY).size() == 1;
        ok = ok && getEventsForDay(state, NEXT_MONDAY).empty();
        check(ok, "«не повторять» у первого дня: ряда больше нет, остаётся разовая запись");
    }
    {
        State state = createEmptyState();
        state.events = {event()};
        const auto single = as<Event>(changeSeriesRule(state, SeriesKind::Event, "e1", NEXT_MONDAY, std::nullopt,
                                                       RuleScope::One, ItemPatch{}, ids0));
        check(!single.repeat && json(*state.events[0].repeat) == json(WEEKLY)
                  && ids(getEventsForDay(state, NEXT_MONDAY)) == std::vector<std::string>{single.id}
                  && ids(getEventsForDay(state, "2026-10-26")) == V({"e1"}),
              "«только этот день без повтора»: день отделён, ряд идёт дальше");
    }
    {
        State state = createEmptyState();
        state.events = {event([](Event &e) {
            e.repeat.reset();
            e.day = MONDAY;
        })};
        check(!changeSeriesRule(state, SeriesKind::Event, "e1", MONDAY, WEEKLY, RuleScope::All, ItemPatch{}, ids0)
                  && !nearestSeriesDay(state.events[0], MONDAY),
              "у разовой записи менять нечего");
    }
}

// ── plannerGroups.test.ts ────────────────────────────────────────────────────

static State makeGroupState() {
    State state = createEmptyState();
    Event lesson;
    lesson.id = "lesson";
    lesson.name = "Лекция";
    lesson.start = "10:00";
    lesson.end = "11:00";
    Repeat r;
    r.kind = "weekly";
    r.interval = 1;
    r.weekdays = std::vector<int>{1};
    r.startDay = "2026-10-12";
    lesson.repeat = r;
    lesson.occurrences = std::vector<Occurrence>();
    Event once;
    once.id = "once";
    once.name = "Встреча";
    once.start = "12:00";
    once.end = "13:00";
    once.day = "2026-10-20";
    once.color = 3;
    state.events = {lesson, once};
    Task t;
    t.id = "t1";
    t.name = "Задание";
    t.rank = 0;
    state.tasks = {t};
    return state;
}

static void groups() {
    std::printf("-- группы «Плана»\n");
    auto ids0 = seqIds("list");
    auto pick = [](SeriesKind kind, const std::string &id, std::optional<std::string> day, bool isRepeat) {
        return GroupPick{kind, id, day, isRepeat};
    };
    {
        State state = makeGroupState();
        bool ok = createGroup(state, "  ", 2, ids0) == "name" && !createGroup(state, "Учёба", 4, ids0)
            && createGroup(state, "Учёба", 1, ids0) == "duplicate";
        ok = ok && state.lists.size() == 1 && state.lists[0].name == "Учёба" && state.lists[0].color == 4;
        ok = ok && std::find(state.projects.begin(), state.projects.end(), "Учёба") != state.projects.end();
        check(ok, "создание: имя обязательно и не повторяется, цвет сохраняется");
    }
    {
        State state = makeGroupState();
        createGroup(state, "Учёба", 5, ids0);
        assignToGroup(state,
                      {pick(SeriesKind::Event, "lesson", "2026-10-19", true), pick(SeriesKind::Event, "lesson", "2026-10-26", true),
                       pick(SeriesKind::Event, "once", std::nullopt, false), pick(SeriesKind::Task, "t1", std::nullopt, false)},
                      "Учёба", true, ids0);
        const Event *lesson = findById(state, "lesson");
        bool ok = lesson->project == "Учёба" && state.events.size() == 2 && getEventColor(state, *lesson) == 5;
        ok = ok && getEventColor(state, *findById(state, "once")) == 5 && state.tasks[0].project == "Учёба";
        check(ok, "ряд целиком с повторами: событие красится цветом группы");
    }
    {
        State state = makeGroupState();
        createGroup(state, "Работа", 2, ids0);
        assignToGroup(state, {pick(SeriesKind::Event, "lesson", "2026-10-19", true)}, "Работа", false, ids0);
        const Event *lesson = findById(state, "lesson");
        bool ok = !lesson->project && sameJson(json(*lesson->occurrences), R"([{"day":"2026-10-19","excluded":true}])");
        const Event *detached = nullptr;
        for (const auto &e : state.events) {
            if (e.origin && e.origin->seriesId == "lesson") detached = &e;
        }
        ok = ok && detached && detached->day == "2026-10-19" && detached->project == "Работа";
        check(ok, "без повторов: отделяется только отмеченный день");
    }
    {
        State state = makeGroupState();
        createGroup(state, "Учёба", 5, ids0);
        assignToGroup(state, {pick(SeriesKind::Event, "lesson", std::nullopt, true), pick(SeriesKind::Task, "t1", std::nullopt, false)},
                      "Учёба", true, ids0);
        bool ok = !renameGroup(state, "Учёба", "Университет");
        ok = ok && findById(state, "lesson")->project == "Университет" && state.tasks[0].project == "Университет";
        ok = ok && std::find(state.projects.begin(), state.projects.end(), "Учёба") == state.projects.end();
        setGroupColor(state, "Университет", 7);
        ok = ok && getEventColor(state, *findById(state, "lesson")) == 7;
        createGroup(state, "Работа", 1, ids0);
        ok = ok && renameGroup(state, "Университет", "Работа") == "duplicate";
        deleteGroup(state, "Университет");
        std::vector<std::string> names;
        for (const auto &l : state.lists) names.push_back(l.name);
        ok = ok && names == V({"Работа"}) && !findById(state, "lesson")->project && state.tasks[0].project.empty();
        // Без группы событие снова своего цвета
        ok = ok && getEventColor(state, *findById(state, "once")) == 3;
        check(ok, "переименование и удаление проходят по всем записям; цвет меняется у группы");
    }
    // не перенесено: «группа из ввода текстом» — `applyQuickDraft` из `plannerHealth.ts` (другой модуль)
}

// ── plannerSchedule.test.ts ──────────────────────────────────────────────────

static const char *SAMPLE = R"(Понедельник

17:00–18:30 Рисование, ауд. 12
18:30–20:00 Шахматный кружок, ауд. 12

Вторник

10:35–12:00 Алгебра (семинар), преп. Иванова А.А., 101 ГК
13:55–15:20 Основы программирования
15:30–16:55 Иностранный язык
17:30–19:00 Робототехника, группа 1, каб. 5

Среда

12:10–13:35 Алгебра (лекция), проф. Петров П.П., 202 ГК

Четверг

15:30–16:55 Иностранный язык
18:40–20:05 История (семинар), преп. Сидоров С.С., 303 ГК

Пятница

15:00–16:30 Бассейн, дорожка 3, СК

Суббота — свободна

Воскресенье

11:00–12:45 Английский клуб, группа 2, каб. 7
13:00–14:45 Робототехника, группа 2, каб. 7

до 15.12.2026)";

static void schedule() {
    std::printf("-- расписание текстом\n");
    {
        const auto parsed = parseSchedule(SAMPLE);
        const auto &items = parsed.items;
        bool ok = parsed.endDay == "2026-12-15" && parsed.skipped.empty() && items.size() == 12;
        ok = ok && std::none_of(items.begin(), items.end(), [](const ScheduleItem &i) { return i.weekday == 6; });
        ok = ok && items[0] == ScheduleItem{1, "17:00", "18:30", "Рисование", std::string("ауд. 12")};
        auto byStart = [&](const std::string &start) {
            return *std::find_if(items.begin(), items.end(), [&](const ScheduleItem &i) { return i.start == start; });
        };
        const auto algebra = byStart("10:35");
        ok = ok && algebra.weekday == 2 && algebra.name == "Алгебра (семинар)"
            && algebra.description == "преп. Иванова А.А., 101 ГК";
        const auto coding = byStart("13:55");
        ok = ok && coding.name == "Основы программирования" && !coding.description;
        std::vector<std::string> sunday;
        for (const auto &i : items) {
            if (i.weekday == 0) sunday.push_back(i.start);
        }
        ok = ok && sunday == V({"11:00", "13:00"});
        check(ok, "разбирает недельное расписание и дату конца");
    }
    {
        const auto parsed = parseSchedule("Пн 9:00-10:00 Зарядка\nвс: 20.00 - 21.30 Кино\nuntil 2027-01-31");
        check(parsed.items
                      == std::vector<ScheduleItem>{{1, "09:00", "10:00", "Зарядка", std::nullopt},
                                                   {0, "20:00", "21:30", "Кино", std::nullopt}}
                  && parsed.endDay == "2027-01-31",
              "день в той же строке, короткие названия, дефис и ISO-дата");
    }
    {
        const auto parsed = parseSchedule("10:00–11:00 Без дня\nСреда\n12:00–11:00 Наоборот\nдо 31.02.2026");
        check(parsed.items.empty() && parsed.skipped == V({"10:00–11:00 Без дня", "12:00–11:00 Наоборот"})
                  && !parsed.endDay,
              "время без дня и неверный интервал — в пропущенных, неверная дата — без даты");
    }
    {
        auto ids0 = seqIds("ev");
        const auto events = buildScheduleEvents(parseSchedule(SAMPLE).items, "2026-10-16", "2026-12-15", std::nullopt, ids0);
        bool ok = events.size() == 12;
        ok = ok && sameJson(json(*events[0].repeat),
                            R"({"kind":"weekly","interval":1,"weekdays":[1],"startDay":"2026-10-16","endDay":"2026-12-15"})");
        std::set<std::string> unique;
        for (const auto &e : events) unique.insert(e.id);
        ok = ok && unique.size() == 12;
        ok = ok && buildScheduleEvents(parseSchedule(SAMPLE).items, "2026-12-20", "2026-12-15", std::nullopt, ids0).empty();
        check(ok, "события — еженедельные ряды с началом и концом");
    }
}

// ── plannerLayers.test.ts ────────────────────────────────────────────────────

static void layers() {
    std::printf("-- планировщик: слои календаря\n");
    const Layers all;
    check(parseLayers(std::nullopt) == all && parseLayers(std::string()) == all,
          "без сохранённого значения показаны все слои");
    const Layers some{false, true, false};
    check(serializeLayers(some) == "sleep,work" && parseLayers(serializeLayers(some)) == some,
          "выключенные слои переживают запись и чтение");
    check(parseLayers(std::string("food,moon")) == Layers{true, false, true}, "незнакомое название слоя пропускается");
}

// ── plannerFormat.ts без Intl ────────────────────────────────────────────────
// не перенесено: `plannerFormat.test.ts` целиком сверяет подписи Intl (formatDate, formatDay, formatMonth…) —
// эти функции строят текст через Intl/lang и в ядро не переносятся. Ниже — дополнительные проверки того, что
// перенесено (formatClock, formatSpan, listColorStyle): в web на них отдельного теста нет

static void format() {
    std::printf("-- подписи без Intl (дополнительно)\n");
    check(formatClock(540) == "09" && formatClock(510) == "08:30" && formatClock(0) == "00",
          "граница окна: ровный час — «09», иначе «08:30»");
    check(formatSpan(406) == "6:46" && formatSpan(480) == "8:00" && formatSpan(5) == "0:05",
          "длительность «часы:минуты»");
    check(listColorStyle(3) == "--planner-list-color: var(--color-peer-2)" && !listColorStyle(0),
          "цвет списка — переменная палитры, 0 — без стиля");
}

int main() {
    std::printf("=== parvane-core planner series/groups/schedule tests (без стека) ===\n");
    descriptionScope();
    copiesForAll();
    seriesRule();
    groups();
    schedule();
    layers();
    format();
    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
