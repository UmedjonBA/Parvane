// Parvane fork (spec 029, фаза 4): тесты здоровья «Плана» — перенос web `plannerHealth.test.ts` (по проверке на
// `it`, имена — как в web). Случаи, где web записывает строку быстрого ввода (`parseQuickInput` + `applyQuickDraft`),
// здесь проверяются только в части чтения (состояние собрано теми же записями, что дал бы черновик); целиком, со
// строками ввода, они перенесены в planner_quick_apply_tests.cpp.
#include <cmath>
#include <cstdio>
#include <map>
#include <string>
#include <variant>
#include <vector>

#include "parvane/sections/planner_health.h"
#include "parvane/sections/planner_model.h"

using namespace parvane::sections::planner;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name) {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}

static const std::string TODAY = "2026-10-08";

static HealthRecord rec(const std::string &id, const std::string &day, const std::string &kind, double value,
                        std::optional<std::string> time = std::nullopt,
                        std::optional<std::string> endTime = std::nullopt) {
    HealthRecord r;
    r.id = id;
    r.day = day;
    r.kind = kind;
    r.value = value;
    r.time = time;
    r.endTime = endTime;
    return r;
}

// Ночь: «лёг-встал» либо одна длительность в минутах
using Night = std::variant<std::pair<std::string, std::string>, double>;
static Night N(const char *bed, const char *wake) { return std::make_pair(std::string(bed), std::string(wake)); }
static Night N(double minutes) { return minutes; }

static int clockOf(const std::string &clock) { return std::stoi(clock.substr(0, 2)) * 60 + std::stoi(clock.substr(3)); }

static HealthRecord nightRecord(const std::string &day, const Night &night) {
    const auto id = dailyRecordId("sleep", day);
    if (const auto *minutes = std::get_if<double>(&night)) return rec(id, day, "sleep", *minutes);
    const auto &[time, endTime] = std::get<std::pair<std::string, std::string>>(night);
    const int value = (clockOf(endTime) - clockOf(time) + 1440) % 1440;
    return rec(id, day, "sleep", value, time, endTime);
}

static State stateWithSleep(const std::map<std::string, Night> &nights) {
    auto state = createEmptyState();
    for (const auto &[day, night] : nights) state.health.push_back(nightRecord(day, night));
    return state;
}

// Ночи подряд, последняя — на TODAY
static State lastNights(const std::vector<Night> &nights) {
    const auto days = getLastDays(TODAY, static_cast<int>(nights.size()));
    std::map<std::string, Night> map;
    for (size_t i = 0; i < nights.size(); ++i) map.emplace(days[i], nights[i]);
    return stateWithSleep(map);
}

static bool statIs(const std::optional<SleepClockStat> &stat, std::optional<int> mean, std::optional<int> spread,
                   std::optional<int> from = std::nullopt, std::optional<int> to = std::nullopt) {
    if (!stat) return false;
    return (!mean || stat->mean == *mean) && (!spread || stat->spread == *spread) && (!from || stat->from == *from)
        && (!to || stat->to == *to);
}

template <typename T, typename F>
static auto mapNights(const std::vector<SleepNight> &nights, F f) {
    std::vector<T> out;
    for (const auto &night : nights) out.push_back(f(night));
    return out;
}

// ── здоровье: черновик ввода → состояние (только чтение) ─────────────────────

