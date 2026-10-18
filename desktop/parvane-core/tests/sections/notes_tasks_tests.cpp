// Parvane fork (spec 029, фаза 4): перенос 1:1 web `notes/notesTasks.test.ts`.
#include <cstdio>
#include <memory>
#include <set>
#include <string>
#include <vector>

#include "parvane/sections/notes_tasks.h"
#include "parvane/sections/planner_model.h"

using namespace parvane::sections;
using namespace parvane::sections::notes;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name) {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}

static std::string join(const std::vector<std::string> &parts, const std::string &sep) {
    std::string out;
    for (size_t i = 0; i < parts.size(); ++i) out += (i ? sep : "") + parts[i];
    return out;
}

static std::vector<std::string> split(const std::string &s, char sep) {
    std::vector<std::string> out;
    size_t start = 0;
    while (true) {
        const size_t at = s.find(sep, start);
        if (at == std::string::npos) {
            out.push_back(s.substr(start));
            return out;
        }
        out.push_back(s.substr(start, at - start));
        start = at + 1;
    }
}

static planner::QuickContext ctx() {
    planner::QuickContext c;
    c.today = "2026-10-08";
    c.nowMinutes = 12 * 60;
    c.dayStart = 9 * 60;
    c.dayEnd = 21 * 60;
    return c;
}

static const std::string NOTE = join(std::vector<std::string>{
    "# Сервер", "", "- [ ] заказать блок питания до пт", "- [ ] проверить обе GPU", "- [x] созвон завтра 18:00",
    "- [ ] блок питания 1000 Вт"}, "\n");

static MakeId ids() {
    auto n = std::make_shared<int>(0);
    return [n] { return "a00" + std::to_string(++*n); };
}

static std::string replaceOnce(std::string s, const std::string &from, const std::string &to) {
    const auto at = s.find(from);
    if (at != std::string::npos) s.replace(at, from.size(), to);
    return s;
}

static std::vector<std::string> idsOf(const std::vector<planner::Task> &tasks) {
    std::vector<std::string> out;
    for (const auto &t : tasks) out.push_back(t.id);
    return out;
}

static planner::Task ownTask(double rank) {
    planner::Task t;
    t.id = "x";
    t.name = "своя";
    t.status = "queue";
    t.rank = rank;
    return t;
}

static void testPlan() {
    std::printf("заметки: пункты с датой → задачи плана\n");
    {
        const auto r = planNoteTasks(NOTE, ctx(), ids());
        check(split(r.text, '\n') == std::vector<std::string>{
                  "# Сервер", "", "- [ ] заказать блок питания до пт ^ta001", "- [ ] проверить обе GPU",
                  "- [x] созвон завтра 18:00 ^ta002", "- [ ] блок питания 1000 Вт"},
              "метку получает только пункт с датой либо сроком: текст");
        NoteTaskPlan a{"ta001", "заказать блок питания", false, std::nullopt, std::nullopt, std::nullopt,
                       std::string("2026-10-09")};
        NoteTaskPlan b{"ta002", "созвон", true, std::string("2026-10-09"), std::string("18:00"), 30, std::nullopt};
        check(r.tasks == std::vector<NoteTaskPlan>{a, b}, "метку получает только пункт с датой либо сроком: задачи");
        check(planNoteTasks(r.text, ctx(), ids()).text == r.text, "повторный разбор ничего не меняет");
    }
    {
        auto state = planner::createEmptyState();
        const auto first = planNoteTasks(NOTE, ctx(), ids());
        check(applyNoteTasks(state, "n1", first.tasks), "задачи создаются");
        const auto tasks = getNoteTasks(state, "n1");
        check(tasks.size() == 2 && tasks[0].id == noteTaskId("ta001") && tasks[0].status == "queue"
                  && tasks[1].id == noteTaskId("ta002") && tasks[1].status == "done",
              "задачи заметки — с id по метке и статусом");
        check(state.tasks[0].source && state.tasks[0].source->chat == "note:n1"
                  && state.tasks[0].source->opId == "7461303031",
              "метка в источнике — шестнадцатеричными кодами символов");
        check(markerOfTask(state.tasks[0]) == "ta001", "метка читается из источника");
        check(!applyNoteTasks(state, "n1", first.tasks), "повторное применение — без правок");

        auto edited = replaceOnce(first.text, "- [ ] заказать блок питания до пт",
                                  "- [x] заказать блок питания до 20.10");
        edited = replaceOnce(edited, "- [x] созвон завтра 18:00 ^ta002\n", "");
        const auto second = planNoteTasks(edited, ctx(), ids());
        check(applyNoteTasks(state, "n1", second.tasks), "пункт отмечен и перенесён, второй удалён — правки есть");
        check(getNoteTasks(state, "n1").size() == 1, "задача удалённого пункта убрана");
        check(state.tasks[0].status == "done" && state.tasks[0].due == std::optional<std::string>("2026-10-20")
                  && state.tasks[0].name == "заказать блок питания",
              "задача поправлена: выполнена, новый срок");
        state.tasks.push_back(ownTask(9));
        applyNoteTasks(state, "n2", {});
        check(state.tasks.size() == 2, "задачи других заметок и обычные задачи не трогаются");
    }
    {
        const auto r = planNoteTasks(NOTE, ctx(), ids());
        const auto copied = r.text + "\n- [ ] заказать блок питания до пт ^ta001";
        const auto again = planNoteTasks(copied, ctx(), ids());
        std::set<std::string> markers;
        for (const auto &t : again.tasks) markers.insert(t.marker);
        check(markers.size() == 3, "скопированный пункт получает свою метку и свою задачу");
    }
}

