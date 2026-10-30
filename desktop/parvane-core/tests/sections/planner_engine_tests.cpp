// Parvane fork (spec 029, T029): тесты «План» ↔ движок — перенос web `planner/plannerSync.test.ts` и
// `planner/plannerDiff.test.ts` (по проверке на `it`, имена — как в web; таблица `diffChanges` — все случаи).
#include <algorithm>
#include <cstdio>
#include <string>
#include <vector>

#include "parvane/sections/planner_engine.h"
#include "parvane/sections/planner_model.h"
#include "parvane/sections/planner_series.h"

using namespace parvane::sections::planner;
using nlohmann::json;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name) {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}

static json J(const char *text) { return json::parse(text); }
static std::string kindOf(const json &change) { return change.begin().key(); }

static const json *findById(const std::vector<json> &changes, const std::string &kind, const std::string &id) {
    for (const auto &c : changes) {
        if (c.contains(kind) && c[kind].value("id", std::string()) == id) return &c;
    }
    return nullptr;
}

// toMatchObject: все поля `pattern` есть в `value` (объекты — рекурсивно, массивы и прочее — равенством)
static bool matches(const json &value, const json &pattern) {
    if (pattern.is_object()) {
        if (!value.is_object()) return false;
        for (const auto &[k, v] : pattern.items()) {
            if (!value.contains(k) || !matches(value[k], v)) return false;
        }
        return true;
    }
    if (pattern.is_array()) {
        if (!value.is_array() || value.size() != pattern.size()) return false;
        for (size_t i = 0; i < pattern.size(); ++i) {
            if (!matches(value[i], pattern[i])) return false;
        }
        return true;
    }
    return value == pattern;
}

static json toJ(const State &s) { return json(s); }

static const char *ENGINE_TEXT = R"JSON({"tasks":[{"id":"t1","name":"Задача","description":"описание","steps":[{"text":"шаг","isDone":true}],"status":"active","listId":"l1","rank":2,"day":"2026-10-08","start":"10:00","due":"","minutes":90},{"id":"t2","name":"Без оценки","description":"","steps":[],"status":"queue","listId":"","rank":0,"day":"","start":"","due":"","minutes":null}],"events":[{"id":"e1","name":"Стендап","start":"09:30","end":"09:45","weekdays":[1,2],"day":""},{"id":"e2","name":"Бассейн","start":"19:00","end":"20:00","weekdays":null,"day":"","repeat":{"kind":"weekly","interval":1,"weekdays":[1,3],"monthDay":0,"startDay":"2026-10-12","endDay":"","count":0},"occurrences":[{"day":"2026-10-14","excluded":true,"done":false,"doneSteps":[]}],"origin":null}],"lists":[{"id":"l1","name":"Работа","order":0}],"nutrition":[{"day":"2026-10-08","entries":[{"id":"f1","name":"Творог","meal":"breakfast","kcal":300,"protein":45,"fat":null,"carbs":null,"fiber":null,"grams":250,"per100":true}],"isComplete":true,"fixedGoals":{"kcal":{"target":2000,"tolerance":100},"protein":{"target":120,"tolerance":20},"fat":null,"carbs":null},"waterMl":500}],"settings":{"dayStart":480,"dayEnd":1200,"lunchStart":0,"lunchEnd":0,"margin":10,"budget":480},"goals":{"kcal":{"target":2100,"tolerance":100},"protein":null,"fat":null,"carbs":null,"water":{"target":2000,"tolerance":300}},"goalPeriods":[{"id":"g1","startDay":"2026-10-15","endDay":"2026-10-15","kcal":{"target":1500,"tolerance":100},"protein":null,"fat":null,"carbs":null,"fiber":null,"water":null}],"headSeq":7,"sizeBytes":1234})JSON";

static const char *ENGINE_EMPTY_TEXT =
    R"JSON({"tasks":[],"events":[],"lists":[],"nutrition":[],"settings":null,"goals":null,"headSeq":0,"sizeBytes":0})JSON";