static void draftReading() {
    // целиком — в planner_quick_apply_tests.cpp: «задача и событие», «описание из строки уходит в событие и в задачу», «метки строки: список,
    // место и „важное“», «цели и настройки текстом» — проверяют запись черновика `applyQuickDraft` (модуль
    // быстрого ввода переносится отдельно)
    {
        // Еда с сахаром и вода 500 + 2 стакана — как после `applyQuickDraft`
        auto state = createEmptyState();
        FoodEntry food;
        food.id = "f1";
        food.name = "гречка";
        food.meal = "lunch";
        food.kcal = 520;
        food.protein = 30;
        food.fiber = 6;
        food.sugar = 4;
        food.grams = 150;
        food.time = "13:30";
        NutritionDay day;
        day.entries.push_back(food);
        day.waterMl = 1000;
        state.nutrition[TODAY] = day;
        check(getLimitTotal(state, TODAY, "sugar") == 4 && getLimitTotal(state, TODAY, "salt") == 0
                  && getLimitTotal(state, "2026-10-09", "sugar") == 0,
              "еда с сахаром и временем, вода складывается (сумма сахара и соли)");
    }
    {
        auto state = createEmptyState();
        state.health.push_back(rec("weight-" + TODAY, TODAY, "weight", 72.1));
        state.health.push_back(rec("sleep-" + TODAY, TODAY, "sleep", 300, "01:00", "06:00"));
        auto pressure = rec("pressure-" + TODAY, TODAY, "pressure", 120);
        pressure.value2 = 80;
        state.health.push_back(pressure);
        const auto weight = getDailyRecord(state, "weight", TODAY);
        const auto sleep = getDailyRecord(state, "sleep", TODAY);
        const auto press = getDailyRecord(state, "pressure", TODAY);
        check(weight && weight->value == 72.1 && sleep && sleep->time == "01:00" && sleep->endTime == "06:00"
                  && sleep->value == 300 && press && press->value == 120 && press->value2 == 80.0
                  && isShortSleep(state, TODAY) && getDayBudget(state, TODAY) == 480
                  && getDayBudget(state, "2026-10-09") == 600 && getWakeMinutes(state, TODAY) == 360,
              "показатель — одна запись на день; сон дня; короткий сон снижает бюджет");
    }
    {
        auto state = createEmptyState();
        auto run = rec("w1", TODAY, "workout", 28);
        run.value2 = 5;
        run.name = "бег";
        auto gym = rec("w2", TODAY, "workout", 0);
        gym.name = "зал";
        gym.exercises = std::vector<Exercise>{{"присед", 4, 8, 80}, {"жим", 3, 10, 60}};
        auto yoga = rec("w3", addDays(TODAY, -1), "workout", 40);
        yoga.name = "йога";
        state.health = {run, gym, yoga};
        const auto week = getLastDays(TODAY);
        const auto workouts = getWorkouts(state, week);
        check(week.size() == 7 && week[6] == TODAY && workouts.size() == 3 && workouts[0].name == "бег"
                  && workouts[1].name == "зал" && workouts[2].name == "йога" && getActiveMinutes(state, week) == 68
                  && workouts[1].exercises->size() == 2 && formatPace(28, 5) == "5:36" && !formatPace(0, 5),
              "тренировки копятся; активные минуты и темп");
    }
    {
        auto state = createEmptyState();
        state.health.push_back(rec("steps-" + TODAY, TODAY, "steps", 9500));
        const auto series = getDailySeries(state, "steps", getLastDays(TODAY, 3));
        const auto latest = getLatestRecord(state, "steps", "2026-10-20");
        check(series.size() == 3 && !series[0] && !series[1] && series[2] == 9500.0 && latest && latest->value == 9500
                  && !getLatestRecord(state, "steps", "2026-10-01"),
              "ряды значений и последняя запись");
    }
    {
        // Последняя запись: среди записей последнего дня — первая по порядку данных
        auto state = createEmptyState();
        state.health = {rec("a", "2026-10-05", "weight", 70), rec("b", "2026-10-07", "weight", 71),
                        rec("c", "2026-10-07", "weight", 72), rec("d", "2026-10-09", "weight", 73)};
        const auto latest = getLatestRecord(state, "weight", TODAY);
        check(latest && latest->id == "b", "последняя запись: первая по порядку данных среди записей дня");
    }
}

// ── шкала графика режима ─────────────────────────────────────────────────────

static void axis() {
    check(getSleepSpan("23:15", "06:45") == SleepSpan{-45, 405} && getSleepSpan("04:10", "09:20") == SleepSpan{250, 560}
              && getSleepSpan("14:00", "15:30") == SleepSpan{840, 930}
              && getSleepSpan("19:30", "20:40") == SleepSpan{1170, 1240} && !getSleepSpan("07:00", "07:00")
              && !getSleepSpan(std::nullopt, "07:00") && getBedOffset(23 * 60 + 30) == -30 && getBedOffset(60) == 60,
          "сон через полночь начинается накануне, остальные — в свой день");
    const auto night = getSleepAxis({-45, 405});
    const auto longAxis = getSleepAxis({-45, 405, 1170, 1240});
    const auto empty = getSleepAxis({});
    check(night.low == -120 && night.high == 480 && night.step == 120 && longAxis.step == 180 && longAxis.low == -180
              && longAxis.high == 1440 && longAxis.ticks.size() == 10 && empty.low == -120 && empty.high == 480,
          "границы оси — на целых шагах, подписи — каждый шаг");
}

