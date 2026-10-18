// Parvane fork (spec 029, фаза 4): типы «Плана» — зеркало web `components/parvane/planner/plannerModel.ts`
// (PlannerState и вложенные). Поля и имена в JSON — как в web (camelCase), необязательные — std::optional:
// состояние из web/движка читается без потерь и пишется обратно тем же видом. Чистые данные без UI и сети.
#pragma once

#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace parvane::sections::planner {

using nlohmann::json;

// Три статуса (spec 013); прежние `later` и `waiting` читаются как `queue`
inline const std::vector<std::string> kStatuses = {"queue", "active", "done"};
inline constexpr int kListColorCount = 8;
inline constexpr const char *kAllDayStart = "00:00";
inline constexpr const char *kAllDayEnd = "23:59";
inline constexpr int kDefaultEventMinutes = 60;
inline constexpr int kAgendaDays = 30;
inline constexpr int kMaxRepeatInterval = 99;
inline constexpr int kMaxRepeatCount = 999;
inline constexpr int kRepeatHorizonDays = 366;
inline constexpr int kMinutesInDay = 1440;
inline constexpr int kMinTaskMinutes = 5;

struct Step {
    std::string text;
    bool isDone = false;
};

// Правило повтора: хранится правило, экземпляры разворачиваются при показе
struct Repeat {
    std::string kind = "daily"; // daily | weekly | monthly | yearly
    int interval = 1;           // 1..99
    std::optional<std::vector<int>> weekdays; // weekly: 0 — воскресенье (как Date.getDay)
    std::optional<int> monthDay;              // monthly: 1..31
    std::string startDay;                     // "" — без нижней границы
    std::optional<std::string> endDay;
    std::optional<int> count;
};

struct Occurrence {
    std::string day;
    std::optional<bool> excluded;
    std::optional<bool> done;
    std::optional<std::vector<int>> doneSteps;
};

struct Origin {
    std::string seriesId;
    std::string day;
};

struct Source {
    std::string chat;
    std::string opId;
};

struct Task {
    std::string id;
    std::string name;
    std::string description;
    std::vector<Step> steps;
    std::string status = "queue";
    std::string project; // "" — «Без списка»
    double rank = 0;
    std::optional<std::string> day;
    std::optional<std::string> start;
    std::optional<std::string> due;
    std::optional<int> minutes;
    std::optional<Repeat> repeat;
    std::optional<std::vector<Occurrence>> occurrences;
    std::optional<Origin> origin;
    std::optional<Source> source;
    std::optional<int> remind;
    std::optional<std::string> instanceDay; // у развёрнутого экземпляра, не хранится
};

struct Event {
    std::string id;
    std::string name;
    std::optional<std::string> description;
    std::string start;
    std::string end;
    std::optional<std::string> day;
    std::optional<Repeat> repeat;
    std::optional<std::vector<Occurrence>> occurrences;
    std::optional<Origin> origin;
    std::optional<std::string> instanceDay;
    std::optional<bool> isAllDay;
    std::optional<bool> isHoliday;
    std::optional<int> color;
    std::optional<int> remind;
    std::optional<std::string> project;
};

// Питание: значения на 100 г по показателю (kcal | protein | fat | carbs | fiber)
using NutrientMap = std::map<std::string, double>;

struct FoodEntry {
    std::string id;
    std::string name;
    std::string meal = "other"; // breakfast | lunch | dinner | snack | other
    double kcal = 0;
    std::optional<double> protein;
    std::optional<double> fat;
    std::optional<double> carbs;
    std::optional<double> fiber;
    std::optional<double> grams;
    std::optional<NutrientMap> per100;
    std::optional<double> sugar;
    std::optional<double> salt;
    std::optional<std::string> time;
};

struct Exercise {
    std::string name;
    std::optional<double> sets;
    std::optional<double> reps;
    std::optional<double> weight;
};

// Запись здоровья (spec 020): вид — строка, незнакомый хранится и не показывается
struct HealthRecord {
    std::string id;
    std::string day;
    std::string kind;
    std::optional<std::string> time;
    std::optional<std::string> endTime;
    double value = 0;
    std::optional<double> value2;
    std::optional<std::string> name;
    std::optional<std::vector<Exercise>> exercises;
};

