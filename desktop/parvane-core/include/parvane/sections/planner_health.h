// Parvane fork (spec 029, фаза 4): здоровье в «Плане» — порт web `components/parvane/planner/plannerHealth.ts`
// (сводки показателей, тренировки, бюджет дня по сну, режим сна круговой статистикой, ось графика режима).
//
// Отличия от web:
// - `applyQuickDraft` (запись черновика ввода текстом) — в planner_quick_apply.h: он опирается на модуль быстрого
//   ввода (`QuickDraft`, `quickDescription`), а сводки здоровья — нет;
// - индекс записей (WeakMap web) не кэшируется — строится при каждом вызове, результат тот же;
// - записи возвращаются копиями (`std::optional<HealthRecord>`), тождество объектов не воспроизводится.
#pragma once

#include <optional>
#include <string>
#include <vector>

#include "parvane/sections/planner_types.h"

namespace parvane::sections::planner {

// Сна меньше этого — бюджет дня снижается
inline constexpr int kShortSleepMinutes = 360;
inline constexpr double kShortSleepBudgetFactor = 0.8;
inline constexpr int kWeekDays = 7;

inline constexpr int kSleepRoutineDays = 14;
inline constexpr int kSleepRoutineMinNights = 4;
inline constexpr int kSleepRoutineStableSpread = 30;
inline constexpr int kSleepRoutineDriftingSpread = 60;

// Идентификатор записи показателя, у которого одно значение на день: `<вид>-<день>`
std::string dailyRecordId(const std::string &kind, const std::string &day);

// Сны дня (ночь и дневной), по порядку записи
std::vector<HealthRecord> getSleepRecords(const State &state, const std::string &day);
// Запись показателя дня (первая по порядку; сон — сумма снов дня со временем самого долгого)
std::optional<HealthRecord> getDailyRecord(const State &state, const std::string &kind, const std::string &day);
// Последняя запись показателя не позже дня (среди записей последнего дня — первая по порядку данных)
std::optional<HealthRecord> getLatestRecord(const State &state, const std::string &kind, const std::string &day);
// Дни недели, заканчивающейся этим днём (от старого к новому)
std::vector<std::string> getLastDays(const std::string &day, int count = kWeekDays);
// Значения показателя по дням; `nullopt` — записи нет
std::vector<std::optional<double>> getDailySeries(const State &state, const std::string &kind,
                                                  const std::vector<std::string> &days);
// Тренировки дней: новые дни первыми, в дне — позднее время первым
std::vector<HealthRecord> getWorkouts(const State &state, const std::vector<std::string> &days);
double sumActiveMinutes(const std::vector<HealthRecord> &workouts);
double getActiveMinutes(const State &state, const std::vector<std::string> &days);
// Темп «мин:сек на километр»; ноль минут либо километров — нет темпа
std::optional<std::string> formatPace(double minutes, double km);
// Сумма сахара либо соли (`sugar` | `salt`) за день
double getLimitTotal(const State &state, const std::string &day, const std::string &nutrient);
bool isShortSleep(const State &state, const std::string &day);
double getDayBudget(const State &state, const std::string &day);
// Время подъёма (минуты от полуночи) по записи сна дня
std::optional<int> getWakeMinutes(const State &state, const std::string &day);

// ── режим сна (комментарий о круговой статистике — в web-исходнике) ─────────

// Времена суток по ночам: среднее, разброс (мин) и «обычное окно» — минутами от полуночи
struct SleepClockStat {
    int mean = 0;
    int spread = 0;
    int from = 0;
    int to = 0;
    bool operator==(const SleepClockStat &) const = default;
};

// Ночь окна. Времена и отклонения (мин, «+» — позже) есть только у ночи с обоими временами
struct SleepNight {
    std::string day;
    double minutes = 0;
    std::optional<int> bed;
    std::optional<int> wake;
    std::optional<double> midpoint; // может быть дробной (половина минуты)
    std::optional<int> bedDeviation;
    std::optional<int> wakeDeviation;
    std::optional<int> deviation; // большее по модулю из двух отклонений
};

struct SleepRoutine {
    std::string level = "none"; // stable | drifting | broken | none
    std::vector<std::string> days;
    std::vector<SleepNight> nights; // ночи с записью сна, от старой к новой
    int timedCount = 0;
    int untimedCount = 0;
    std::optional<int> center; // средняя середина сна — центр оси графика
    std::optional<SleepClockStat> bed;
    std::optional<SleepClockStat> wake;
    std::optional<SleepClockStat> midpoint;
    std::optional<int> spread;
    std::vector<SleepNight> outliers; // самые выбившиеся ночи, от худшей
    std::optional<int> socialJetlag;  // середина сна в выходные минус в будни
    std::optional<int> bedGoalDeviation;
    std::optional<int> wakeGoalDeviation;
};

// Время суток из любых минут: 1450 → 10, −20 → 1420
double wrapClock(double minutes);
// Разница времён суток по кругу, −720…719 мин
double clockDifference(double a, double b);
// «23:40» → минуты от полуночи (`/^(\d{1,2}):(\d{2})$/`, часы < 24, минуты < 60); иначе `nullopt`
std::optional<int> parseClock(const std::optional<std::string> &time);

struct SleepSpan {
    int from = 0;
    int to = 0;
    bool operator==(const SleepSpan &) const = default;
};
// Сон на оси своего дня: через полночь — начался накануне вечером; без времени либо «лёг = встал» — `nullopt`
std::optional<SleepSpan> getSleepSpan(const std::optional<std::string> &time,
                                      const std::optional<std::string> &endTime);
// Время отхода ко сну на оси дня подъёма: после полудня — накануне вечером
int getBedOffset(int clock);

struct SleepAxis {
    int low = 0;
    int high = 0;
    int step = 0;
    std::vector<int> ticks;
};
// Ось графика режима по отметкам (минуты от полуночи дня)
SleepAxis getSleepAxis(const std::vector<double> &marks);

// Цель режима из сохранённых целей: только известное число 0…1439
std::optional<double> getClockGoal(const std::optional<double> &value);
// Круговые среднее и разброс; пустой набор — `nullopt`
std::optional<SleepClockStat> getClockStat(const std::vector<double> &values);
// stable | drifting | broken | none
std::string getSleepRoutineLevel(const std::optional<int> &spread);
// Режим сна по записям за `count` дней, заканчивающихся днём `day`
SleepRoutine getSleepRoutine(const State &state, const std::string &day, int count = kSleepRoutineDays);

} // namespace parvane::sections::planner
