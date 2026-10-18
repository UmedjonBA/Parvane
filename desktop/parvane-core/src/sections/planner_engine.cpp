// Parvane fork (spec 029, T029): «План» ↔ движок — порт web `plannerSync.ts` (см. заголовок).
#include "parvane/sections/planner_engine.h"

#include <algorithm>
#include <cmath>
#include <map>
#include <optional>
#include <set>

#include "parvane/sections/planner_model.h"

namespace parvane::sections::planner {

namespace {

// ── чтение JSON движка ───────────────────────────────────────────────────────

const json *field(const json &j, const char *key) {
    if (!j.is_object()) return nullptr;
    const auto it = j.find(key);
    return it == j.end() ? nullptr : &*it;
}

// Значение есть и не null (JS: `!= null`)
bool present(const json *v) { return v && !v->is_null(); }

// Истинность значения JS (`||`, `?:`)
bool truthy(const json *v) {
    if (!v || v->is_null()) return false;
    if (v->is_boolean()) return v->get<bool>();
    if (v->is_number()) {
        const double d = v->get<double>();
        return d != 0 && !std::isnan(d);
    }
    if (v->is_string()) return !v->get_ref<const std::string &>().empty();
    return true;
}

std::string str(const json &j, const char *key) {
    const auto *v = field(j, key);
    return v && v->is_string() ? v->get<std::string>() : std::string();
}

// `x || undefined` для строки
std::optional<std::string> strOrNone(const json &j, const char *key) {
    auto s = str(j, key);
    if (s.empty()) return std::nullopt;
    return s;
}

double num(const json &j, const char *key, double fallback = 0) {
    const auto *v = field(j, key);
    return v && v->is_number() ? v->get<double>() : fallback;
}

std::optional<double> numOpt(const json &j, const char *key) {
    const auto *v = field(j, key);
    if (v && v->is_number()) return v->get<double>();
    return std::nullopt;
}

std::optional<int> intOpt(const json &j, const char *key) {
    const auto v = numOpt(j, key);
    if (!v) return std::nullopt;
    return static_cast<int>(*v);
}

std::vector<int> intList(const json *v) {
    std::vector<int> out;
    if (!v || !v->is_array()) return out;
    for (const auto &x : *v) {
        if (x.is_number()) out.push_back(x.get<int>());
    }
    return out;
}

bool contains(const std::vector<std::string> &list, const std::string &value) {
    return std::find(list.begin(), list.end(), value) != list.end();
}

// JS Math.round: половина — вверх
double jsRound(double x) { return std::floor(x + 0.5); }

// ── движок → состояние ───────────────────────────────────────────────────────

GoalValues goalValuesFrom(const json *goals) {
    GoalValues out;
    if (!truthy(goals) || !goals->is_object()) return out;
    for (const auto &metric : kGoalMetrics) {
        const auto *goal = field(*goals, metric.c_str());
        if (truthy(goal) && goal->is_object()) out[metric] = Goal{num(*goal, "target"), num(*goal, "tolerance")};
    }
    return out;
}

std::optional<Repeat> repeatFrom(const json *repeat, const json *legacyWeekdays = nullptr) {
    if (truthy(repeat) && repeat->is_object() && contains(kRepeatKinds, str(*repeat, "kind"))) {
        Repeat r;
        r.kind = str(*repeat, "kind");
        const int interval = static_cast<int>(num(*repeat, "interval"));
        r.interval = interval ? interval : 1;
        if (r.kind == "weekly") {
            if (const auto *w = field(*repeat, "weekdays"); present(w)) r.weekdays = intList(w);
        }
        const int monthDay = static_cast<int>(num(*repeat, "monthDay"));
        if (r.kind == "monthly" && monthDay) r.monthDay = monthDay;
        r.startDay = str(*repeat, "startDay");
        r.endDay = strOrNone(*repeat, "endDay");
        const int count = static_cast<int>(num(*repeat, "count"));
        if (count) r.count = count;
        return r;
    }
    // События «по дням недели» этапов 1–2 — еженедельный ряд без нижней границы (R5)
    if (legacyWeekdays && legacyWeekdays->is_array() && !legacyWeekdays->empty()) {
        Repeat r;
        r.kind = "weekly";
        r.interval = 1;
        r.weekdays = intList(legacyWeekdays);
        r.startDay = "";
        return r;
    }
    return std::nullopt;
}

std::optional<std::vector<Occurrence>> occurrencesFrom(const json *items) {
    if (!items || !items->is_array() || items->empty()) return std::nullopt;
    std::vector<Occurrence> out;
    for (const auto &o : *items) {
        Occurrence occ;
        occ.day = str(o, "day");
        if (const auto *v = field(o, "excluded"); v && v->is_boolean()) occ.excluded = v->get<bool>();
        if (const auto *v = field(o, "done"); v && v->is_boolean()) occ.done = v->get<bool>();
        if (const auto *v = field(o, "doneSteps"); v && v->is_array()) occ.doneSteps = intList(v);
        out.push_back(occ);
    }
    return out;
}

std::optional<Origin> originFrom(const json *origin) {
    if (!truthy(origin) || !origin->is_object()) return std::nullopt;
    return Origin{str(*origin, "seriesId"), str(*origin, "day")};
}

FoodEntry entryFrom(const json &e) {
    FoodEntry entry;
    entry.id = str(e, "id");
    entry.name = str(e, "name");
    const auto meal = str(e, "meal");
    entry.meal = contains(kMeals, meal) ? meal : "other";
    entry.kcal = num(e, "kcal");
    entry.protein = numOpt(e, "protein");
    entry.fat = numOpt(e, "fat");
    entry.carbs = numOpt(e, "carbs");
    entry.fiber = numOpt(e, "fiber");
    entry.grams = numOpt(e, "grams");
    const bool per100 = truthy(field(e, "per100")) && entry.grams && *entry.grams != 0;
    entry.sugar = numOpt(e, "sugar");
    entry.salt = numOpt(e, "salt");
    entry.time = strOrNone(e, "time");
    if (per100) {
        NutrientMap values;
        const double grams = *entry.grams;
        const std::map<std::string, std::optional<double>> nutrients = {
            {"kcal", entry.kcal}, {"protein", entry.protein}, {"fat", entry.fat},
            {"carbs", entry.carbs}, {"fiber", entry.fiber},
        };
        for (const auto &[name, v] : nutrients) {
            if (v && isKnownNumber(*v)) values[name] = jsRound((*v / grams) * 100 * 10000) / 10000;
        }
        entry.per100 = values;
    }
    return entry;
}

// Подробности записи здоровья — JSON; негодные — запись остаётся без них
std::optional<json> parseDetails(const std::string &details) {
    if (details.empty()) return std::nullopt;
    auto parsed = json::parse(details, nullptr, false);
    if (parsed.is_discarded()) return std::nullopt;
    return parsed;
}

std::optional<std::vector<Exercise>> exercisesFrom(const std::string &details) {
    const auto parsed = parseDetails(details);
    if (!parsed || !parsed->is_object()) return std::nullopt;
    const auto *ex = field(*parsed, "ex");
    if (!ex || !ex->is_array() || ex->empty()) return std::nullopt;
    std::vector<Exercise> out;
    for (const auto &item : *ex) {
        Exercise e;
        e.name = str(item, "name");
        e.sets = numOpt(item, "sets");
        e.reps = numOpt(item, "reps");
        e.weight = numOpt(item, "weight");
        out.push_back(e);
    }
    return out;
}

// Цели здоровья из подробностей: только числовые поля типа (в web объект берётся как есть)
std::optional<HealthGoals> healthGoalsFrom(const std::string &details) {
    const auto parsed = parseDetails(details);
    // web: `parseDetails(…) || empty.healthGoals` — любой разобранный не-null объект истинен
    if (!parsed || parsed->is_null() || (parsed->is_boolean() && !parsed->get<bool>())) return std::nullopt;
    HealthGoals g;
    if (!parsed->is_object()) return g;
    g.sugarMax = numOpt(*parsed, "sugarMax");
    g.saltMax = numOpt(*parsed, "saltMax");
    g.sleepMinutes = numOpt(*parsed, "sleepMinutes");
    g.bedtime = numOpt(*parsed, "bedtime");
    g.wakeTime = numOpt(*parsed, "wakeTime");
    g.weight = numOpt(*parsed, "weight");
    g.steps = numOpt(*parsed, "steps");
    g.activeMinutes = numOpt(*parsed, "activeMinutes");
    g.workouts = numOpt(*parsed, "workouts");
    return g;
}

HealthRecord healthFrom(const json &record) {
    HealthRecord r;
    r.id = str(record, "id");
    r.day = str(record, "day");
    r.kind = str(record, "kind");
    r.time = strOrNone(record, "time");
    r.endTime = strOrNone(record, "endTime");
    r.value = num(record, "value");
    if (const double v2 = num(record, "value2"); v2 != 0 && !std::isnan(v2)) r.value2 = v2;
    r.name = strOrNone(record, "name");
    r.exercises = exercisesFrom(str(record, "details"));
    return r;
}

// ── состояние → изменения ───────────────────────────────────────────────────

template <typename T>
json toJson(const T &value) {
    json j = value;
    return j;
}

template <typename T>
bool same(const T &a, const T &b) {
    return toJson(a) == toJson(b);
}

// JSON-текст в порядке полей (как `JSON.stringify` объекта, собранного в этом порядке)
using ordered = nlohmann::ordered_json;

void putNum(ordered &j, const char *key, const std::optional<double> &v) {
    if (!v) return;
    const json n = jsonNumber(*v);
    j[key] = n.is_number_integer() ? ordered(n.get<std::int64_t>()) : ordered(n.get<double>());
}

std::string exercisesDetails(const std::vector<Exercise> &exercises) {
    ordered list = ordered::array();
    for (const auto &e : exercises) {
        ordered item = ordered::object();
        item["name"] = e.name;
        putNum(item, "sets", e.sets);
        putNum(item, "reps", e.reps);
        putNum(item, "weight", e.weight);
        list.push_back(item);
    }
    ordered root = ordered::object();
    root["ex"] = list;
    return root.dump();
}

std::string healthGoalsDetails(const HealthGoals &g) {
    ordered root = ordered::object();
    putNum(root, "sugarMax", g.sugarMax);
    putNum(root, "saltMax", g.saltMax);
    putNum(root, "sleepMinutes", g.sleepMinutes);
    putNum(root, "bedtime", g.bedtime);
    putNum(root, "wakeTime", g.wakeTime);
    putNum(root, "weight", g.weight);
    putNum(root, "steps", g.steps);
    putNum(root, "activeMinutes", g.activeMinutes);
    putNum(root, "workouts", g.workouts);
    return root.dump();
}

json healthChange(const HealthRecord &record) {
    return json{{"health", {
        {"id", record.id},
        {"day", record.day},
        {"kind", record.kind},
        {"time", record.time.value_or("")},
        {"endTime", record.endTime.value_or("")},
        {"value", jsonNumber(record.value)},
        {"value2", jsonNumber(record.value2.value_or(0))},
        {"name", record.name.value_or("")},
        {"details", record.exercises && !record.exercises->empty() ? exercisesDetails(*record.exercises) : ""},
    }}};
}

json healthGoalsChange(const HealthGoals &goals) {
    return json{{"health", {
        {"id", kHealthGoalsId}, {"day", kHealthGoalsDay}, {"kind", kHealthGoalsKind}, {"value", 0},
        {"details", healthGoalsDetails(goals)},
    }}};
}

std::string listIdOf(const State &state, const std::string &name) {
    if (name.empty()) return "";
    for (const auto &list : state.lists) {
        if (list.name == name) return list.id;
    }
    return "";
}

json intArray(const std::vector<int> &v) {
    json a = json::array();
    for (int x : v) a.push_back(x);
    return a;
}

json repeatOf(const std::optional<Repeat> &repeat) {
    if (!repeat) return nullptr;
    return json{
        {"kind", repeat->kind},
        {"interval", repeat->interval},
        {"weekdays", repeat->kind == "weekly" ? intArray(repeat->weekdays.value_or(std::vector<int>{})) : json::array()},
        {"monthDay", repeat->kind == "monthly" ? repeat->monthDay.value_or(0) : 0},
        {"startDay", repeat->startDay},
        {"endDay", repeat->endDay.value_or("")},
        {"count", repeat->count.value_or(0)},
    };
}

// Движок сливает экземпляры по дню — уходят только изменённые дни
json occurrencesOf(const std::optional<std::vector<Occurrence>> &next,
                   const std::optional<std::vector<Occurrence>> &previous) {
    json out = json::array();
    if (!next || next->empty()) return out;
    std::map<std::string, const Occurrence *> before;
    if (previous) {
        for (const auto &o : *previous) before[o.day] = &o;
    }
    for (const auto &o : *next) {
        const auto it = before.find(o.day);
        if (it != before.end() && same(*it->second, o)) continue;
        out.push_back(json{
            {"day", o.day},
            {"excluded", o.excluded.value_or(false)},
            {"done", o.done.value_or(false)},
            {"doneSteps", intArray(o.doneSteps.value_or(std::vector<int>{}))},
        });
    }
    return out;
}

json originOf(const std::optional<Origin> &origin) {
    if (!origin) return nullptr;
    return json{{"seriesId", origin->seriesId}, {"day", origin->day}};
}

json optInt(const std::optional<int> &v) {
    if (!v) return nullptr;
    return *v;
}

json taskChange(const State &state, const Task &t, const Task *previous) {
    json steps = json::array();
    for (const auto &s : t.steps) steps.push_back(json{{"text", s.text}, {"isDone", s.isDone}});
    return json{{"task", {
        {"id", t.id},
        {"name", t.name},
        {"description", t.description},
        {"steps", steps},
        {"status", t.status},
        {"listId", listIdOf(state, t.project)},
        {"rank", jsonNumber(t.rank)},
        {"day", t.day.value_or("")},
        {"start", t.start.value_or("")},
        {"due", t.due.value_or("")},
        {"minutes", optInt(t.minutes)},
        {"repeat", repeatOf(t.repeat)},
        {"occurrences", occurrencesOf(t.occurrences, previous ? previous->occurrences : std::nullopt)},
        {"origin", originOf(t.origin)},
        {"source", t.source ? json{{"chat", t.source->chat}, {"opId", t.source->opId}} : json(nullptr)},
        {"remind", optInt(t.remind)},
    }}};
}

json eventChange(const State &state, const Event &e, const Event *previous) {
    return json{{"event", {
        {"id", e.id},
        {"name", e.name},
        {"start", e.start},
        {"end", e.end},
        {"weekdays", nullptr},
        {"day", e.day.value_or("")},
        {"repeat", repeatOf(e.repeat)},
        {"occurrences", occurrencesOf(e.occurrences, previous ? previous->occurrences : std::nullopt)},
        {"origin", originOf(e.origin)},
        {"allDay", e.isAllDay.value_or(false)},
        {"isHoliday", e.isHoliday.value_or(false)},
        {"color", e.color.value_or(0)},
        {"description", e.description.value_or("")},
        {"remind", optInt(e.remind)},
        {"listId", listIdOf(state, e.project.value_or(""))},
    }}};
}

json listChange(const List &l) {
    return json{{"list", {{"id", l.id}, {"name", l.name}, {"order", jsonNumber(l.order)}, {"color", l.color.value_or(0)}}}};
}

json goalsOf(const GoalValues &goals) {
    json out = json::object();
    for (const auto &metric : kGoalMetrics) {
        const auto it = goals.find(metric);
        out[metric] = it == goals.end() ? json(nullptr)
            : json{{"target", jsonNumber(it->second.target)}, {"tolerance", jsonNumber(it->second.tolerance)}};
    }
    return out;
}

json goalPeriodChange(const GoalRecord &record) {
    json body = goalsOf(record.goals);
    body["id"] = record.id;
    body["startDay"] = record.startDay;
    body["endDay"] = record.endDay;
    return json{{"goalPeriod", body}};
}

json optNum(const std::optional<double> &v) {
    if (!v || !isKnownNumber(*v)) return nullptr;
    return jsonNumber(*v);
}

// `v === undefined ? null : v`
json optNumRaw(const std::optional<double> &v) {
    if (!v) return nullptr;
    return jsonNumber(*v);
}

json entryOf(const FoodEntry &e) {
    return json{
        {"id", e.id},
        {"name", e.name},
        {"meal", e.meal},
        {"kcal", jsonNumber(e.kcal)},
        {"protein", optNum(e.protein)},
        {"fat", optNum(e.fat)},
        {"carbs", optNum(e.carbs)},
        {"fiber", optNum(e.fiber)},
        {"grams", optNum(e.grams)},
        {"per100", e.per100.has_value()},
        {"sugar", optNum(e.sugar)},
        {"salt", optNum(e.salt)},
        {"time", e.time.value_or("")},
    };
}

json dayChange(const std::string &day, const NutritionDay &d, const NutritionDay *previous) {
    json entries = json::array();
    std::map<std::string, const FoodEntry *> beforeById;
    std::set<std::string> afterIds;
    if (previous) {
        for (const auto &p : previous->entries) beforeById[p.id] = &p;
    }
    for (const auto &e : d.entries) afterIds.insert(e.id);
    for (const auto &e : d.entries) {
        const auto it = beforeById.find(e.id);
        if (it == beforeById.end() || !same(*it->second, e)) entries.push_back(entryOf(e));
    }
    if (previous) {
        for (const auto &p : previous->entries) {
            if (!afterIds.count(p.id)) entries.push_back(json{{"id", p.id}, {"deleted", true}});
        }
    }
    json change = json{{"day", day}, {"entries", entries}};
    if (!previous || previous->isComplete != d.isComplete) change["isComplete"] = d.isComplete;
    const bool fixedSame = previous && previous->fixedGoals.has_value() == d.fixedGoals.has_value()
        && (!d.fixedGoals || same(*previous->fixedGoals, *d.fixedGoals));
    if (!fixedSame) change["fixedGoals"] = d.fixedGoals ? goalsOf(*d.fixedGoals) : json(nullptr);
    if (!previous || previous->waterMl != d.waterMl) change["waterMl"] = optNumRaw(d.waterMl);
    return json{{"nutritionDay", change}};
}

// Слово словаря правок: значение и его счётчик уходят парой, и только изменившаяся пара; новое слово — целиком
json learnedChange(const LearnedWord &word, const LearnedWord *before) {
    json change = json{{"id", word.id}};
    if (!before || before->kind != word.kind || before->kindCount != word.kindCount) {
        change["kind"] = word.kind.value_or("");
        change["kindCount"] = word.kindCount;
    }
    if (!before || before->minutes != word.minutes || before->minutesCount != word.minutesCount) {
        change["minutes"] = optInt(word.minutes);
        change["minutesCount"] = word.minutesCount;
    }
    if (!before || before->touched != word.touched) change["touched"] = jsonNumber(word.touched);
    return json{{"learned", change}};
}

json quickLineChange(const QuickLine &line) {
    return json{{"quickLine", {
        {"id", line.id}, {"text", line.text}, {"count", line.count}, {"touched", jsonNumber(line.touched)},
        {"hidden", line.isHidden.value_or(false)},
    }}};
}

json settingsChange(const State &state) {
    json body = toJson(state.settings);
    body["budget"] = state.budget;
    return json{{"settings", body}};
}

// Правка существующего объекта несёт только изменившиеся поля: движок сводит объект по полям
json onlyChanged(const std::string &kind, const json &change, const json *before) {
    if (!before) return change;
    const auto &next = change.at(kind);
    const auto &old = before->at(kind);
    json out = json::object();
    for (const auto &[key, value] : next.items()) {
        bool keep;
        if (key == "id") keep = true;
        // У события правило уходит всегда, парой: `weekdays: null` снимает правило прежнего формата
        else if (kind == "event" && (key == "weekdays" || key == "repeat")) keep = true;
        else if (key == "occurrences") keep = value.is_array() && !value.empty();
        else keep = !old.contains(key) || old.at(key) != value;
        if (keep) out[key] = value;
    }
    return json{{kind, out}};
}

// Коллекция по id: изменившиеся и новые — в порядке нового состояния, пропавшие — в порядке прежнего
template <typename T, typename OnChanged, typename OnDeleted>
void diffById(const std::vector<T> &nextItems, const std::vector<T> &previousItems, OnChanged onChanged,
              OnDeleted onDeleted) {
    std::map<std::string, const T *> before;
    for (const auto &item : previousItems) before.emplace(item.id, &item);
    std::set<std::string> after;
    for (const auto &item : nextItems) {
        after.insert(item.id);
        const auto it = before.find(item.id);
        const T *old = it == before.end() ? nullptr : it->second;
        if (!old || !same(*old, item)) onChanged(item, old);
    }
    for (const auto &item : previousItems) {
        if (!after.count(item.id)) onDeleted(item);
    }
}

json tombstone(const char *kind, const std::string &id) { return json{{kind, {{"id", id}, {"deleted", true}}}}; }

bool isDigits(const std::string &s) {
    return !s.empty() && std::all_of(s.begin(), s.end(), [](char c) { return c >= '0' && c <= '9'; });
}

// Первые `n` кодовых точек UTF-8 (в web — единицы UTF-16 `slice`)
std::string headCodepoints(const std::string &s, size_t n) {
    size_t i = 0, count = 0;
    while (i < s.size() && count < n) {
        const auto c = static_cast<unsigned char>(s[i]);
        size_t len = c < 0x80 ? 1 : (c & 0xE0) == 0xC0 ? 2 : (c & 0xF0) == 0xE0 ? 3 : (c & 0xF8) == 0xF0 ? 4 : 1;
        i = std::min(s.size(), i + len);
        ++count;
    }
    return s.substr(0, i);
}

} // namespace

json jsonNumber(double value) {
    if (std::isfinite(value) && std::floor(value) == value && std::fabs(value) < 9007199254740992.0) {
        return static_cast<std::int64_t>(value);
    }
    return value;
}

// ── движок → состояние ───────────────────────────────────────────────────────

State fromEngineState(const json &engine) {
    const State empty = createEmptyState();
    State built;
    built.version = 1;

    // Списки: по порядку, затем по имени; одноимённые (созданы на двух устройствах без связи) — первым
    std::vector<List> sorted;
    if (const auto *lists = field(engine, "lists"); lists && lists->is_array()) {
        for (const auto &l : *lists) {
            List list;
            list.id = str(l, "id");
            list.name = str(l, "name");
            list.order = num(l, "order");
            if (const int color = static_cast<int>(num(l, "color")); color) list.color = color;
            sorted.push_back(list);
        }
    }
    std::stable_sort(sorted.begin(), sorted.end(), [](const List &a, const List &b) {
        if (a.order != b.order) return a.order < b.order;
        return a.name < b.name;
    });
    std::map<std::string, std::string> nameById;
    for (const auto &list : sorted) nameById[list.id] = list.name;
    std::set<std::string> seenNames;
    for (const auto &list : sorted) {
        if (!seenNames.insert(list.name).second) continue;
        built.lists.push_back(list);
    }
    const auto nameOf = [&](const std::string &id) -> std::string {
        const auto it = nameById.find(id);
        return it == nameById.end() ? std::string() : it->second;
    };

    if (const auto *tasks = field(engine, "tasks"); tasks && tasks->is_array()) {
        for (const auto &t : *tasks) {
            Task task;
            task.id = str(t, "id");
            task.name = str(t, "name");
            task.description = str(t, "description");
            if (const auto *steps = field(t, "steps"); steps && steps->is_array()) {
                for (const auto &s : *steps) {
                    const auto *done = field(s, "isDone");
                    task.steps.push_back(Step{str(s, "text"), done && done->is_boolean() && done->get<bool>()});
                }
            }
            const auto status = str(t, "status");
            task.status = contains(kStatuses, status) ? status : "queue";
            task.project = nameOf(str(t, "listId"));
            task.rank = num(t, "rank");
            task.day = strOrNone(t, "day");
            task.start = strOrNone(t, "start");
            task.due = strOrNone(t, "due");
            task.minutes = intOpt(t, "minutes");
            task.repeat = repeatFrom(field(t, "repeat"));
            task.occurrences = occurrencesFrom(field(t, "occurrences"));
            task.origin = originFrom(field(t, "origin"));
            task.remind = intOpt(t, "remind");
            if (const auto *source = field(t, "source"); truthy(source) && source->is_object()) {
                task.source = Source{str(*source, "chat"), str(*source, "opId")};
            }
            built.tasks.push_back(task);
        }
    }

    if (const auto *events = field(engine, "events"); events && events->is_array()) {
        for (const auto &e : *events) {
            Event event;
            const auto repeat = repeatFrom(field(e, "repeat"), field(e, "weekdays"));
            event.id = str(e, "id");
            event.name = str(e, "name");
            // Движок прежней сборки поля не отдаёт
            event.description = strOrNone(e, "description");
            event.start = str(e, "start");
            event.end = str(e, "end");
            if (!repeat) event.day = strOrNone(e, "day");
            event.repeat = repeat;
            event.occurrences = occurrencesFrom(field(e, "occurrences"));
            event.origin = originFrom(field(e, "origin"));
            if (truthy(field(e, "allDay"))) event.isAllDay = true;
            if (truthy(field(e, "isHoliday"))) event.isHoliday = true;
            if (const int color = static_cast<int>(num(e, "color")); color) event.color = color;
            event.remind = intOpt(e, "remind");
            // Группа — по id списка, как у задачи
            if (const auto listId = str(e, "listId"); !listId.empty()) {
                if (auto name = nameOf(listId); !name.empty()) event.project = name;
            }
            built.events.push_back(event);
        }
    }

    built.projects = {""};
    for (const auto &list : built.lists) built.projects.push_back(list.name);

    if (const auto *nutrition = field(engine, "nutrition"); nutrition && nutrition->is_array()) {
        for (const auto &d : *nutrition) {
            const auto *entries = field(d, "entries");
            const bool hasEntries = entries && entries->is_array() && !entries->empty();
            const auto *water = field(d, "waterMl");
            // web: `d.waterMl === null` — пропущенное поле днём без данных не считается
            if (!hasEntries && !truthy(field(d, "isComplete")) && water && water->is_null()) continue;
            NutritionDay day;
            if (hasEntries) {
                for (const auto &entry : *entries) day.entries.push_back(entryFrom(entry));
            }
            day.isComplete = truthy(field(d, "isComplete"));
            if (const auto *fixed = field(d, "fixedGoals"); truthy(fixed)) {
                auto goals = goalValuesFrom(fixed);
                if (!goals.empty()) day.fixedGoals = goals;
            }
            if (water && water->is_number()) day.waterMl = water->get<double>();
            built.nutrition[str(d, "day")] = day;
        }
    }

    const auto *settings = field(engine, "settings");
    const bool hasSettings = truthy(settings) && settings->is_object();
    const auto goals = goalValuesFrom(field(engine, "goals"));
    built.goals = goals.empty() ? empty.goals : goals;
    if (const auto *periods = field(engine, "goalPeriods"); periods && periods->is_array()) {
        for (const auto &p : *periods) {
            built.goalPeriods.push_back(GoalRecord{str(p, "id"), str(p, "startDay"), str(p, "endDay"), goalValuesFrom(&p)});
        }
    }
    built.budget = hasSettings && present(field(*settings, "budget")) ? static_cast<int>(num(*settings, "budget"))
                                                                       : empty.budget;
    if (hasSettings) {
        built.settings.dayStart = static_cast<int>(num(*settings, "dayStart"));
        built.settings.dayEnd = static_cast<int>(num(*settings, "dayEnd"));
        built.settings.lunchStart = static_cast<int>(num(*settings, "lunchStart"));
        built.settings.lunchEnd = static_cast<int>(num(*settings, "lunchEnd"));
        built.settings.margin = static_cast<int>(num(*settings, "margin"));
    } else {
        built.settings = defaultSettings();
    }

    std::optional<HealthGoals> healthGoals;
    if (const auto *health = field(engine, "health"); health && health->is_array()) {
        for (const auto &record : *health) {
            if (!healthGoals && str(record, "id") == kHealthGoalsId) healthGoals = healthGoalsFrom(str(record, "details"));
            if (str(record, "kind") == kHealthGoalsKind) continue;
            built.health.push_back(healthFrom(record));
        }
    }
    built.healthGoals = healthGoals ? *healthGoals : empty.healthGoals;

    json learned = json::array();
    if (const auto *words = field(engine, "learned"); words && words->is_array()) {
        for (const auto &word : *words) {
            json w = word;
            if (w.is_object() && w.contains("minutes") && w["minutes"].is_null()) w.erase("minutes");
            learned.push_back(w);
        }
    }
    built.learned = normalizeLearned(learned);

    json lines = json::array();
    if (const auto *quick = field(engine, "quickLines"); quick && quick->is_array()) {
        for (const auto &line : *quick) {
            json l = line;
            if (l.is_object()) {
                const bool hidden = truthy(field(line, "hidden"));
                l.erase("hidden");
                if (hidden) l["isHidden"] = true;
            }
            lines.push_back(l);
        }
    }
    built.quickLines = normalizeQuickLines(lines);

    if (const auto *reminded = field(engine, "reminded"); reminded && reminded->is_array()) {
        for (const auto &id : *reminded) {
            if (id.is_string()) built.reminded.push_back(id.get<std::string>());
        }
        std::sort(built.reminded.begin(), built.reminded.end());
    }
    return built;
}

bool hasEngineQuickLines(const json &engine) {
    const auto *quick = field(engine, "quickLines");
    return quick && quick->is_array();
}

// ── состояние → изменения ───────────────────────────────────────────────────

std::vector<PlannerChange> diffChanges(const State &previous, const State &next) {
    std::vector<PlannerChange> changes;

    diffById(next.lists, previous.lists, [&](const List &list, const List *before) {
        const auto old = before ? std::optional<json>(listChange(*before)) : std::nullopt;
        changes.push_back(onlyChanged("list", listChange(list), old ? &*old : nullptr));
    }, [&](const List &list) { changes.push_back(tombstone("list", list.id)); });

    diffById(next.tasks, previous.tasks, [&](const Task &task, const Task *before) {
        const auto old = before ? std::optional<json>(taskChange(previous, *before, nullptr)) : std::nullopt;
        changes.push_back(onlyChanged("task", taskChange(next, task, before), old ? &*old : nullptr));
    }, [&](const Task &task) { changes.push_back(tombstone("task", task.id)); });

    diffById(next.events, previous.events, [&](const Event &event, const Event *before) {
        const auto old = before ? std::optional<json>(eventChange(previous, *before, nullptr)) : std::nullopt;
        changes.push_back(onlyChanged("event", eventChange(next, event, before), old ? &*old : nullptr));
    }, [&](const Event &event) { changes.push_back(tombstone("event", event.id)); });

    for (const auto &[day, record] : next.nutrition) {
        const auto it = previous.nutrition.find(day);
        const NutritionDay *before = it == previous.nutrition.end() ? nullptr : &it->second;
        if (!before || !same(*before, record)) changes.push_back(dayChange(day, record, before));
    }
    for (const auto &[day, record] : previous.nutrition) {
        if (!next.nutrition.count(day)) changes.push_back(dayChange(day, NutritionDay{}, &record));
    }

    if (!same(previous.settings, next.settings) || previous.budget != next.budget) changes.push_back(settingsChange(next));
    if (!same(previous.goals, next.goals)) changes.push_back(json{{"goals", goalsOf(next.goals)}});

    diffById(next.goalPeriods, previous.goalPeriods, [&](const GoalRecord &record, const GoalRecord *) {
        changes.push_back(goalPeriodChange(record));
    }, [&](const GoalRecord &record) { changes.push_back(tombstone("goalPeriod", record.id)); });

    diffById(next.health, previous.health, [&](const HealthRecord &record, const HealthRecord *) {
        changes.push_back(healthChange(record));
    }, [&](const HealthRecord &record) { changes.push_back(tombstone("health", record.id)); });
    if (!same(previous.healthGoals, next.healthGoals)) changes.push_back(healthGoalsChange(next.healthGoals));

    diffById(next.learned, previous.learned, [&](const LearnedWord &word, const LearnedWord *before) {
        changes.push_back(learnedChange(word, before));
    }, [&](const LearnedWord &word) { changes.push_back(tombstone("learned", word.id)); });

    // История ввода текстом: запись уходит целиком (движок сводит её одним регистром), пропавшая — надгробием
    diffById(next.quickLines, previous.quickLines, [&](const QuickLine &line, const QuickLine *) {
        changes.push_back(quickLineChange(line));
    }, [&](const QuickLine &line) { changes.push_back(tombstone("quickLine", line.id)); });

    // Отметки «напомнено»: новая — регистр, снятая — надгробие
    const std::set<std::string> before(previous.reminded.begin(), previous.reminded.end());
    const std::set<std::string> after(next.reminded.begin(), next.reminded.end());
    for (const auto &id : next.reminded) {
        if (!before.count(id)) changes.push_back(json{{"reminded", {{"id", id}}}});
    }
    for (const auto &id : previous.reminded) {
        if (!after.count(id)) changes.push_back(tombstone("reminded", id));
    }
    return changes;
}

std::vector<PlannerChange> legacyToChanges(const State &legacy, const std::string &devicePrefix) {
    std::string clean;
    for (char c : devicePrefix) {
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '-') {
            clean += c;
        }
    }
    const std::string prefix = "legacy-" + clean.substr(0, 12) + "-";
    const auto rename = [&](const std::string &id) { return isDigits(id) ? prefix + id : id; };
    State state = legacy;
    for (auto &t : state.tasks) t.id = rename(t.id);
    for (auto &e : state.events) e.id = rename(e.id);
    auto changes = diffChanges(createEmptyState(), state);
    // Настройки и цели по умолчанию diff не выдаёт — для переноса они не нужны
    const auto count = changes.size();
    changes.push_back(json{{"migration", {{"sourceDevice", headCodepoints(devicePrefix, 64)}, {"count", count}}}});
    return changes;
}

bool isLegacyPlannerRecord(const json &raw) {
    if (!raw.is_object()) return false;
    const auto *version = field(raw, "version");
    const auto *tasks = field(raw, "tasks");
    return version && version->is_number() && version->get<double>() == 1 && tasks && tasks->is_array();
}

} // namespace parvane::sections::planner