struct HealthGoals {
    std::optional<double> sugarMax;
    std::optional<double> saltMax;
    std::optional<double> sleepMinutes;
    std::optional<double> bedtime;
    std::optional<double> wakeTime;
    std::optional<double> weight;
    std::optional<double> steps;
    std::optional<double> activeMinutes;
    std::optional<double> workouts;
};

struct Goal {
    double target = 0;
    double tolerance = 0;
};
// Показатель (kcal | protein | fat | carbs | fiber | water) → цель
using GoalValues = std::map<std::string, Goal>;

struct GoalRecord {
    std::string id;
    std::string startDay;
    std::string endDay;
    GoalValues goals;
};

struct NutritionDay {
    std::vector<FoodEntry> entries;
    bool isComplete = false;
    std::optional<GoalValues> fixedGoals;
    std::optional<double> waterMl;
};

struct Settings {
    int dayStart = 9 * 60;
    int dayEnd = 21 * 60;
    int lunchStart = 13 * 60;
    int lunchEnd = 14 * 60;
    int margin = 15;
};

struct List {
    std::string id;
    std::string name;
    double order = 0;
    std::optional<int> color;
};

struct LearnedWord {
    std::string id;
    std::optional<std::string> kind; // task | event
    int kindCount = 0;
    std::optional<int> minutes;
    int minutesCount = 0;
    double touched = 0;
};

struct QuickLine {
    std::string id;
    std::string text;
    int count = 0;
    double touched = 0;
    std::optional<bool> isHidden;
};

struct State {
    int version = 1;
    std::vector<Task> tasks;
    std::vector<Event> events;
    std::vector<std::string> projects;
    std::vector<List> lists;
    std::map<std::string, NutritionDay> nutrition;
    GoalValues goals;
    std::vector<GoalRecord> goalPeriods;
    int budget = 600; // как web createEmptyPlannerState
    Settings settings;
    std::vector<HealthRecord> health;
    HealthGoals healthGoals;
    std::vector<LearnedWord> learned;
    std::vector<QuickLine> quickLines;
    std::vector<std::string> reminded;
};

// Цели здоровья по умолчанию (150 активных минут в неделю — норма ВОЗ)
inline HealthGoals defaultHealthGoals() {
    HealthGoals g;
    g.sugarMax = 50;
    g.saltMax = 5;
    g.sleepMinutes = 480;
    g.steps = 8000;
    g.activeMinutes = 150;
    g.workouts = 3;
    return g;
}

// ── JSON (имена полей как в web) ─────────────────────────────────────────────
namespace detail {

template <typename T>
void putOpt(json &j, const char *key, const std::optional<T> &v) {
    if (v) j[key] = *v;
}

template <typename T>
void getOpt(const json &j, const char *key, std::optional<T> &v) {
    if (const auto it = j.find(key); it != j.end() && !it->is_null()) v = it->get<T>();
}

} // namespace detail

inline void to_json(json &j, const Step &v) { j = json{{"text", v.text}, {"isDone", v.isDone}}; }
inline void from_json(const json &j, Step &v) {
    v.text = j.value("text", std::string());
    v.isDone = j.value("isDone", false);
}

inline void to_json(json &j, const Repeat &v) {
    j = json{{"kind", v.kind}, {"interval", v.interval}, {"startDay", v.startDay}};
    detail::putOpt(j, "weekdays", v.weekdays);
    detail::putOpt(j, "monthDay", v.monthDay);
    detail::putOpt(j, "endDay", v.endDay);
    detail::putOpt(j, "count", v.count);
}
inline void from_json(const json &j, Repeat &v) {
    v.kind = j.value("kind", std::string("daily"));
    v.interval = j.value("interval", 1);
    v.startDay = j.value("startDay", std::string());
    detail::getOpt(j, "weekdays", v.weekdays);
    detail::getOpt(j, "monthDay", v.monthDay);
    detail::getOpt(j, "endDay", v.endDay);
    detail::getOpt(j, "count", v.count);
}

inline void to_json(json &j, const Occurrence &v) {
    j = json{{"day", v.day}};
    detail::putOpt(j, "excluded", v.excluded);
    detail::putOpt(j, "done", v.done);
    detail::putOpt(j, "doneSteps", v.doneSteps);
}
inline void from_json(const json &j, Occurrence &v) {
    v.day = j.value("day", std::string());
    detail::getOpt(j, "excluded", v.excluded);
    detail::getOpt(j, "done", v.done);
    detail::getOpt(j, "doneSteps", v.doneSteps);
}