// ── режим сна ────────────────────────────────────────────────────────────────

static void routine() {
    check(statIs(getClockStat({23 * 60 + 40, 20}), 0, 20) && getClockStat({23 * 60 + 50, 23 * 60 + 30})->mean == 23 * 60 + 40
              && clockDifference(20, 23 * 60 + 40) == 40 && clockDifference(23 * 60 + 40, 20) == -40
              && clockDifference(600, 600) == 0 && wrapClock(1450) == 10 && wrapClock(-20) == 1420 && !getClockStat({})
              && statIs(getClockStat({0, 720}), 0, 720) && parseClock("07:05") == 425 && parseClock("7:05") == 425
              && !parseClock("25:00") && !parseClock("07:75") && !parseClock("утром") && !parseClock(std::nullopt),
          "время суток — круг: среднее через полночь, разница и приведение");

    check(getSleepRoutineLevel(std::nullopt) == "none" && getSleepRoutineLevel(0) == "stable"
              && getSleepRoutineLevel(kSleepRoutineStableSpread) == "stable"
              && getSleepRoutineLevel(kSleepRoutineStableSpread + 1) == "drifting"
              && getSleepRoutineLevel(kSleepRoutineDriftingSpread) == "drifting"
              && getSleepRoutineLevel(kSleepRoutineDriftingSpread + 1) == "broken" && kSleepRoutineDays == 14
              && kSleepRoutineMinNights == 4,
          "пороги уровня");

    {
        const auto r = getSleepRoutine(lastNights({N("23:40", "07:00"), N("00:20", "07:00"), N("23:50", "07:00"),
                                                   N("00:10", "07:00")}),
                                       TODAY);
        const auto bedDev = mapNights<std::optional<int>>(r.nights, [](auto &n) { return n.bedDeviation; });
        const auto wakeDev = mapNights<std::optional<int>>(r.nights, [](auto &n) { return n.wakeDeviation; });
        const auto mids = mapNights<std::optional<double>>(r.nights, [](auto &n) { return n.midpoint; });
        check(r.level == "stable" && r.timedCount == 4 && r.untimedCount == 0 && r.spread == 16
                  && statIs(r.bed, 0, 16) && statIs(r.wake, 420, 0)
                  && bedDev == std::vector<std::optional<int>>{-20, 20, -10, 10}
                  && wakeDev == std::vector<std::optional<int>>{0, 0, 0, 0}
                  && statIs(r.bed, std::nullopt, std::nullopt, 23 * 60 + 43, 17)
                  && mids == std::vector<std::optional<double>>{200, 220, 205, 215} && statIs(r.midpoint, 210, 8)
                  && r.center == 210 && r.outliers.empty(),
              "отход ко сну вокруг полуночи: среднее 00:00, отклонения со знаком");
    }
    {
        const auto r = getSleepRoutine(lastNights(std::vector<Night>(14, N("23:30", "07:00"))), TODAY);
        bool allZero = true;
        for (const auto &n : r.nights) allZero = allZero && n.deviation == 0;
        check(r.level == "stable" && r.timedCount == 14 && r.spread == 0 && statIs(r.bed, 1410, 0, 1410, 1410)
                  && statIs(r.wake, 420, 0, 420, 420) && statIs(r.midpoint, 195, 0) && allZero && r.outliers.empty(),
              "одинаковые ночи: разброс ноль, окно стянуто в точку");
    }
    {
        const auto r = getSleepRoutine(lastNights({N("08:00", "16:00"), N("08:20", "16:10"), N("07:40", "15:50"),
                                                   N("08:00", "16:00")}),
                                       TODAY);
        check(r.level == "stable" && statIs(r.bed, 480, 14) && statIs(r.wake, 960, 7) && statIs(r.midpoint, 720, {}),
              "дневной сон: ложится утром");
    }
    {
        const auto drifting = getSleepRoutine(lastNights({N("23:00", "06:00"), N("23:00", "08:00"),
                                                          N("23:00", "06:00"), N("23:00", "08:00")}),
                                              TODAY);
        const auto broken = getSleepRoutine(lastNights({N("22:00", "07:00"), N("02:00", "07:00"), N("22:00", "07:00"),
                                                        N("02:00", "07:00")}),
                                            TODAY);
        const auto outDays = mapNights<std::string>(broken.outliers, [](auto &n) { return n.day; });
        check(drifting.level == "drifting" && drifting.spread == 60 && statIs(drifting.bed, {}, 0)
                  && statIs(drifting.wake, 420, 60) && broken.level == "broken" && broken.bed->mean == 0
                  && *broken.spread > 115 && *broken.spread < 130
                  && outDays == std::vector<std::string>{"2026-10-08", "2026-10-07", "2026-10-06"}
                  && broken.outliers[0].bedDeviation == 120 && broken.outliers[0].wakeDeviation == 0
                  && broken.outliers[0].deviation == 120,
              "уровень — по худшему из двух разбросов");
    }
    {
        std::vector<Night> nights(14, N("23:30", "07:00"));
        nights[9] = N("02:30", "10:00");
        const auto r = getSleepRoutine(lastNights(nights), TODAY);
        int close = 0;
        for (const auto &n : r.nights) close += *n.deviation < 15 ? 1 : 0;
        check(r.level == "drifting" && *r.spread > 40 && *r.spread < 55 && r.outliers.size() == 1
                  && r.outliers[0].day == getLastDays(TODAY, 14)[9] && *r.outliers[0].deviation > 160 && close == 13
                  && clockDifference(r.bed->to, 23 * 60 + 30) < 15,
              "одна выбившаяся ночь из четырнадцати: режим «плавает», ночь названа");
    }
    {
        const auto state = stateWithSleep({
            {"2026-09-20", N("04:00", "12:00")},
            {"2026-09-25", N("23:30", "07:00")},
            {"2026-09-29", N("23:50", "07:10")},
            {"2026-10-03", N("23:40", "07:20")},
            {"2026-10-08", N("23:20", "06:50")},
        });
        const auto r = getSleepRoutine(state, TODAY);
        const auto days = mapNights<std::string>(r.nights, [](auto &n) { return n.day; });
        const auto week = getSleepRoutine(state, TODAY, 7);
        const auto before = getSleepRoutine(state, "2026-10-07");
        const auto wide = getSleepRoutine(state, "2026-10-07", 18);
        check(r.days.size() == 14 && r.days[0] == "2026-09-25"
                  && days == std::vector<std::string>{"2026-09-25", "2026-09-29", "2026-10-03", "2026-10-08"}
                  && r.level == "stable" && r.timedCount == 4 && statIs(r.bed, 23 * 60 + 35, 11)
                  && week.level == "none" && week.timedCount == 2 && before.level == "none" && before.timedCount == 3
                  && wide.level == "broken" && wide.timedCount == 4,
              "пропущенные ночи и ночи вне окна");
    }
    {
        auto state = lastNights({N("23:30", "07:00"), N(450), N("23:40", "07:10"), N(420), N("23:20", "06:50")});
        // Негодное время в записи — тоже «без времени»
        auto bad = [](const std::string &day, const std::string &time, double value) {
            return rec(dailyRecordId("sleep", day), day, "sleep", value, time, std::string("07:00"));
        };
        state.health.push_back(bad("2026-10-01", "25:00", 400));
        const auto r = getSleepRoutine(state, TODAY);
        std::vector<double> untimed;
        bool noDeviation = true;
        for (const auto &n : r.nights) {
            if (!n.bed) untimed.push_back(n.minutes);
            noDeviation = noDeviation && !n.deviation;
        }
        const bool first = r.level == "none" && r.timedCount == 3 && r.untimedCount == 3 && r.outliers.empty()
            && r.center == 195 && !r.bed && !r.wake && !r.midpoint && !r.spread && r.nights.size() == 6
            && untimed == std::vector<double>{400, 450, 420} && noDeviation;
        state.health.push_back(bad("2026-10-02", "23:30", 450));
        const auto r2 = getSleepRoutine(state, TODAY);
        const auto empty = getSleepRoutine(createEmptyState(), TODAY);
        check(first && r2.level == "stable" && r2.timedCount == 4 && r2.untimedCount == 3 && empty.level == "none"
                  && empty.timedCount == 0 && empty.untimedCount == 0 && empty.nights.empty() && !empty.center,
              "ночей со временем меньше четырёх — «мало данных»; длительность без времени считается отдельно");
    }
    {
        auto state = lastNights(std::vector<Night>(4, N("00:20", "07:30")));
        const auto r0 = getSleepRoutine(state, TODAY);
        state.healthGoals.bedtime = 23 * 60 + 30;
        state.healthGoals.wakeTime = 7 * 60;
        const auto r1 = getSleepRoutine(state, TODAY);
        state.healthGoals.bedtime = 60;
        state.healthGoals.wakeTime = 8 * 60;
        const auto r2 = getSleepRoutine(state, TODAY);
        state.healthGoals.bedtime = 0;
        const auto r3 = getSleepRoutine(state, TODAY);
        // Негодное значение из сохранённого JSON (в web — строка «поздно»): здесь — NaN
        state.healthGoals.bedtime = NAN;
        state.healthGoals.wakeTime = 7 * 60 + 30;
        const auto r4 = getSleepRoutine(state, TODAY);
        check(!r0.bedGoalDeviation && !r0.wakeGoalDeviation && r1.bedGoalDeviation == 50 && r1.wakeGoalDeviation == 30
                  && r2.bedGoalDeviation == -40 && r2.wakeGoalDeviation == -30 && r3.bedGoalDeviation == 20
                  && !r4.bedGoalDeviation && r4.wakeGoalDeviation == 0 && getClockGoal(0) == 0.0
                  && getClockGoal(1439) == 1439.0 && !getClockGoal(1440) && !getClockGoal(-5)
                  && !getClockGoal(std::nullopt),
              "отклонение от цели режима, в том числе через полночь");
    }
    // целиком — в planner_quick_apply_tests.cpp: «цель режима задаётся текстом и не трогает цель длительности» — запись черновика
    // `applyQuickDraft` (быстрый ввод)
    {
        std::map<std::string, Night> nights;
        for (const auto &day : getLastDays(TODAY, 14)) {
            const bool weekend = day == "2026-09-26" || day == "2026-09-27" || day == "2026-10-03" || day == "2026-10-04";
            nights.emplace(day, weekend ? N("01:00", "10:00") : N("23:00", "07:00"));
        }
        const auto r = getSleepRoutine(stateWithSleep(nights), TODAY);
        nights.erase("2026-09-26");
        nights.erase("2026-09-27");
        nights.erase("2026-10-03");
        const auto one = getSleepRoutine(stateWithSleep(nights), TODAY);
        nights.erase("2026-10-04");
        const auto none = getSleepRoutine(stateWithSleep(nights), TODAY);
        check(r.socialJetlag == 150 && r.level == "broken" && !one.socialJetlag && !none.socialJetlag
                  && none.level == "stable",
              "сдвиг выходных: середина сна в выходные против будней");
    }
    {
        // Чтение части случая: те же записи, что дают строки блока «Сон» (разбор строк — модуль быстрого ввода)
        auto state = createEmptyState();
        state.health = {rec("sleep-2026-10-05", "2026-10-05", "sleep", 470, "23:40", "07:30"),
                        rec("sleep-2026-10-06", "2026-10-06", "sleep", 450),
                        rec("sleep-2026-10-07", "2026-10-07", "sleep", 450),
                        rec("sleep-2026-10-04", "2026-10-04", "sleep", 450, "23:50", "07:20")};
        const auto d5 = getDailyRecord(state, "sleep", "2026-10-05");
        const auto d6 = getDailyRecord(state, "sleep", "2026-10-06");
        const auto d4 = getDailyRecord(state, "sleep", "2026-10-04");
        const auto r = getSleepRoutine(state, TODAY);
        check(d5 && d5->time == "23:40" && d5->value == 470 && d6 && !d6->time && d6->value == 450 && d4
                  && d4->endTime == "07:20" && !getDailyRecord(state, "sleep", TODAY) && r.timedCount == 2
                  && r.untimedCount == 2,
              "строка блока «Сон» пишет сон в день экрана (чтение записей)");
    }
    {
        const auto days = getLastDays(TODAY, 7);
        const std::vector<Night> steady = {N("23:40", "07:30"), N("23:50", "07:20"), N("23:30", "07:30"),
                                           N("23:45", "07:40"), N("23:35", "07:25")};
        std::map<std::string, Night> nights = {{TODAY, N("01:00", "06:00")}};
        const auto lone = getSleepRoutine(stateWithSleep(nights), TODAY);
        for (size_t i = 0; i < steady.size(); ++i) nights.emplace(days[i], steady[i]);
        auto state = stateWithSleep(nights);
        state.healthGoals.bedtime = 23 * 60 + 30;
        state.healthGoals.wakeTime = 7 * 60;
        const auto stable = getSleepRoutine(state, days[4]);
        state.health.push_back(nightRecord(days[5], N("02:40", "10:30")));
        const auto broken = getSleepRoutine(state, days[5]);
        std::vector<HealthRecord> kept;
        for (const auto &h : state.health) {
            if (h.day != days[5]) kept.push_back(h);
        }
        kept.push_back(nightRecord(days[5], N(450)));
        state.health = kept;
        const auto back = getSleepRoutine(state, days[5]);
        const auto drifting = getSleepRoutine(state, TODAY);
        check(lone.level == "none" && lone.timedCount == 1 && stable.level == "stable" && stable.timedCount == 5
                  && statIs(stable.bed, 23 * 60 + 40, 7) && statIs(stable.wake, 7 * 60 + 29, 7)
                  && stable.outliers.empty() && stable.bedGoalDeviation == 10 && stable.wakeGoalDeviation == 29
                  && broken.level == "broken" && broken.timedCount == 6 && broken.outliers[0].day == days[5]
                  && back.level == "stable" && back.timedCount == 5 && back.untimedCount == 1
                  && drifting.level == "drifting" && drifting.timedCount == 6 && drifting.untimedCount == 1
                  && *drifting.spread > kSleepRoutineStableSpread + 2,
              "ночи сценария: стабильный → сбит → ночь без времени → «плавает»");
    }
    {
        const auto state = lastNights({N("22:00", "07:00"), N("02:00", "09:00"), N("22:00", "07:00"),
                                       N("02:00", "09:00")});
        check(getSleepRoutine(state, TODAY).level == "broken" && getDayBudget(state, TODAY) == state.budget,
              "режим не меняет бюджет дня: его снижает только короткий сон");
    }
}

