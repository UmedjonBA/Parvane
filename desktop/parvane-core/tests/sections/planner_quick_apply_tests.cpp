// Parvane fork (spec 029, фаза 4): тесты записи черновика ввода текстом — перенос случаев web
// `plannerHealth.test.ts`, идущих через `parseQuickInput` + `applyQuickDraft` (по проверке на `it`, имена — как в
// web). Сводки здоровья без черновика — в planner_health_tests.cpp.
#include <cstdio>
#include <functional>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "parvane/sections/planner_health.h"
#include "parvane/sections/planner_model.h"
#include "parvane/sections/planner_quick.h"
#include "parvane/sections/planner_quick_apply.h"

using namespace parvane::sections::planner;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name) {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}

static const std::string TODAY = "2026-10-08";

static QuickContext ctx(std::optional<std::string> kind = std::nullopt, std::optional<std::string> lang = std::nullopt,
                        const std::string &today = TODAY, double now = 12 * 60) {
    QuickContext c;
    c.today = today;
    c.nowMinutes = now;
    c.dayStart = 9 * 60;
    c.dayEnd = 21 * 60;
    c.kind = kind;
    c.lang = lang;
    return c;
}

static IdGen seqIds() {
    auto n = std::make_shared<int>(0);
    return [n]() { return "id" + std::to_string(++*n); };
}

static const IdGen IDS = seqIds();

// Строки записываются по очереди; каждая обязана дать подпись (как `toBeDefined` в web)
static State stateAfter(const std::vector<std::string> &lines, bool *allOk) {
    auto state = createEmptyState();
    *allOk = true;
    for (const auto &line : lines) {
        if (!applyQuickDraft(state, parseQuickInput(line, ctx()), TODAY, IDS)) {
            std::printf("    строка не записалась: %s\n", line.c_str());
            *allOk = false;
        }
    }
    return state;
}