// Таблица `plannerDiff.test.ts` (DIFF_ENGINE и EXPECTED — как в web, извлечены из теста)
static const char *DIFF_ENGINE_TEXT = R"JSON({"tasks": [{"id": "t1", "name": "Задача", "description": "описание", "steps": [{"text": "шаг", "isDone": true}, {"text": "ещё", "isDone": false}], "status": "active", "listId": "l1", "rank": 2, "day": "2026-10-08", "start": "10:00", "due": "2026-10-20", "minutes": 90, "source": {"chat": "note:Идеи", "opId": "op1"}}, {"id": "t2", "name": "Без оценки", "description": "", "steps": [], "status": "queue", "listId": "", "rank": 0, "day": "", "start": "", "due": "", "minutes": null}, {"id": "t3", "name": "Ряд", "description": "", "steps": [], "status": "queue", "listId": "l1", "rank": 1, "day": "", "start": "08:00", "due": "", "minutes": 15, "repeat": {"kind": "daily", "interval": 1, "weekdays": [], "monthDay": 0, "startDay": "2026-10-01", "endDay": "", "count": 0}, "occurrences": [{"day": "2026-10-05", "excluded": false, "done": true, "doneSteps": []}], "origin": null}], "events": [{"id": "e1", "name": "Стендап", "start": "09:30", "end": "09:45", "weekdays": [1, 2], "day": ""}, {"id": "e2", "name": "Бассейн", "start": "19:00", "end": "20:00", "weekdays": null, "day": "", "repeat": {"kind": "weekly", "interval": 1, "weekdays": [1, 3], "monthDay": 0, "startDay": "2026-10-12", "endDay": "", "count": 0}, "occurrences": [{"day": "2026-10-14", "excluded": true, "done": false, "doneSteps": []}], "origin": null}, {"id": "e3", "name": "Праздник", "start": "00:00", "end": "23:59", "weekdays": null, "day": "2026-11-04", "allDay": true, "isHoliday": true, "color": 0, "description": "выходной"}], "lists": [{"id": "l1", "name": "Работа", "order": 0}, {"id": "l2", "name": "Дом", "order": 1, "color": 3}], "nutrition": [{"day": "2026-10-08", "entries": [{"id": "f1", "name": "Творог", "meal": "breakfast", "kcal": 300, "protein": 45, "fat": null, "carbs": null, "fiber": null, "grams": 250, "per100": true, "time": "08:30"}, {"id": "f2", "name": "Суп", "meal": "lunch", "kcal": 450, "protein": 20, "fat": 15, "carbs": 40, "fiber": 5, "grams": null, "per100": false, "sugar": 3, "salt": 2}], "isComplete": true, "fixedGoals": {"kcal": {"target": 2000, "tolerance": 100}, "protein": {"target": 120, "tolerance": 20}, "fat": null, "carbs": null}, "waterMl": 500}, {"day": "2026-10-09", "entries": [], "isComplete": false, "fixedGoals": null, "waterMl": 1250}], "settings": {"dayStart": 480, "dayEnd": 1200, "lunchStart": 780, "lunchEnd": 840, "margin": 10, "budget": 480}, "goals": {"kcal": {"target": 2100, "tolerance": 100}, "protein": null, "fat": null, "carbs": null, "water": {"target": 2000, "tolerance": 300}}, "goalPeriods": [{"id": "g1", "startDay": "2026-10-15", "endDay": "2026-10-15", "kcal": {"target": 1500, "tolerance": 100}, "protein": null, "fat": null, "carbs": null, "fiber": null, "water": null}], "health": [{"id": "h1", "day": "2026-10-08", "kind": "sleep", "time": "23:30", "endTime": "07:00", "value": 450, "value2": 0, "name": "", "details": ""}, {"id": "h2", "day": "2026-10-08", "kind": "weight", "time": "", "endTime": "", "value": 81.5, "value2": 0, "name": "", "details": ""}, {"id": "h3", "day": "2026-10-07", "kind": "workout", "time": "18:00", "endTime": "", "value": 45, "value2": 5, "name": "бег", "details": "{\"ex\":[{\"name\":\"бег\",\"minutes\":45}]}"}, {"id": "health-goals", "day": "2000-01-01", "kind": "goals", "time": "", "endTime": "", "value": 0, "value2": 0, "name": "", "details": "{\"steps\":8000,\"bedtime\":\"23:00\"}"}], "learned": [{"id": "пара", "kind": "", "kindCount": 0, "minutes": 105, "minutesCount": 4, "touched": 9}, {"id": "зал", "kind": "event", "kindCount": 3, "minutes": null, "minutesCount": 0, "touched": 10}], "quickLines": [{"id": "q1", "text": "Купить кабель", "count": 2, "touched": 3, "hidden": false}, {"id": "q2", "text": "обед", "count": 0, "touched": 1, "hidden": true}], "headSeq": 7, "sizeBytes": 1234})JSON";
static const char *EXPECTED_TEXT = R"JSON({"ничего": [], "выполнение задачи": [{"task": {"id": "t1", "status": "done"}}], "шаг и описание задачи": [{"task": {"id": "t1", "description": "новое", "steps": [{"text": "шаг", "isDone": true}, {"text": "ещё", "isDone": true}]}}], "удаление и добавление задачи": [{"task": {"id": "t9", "name": "Новая", "description": "", "steps": [], "status": "queue", "listId": "l2", "rank": 1, "day": "", "start": "", "due": "2026-12-01", "minutes": null, "repeat": null, "occurrences": [], "origin": null, "source": null, "remind": null}}, {"task": {"id": "t2", "deleted": true}}], "новый список и перенос задачи": [{"list": {"id": "l3", "name": "Учёба", "order": 2, "color": 5}}, {"task": {"id": "t1", "listId": ""}}, {"task": {"id": "t2", "listId": "l3"}}], "удаление списка": [{"list": {"id": "l2", "deleted": true}}], "цвет списка": [{"list": {"id": "l1", "color": 2}}, {"list": {"id": "l2", "color": 0}}], "отметка экземпляра ряда и новое правило": [{"task": {"id": "t3", "repeat": {"kind": "weekly", "interval": 2, "weekdays": [1, 5], "monthDay": 0, "startDay": "2026-10-01", "endDay": "2026-12-31", "count": 10}, "occurrences": [{"day": "2026-10-05", "excluded": false, "done": false, "doneSteps": []}, {"day": "2026-10-06", "excluded": false, "done": true, "doneSteps": []}]}}], "снятие ряда с задачи и дата": [{"task": {"id": "t3", "day": "2026-10-20", "repeat": null}}], "перенос времени события и исключение дня": [{"event": {"id": "e2", "start": "18:00", "end": "19:00", "weekdays": null, "repeat": {"kind": "weekly", "interval": 1, "weekdays": [1, 3], "monthDay": 0, "startDay": "2026-10-12", "endDay": "", "count": 0}, "occurrences": [{"day": "2026-10-21", "excluded": true, "done": false, "doneSteps": []}]}}], "событие по дням недели прежнего формата становится рядом": [{"event": {"id": "e1", "weekdays": null, "repeat": {"kind": "weekly", "interval": 1, "weekdays": [1, 2, 4], "monthDay": 0, "startDay": "2026-10-05", "endDay": "", "count": 0}}}], "удаление события и новое разовое": [{"event": {"id": "e9", "name": "Врач", "start": "11:00", "end": "11:30", "weekdays": null, "day": "2026-10-22", "repeat": null, "occurrences": [], "origin": null, "allDay": false, "isHoliday": false, "color": 4, "description": "взять полис", "remind": null, "listId": ""}}, {"event": {"id": "e3", "deleted": true}}], "отделённый день ряда": [{"event": {"id": "e2", "weekdays": null, "repeat": {"kind": "weekly", "interval": 1, "weekdays": [1, 3], "monthDay": 0, "startDay": "2026-10-12", "endDay": "", "count": 0}, "occurrences": [{"day": "2026-10-19", "excluded": true, "done": false, "doneSteps": []}]}}, {"event": {"id": "e10", "name": "Бассейн", "start": "20:00", "end": "21:00", "weekdays": null, "day": "2026-10-19", "repeat": null, "occurrences": [], "origin": {"seriesId": "e2", "day": "2026-10-19"}, "allDay": false, "isHoliday": false, "color": 0, "description": "", "remind": null, "listId": ""}}], "правка и удаление записи еды, вода": [{"nutritionDay": {"day": "2026-10-08", "entries": [{"id": "f1", "name": "Творог", "meal": "breakfast", "kcal": 320, "protein": 45, "fat": null, "carbs": null, "fiber": null, "grams": 250, "per100": true, "sugar": null, "salt": null, "time": "09:00"}, {"id": "f2", "deleted": true}], "waterMl": 750}}], "новая запись еды и закрытие дня": [{"nutritionDay": {"day": "2026-10-09", "entries": [{"id": "f9", "name": "Яблоко", "meal": "snack", "kcal": 80, "protein": null, "fat": null, "carbs": 20, "fiber": 3, "grams": 150, "per100": false, "sugar": null, "salt": null, "time": "16:00"}], "isComplete": true, "fixedGoals": {"kcal": {"target": 1800, "tolerance": 50}, "protein": null, "fat": null, "carbs": null, "fiber": null, "water": null}}}], "день еды исчезает и появляется новый": [{"nutritionDay": {"day": "2026-10-10", "entries": [], "isComplete": false, "fixedGoals": null, "waterMl": 250}}, {"nutritionDay": {"day": "2026-10-09", "entries": [], "waterMl": null}}], "цели и настройки": [{"settings": {"dayStart": 480, "dayEnd": 1260, "lunchStart": 780, "lunchEnd": 840, "margin": 10, "budget": 600}}, {"goals": {"kcal": {"target": 2100, "tolerance": 100}, "protein": {"target": 130, "tolerance": 10}, "fat": null, "carbs": null, "fiber": null, "water": {"target": 2000, "tolerance": 300}}}], "только бюджет": [{"settings": {"dayStart": 480, "dayEnd": 1200, "lunchStart": 780, "lunchEnd": 840, "margin": 10, "budget": 420}}], "период целей: правка, удаление, новый": [{"goalPeriod": {"id": "g1", "startDay": "2026-10-15", "endDay": "2026-10-15", "kcal": {"target": 1400, "tolerance": 100}, "protein": null, "fat": null, "carbs": null, "fiber": null, "water": {"target": 2500, "tolerance": 200}}}, {"goalPeriod": {"id": "g2", "startDay": "2026-11-01", "endDay": "2026-11-07", "kcal": null, "protein": null, "fat": null, "carbs": null, "fiber": null, "water": null}}], "удаление периода целей": [{"goalPeriod": {"id": "g1", "deleted": true}}], "здоровье: правка, удаление, новая запись": [{"health": {"id": "h2", "day": "2026-10-08", "kind": "weight", "time": "", "endTime": "", "value": 81.1, "value2": 0, "name": "", "details": ""}}, {"health": {"id": "h9", "day": "2026-10-08", "kind": "workout", "time": "19:00", "endTime": "", "value": 30, "value2": 4.2, "name": "бег", "details": "{\"ex\":[{\"name\":\"бег\",\"minutes\":30}]}"}}, {"health": {"id": "h3", "deleted": true}}], "цели здоровья": [{"health": {"id": "health-goals", "day": "2000-01-01", "kind": "goals", "value": 0, "details": "{\"steps\":10000,\"bedtime\":\"23:00\",\"waterMl\":2500}"}}], "словарь: правка типа, длительности, удаление, новое слово": [{"learned": {"id": "пара", "minutes": 120, "minutesCount": 5, "touched": 12}}, {"learned": {"id": "созвон", "kind": "event", "kindCount": 1, "minutes": null, "minutesCount": 0, "touched": 13}}, {"learned": {"id": "зал", "deleted": true}}], "словарь: только тип": [{"learned": {"id": "зал", "kind": "task", "kindCount": 4}}], "история ввода: правка, удаление, новая строка": [{"quickLine": {"id": "q1", "text": "Купить кабель", "count": 3, "touched": 5, "hidden": false}}, {"quickLine": {"id": "q9", "text": "зал 19:00", "count": 1, "touched": 6, "hidden": false}}, {"quickLine": {"id": "q2", "deleted": true}}], "всё сразу": [{"list": {"id": "l2", "order": 5}}, {"task": {"id": "t1", "status": "done"}}, {"task": {"id": "t2", "name": "Переименовано"}}, {"event": {"id": "e3", "weekdays": null, "repeat": null, "color": 2}}, {"nutritionDay": {"day": "2026-10-08", "entries": [], "isComplete": false}}, {"settings": {"dayStart": 480, "dayEnd": 1200, "lunchStart": 780, "lunchEnd": 840, "margin": 10, "budget": 500}}, {"goalPeriod": {"id": "g1", "startDay": "2026-10-15", "endDay": "2026-10-16", "kcal": {"target": 1500, "tolerance": 100}, "protein": null, "fat": null, "carbs": null, "fiber": null, "water": null}}, {"health": {"id": "h1", "day": "2026-10-08", "kind": "sleep", "time": "23:30", "endTime": "07:00", "value": 420, "value2": 0, "name": "", "details": ""}}, {"health": {"id": "health-goals", "day": "2000-01-01", "kind": "goals", "value": 0, "details": "{\"steps\":8000,\"bedtime\":\"22:30\"}"}}, {"learned": {"id": "зал", "touched": 11}}, {"quickLine": {"id": "q2", "text": "обед", "count": 0, "touched": 2, "hidden": true}}]})JSON";