inline void to_json(json &j, const Origin &v) { j = json{{"seriesId", v.seriesId}, {"day", v.day}}; }
inline void from_json(const json &j, Origin &v) {
    v.seriesId = j.value("seriesId", std::string());
    v.day = j.value("day", std::string());
}

inline void to_json(json &j, const Source &v) { j = json{{"chat", v.chat}, {"opId", v.opId}}; }
inline void from_json(const json &j, Source &v) {
    v.chat = j.value("chat", std::string());
    v.opId = j.value("opId", std::string());
}

inline void to_json(json &j, const Task &v) {
    j = json{{"id", v.id}, {"name", v.name}, {"description", v.description}, {"steps", v.steps},
             {"status", v.status}, {"project", v.project}, {"rank", v.rank}};
    detail::putOpt(j, "day", v.day);
    detail::putOpt(j, "start", v.start);
    detail::putOpt(j, "due", v.due);
    detail::putOpt(j, "minutes", v.minutes);
    detail::putOpt(j, "repeat", v.repeat);
    detail::putOpt(j, "occurrences", v.occurrences);
    detail::putOpt(j, "origin", v.origin);
    detail::putOpt(j, "source", v.source);
    detail::putOpt(j, "remind", v.remind);
    detail::putOpt(j, "instanceDay", v.instanceDay);
}
inline void from_json(const json &j, Task &v) {
    v.id = j.value("id", std::string());
    v.name = j.value("name", std::string());
    v.description = j.value("description", std::string());
    v.steps = j.value("steps", std::vector<Step>());
    v.status = j.value("status", std::string("queue"));
    v.project = j.value("project", std::string());
    v.rank = j.value("rank", 0.0);
    detail::getOpt(j, "day", v.day);
    detail::getOpt(j, "start", v.start);
    detail::getOpt(j, "due", v.due);
    detail::getOpt(j, "minutes", v.minutes);
    detail::getOpt(j, "repeat", v.repeat);
    detail::getOpt(j, "occurrences", v.occurrences);
    detail::getOpt(j, "origin", v.origin);
    detail::getOpt(j, "source", v.source);
    detail::getOpt(j, "remind", v.remind);
    detail::getOpt(j, "instanceDay", v.instanceDay);
}

inline void to_json(json &j, const Event &v) {
    j = json{{"id", v.id}, {"name", v.name}, {"start", v.start}, {"end", v.end}};
    detail::putOpt(j, "description", v.description);
    detail::putOpt(j, "day", v.day);
    detail::putOpt(j, "repeat", v.repeat);
    detail::putOpt(j, "occurrences", v.occurrences);
    detail::putOpt(j, "origin", v.origin);
    detail::putOpt(j, "instanceDay", v.instanceDay);
    detail::putOpt(j, "isAllDay", v.isAllDay);
    detail::putOpt(j, "isHoliday", v.isHoliday);
    detail::putOpt(j, "color", v.color);
    detail::putOpt(j, "remind", v.remind);
    detail::putOpt(j, "project", v.project);
}
inline void from_json(const json &j, Event &v) {
    v.id = j.value("id", std::string());
    v.name = j.value("name", std::string());
    v.start = j.value("start", std::string());
    v.end = j.value("end", std::string());
    detail::getOpt(j, "description", v.description);
    detail::getOpt(j, "day", v.day);
    detail::getOpt(j, "repeat", v.repeat);
    detail::getOpt(j, "occurrences", v.occurrences);
    detail::getOpt(j, "origin", v.origin);
    detail::getOpt(j, "instanceDay", v.instanceDay);
    detail::getOpt(j, "isAllDay", v.isAllDay);
    detail::getOpt(j, "isHoliday", v.isHoliday);
    detail::getOpt(j, "color", v.color);
    detail::getOpt(j, "remind", v.remind);
    detail::getOpt(j, "project", v.project);
}