static void testBack() {
    std::printf("заметки: задачи плана → пункты\n");
    auto state = planner::createEmptyState();
    const auto r = planNoteTasks(NOTE, ctx(), ids());
    applyNoteTasks(state, "n1", r.tasks);
    state.tasks[0].status = "done";
    const std::set<std::string> known{"ta001", "ta002"};
    const auto afterDone = applyPlannerToNote(r.text, getNoteTasks(state, "n1"), known);
    check(afterDone.find("- [x] заказать блок питания до пт ^ta001") != std::string::npos,
          "галочка следует за задачей");
    std::vector<planner::Task> rest;
    for (const auto &t : state.tasks) {
        if (t.id != noteTaskId("ta002")) rest.push_back(t);
    }
    state.tasks = rest;
    const auto afterDelete = applyPlannerToNote(afterDone, getNoteTasks(state, "n1"), known);
    check(afterDelete.find("созвон") == std::string::npos, "пункт удалённой задачи убирается");
    check(afterDelete.find("проверить обе GPU") != std::string::npos, "остальные пункты на месте");
    check(applyPlannerToNote(r.text, {}, {}) == r.text, "метка, которой задача ещё не выдавалась, удалением не считается");
}

static void testIndex() {
    std::printf("заметки: индекс задач и сухая проверка правок\n");
    const auto plans = [] { return planNoteTasks(NOTE, ctx(), ids()).tasks; };
    {
        auto state = planner::createEmptyState();
        applyNoteTasks(state, "n1", plans());
        const auto first = noteTasksBySource(state);
        check(idsOf(first.at("n1")) == std::vector<std::string>{"note-ta001", "note-ta002"},
              "индекс по заметке: задачи заметки по порядку");
        // В web — тот же объект из кэша по массиву задач; здесь кэша нет, проверяется равенство состава
        check(idsOf(noteTasksBySource(state).at("n1")) == idsOf(first.at("n1")), "индекс повторяется тем же составом");
        const auto signature = noteTasksStatusSignature(state);
        check(noteTasksStatusSignature(state) == signature, "подпись повторяется");
        state.tasks.push_back(ownTask(0));
        check(noteTasksStatusSignature(state) == signature, "чужая задача подпись не трогает");
        check(getNoteTasks(state, "n1").size() == 2, "чужая задача в задачи заметки не входит");
        for (auto &t : state.tasks) {
            if (t.id == "note-ta001") t.status = "done";
        }
        check(noteTasksStatusSignature(state) != signature, "смена статуса задачи из заметки меняет подпись");
    }
    {
        auto state = planner::createEmptyState();
        auto tasks = plans();
        check(hasNoteTaskChanges(state, "n1", tasks), "пустой план: есть что править");
        check(applyNoteTasks(state, "n1", tasks), "пустой план: применение с правками");
        check(!hasNoteTaskChanges(state, "n1", tasks), "после применения править нечего");
        check(!applyNoteTasks(state, "n1", tasks), "повторное применение без правок");
        auto done = tasks;
        for (auto &t : done) {
            if (t.marker == "ta001") t.isDone = true;
        }
        check(hasNoteTaskChanges(state, "n1", done), "отметка пункта — есть что править");
        check(applyNoteTasks(state, "n1", done), "отметка пункта — применение с правками");
        const std::vector<NoteTaskPlan> tail(done.begin() + 1, done.end());
        check(hasNoteTaskChanges(state, "n1", tail), "убранный пункт — есть что править");
        check(applyNoteTasks(state, "n1", tail), "убранный пункт — применение с правками");
        check(idsOf(state.tasks) == std::vector<std::string>{"note-ta002"}, "осталась только задача второго пункта");
    }
}

int main() {
    testPlan();
    testBack();
    testIndex();
    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
