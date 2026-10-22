// Parvane Android (spec 031): «План» и «Здоровье» для экранов Kotlin — запросы (дела дня, сетка часов, задачи без
// даты, сводки здоровья, разбор ввода текстом) и правки (отметки, сохранение задачи/события с выбором «это / это и
// следующие / все», удаление, питание, вода, цели) поверх логики ядра (`parvane::sections::planner`, порт web с
// тестами). Чистые функции над `State`: хаб разделов зовёт их на своём рабочем потоке, правки — внутри
// `PlannerStore::update`, разницу состояний считает ядро. Экраны не повторяют правил повтора и подсчётов.
#include "jni_planner_ops.h"

#include <parvane/sections/planner_forms.h>
#include <parvane/sections/planner_health.h>
#include <parvane/sections/planner_model.h>
#include <parvane/sections/planner_quick.h>
#include <parvane/sections/planner_quick_apply.h>
#include <parvane/sections/planner_reminders.h>
#include <parvane/sections/planner_series.h>

#include <algorithm>
#include <set>
#include <stdexcept>

namespace pvjni::plannerops {
namespace {

using namespace parvane::sections::planner;

IdGen newId() {
    return [] { return randomUuid(); };
}

template <typename T>
PatchField<T> field(const json &a, const char *key) {
    const auto it = a.find(key);
    if (it == a.end()) return std::nullopt;
    if (it->is_null()) return undefinedField<T>();
    return PatchField<T>(std::in_place, it->get<T>());
}

// Правка из JSON экрана: есть ключ — поле меняется, `null` — снимается
ItemPatch patchOf(const json &a) {
    ItemPatch p;
    p.name = field<std::string>(a, "name");
    p.description = field<std::string>(a, "description");
    p.start = field<std::string>(a, "start");
    p.end = field<std::string>(a, "end");
    p.day = field<std::string>(a, "day");
    p.due = field<std::string>(a, "due");
    p.status = field<std::string>(a, "status");
    p.project = field<std::string>(a, "project");
    p.minutes = field<int>(a, "minutes");
    p.color = field<int>(a, "color");
    p.remind = field<int>(a, "remind");
    p.rank = field<double>(a, "rank");
    p.isAllDay = field<bool>(a, "isAllDay");
    p.isHoliday = field<bool>(a, "isHoliday");
    p.steps = field<std::vector<Step>>(a, "steps");
    return p;
}

SeriesKind kindOf(const json &a) { return a.value("kind", std::string("task")) == "event" ? SeriesKind::Event : SeriesKind::Task; }

std::optional<Repeat> repeatOf(const json &a) {
    const auto it = a.find("repeat");
    if (it == a.end() || it->is_null()) return std::nullopt;
    return it->get<Repeat>();
}

RuleScope ruleScopeOf(const std::string &scope) {
    if (scope == "all") return RuleScope::All;
    if (scope == "stop") return RuleScope::Stop;
    if (scope == "one") return RuleScope::One;
    return RuleScope::Following;
}

json itemJson(const SeriesItem &item) {
    return std::visit([](const auto &v) { return json(v); }, item);
}

json timedJson(const State &s, const TimedLayout &t) {
    auto j = json{{"name", t.item.name}, {"start", t.item.start}, {"end", t.item.end},
                  {"lane", t.lane}, {"lanes", t.lanes}, {"right", t.right}};
    if (t.item.task) {
        j["task"] = *t.item.task;
        j["color"] = getListColor(s, t.item.task->project);
    }
    if (t.item.event) {
        j["event"] = *t.item.event;
        j["color"] = getEventColor(s, *t.item.event);
    }
    return j;
}

json dayJson(const State &s, const std::string &day, const DayIndexEntry &e, bool withLayout) {
    auto j = json{{"tasks", e.tasks}, {"events", e.events}, {"deadlines", e.deadlines}, {"isHoliday", e.isHoliday},
                  {"minutes", e.minutes}, {"untimed", e.untimed}, {"allDay", e.allDay}, {"conflicts", e.conflicts},
                  {"unrated", e.unrated}, {"load", getLoadFraction(s, e.minutes)}, {"budget", getDayBudget(s, day)}};
    if (e.holiday) j["holiday"] = *e.holiday;
    if (withLayout) {
        auto timed = json::array();
        for (const auto &t : layoutTimed(e.timed)) timed.push_back(timedJson(s, t));
        j["timed"] = timed;
        const auto avail = getDayAvailability(s, day);
        j["freeMinutes"] = avail.freeMinutes;
    }
    return j;
}

json listsJson(const State &s) {
    auto out = json::array();
    std::set<std::string> seen;
    auto lists = s.lists;
    std::sort(lists.begin(), lists.end(), [](const List &a, const List &b) { return a.order < b.order; });
    for (const auto &l : lists) {
        if (!seen.insert(l.name).second) continue;
        out.push_back(json{{"name", l.name}, {"color", getListColor(s, l.name)}});
    }
    for (const auto &p : s.projects)
        if (!p.empty() && seen.insert(p).second) out.push_back(json{{"name", p}, {"color", getListColor(s, p)}});
    return out;
}

json goalJson(const std::optional<Goal> &g) {
    return g ? json{{"target", g->target}, {"tolerance", g->tolerance}} : json();
}

json recordJson(const std::optional<HealthRecord> &r) { return r ? json(*r) : json(); }

json healthJson(const State &s, const std::string &day, const std::string &today) {
    auto nutrients = json::object();
    for (const auto *n : {"kcal", "protein", "fat", "carbs", "fiber", "water"}) {
        const auto total = getNutrientTotal(s, day, n);
        nutrients[n] = json{{"value", total.value}, {"missing", total.missing}, {"count", total.count},
                            {"goal", goalJson(getNutrientGoal(s, day, n, today))},
                            {"status", getNutrientStatus(s, day, n, today)}};
    }
    const auto week = getLastDays(day);
    auto metrics = json::object();
    for (const auto *m : {"weight", "pressure", "pulse", "steps", "mood"}) {
        metrics[m] = json{{"day", recordJson(getDailyRecord(s, m, day))}, {"latest", recordJson(getLatestRecord(s, m, day))},
                          {"week", getDailySeries(s, m, week)}};
    }
    auto sleepWeek = json::array();
    for (const auto &d : week) sleepWeek.push_back(recordJson(getDailyRecord(s, "sleep", d)));
    const auto routine = getSleepRoutine(s, day);
    auto entries = json::array();
    if (const auto it = s.nutrition.find(day); it != s.nutrition.end()) entries = it->second.entries;
    const auto &g = s.healthGoals;
    return json{
        {"day", day},
        {"week", week},
        {"nutrients", nutrients},
        {"sugar", getLimitTotal(s, day, "sugar")},
        {"salt", getLimitTotal(s, day, "salt")},
        {"food", entries},
        {"closed", isDayClosed(s, day, today)},
        {"metrics", metrics},
        {"sleep", recordJson(getDailyRecord(s, "sleep", day))},
        {"sleepRecords", getSleepRecords(s, day)},
        {"sleepWeek", sleepWeek},
        {"sleepLevel", routine.level},
        {"shortSleep", isShortSleep(s, day)},
        {"workouts", getWorkouts(s, week)},
        {"activeMinutes", getActiveMinutes(s, week)},
        {"budget", getDayBudget(s, day)},
        {"goals", json{{"sugarMax", g.sugarMax ? json(*g.sugarMax) : json()},
                       {"saltMax", g.saltMax ? json(*g.saltMax) : json()},
                       {"sleepMinutes", g.sleepMinutes ? json(*g.sleepMinutes) : json()},
                       {"weight", g.weight ? json(*g.weight) : json()},
                       {"steps", g.steps ? json(*g.steps) : json()},
                       {"activeMinutes", g.activeMinutes ? json(*g.activeMinutes) : json()},
                       {"workouts", g.workouts ? json(*g.workouts) : json()}}},
    };
}

QuickContext quickContext(const json &a, const Context &c, const State &s) {
    auto ctx = QuickContext();
    ctx.today = c.today;
    ctx.nowMinutes = c.nowMinutes;
    ctx.dayStart = s.settings.dayStart;
    ctx.dayEnd = s.settings.dayEnd;
    ctx.lang = c.lang;
    if (a.contains("kind") && a["kind"].is_string()) ctx.kind = a["kind"].get<std::string>();
    if (a.contains("skip") && a["skip"].is_array()) ctx.skip = a["skip"].get<std::vector<std::string>>();
    return ctx;
}

void eraseById(auto &list, const std::string &id) {
    list.erase(std::remove_if(list.begin(), list.end(), [&](const auto &x) { return x.id == id; }), list.end());
}

// Сохранить задачу либо событие. Новая запись — `addEntry`; правка ряда — по `scope` (this | following | all);
// смена правила повтора у экземпляра — `changeSeriesRule`.
json saveItem(State &s, const json &a, const Context &c) {
    const auto kind = kindOf(a);
    const auto &item = a.at("item");
    const auto id = item.value("id", std::string());
    const auto scope = a.value("scope", std::string("all"));
    const auto day = a.value("day", std::string());
    if (id.empty()) {
        SeriesItem entry;
        if (kind == SeriesKind::Task) {
            auto t = item.get<Task>();
            t.id = randomUuid();
            if (!item.contains("rank")) t.rank = newTaskRank(s);
            if (const auto err = validateTask(t)) return json{{"error", *err}};
            if (!t.project.empty()) ensureList(s, t.project, newId());
            entry = t;
        } else {
            auto e = item.get<Event>();
            e.id = randomUuid();
            if (const auto err = validateEvent(e)) return json{{"error", *err}};
            entry = e;
        }
        addEntry(s, kind, entry, a.value("descriptionForAll", true) ? DescriptionScope::All : DescriptionScope::One,
                 day.empty() ? c.today : day, newId());
        return json{{"id", itemId(entry)}};
    }
    const auto patch = patchOf(item);
    const auto found = findSeriesItem(s, kind, id);
    if (!found) return json{{"error", "missing"}};
    const auto repeating = std::visit([](const auto &v) { return isRepeating(v); }, *found);
    const auto newRepeat = repeatOf(item);
    const auto oldRepeat = std::visit([](const auto &v) { return v.repeat; }, *found);
    if (repeating && !day.empty() && item.contains("repeat") && !sameRepeat(oldRepeat, newRepeat)) {
        const auto r = changeSeriesRule(s, kind, id, day, newRepeat, ruleScopeOf(scope), patch, newId());
        return r ? json{{"id", itemId(*r)}} : json{{"error", "repeat"}};
    }
    if (repeating && !day.empty()) {
        std::optional<SeriesItem> r;
        if (scope == "this") r = detachInstance(s, kind, id, day, patch, newId());
        else if (scope == "following") r = splitSeries(s, kind, id, day, patch, newId());
        else r = updateSeries(s, kind, id, day, patch);
        return r ? json{{"id", itemId(*r)}} : json{{"error", "series"}};
    }
    if (kind == SeriesKind::Task) {
        auto *t = findTask(s, id);
        auto copy = *t;
        applyPatch(copy, patch);
        if (item.contains("repeat")) copy.repeat = newRepeat;
        if (const auto err = validateTask(copy)) return json{{"error", *err}};
        if (!copy.project.empty()) ensureList(s, copy.project, newId());
        *findTask(s, id) = copy;
    } else {
        auto *e = findEvent(s, id);
        auto copy = *e;
        applyPatch(copy, patch);
        if (item.contains("repeat")) copy.repeat = newRepeat;
        if (const auto err = validateEvent(copy)) return json{{"error", *err}};
        *findEvent(s, id) = copy;
    }
    return json{{"id", id}};
}

json removeItem(State &s, const json &a) {
    const auto kind = kindOf(a);
    const auto id = a.value("id", std::string());
    const auto day = a.value("day", std::string());
    const auto scope = a.value("scope", std::string("all"));
    const auto found = findSeriesItem(s, kind, id);
    if (!found) return false;
    const auto repeating = std::visit([](const auto &v) { return isRepeating(v); }, *found);
    if (repeating && !day.empty() && scope == "this") return excludeInstance(s, kind, id, day);
    if (repeating && !day.empty() && scope == "following") return truncateSeries(s, kind, id, day);
    if (repeating) {
        removeSeries(s, kind, id);
        return true;
    }
    if (kind == SeriesKind::Task) eraseById(s.tasks, id);
    else eraseById(s.events, id);
    return true;
}

// Задача (или экземпляр ряда на день `day`) по id
std::optional<Task> taskOf(State &s, const json &a) {
    const auto *t = findTask(s, a.value("id", std::string()));
    if (!t) return std::nullopt;
    const auto day = a.value("day", std::string());
    if (!day.empty() && isRepeating(*t)) return taskInstance(*t, day);
    return *t;
}

} // namespace

json query(const State &s, const std::string &op, const json &a, const Context &c) {
    if (op == "days") {
        const auto from = a.value("from", c.today), to = a.value("to", from);
        const auto layout = a.value("layout", false);
        auto out = json::object();
        for (const auto &[day, entry] : getDayIndex(s, from, to)) out[day] = dayJson(s, day, entry, layout);
        return out;
    }
    if (op == "undated") return json{{"undated", getUndatedTasks(s)}, {"completed", getCompletedTasks(s)}};
    if (op == "lists") return listsJson(s);
    if (op == "settings") return json{{"settings", s.settings}, {"budget", s.budget}};
    if (op == "health") return healthJson(s, a.value("day", c.today), c.today);
    if (op == "monthGrid") return getMonthGridKeys(a.value("year", 2026), a.value("month", 0));
    if (op == "week") return getWeekKeys(a.value("day", c.today));
    if (op == "quickParse") return toJson(parseQuickInput(a.value("text", std::string()), quickContext(a, c, s)));
    if (op == "stats") {
        std::vector<std::string> days;
        for (auto d = a.value("from", c.today); d <= a.value("to", c.today) && days.size() < 400; d = addDays(d, 1))
            days.push_back(d);
        const auto t = getTimeStatistics(s, days, {});
        auto rows = json::array();
        for (const auto &r : t.rows) rows.push_back(json{{"name", r.name}, {"minutes", r.minutes}, {"color", r.colorIndex}});
        return json{{"rows", rows}, {"total", t.total}, {"unrated", t.unrated}};
    }
    if (op == "slots") {
        const auto *t = findTask(const_cast<State &>(s), a.value("id", std::string()));
        if (!t) return json::array();
        auto out = json::array();
        for (const auto &x : findSlots(s, *t, c.today, a.value("day", c.today)))
            out.push_back(json{{"day", x.day}, {"start", x.start}, {"end", x.end}});
        return out;
    }
    if (op == "reminders") {
        // Моменты — «настенные» мс (день и время без пояса): Kotlin переводит в настоящие по местной зоне
        const auto now = wallMs(c.today, int(c.nowMinutes));
        const auto plan = readReminders(s, now);
        const auto toJson = [](const std::vector<Reminder> &list) {
            auto out = json::array();
            for (const auto &r : list)
                out.push_back(json{{"key", r.key}, {"at", r.at}, {"startsAt", r.startsAt}, {"title", r.title}, {"kind", r.kind},
                                   {"day", r.day}, {"start", r.start ? json(*r.start) : json()}});
            return out;
        };
        return json{{"upcoming", toJson(plan.upcoming)}, {"due", toJson(plan.due)}, {"nowWall", now}};
    }
    throw std::runtime_error("план: неизвестный запрос " + op);
}

json edit(State &s, const std::string &op, const json &a, const Context &c) {
    if (op == "quickAdd") {
        const auto draft = parseQuickInput(a.value("text", std::string()), quickContext(a, c, s));
        if (draft.error) return json{{"error", *draft.error}};
        const auto id = applyQuickDraft(s, draft, c.today, newId());
        return json{{"kind", draft.kind}, {"id", id ? json(*id) : json()}};
    }
    if (op == "taskDone") {
        const auto t = taskOf(s, a);
        return t ? setTaskDone(s, *t, a.value("done", true)) : false;
    }
    if (op == "stepDone") {
        const auto t = taskOf(s, a);
        return t ? setTaskStepDone(s, *t, a.value("index", 0), a.value("done", true)) : false;
    }
    if (op == "status") {
        auto *t = findTask(s, a.value("id", std::string()));
        if (!t) return false;
        t->status = a.value("status", std::string("queue"));
        return true;
    }
    if (op == "move") return moveTask(s, a.value("id", std::string()), a.value("direction", 1), c.today);
    if (op == "save") return saveItem(s, a, c);
    if (op == "remove") return removeItem(s, a);
    if (op == "food") {
        auto input = FoodInput();
        input.name = a.value("name", std::string());
        input.meal = a.value("meal", std::string("other"));
        input.isPer100 = a.value("isPer100", false);
        if (a.contains("grams") && a["grams"].is_number()) input.grams = a["grams"].get<double>();
        if (a.contains("values") && a["values"].is_object()) input.values = a["values"].get<NutrientMap>();
        const auto entry = makeFoodEntry(input, newId());
        s.nutrition[a.value("day", c.today)].entries.push_back(entry);
        return json{{"id", entry.id}};
    }
    if (op == "removeFood") {
        const auto it = s.nutrition.find(a.value("day", c.today));
        if (it == s.nutrition.end()) return false;
        eraseById(it->second.entries, a.value("id", std::string()));
        return true;
    }
    if (op == "water") {
        auto &day = s.nutrition[a.value("day", c.today)];
        const auto add = a.value("add", 0.0);
        day.waterMl = std::max(0.0, (a.contains("ml") ? a.value("ml", 0.0) : day.waterMl.value_or(0) + add));
        return true;
    }
    if (op == "removeHealth") {
        eraseById(s.health, a.value("id", std::string()));
        return true;
    }
    if (op == "goals") {
        for (const auto &[k, v] : a.value("goals", json::object()).items()) {
            if (v.is_null()) s.goals.erase(k);
            else s.goals[k] = Goal{v.value("target", 0.0), v.value("tolerance", 0.0)};
        }
        return true;
    }
    if (op == "healthGoals") {
        auto &g = s.healthGoals;
        const auto set = [&](const char *k, std::optional<double> &v) {
            if (!a.contains(k)) return;
            v = a[k].is_number() ? std::optional<double>(a[k].get<double>()) : std::nullopt;
        };
        set("sugarMax", g.sugarMax);
        set("saltMax", g.saltMax);
        set("sleepMinutes", g.sleepMinutes);
        set("weight", g.weight);
        set("steps", g.steps);
        set("activeMinutes", g.activeMinutes);
        set("workouts", g.workouts);
        return true;
    }
    if (op == "settings") {
        auto next = s.settings;
        const auto set = [&](const char *k, int &v) {
            if (a.contains(k) && a[k].is_number()) v = a[k].get<int>();
        };
        set("dayStart", next.dayStart);
        set("dayEnd", next.dayEnd);
        set("lunchStart", next.lunchStart);
        set("lunchEnd", next.lunchEnd);
        set("margin", next.margin);
        if (const auto err = validateSettings(next)) return json{{"error", *err}};
        s.settings = next;
        if (a.contains("budget") && a["budget"].is_number()) {
            if (!validateBudget(a["budget"].get<double>())) return json{{"error", "budget"}};
            s.budget = a["budget"].get<int>();
        }
        return true;
    }
    if (op == "markReminded") {
        auto changed = false;
        for (const auto &k : a.value("keys", json::array())) {
            if (!k.is_string()) continue;
            const auto key = k.get<std::string>();
            if (std::find(s.reminded.begin(), s.reminded.end(), key) != s.reminded.end()) continue;
            s.reminded.push_back(key);
            changed = true;
        }
        return changed;
    }
    if (op == "list") {
        const auto name = a.value("name", std::string());
        if (name.empty()) return false;
        auto *l = ensureList(s, name, newId());
        if (a.contains("color") && a["color"].is_number()) l->color = a["color"].get<int>();
        return true;
    }
    throw std::runtime_error("план: неизвестная правка " + op);
}

bool isEdit(const std::string &op) {
    static const std::set<std::string> kEdits = {"quickAdd", "taskDone", "stepDone", "status", "move", "save", "remove",
                                                 "food", "removeFood", "water", "removeHealth", "goals", "healthGoals",
                                                 "settings", "list", "markReminded"};
    return kEdits.count(op) > 0;
}

} // namespace pvjni::plannerops