static void draftToState() {
    {
        bool ok = false;
        const auto s = stateAfter({"купить кабель", "созвон завтра 16:00 45 мин", "урок вт 15:00 каждую неделю"}, &ok);
        check(ok && s.tasks.size() == 1 && s.tasks[0].name == "купить кабель" && s.events.size() == 2
                  && s.events[0].name == "созвон" && s.events[0].day == "2026-10-09" && s.events[0].start == "16:00"
                  && s.events[0].end == "16:45" && !s.events[1].day && s.events[1].repeat
                  && s.events[1].repeat->weekdays == std::vector<int>{2},
              "задача и событие");
    }
    {
        bool ok = false;
        const auto s = stateAfter({"вт 15:00 пара по Английскому будет тест  лисининг",
                                   "задача сдать отчёт до пт — приложить таблицу", "созвон завтра 16:00"},
                                  &ok);
        check(ok && s.events.size() == 2 && s.events[0].name == "пара по Английскому"
                  && s.events[0].description == "будет тест лисининг" && s.events[0].day == "2026-10-13"
                  && s.events[0].start == "15:00" && s.events[0].end == "16:45" && s.tasks.size() == 1
                  && s.tasks[0].name == "сдать отчёт" && s.tasks[0].description == "приложить таблицу"
                  && s.tasks[0].due == "2026-10-09" && !s.events[1].description,
              "описание из строки уходит в событие и в задачу");
    }
    {
        bool ok = false;
        const auto s = stateAfter({"купить молоко #Дом", "купить хлеб #дом @Ашан ! — бородинский",
                                   "пара вт 15:00 @301ГК — взять тетрадь", "созвон завтра 16:00 @Zoom",
                                   "позвонить в банк #мой_банк"},
                                  &ok);
        std::vector<std::string> lists;
        for (const auto &l : s.lists) lists.push_back(l.name);
        check(ok && lists == std::vector<std::string>{"Дом", "мой банк"}
                  && s.projects == std::vector<std::string>{"", "Дом", "мой банк"} && s.tasks.size() == 3
                  && s.tasks[0].name == "купить молоко" && s.tasks[0].project == "Дом" && s.tasks[0].status == "queue"
                  && s.tasks[0].description.empty() && s.tasks[1].name == "купить хлеб" && s.tasks[1].project == "Дом"
                  && s.tasks[1].status == "active" && s.tasks[1].description == "@Ашан\nбородинский"
                  && s.tasks[2].name == "позвонить в банк" && s.tasks[2].project == "мой банк"
                  && s.events.size() == 2 && s.events[0].name == "пара"
                  && s.events[0].description == "@301ГК\nвзять тетрадь" && s.events[1].name == "созвон"
                  && s.events[1].description == "@Zoom",
              "метки строки: список, место и «важное»");
    }
    {
        bool ok = false;
        const auto s = stateAfter({"обед гречка 150г б30 ж10 у60 кл6 сахар 4 13:30 520 ккал", "вода 500 мл",
                                   "2 стакана"},
                                  &ok);
        const auto it = s.nutrition.find(TODAY);
        const bool food = it != s.nutrition.end() && !it->second.entries.empty();
        const auto &e = food ? it->second.entries[0] : FoodEntry{};
        check(ok && food && e.name == "гречка" && e.meal == "lunch" && e.kcal == 520 && e.protein == 30.0
                  && e.fiber == 6.0 && e.sugar == 4.0 && e.grams == 150.0 && e.time == "13:30"
                  && it->second.waterMl == 1000.0 && getLimitTotal(s, TODAY, "sugar") == 4
                  && getLimitTotal(s, TODAY, "salt") == 0,
              "еда с сахаром и временем, вода складывается");
    }
    {
        bool ok = false;
        const auto s = stateAfter({"вес 72,4", "вес 72,1", "сон 01:00-06:00", "давление 120/80"}, &ok);
        int weights = 0;
        for (const auto &h : s.health) weights += h.kind == "weight" ? 1 : 0;
        const auto weight = getDailyRecord(s, "weight", TODAY);
        const auto sleep = getDailyRecord(s, "sleep", TODAY);
        const auto press = getDailyRecord(s, "pressure", TODAY);
        check(ok && weights == 1 && weight && weight->value == 72.1 && sleep && sleep->time == "01:00"
                  && sleep->endTime == "06:00" && sleep->value == 300 && press && press->value == 120
                  && press->value2 == 80.0 && isShortSleep(s, TODAY) && getDayBudget(s, TODAY) == 480
                  && getDayBudget(s, "2026-10-09") == 600,
              "показатель — одна запись на день, новая заменяет прежнюю; сон дня — сумма снов");
    }
    {
        bool ok = false;
        const auto s = stateAfter({"бег 5 км 28 мин", "зал присед 4x8x80, жим 3x10x60", "йога вчера 40 мин"}, &ok);
        const auto week = getLastDays(TODAY);
        const auto w = getWorkouts(s, week);
        check(ok && week.size() == 7 && week[6] == TODAY && w.size() == 3 && w[0].name == "бег" && w[1].name == "зал"
                  && w[2].name == "йога" && getActiveMinutes(s, week) == 68 && w[1].exercises
                  && w[1].exercises->size() == 2 && formatPace(28, 5) == "5:36" && !formatPace(0, 5),
              "тренировки копятся; активные минуты и темп");
    }
    {
        bool ok = false;
        const auto s = stateAfter({"цель белок 140 вода 2,5л сон 8ч день с 8 до 22 шаги 9000 бюджет 8 ч"}, &ok);
        const auto protein = s.goals.find("protein");
        const auto water = s.goals.find("water");
        check(ok && protein != s.goals.end() && protein->second.target == 140 && protein->second.tolerance == 20
                  && water != s.goals.end() && water->second.target == 2500 && water->second.tolerance == 250
                  && s.healthGoals.sleepMinutes == 480.0 && s.healthGoals.steps == 9000.0
                  && s.healthGoals.sugarMax == 50.0 && s.settings.dayStart == 480 && s.settings.dayEnd == 1320
                  && s.budget == 480 && s.tasks.empty(),
              "цели и настройки текстом");
    }
    {
        bool ok = false;
        auto s = stateAfter({"шаги 9500"}, &ok);
        const auto rejected = applyQuickDraft(s, parseQuickInput("самочувствие 9", ctx()), TODAY, IDS);
        const auto series = getDailySeries(s, "steps", getLastDays(TODAY, 3));
        const auto latest = getLatestRecord(s, "steps", "2026-10-20");
        check(ok && !rejected && s.health.size() == 1 && series.size() == 3 && !series[0] && !series[1]
                  && series[2] == 9500.0 && latest && latest->value == 9500
                  && !getLatestRecord(s, "steps", "2026-10-01"),
              "черновик с ошибкой не записывается; ряды значений и последняя запись");
    }
}

