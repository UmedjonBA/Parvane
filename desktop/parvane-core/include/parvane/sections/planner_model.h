// Parvane fork (spec 029, фаза 4): модель «Плана» — порт web `components/parvane/planner/plannerModel.ts`
// (даты и время, повторы и экземпляры, дела дня и индекс дней, окна и поиск времени, раскладка пересечений,
// проверки ввода, питание и цели, статистика времени, приведение сохранённого состояния), а также
// `plannerLayers.ts` (слои календаря без хранилища) и не зависящих от Intl подписей `plannerFormat.ts`.
//
// Поведение — как в web. Отличия по природе C++:
// - web правит черновик (`updatePlanner(mutate)`) — здесь функции над `State&`;
// - `newId()` (crypto.randomUUID) — параметр `IdGen` (в тестах — детерминированный генератор);
// - «сегодня» — всегда параметр (в web у части функций по умолчанию `new Date()`);
// - кэшей по объекту (WeakMap web: экземпляры рядов, разобранные правила, индексы дней) нет — всё считается
//   заново; результат тот же, тождество объектов (`toBe`) не воспроизводится;
// - частичная правка `Partial<PlannerTask & PlannerEvent>` — `ItemPatch`: у поля три состояния (нет — не
//   трогается, `nullopt` внутри — `undefined` web, значение).
#pragma once

#include <functional>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <variant>
#include <vector>

#include <nlohmann/json.hpp>

#include "parvane/sections/planner_types.h"