// ── несколько снов за день (16 окт 2026) ─────────────────────────────────────

static void severalSleeps() {
    // Те же записи, что дают «сон 23:00-07:00» и «спал с 14 до 15:30» (повтор не добавляется — это `applyQuickDraft`)
    auto state = createEmptyState();
    state.health = {rec(dailyRecordId("sleep", TODAY), TODAY, "sleep", 480, "23:00", "07:00"),
                    rec("n2", TODAY, "sleep", 90, "14:00", "15:30")};
    const auto day = getDailyRecord(state, "sleep", TODAY);
    check(getSleepRecords(state, TODAY).size() == 2 && day && day->value == 570 && day->time == "23:00"
              && day->endTime == "07:00" && day->id == dailyRecordId("sleep", TODAY),
          "ночь и дневной сон: сумма за день, время — по ночи");
    // целиком — в planner_quick_apply_tests.cpp: «„не спал“ — 0 ч; настоящий сон его убирает…», «правка меняет только свой сон», «ноль часов
    // сна» (4 строки и «сон 0 ч» в общем вводе) — запись черновика `applyQuickDraft` и разбор `parseQuickInput`
}

int main() {
    std::printf("=== parvane-core planner health tests (без стека) ===\n");
    draftReading();
    axis();
    routine();
    severalSleeps();
    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