static std::string idSeq() {
    static int n = 0;
    return "id-" + std::to_string(++n);
}

// Изменения с разобранными `details` цели здоровья (в C++ порядок ключей подробностей — порядок полей типа)
static json withParsedGoals(std::vector<json> changes) {
    for (auto &c : changes) {
        if (c.contains("health") && c["health"].value("id", std::string()) == kHealthGoalsId
            && c["health"].contains("details")) {
            c["health"]["details"] = json::parse(c["health"]["details"].get<std::string>());
        }
    }
    return json(changes);
}

int main() {
    std::printf("=== parvane-core planner_engine tests (без стека) ===\n");
    const json ENGINE = J(ENGINE_TEXT);
    const json ENGINE_EMPTY = J(ENGINE_EMPTY_TEXT);

    // ── планировщик ↔ движок (spec 010) ──
    {
        const auto state = fromEngineState(ENGINE);
        const auto t = toJ(state);
        bool ok = state.projects == std::vector<std::string>{"", "Работа"};
        ok = ok && state.tasks[0].project == "Работа" && state.tasks[0].minutes == 90
            && state.tasks[0].day == std::optional<std::string>("2026-10-08") && !state.tasks[0].due;
        ok = ok && state.tasks[1].project.empty() && !state.tasks[1].minutes && !state.tasks[1].day;
        ok = ok && matches(t["events"][0], J(R"({"repeat":{"kind":"weekly","interval":1,"weekdays":[1,2],"startDay":""}})"))
            && !state.events[0].day;
        ok = ok && matches(t["events"][1], J(R"({"repeat":{"kind":"weekly","weekdays":[1,3],"startDay":"2026-10-12"},
            "occurrences":[{"day":"2026-10-14","excluded":true,"done":false,"doneSteps":[]}]})"))
            && !state.events[1].repeat->endDay && !state.events[1].repeat->count && !state.events[1].origin;
        ok = ok && t["goals"] == J(R"({"kcal":{"target":2100,"tolerance":100},"water":{"target":2000,"tolerance":300}})");
        ok = ok && t["goalPeriods"] == J(R"([{"id":"g1","startDay":"2026-10-15","endDay":"2026-10-15","goals":{"kcal":{"target":1500,"tolerance":100}}}])");
        const auto &day = state.nutrition.at("2026-10-08");
        ok = ok && day.entries[0].kcal == 300 && day.entries[0].protein == 45.0 && !day.entries[0].fat
            && day.entries[0].grams == 250.0;
        ok = ok && json(*day.entries[0].per100) == J(R"({"kcal":120,"protein":18})");
        ok = ok && json(*day.fixedGoals) == J(R"({"kcal":{"target":2000,"tolerance":100},"protein":{"target":120,"tolerance":20}})");
        ok = ok && day.waterMl == 500.0 && state.budget == 480 && state.settings.dayStart == 480;
        check(ok, "состояние движка превращается в состояние экранов: списки по имени, «не задано», значения на 100 г");
    }
    {
        const auto before = fromEngineState(ENGINE);
        auto after = before;
        after.tasks[0].status = "done";
        after.tasks.erase(std::remove_if(after.tasks.begin(), after.tasks.end(), [](const Task &t) { return t.id == "t2"; }),
                          after.tasks.end());
        after.lists.push_back(List{"l2", "Дом", 1, std::nullopt});
        after.projects.push_back("Дом");
        Task t3;
        t3.id = "t3"; t3.name = "Новая"; t3.status = "queue"; t3.project = "Дом"; t3.rank = 1;
        after.tasks.push_back(t3);
        after.nutrition["2026-10-08"].entries.clear();
        after.budget = 600;
        const auto changes = diffChanges(before, after);
        std::vector<std::string> kinds;
        for (const auto &c : changes) kinds.push_back(kindOf(c));
        std::sort(kinds.begin(), kinds.end());
        bool ok = kinds == std::vector<std::string>{"list", "nutritionDay", "settings", "task", "task", "task"};
        ok = ok && findById(changes, "task", "t1") && *findById(changes, "task", "t1") == J(R"({"task":{"id":"t1","status":"done"}})");
        ok = ok && findById(changes, "task", "t2") && *findById(changes, "task", "t2") == J(R"({"task":{"id":"t2","deleted":true}})");
        ok = ok && findById(changes, "task", "t3")
            && matches(*findById(changes, "task", "t3"), J(R"({"task":{"listId":"l2","minutes":null,"day":""}})"));
        json day, settings;
        for (const auto &c : changes) {
            if (c.contains("nutritionDay")) day = c;
            if (c.contains("settings")) settings = c;
        }
        ok = ok && day["nutritionDay"]["entries"] == J(R"([{"id":"f1","deleted":true}])");
        json expectSettings = json(after.settings);
        expectSettings["budget"] = 600;
        ok = ok && settings == json{{"settings", expectSettings}};
        ok = ok && diffChanges(after, after).empty();
        check(ok, "разница состояний — только изменённые объекты; удаление — надгробие; список создаётся");
    }
    {
        const auto before = fromEngineState(ENGINE);
        auto after = before;
        after.events[1].occurrences->push_back(Occurrence{"2026-10-21", true, std::nullopt, std::nullopt});
        after.events[1].repeat->endDay = "2026-12-31";
        Repeat monthly;
        monthly.kind = "monthly"; monthly.interval = 1; monthly.monthDay = 20; monthly.startDay = "2026-10-01";
        after.tasks[0].repeat = monthly;
        after.tasks[0].occurrences = std::vector<Occurrence>{Occurrence{"2026-10-20", std::nullopt, true, std::vector<int>{0}}};
        after.goalPeriods = {GoalRecord{"g2", "2026-11-01", "", GoalValues{{"water", Goal{2500, 200}}}}};
        after.goals = GoalValues{{"kcal", Goal{2100, 100}}};
        const auto changes = diffChanges(before, after);
        bool ok = findById(changes, "event", "e2") && matches(*findById(changes, "event", "e2"), J(R"({"event":{
            "repeat":{"kind":"weekly","interval":1,"weekdays":[1,3],"monthDay":0,"startDay":"2026-10-12","endDay":"2026-12-31","count":0},
            "occurrences":[{"day":"2026-10-21","excluded":true,"done":false,"doneSteps":[]}],"weekdays":null}})"));
        ok = ok && findById(changes, "task", "t1") && matches(*findById(changes, "task", "t1"), J(R"({"task":{
            "repeat":{"kind":"monthly","interval":1,"weekdays":[],"monthDay":20,"startDay":"2026-10-01","endDay":"","count":0},
            "occurrences":[{"day":"2026-10-20","excluded":false,"done":true,"doneSteps":[0]}]}})"));
        std::vector<json> periods;
        json goals;
        for (const auto &c : changes) {
            if (c.contains("goalPeriod")) periods.push_back(c);
            if (c.contains("goals")) goals = c;
        }
        ok = ok && json(periods) == J(R"([{"goalPeriod":{"id":"g2","startDay":"2026-11-01","endDay":"","kcal":null,"protein":null,
            "fat":null,"carbs":null,"fiber":null,"water":{"target":2500,"tolerance":200}}},{"goalPeriod":{"id":"g1","deleted":true}}])");
        ok = ok && goals == J(R"({"goals":{"kcal":{"target":2100,"tolerance":100},"protein":null,"fat":null,"carbs":null,"fiber":null,"water":null}})");
        // Унаследованное событие по дням недели при записи получает правило, а `weekdays` обнуляется
        auto legacyEvent = before;
        legacyEvent.events[0].name = "Стендап-2";
        ok = ok && matches(diffChanges(before, legacyEvent)[0],
                           J(R"({"event":{"id":"e1","weekdays":null,"repeat":{"kind":"weekly","weekdays":[1,2],"startDay":""}}})"));
        check(ok, "spec 011: правило повтора и только изменённые дни экземпляров; записи целей — целиком и надгробием");
    }
    {
        json engine = ENGINE;
        engine["tasks"][0]["status"] = "later";
        engine["tasks"][0]["listId"] = "l2";
        engine["tasks"][1]["status"] = "waiting";
        engine["events"] = J(R"([{"id":"e3","name":"Новый год","start":"00:00","end":"23:59","weekdays":null,"day":"2027-01-01",
            "allDay":true,"isHoliday":true}])");
        engine["lists"] = J(R"([{"id":"l1","name":"Работа","order":0,"color":4},{"id":"l2","name":"Работа","order":1,"color":2}])");
        const auto state = fromEngineState(engine);
        bool ok = json(state.lists) == J(R"([{"id":"l1","name":"Работа","order":0,"color":4}])");
        ok = ok && state.projects == std::vector<std::string>{"", "Работа"};
        ok = ok && state.tasks[0].status == "queue" && state.tasks[0].project == "Работа"
            && state.tasks[1].status == "queue" && state.tasks[1].project.empty();
        ok = ok && state.events[0].isAllDay == true && state.events[0].isHoliday == true;
        auto next = state;
        next.lists[0].color = 7;
        next.events[0].isHoliday = false;
        const auto changes = diffChanges(state, next);
        json list, event;
        for (const auto &c : changes) {
            if (c.contains("list")) list = c["list"];
            if (c.contains("event")) event = c["event"];
        }
        ok = ok && list["color"] == 7;
        // Уходит только изменённое поле: неизменённое «весь день» не переписывается
        ok = ok && event == J(R"({"id":"e3","weekdays":null,"repeat":null,"isHoliday":false})");
        check(ok, "spec 013: цвет списка, «весь день», «праздник»; одноимённые списки — одним; прежние статусы");
    }
    {
        json engine = ENGINE;
        engine["events"] = J(R"([
            {"id":"e5","name":"пара","start":"15:00","end":"16:45","weekdays":null,"day":"2026-10-13","description":"будет тест"},
            {"id":"e6","name":"созвон","start":"10:00","end":"11:00","weekdays":null,"day":"2026-10-13"},
            {"id":"e7","name":"обед","start":"13:00","end":"14:00","weekdays":null,"day":"2026-10-13","description":""}])");
        const auto state = fromEngineState(engine);
        bool ok = state.events[0].description == std::optional<std::string>("будет тест") && !state.events[1].description
            && !state.events[2].description;
        auto described = state;
        described.events[0].description = "будет тест\nвзять тетрадь";
        described.events[1].description = "обсудить бюджет";
        ok = ok && json(diffChanges(state, described)) == J(R"([
            {"event":{"id":"e5","weekdays":null,"repeat":null,"description":"будет тест\nвзять тетрадь"}},
            {"event":{"id":"e6","weekdays":null,"repeat":null,"description":"обсудить бюджет"}}])");
        auto moved = state;
        moved.events[0].start = "16:00";
        ok = ok && json(diffChanges(state, moved)) == J(R"([{"event":{"id":"e5","weekdays":null,"repeat":null,"start":"16:00"}}])");
        // Стёртое описание уходит пустой строкой
        auto cleared = state;
        cleared.events[0].description.reset();
        ok = ok && json(diffChanges(state, cleared)) == J(R"([{"event":{"id":"e5","weekdays":null,"repeat":null,"description":""}}])");
        // Новое событие несёт описание вместе с остальными полями
        auto created = state;
        Event e8;
        e8.id = "e8"; e8.name = "врач"; e8.start = "10:30"; e8.end = "11:30"; e8.day = "2026-10-09"; e8.description = "взять полис";
        created.events.push_back(e8);
        ok = ok && diffChanges(state, created)[0]["event"]["description"] == "взять полис";
        check(ok, "описание события: из движка в состояние и обратно отдельным полем");
    }
    {
        const auto before = fromEngineState(ENGINE);
        auto after = before;
        after.tasks[0].start = "17:00";
        after.events[1].name = "Бассейн 50 м";
        const auto changes = diffChanges(before, after);
        bool ok = changes[0] == J(R"({"task":{"id":"t1","start":"17:00"}})");
        std::vector<std::string> keys;
        for (const auto &[k, v] : changes[1]["event"].items()) keys.push_back(k);
        std::sort(keys.begin(), keys.end());
        ok = ok && keys == std::vector<std::string>{"id", "name", "repeat", "weekdays"};
        // Отметка экземпляра ряда — только день экземпляра, без времени и названия задачи
        auto marked = before;
        marked.events[1].occurrences->push_back(Occurrence{"2026-10-19", true, std::nullopt, std::nullopt});
        const auto mark = diffChanges(before, marked)[0]["event"];
        keys.clear();
        for (const auto &[k, v] : mark.items()) keys.push_back(k);
        std::sort(keys.begin(), keys.end());
        ok = ok && keys == std::vector<std::string>{"id", "occurrences", "repeat", "weekdays"};
        ok = ok && mark["occurrences"] == J(R"([{"day":"2026-10-19","excluded":true,"done":false,"doneSteps":[]}])");
        check(ok, "правка одного поля не переписывает остальные (сведение по полям между устройствами)");
    }
    {
        auto legacy = createEmptyState();
        Task t;
        t.id = "7"; t.name = "Старая"; t.status = "queue"; t.project = "Дом"; t.rank = 0;
        legacy.tasks.push_back(t);
        legacy.lists.push_back(List{"list-x", "Дом", 0, std::nullopt});
        legacy.projects.push_back("Дом");
        Event e;
        e.id = "9"; e.name = "Событие"; e.start = "10:00"; e.end = "11:00"; e.day = "2026-10-09";
        legacy.events.push_back(e);
        const auto changes = legacyToChanges(legacy, "web-1");
        std::vector<std::string> kinds;
        for (const auto &c : changes) kinds.push_back(kindOf(c));
        bool ok = kinds == std::vector<std::string>{"list", "task", "event", "migration"};
        ok = ok && changes[1]["task"]["id"] == "legacy-web-1-7" && changes[2]["event"]["id"] == "legacy-web-1-9";
        ok = ok && changes[3] == J(R"({"migration":{"sourceDevice":"web-1","count":3}})");
        ok = ok && isLegacyPlannerRecord(json(legacy)) && !isLegacyPlannerRecord(J(R"({"migrated":true,"at":1})"));
        check(ok, "перенос этапа 1: числовые id получают префикс устройства, последним — отметка переноса");
    }

    // ── повторный разбор (C1). В C++ объекты не переиспользуются (значения — копии): проверяется смысл —
    // разбор того же JSON даёт равные записи, изменённое — новое значение, нетронутое — то же
    {
        const auto previous = fromEngineState(ENGINE);
        const auto same = fromEngineState(ENGINE);
        bool ok = toJ(same) == toJ(previous);
        json engine = ENGINE;
        engine["tasks"][0]["status"] = "done";
        json t9 = engine["tasks"][1];
        t9["id"] = "t9";
        t9["name"] = "Новая";
        engine["tasks"].push_back(t9);
        engine["nutrition"][0]["waterMl"] = 750;
        const auto next = fromEngineState(engine);
        ok = ok && json(next.tasks[0]) != json(previous.tasks[0]) && next.tasks[0].status == "done";
        ok = ok && json(next.tasks[1]) == json(previous.tasks[1]) && next.tasks[2].id == "t9";
        ok = ok && json(next.events) == json(previous.events);
        ok = ok && next.nutrition.at("2026-10-08").waterMl == 750.0;
        json shorter = ENGINE;
        shorter["tasks"].erase(shorter["tasks"].size() - 1);
        const auto dropped = fromEngineState(shorter);
        ok = ok && dropped.tasks.size() == previous.tasks.size() - 1 && json(dropped.tasks[0]) == json(previous.tasks[0]);
        check(ok, "записи с тем же JSON — те же объекты, изменённые — новые; нетронутые коллекции — те же массивы");
    }

    // ── здоровье (spec 020) ──
    {
        const auto empty = createEmptyState();
        auto next = empty;
        HealthRecord weight;
        weight.id = "weight-2026-10-11"; weight.day = "2026-10-11"; weight.kind = "weight"; weight.value = 74.7;
        HealthRecord w1;
        w1.id = "w1"; w1.day = "2026-10-11"; w1.kind = "workout"; w1.time = "19:00"; w1.value = 60; w1.name = "Зал";
        w1.exercises = std::vector<Exercise>{Exercise{"присед", 4, 8, 80}};
        next.health = {weight, w1};
        next.healthGoals.steps = 10000;
        FoodEntry f1;
        f1.id = "f1"; f1.name = "Обед"; f1.meal = "lunch"; f1.kcal = 520; f1.sugar = 14; f1.time = "13:30";
        next.nutrition["2026-10-11"] = NutritionDay{{f1}, false, std::nullopt, std::nullopt};
        const auto changes = diffChanges(empty, next);
        std::vector<json> health;
        json day;
        for (const auto &c : changes) {
            if (c.contains("health")) health.push_back(c["health"]);
            if (c.contains("nutritionDay")) day = c["nutritionDay"];
        }
        bool ok = health.size() == 3 && health[0]["id"] == "weight-2026-10-11" && health[1]["id"] == "w1"
            && health[2]["id"] == "health-goals";
        ok = ok && health[1]["details"] == "{\"ex\":[{\"name\":\"присед\",\"sets\":4,\"reps\":8,\"weight\":80}]}";
        ok = ok && json::parse(health[2]["details"].get<std::string>())["steps"] == 10000;
        ok = ok && matches(day["entries"][0], J(R"({"sugar":14,"salt":null,"time":"13:30"})"));
        auto fewer = next;
        fewer.health = {next.health[1]};
        ok = ok && json(diffChanges(next, fewer)) == J(R"([{"health":{"id":"weight-2026-10-11","deleted":true}}])");
        check(ok, "записи здоровья, цели здоровья и новые поля питания уходят изменениями");
    }
    {
        json engine = ENGINE_EMPTY;
        engine["health"] = J(R"([
            {"id":"w1","day":"2026-10-11","kind":"workout","time":"19:00","endTime":"","value":60,"value2":0,"name":"Зал",
             "details":"{\"ex\":[{\"name\":\"жим\",\"sets\":3,\"reps\":10,\"weight\":60}]}"},
            {"id":"health-goals","day":"2000-01-01","kind":"goals","time":"","endTime":"","value":0,"value2":0,"name":"",
             "details":"{\"steps\":9000,\"sleepMinutes\":450}"},
            {"id":"x","day":"2026-10-11","kind":"pulse","time":"","endTime":"","value":64,"value2":0,"name":"","details":"не JSON"}])");
        const auto state = fromEngineState(engine);
        bool ok = state.health.size() == 2 && state.health[0].id == "w1" && state.health[1].id == "x";
        ok = ok && json(*state.health[0].exercises) == J(R"([{"name":"жим","sets":3,"reps":10,"weight":60}])");
        ok = ok && !state.health[1].exercises;
        ok = ok && json(state.healthGoals) == J(R"({"steps":9000,"sleepMinutes":450})");
        ok = ok && fromEngineState(ENGINE_EMPTY).healthGoals.activeMinutes == 150.0;
        check(ok, "состояние строится из записей движка; цели здоровья — из записи вида goals");
    }

    // ── словарь правок ввода текстом ──
    const LearnedWord word{"пара", "event", 2, 105, 3, 4};
    {
        json engine = ENGINE_EMPTY;
        engine["learned"] = J(R"([
            {"id":"пара","kind":"event","kindCount":2,"minutes":105,"minutesCount":3,"touched":4},
            {"id":"созвон","kind":"","kindCount":0,"minutes":20,"minutesCount":1,"touched":5},
            {"id":"пусто","kind":"","kindCount":0,"minutes":null,"minutesCount":0,"touched":6},
            {"id":"чужое","kind":"food","kindCount":3,"minutes":null,"minutesCount":0,"touched":7}])");
        const auto state = fromEngineState(engine);
        const LearnedWord zvon{"созвон", std::nullopt, 0, 20, 1, 5};
        bool ok = json(state.learned) == json(std::vector<LearnedWord>{word, zvon});
        ok = ok && fromEngineState(ENGINE_EMPTY).learned.empty();
        check(ok, "слова движка читаются; негодные и пустые пропускаются; прежний движок — пустой словарь");
    }
    {
        const auto empty = createEmptyState();
        auto one = empty;
        one.learned = {word};
        bool ok = json(diffChanges(empty, one))
            == J(R"([{"learned":{"id":"пара","kind":"event","kindCount":2,"minutes":105,"minutesCount":3,"touched":4}}])");
        auto copy = one;
        ok = ok && diffChanges(one, copy).empty();
        auto grown = one;
        grown.learned[0].minutesCount = 4;
        grown.learned[0].touched = 5;
        ok = ok && json(diffChanges(one, grown)) == J(R"([{"learned":{"id":"пара","minutes":105,"minutesCount":4,"touched":5}}])");
        auto unkind = one;
        unkind.learned[0].kind.reset();
        unkind.learned[0].kindCount = 0;
        ok = ok && json(diffChanges(one, unkind)) == J(R"([{"learned":{"id":"пара","kind":"","kindCount":0}}])");
        auto unminutes = one;
        unminutes.learned[0].minutes.reset();
        unminutes.learned[0].minutesCount = 0;
        ok = ok && json(diffChanges(one, unminutes)) == J(R"([{"learned":{"id":"пара","minutes":null,"minutesCount":0}}])");
        auto two = one;
        two.learned.push_back(LearnedWord{"зал", "event", 3, std::nullopt, 0, 6});
        auto none = two;
        none.learned.clear();
        ok = ok && json(diffChanges(two, none))
            == J(R"([{"learned":{"id":"пара","deleted":true}},{"learned":{"id":"зал","deleted":true}}])");
        bool hasLearned = false;
        for (const auto &c : legacyToChanges(empty, "web1")) hasLearned = hasLearned || c.contains("learned");
        ok = ok && !hasLearned;
        check(ok, "новое слово уходит целиком, правка — только изменившейся парой, пропавшее — удалением");
    }

    // ── история ввода текстом ──
    const QuickLine line{"q01", "созвон завтра 16:00", 2, 4, std::nullopt};
    const QuickLine hidden{"h02", "созвон 16:00", 0, 5, true};
    {
        json engine = ENGINE_EMPTY;
        engine["quickLines"] = J(R"([
            {"id":"q01","text":"созвон завтра 16:00","count":2,"touched":4,"hidden":false},
            {"id":"h02","text":"созвон 16:00","count":0,"touched":5,"hidden":true},
            {"id":"q03","text":"  ","count":1,"touched":6,"hidden":false},
            {"id":"q01","text":"дубль","count":1,"touched":7,"hidden":false}])");
        bool ok = json(fromEngineState(engine).quickLines) == json(std::vector<QuickLine>{line, hidden});
        ok = ok && hasEngineQuickLines(engine);
        json emptyLines = ENGINE_EMPTY;
        emptyLines["quickLines"] = json::array();
        ok = ok && hasEngineQuickLines(emptyLines);
        ok = ok && fromEngineState(ENGINE_EMPTY).quickLines.empty() && !hasEngineQuickLines(ENGINE_EMPTY);
        check(ok, "записи движка читаются; пустые и повторные пропускаются; прежний движок истории не ведёт");
    }
    {
        const auto empty = createEmptyState();
        auto two = empty;
        two.quickLines = {line, hidden};
        bool ok = json(diffChanges(empty, two)) == J(R"([
            {"quickLine":{"id":"q01","text":"созвон завтра 16:00","count":2,"touched":4,"hidden":false}},
            {"quickLine":{"id":"h02","text":"созвон 16:00","count":0,"touched":5,"hidden":true}}])");
        auto swapped = two;
        swapped.quickLines = {hidden, line};
        ok = ok && diffChanges(two, swapped).empty();
        auto used = two;
        used.quickLines[0].count = 3;
        used.quickLines[0].touched = 9;
        ok = ok && json(diffChanges(two, used))
            == J(R"([{"quickLine":{"id":"q01","text":"созвон завтра 16:00","count":3,"touched":9,"hidden":false}}])");
        auto forgot = two;
        forgot.quickLines = {hidden};
        ok = ok && json(diffChanges(two, forgot)) == J(R"([{"quickLine":{"id":"q01","deleted":true}}])");
        auto none = two;
        none.quickLines.clear();
        ok = ok && json(diffChanges(two, none))
            == J(R"([{"quickLine":{"id":"q01","deleted":true}},{"quickLine":{"id":"h02","deleted":true}}])");
        auto withTask = two;
        Task t;
        t.id = "t1"; t.name = "созвон"; t.status = "queue";
        withTask.tasks.push_back(t);
        std::vector<std::string> kinds;
        for (const auto &c : diffChanges(empty, withTask)) kinds.push_back(kindOf(c));
        ok = ok && kinds == std::vector<std::string>{"task", "quickLine", "quickLine"};
        bool hasQuick = false;
        for (const auto &c : legacyToChanges(empty, "web1")) hasQuick = hasQuick || c.contains("quickLine");
        ok = ok && !hasQuick;
        check(ok, "запись уходит целиком, неизменённая не уходит, пропавшая — надгробием");
    }

    // ── описание ряда и одного дня ──
    Event series;
    series.id = "e1"; series.name = "Йога"; series.start = "18:00"; series.end = "19:00"; series.description = "Взять коврик";
    {
        Repeat r;
        r.kind = "weekly"; r.interval = 1; r.weekdays = std::vector<int>{1}; r.startDay = "2026-10-12";
        series.repeat = r;
    }
    {
        const auto before = createEmptyState();
        auto after = before;
        const auto own = addEntry(after, SeriesKind::Event, series, DescriptionScope::One, "2026-10-12", idSeq);
        const auto changes = diffChanges(before, after);
        bool ok = own.has_value() && changes.size() == 2;
        ok = ok && matches(changes[0], J(R"({"event":{"id":"e1","description":"",
            "repeat":{"kind":"weekly","weekdays":[1],"startDay":"2026-10-12"},
            "occurrences":[{"day":"2026-10-12","excluded":true,"done":false,"doneSteps":[]}],"origin":null}})"));
        json expect1 = J(R"({"event":{"description":"Взять коврик","day":"2026-10-12","repeat":null,"occurrences":[],
            "origin":{"seriesId":"e1","day":"2026-10-12"}}})");
        if (own) expect1["event"]["id"] = itemId(*own);
        ok = ok && matches(changes[1], expect1);
        check(ok, "ряд с описанием первого дня уходит двумя созданиями разных объектов: ряд без описания и день с описанием");
    }
    {
        auto before = createEmptyState();
        addEntry(before, SeriesKind::Event, series, DescriptionScope::All, "2026-10-12", idSeq);
        const auto instance = eventInstance(before.events[0], "2026-10-19");
        auto all = before;
        setDescription(all, SeriesKind::Event, instance, "Новый зал", DescriptionScope::All, idSeq);
        const auto allChanges = diffChanges(before, all);
        bool ok = allChanges.size() == 1;
        const auto allEvent = ok ? allChanges[0]["event"] : json::object();
        ok = ok && matches(allEvent, J(R"({"id":"e1","description":"Новый зал"})")) && !allEvent.contains("occurrences")
            && !allEvent.contains("name");
        auto one = before;
        const auto own = setDescription(one, SeriesKind::Event, instance, "Только сегодня", DescriptionScope::One, idSeq);
        const auto oneChanges = diffChanges(before, one);
        ok = ok && own.has_value() && oneChanges.size() == 2;
        if (ok) {
            const auto seriesEvent = oneChanges[0]["event"];
            ok = matches(seriesEvent, J(R"({"id":"e1","occurrences":[{"day":"2026-10-19","excluded":true,"done":false,"doneSteps":[]}]})"))
                && !seriesEvent.contains("description");
            json expect1 = J(R"({"event":{"description":"Только сегодня","day":"2026-10-19","origin":{"seriesId":"e1"}}})");
            expect1["event"]["id"] = itemId(*own);
            ok = ok && matches(oneChanges[1], expect1);
        }
        check(ok, "описание «для всех» у экземпляра — одно поле ряда; «только этот день» — отметка дня и новая запись");
    }

    // ── diffChanges (C4): таблица правок ──
    // Адаптация: в C++ подробности здоровья читаются в типы — цель `bedtime` строкой ("23:00") и поля вне типа
    // (`minutes` у упражнения, `waterMl` у целей здоровья) не представимы; в таблице они заменены числовыми
    // значениями полей типа (bedtime 23:00 → 1380 минут, 22:30 → 1350; упражнение — `sets`), цели здоровья
    // сравниваются разобранными
    json DIFF_ENGINE = J(DIFF_ENGINE_TEXT);
    DIFF_ENGINE["health"][3]["details"] = "{\"steps\":8000,\"bedtime\":1380}";
    json EXPECTED = J(EXPECTED_TEXT);
    EXPECTED["здоровье: правка, удаление, новая запись"][1]["health"]["details"] = "{\"ex\":[{\"name\":\"бег\",\"sets\":30}]}";
    EXPECTED["цели здоровья"][0]["health"]["details"] = "{\"steps\":10000,\"bedtime\":1380}";
    EXPECTED["всё сразу"][8]["health"]["details"] = "{\"steps\":8000,\"bedtime\":1350}";
    const auto base = fromEngineState(DIFF_ENGINE);
    const auto eraseId = [](auto &list, const std::string &id) {
        list.erase(std::remove_if(list.begin(), list.end(), [&](const auto &x) { return x.id == id; }), list.end());
    };
    using Mutate = std::function<void(State &)>;
    const std::vector<std::pair<std::string, Mutate>> cases = {
        {"ничего", [](State &) {}},
        {"выполнение задачи", [](State &d) { d.tasks[0].status = "done"; }},
        {"шаг и описание задачи", [](State &d) {
            d.tasks[0].steps[1].isDone = true;
            d.tasks[0].description = "новое";
        }},
        {"удаление и добавление задачи", [&](State &d) {
            eraseId(d.tasks, "t2");
            Task t;
            t.id = "t9"; t.name = "Новая"; t.status = "queue"; t.project = "Дом"; t.rank = 1; t.due = "2026-12-01";
            d.tasks.push_back(t);
        }},
        {"новый список и перенос задачи", [](State &d) {
            d.lists.push_back(List{"l3", "Учёба", 2, 5});
            d.projects.push_back("Учёба");
            d.tasks[1].project = "Учёба";
            d.tasks[0].project = "";
        }},
        {"удаление списка", [&](State &d) {
            eraseId(d.lists, "l2");
            d.projects.erase(std::remove(d.projects.begin(), d.projects.end(), "Дом"), d.projects.end());
        }},
        {"цвет списка", [](State &d) {
            d.lists[0].color = 2;
            d.lists[1].color.reset();
        }},
        {"отметка экземпляра ряда и новое правило", [](State &d) {
            d.tasks[2].occurrences->push_back(Occurrence{"2026-10-06", std::nullopt, true, std::nullopt});
            (*d.tasks[2].occurrences)[0].done = false;
            Repeat r;
            r.kind = "weekly"; r.interval = 2; r.weekdays = std::vector<int>{1, 5}; r.startDay = "2026-10-01";
            r.endDay = "2026-12-31"; r.count = 10;
            d.tasks[2].repeat = r;
        }},
        {"снятие ряда с задачи и дата", [](State &d) {
            d.tasks[2].repeat.reset();
            d.tasks[2].occurrences.reset();
            d.tasks[2].day = "2026-10-20";
        }},
        {"перенос времени события и исключение дня", [](State &d) {
            d.events[1].start = "18:00";
            d.events[1].end = "19:00";
            d.events[1].occurrences->push_back(Occurrence{"2026-10-21", true, std::nullopt, std::nullopt});
        }},
        {"событие по дням недели прежнего формата становится рядом", [](State &d) {
            Repeat r;
            r.kind = "weekly"; r.interval = 1; r.weekdays = std::vector<int>{1, 2, 4}; r.startDay = "2026-10-05";
            d.events[0].repeat = r;
        }},
        {"удаление события и новое разовое", [&](State &d) {
            eraseId(d.events, "e3");
            Event e;
            e.id = "e9"; e.name = "Врач"; e.start = "11:00"; e.end = "11:30"; e.day = "2026-10-22"; e.color = 4;
            e.description = "взять полис";
            d.events.push_back(e);
        }},
        {"отделённый день ряда", [](State &d) {
            Event e;
            e.id = "e10"; e.name = "Бассейн"; e.start = "20:00"; e.end = "21:00"; e.day = "2026-10-19";
            e.origin = Origin{"e2", "2026-10-19"};
            d.events.push_back(e);
            d.events[1].occurrences->push_back(Occurrence{"2026-10-19", true, std::nullopt, std::nullopt});
        }},
        {"правка и удаление записи еды, вода", [&](State &d) {
            auto &day = d.nutrition["2026-10-08"];
            day.entries[0].kcal = 320;
            day.entries[0].time = "09:00";
            eraseId(day.entries, "f2");
            day.waterMl = 750;
        }},
        {"новая запись еды и закрытие дня", [](State &d) {
            FoodEntry f;
            f.id = "f9"; f.name = "Яблоко"; f.meal = "snack"; f.kcal = 80; f.carbs = 20; f.fiber = 3; f.grams = 150;
            f.time = "16:00";
            auto &day = d.nutrition["2026-10-09"];
            day.entries.push_back(f);
            day.isComplete = true;
            day.fixedGoals = GoalValues{{"kcal", Goal{1800, 50}}};
        }},
        {"день еды исчезает и появляется новый", [](State &d) {
            d.nutrition.erase("2026-10-09");
            d.nutrition["2026-10-10"] = NutritionDay{{}, false, std::nullopt, 250.0};
        }},
        {"цели и настройки", [](State &d) {
            d.goals["protein"] = Goal{130, 10};
            d.budget = 600;
            d.settings.dayEnd = 1260;
        }},
        {"только бюджет", [](State &d) { d.budget = 420; }},
        {"период целей: правка, удаление, новый", [](State &d) {
            d.goalPeriods[0].goals = GoalValues{{"kcal", Goal{1400, 100}}, {"water", Goal{2500, 200}}};
            d.goalPeriods.push_back(GoalRecord{"g2", "2026-11-01", "2026-11-07", {}});
        }},
        {"удаление периода целей", [](State &d) { d.goalPeriods.clear(); }},
        {"здоровье: правка, удаление, новая запись", [&](State &d) {
            d.health[1].value = 81.1;
            eraseId(d.health, "h3");
            HealthRecord h;
            h.id = "h9"; h.day = "2026-10-08"; h.kind = "workout"; h.time = "19:00"; h.value = 30; h.value2 = 4.2;
            h.name = "бег";
            h.exercises = std::vector<Exercise>{Exercise{"бег", 30, std::nullopt, std::nullopt}};
            d.health.push_back(h);
        }},
        {"цели здоровья", [](State &d) { d.healthGoals.steps = 10000; }},
        {"словарь: правка типа, длительности, удаление, новое слово", [&](State &d) {
            d.learned[0].minutes = 120;
            d.learned[0].minutesCount = 5;
            d.learned[0].touched = 12;
            eraseId(d.learned, "зал");
            d.learned.push_back(LearnedWord{"созвон", "event", 1, std::nullopt, 0, 13});
        }},
        {"словарь: только тип", [](State &d) {
            d.learned[1].kind = "task";
            d.learned[1].kindCount = 4;
        }},
        {"история ввода: правка, удаление, новая строка", [&](State &d) {
            d.quickLines[0].count = 3;
            d.quickLines[0].touched = 5;
            eraseId(d.quickLines, "q2");
            d.quickLines.push_back(QuickLine{"q9", "зал 19:00", 1, 6, std::nullopt});
        }},
        {"всё сразу", [](State &d) {
            d.tasks[0].status = "done";
            d.tasks[1].name = "Переименовано";
            d.events[2].color = 2;
            d.lists[1].order = 5;
            d.nutrition["2026-10-08"].isComplete = false;
            d.budget = 500;
            d.goalPeriods[0].endDay = "2026-10-16";
            d.health[0].value = 420;
            d.healthGoals.bedtime = 1350;
            d.learned[1].touched = 11;
            d.quickLines[1].touched = 2;
        }},
    };
    for (const auto &[name, mutate] : cases) {
        auto draft = base;
        mutate(draft);
        const auto got = diffChanges(base, draft);
        std::vector<json> expected;
        for (const auto &c : EXPECTED.at(name)) expected.push_back(c);
        bool ok = withParsedGoals(got) == withParsedGoals(expected);
        if (!ok) std::printf("    получено: %s\n", json(got).dump().c_str());
        // Обратная правка — зеркальна по составу записей
        ok = ok && diffChanges(draft, base).size() >= (name == "ничего" ? 0u : 1u);
        check(ok, name);
    }
    {
        auto draft = base;
        draft.tasks[0].status = "done";
        json engine = DIFF_ENGINE;
        engine["tasks"][0]["status"] = "done";
        const auto echo = fromEngineState(engine);
        check(json(echo.tasks[0]) == json(draft.tasks[0]) && diffChanges(draft, echo).empty(),
              "эхо движка с переиспользованными объектами даёт пустую разницу");
    }

    {
        // A0078-1 / A0079: значения вне диапазона и глубокая вложенность не дают UB и не падают
        json engine = DIFF_ENGINE;
        engine["tasks"][0]["remind"] = 1e12;
        engine["tasks"][0]["minutes"] = 1e12;
        engine["tasks"][0]["start"] = std::string(400, '9');
        const auto state = fromEngineState(engine);
        check(state.tasks[0].remind && *state.tasks[0].remind == 2147483647, "remind 1e12 насыщается, а не UB");
        check(state.tasks[0].minutes && *state.tasks[0].minutes <= 100000, "minutes ограничены");
        check(toMinutes(std::string(400, '9') + ":00") == 0 && toMinutes("99999999999:00") >= 0,
              "toMinutes на длинной строке цифр не бросает");
        json deep = engine;
        deep["health"] = json::array({json{{"id", "h1"}, {"day", "2026-01-01"}, {"kind", "workout"},
                                           {"details", "{\"ex\":" + std::string(100000, '[') + std::string(100000, ']') + "}"}}});
        const auto deepState = fromEngineState(deep);
        check(!deepState.health.empty() && !deepState.health[0].exercises, "details глубиной 100000 отвергаются без падения");
    }

    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
