// Parvane fork (spec 029, фаза 4): тесты записей «Плана» для палитры — перенос блока «палитра: записи „Плана“»
// web `palette/paletteSearch.test.ts` (по проверке на `it`, имена — как в web).
#include <cstdio>
#include <string>
#include <utility>
#include <vector>

#include "parvane/sections/palette_records.h"
#include "parvane/sections/planner_model.h"

using namespace parvane::sections;
using namespace parvane::sections::palette;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name) {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}

// 8 октября 2026 — четверг
static const std::string TODAY = "2026-10-08";

static planner::Task task(const std::string &id, const std::string &name, std::optional<std::string> day = {}) {
    planner::Task t;
    t.id = id;
    t.name = name;
    t.day = day;
    return t;
}

static planner::Event event(const std::string &id, const std::string &name, std::optional<std::string> day = {}) {
    planner::Event e;
    e.id = id;
    e.name = name;
    e.start = "10:00";
    e.end = "11:00";
    e.day = day;
    return e;
}

// Как `titles` web: группы и названия найденного
static std::vector<std::pair<std::string, std::vector<std::string>>> titles(
    const std::vector<PaletteRecordItem> &records, const std::string &query) {
    const auto items = paletteItemsOf(records);
    std::vector<std::pair<std::string, std::vector<std::string>>> out;
    for (const auto &section : searchPalette(items, query)) {
        std::vector<std::string> names;
        for (const auto &result : section.results) names.push_back(items[result.index].title);
        out.emplace_back(groupName(section.group), names);
    }
    return out;
}

static void records() {
    {
        planner::Repeat weeklyRule;
        weeklyRule.kind = "weekly";
        weeklyRule.interval = 1;
        weeklyRule.weekdays = std::vector<int>{1};
        weeklyRule.startDay = "2026-09-01";
        auto weekly = event("e1", "Событие");
        weekly.repeat = weeklyRule;
        auto excluded = weekly;
        planner::Occurrence occurrence;
        occurrence.day = "2026-10-12";
        occurrence.excluded = true;
        excluded.occurrences = std::vector<planner::Occurrence>{occurrence};
        planner::Repeat endedRule;
        endedRule.kind = "daily";
        endedRule.interval = 1;
        endedRule.startDay = "2026-09-01";
        endedRule.endDay = "2026-09-05";
        auto ended = event("e1", "Событие");
        ended.repeat = endedRule;
        check(recordDay(task("t1", "Задача", "2026-10-01"), TODAY) == "2026-10-01"
                  && !recordDay(task("t1", "Задача"), TODAY) && recordDay(weekly, TODAY) == "2026-10-12"
                  && recordDay(excluded, TODAY) == "2026-10-19" && recordDay(ended, TODAY) == "2026-09-01",
              "день разовой записи — её дата, ряда — ближайший экземпляр от сегодня");
    }
    {
        auto state = planner::createEmptyState();
        auto t = task("t1", "Проверить работы");
        t.description = "до пятницы";
        t.steps = {{"9 класс", false}};
        state.tasks = {t};
        auto e = event("e1", "Созвон", "2026-10-09");
        e.description = "по серверу";
        state.events = {e};
        planner::HealthRecord gym;
        gym.id = "h1";
        gym.day = "2026-10-07";
        gym.kind = "workout";
        gym.value = 60;
        gym.name = "Зал";
        gym.exercises = std::vector<planner::Exercise>{{"Присед", {}, {}, {}}};
        planner::HealthRecord weight;
        weight.id = "h2";
        weight.day = "2026-10-08";
        weight.kind = "weight";
        weight.value = 72;
        planner::HealthRecord nameless;
        nameless.id = "h3";
        nameless.day = "2026-10-08";
        nameless.kind = "workout";
        nameless.value = 30;
        state.health = {gym, weight, nameless};
        const auto recs = collectPlannerRecords(state, TODAY);
        std::vector<std::pair<std::string, std::optional<std::string>>> keys;
        for (const auto &r : recs) keys.emplace_back(r.item.key, r.day);
        const std::vector<std::pair<std::string, std::optional<std::string>>> want = {
            {"event:e1", "2026-10-09"}, {"workout:h1", "2026-10-07"}, {"task:t1", std::nullopt}};
        using Groups = std::vector<std::pair<std::string, std::vector<std::string>>>;
        check(keys == want && titles(recs, "9 класс") == Groups{{"record", {"Проверить работы"}}}
                  && titles(recs, "присед") == Groups{{"record", {"Зал"}}}
                  && titles(recs, "серверу") == Groups{{"record", {"Созвон"}}},
              "собираются события, задачи и тренировки с названием — еда и показатели не входят");
    }
}

int main() {
    std::printf("=== parvane-core palette records tests (без стека) ===\n");
    records();
    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