static void routineByText() {
    {
        bool ok = false;
        auto s = stateAfter({"цель сон 23:30-07:00"}, &ok);
        const bool first = s.healthGoals.bedtime == 1410.0 && s.healthGoals.wakeTime == 420.0
            && s.healthGoals.sleepMinutes == 480.0;
        applyQuickDraft(s, parseQuickInput("цель сон 7 ч", ctx()), TODAY, IDS);
        const bool second = s.healthGoals.bedtime == 1410.0 && s.healthGoals.wakeTime == 420.0
            && s.healthGoals.sleepMinutes == 420.0;
        // «24:00» — полночь
        applyQuickDraft(s, parseQuickInput("цель сон 24:00-08:00", ctx()), TODAY, IDS);
        check(ok && first && second && s.healthGoals.bedtime == 0.0 && s.healthGoals.wakeTime == 480.0
                  && s.healthGoals.sleepMinutes == 420.0,
              "цель режима задаётся текстом и не трогает цель длительности");
    }
    {
        auto s = createEmptyState();
        bool ok = true;
        auto save = [&](const std::string &day, const std::string &line, const std::string &lang) {
            const auto draft = parseQuickInput(line, ctx("sleep", lang, day, 0));
            if (draft.kind != "sleep" || draft.day != day || draft.error) {
                std::printf("    строка блока «Сон» не разобрана: %s\n", line.c_str());
                ok = false;
            }
            applyQuickDraft(s, draft, day, IDS);
        };
        save("2026-10-05", "23:40-07:30", "en");
        save("2026-10-06", "7.5 h", "en");
        save("2026-10-07", "7,5 ч", "ru");
        save("2026-10-04", "сон 23:50-07:20", "ru");
        const auto d5 = getDailyRecord(s, "sleep", "2026-10-05");
        const auto d6 = getDailyRecord(s, "sleep", "2026-10-06");
        const auto d7 = getDailyRecord(s, "sleep", "2026-10-07");
        const auto d4 = getDailyRecord(s, "sleep", "2026-10-04");
        const auto r = getSleepRoutine(s, TODAY);
        const auto goal = parseQuickInput("sleep 23:30-07:00", ctx("goal", "en"));
        HealthGoals want;
        want.bedtime = 1410;
        want.wakeTime = 420;
        const bool goalOk = goal.goalChanges && goal.goalChanges->health.bedtime == want.bedtime
            && goal.goalChanges->health.wakeTime == want.wakeTime && !goal.goalChanges->health.sleepMinutes
            && !goal.goalChanges->health.steps && !goal.goalChanges->health.sugarMax;
        check(ok && d5 && d5->time == "23:40" && d5->endTime == "07:30" && d5->value == 470 && d6 && !d6->time
                  && d6->value == 450 && d7 && !d7->time && d7->value == 450 && d4 && d4->time == "23:50"
                  && d4->endTime == "07:20" && !getDailyRecord(s, "sleep", TODAY) && r.timedCount == 2
                  && r.untimedCount == 2 && goalOk,
              "строка блока «Сон» пишет сон в день экрана — и временем, и одной длительностью");
    }
}

static void severalSleeps() {
    {
        bool ok = false;
        const auto s = stateAfter({"сон 23:00-07:00", "спал с 14 до 15:30", "спал с 14 до 15:30"}, &ok);
        const auto day = getDailyRecord(s, "sleep", TODAY);
        check(ok && getSleepRecords(s, TODAY).size() == 2 && day && day->value == 570 && day->time == "23:00"
                  && day->endTime == "07:00",
              "ночь и дневной сон: сумма за день, время — по ночи; повтор не добавляется");
    }
    {
        auto values = [](const State &s) {
            std::vector<double> out;
            for (const auto &r : getSleepRecords(s, TODAY)) out.push_back(r.value);
            return out;
        };
        bool ok = false;
        auto s = stateAfter({"не спал"}, &ok);
        const auto zero = getDailyRecord(s, "sleep", TODAY);
        const bool first = zero && zero->value == 0;
        applyQuickDraft(s, parseQuickInput("спал с 14 до 15", ctx()), TODAY, IDS);
        const auto afterNap = values(s);
        applyQuickDraft(s, parseQuickInput("не спал", ctx()), TODAY, IDS);
        check(ok && first && afterNap == std::vector<double>{60} && values(s) == std::vector<double>{60},
              "«не спал» — 0 ч; настоящий сон его убирает; при сне «не спал» не добавляется");
    }
    {
        bool ok = false;
        auto s = stateAfter({"сон 23:00-07:00", "спал с 14 до 15"}, &ok);
        const auto nap = getSleepRecords(s, TODAY)[1];
        applyQuickDraft(s, parseQuickInput("сон 13:00-14:00", ctx("sleep")), TODAY, IDS, nap.id);
        std::vector<std::pair<std::string, std::string>> got;
        for (const auto &r : getSleepRecords(s, TODAY)) got.emplace_back(r.id, r.time.value_or(""));
        const std::vector<std::pair<std::string, std::string>> want = {{dailyRecordId("sleep", TODAY), "23:00"},
                                                                       {nap.id, "13:00"}};
        check(ok && got == want, "правка меняет только свой сон");
    }
}

static void zeroSleep() {
    for (const char *line : {"0", "0ч", "0 ч", "не спал"}) {
        const auto draft = parseQuickInput(line, ctx("sleep"));
        check(draft.kind == "sleep" && draft.minutes == 0.0 && !draft.error,
              std::string("«") + line + "» в поле сна — 0 ч");
    }
    const auto draft = parseQuickInput("сон 0 ч", ctx());
    check(draft.kind == "sleep" && draft.minutes == 0.0, "«сон 0 ч» в общем вводе — 0 ч");
}

int main() {
    std::printf("=== parvane-core planner quick apply tests (без стека) ===\n");
    draftToState();
    routineByText();
    severalSleeps();
    zeroSleep();
    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