inline void to_json(json &j, const FoodEntry &v) {
    j = json{{"id", v.id}, {"name", v.name}, {"meal", v.meal}, {"kcal", v.kcal}};
    detail::putOpt(j, "protein", v.protein);
    detail::putOpt(j, "fat", v.fat);
    detail::putOpt(j, "carbs", v.carbs);
    detail::putOpt(j, "fiber", v.fiber);
    detail::putOpt(j, "grams", v.grams);
    detail::putOpt(j, "per100", v.per100);
    detail::putOpt(j, "sugar", v.sugar);
    detail::putOpt(j, "salt", v.salt);
    detail::putOpt(j, "time", v.time);
}
inline void from_json(const json &j, FoodEntry &v) {
    v.id = j.value("id", std::string());
    v.name = j.value("name", std::string());
    v.meal = j.value("meal", std::string("other"));
    v.kcal = j.value("kcal", 0.0);
    detail::getOpt(j, "protein", v.protein);
    detail::getOpt(j, "fat", v.fat);
    detail::getOpt(j, "carbs", v.carbs);
    detail::getOpt(j, "fiber", v.fiber);
    detail::getOpt(j, "grams", v.grams);
    detail::getOpt(j, "per100", v.per100);
    detail::getOpt(j, "sugar", v.sugar);
    detail::getOpt(j, "salt", v.salt);
    detail::getOpt(j, "time", v.time);
}

inline void to_json(json &j, const Exercise &v) {
    j = json{{"name", v.name}};
    detail::putOpt(j, "sets", v.sets);
    detail::putOpt(j, "reps", v.reps);
    detail::putOpt(j, "weight", v.weight);
}
inline void from_json(const json &j, Exercise &v) {
    v.name = j.value("name", std::string());
    detail::getOpt(j, "sets", v.sets);
    detail::getOpt(j, "reps", v.reps);
    detail::getOpt(j, "weight", v.weight);
}

inline void to_json(json &j, const HealthRecord &v) {
    j = json{{"id", v.id}, {"day", v.day}, {"kind", v.kind}, {"value", v.value}};
    detail::putOpt(j, "time", v.time);
    detail::putOpt(j, "endTime", v.endTime);
    detail::putOpt(j, "value2", v.value2);
    detail::putOpt(j, "name", v.name);
    detail::putOpt(j, "exercises", v.exercises);
}
inline void from_json(const json &j, HealthRecord &v) {
    v.id = j.value("id", std::string());
    v.day = j.value("day", std::string());
    v.kind = j.value("kind", std::string());
    v.value = j.value("value", 0.0);
    detail::getOpt(j, "time", v.time);
    detail::getOpt(j, "endTime", v.endTime);
    detail::getOpt(j, "value2", v.value2);
    detail::getOpt(j, "name", v.name);
    detail::getOpt(j, "exercises", v.exercises);
}

inline void to_json(json &j, const HealthGoals &v) {
    j = json::object();
    detail::putOpt(j, "sugarMax", v.sugarMax);
    detail::putOpt(j, "saltMax", v.saltMax);
    detail::putOpt(j, "sleepMinutes", v.sleepMinutes);
    detail::putOpt(j, "bedtime", v.bedtime);
    detail::putOpt(j, "wakeTime", v.wakeTime);
    detail::putOpt(j, "weight", v.weight);
    detail::putOpt(j, "steps", v.steps);
    detail::putOpt(j, "activeMinutes", v.activeMinutes);
    detail::putOpt(j, "workouts", v.workouts);
}
inline void from_json(const json &j, HealthGoals &v) {
    detail::getOpt(j, "sugarMax", v.sugarMax);
    detail::getOpt(j, "saltMax", v.saltMax);
    detail::getOpt(j, "sleepMinutes", v.sleepMinutes);
    detail::getOpt(j, "bedtime", v.bedtime);
    detail::getOpt(j, "wakeTime", v.wakeTime);
    detail::getOpt(j, "weight", v.weight);
    detail::getOpt(j, "steps", v.steps);
    detail::getOpt(j, "activeMinutes", v.activeMinutes);
    detail::getOpt(j, "workouts", v.workouts);
}

inline void to_json(json &j, const Goal &v) { j = json{{"target", v.target}, {"tolerance", v.tolerance}}; }
inline void from_json(const json &j, Goal &v) {
    v.target = j.value("target", 0.0);
    v.tolerance = j.value("tolerance", 0.0);
}

inline void to_json(json &j, const GoalRecord &v) {
    j = json{{"id", v.id}, {"startDay", v.startDay}, {"endDay", v.endDay}, {"goals", v.goals}};
}
inline void from_json(const json &j, GoalRecord &v) {
    v.id = j.value("id", std::string());
    v.startDay = j.value("startDay", std::string());
    v.endDay = j.value("endDay", std::string());
    v.goals = j.value("goals", GoalValues());
}