namespace parvane::sections::planner {

// ── идентификаторы ───────────────────────────────────────────────────────────

// Источник новых идентификаторов (web `newId()` = UUID v4)
using IdGen = std::function<std::string()>;

// UUID v4 из `std::random_device` — для UI; логика и тесты получают генератор параметром
std::string randomUuid();

// ── константы (как в web) ────────────────────────────────────────────────────

inline const std::vector<std::string> kCalendarViews = {"week", "month", "year", "agenda"};
inline const std::vector<std::string> kRepeatKinds = {"daily", "weekly", "monthly", "yearly"};
inline const std::vector<std::string> kMetrics = {"kcal", "protein", "fat", "carbs"};
inline const std::vector<std::string> kNutrients = {"kcal", "protein", "fat", "carbs", "fiber"};
inline const std::vector<std::string> kGoalMetrics = {"kcal", "protein", "fat", "carbs", "fiber", "water"};
inline const std::vector<std::string> kMeals = {"breakfast", "lunch", "dinner", "snack", "other"};
inline const std::vector<std::string> kHealthKinds = {"weight", "pressure", "pulse", "steps", "mood", "sleep",
                                                     "workout"};
inline constexpr int kMinBudgetMinutes = 60;
inline constexpr int kMaxSlotMargin = 180;
// Группа событий в статистике времени (`'\u0000events'`)
inline const std::string kEventsGroup = std::string("\0events", 7);

// Значения макета: окна 09–21, обед 13–14, запас 15 минут
inline Settings defaultSettings() { return Settings{}; }

State createEmptyState();

// ── даты и время ─────────────────────────────────────────────────────────────

bool isDayKey(const std::string &day);   // `YYYY-MM-DD`
bool isTimeKey(const std::string &time); // `HH:MM`, 00:00…23:59
std::string toDayKey(int year, int month, int date); // `month` 1…12
std::string addDays(const std::string &day, long long delta);
int toMinutes(const std::string &time); // негодное число — 0 (в web — NaN)
std::string toTime(int minutes);
// День недели как `Date.getDay` (0 — воскресенье)
int weekdayOf(const std::string &day);
std::vector<std::string> getMonthKeys(int year, int month);
// Смещение первого дня месяца при неделе с понедельника
int getMonthOffset(int year, int month);
// Неделя дня с понедельника по воскресенье
std::vector<std::string> getWeekKeys(const std::string &day);
std::vector<std::string> getYearKeys(int year);
// Сетка месяца полными неделями: дни соседних месяцев в начале и в конце
std::vector<std::string> getMonthGridKeys(int year, int month);
// Сдвиг якоря на период вида (`year|month|week|day|agenda`); расписание листается неделями
std::string shiftPeriod(const std::string &view, const std::string &day, int delta);
// Конец события по умолчанию: через час после начала, но не позже конца суток
std::string getDefaultEventEnd(const std::string &start);

// ── повторы ──────────────────────────────────────────────────────────────────

enum class SeriesKind { Task, Event };
// Запись ряда — задача либо событие (web `PlannerSeriesItem`)
using SeriesItem = std::variant<Task, Event>;
const std::string &itemId(const SeriesItem &item);

bool isRepeating(const Task &item);
bool isRepeating(const Event &item);
// Отметка экземпляра в день — первая с этим днём; указатель в `item.occurrences`
const Occurrence *getOccurrence(const Task &item, const std::string &day);
const Occurrence *getOccurrence(const Event &item, const std::string &day);
// Даёт ли правило экземпляр в этот день (исключения не учитываются)
bool occursOn(const Repeat &repeat, const std::string &day);
// Дни ряда в промежутке включительно (исключения не учитываются)
std::vector<std::string> expandRepeat(const Repeat &repeat, const std::string &fromDay, const std::string &toDay);
// Дни ряда в промежутке, в которые экземпляр есть (исключённые дни пропущены)
std::vector<std::string> expandInstances(const Task &item, const std::string &fromDay, const std::string &toDay);
std::vector<std::string> expandInstances(const Event &item, const std::string &fromDay, const std::string &toDay);
bool hasInstanceOn(const Task &item, const std::string &day);
bool hasInstanceOn(const Event &item, const std::string &day);
std::string instanceKey(const Task &item); // `id@день` у экземпляра
std::string instanceKey(const Event &item);
// Экземпляр задачи-ряда на день: выполнение и шаги — из состояния экземпляра
Task taskInstance(const Task &task, const std::string &day);
Event eventInstance(const Event &event, const std::string &day);
bool isInstanceDone(const Task &task, const std::string &day);
// Ближайший невыполненный экземпляр задачи-ряда с `today` (горизонт года)
std::optional<Task> nextOpenInstance(const Task &task, const std::string &today);
// Ошибка правила: interval | weekdays | monthDay | startDay | endDay | count
std::optional<std::string> validateRepeat(const Repeat &repeat);

// ── частичные правки ─────────────────────────────────────────────────────────

// Поле правки: нет значения — не трогается; внутри `nullopt` — «undefined» web; иначе — значение
template <typename T>
using PatchField = std::optional<std::optional<T>>;

// Поле правки со значением «undefined» (ключ есть, значения нет)
template <typename T>
PatchField<T> undefinedField() {
    return PatchField<T>(std::in_place);
}

// Частичное правило повтора (`Partial<PlannerRepeat>`)
struct RepeatPatch {
    PatchField<std::string> kind;
    PatchField<int> interval;
    PatchField<std::vector<int>> weekdays;
    PatchField<int> monthDay;
    PatchField<std::string> startDay;
    PatchField<std::string> endDay;
    PatchField<int> count;
    // Правило целиком: все ключи присутствуют (как у объекта, который собирает форма повтора web)
    static RepeatPatch of(const Repeat &repeat);
};
Repeat applyRepeatPatch(Repeat base, const RepeatPatch &patch);

// Правка записи (`Partial<PlannerTask & PlannerEvent>`). `id`, `occurrences`, `origin`, `instanceDay` в правке
// не несутся: в web их задаёт сама функция правки
struct ItemPatch {
    PatchField<std::string> name;
    PatchField<std::string> description;
    PatchField<std::string> start;
    PatchField<std::string> end;
    PatchField<std::string> day;
    PatchField<std::string> due;
    PatchField<std::string> status;
    PatchField<std::string> project;
    PatchField<int> minutes;
    PatchField<int> color;
    PatchField<int> remind;
    PatchField<double> rank;
    PatchField<bool> isAllDay;
    PatchField<bool> isHoliday;
    PatchField<std::vector<Step>> steps;
    PatchField<Source> source;
    PatchField<RepeatPatch> repeat;
    // Ключи с их значениями (`undefined` — `null`), как объект правки web; `repeat` — только ключи правила
    json toJson() const;
    bool empty() const;
};
// `Object.assign(item, patch)`: поля, которых у вида записи нет, не пишутся
void applyPatch(Task &task, const ItemPatch &patch);
void applyPatch(Event &event, const ItemPatch &patch);

// Отметка экземпляра (`Omit<PlannerOccurrence, 'day'>`)
struct OccurrencePatch {
    std::optional<bool> excluded;
    std::optional<bool> done;
    std::optional<std::vector<int>> doneSteps;
};

// ── повторы: правки экземпляров и ряда ───────────────────────────────────────

Task *findTask(State &state, const std::string &id);
Event *findEvent(State &state, const std::string &id);
// Записать состояние экземпляра на день (слияние по дню у движка)
bool setOccurrence(State &state, SeriesKind kind, const std::string &id, const std::string &day,
                   const OccurrencePatch &patch);
// «Удалить только это»: исключить день из ряда
bool excludeInstance(State &state, SeriesKind kind, const std::string &id, const std::string &day);
// «Изменить только это»: самостоятельная копия экземпляра с полями `patch` и исключение дня у ряда
std::optional<SeriesItem> detachInstance(State &state, SeriesKind kind, const std::string &id,
                                         const std::string &day, const ItemPatch &patch, const IdGen &newId);
// «Это и последующие»: старый ряд заканчивается днём раньше, новый ряд с этого дня с полями `patch`
std::optional<SeriesItem> splitSeries(State &state, SeriesKind kind, const std::string &id, const std::string &day,
                                      const ItemPatch &patch, const IdGen &newId);
// «Удалить это и последующие»: ряд заканчивается днём раньше; если раньше начала — ряд удаляется
bool truncateSeries(State &state, SeriesKind kind, const std::string &id, const std::string &day);
// «Все в серии»: поля `patch` — в шаблон, другой `patch.day` переносит ряд целиком (см. web `updateSeries`)
std::optional<SeriesItem> updateSeries(State &state, SeriesKind kind, const std::string &id,
                                       const std::string &day, const ItemPatch &patch);
// Удалить ряд целиком (отделённые экземпляры остаются)
void removeSeries(State &state, SeriesKind kind, const std::string &id);
// Отметить задачу (или экземпляр ряда) выполненной
bool setTaskDone(State &state, const Task &task, bool isDone);
// Отметить шаг задачи (или экземпляра ряда — по дню)
bool setTaskStepDone(State &state, const Task &task, int index, bool isDone);

// ── дела дня ─────────────────────────────────────────────────────────────────

struct Timed {
    std::string name;
    std::string start;
    std::string end;
    std::optional<Task> task;
    std::optional<Event> event;
};

struct Slot {
    int start = 0;
    int end = 0;
    bool operator==(const Slot &) const = default;
};

struct BusyGroup {
    int start = 0;
    int end = 0;
    std::vector<Timed> items;
};

// Задачи дня: разовые с датой и экземпляры рядов
std::vector<Task> getTasksForDay(const State &state, const std::string &day);
std::vector<Task> getDeadlines(const State &state, const std::string &day);
std::vector<Event> getEventsForDay(const State &state, const std::string &day);

// Дела дня одним объектом — как функции дня, но за один проход на весь промежуток
struct DayIndexEntry {
    std::vector<Task> tasks;
    std::vector<Event> events; // по порядку `compareEvents`
    std::vector<Task> deadlines;
    bool isHoliday = false;
    std::optional<Event> holiday; // первый праздник дня
    int minutes = 0;
    std::vector<Timed> timed;
    std::vector<Task> untimed; // без времени начала либо без оценки
    std::vector<Event> allDay;
    int conflicts = 0;
    int unrated = 0;
};
using DayIndex = std::map<std::string, DayIndexEntry>;

// Индекс промежутка (в web — кэш по объекту состояния; здесь строится при каждом вызове)
DayIndex getDayIndex(const State &state, const std::string &fromDay, const std::string &toDay);
// Дела одного дня (дня без дел — пустая запись)
DayIndexEntry getDayEntry(const State &state, const std::string &day);
DayIndex getDayRange(const State &state, const std::string &fromDay, const std::string &toDay);
// Подпись задач из пунктов заметок (`source.chat` вида `note:*`)
std::string noteTasksSignature(const State &state);

bool isHolidayOn(const State &state, const std::string &day);
int countUnrated(const State &state, const std::string &day);
int getDayLoad(const State &state, const std::string &day);
std::vector<Timed> getTimedForDay(const State &state, const std::string &day,
                                  const std::optional<std::string> &excludedTaskId = std::nullopt);

// `right` — колонка, до которой тянется блок (не дальше `lanes`)
struct TimedLayout {
    Timed item;
    int lane = 0;
    int lanes = 1;
    int right = 1;
};
// Раскладка дел дня для сетки часов (см. web `layoutTimed`)
std::vector<TimedLayout> layoutTimed(const std::vector<Timed> &timed);
int countConflicts(const State &state, const std::string &day);
// Доля дневного бюджета 0…1
double getLoadFraction(const State &state, double minutes);

struct DayAvailability {
    std::vector<Slot> free;
    std::vector<BusyGroup> groups;
    int freeMinutes = 0;
};
DayAvailability getDayAvailability(const State &state, const std::string &day);

struct SlotAnswer {
    std::string day;
    std::string start;
    std::string end;
    bool operator==(const SlotAnswer &) const = default;
};
// Ближайшие свободные окна под задачу (без перерыва и запаса, spec 018)
std::vector<SlotAnswer> findSlots(const State &state, const Task &task, const std::string &today,
                                  const std::string &picked);

// ── списки задач ─────────────────────────────────────────────────────────────

// Список по имени; создаёт запись `lists`, если её ещё нет. Указатель живёт до следующей правки `lists`
List *ensureList(State &state, const std::string &name, const IdGen &newId);
int getListColor(const State &state, const std::string &name);
// Цвет события: цвет его группы, без группы — свой цвет
int getEventColor(const State &state, const Event &event);
bool hasLunchBreak(const Settings &settings);
std::vector<Task> getEligibleTasks(const State &state, const std::string &today);
// Задачи без даты работы (не ряды, не завершённые): «в работе» первыми, дальше по рангу
std::vector<Task> getUndatedTasks(const State &state);
std::vector<Task> getCompletedTasks(const State &state);
// Соседи задачи по порядку — незавершённые задачи того же списка и статуса
std::vector<Task> getOrderedGroup(const State &state, const Task &task, const std::string &today);
// Задача меняется местами с соседом (`direction` −1 / 1); у края группы ничего не происходит
bool moveTask(State &state, const std::string &taskId, int direction, const std::string &today);

// ── проверки ввода ───────────────────────────────────────────────────────────

// name | minutes | startNeedsDayAndMinutes | pastMidnight | dayAfterDue
std::optional<std::string> validateTask(const Task &task);
// window | lunch | margin
std::optional<std::string> validateSettings(const Settings &settings);
bool validateBudget(double budget);
// name | time | repeat | ошибка правила
std::optional<std::string> validateEvent(const Event &event);

// ── питание ──────────────────────────────────────────────────────────────────

bool isKnownNumber(double value);

struct FoodInput {
    std::optional<std::string> id;
    std::string name;
    std::string meal = "other";
    bool isPer100 = false;
    std::optional<double> grams;
    NutrientMap values;
};
FoodEntry makeFoodEntry(const FoodInput &raw, const IdGen &newId);

struct NutrientTotal {
    double value = 0;
    int missing = 0;
    int count = 0;
    bool operator==(const NutrientTotal &) const = default;
};
// Факт дня по показателю: сумма записей; вода — `waterMl`
NutrientTotal getNutrientTotal(const State &state, const std::string &day, const std::string &nutrient);
// Запись цели, действующая в день: накрывающая, затем позже начатая, короче, позже в списке
std::optional<GoalRecord> getGoalRecordForDay(const State &state, const std::string &day);
// День питания завершён: прошедший — сам, отметка `isComplete` прежних версий — тоже
bool isDayClosed(const State &state, const std::string &day, const std::string &today);
GoalValues getGoalsForDay(const State &state, const std::string &day, const std::string &today);
// Прошедшим дням с записями фиксируются действующие цели; возвращает число затронутых дней
int freezePastGoals(State &state, const std::string &today);
std::optional<Goal> getNutrientGoal(const State &state, const std::string &day, const std::string &metric,
                                    const std::string &today);
// none | nogoal | incomplete | open | below | above | ok
std::string getNutrientStatus(const State &state, const std::string &day, const std::string &metric,
                              const std::string &today);

struct NutrientStatistics {
    std::vector<std::string> recorded;
    std::vector<std::string> complete;
    std::vector<std::string> withGoal;
    double sum = 0;
    double completeSum = 0;
    int inGoal = 0;
    std::optional<double> average;
    double goalLow = 0;
    double goalHigh = 0;
};
NutrientStatistics getNutrientStatistics(const State &state, const std::vector<std::string> &days,
                                         const std::string &metric, const std::string &today);
// Ошибка записи цели: startDay | endDay | empty | имя показателя
std::optional<std::string> validateGoalRecord(const GoalRecord &record);
bool validateGoal(const Goal &goal, bool isInteger);

// ── статистика времени ───────────────────────────────────────────────────────

struct TimeRow {
    std::string name;
    int minutes = 0;
    int colorIndex = 0;
};
struct TimeStatistics {
    std::vector<TimeRow> rows;
    int total = 0;
    int unrated = 0;
};
// Оценки задач + длительность событий по спискам; задачи без даты не входят
TimeStatistics getTimeStatistics(const State &state, const std::vector<std::string> &days,
                                 const std::set<std::string> &hidden);

// ── хранение ─────────────────────────────────────────────────────────────────

// Сохранённое состояние (JSON) приводится к текущей форме; негодное — пустой планировщик
State normalizeState(const json &raw, const IdGen &newId);
std::vector<QuickLine> normalizeQuickLines(const json &raw);
std::vector<LearnedWord> normalizeLearned(const json &raw);

// ── подписи без Intl (plannerFormat.ts) ──────────────────────────────────────

// Граница окна: ровный час — «09», иначе «08:30»
std::string formatClock(int minutes);
// Длительность «часы:минуты» — 6:46, 8:00
std::string formatSpan(double minutes);
// Цвет списка — переменная палитры собеседников; 0 — нет стиля
std::optional<std::string> listColorStyle(int color);

// ── слои календаря (plannerLayers.ts без localStorage) ───────────────────────

struct Layers {
    bool sleep = true;
    bool food = true;
    bool work = true;
    bool operator==(const Layers &) const = default;
};
inline const std::vector<std::string> kLayers = {"sleep", "food", "work"};
// Слои из строки хранилища: названия выключенных через запятую; незнакомое пропускается
Layers parseLayers(const std::optional<std::string> &saved);
std::string serializeLayers(const Layers &layers);

} // namespace parvane::sections::planner
