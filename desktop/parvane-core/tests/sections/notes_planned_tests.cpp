// Parvane fork (spec 029, фаза 4): перенос 1:1 web `notes/notesPlanned.test.ts`.
#include <cstdio>
#include <string>

#include "parvane/sections/notes_planned.h"
#include "parvane/sections/planner_model.h"
#include "parvane/sections/planner_quick.h"

using namespace parvane::sections;
using namespace parvane::sections::notes;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name) {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}

// 8 октября 2026 — четверг, полдень
static const std::string TODAY = "2026-10-08";

// Запись, которую добавит окно ввода текстом. В web — `applyQuickDraft` (plannerHealth.ts, на десктоп ещё не
// перенесён): здесь задача либо событие собираются из черновика теми же полями, которые проверяет тест
static planner::State plan(const std::string &title, const std::string &tail) {
    planner::QuickContext ctx;
    ctx.today = TODAY;
    ctx.nowMinutes = 12 * 60;
    ctx.dayStart = 9 * 60;
    ctx.dayEnd = 21 * 60;
    const auto draft = planner::parseQuickInput(notePlanLine(title) + tail, ctx);
    check(!draft.error, "черновик без ошибки: " + title + " / " + tail);
    auto state = planner::createEmptyState();
    if (draft.kind == "event") {
        planner::Event event;
        event.id = "e1";
        event.name = draft.name;
        event.day = draft.day;
        event.start = draft.start.value_or("");
        event.end = draft.end.value_or("");
        state.events.push_back(event);
    } else {
        planner::Task task;
        task.id = "t1";
        task.name = draft.name;
        task.day = draft.day;
        task.start = draft.start;
        task.due = draft.due;
        task.rank = -1;
        state.tasks.push_back(task);
    }
    return state;
}

int main() {
    std::printf("заметки: «Запланировать» → «Запланировано»\n");
    check(notePlanLine("Сервер X99") == "[[Сервер X99]] ", "заготовка — ссылка на заметку и пробел");
    check(notePlanLine("  Сервер  ") == "[[Сервер]] ", "заготовка — название без крайних пробелов");
    {
        const auto state = plan("Сервер X99", "созвон завтра 16:00");
        check(state.events.size() == 1 && state.events[0].name == "[[Сервер X99]] созвон"
                  && state.events[0].day == std::optional<std::string>("2026-10-09") && state.events[0].start == "16:00",
              "событие из заготовки: название со ссылкой, день и время");
        const auto index = buildPlannedIndex(state, TODAY);
        const auto planned = plannedOf(index, "n1", "Сервер X99");
        check(planned.size() == 1 && planned[0].kind == "event" && planned[0].name == "созвон"
                  && planned[0].day == std::optional<std::string>("2026-10-09")
                  && planned[0].time == std::optional<std::string>("16:00"),
              "событие из заготовки стоит в «Запланировано» своей заметки");
        check(nearestPlanned(planned, TODAY) == std::optional<size_t>(0), "ближайшая запись — это событие");
        check(plannedOf(index, "n2", "Другая").empty(), "у другой заметки записей нет");
    }
    {
        const auto state = plan("Встреча завтра в 9", "сб 15:00");
        check(state.events.size() == 1 && state.events[0].name == "[[Встреча завтра в 9]]"
                  && state.events[0].day == std::optional<std::string>("2026-10-10") && state.events[0].start == "15:00",
              "слова названия заметки датой и временем записи не становятся");
        const auto planned = plannedOf(buildPlannedIndex(state, TODAY), "n1", "встреча завтра в 9");
        check(planned.size() == 1 && planned[0].kind == "event" && planned[0].name == "Встреча завтра в 9"
                  && planned[0].day == std::optional<std::string>("2026-10-10"),
              "название записи из одной ссылки показывается названием заметки");
    }
    {
        const auto state = plan("Parvane", "");
        check(state.tasks.size() == 1 && state.tasks[0].name == "[[Parvane]]" && !state.tasks[0].day,
              "заготовка без продолжения — задача без даты со ссылкой");
        const auto planned = plannedOf(buildPlannedIndex(state, TODAY), "n1", "Parvane");
        check(planned.size() == 1 && planned[0].kind == "task" && planned[0].name == "Parvane" && !planned[0].day,
              "задача без даты в «Запланировано» заметки");
    }
    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