inline void to_json(json &j, const NutritionDay &v) {
    j = json{{"entries", v.entries}, {"isComplete", v.isComplete}};
    detail::putOpt(j, "fixedGoals", v.fixedGoals);
    detail::putOpt(j, "waterMl", v.waterMl);
}
inline void from_json(const json &j, NutritionDay &v) {
    v.entries = j.value("entries", std::vector<FoodEntry>());
    v.isComplete = j.value("isComplete", false);
    detail::getOpt(j, "fixedGoals", v.fixedGoals);
    detail::getOpt(j, "waterMl", v.waterMl);
}

inline void to_json(json &j, const Settings &v) {
    j = json{{"dayStart", v.dayStart}, {"dayEnd", v.dayEnd}, {"lunchStart", v.lunchStart},
             {"lunchEnd", v.lunchEnd}, {"margin", v.margin}};
}
inline void from_json(const json &j, Settings &v) {
    const Settings d;
    v.dayStart = j.value("dayStart", d.dayStart);
    v.dayEnd = j.value("dayEnd", d.dayEnd);
    v.lunchStart = j.value("lunchStart", d.lunchStart);
    v.lunchEnd = j.value("lunchEnd", d.lunchEnd);
    v.margin = j.value("margin", d.margin);
}

inline void to_json(json &j, const List &v) {
    j = json{{"id", v.id}, {"name", v.name}, {"order", v.order}};
    detail::putOpt(j, "color", v.color);
}
inline void from_json(const json &j, List &v) {
    v.id = j.value("id", std::string());
    v.name = j.value("name", std::string());
    v.order = j.value("order", 0.0);
    detail::getOpt(j, "color", v.color);
}

inline void to_json(json &j, const LearnedWord &v) {
    j = json{{"id", v.id}, {"kindCount", v.kindCount}, {"minutesCount", v.minutesCount}, {"touched", v.touched}};
    detail::putOpt(j, "kind", v.kind);
    detail::putOpt(j, "minutes", v.minutes);
}
inline void from_json(const json &j, LearnedWord &v) {
    v.id = j.value("id", std::string());
    v.kindCount = j.value("kindCount", 0);
    v.minutesCount = j.value("minutesCount", 0);
    v.touched = j.value("touched", 0.0);
    detail::getOpt(j, "kind", v.kind);
    detail::getOpt(j, "minutes", v.minutes);
}

inline void to_json(json &j, const QuickLine &v) {
    j = json{{"id", v.id}, {"text", v.text}, {"count", v.count}, {"touched", v.touched}};
    detail::putOpt(j, "isHidden", v.isHidden);
}
inline void from_json(const json &j, QuickLine &v) {
    v.id = j.value("id", std::string());
    v.text = j.value("text", std::string());
    v.count = j.value("count", 0);
    v.touched = j.value("touched", 0.0);
    detail::getOpt(j, "isHidden", v.isHidden);
}

inline void to_json(json &j, const State &v) {
    j = json{{"version", v.version}, {"tasks", v.tasks}, {"events", v.events}, {"projects", v.projects},
             {"lists", v.lists}, {"nutrition", v.nutrition}, {"goals", v.goals}, {"goalPeriods", v.goalPeriods},
             {"budget", v.budget}, {"settings", v.settings}, {"health", v.health}, {"healthGoals", v.healthGoals},
             {"learned", v.learned}, {"quickLines", v.quickLines}, {"reminded", v.reminded}};
}
inline void from_json(const json &j, State &v) {
    v.version = j.value("version", 1);
    v.tasks = j.value("tasks", std::vector<Task>());
    v.events = j.value("events", std::vector<Event>());
    v.projects = j.value("projects", std::vector<std::string>());
    v.lists = j.value("lists", std::vector<List>());
    v.nutrition = j.value("nutrition", std::map<std::string, NutritionDay>());
    v.goals = j.value("goals", GoalValues());
    v.goalPeriods = j.value("goalPeriods", std::vector<GoalRecord>());
    v.budget = j.value("budget", 600);
    v.settings = j.value("settings", Settings());
    v.health = j.value("health", std::vector<HealthRecord>());
    v.healthGoals = j.contains("healthGoals") ? j["healthGoals"].get<HealthGoals>() : defaultHealthGoals();
    v.learned = j.value("learned", std::vector<LearnedWord>());
    v.quickLines = j.value("quickLines", std::vector<QuickLine>());
    v.reminded = j.value("reminded", std::vector<std::string>());
}

} // namespace parvane::sections::planner
