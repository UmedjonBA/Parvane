// Parvane fork (spec 029, фаза 4): тесты напоминаний и листания жестом «Плана» — перенос web
// `plannerReminders.test.ts` и `plannerSwipe.test.ts` (по проверке на `it`, имена — как в web).
#include <cstdio>
#include <string>
#include <utility>
#include <vector>

#include "parvane/sections/planner_model.h"
#include "parvane/sections/planner_reminders.h"
#include "parvane/sections/planner_swipe.h"

using namespace parvane::sections::planner;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name) {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}

// Настенный момент (в web — `new Date('<день>T<время>:00')` в местной зоне)
static long long at(const std::string &day, const std::string &time) { return wallMs(day, toMinutes(time)); }

static Task task(const std::string &id, const std::string &name, const std::string &day,
                 std::optional<std::string> start, std::optional<int> remind, const std::string &status = "queue") {
    Task t;
    t.id = id;
    t.name = name;
    t.day = day;
    t.start = start;
    t.remind = remind;
    t.status = status;
    return t;
}

static Event event(std::optional<std::string> day, std::optional<int> remind) {
    Event e;
    e.id = "e1";
    e.name = "Созвон";
    e.start = "16:00";
    e.end = "16:30";
    e.day = day;
    e.remind = remind;
    return e;
}

static void reminders() {
    {
        auto state = createEmptyState();
        state.tasks = {task("t1", "Отчёт", "2026-10-20", "10:00", 15),
                       task("t2", "Без времени", "2026-10-20", std::nullopt, 0),
                       task("t3", "Сделано", "2026-10-20", "11:00", 5, "done"),
                       task("t4", "Без напоминания", "2026-10-20", "12:00", std::nullopt)};
        state.events = {event("2026-10-21", 60 * 24)};
        const auto list = getReminders(state, at("2026-10-20", "00:00"), at("2026-10-20", "23:59"));
        std::vector<std::pair<std::string, std::string>> got;
        for (const auto &r : list) got.emplace_back(r.key, wallTime(r.at));
        const std::vector<std::pair<std::string, std::string>> want = {
            {reminderKey("t2", "2026-10-20", 0), "09:00"},
            {reminderKey("t1", "2026-10-20", 15), "09:45"},
            {reminderKey("e1", "2026-10-21", 1440), "16:00"},
        };
        check(got == want && list[0].kind == "task" && !list[0].start && list[1].start == "10:00"
                  && list[1].startsAt == at("2026-10-20", "10:00") && list[2].kind == "event"
                  && list[2].day == "2026-10-21",
              "момент — начало минус «за сколько»; без времени — начало дня; выполненное не напоминает");
    }
    {
        auto state = createEmptyState();
        auto e = event(std::nullopt, 10);
        Repeat repeat;
        repeat.kind = "daily";
        repeat.interval = 1;
        repeat.startDay = "2026-10-20";
        e.repeat = repeat;
        state.events = {e};
        state.reminded = {reminderKey("e1", "2026-10-20", 10)};
        const auto due = getDueReminders(state, at("2026-10-21", "16:00"), at("2026-10-19", "00:00"));
        check(due.size() == 1 && due[0].key == reminderKey("e1", "2026-10-21", 10),
              "у ряда — каждый экземпляр своим ключом; отмеченные уже не сработают повторно");
    }
    {
        // Сверх web: настенные моменты и сводка для провайдера
        auto state = createEmptyState();
        state.tasks = {task("t1", "Отчёт", "2026-10-20", "10:00", 15)};
        const auto plan = readReminders(state, at("2026-10-20", "09:50"));
        const auto early = readReminders(state, at("2026-10-01", "00:00"));
        check(wallDay(at("2026-10-20", "23:59")) == "2026-10-20" && wallTime(at("1969-12-31", "23:30")) == "23:30"
                  && wallDay(at("1969-12-31", "23:30")) == "1969-12-31" && plan.upcoming.empty()
                  && plan.due.size() == 1 && early.upcoming.size() == 1 && early.due.empty(),
              "настенные моменты и сводка: ближайшие и наступившие");
    }
}

static void swipe() {
    check(getSwipeDelta({300, 400}, {200, 400}) == 1 && getSwipeDelta({100, 400}, {220, 380}) == -1,
          "палец влево — следующий день, вправо — предыдущий");
    check(getSwipeDelta({300, 400}, {241, 400}) == 0 && getSwipeDelta({300, 400}, {240, 400}) == 1
              && getSwipeDelta({300, 400}, {300, 400}) == 0,
          "короткий жест — не листание");
    check(getSwipeDelta({300, 100}, {290, 500}) == 0 && getSwipeDelta({300, 100}, {200, 180}) == 0
              && getSwipeDelta({300, 100}, {200, 170}) == 1 && getSwipeDelta({300, 100}, {200, 30}) == 1,
          "прокрутка по вертикали и жест по диагонали — не листание");
    // не перенесено: «где жест листания не начинается» (3 случая `isSwipeBlocked`) — DOM и getComputedStyle
}

int main() {
    std::printf("=== parvane-core planner reminders/swipe tests (без стека) ===\n");
    reminders();
    swipe();
    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
